//! JSONL adaptation of the durable Harness supervisor and its original Task handle.
use std::{
    io::BufReader,
    sync::{Arc, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use morrow_agent_harness::{
    core::rpi_agent::AgentTool,
    orchestration::{DispatchHandle, DispatchIntent, DispatchMode, FileReference, Store},
};
use serde_json::{json, Value};

use crate::{finish, prepare, protocol::Start, spawn_dispatch, spawn_reader};

pub async fn run(
    start: Start,
    reader: BufReader<std::io::Stdin>,
    token: String,
    mcp_tools: Vec<Arc<dyn AgentTool>>,
    mcp_status: Option<Value>,
) -> Result<(), &'static str> {
    let configuration = start.orchestration.clone().ok_or("orchestration_config_required")?;
    let mode = if let Some(resume) = &start.resume {
        DispatchMode::Resume { expected_fence_sha256: resume.fence_sha256.clone() }
    } else if let Some(source) = &start.continue_reviewed {
        DispatchMode::Continue { source: Box::new(source.clone()) }
    } else {
        DispatchMode::Start
    };
    let (prepared, (initial, host, options)) = prepare(start, token, mcp_tools, None).await?;
    let dispatch = (|| -> Result<DispatchHandle> {
        let store = Store::open(&configuration.directory)?;
        store.validate_dispatch(
            &configuration.assignment_id,
            &prepared.spec,
            &initial,
            options,
            &configuration.configuration_sha256,
            configuration.retry_unadmitted_ref.as_ref().map(|_| configuration.attempt_id.as_str()),
        )?;
        let at_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis().try_into()?;
        let claim = if configuration.retry_unadmitted_ref.is_some() || matches!(mode, DispatchMode::Resume { .. }) {
            store.claim_recovery(
                &configuration.assignment_id,
                &configuration.worker_id,
                at_ms,
                configuration.lease_expires_at_ms,
            )?
        } else if matches!(mode, DispatchMode::Continue { .. }) {
            store.claim_reviewed(
                &configuration.assignment_id,
                &configuration.worker_id,
                at_ms,
                configuration.lease_expires_at_ms,
            )?
        } else {
            store.claim_queued(
                &configuration.assignment_id,
                &configuration.worker_id,
                at_ms,
                configuration.lease_expires_at_ms,
            )?
        };
        if let Some(reference) = &configuration.recovery_authorization_ref {
            claim
                .authorize_recovery(FileReference { path: reference.path.clone(), sha256: reference.sha256.clone() })?;
        }
        if let Some(reference) = configuration.retry_unadmitted_ref {
            claim.retry_unadmitted(
                initial,
                host,
                &configuration.configuration_sha256,
                FileReference { path: reference.path, sha256: reference.sha256 },
            )
        } else {
            let intent = DispatchIntent {
                attempt_id: configuration.attempt_id,
                run_id: initial.id.clone(),
                evidence_dir: prepared.spec.evidence_dir.clone(),
                mode,
            };
            claim.dispatch(intent, initial, host, &configuration.configuration_sha256)
        }
    })()
    .map_err(|_| "orchestration_admission_rejected")?;
    let admitted = Arc::new(OnceLock::new());
    let input = spawn_dispatch(
        spawn_reader(reader),
        prepared.bridge.clone(),
        admitted.clone(),
        prepared.guidance,
        Some(dispatch.clone()),
    );
    let task = match dispatch.wait_admitted().await {
        Ok(task) => task,
        Err(_) => {
            input.abort();
            let _ = input.await;
            return Err("orchestration_dispatch_failed");
        }
    };
    let _ = admitted.set(task.clone());
    if let Some(mut frame) = mcp_status {
        frame["kind"] = json!("mcp_status");
        frame["version"] = json!(1);
        frame["task_id"] = json!(prepared.spec.task_id);
        if prepared.output.control(frame).await.is_err() {
            let _ = dispatch.cancel();
        }
    }
    finish(prepared, task, input, Some(dispatch)).await
}
