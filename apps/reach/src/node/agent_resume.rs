// Copyright (c) Ray Zhang. Exact original Task records; observations are not native resume admission.
use crate::{
    agent::{self, checked_reference, read as bounded_read, save_new},
    agent_relay::Relay,
    api::Api,
    control::Control,
    desktop::Desktop,
    ledger::Ledger,
    protocol::{self, Dispatch},
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};
use tokio::sync::watch;

pub(super) fn number(v: &Value, key: &str) -> Result<u64> {
    v[key].as_u64().with_context(|| format!("native {key} missing"))
}
pub(super) fn reference(path: &Path) -> Result<Value> {
    Ok(json!({"path":path,"sha256":agent::file_hash(path)?}))
}
pub(super) fn object(path: &Path) -> Result<Value> {
    Ok(serde_json::from_slice(&bounded_read(path, 4 * 1024 * 1024)?)?)
}
fn binding(execution: &Dispatch) -> Value {
    json!({"dispatchId":execution.dispatch_id,"payloadHash":execution.payload_hash})
}
async fn call(api: &Api, execution: &Dispatch, method: &str, mut input: Value) -> Result<Value> {
    input["dispatchId"] = json!(execution.dispatch_id);
    input["payloadHash"] = json!(execution.payload_hash);
    api.call(
        reqwest::Method::POST,
        &format!("/api/v1/node/agents/{}/resume/{method}", execution.operation_id),
        Some(&input),
    )
    .await
}

// Reconstruct a continuous prefix from ORIGINAL admission files. Inherited counts
// are cumulative; they are checked against the previous chain, never added twice.
fn consumption(original: &Original) -> Result<Value> {
    let fence = object(&original.fence)?;
    consumption_at(original, &value_path(&fence["evidence_dir"])?)
}
pub(super) fn consumption_at(original: &Original, evidence: &Path) -> Result<Value> {
    let mut evidence = evidence.canonicalize()?;
    let mut chain = Vec::new();
    loop {
        ensure!(
            evidence.starts_with(&original.root) && chain.len() < 64 && !chain.contains(&evidence),
            "native evidence chain is not original"
        );
        chain.push(evidence.clone());
        let prior = evidence.join("resume.json");
        if !prior.try_exists()? {
            break;
        }
        let record = object(&prior)?;
        evidence = value_path(&record["fenced_evidence_dir"])?.canonicalize()?;
    }
    ensure!(
        chain.last() == Some(&original.root.join("evidence").canonicalize()?),
        "native evidence chain lost the first Task"
    );
    chain.reverse();
    let mut runs = Vec::new();
    let mut calls = 0u64;
    for evidence in &chain {
        let inherited = evidence.join("resume.json");
        if inherited.try_exists()? {
            let record = object(&inherited)?;
            ensure!(
                record["consumed_runs"] == runs.len() && record["consumed_calls"] == calls,
                "native inherited consumption changed"
            );
        }
        loop {
            let n = runs.len() + 1;
            let path = evidence.join(format!("run-{n}-admission.json"));
            if !path.try_exists()? {
                break;
            }
            let a = object(&path)?;
            let cap = original.dispatch.command["runCallLimit"]
                .as_u64()
                .unwrap_or(number(&original.dispatch.command, "maxCalls")?)
                .min(
                    number(&original.dispatch.command, "maxCalls")?
                        .checked_sub(calls)
                        .context("native budget overflow")?,
                );
            ensure!(
                a["task_id"] == original.dispatch.operation_id
                    && a["authorization_revision"] == original.dispatch.payload_hash
                    && a["criteria_revision"] == "reach-receipt-integrity-v1"
                    && a["run_number"] == n
                    && location(&value_path(&a["session_path"])?)? == original.session
                    && a["deadline_unix_ms"] == original.record["deadlineLocalUnixMs"]
                    && a["remaining_calls"] == cap,
                "original native admission changed"
            );
            let observation = evidence.join(format!("run-{n}-observation.json"));
            let charged = if observation.try_exists()? {
                let o = object(&observation)?;
                ensure!(
                    o["task_id"] == original.dispatch.operation_id && o["run_id"] == a["run_id"],
                    "native observation Run changed"
                );
                let events = evidence.join(format!("run-{n}-events.jsonl"));
                ensure!(
                    o["core_joined"] == true
                        && o["event_failure"] == false
                        && o["events_sha256"] == agent::file_hash(&events)?,
                    "native observation lost its complete original events"
                );
                number(&o, "observed_calls")?
            } else {
                cap
            };
            ensure!(charged <= cap, "native observation exceeds original cap");
            calls += charged;
            let mut charge = json!({"runId":a["run_id"],"runNumber":n,"effectiveCap":cap,"calls":charged,"admission":reference(&path)?});
            if observation.try_exists()? {
                charge["observation"] = reference(&observation)?;
            }
            runs.push(charge);
        }
        for entry in fs::read_dir(evidence)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if let Some(n) = name.strip_prefix("run-").and_then(|s| s.strip_suffix("-admission.json")) {
                let n = n.parse::<usize>()?;
                ensure!(
                    n > 0 && n <= runs.len() && runs[n - 1]["admission"]["path"] == json!(evidence.join(name)),
                    "native admission prefix has a gap or duplicate"
                );
            }
        }
        let outcome = evidence.join("outcome.json");
        if outcome.try_exists()? {
            let o = object(&outcome)?;
            ensure!(
                o["task_id"] == original.dispatch.operation_id
                    && number(&o, "runs")? <= runs.len() as u64
                    && number(&o, "observed_calls")? <= calls,
                "native outcome consumption cannot be explained by admissions"
            );
        }
    }
    Ok(json!({"consumedRuns":runs.len(),"consumedCalls":calls,"runs":runs}))
}

