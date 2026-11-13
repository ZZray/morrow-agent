// Copyright (c) Ray Zhang. Reach Host for the fixed ARA Lite/Harness JSONL runtime.
use crate::{
    agent_relay::Relay,
    api::Api,
    control::{self, Control},
    desktop::Desktop,
    job::Job,
    ledger::Ledger,
    protocol::{self, Dispatch, Event},
    runtime,
};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, watch},
    time::Instant,
};

const FRAME: usize = 256 * 1024;
pub struct Runtime {
    pub(super) sidecar: PathBuf,
    pub(super) sha: String,
    pub(super) inspection_lease: bool,
    pub upload_lost: Arc<AtomicBool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    sidecar: PathBuf,
    sha256: String,
    #[serde(default, rename = "inspectionLeaseVersion")]
    inspection_lease_version: Option<u32>,
}
#[derive(Deserialize)]
struct RawArguments {
    arguments: Box<serde_json::value::RawValue>,
}
impl Runtime {
    pub fn load(development: bool, upload_lost: Arc<AtomicBool>) -> Result<Option<Self>> {
        let package = std::env::current_exe()?.parent().context("Node package missing")?.to_owned();
        let manifest_path = package.join("payload-manifest.json");
        let required = if manifest_path.try_exists()? {
            let manifest: Value = serde_json::from_slice(&read(&manifest_path, 16 * 1024 * 1024)?)?;
            ensure!(manifest["product"] == "Reach", "unexpected package manifest");
            match manifest["schema"].as_u64() {
                Some(1) => {
                    ensure!(
                        manifest.get("agentBundled").is_none() && manifest.get("agentSha256").is_none(),
                        "legacy package declares Agent fields"
                    );
                    None
                }
                Some(2) => {
                    ensure!(
                        manifest["agentBundled"] == true
                            && manifest["architecture"] == "x86_64-pc-windows-msvc"
                            && manifest["nodeSha256"] == file_hash(&std::env::current_exe()?)?,
                        "complete package Agent identity changed"
                    );
                    Some(manifest)
                }
                _ => anyhow::bail!("unsupported complete package manifest"),
            }
        } else {
            None
        };
        ensure!(
            required.is_none() || std::env::var_os("REACH_AGENT_CONFIG").is_none(),
            "complete package Agent configuration cannot be overridden"
        );
        let config = if development {
            std::env::var_os("REACH_AGENT_CONFIG")
                .map(PathBuf::from)
                .unwrap_or_else(|| package.join("agent-runtime.json"))
        } else {
            package.join("agent-runtime.json")
        };
        if !config.exists() {
            ensure!(required.is_none(), "required packaged Agent configuration missing");
            ensure!(
                !(development && std::env::var_os("REACH_AGENT_CONFIG").is_some()),
                "configured Agent runtime missing"
            );
            return Ok(None);
        }
        ensure!(config.is_absolute(), "Agent configuration must be absolute");
        let bytes = read(&config, 16384)?;
        let c: Config = serde_json::from_slice(&bytes)?;
        if let Some(manifest) = &required {
            ensure!(
                c.sidecar == Path::new("agent/morrow-agent-jsonl.exe")
                    && c.inspection_lease_version == Some(1)
                    && manifest["agentSha256"] == c.sha256,
                "complete package Agent configuration changed"
            );
            let files = manifest["files"].as_array().context("complete package file inventory missing")?;
            for (name, sha) in
                [("agent-runtime.json", protocol::hash(&bytes)), ("agent/morrow-agent-jsonl.exe", c.sha256.clone())]
            {
                let matches = files.iter().filter(|f| f["path"] == name).collect::<Vec<_>>();
                ensure!(
                    matches.len() == 1 && matches[0]["sha256"] == sha,
                    "complete package Agent file identity changed"
                );
            }
        }
        let sidecar = if c.sidecar.is_absolute() {
            ensure!(development, "packaged sidecar must be relative");
            c.sidecar
        } else {
            config.parent().context("configuration parent missing")?.join(c.sidecar)
        }
        .canonicalize()
        .context("Agent sidecar missing or inaccessible")?;
        if !development || required.is_some() {
            ensure!(sidecar.starts_with(package.canonicalize()?), "packaged sidecar escaped package");
        }
        ensure!(c.sha256.len() == 64 && file_hash(&sidecar)? == c.sha256, "Agent runtime image changed");
        ensure!(c.inspection_lease_version.is_none_or(|v| v == 1), "unsupported inspector lease version");
        Ok(Some(Self { sidecar, sha: c.sha256, inspection_lease: c.inspection_lease_version == Some(1), upload_lost }))
    }
}
pub fn stopped(stop: &Option<watch::Receiver<bool>>) -> bool {
    stop.as_ref().is_some_and(|s| *s.borrow())
}
pub async fn wait_stop(stop: &mut Option<watch::Receiver<bool>>) {
    match stop {
        Some(s) => {
            if !*s.borrow() {
                let _ = s.changed().await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}
pub fn save_new(path: &Path, value: &Value) -> Result<()> {
    let mut f = OpenOptions::new().write(true).create_new(true).open(path)?;
    serde_json::to_writer(&mut f, value)?;
    f.write_all(b"\n")?;
    f.sync_all()?;
    Ok(())
}
pub(super) fn read(path: &Path, max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take((max + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= max, "Agent evidence exceeds bound");
    Ok(bytes)
}
pub(super) fn file_hash(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = File::open(path)?;
    let mut hash = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        hash.update(&b[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(super) fn checked_reference(reference: &Value, root: &Path, max: usize) -> Result<Vec<u8>> {
    let path = PathBuf::from(reference["path"].as_str().context("reference path missing")?).canonicalize()?;
    ensure!(path.starts_with(root.canonicalize()?), "Agent reference escaped task evidence");
    let bytes = read(&path, max)?;
    ensure!(reference["sha256"] == protocol::hash(&bytes), "Agent reference changed");
    Ok(bytes)
}
fn now_ms() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis().try_into()?)
}
pub(super) async fn send(stdin: &mut tokio::process::ChildStdin, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() < FRAME, "Agent control frame exceeds bound");
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(3), stdin.write_all(&bytes)).await??;
    Ok(())
}
pub(super) async fn ack(
    ledger: &Ledger,
    dispatch: &Dispatch,
    stop: &watch::Receiver<bool>,
    control: &mut Option<&mut Control>,
) -> Result<()> {
    let sequence: u64 =
        ledger.db.query_row("SELECT sequence FROM operations WHERE id=?", [&dispatch.operation_id], |r| r.get(0))?;
    let limit = Instant::now() + Duration::from_secs(15);
    loop {
        control::executing(ledger, control)?;
        ensure!(!*stop.borrow() && !control::stopping(control), "Agent stopped while waiting for receipt ACK");
        if ledger.acknowledged(&dispatch.operation_id, sequence)? {
            return Ok(());
        }
        ensure!(Instant::now() < limit, "original receipt ACK unavailable");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

pub fn preflight(ledger: &Ledger, execution: &Dispatch, desktop: &Desktop, runtime: &Runtime) -> Result<Option<Value>> {
    let original = if execution.command["kind"] == "agent.resume" {
        Some(crate::agent_resume::Original::load(
            ledger,
            execution.command["rootOperationId"].as_str().context("root Task missing")?,
            &runtime.sidecar,
            &runtime.sha,
        )?)
    } else {
        None
    };
    let command = original.as_ref().map_or(&execution.command, |r| &r.dispatch.command);
    let capabilities = crate::agent_guidance::capabilities(desktop.capabilities(), runtime.inspection_lease);
    let environment = crate::agent_guidance::environment(&capabilities);
    let issues = crate::agent_guidance::check(command, &environment)?;
    Ok((!issues.is_empty()).then(|| json!({"reason":"agent_guidance_incompatible","started":false,"taskAccepted":false,"issues":issues,"environment":environment})))
}

pub async fn execute(
    ledger: &mut Ledger,
    api: &Api,
    execution: &Dispatch,
    control: &mut Option<&mut Control>,
    desktop: &mut Desktop,
    runtime: &Runtime,
) -> Result<(String, Value)> {
    let resume = if execution.command["kind"] == "agent.resume" {
        Some(crate::agent_resume::Original::load(
            ledger,
            execution.command["rootOperationId"].as_str().context("root Task missing")?,
            &runtime.sidecar,
            &runtime.sha,
        )?)
    } else {
        None
    };
    let parent = resume.as_ref().map_or(execution, |r| &r.dispatch);
    let root = ledger.root.join("agents").join(&parent.operation_id);
    fs::create_dir_all(root.parent().context("Agent root missing")?)?;
    let records = if resume.is_some() {
        let records = root.join("attempts").join(&execution.operation_id);
        fs::create_dir_all(records.parent().context("attempt parent missing")?)?;
        records
    } else {
        root.clone()
    };
    fs::create_dir(&records).context("execution evidence already exists; no implicit replay")?;
    let (stop_tx, stop) = watch::channel(false);
    let watched = stop_tx.clone();
    let parent_api = api.clone();
    let parent_id = execution.operation_id.clone();
    let lost = runtime.upload_lost.clone();
    let watchdog = tokio::spawn(async move {
        loop {
            if watched.is_closed() {
                break;
            }
            let status = tokio::time::timeout(
                Duration::from_secs(2),
                parent_api.call(reqwest::Method::GET, &format!("/api/v1/node/control/{parent_id}"), None),
            )
            .await;
            let live = matches!(status,Ok(Ok(ref v))if v["revoked"]!=true&&v["operation"]["cancel_requested"]!=1&&["not_observed","received","running"].contains(&v["operation"]["execution"].as_str().unwrap_or_default()));
            if !live || lost.load(Ordering::SeqCst) {
                let _ = watched.send(true);
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    });
    let result = async {
        ack(ledger, execution, &stop, control).await?;
        if let Some(original) = &resume {
            return crate::agent_resume::execute_original(
                ledger,
                api,
                original,
                execution,
                control,
                desktop,
                runtime,
                &records,
                (&stop_tx, &stop),
            )
            .await;
        }
        let before = Instant::now();
        let route = api
            .call(
                reqwest::Method::POST,
                &format!("/api/v1/node/agents/{}/model/route", parent.operation_id),
                Some(&json!({"dispatchId":parent.dispatch_id,"payloadHash":parent.payload_hash})),
            )
            .await?;
        let server_deadline = route["parentDeadlineUnixMs"].as_u64().context("parent deadline missing")?;
        let server_now = route["serverNowUnixMs"].as_u64().context("server clock missing")?;
        let remaining = server_deadline.saturating_sub(server_now).saturating_sub(before.elapsed().as_millis() as u64);
        ensure!(remaining >= 1000, "Agent deadline elapsed");
        let local_deadline = now_ms()?.checked_add(remaining).context("deadline overflow")?;
        let monotonic_deadline = Instant::now() + Duration::from_millis(remaining);
        let run = protocol::id();
        let descriptor = &route["descriptor"];
        let route_hash = descriptor["routeHash"].as_str().context("model route missing")?;
        let relay = Relay::bind(
            api.clone(),
            parent.clone(),
            run.clone(),
            route_hash.into(),
            root.clone(),
            stop.clone(),
            stop_tx.clone(),
        )
        .await?;
        let expiry = stop_tx.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(monotonic_deadline).await;
            let _ = expiry.send(true);
        });
        let task = run_task(
            ledger,
            api,
            parent,
            execution,
            control,
            desktop,
            runtime,
            &root,
            &route,
            &run,
            local_deadline,
            &relay,
            (&stop_tx, &stop),
            None,
        )
        .await;
        let _ = stop_tx.send(true);
        let desktop_cleanup =
            if matches!(&task,Ok((state,_)) if state=="succeeded") { Ok(()) } else { desktop.shutdown().await };
        let closed = relay.close().await;
        timer.abort();
        let _ = timer.await;
        desktop_cleanup?;
        closed?;
        task
    }
    .await;
    let _ = stop_tx.send(true);
    watchdog.abort();
    let _ = watchdog.await;
    result
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run_task(
    ledger: &mut Ledger,
    api: &Api,
    parent: &Dispatch,
    execution: &Dispatch,
    control: &mut Option<&mut Control>,
    desktop: &mut Desktop,
    runtime: &Runtime,
    root: &Path,
    route: &Value,
    run: &str,
    deadline: u64,
    relay: &Relay,
    stop: (&watch::Sender<bool>, &watch::Receiver<bool>),
    resume: Option<&Value>,
) -> Result<(String, Value)> {
    let evidence = root.join("evidence");
    let session =
        ledger.root.join("agent-sessions").join(parent.command["sessionId"].as_str().context("session missing")?);
    fs::create_dir_all(&session)?;
    let capabilities = crate::agent_guidance::capabilities(desktop.capabilities(), runtime.inspection_lease);
    let guidance = if let Some(r) = resume {
        r["guidance"].clone()
    } else {
        crate::agent_guidance::snapshot(&parent.command, crate::agent_guidance::environment(&capabilities))
    };
    let mut objective = if let Some(r) = resume {
        r["start"]["run"]["objective"].as_str().context("resume objective missing")?.to_owned()
    } else {
        crate::agent_guidance::objective(&parent.command, &guidance)?
    };
    let descriptor = &route["descriptor"];
    let max_output = route["maxOutput"].as_u64().context("output cap missing")?;
    // Host byte allocation for previews, not a token/usage estimate. Full results remain readable.
    let result_window_bytes =
        (descriptor["contextWindow"].as_u64().context("context capability missing")? / 32).clamp(256, 4096) as usize;
    let tools = if let Some(r) = resume {
        r["start"]["run"]["tools"].clone()
    } else {
        crate::agent_guidance::contract()?["tools"].clone()
    };
    let mut start = json!({"kind":"start_task","version":1,"task":{"task_id":parent.operation_id,"criteria_revision":"reach-receipt-integrity-v1","authorization_revision":parent.payload_hash,"kind":"Reasoning","evidence_dir":evidence,"max_runs":parent.command["maxRuns"],"max_calls":parent.command["maxCalls"],"deadline_unix_ms":deadline},"run":{"run_id":run,"objective":objective,"cwd":parent.command["cwd"],"session_path":session.join("session.json"),"environment_state":session.join("environment"),"device_fp":format!("{}:{}",parent.node_id,parent.epoch),"session_key":parent.command["sessionId"],"mode":"execute","endpoint":relay.endpoint,"model":descriptor["model"],"max_calls":parent.command["maxCalls"],"max_seconds":((deadline.saturating_sub(now_ms()?))/1000).max(1),"max_output":max_output,"host_output_ceiling":max_output,"model_resolution":{"kind":"host_declared_loopback","capabilities":{"context_window":descriptor["contextWindow"],"max_tokens":descriptor["maxOutput"],"input":descriptor["input"]}},"tools":tools},"cancel_grace_ms":1000,"emit_events":true});
    if let Some(cap) = parent.command["runCallLimit"].as_u64() {
        ensure!(cap > 0 && Some(cap) <= parent.command["maxCalls"].as_u64(), "invalid original Run call limit");
        start["run"]["max_calls"] = json!(cap);
        start["budget_stop_review"] = json!("review_closed_tool_round");
    }
    if let Some(r) = resume {
        start = r["start"].clone();
        objective = start["run"]["objective"].as_str().context("resume objective missing")?.to_owned();
    }
    save_new(
        &root.join("task.json"),
        &json!({"dispatch":parent,"execution":execution,"route":route,"start":start,"guidance":guidance,"sidecar":runtime.sidecar,"sidecarSha256":runtime.sha,"relayToken":relay.token,"deadlineLocalUnixMs":deadline,"budgetBytes":32*1024*1024,"resultWindowBytes":result_window_bytes,"resume":resume}),
    )?;
    if resume.is_none() && parent.command["maxRuns"].as_u64().unwrap_or(1) > 1 {
        let registered = register_run(api, execution, run).await?;
        ensure!(
            registered["runNumber"] == 1 && registered["remainingCalls"] == parent.command["maxCalls"],
            "initial Run registration differs"
        );
    }
    save_new(
        &root.join(format!("run-{}.json", resume.map_or(1, |r| r["plan"]["runNumber"].as_u64().unwrap_or(0)))),
        &json!({"runId":run,"runNumber":resume.map_or(1,|r|r["plan"]["runNumber"].as_u64().unwrap_or(0)),"objective":objective,"remainingCalls":parent.command["maxCalls"].as_u64().unwrap_or(0)-resume.map_or(0,|r|r["plan"]["consumedCalls"].as_u64().unwrap_or(0))}),
    )?;
    ensure!(file_hash(&runtime.sidecar)? == runtime.sha, "Agent image changed before launch");
    ensure!(!*stop.1.borrow(), "Agent stopped before launch");
    let mut command = tokio::process::Command::new(&runtime.sidecar);
    command.env_clear();
    for key in [
        "PATH",
        "SYSTEMROOT",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "SystemDrive",
        "ProgramData",
        "ALLUSERSPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "PATHEXT",
        "ComSpec",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(v) = std::env::var_os(key) {
            command.env(key, v);
        }
    }
    command
        .env("MORROW_AGENT_MODEL_TOKEN", &relay.token)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    let job_name = format!("Global\\RY.Reach.Agent.{}.{}", execution.operation_id, protocol::id());
    let job = match Job::assign_named(&child, &job_name) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(e);
        }
    };
    #[cfg(windows)]
    {
        let owner = crate::agent_process::capture(parent, execution, &child, &runtime.sha, &job_name)?;
        let owner_path = root.join("sidecar-owner.json");
        save_new(&owner_path, &serde_json::to_value(&owner)?)?;
        ledger.event(execution,"output",json!({"type":"agent.process_owner","taskId":parent.operation_id,"executionId":execution.operation_id,"processOwner":{"path":owner_path,"sha256":file_hash(&owner_path)?}}))?;
        // Pin the immutable process identity in the service BEFORE a native Task can start.
        ack(ledger, execution, stop.1, control).await?;
    }
    let (tx, mut frames) = mpsc::channel(16);
    let stdout = child.stdout.take().context("Agent stdout missing")?;
    let signal = stop.0.clone();
    let task_id = parent.operation_id.clone();
    let reader = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut terminal = false;
        let mut bytes = 0usize;
        let result: Result<()> = async {
            loop {
                let mut line = Vec::new();
                let n = (&mut reader).take((FRAME + 1) as u64).read_until(b'\n', &mut line).await?;
                if n == 0 {
                    break;
                }
                bytes += n;
                ensure!(
                    n <= FRAME && line.last() == Some(&b'\n') && bytes <= 8 * 1024 * 1024,
                    "Agent stdout bound exceeded"
                );
                let frame: Value = serde_json::from_slice(&line)?;
                ensure!(frame["version"] == 1 && frame["task_id"] == task_id, "Agent frame identity changed");
                if frame["kind"] == "callback_cancel" {
                    let _ = signal.send(true);
                }
                if frame["kind"] == "task_result" {
                    ensure!(!terminal, "duplicate Agent terminal");
                    terminal = true;
                } else {
                    ensure!(!terminal, "Agent emitted frames after terminal");
                }
                let arguments = if frame["kind"] == "tool_call" {
                    Some(serde_json::from_slice::<RawArguments>(&line)?.arguments.get().to_owned())
                } else {
                    None
                };
                if tx.send((frame, arguments)).await.is_err() {
                    break;
                }
            }
            ensure!(terminal, "Agent exited without terminal");
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = signal.send(true);
        }
        result
    });
    let mut stdin = child.stdin.take().context("Agent stdin missing")?;
    let mut seen = HashSet::new();
    let mut children: Vec<String> =
        resume.map(|r| serde_json::from_value(r["childOperationIds"].clone())).transpose()?.unwrap_or_default();
    let mut returned = Vec::new();
    let mut verified_basis = None;
    let mut verified_budget = false;
    let mut current_run = run.to_owned();
    let mut run_number = resume.map_or(1, |r| r["plan"]["runNumber"].as_u64().unwrap_or(0));
    let mut last_review: Option<(Value, Value, Value, bool)> = None;
    let outcome=async {
        send(&mut stdin,&start).await?;
        loop {
            control::executing(ledger,control)?;
            ensure!(!*stop.1.borrow()&&!runtime.upload_lost.load(Ordering::SeqCst)&&!control::stopping(control)&&!relay.finished(),"Agent stopped; original effects retained");
            tokio::select! {biased;
                _=tokio::time::sleep(Duration::from_millis(100))=>{},
                frame=frames.recv()=>{
                    let (frame,arguments)=frame.context("Agent control stream closed")?;
                    match frame["kind"].as_str() {
                        Some("event")=>{ledger.event(execution,"output",json!({"type":"agent.progress","runId":frame["run_id"],"nativeSequence":frame["seq"],"eventType":frame["event_type"],"delivery":"best_effort_not_complete_evidence"}))?;},
                        Some("reconcile_request")=>{
                            crate::agent_resume::reconcile(ledger,api,parent,execution,root,&evidence,&frame,resume.context("unexpected resume callback")?,&mut stdin).await?;
                        },
                        Some("tool_call")=>{
                            crate::agent_resume::admit(api,execution,root,&current_run).await?;
                            ensure!(frame["run_id"]==current_run&&frame["tool_name"]=="reach_execute"&&seen.insert(frame["rpc_id"].as_str().context("RPC id missing")?.to_owned()),"invalid or duplicate Agent callback");
                            completed_models(root)?;
                            let result=tool(ledger,api,execution,&parent.operation_id,control,desktop,&evidence,&frame,arguments.as_deref().context("original arguments missing")?,stop.1,&mut children,result_window_bytes).await?;
                            returned.push((frame.clone(),result.clone()));let mut reply=frame.clone();reply["kind"]=json!("tool_reply");reply.as_object_mut().unwrap().remove("arguments");reply["result"]=result;send(&mut stdin,&reply).await?;
                        },
                        Some("verify_request"|"verify_budget_request")=>{
                            crate::agent_resume::admit(api,execution,root,&current_run).await?;
                            ensure!(frame["run_id"]==current_run&&seen.insert(frame["rpc_id"].as_str().context("RPC id missing")?.to_owned()),"verify correlation invalid");
                            let is_budget=frame["kind"]=="verify_budget_request";ensure!(!is_budget||parent.command.get("runCallLimit").is_some(),"budget review was not admitted");
                            let key=if is_budget{"snapshot"}else{"candidate"};let candidate=if let Some(value)=frame.get(key){value.clone()}else{serde_json::from_slice(&checked_reference(&frame[format!("{key}_ref")],&evidence,2*1024*1024)?)?};
                            if is_budget{check_budget_snapshot(&candidate,&evidence)?;}
                            let basis=&candidate["basis"];
                            ensure!(basis["task_id"]==parent.operation_id&&basis["run_id"]==current_run&&basis["run_number"]==run_number&&basis["authorization_revision"]==parent.payload_hash&&basis["criteria_revision"]=="reach-receipt-integrity-v1","candidate basis mismatch");
                            let events=json!({"path":basis["events_path"],"sha256":basis["events_sha256"]});let _=checked_reference(&events,&evidence,8*1024*1024)?;
                            for id in &children{let terminal=ledger.terminal(id)?;ensure!(terminal.kind!="unknown","unknown child cannot be verified");let dispatch:Dispatch=serde_json::from_str(&ledger.db.query_row("SELECT dispatch_json FROM operations WHERE id=?",[id],|r|r.get::<_,String>(0))?)?;ack(ledger,&dispatch,stop.1,control).await?;}
                            ensure!(basis["total_calls"].as_u64()==Some(completed_models(root)? as u64),"candidate model set changed");
                            check_image_consumption(&frame,&candidate,&returned,&evidence)?;
                            verified_basis=Some(basis.clone());
                            verified_budget=is_budget;
                            let proof=evidence.join(if is_budget{format!("reach-budget-review-{run_number}.json")}else if run_number==1{"reach-review.json".into()}else{format!("reach-review-{run_number}.json")});
                            save_new(&proof,&json!({"subjectKind":if is_budget{"closed_budget"}else{"candidate"},"subject":candidate,"candidate":if is_budget{Value::Null}else{candidate.clone()},"childOperationIds":children,"validation":"receipt integrity only; objective awaits caller review","taskAccepted":false}))?;
                            let decision=if parent.command["maxRuns"].as_u64().unwrap_or(1)>1 {
                                Some(caller_review(ledger,api,execution,control,runtime,&candidate,&children,stop.1).await?)
                            }else{None};
                            // Caller review can remain pending for minutes. Re-read original evidence after the wait.
                            let _=checked_reference(&events,&evidence,8*1024*1024)?;
                            if is_budget{check_budget_snapshot(&candidate,&evidence)?;}
                            ensure!(basis["total_calls"].as_u64()==Some(completed_models(root)? as u64),"review model set changed while awaiting feedback");
                            check_image_consumption(&frame,&candidate,&returned,&evidence)?;
                            let verdict=if let Some(d)=&decision {if d["decision"]=="continue"{json!({"NeedsChanges":{"feedback":d["feedback"]}})}else{json!("Verified")}}else if is_budget{json!({"NeedsChanges":{"feedback":""}})}else{json!("Verified")};
                            let receipt=json!({"basis":basis,"committed":true,"settlement":"Settled","verdict":verdict,"evidence":[proof]});
                            let reply=json!({"kind":if is_budget{"verify_budget_reply"}else{"verify_reply"},"version":1,"rpc_id":frame["rpc_id"],"task_id":parent.operation_id,"run_id":current_run,"receipt":receipt});
                            save_new(&root.join(format!("review-decision-{run_number}.json")),&json!({"subjectKind":if is_budget{"closed_budget"}else{"candidate"},"subject":candidate,"candidate":if is_budget{Value::Null}else{candidate.clone()},"decision":decision,"reply":reply}))?;
                            last_review=Some((candidate,receipt,frame.clone(),is_budget));
                            ensure!(!*stop.1.borrow(),"Agent stopped before review reply");send(&mut stdin,&reply).await?;
                        },
                        Some("prepare_request"|"prepare_budget_request")=>{
                            crate::agent_resume::admit(api,execution,root,&current_run).await?;
                            ensure!(frame["run_id"]==current_run&&seen.insert(frame["rpc_id"].as_str().context("RPC id missing")?.to_owned()),"prepare correlation invalid");
                            let is_budget=frame["kind"]=="prepare_budget_request";let key=if is_budget{"budget_continuation"}else{"continuation"};let continuation=if let Some(v)=frame.get(key){v.clone()}else{serde_json::from_slice(&checked_reference(&frame[format!("{key}_ref")],&evidence,2*1024*1024)?)?};
                            let (previous,receipt,review_frame,budget_review)=last_review.as_ref().context("prepare has no committed original review")?;ensure!(is_budget==*budget_review,"continuation subject kind changed");
                            ensure!(continuation["previous"]==*previous&&continuation["receipt"]==*receipt&&continuation["next_run_number"]==run_number+1&&continuation["deadline_unix_ms"]==deadline,"continuation basis or deadline changed");
                            let used=completed_models(root)? as u64;let remaining=parent.command["maxCalls"].as_u64().context("call budget missing")?.checked_sub(used).context("call budget exceeded")?;
                            ensure!(remaining>0&&continuation["remaining_calls"]==remaining&&run_number<parent.command["maxRuns"].as_u64().unwrap_or(1),"continuation budget changed");
                            let stored:Value=serde_json::from_slice(&read(&root.join(format!("review-decision-{run_number}.json")),2*1024*1024)?)?;
                            let decision=&stored["decision"];ensure!(stored["subject"]==*previous&&stored["reply"]["receipt"]==*receipt&&decision["decision"]=="continue"&&decision["feedback"]==receipt["verdict"]["NeedsChanges"]["feedback"],"continuation feedback changed");
                            let next=decision["nextRunId"].as_str().context("next Run missing")?.to_owned();
                            let next_objective=format!("{}\n\nCaller correction feedback for the same Task (original limits still apply):\n{}",objective,decision["feedback"].as_str().context("feedback missing")?);
                            let reply=json!({"kind":if is_budget{"prepare_budget_reply"}else{"prepare_reply"},"version":1,"rpc_id":frame["rpc_id"],"task_id":parent.operation_id,"run_id":current_run,"run_id_next":next,"objective":next_objective});
                            save_new(&root.join(format!("run-{}.json",run_number+1)),&json!({"runId":next,"runNumber":run_number+1,"previousRunId":current_run,"remainingCalls":remaining,"decision":decision,"reply":reply}))?;
                            let registered=register_run(api,execution,&next).await?;ensure!(registered["runNumber"]==run_number+1&&registered["remainingCalls"]==remaining,"continuation service budget changed");
                            relay.switch_run(&current_run,&next).await?;
                            let _=checked_reference(&json!({"path":previous["basis"]["events_path"],"sha256":previous["basis"]["events_sha256"]}),&evidence,8*1024*1024)?;
                            if is_budget{check_budget_snapshot(previous,&evidence)?;}
                            ensure!(used==completed_models(root)? as u64,"prepare model set changed");
                            check_image_consumption(review_frame,previous,&returned,&evidence)?;
                            ensure!(!*stop.1.borrow(),"Agent stopped before continuation");send(&mut stdin,&reply).await?;
                            current_run=next;run_number+=1;returned.clear();
                        },
                        Some("task_result")=>{
                            ensure!(frame["task_accepted"]==false&&frame["local_callbacks_finished"]==true,"Agent terminal invalid");
                            let raw=checked_reference(&frame["outcome_ref"],&evidence,4*1024*1024)?;let native:Value=serde_json::from_slice(&raw)?;
                            ensure!(native["task_id"]==parent.operation_id&&native["task_accepted"]==false&&native["stop"]==frame["stop"],"Agent outcome mismatch");
                            let released=frame["fence_presence"]=="Released";let success=frame["stop"]=="AwaitingHostAcceptance"&&released;
                            let incomplete=released&&(frame["stop"]=="BudgetExhausted"||frame["stop"]=="NeedsChanges");
                            if success||incomplete{
                                ensure!(native["last_receipt"]["basis"]==*verified_basis.as_ref().context("native outcome has no original Host review")?&&native["observed_calls"].as_u64()==Some(completed_models(root)? as u64),"native outcome or model set differs from Host receipts");
                                if verified_budget{
                                    ensure!(native["last_candidate"].is_null(),"budget snapshot must not become an ordinary candidate");
                                    let index:Value=serde_json::from_slice(&checked_reference(&frame["budget_review_ref"],&evidence,2*1024*1024)?)?;
                                    let (subject,receipt,_,budget)=last_review.as_ref().context("budget terminal review missing")?;
                                    ensure!(*budget&&index["kind"]=="closed_budget_snapshot_review"&&index["version"]==1&&index["receipt"]==*receipt&&native["last_receipt"]==*receipt,"budget review index changed");
                                    let original:Value=serde_json::from_slice(&checked_reference(&index["snapshot"],&evidence,2*1024*1024)?)?;ensure!(original==*subject,"budget terminal snapshot changed");check_budget_snapshot(&original,&evidence)?;
                                }else{check_ordinary_basis(&native["last_candidate"]["basis"],&native["last_receipt"]["basis"],parent.command["sessionId"].as_str().context("original Session ID missing")?)?;}
                            }
                            save_new(&root.join("terminal.json"),&json!({"frame":frame,"outcome":native,"childOperationIds":children}))?;
                            let status=if success{"awaiting_review"}else if incomplete{"budget_or_feedback_incomplete"}else{"reconciliation_required"};
                            return Ok((if success{"succeeded"}else if incomplete{"failed"}else{"unknown"}.into(),json!({"taskId":parent.operation_id,"sessionId":parent.command["sessionId"],"taskAccepted":false,"status":status,"reviewSubject":if verified_budget{"closed_budget"}else{"candidate"},"childOperationIds":children,"outcome":native})));
                        },
                        _=>anyhow::bail!("Agent control request unsupported or cancelled; original fence retained")
                    }
                }
            }
        }
    }.await;
    let _ = stop.0.send(true);
    let _ = send(&mut stdin, &json!({"kind":"cancel","version":1,"task_id":parent.operation_id})).await;
    drop(stdin);
    // Real child tools already joined above; now retire the sidecar and every owned descendant.
    let exited = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    let normal = matches!(exited,Ok(Ok(ref status))if status.success());
    let terminated = job.terminate();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    let end = Instant::now() + Duration::from_secs(5);
    while !job.empty()? && Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    reader.abort();
    let _ = reader.await;
    ensure!(terminated.is_ok() && job.empty()?, "Agent process tree did not settle");
    #[cfg(windows)]
    {
        let owner_path = root.join("sidecar-owner.json");
        let owner: crate::agent_process::Owner = serde_json::from_slice(&read(&owner_path, 16384)?)?;
        let observed = crate::agent_process::observe(&owner)?;
        ensure!(
            observed["sidecar"]["originalAlive"] == false && observed["job"]["activeProcesses"] == 0,
            "original containment did not settle"
        );
        save_new(
            &root.join("process-settled.json"),
            &json!({"version":1,"kind":"normal_join_receipt","processOwner":{"path":owner_path,"sha256":file_hash(&owner_path)?},"normalExit":normal,"sidecarWaited":true,"jobTerminated":true,"jobEmpty":true,"observation":observed}),
        )?;
    }
    let result = outcome?;
    ensure!(normal, "Agent process exited abnormally; original fence retained");
    let result = crate::agent_resume::finalize(ledger, api, execution, root, &current_run, result).await?;
    #[cfg(windows)]
    {
        crate::agent_closure::finalize(api, execution, root, &current_run, result).await
    }
    #[cfg(not(windows))]
    {
        Ok(result)
    }
}

async fn register_run(api: &Api, parent: &Dispatch, run: &str) -> Result<Value> {
    api.call(
        reqwest::Method::POST,
        &format!("/api/v1/node/agents/{}/runs", parent.operation_id),
        Some(&json!({"dispatchId":parent.dispatch_id,"payloadHash":parent.payload_hash,"runId":run})),
    )
    .await
}

pub(super) fn check_budget_snapshot(subject: &Value, evidence: &Path) -> Result<()> {
    ensure!(
        subject["termination"]
            == json!({"version":1,"cause":"call_budget_exhausted","native_round_closed":true,"model_final_stop":false})
            && subject["diagnostic_output"].is_string()
            && subject.get("output").is_none(),
        "not a closed native budget snapshot"
    );
    let number = subject["basis"]["run_number"].as_u64().context("budget Run number missing")?;
    let original: Value =
        serde_json::from_slice(&read(&evidence.join(format!("run-{number}-budget-snapshot.json")), 2 * 1024 * 1024)?)?;
    ensure!(original == *subject, "original budget snapshot changed");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn caller_review(
    ledger: &mut Ledger,
    api: &Api,
    parent: &Dispatch,
    control: &mut Option<&mut Control>,
    runtime: &Runtime,
    candidate: &Value,
    children: &[String],
    stop: &watch::Receiver<bool>,
) -> Result<Value> {
    let budget = candidate.get("termination").is_some();
    let subject_key = if budget { "snapshot" } else { "candidate" };
    let mut payload =
        json!({"dispatchId":parent.dispatch_id,"payloadHash":parent.payload_hash,"childOperationIds":children});
    payload[subject_key] = candidate.clone();
    let published = api
        .call(reqwest::Method::POST, &format!("/api/v1/node/agents/{}/reviews", parent.operation_id), Some(&payload))
        .await?;
    let basis = &candidate["basis"];
    let basis_hash = protocol::hash(&serde_json::to_vec(basis)?);
    ensure!(
        published[subject_key] == *candidate && published["basisSha256"] == basis_hash,
        "published review subject changed"
    );
    ledger.event(parent,"output",json!({"type":"agent.review_ready","runId":basis["run_id"],"runNumber":basis["run_number"],"basisSha256":basis_hash,"taskAccepted":false}))?;
    let mut current = published;
    loop {
        control::executing(ledger, control)?;
        ensure!(
            !*stop.borrow() && !control::stopping(control) && !runtime.upload_lost.load(Ordering::SeqCst),
            "Agent stopped awaiting caller feedback"
        );
        if !current["decision"].is_null() {
            let decision = current["decision"].clone();
            ensure!(
                current[subject_key] == *candidate
                    && current["basisSha256"] == basis_hash
                    && decision["basisSha256"] == basis_hash
                    && decision["runId"] == basis["run_id"]
                    && decision["taskAccepted"] == false,
                "caller feedback basis changed"
            );
            let feedback = decision["feedback"].as_str().context("feedback text missing")?;
            ensure!(
                decision["feedbackSha256"] == protocol::hash(feedback.as_bytes())
                    && ["continue", "return_result"].contains(&decision["decision"].as_str().unwrap_or_default()),
                "caller feedback changed"
            );
            return Ok(decision);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        current = api
            .call(
                reqwest::Method::POST,
                &format!(
                    "/api/v1/node/agents/{}/reviews/{}",
                    parent.operation_id,
                    basis["run_id"].as_str().context("review Run missing")?
                ),
                Some(&json!({"dispatchId":parent.dispatch_id,"payloadHash":parent.payload_hash})),
            )
            .await?;
    }
}

#[allow(clippy::too_many_arguments)]
async fn tool(
    ledger: &mut Ledger,
    api: &Api,
    parent: &Dispatch,
    root_id: &str,
    control: &mut Option<&mut Control>,
    desktop: &mut Desktop,
    evidence: &Path,
    frame: &Value,
    arguments: &str,
    stop: &watch::Receiver<bool>,
    children: &mut Vec<String>,
    result_window_bytes: usize,
) -> Result<Value> {
    ensure!(!*stop.borrow(), "Agent stopped before tool");
    ensure!(protocol::hash(arguments.as_bytes()) == frame["args_sha256"], "native tool argument hash changed");
    let response=api.call(reqwest::Method::POST,&format!("/api/v1/node/agents/{}/calls",parent.operation_id),Some(&json!({"dispatchId":parent.dispatch_id,"payloadHash":parent.payload_hash,"runId":frame["run_id"],"callId":frame["native_call_id"],"tool":"reach_execute","argsSha256":frame["args_sha256"],"argumentsJson":arguments}))).await?;
    let dispatch: Dispatch = serde_json::from_value(response["operation"].clone())?;
    ensure!(response["evidenceOnly"] != true, "historical child is evidence only; cannot execute it");
    dispatch.validate(&parent.node_id, parent.epoch)?;
    ensure!(dispatch.command["kind"] != "agent.delegate", "recursive delegation refused");
    ledger.bind_agent_child(root_id, &dispatch.operation_id)?;
    if ledger.accept(&dispatch)? {
        runtime::execute_child(ledger, api, &dispatch, control, desktop, stop.clone()).await?;
    }
    let event = ledger.terminal(&dispatch.operation_id).context("original child has no settled receipt; no replay")?;
    ensure!(event.kind != "unknown", "child effects unknown; no replay");
    ack(ledger, &dispatch, stop, control).await?;
    if !children.contains(&dispatch.operation_id) {
        children.push(dispatch.operation_id.clone());
    }
    settled_tool(ledger, &dispatch, evidence, frame, arguments, result_window_bytes)
}
pub(super) fn settled_tool(
    ledger: &Ledger,
    dispatch: &Dispatch,
    evidence: &Path,
    frame: &Value,
    arguments: &str,
    result_window_bytes: usize,
) -> Result<Value> {
    let event = ledger.terminal(&dispatch.operation_id)?;
    ensure!(event.kind != "unknown", "unknown tool effect cannot be rendered as settled");
    let receipt = evidence.join(format!("child-{}.json", dispatch.operation_id));
    let raw = json!({"dispatch":dispatch,"event":event,"callback":frame,"argumentsJson":arguments});
    if !receipt.exists() {
        save_new(&receipt, &raw)?;
    } else {
        ensure!(
            serde_json::from_slice::<Value>(&read(&receipt, 4 * 1024 * 1024)?)? == raw,
            "original child receipt changed"
        );
    }
    let mut value = json!({"operationId":dispatch.operation_id,"state":event.kind,"result":event.data});
    if serde_json::to_vec(&value)?.len() > result_window_bytes {
        let bytes = serde_json::to_vec(&value)?;
        let full = evidence.join(format!("result-{}.json", dispatch.operation_id));
        if full.exists() {
            ensure!(read(&full, 4 * 1024 * 1024)? == bytes, "original result reference changed");
        } else {
            let mut file = OpenOptions::new().create_new(true).write(true).open(&full)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        let mut end = result_window_bytes;
        while !std::str::from_utf8(&bytes[..end]).is_ok() {
            end -= 1;
        }
        value = json!({"operationId":dispatch.operation_id,"state":event.kind,"resultRef":{"path":full,"sha256":protocol::hash(&bytes),"bytes":bytes.len()},"resultWindow":{"offset":0,"nextOffset":end,"totalBytes":bytes.len(),"eof":false,"text":std::str::from_utf8(&bytes[..end])?},"desktop":{"helperGeneration":event.data["helperGeneration"],"sessionRef":event.data["sessionRef"],"snapshotId":event.data["snapshotId"]}});
    }
    let mut reply =
        json!({"value":value,"is_error":event.kind!="succeeded","settlement":"Settled","operation_receipt":receipt});
    if event.kind == "succeeded" {
        let images = images(ledger, dispatch, evidence, false)?;
        if !images.is_empty() {
            reply["images"] = json!(images);
        }
    }
    ensure!(serde_json::to_vec(&reply)?.len() <= 128 * 1024, "tool result exceeds sidecar bound");
    Ok(reply)
}
pub(super) fn images(ledger: &Ledger, dispatch: &Dispatch, evidence: &Path, existing_only: bool) -> Result<Vec<Value>> {
    let mut statement = ledger.db.prepare("SELECT event_json FROM outbox WHERE operation_id=? ORDER BY sequence")?;
    let events = statement
        .query_map([&dispatch.operation_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|s| serde_json::from_str::<Event>(&s))
        .collect::<serde_json::Result<Vec<_>>>()?;
    let mut result = Vec::new();
    for event in &events {
        let m = &event.data;
        if m["type"] != "artifact.manifest" || m["mimeType"] != "image/png" {
            continue;
        }
        let id = m["artifactId"].as_str().context("image artifact missing")?;
        let mut bytes = Vec::new();
        let mut index = 0u64;
        let mut complete = false;
        for part in &events {
            let data = &part.data;
            if data["artifactId"] != id {
                continue;
            }
            if data["type"] == "artifact.chunk" {
                ensure!(data["index"] == index, "image chunk sequence changed");
                let chunk = STANDARD.decode(data["dataBase64"].as_str().context("image bytes missing")?)?;
                ensure!(data["sha256"] == protocol::hash(&chunk), "image chunk changed");
                ensure!(bytes.len() + chunk.len() <= 8 * 1024 * 1024, "image exceeds bound");
                bytes.extend(chunk);
                index += 1;
            }
            if data["type"] == "artifact.complete" {
                complete = true;
            }
        }
        ensure!(
            complete
                && m["chunkCount"] == index
                && m["byteLength"] == bytes.len()
                && m["sha256"] == protocol::hash(&bytes),
            "original image incomplete"
        );
        let path = evidence.join(format!("image-{}-{id}.png", dispatch.operation_id));
        if path.exists() {
            ensure!(read(&path, 8 * 1024 * 1024)? == bytes, "original image changed");
        } else {
            ensure!(!existing_only, "original retained image missing; read-only finalization cannot recreate it");
            let mut file = OpenOptions::new().create_new(true).write(true).open(&path)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        result.push(json!({"path":path,"sha256":m["sha256"],"bytes":bytes.len(),"mime_type":"image/png","width":m["width"],"height":m["height"]}));
        ensure!(result.len() <= 4, "image count exceeds bound");
    }
    Ok(result)
}

// Morrow's legacy JSONL review omits session_id from the callback receipt,
// while the native outcome retains it. Bind that exact ID before comparing
// every remaining field; this does not discard unknown basis fields.
fn check_ordinary_basis(candidate: &Value, receipt: &Value, session_id: &str) -> Result<()> {
    let mut basis = candidate.as_object().context("native candidate basis missing")?.clone();
    ensure!(basis.remove("session_id") == Some(json!(session_id)), "native candidate Session changed");
    ensure!(Value::Object(basis) == *receipt, "ordinary candidate basis changed");
    Ok(())
}

fn completed_models(root: &Path) -> Result<usize> {
    let task: Value = serde_json::from_slice(&read(&root.join("task.json"), 2 * 1024 * 1024)?)?;
    let mut count = task["resume"]["plan"]["consumedCalls"].as_u64().unwrap_or(0) as usize;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| anyhow::anyhow!("invalid task record name"))?;
        let Some(id) = name.strip_prefix("model-").and_then(|s| s.strip_suffix(".json")) else { continue };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let intent: Value = serde_json::from_slice(&read(&entry.path(), 16384)?)?;
        let completed: Value = serde_json::from_slice(&read(&root.join(format!("model-{id}-transport.json")), 16384)?)?;
        let settlement = &completed["settlement"];
        ensure!(
            intent["requestId"] == id
                && completed["requestId"] == id
                && settlement["request_id"] == id
                && settlement["state"] == "stream_complete"
                && settlement["body_sha256"] == intent["bodySha256"]
                && settlement["run_id"] == intent["runId"],
            "model request remains unknown; no new effects or verification"
        );
        count += 1;
    }
    Ok(count)
}
fn check_image_consumption(
    frame: &Value,
    candidate: &Value,
    returned: &[(Value, Value)],
    evidence: &Path,
) -> Result<()> {
    let image_count = returned.iter().map(|(_, reply)| reply["images"].as_array().map_or(0, Vec::len)).sum::<usize>();
    if image_count == 0 {
        ensure!(frame.get("tool_images_ref").is_none(), "unexpected image consumption proof");
        return Ok(());
    }
    let proof: Value =
        serde_json::from_slice(&checked_reference(&frame["tool_images_ref"], evidence, 4 * 1024 * 1024)?)?;
    ensure!(
        proof["kind"] == "jsonl-native-images-v1" && proof["basis"] == candidate["basis"],
        "image consumption basis changed"
    );
    let from = candidate["basis"]["raw_start"].as_u64().context("image range start missing")?;
    let end = candidate["basis"]["raw_end"].as_u64().context("image range end missing")?;
    ensure!(from <= end, "image range invalid");
    let full = proof["full_proof"]
        .as_str()
        .and_then(|s| s.strip_prefix("journal-v1:"))
        .context("image full history proof missing")?;
    ensure!(
        full.len() == 64 && full.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "image full history proof invalid"
    );
    // The fixed sidecar validates range_proof against this basis under the Session lock.
    // full_proof covers 0..end, while raw_proof covers from..end; only a fresh Session shares both.
    if from == 0 {
        ensure!(proof["full_proof"] == candidate["basis"]["raw_proof"], "fresh image history proof differs");
    }
    let calls = proof["calls"].as_array().context("image proof calls missing")?;
    let actual = calls.iter().filter(|c| c["name"] == "reach_execute").collect::<Vec<_>>();
    ensure!(actual.len() == returned.len(), "native tool receipt set differs");
    for (frame, reply) in returned {
        let matching = actual.iter().filter(|c| c["id"] == frame["native_call_id"]).collect::<Vec<_>>();
        ensure!(matching.len() == 1, "native call correlation changed");
        let call = matching[0];
        let raw_index = call["result_raw_index"].as_u64().context("image result index missing")?;
        ensure!(raw_index >= from && raw_index < end, "image result lies outside the original Run range");
        ensure!(
            call["arguments"] == frame["arguments"]
                && call["is_error"] == reply["is_error"]
                && call["text"] == serde_json::to_string(&reply["value"])?,
            "native result differs from original tool reply"
        );
        let expected = reply["images"].as_array().cloned().unwrap_or_default();
        let actual = call["images"].as_array().context("native image set missing")?;
        ensure!(actual.len() == expected.len(), "native image count changed");
        for (a, b) in actual.iter().zip(expected) {
            ensure!(
                a["mime_type"] == b["mime_type"] && a["bytes"] == b["bytes"] && a["sha256"] == b["sha256"],
                "native image bytes changed"
            );
            let _ = checked_reference(&b, evidence, 8 * 1024 * 1024)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn morrow_legacy_receipt_requires_the_original_session_and_every_other_basis_field() {
        let receipt = json!({"task_id":"original-task","run_id":"original-run","raw_proof":"original-proof"});
        let mut native = receipt.clone();
        native["session_id"] = json!("original-session");
        assert!(check_ordinary_basis(&native, &receipt, "original-session").is_ok());
        assert!(check_ordinary_basis(&native, &receipt, "different-session").is_err());
        assert!(check_ordinary_basis(&receipt, &receipt, "original-session").is_err());
        let mut changed = native.clone();
        changed["raw_proof"] = json!("changed-proof");
        assert!(check_ordinary_basis(&changed, &receipt, "original-session").is_err());
        changed = native.clone();
        changed["unknown_field"] = json!(true);
        assert!(check_ordinary_basis(&changed, &receipt, "original-session").is_err());
        let mut supplied_session = receipt.clone();
        supplied_session["session_id"] = json!("different-session");
        assert!(check_ordinary_basis(&native, &supplied_session, "original-session").is_err());
    }

    #[test]
    fn native_arguments_retain_the_sidecars_original_key_order_and_json_escapes() -> Result<()> {
        let raw = r#"{"arguments":{"command":{"kind":"file.write","path":"effect.txt","contentBase64":"b25jZQo="}}}"#;
        let original = serde_json::from_str::<RawArguments>(raw)?.arguments;
        let sorted: Value = serde_json::from_str(original.get())?;
        ensure!(
            protocol::hash(original.get().as_bytes()) != protocol::hash(&serde_json::to_vec(&sorted)?),
            "fixture must exercise the preserve_order boundary"
        );
        ensure!(
            original.get() == r#"{"command":{"kind":"file.write","path":"effect.txt","contentBase64":"b25jZQo="}}"#,
            "native arguments were rewritten"
        );
        Ok(())
    }
}
