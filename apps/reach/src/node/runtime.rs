// Copyright (c) Ray Zhang.
use crate::{
    api::{Api, HttpError},
    control::{self, Control, Request},
    desktop::{self, Desktop},
    job::Job,
    ledger::{Identity, Ledger},
    protocol::{Dispatch, Event},
};
use anyhow::{ensure, Context, Result};
use reqwest::Method;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{path::PathBuf, process::Stdio, time::Duration};
struct UploadLifetime(Arc<AtomicBool>);
impl Drop for UploadLifetime {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    time::Instant,
};

async fn upload_forever(database: PathBuf, api: Api) -> Result<()> {
    let mut db = Connection::open(database)?;
    db.busy_timeout(Duration::from_millis(250))?;
    loop {
        let raw: Option<String> = db
            .query_row("SELECT event_json FROM outbox WHERE acknowledged=0 ORDER BY rowid LIMIT 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        if let Some(raw) = raw {
            let event: Event = serde_json::from_str(&raw)?;
            match api.call(Method::POST, "/api/v1/node/events", Some(&serde_json::to_value(&event)?)).await {
                Ok(reply) if reply["accepted"] == true && reply["sequence"] == event.sequence => {
                    persist_ack(&mut db, &event).await?;
                }
                Ok(_) => anyhow::bail!("invalid receipt acknowledgement; original outbox retained"),
                Err(error) if error.downcast_ref::<HttpError>().is_some_and(HttpError::permanent) => {
                    eprintln!("receipt upload requires reconciliation: {error}; original outbox retained");
                    return Err(error);
                }
                Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
            }
        } else {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

async fn persist_ack(db: &mut Connection, event: &Event) -> Result<()> {
    // A fast producer can hold successive write transactions longer than the
    // busy timeout. Keep the original ACK pending and yield to the executor;
    // a retry here changes no remote effects and must not kill the uploader.
    loop {
        let result = db.execute(
            "UPDATE outbox SET acknowledged=1 WHERE operation_id=? AND sequence=?",
            params![event.operation_id, event.sequence],
        );
        match result {
            Ok(1) => return Ok(()),
            Ok(_) => anyhow::bail!("original receipt disappeared before ACK persistence"),
            Err(rusqlite::Error::SqliteFailure(error, _))
                if matches!(error.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) =>
            {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(error) => return Err(error.into()),
        }
    }
}

pub async fn run(ledger: &mut Ledger, once: bool) -> Result<()> {
    run_managed(ledger, once, None).await.map(|_| ())
}
pub async fn run_managed(
    ledger: &mut Ledger,
    once: bool,
    mut control: Option<&mut Control>,
) -> Result<Option<Request>> {
    let identity = ledger.identity()?;
    ensure!(identity.pending_pair.is_none(), "finish the pending pairing attempt before running");
    let api =
        Api::new(identity.server.as_deref().context("Node is not paired")?, &identity.secret, identity.development)?;
    ledger.recover()?;
    let mut desktop =
        Desktop::new(identity.development, &ledger.root, control.as_ref().and_then(|c| c.desktop_owner.as_deref()))?;
    let upload_lost = Arc::new(AtomicBool::new(false));
    let agent = crate::agent::Runtime::load(identity.development, upload_lost.clone())?;
    let upload_database = ledger.root.join("node.sqlite");
    let upload_api = api.clone();
    let uploader = tokio::spawn(async move {
        let _lifetime = UploadLifetime(upload_lost);
        upload_forever(upload_database, upload_api).await
    });
    let outcome = run_loop(ledger, &identity, &api, once, &uploader, &mut control, &mut desktop, agent.as_ref()).await;
    // Pair/maintenance ACK is owned by our caller: no exit path may hand back
    // control before the persistent helper and all its descendants settle.
    let cleanup = desktop.shutdown().await;
    if uploader.is_finished() {
        let result = match uploader.await {
            Ok(Err(error)) => Err(error.context("receipt uploader stopped; original outbox retained")),
            Ok(Ok(())) => Err(anyhow::anyhow!("receipt uploader exited unexpectedly; original outbox retained")),
            Err(error) => Err(error.into()),
        };
        cleanup?;
        return result;
    }
    uploader.abort();
    let _ = uploader.await;
    cleanup?;
    outcome
}
#[allow(clippy::too_many_arguments)]
async fn run_loop(
    ledger: &mut Ledger,
    identity: &Identity,
    api: &Api,
    once: bool,
    uploader: &tokio::task::JoinHandle<Result<()>>,
    control: &mut Option<&mut Control>,
    desktop: &mut Desktop,
    agent: Option<&crate::agent::Runtime>,
) -> Result<Option<Request>> {
    let node_id = identity.node_id.as_deref().context("missing node ID")?;
    let mut recovered_pending = false;
    loop {
        if control::stopping(control) {
            return Ok(None);
        }
        if let Some(request) = control::idle(ledger, control)? {
            return Ok(Some(request));
        }
        if control::stopping(control) {
            return Ok(None);
        }
        ensure!(!uploader.is_finished(), "receipt uploader stopped; effects remain in local ledger");
        if ledger.next_event()?.is_some() {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        if !recovered_pending {
            let pending = match api.call(Method::GET, "/api/v1/node/pending", None).await {
                Ok(value) => value,
                Err(error) if error.downcast_ref::<HttpError>().is_some_and(HttpError::permanent) => return Err(error),
                Err(error) => {
                    eprintln!("{error}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            for item in pending["operations"].as_array().context("invalid pending response")? {
                let operation_id = item["id"].as_str().context("invalid pending ID")?;
                if !ledger.contains(operation_id)? {
                    let dispatch = Dispatch {
                        operation_id: operation_id.into(),
                        node_id: node_id.into(),
                        epoch: identity.epoch,
                        dispatch_id: item["dispatch_id"].as_str().context("missing dispatch")?.into(),
                        payload_hash: item["payload_hash"].as_str().context("missing hash")?.into(),
                        command: Value::Null,
                        created_at: 0,
                    };
                    // Missing local evidence is never proof that an effect did not occur.
                    ledger.import_missing(
                        &dispatch,
                        item["last_sequence"].as_u64().context("invalid pending cursor")?,
                        item["execution"].as_str().context("invalid pending state")?,
                    )?;
                }
            }
            recovered_pending = true;
            if ledger.next_event()?.is_some() {
                continue;
            }
        }
        if control::stopping(control) {
            return Ok(None);
        }
        if let Some(request) = control::idle(ledger, control)? {
            return Ok(Some(request));
        }
        if control::stopping(control) {
            return Ok(None);
        }
        let mut capabilities = desktop.capabilities();
        if agent.is_some() {
            capabilities.push("agent.inspect");
            #[cfg(windows)]
            if agent.as_ref().is_some_and(|r| r.inspection_lease) {
                capabilities.push("agent.finalize");
            }
            if let Ok(value) = api.call(Method::GET, "/api/v1/node/agent-model", None).await {
                if value["configured"] == true {
                    capabilities.push("agent.delegate");
                    capabilities.push(crate::agent_guidance::CAPABILITY);
                    capabilities.push("agent.resume");
                }
            }
        }
        let reply = match api
            .call(
                Method::POST,
                "/api/v1/node/poll",
                Some(&json!({"version":env!("CARGO_PKG_VERSION"),"capabilities":capabilities})),
            )
            .await
        {
            Ok(value) => value,
            Err(error) if error.downcast_ref::<HttpError>().is_some_and(HttpError::permanent) => return Err(error),
            Err(error) => {
                eprintln!("{error}");
                recovered_pending = false;
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        if !reply["operation"].is_null() {
            let dispatch: Dispatch = serde_json::from_value(reply["operation"].clone())?;
            dispatch.validate(node_id, identity.epoch)?;
            if ledger.accept(&dispatch)? {
                let _phase = control.as_ref().map(|c| c.execution_phase());
                control::executing(ledger, control)?;
                execute(ledger, api, &dispatch, control, desktop, agent, None).await?;
            }
            if once {
                let deadline = Instant::now() + Duration::from_secs(20);
                while ledger.next_event()?.is_some() && Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                ensure!(ledger.next_event()?.is_none(), "result saved locally; upload still pending");
                return Ok(None);
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

pub(crate) async fn execute_child(
    ledger: &mut Ledger,
    api: &Api,
    dispatch: &Dispatch,
    control: &mut Option<&mut Control>,
    desktop: &mut Desktop,
    stop: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    execute(ledger, api, dispatch, control, desktop, None, Some(stop)).await
}
async fn execute(
    ledger: &mut Ledger,
    api: &Api,
    dispatch: &Dispatch,
    control: &mut Option<&mut Control>,
    desktop: &mut Desktop,
    agent: Option<&crate::agent::Runtime>,
    mut parent_stop: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<()> {
    let is_desktop = dispatch.command["kind"].as_str().is_some_and(|kind| kind.starts_with("desktop."));
    if control::stopping(control) || crate::agent::stopped(&parent_stop) {
        ledger.event(
            dispatch,
            "cancelled",
            json!({"reason":"host_stopping_before_start","started":false,"processTreeStopped":!is_desktop}),
        )?;
        return Ok(());
    }
    let remote_control = api.call(Method::GET, &format!("/api/v1/node/control/{}", dispatch.operation_id), None).await;
    match remote_control {
        Ok(value) if value["revoked"] == true || value["operation"]["cancel_requested"] == 1 => {
            ledger.event(dispatch, "cancelled", json!({"started":false,"processTreeStopped":!is_desktop}))?;
            return Ok(());
        }
        Ok(_) => {}
        Err(_) => {
            ledger.event(dispatch, "unknown", json!({"reason":"control_unavailable_before_start","started":false}))?;
            return Ok(());
        }
    }
    if control::stopping(control) || crate::agent::stopped(&parent_stop) {
        ledger.event(
            dispatch,
            "cancelled",
            json!({"reason":"host_stopping_before_start","started":false,"processTreeStopped":!is_desktop}),
        )?;
        return Ok(());
    }
    if matches!(dispatch.command["kind"].as_str(), Some("agent.delegate" | "agent.resume")) {
        if let Some(agent) = agent {
            match crate::agent::preflight(ledger, dispatch, desktop, agent) {
                Ok(Some(result)) => {
                    ledger.event(dispatch, "failed", result)?;
                    return Ok(());
                }
                Ok(None) => {}
                Err(error) => {
                    ledger.event(
                        dispatch,
                        "unknown",
                        json!({"reason":"agent_guidance_unverifiable","started":false,"error":error.to_string()}),
                    )?;
                    return Ok(());
                }
            }
        }
    }
    ledger.event(dispatch, "running", json!({"executionIntentSaved":true}))?;
    let result = if dispatch.command["kind"] == "agent.delegate" || dispatch.command["kind"] == "agent.resume" {
        match agent {
            Some(agent) => Box::pin(crate::agent::execute(ledger, api, dispatch, control, desktop, agent)).await,
            None => Err(anyhow::anyhow!("Agent runtime unavailable")),
        }
    } else if dispatch.command["kind"] == "agent.finalize" {
        #[cfg(windows)]
        {
            match agent {
                Some(agent) if agent.inspection_lease => {
                    Box::pin(crate::agent_finalize::execute(ledger, api, dispatch, control, agent)).await
                }
                _ => Err(anyhow::anyhow!("read-only finalization runtime unavailable")),
            }
        }
        #[cfg(not(windows))]
        {
            Err(anyhow::anyhow!("read-only process finalization is not supported on this host"))
        }
    } else if dispatch.command["kind"] == "agent.inspect" {
        match agent {
            Some(agent) => crate::agent_resume::inspect(ledger, dispatch, &agent.sidecar, &agent.sha),
            None => Err(anyhow::anyhow!("Agent runtime unavailable")),
        }
    } else if is_desktop {
        execute_desktop(ledger, api, dispatch, control, desktop, &mut parent_stop).await
    } else {
        execute_worker(ledger, api, dispatch, control, &mut parent_stop).await
    };
    match result {
        Ok((state, data)) => {
            if dispatch.command["kind"] == "agent.finalize" {
                if let Ok(original) = ledger.terminal(&dispatch.operation_id) {
                    ensure!(original.kind == state && original.data == data, "sealed finalizer result changed");
                    return Ok(());
                }
            }
            if let Err(error) = ledger.event(dispatch, &state, data.clone()) {
                let path = ledger.root.join(format!("rejected-result-{}.json", dispatch.operation_id));
                let preserved =
                    crate::agent::save_new(&path, &json!({"dispatch":dispatch,"state":state,"data":data})).is_ok();
                ledger.event(dispatch, "unknown", json!({"reason":"result_not_saved","replayed":false,"resultPreserved":preserved,"localResult":if preserved{Some(path)}else{None}}))?;
                return Err(error);
            }
        }
        Err(error) => {
            if dispatch.command["kind"] == "agent.finalize" && ledger.terminal(&dispatch.operation_id).is_ok() {
                return Err(error);
            }
            ledger.event(
                dispatch,
                "unknown",
                json!({"reason":"worker_observation_failed","error":error.to_string(),"replayed":false}),
            )?;
            if is_desktop {
                return Err(error);
            }
        }
    }
    Ok(())
}
async fn execute_desktop(
    ledger: &mut Ledger,
    api: &Api,
    dispatch: &Dispatch,
    control: &mut Option<&mut Control>,
    desktop: &mut Desktop,
    parent_stop: &mut Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<(String, Value)> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let control_api = api.clone();
    let route = format!("/api/v1/node/control/{}", dispatch.operation_id);
    let control_task = tokio::spawn(async move {
        loop {
            let stop = match control_api.call(Method::GET, &route, None).await {
                Ok(value) => value["revoked"] == true || value["operation"]["cancel_requested"] == 1,
                Err(_) => true,
            };
            if stop {
                let _ = tx.send(()).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    let timeout = dispatch.command["timeoutMs"].as_u64().unwrap_or(60000).clamp(100, 3_600_000);
    let outcome = async {
        let request = desktop.request(dispatch);
        tokio::pin!(request);
        let deadline = tokio::time::sleep(Duration::from_millis(timeout));
        tokio::pin!(deadline);
        loop {
            control::executing(ledger, control)?;
            if control::stopping(control) {
                return Ok(Err("host_stopping"));
            }
            tokio::select! {
                biased;
                _=crate::agent::wait_stop(parent_stop)=>return Ok(Err("parent_stopped")),
                _ = rx.recv() => return Ok(Err("cancel_requested_or_control_lost")),
                _ = &mut deadline => return Ok(Err("deadline_exceeded")),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                reply = &mut request => return reply.map(Ok),
            }
        }
    }
    .await;
    control_task.abort();
    let _ = control_task.await;
    let mut reply = match outcome {
        Ok(Ok(reply)) => reply,
        Ok(Err(reason)) => {
            desktop.shutdown().await?;
            return Ok((
                "unknown".into(),
                json!({"reason":reason,"processTreeStopped":true,"effectsMayHaveOccurred":true,"replayed":false}),
            ));
        }
        Err(error) => {
            desktop.shutdown().await?;
            return Err(error);
        }
    };
    let state = reply["status"].as_str().context("desktop response status missing")?.to_owned();
    let guarded_rejection = state == "failed"
        && reply["effectsMayHaveOccurred"] == false
        && matches!(
            reply["reason"].as_str(),
            Some(
                "desktop_identity_mismatch"
                    | "stale_desktop_snapshot"
                    | "desktop_generation_unavailable"
                    | "desktop_unavailable"
                    | "desktop_session_unavailable"
                    | "duplicate_dispatch_id"
            )
        );
    let retired = state != "succeeded" && !guarded_rejection;
    if retired {
        desktop.shutdown().await?;
    }
    if let Err(error) = desktop::persist_images(ledger, dispatch, &mut reply) {
        desktop.shutdown().await?;
        return Err(error);
    }
    reply["processTreeStopped"] = json!(retired);
    reply["helperRetained"] = json!(desktop.retained());
    Ok((state, reply))
}
async fn execute_worker(
    ledger: &mut Ledger,
    api: &Api,
    dispatch: &Dispatch,
    control: &mut Option<&mut Control>,
    parent_stop: &mut Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<(String, Value)> {
    let work = ledger.root.join("workspace");
    std::fs::create_dir_all(&work)?;
    let mut command = tokio::process::Command::new(std::env::current_exe()?);
    command
        .arg("worker")
        .current_dir(work)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let job = match Job::assign(&child) {
        Ok(job) => job,
        Err(error) => {
            // No input was sent, so the waiting worker cannot start an effect.
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
    };
    let input_result: Result<()> = async {
        ensure!(!crate::agent::stopped(parent_stop), "parent stopped before worker input");
        let mut stdin = child.stdin.take().context("worker stdin missing")?;
        let payload = serde_json::to_vec(&json!({"command":dispatch.command}))?;
        stdin.write_all(&payload).await?;
        stdin.shutdown().await?;
        Ok(())
    }
    .await;
    if let Err(error) = input_result {
        let _ = job.terminate();
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(error);
    }
    let mut lines = BufReader::new(child.stdout.take().context("worker stdout missing")?).lines();
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let control_api = api.clone();
    let route = format!("/api/v1/node/control/{}", dispatch.operation_id);
    let control_task = tokio::spawn(async move {
        loop {
            let status = control_api.call(Method::GET, &route, None).await;
            let stop = match status {
                Ok(value) => value["revoked"] == true || value["operation"]["cancel_requested"] == 1,
                Err(_) => true,
            };
            if stop {
                let _ = tx.send(()).await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    });
    let timeout = dispatch.command["timeoutMs"].as_u64().unwrap_or(30000).clamp(100, 3_600_000);
    let deadline = tokio::time::sleep(Duration::from_millis(timeout));
    tokio::pin!(deadline);
    let mut terminal = None;
    let mut stopped = None;
    let observation:Result<()>=async {
        loop {
            control::executing(ledger, control)?;
            if control::stopping(control) { stopped=Some("host_stopping"); break; }
            tokio::select! {
                biased;
                _=crate::agent::wait_stop(parent_stop)=>{stopped=Some("parent_stopped");break;},
                _=tokio::time::sleep(Duration::from_millis(100)) => {
                    control::executing(ledger, control)?;
                    if control::stopping(control) { stopped=Some("host_stopping"); break; }
                }
                _=&mut deadline=> { stopped=Some("deadline_exceeded"); break; }
                _=rx.recv()=> { stopped=Some("cancel_requested_or_control_lost"); break; }
                line=lines.next_line()=> {
                    let Some(line)=line? else { break; };
                    ensure!(line.len()<=2_097_152,"worker frame exceeds limit");
                    let value:Value=serde_json::from_str(&line)?;
                    match value["kind"].as_str() {
                        Some("output")=> { ledger.event(dispatch,"output",value["data"].clone())?; },
                        Some("result")=> { terminal=Some((value["state"].as_str().context("missing worker state")?.to_owned(),value["data"].clone())); break; },
                        Some("limit")=> { stopped=Some("output_limit"); break; },
                        _=>anyhow::bail!("invalid worker frame"),
                    }
                }
            }
        }
        Ok(())
    }.await;
    control_task.abort();
    let _ = control_task.await;
    // Always reap the owned job, including descendants left by a completed shell.
    let terminated = job.terminate();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    let end = Instant::now() + Duration::from_secs(5);
    while !job.empty()? && Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    ensure!(terminated.is_ok() && job.empty()?, "worker tree did not settle");
    observation?;
    if let Some(reason) = stopped {
        return Ok((
            "unknown".into(),
            json!({"reason":reason,"processTreeStopped":true,"effectsMayHaveOccurred":true}),
        ));
    }
    let (state, mut data) = terminal.context("worker exited without a durable result")?;
    ensure!(["succeeded", "failed", "unknown"].contains(&state.as_str()), "invalid worker terminal state");
    if let Some(object) = data.as_object_mut() {
        object.insert("processTreeStopped".into(), Value::Bool(true));
    }
    Ok((state, data))
}