#[allow(clippy::too_many_arguments)]
pub async fn execute_original(
    ledger: &mut Ledger,
    api: &Api,
    original: &Original,
    execution: &Dispatch,
    control: &mut Option<&mut Control>,
    desktop: &mut Desktop,
    runtime: &agent::Runtime,
    records: &Path,
    stop: (&watch::Sender<bool>, &watch::Receiver<bool>),
) -> Result<(String, Value)> {
    let observed = original.observation()?;
    ensure!(
        observed["fencePresent"] == true && observed["expectedFenceSha256"] == execution.command["fenceSha256"],
        "original fence changed or already released; no implicit fresh Run"
    );
    let context = api
        .call(
            reqwest::Method::POST,
            &format!("/api/v1/node/agents/{}/context", execution.operation_id),
            Some(&binding(execution)),
        )
        .await?;
    ensure!(
        context["rootDispatch"] == serde_json::to_value(&original.dispatch)?
            && context["activeExecutionId"] == execution.operation_id
            && context["phase"] == "reconciling"
            && context["descriptor"] == original.record["route"]["descriptor"],
        "service original authority changed"
    );
    let current = api.call(reqwest::Method::GET, "/api/v1/node/agent-model", None).await?;
    ensure!(
        current["configured"] == true && current["descriptor"] == context["descriptor"],
        "organization model route changed"
    );
    let charges = consumption(original)?;
    let envelope = call(
        api,
        execution,
        "plan",
        json!({"consumedRuns":charges["consumedRuns"],"consumedCalls":charges["consumedCalls"]}),
    )
    .await?;
    let text = envelope["planJson"].as_str().context("resume plan missing")?;
    ensure!(envelope["planSha256"] == protocol::hash(text.as_bytes()), "service plan bytes changed");
    let plan: Value = serde_json::from_str(text)?;
    ensure!(
        plan["taskId"] == original.dispatch.operation_id
            && plan["executionId"] == execution.operation_id
            && plan["generation"] == context["generation"]
            && plan["fenceSha256"] == execution.command["fenceSha256"]
            && plan["instructionSha256"]
                == protocol::hash(
                    execution.command["instruction"].as_str().context("resume instruction missing")?.as_bytes()
                )
            && plan["consumedRuns"] == charges["consumedRuns"]
            && plan["consumedCalls"] == charges["consumedCalls"]
            && plan["parentDeadlineUnixMs"] == context["parentDeadlineUnixMs"],
        "resume plan authority changed"
    );
    let deadline = number(&original.record, "deadlineLocalUnixMs")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
    ensure!(deadline > now + 1000, "original local deadline elapsed");
    let run = plan["runId"].as_str().context("planned Run missing")?;
    let descriptor = &context["descriptor"];
    let relay = Relay::rebind(
        api.clone(),
        execution.clone(),
        run.into(),
        descriptor["routeHash"].as_str().context("route missing")?.into(),
        records.to_owned(),
        original.record["start"]["run"]["endpoint"].as_str().context("relay endpoint missing")?,
        original.record["relayToken"].as_str().context("relay token missing")?,
        stop.1.clone(),
        stop.0.clone(),
    )
    .await?;
    let mut start = original.record["start"].clone();
    start["task"]["evidence_dir"] = json!(records.join("evidence"));
    start["run"]["run_id"] = json!(run);
    start["run"]["objective"] = json!(format!(
        "{}\n\nRecovery instruction for the SAME Task, original limits and authority retained:\n{}",
        start["run"]["objective"].as_str().context("original objective missing")?,
        execution.command["instruction"].as_str().context("instruction missing")?
    ));
    start["run"]["max_seconds"] = json!(number(&start["run"], "max_seconds")?.min((deadline - now) / 1000));
    start["resume"] = json!({"version":1,"fence_sha256":execution.command["fenceSha256"]});
    let snapshot = call(api, execution, "snapshot", json!({})).await?;
    let snapshot_json = snapshot["snapshotJson"].as_str().context("snapshot missing")?;
    ensure!(snapshot["snapshotSha256"] == protocol::hash(snapshot_json.as_bytes()), "snapshot bytes changed");
    let snapshot: Value = serde_json::from_str(snapshot_json)?;
    let children = snapshot["children"]
        .as_array()
        .context("child set missing")?
        .iter()
        .map(|c| c["operation"]["id"].clone())
        .collect::<Vec<_>>();
    let options = json!({"start":start,"guidance":original.record["guidance"],"plan":plan,"planEnvelope":envelope,"consumption":charges,"fencePath":original.fence,"originalTask":reference(&original.root.join("task.json"))?,"childOperationIds":children});
    let signal = stop.0.clone();
    let timer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(deadline - now)).await;
        let _ = signal.send(true);
    });
    let result = agent::run_task(
        ledger,
        api,
        &original.dispatch,
        execution,
        control,
        desktop,
        runtime,
        records,
        &original.record["route"],
        run,
        deadline,
        &relay,
        stop,
        Some(&options),
    )
    .await;
    let _ = stop.0.send(true);
    let closed = relay.close().await;
    timer.abort();
    let _ = timer.await;
    if !matches!(&result,Ok((state,_))if state=="succeeded") {
        desktop.shutdown().await?;
    }
    closed?;
    result
}

