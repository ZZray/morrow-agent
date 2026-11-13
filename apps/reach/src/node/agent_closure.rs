// Copyright (c) Ray Zhang. Original gen1 closure from native files after normal sidecar join.
use crate::{
    agent,
    api::Api,
    protocol::{self, Dispatch},
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

fn reference(path: &Path) -> Result<Value> {
    Ok(json!({"path":path,"sha256":agent::file_hash(path)?}))
}
pub async fn finalize(
    api: &Api,
    execution: &Dispatch,
    records: &Path,
    run: &str,
    mut result: (String, Value),
) -> Result<(String, Value)> {
    if execution.command["kind"] != "agent.delegate" || !["succeeded", "failed"].contains(&result.0.as_str()) {
        return Ok(result);
    }
    let original: Value = serde_json::from_slice(&agent::read(&records.join("task.json"), 2 * 1024 * 1024)?)?;
    // Negotiated before any sidecar/model/tool effect. Older services keep ordinary
    // completion semantics, without gaining eligibility as verified library evidence.
    if original["route"]["nativeClosureVersion"] != 1 {
        return Ok(result);
    }
    let terminal: Value = serde_json::from_slice(&agent::read(&records.join("terminal.json"), 4 * 1024 * 1024)?)?;
    ensure!(
        terminal["frame"]["fence_presence"] == "Released" && terminal["frame"]["local_callbacks_finished"] == true,
        "original native Task has not released"
    );
    let outcome = &terminal["frame"]["outcome_ref"];
    let bytes = agent::checked_reference(outcome, &records.join("evidence"), 4 * 1024 * 1024)?;
    ensure!(serde_json::from_slice::<Value>(&bytes)? == result.1["outcome"], "original native outcome changed");
    let owner = records.join("sidecar-owner.json");
    let settled = records.join("process-settled.json");
    let owner_json = String::from_utf8(agent::read(&owner, 16384)?)?;
    let settled_json = String::from_utf8(agent::read(&settled, 32768)?)?;
    let receipt: Value = serde_json::from_str(&settled_json)?;
    ensure!(
        receipt["normalExit"] == true
            && receipt["sidecarWaited"] == true
            && receipt["jobEmpty"] == true
            && receipt["processOwner"] == reference(&owner)?,
        "original process join receipt changed"
    );
    let end = tokio::time::Instant::now() + Duration::from_secs(5);
    let snapshot = loop {
        let value = api
            .call(
                reqwest::Method::POST,
                &format!("/api/v1/node/agents/{}/closure/snapshot", execution.operation_id),
                Some(&json!({"dispatchId":execution.dispatch_id,"payloadHash":execution.payload_hash})),
            )
            .await?;
        if value["ready"] == true {
            break value;
        }
        ensure!(tokio::time::Instant::now() < end, "model transport has not joined before native closure");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let raw = snapshot["snapshotJson"].as_str().context("native closure snapshot missing")?;
    ensure!(snapshot["snapshotSha256"] == protocol::hash(raw.as_bytes()), "native closure snapshot changed");
    result.1["nativeClosure"] = json!({"version":1,"snapshotSha256":snapshot["snapshotSha256"],"lastRunId":run,"observedCalls":result.1["outcome"]["observed_calls"],"task":reference(&records.join("task.json"))?,"terminal":reference(&records.join("terminal.json"))?,"outcome":outcome,"processOwner":reference(&owner)?,"processOwnerJson":owner_json,"processSettled":reference(&settled)?,"processSettledJson":settled_json});
    agent::save_new(&records.join("native-closure-result.json"), &json!({"state":result.0,"result":result.1}))?;
    Ok(result)
}