pub(super) fn compare_children(ledger: &Ledger, snapshot: &Value) -> Result<()> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawEvent<'a> {
        event_id: String,
        sequence: u64,
        kind: String,
        #[serde(borrow)]
        data: &'a serde_json::value::RawValue,
    }
    let identity = ledger.identity()?;
    for child in snapshot["children"].as_array().context("service child set missing")? {
        let op = &child["operation"];
        let id = op["id"].as_str().context("child id missing")?;
        let stored: String =
            ledger.db.query_row("SELECT dispatch_json FROM operations WHERE id=?", [id], |r| r.get(0))?;
        let d: Dispatch = serde_json::from_str(&stored)?;
        d.validate(identity.node_id.as_deref().context("Node missing")?, identity.epoch)?;
        ensure!(
            d.operation_id == id
                && d.node_id == op["node_id"]
                && d.epoch == op["epoch"]
                && d.dispatch_id == op["dispatch_id"]
                && d.payload_hash == op["payload_hash"]
                && op["commandSha256"] == protocol::hash(&serde_json::to_vec(&d.command)?),
            "original child dispatch differs from service"
        );
        let mut statement =
            ledger.db.prepare("SELECT event_json,acknowledged FROM outbox WHERE operation_id=? ORDER BY sequence")?;
        let events = statement
            .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            child["eventCount"] == events.len(),
            "child original event set differs for {id}: service={} local={}",
            child["eventCount"],
            events.len()
        );
        let mut proof = String::new();
        for (raw, _acked) in &events {
            let event: RawEvent<'_> = serde_json::from_str(raw)?;
            // The service may have durably committed the child event while the
            // original Node died before receiving the HTTP ACK. The service
            // event proof below is the authority for that exact event set;
            // requiring the local outbox ACK would reject this recoverable
            // crash window and could force an unsafe replay.
            proof.push_str(&format!(
                "{}\t{}\t{}\t{}\n",
                event.event_id,
                event.sequence,
                event.kind,
                protocol::hash(event.data.get().as_bytes())
            ));
        }
        ensure!(
            child["eventsProof"] == protocol::hash(proof.as_bytes()),
            "original child event set changed for {id}: service={} local={}",
            child["eventsProof"],
            protocol::hash(proof.as_bytes())
        );
        let event = ledger.terminal(id)?;
        ensure!(
            event.kind != "unknown"
                && op["execution"] == event.kind
                && op["resultSha256"] == protocol::hash(&serde_json::to_vec(&event.data)?),
            "child effect remains unknown or reconciled differently"
        );
    }
    Ok(())
}
async fn original_arguments(api: &Api, execution: &Dispatch, child: &Value) -> Result<String> {
    use base64::Engine;
    let mut bytes = Vec::new();
    loop {
        let reply = call(
            api,
            execution,
            "arguments",
            json!({"childId":child["relation"]["child_id"],"offset":bytes.len(),"length":65536}),
        )
        .await?;
        ensure!(
            reply["childId"] == child["relation"]["child_id"]
                && reply["offset"] == bytes.len()
                && reply["sha256"] == child["relation"]["args_sha256"]
                && reply["totalBytes"] == child["argumentsBytes"],
            "original argument window changed"
        );
        let part = base64::engine::general_purpose::STANDARD
            .decode(reply["dataBase64"].as_str().context("original arguments bytes missing")?)?;
        ensure!(
            !part.is_empty() && bytes.len() + part.len() <= 2 * 1024 * 1024,
            "original arguments exceed their bound"
        );
        bytes.extend(part);
        ensure!(reply["nextOffset"] == bytes.len(), "argument window is not contiguous");
        if reply["eof"] == true {
            break;
        }
    }
    ensure!(
        child["argumentsBytes"] == bytes.len() && child["relation"]["args_sha256"] == protocol::hash(&bytes),
        "original tool argument bytes changed"
    );
    Ok(String::from_utf8(bytes)?)
}

pub(super) fn compare_models(original: &Original, snapshot: &Value) -> Result<()> {
    let mut intents = Vec::new();
    let mut records = vec![original.root.clone()];
    let attempts = original.root.join("attempts");
    if attempts.try_exists()? {
        for entry in fs::read_dir(attempts)? {
            let path = entry?.path();
            if path.is_dir() {
                records.push(path);
            }
        }
    }
    for records in records {
        for entry in fs::read_dir(&records)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_prefix("model-").and_then(|n| n.strip_suffix(".json")) else { continue };
            if uuid::Uuid::parse_str(id).is_err() {
                continue;
            }
            let intent = object(&entry.path())?;
            let remote = snapshot["models"]
                .as_array()
                .context("model set missing")?
                .iter()
                .find(|r| r["model"]["request_id"] == id);
            if let Some(remote) = remote {
                let m = &remote["model"];
                ensure!(
                    intent["requestId"] == id
                        && intent["runId"] == m["run_id"]
                        && intent["bodySha256"] == m["body_sha256"]
                        && intent["parentId"] == remote["owner"]["execution_id"]
                        && intent["routeHash"] == remote["owner"]["route_hash"],
                    "original model intent authority differs"
                );
                let transport = records.join(format!("model-{id}-transport.json"));
                if transport.try_exists()? {
                    let t = object(&transport)?;
                    ensure!(
                        t["requestId"] == id
                            && t["transport"] == "stream_complete"
                            && t["settlement"]["request_id"] == id
                            && t["settlement"]["body_sha256"] == m["body_sha256"]
                            && t["settlement"]["run_id"] == m["run_id"]
                            && m["state"] == "stream_complete",
                        "original model transport differs"
                    );
                }
                intents.push(id.to_owned());
            }
            // No service reservation: the old generation cannot add one. Do not retry it,
            // fabricate transport success, or refund the native unobserved admission.
        }
    }
    ensure!(
        snapshot["models"]
            .as_array()
            .context("models missing")?
            .iter()
            .all(|m| intents.iter().any(|id| m["model"]["request_id"] == *id)),
        "service model reservation lost its original local intent"
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn reconcile(
    ledger: &Ledger,
    api: &Api,
    parent: &Dispatch,
    execution: &Dispatch,
    records: &Path,
    evidence: &Path,
    frame: &Value,
    options: &Value,
    stdin: &mut tokio::process::ChildStdin,
) -> Result<()> {
    ensure!(frame["run_id"] == options["plan"]["runId"], "resume RPC does not name the planned new Run");
    let original = Original::load(
        ledger,
        &parent.operation_id,
        &value_path(&object(&records.join("task.json"))?["sidecar"])?,
        object(&records.join("task.json"))?["sidecarSha256"].as_str().context("sidecar hash missing")?,
    )?;
    let fence_bytes = read(&original.fence, 256 * 1024)?;
    ensure!(protocol::hash(&fence_bytes) == execution.command["fenceSha256"], "locked original fence changed");
    let review = if let Some(r) = frame.get("review") {
        r.clone()
    } else {
        serde_json::from_slice(&checked_reference(&frame["review_ref"], evidence, 2 * 1024 * 1024)?)?
    };
    ensure!(
        review["task_id"] == parent.operation_id
            && review["fence"] == serde_json::from_slice::<Value>(&fence_bytes)?
            && location(&value_path(&review["session_path"])?)? == original.session
            && location(&value_path(&review["resume_evidence_dir"])?)? == evidence.canonicalize()?
            && location(&value_path(&review["fenced_evidence_dir"])?)?
                == location(&value_path(&review["fence"]["evidence_dir"])?)?,
        "locked native resume review changed"
    );
    let charges = consumption(&original)?;
    ensure!(
        charges == options["consumption"]
            && review["consumed_runs"] == charges["consumedRuns"]
            && review["consumed_calls"] == charges["consumedCalls"],
        "locked native consumption changed after planning"
    );
    ensure!(
        review["fenced_outcome"]["unknown_effects"].as_array().is_none_or(|effects| effects.is_empty()),
        "native outcome retains unknown effects"
    );
    let snapshot_envelope = call(api, execution, "snapshot", json!({})).await?;
    let raw = snapshot_envelope["snapshotJson"].as_str().context("snapshot bytes missing")?;
    ensure!(snapshot_envelope["snapshotSha256"] == protocol::hash(raw.as_bytes()), "snapshot bytes changed");
    let snapshot: Value = serde_json::from_str(raw)?;
    compare_children(ledger, &snapshot)?;
    compare_models(&original, &snapshot)?;
    let review_path = evidence.join("reach-resume-review.json");
    save_new(&review_path, &review)?;
    let review_json = String::from_utf8(read(&review_path, 2 * 1024 * 1024)?)?;
    let review_sha = protocol::hash(review_json.as_bytes());
    let mut tools = Vec::new();
    if let Some(open) = review["interrupted_run"]["open_tool_calls"].as_array() {
        for call in open {
            ensure!(call["name"] == "reach_execute", "unsupported open native tool");
            let child = snapshot["children"].as_array().context("children missing")?.iter().find(|c| {
                c["relation"]["run_id"] == review["interrupted_run"]["run_id"] && c["relation"]["call_id"] == call["id"]
            });
            let settlement = if let Some(child) = child {
                let args = original_arguments(api, execution, child).await?;
                ensure!(
                    serde_json::from_str::<Value>(&args)? == call["arguments"]
                        && protocol::hash(args.as_bytes()) == child["relation"]["args_sha256"],
                    "open native tool arguments differ"
                );
                let d: Dispatch = serde_json::from_str(&ledger.db.query_row(
                    "SELECT dispatch_json FROM operations WHERE id=?",
                    [child["relation"]["child_id"].as_str().context("child id missing")?],
                    |r| r.get::<_, String>(0),
                )?)?;
                let callback = json!({"kind":"resume_settled_tool","run_id":review["interrupted_run"]["run_id"],"native_call_id":call["id"],"arguments":call["arguments"],"args_sha256":child["relation"]["args_sha256"]});
                let reply = agent::settled_tool(
                    ledger,
                    &d,
                    evidence,
                    &callback,
                    &args,
                    number(&original.record, "resultWindowBytes")? as usize,
                )?;
                if reply["is_error"] == true {
                    json!({"kind":"failed","output":serde_json::to_string(&reply["value"]) ?})
                } else {
                    let mut images = reply.get("images").cloned().unwrap_or_else(|| json!([]));
                    if let Some(items) = images.as_array_mut() {
                        for item in items {
                            item["root"] = json!(evidence);
                        }
                    }
                    json!({"kind":"completed","output":serde_json::to_string(&reply["value"]) ?,"images":images})
                }
            } else {
                json!({"kind":"not_executed"})
            };
            tools.push(json!({"call_id":call["id"],"settlement":settlement}));
        }
    }
    let native = json!({"committed":true,"settlement":"Settled","tool_calls":tools,"evidence":[review_path]});
    let native_json = serde_json::to_string(&native)?;
    let mut charge = charges;
    charge["receiptId"] = json!(execution.operation_id);
    charge["fenceSha256"] = execution.command["fenceSha256"].clone();
    charge["reviewSha256"] = json!(review_sha);
    let request = json!({"planSha256":options["planEnvelope"]["planSha256"],"snapshotSha256":snapshot_envelope["snapshotSha256"],"reviewJson":review_json,"reviewSha256":review_sha,"nativeReceiptJson":native_json,"nativeReceiptSha256":protocol::hash(native_json.as_bytes()),"consumption":charge,"originalTask":reference(&original.root.join("task.json"))?,"review":reference(&review_path)?});
    save_new(&records.join("resume-reconcile-request.json"), &request)?;
    let committed = call(api, execution, "reconcile", request.clone())
        .await
        .context("resume receipt ACK missing; no native takeover")?;
    let raw = committed["receiptJson"].as_str().context("committed resume receipt missing")?;
    ensure!(committed["receiptSha256"] == protocol::hash(raw.as_bytes()), "committed receipt bytes changed");
    let receipt: Value = serde_json::from_str(raw)?;
    ensure!(
        receipt["executionId"] == execution.operation_id
            && receipt["taskId"] == parent.operation_id
            && receipt["planSha256"] == options["planEnvelope"]["planSha256"]
            && receipt["nativeReceiptSha256"] == request["nativeReceiptSha256"]
            && receipt["reviewSha256"] == request["reviewSha256"],
        "committed resume receipt differs"
    );
    save_new(
        &records.join("resume-committed.json"),
        &json!({"envelope":committed,"nativeReceipt":native,"snapshot":snapshot_envelope}),
    )?;
    let reply = json!({"kind":"reconcile_reply","version":1,"rpc_id":frame["rpc_id"],"task_id":parent.operation_id,"run_id":frame["run_id"],"receipt":native});
    save_new(&records.join("resume-reply.json"), &reply)?;
    agent::send(stdin, &reply).await
}

pub async fn admit(api: &Api, execution: &Dispatch, records: &Path, run: &str) -> Result<()> {
    if execution.command["kind"] != "agent.resume" {
        return Ok(());
    }
    let task = object(&records.join("task.json"))?;
    let committed = object(&records.join("resume-committed.json"))?;
    let evidence = records.join("evidence");
    let resume_path = evidence.join("resume.json");
    let native_resume = object(&resume_path)?;
    ensure!(native_resume["receipt"] == committed["nativeReceipt"], "native takeover receipt changed");
    let number = task["resume"]["plan"]["runNumber"].as_u64().context("planned Run number missing")?;
    let mut admission = None;
    for n in number..=4 {
        let path = evidence.join(format!("run-{n}-admission.json"));
        if path.try_exists()? {
            let a = object(&path)?;
            if a["run_id"] == run {
                admission = Some((path, a));
                break;
            }
        }
    }
    let (path, a) = admission.context("new native Run has no original admission")?;
    let fence_path = value_path(&task["resume"]["fencePath"])?;
    let fence = object(&fence_path)?;
    ensure!(
        fence["task_id"] == task["dispatch"]["operationId"]
            && location(&value_path(&fence["evidence_dir"])?)? == evidence.canonicalize()?
            && fence["deadline_unix_ms"] == task["deadlineLocalUnixMs"]
            && fence["authorization_revision"] == task["dispatch"]["payloadHash"],
        "native takeover fence differs"
    );
    let input = json!({"receiptSha256":committed["envelope"]["receiptSha256"],"runId":run,"fence":reference(&fence_path)?,"resume":reference(&resume_path)?,"admission":reference(&path)?,"nativeAdmission":a,"sessionPath":task["start"]["run"]["session_path"],"deadlineLocalUnixMs":task["deadlineLocalUnixMs"]});
    let admitted = call(api, execution, "admit", input.clone()).await?;
    ensure!(admitted["admitted"] == true && admitted["runId"] == run, "service native admission missing");
    let proof = records.join(format!("admitted-{run}.json"));
    if proof.try_exists()? {
        ensure!(object(&proof)? == input, "native admission changed");
    } else {
        save_new(&proof, &input)?;
    }
    Ok(())
}

pub async fn finalize(
    ledger: &Ledger,
    api: &Api,
    execution: &Dispatch,
    records: &Path,
    run: &str,
    mut result: (String, Value),
) -> Result<(String, Value)> {
    if execution.command["kind"] != "agent.resume" || !["succeeded", "failed"].contains(&result.0.as_str()) {
        return Ok(result);
    }
    let task = object(&records.join("task.json"))?;
    let committed = object(&records.join("resume-committed.json"))?;
    let terminal = object(&records.join("terminal.json"))?;
    ensure!(
        terminal["frame"]["fence_presence"] == "Released"
            && terminal["frame"]["local_callbacks_finished"] == true
            && !value_path(&task["resume"]["fencePath"])?.try_exists()?
            && object(&records.join(format!("admitted-{run}.json")))?["runId"] == run,
        "native final release not proven"
    );
    let end = tokio::time::Instant::now() + Duration::from_secs(5);
    let snapshot = loop {
        let snapshot = call(api, execution, "final-snapshot", json!({})).await?;
        if snapshot["ready"] == true {
            break snapshot;
        }
        ensure!(tokio::time::Instant::now() < end, "original model transport has not joined for finalization");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let raw = snapshot["snapshotJson"].as_str().context("final snapshot missing")?;
    ensure!(snapshot["snapshotSha256"] == protocol::hash(raw.as_bytes()), "final snapshot changed");
    compare_children(ledger, &serde_json::from_str(raw)?)?;
    result.1["finalProof"] = json!({"receiptSha256":committed["envelope"]["receiptSha256"],"snapshotSha256":snapshot["snapshotSha256"],"terminal":reference(&records.join("terminal.json"))?,"outcome":terminal["frame"]["outcome_ref"],"lastRunId":run,"observedCalls":result.1["outcome"]["observed_calls"],"fencePresence":"Released","localCallbacksFinished":true,"sidecarJoined":true,"ownedProcessesEmpty":true});
    save_new(&records.join("final-result.json"), &json!({"state":result.0,"result":result.1}))?;
    Ok(result)
}

fn read(path: &Path, bound: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?.take((bound + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= bound, "original Task record exceeds its bound");
    Ok(bytes)
}
pub(super) fn location(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "original Task path must be absolute");
    if path.try_exists()? {
        return Ok(path.canonicalize()?);
    }
    Ok(path
        .parent()
        .context("Task path has no parent")?
        .canonicalize()?
        .join(path.file_name().context("Task path has no name")?))
}
pub(super) fn value_path(value: &Value) -> Result<PathBuf> {
    Ok(PathBuf::from(value.as_str().context("original Task path missing")?))
}

pub struct Original {
    pub root: PathBuf,
    pub dispatch: Dispatch,
    pub record: Value,
    pub session: PathBuf,
    pub fence: PathBuf,
}
impl Original {
    pub fn load_saved(ledger: &Ledger, root_id: &str) -> Result<Self> {
        uuid::Uuid::parse_str(root_id)?;
        let record = object(&ledger.root.join("agents").join(root_id).join("task.json"))?;
        Self::load(
            ledger,
            root_id,
            &value_path(&record["sidecar"])?,
            record["sidecarSha256"].as_str().context("original sidecar SHA missing")?,
        )
    }
    pub fn load(ledger: &Ledger, root_id: &str, sidecar: &Path, sidecar_sha: &str) -> Result<Self> {
        uuid::Uuid::parse_str(root_id)?;
        let stored: String =
            ledger.db.query_row("SELECT dispatch_json FROM operations WHERE id=?", [root_id], |row| row.get(0))?;
        let dispatch: Dispatch = serde_json::from_str(&stored)?;
        let identity = ledger.identity()?;
        dispatch.validate(identity.node_id.as_deref().context("Node identity missing")?, identity.epoch)?;
        ensure!(
            dispatch.operation_id == root_id && dispatch.command["kind"] == "agent.delegate",
            "inspection requires the original delegate Task"
        );
        let root = ledger.root.join("agents").join(root_id).canonicalize()?;
        ensure!(
            root.starts_with(ledger.root.join("agents").canonicalize()?),
            "original Task directory escaped Node state"
        );
        let record: Value = serde_json::from_slice(&read(&root.join("task.json"), 2 * 1024 * 1024)?)?;
        ensure!(record["dispatch"] == serde_json::to_value(&dispatch)?, "original Task dispatch changed");
        let start = &record["start"];
        let task = &start["task"];
        let run = &start["run"];
        ensure!(
            task["task_id"] == root_id
                && task["authorization_revision"] == dispatch.payload_hash
                && task["criteria_revision"] == "reach-receipt-integrity-v1"
                && task["max_runs"] == dispatch.command["maxRuns"]
                && task["max_calls"] == dispatch.command["maxCalls"]
                && task["deadline_unix_ms"] == record["deadlineLocalUnixMs"]
                && run["cwd"] == dispatch.command["cwd"]
                && run["session_key"] == dispatch.command["sessionId"]
                && record["sidecarSha256"] == sidecar_sha
                && crate::agent::file_hash(sidecar)? == sidecar_sha
                && value_path(&record["sidecar"])?.canonicalize()? == sidecar.canonicalize()?,
            "original Task authority changed"
        );
        let session = location(&value_path(&run["session_path"])?)?;
        let expected = ledger
            .root
            .join("agent-sessions")
            .join(dispatch.command["sessionId"].as_str().context("original Session missing")?)
            .join("session.json");
        ensure!(session == location(&expected)?, "original Task Session changed");
        ensure!(
            location(&value_path(&task["evidence_dir"])?)? == location(&root.join("evidence"))?,
            "original Task evidence directory changed"
        );
        let identity = session.to_str().context("Session path is not Unicode")?.to_owned();
        let identity = if cfg!(windows) { identity.to_lowercase() } else { identity };
        let fence = session
            .parent()
            .context("Session parent missing")?
            .join(format!(".ara-lite-harness-{}.fence.json", protocol::hash(identity.as_bytes())));
        Ok(Self { root, dispatch, record, session, fence })
    }
    pub fn observation(&self) -> Result<Value> {
        if !self.fence.try_exists()? {
            return Ok(
                json!({"taskId":self.dispatch.operation_id,"taskAccepted":false,"fencePresent":false,"expectedFenceSha256":null,"observation":"unlocked_readonly","nativeAuthorityVerified":false}),
            );
        }
        let bytes = read(&self.fence, 256 * 1024)?;
        let fence: Value = serde_json::from_slice(&bytes)?;
        let task = &self.record["start"]["task"];
        ensure!(
            fence["version"] == 1
                && fence["task_id"] == self.dispatch.operation_id
                && fence["authorization_revision"] == self.dispatch.payload_hash
                && fence["criteria_revision"] == task["criteria_revision"]
                && fence["deadline_unix_ms"] == task["deadline_unix_ms"]
                && fence["max_calls"] == task["max_calls"]
                && fence["max_runs"] == task["max_runs"]
                && location(&value_path(&fence["session_path"])?)? == self.session,
            "original native fence authority changed"
        );
        let evidence = value_path(&fence["evidence_dir"])?.canonicalize()?;
        ensure!(evidence.starts_with(&self.root), "native fence evidence escaped the original Task");
        Ok(
            json!({"taskId":self.dispatch.operation_id,"taskAccepted":false,"fencePresent":true,"expectedFenceSha256":protocol::hash(&bytes),"observation":"unlocked_readonly","nativeAuthorityVerified":false}),
        )
    }
}
pub fn inspect(ledger: &Ledger, execution: &Dispatch, sidecar: &Path, sidecar_sha: &str) -> Result<(String, Value)> {
    let root_id = execution.command["rootOperationId"].as_str().context("original Task missing")?;
    let original = Original::load_saved(ledger, root_id)?;
    ensure!(crate::agent::file_hash(sidecar)? == sidecar_sha, "inspection runtime image changed");
    let mut result = original.observation()?;
    result["resumeRuntimeMatches"] = json!(
        original.record["sidecarSha256"] == sidecar_sha
            && value_path(&original.record["sidecar"])?.canonicalize()? == sidecar.canonicalize()?
    );
    result["sourceRuntimeSha256"] = original.record["sidecarSha256"].clone();
    result["inspectorSha256"] = json!(sidecar_sha);
    let mut candidates = Vec::new();
    if result["fencePresent"] == false {
        let mut records = vec![(root_id.to_owned(), original.root.clone())];
        let attempts = original.root.join("attempts");
        if attempts.try_exists()? {
            for attempt in fs::read_dir(attempts)? {
                let attempt = attempt?;
                let id = attempt
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("attempt identity is not Unicode"))?;
                if attempt.file_type()?.is_dir() && uuid::Uuid::parse_str(&id).is_ok() {
                    records.push((id, attempt.path()));
                }
            }
        }
        records.sort_by(|a, b| a.0.cmp(&b.0));
        for (id, records) in records {
            let released = records.join("evidence/released.json");
            if released.try_exists()? {
                let bytes = read(&released, 2 * 1024 * 1024)?;
                let value: Value = serde_json::from_slice(&bytes)?;
                ensure!(
                    value["task_id"] == root_id && value["fence_presence"] == "Released",
                    "released candidate identity changed"
                );
                // Candidates are observations, not a source election or permission.
                // The service and held native inspector revalidate all authority.
                candidates.push(json!({"sourceExecutionId":id,"releasedSha256":protocol::hash(&bytes)}));
            }
        }
    }
    result["finalizationCandidates"] = json!(candidates);
    result["version"] = json!(1);
    result["nodeId"] = json!(original.dispatch.node_id);
    result["epoch"] = json!(original.dispatch.epoch);
    result["sessionId"] = original.dispatch.command["sessionId"].clone();
    result["observedAtUnixMs"] =
        json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis() as u64);
    result["inspectionOperationId"] = json!(execution.operation_id);
    Ok(("succeeded".into(), result))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inspection_does_not_report_an_io_failure_as_an_absent_fence() {
        let original = Original {
            root: PathBuf::new(),
            dispatch: Dispatch {
                operation_id: protocol::id(),
                node_id: protocol::id(),
                epoch: 1,
                dispatch_id: protocol::id(),
                payload_hash: "a".repeat(64),
                command: json!({"kind":"agent.delegate"}),
                created_at: 0,
            },
            record: Value::Null,
            session: PathBuf::new(),
            fence: PathBuf::from("invalid\0fence"),
        };
        assert!(original.observation().is_err(), "an unreadable fence must not be reported absent");
    }
}
