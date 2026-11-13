// Copyright (c) Ray Zhang. Query original native release under a held inspector; never start a Task or replay a tool.
use crate::{
    agent::{self, checked_reference, read, save_new, Runtime},
    agent_process::{self, Owner},
    agent_resume::{self, location, number, object, reference, value_path, Original},
    api::Api,
    control::{self, Control},
    job::Job,
    ledger::Ledger,
    protocol::{self, Dispatch},
};
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    sync::watch,
    time::Instant,
};

const FRAME: u64 = 256 * 1024;
struct Inspector {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    job: Job,
    frame: Value,
    record: Value,
    raw: Vec<u8>,
    lease: String,
    deadline: Instant,
    request_sha: String,
}
async fn frame(reader: &mut BufReader<tokio::process::ChildStdout>) -> Result<Value> {
    let mut bytes = Vec::new();
    let n =
        tokio::time::timeout(Duration::from_secs(5), reader.take(FRAME + 1).read_until(b'\n', &mut bytes)).await??;
    ensure!(n > 0 && n <= FRAME as usize && bytes.last() == Some(&b'\n'), "inspector control frame is incomplete");
    Ok(serde_json::from_slice(&bytes)?)
}
impl Inspector {
    async fn start(
        runtime: &Runtime,
        root: &Dispatch,
        execution: &Dispatch,
        request: Value,
        directory: &Path,
    ) -> Result<Self> {
        ensure!(
            runtime.inspection_lease && agent::file_hash(&runtime.sidecar)? == runtime.sha,
            "inspector image changed"
        );
        let lease = {
            use base64::Engine;
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("inspector lease entropy unavailable"))?;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        };
        let request = json!({"kind":"inspect_session","version":1,"request_id":execution.operation_id,"request":request,"output_directory":directory,"hold":{"version":1,"lease_id":lease,"timeout_ms":30000}});
        let mut bytes = serde_json::to_vec(&request)?;
        bytes.push(b'\n');
        let request_sha = protocol::hash(&bytes);
        let deadline = Instant::now() + Duration::from_secs(29);
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
            "LOCALAPPDATA",
            "APPDATA",
            "PATHEXT",
            "ComSpec",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .current_dir(directory.parent().context("inspector output parent missing")?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .creation_flags(0x08000000);
        let mut child = command.spawn()?;
        let job_name = format!("Global\\RY.Reach.Agent.{}.{}", execution.operation_id, protocol::id());
        let job = Job::assign_named(&child, &job_name)?;
        let owner = agent_process::capture(root, execution, &child, &runtime.sha, &job_name)?;
        save_new(
            &directory.parent().context("inspector evidence parent missing")?.join("inspector-owner.json"),
            &serde_json::to_value(&owner)?,
        )?;
        let mut stdin = child.stdin.take().context("inspector stdin missing")?;
        let mut stdout = BufReader::new(child.stdout.take().context("inspector stdout missing")?);
        agent::send(&mut stdin, &request).await?;
        let result = frame(&mut stdout).await?;
        ensure!(
            result["kind"] == "session_inspection_result"
                && result["version"] == 1
                && result["request_id"] == execution.operation_id
                && result["request_sha256"] == request_sha
                && result["lease"]["version"] == 1
                && result["lease"]["lease_id"] == lease
                && result["lease"]["timeout_ms"] == 30000
                && result["lease"]["snapshot_sha256"] == result["result_ref"]["sha256"],
            "inspector held snapshot identity changed"
        );
        let raw = checked_reference(&result["result_ref"], directory, 64 * 1024 * 1024)?;
        let record: Value = serde_json::from_slice(&raw)?;
        ensure!(
            record["kind"] == "locked_session_inspection"
                && record["request_id"] == execution.operation_id
                && record["request_sha256"] == request_sha
                && record["snapshot"]["inspection"]["request"] == request["request"],
            "native inspector did not use the original request"
        );
        Ok(Self { child, stdin, stdout, job, frame: result, record, raw, lease, deadline, request_sha })
    }
    fn live(&mut self) -> Result<()> {
        ensure!(
            Instant::now() < self.deadline && self.child.try_wait()?.is_none(),
            "native inspection lease ended before finalizer sealing"
        );
        Ok(())
    }
    async fn seal(&mut self, commitment: &Value) -> Result<Value> {
        self.live()?;
        let commitment_json = serde_json::to_string(commitment)?;
        let commitment_sha = protocol::hash(commitment_json.as_bytes());
        let request = json!({"kind":"seal_inspection","version":1,"request_id":self.frame["request_id"],"lease_id":self.lease,"snapshot_sha256":self.frame["result_ref"]["sha256"],"commitment_sha256":commitment_sha});
        // A complete published receipt is authoritative even if the inspector
        // exits after publication but before its stdout ACK reaches this Host.
        if agent::send(&mut self.stdin, &request).await.is_ok() {
            let _ = frame(&mut self.stdout).await;
        }
        let path = value_path(&self.frame["result_ref"]["path"])?;
        let directory = path.parent().context("inspection receipt parent missing")?;
        let receipt = reference(&directory.join("seal.json")).context("native inspector did not publish a seal")?;
        let raw = checked_reference(&receipt, directory, 16384)?;
        let sealed: Value = serde_json::from_slice(&raw)?;
        ensure!(
            sealed
                == json!({"kind":"sealed_session_inspection","version":1,"request_id":self.frame["request_id"],"request_sha256":self.request_sha,"lease_id":self.lease,"snapshot_sha256":self.frame["result_ref"]["sha256"],"commitment_sha256":commitment_sha}),
            "native inspection seal does not bind this exact result"
        );
        Ok(json!({"version":1,"receipt":receipt,"commitmentSha256":commitment_sha,"commitmentJson":commitment_json}))
    }
    async fn close(mut self, committed: bool) -> Result<()> {
        if committed && self.live().is_ok() {
            let release = json!({"kind":"release_inspection","version":1,"request_id":self.frame["request_id"],"lease_id":self.lease,"snapshot_sha256":self.frame["result_ref"]["sha256"]});
            agent::send(&mut self.stdin, &release).await?;
            let released = frame(&mut self.stdout).await?;
            ensure!(
                released["kind"] == "session_inspection_released"
                    && released["lease_id"] == self.lease
                    && released["snapshot_sha256"] == self.frame["result_ref"]["sha256"],
                "inspector release changed"
            );
        }
        drop(self.stdin);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
        self.job.terminate()?;
        let _ = tokio::time::timeout(Duration::from_secs(3), self.child.wait()).await;
        ensure!(self.job.empty()?, "read-only inspector process tree did not exit");
        Ok(())
    }
}

#[derive(Deserialize)]
struct RawHead {
    head: Box<serde_json::value::RawValue>,
}
#[derive(Deserialize)]
struct RawSnapshot {
    inspection: RawHead,
}
#[derive(Deserialize)]
struct RawRecord {
    snapshot: RawSnapshot,
}
fn validate_native(
    original: &Original,
    source: &Dispatch,
    records: &Path,
    inspector: &Inspector,
    outcome: &Value,
) -> Result<Value> {
    let inspection = &inspector.record["snapshot"]["inspection"];
    let snapshot = &inspector.record["snapshot"];
    let basis = &outcome["last_receipt"]["basis"];
    ensure!(
        snapshot["version"] == 1
            && snapshot["fence"].is_null()
            && snapshot["closing_marker"].is_null()
            && inspection["absent"] == false
            && inspection["transcript_closed"] == true
            && inspection["pending_run"].is_null()
            && inspection["unknown_effect_result_indices"]
                .as_array()
                .context("native unknown-effect set missing")?
                .is_empty(),
        "native Session is not closed and effect-known"
    );
    ensure!(
        location(&value_path(&inspection["canonical_session_path"])?)? == original.session
            && inspection["range_proof"] == basis["raw_proof"]
            && inspection["from_raw"] == basis["raw_start"]
            && inspection["to_raw"] == basis["raw_end"],
        "native Session range changed after original Host review"
    );
    let raw: RawRecord = serde_json::from_slice(&inspector.raw)?;
    ensure!(
        basis["journal_head_sha256"] == protocol::hash(raw.snapshot.inspection.head.get().as_bytes()),
        "original native journal head changed"
    );
    let number = number(basis, "run_number")?;
    let decision = object(&records.join(format!("review-decision-{number}.json")))?;
    ensure!(
        decision["reply"]["receipt"] == outcome["last_receipt"]
            && decision["subject"]["basis"] == *basis
            && basis["task_id"] == original.dispatch.operation_id
            && basis["authorization_revision"] == original.dispatch.payload_hash
            && basis["criteria_revision"] == "reach-receipt-integrity-v1",
        "original Host review or authority changed"
    );
    let proof = if decision["subjectKind"] == "closed_budget" {
        agent::check_budget_snapshot(&decision["subject"], &records.join("evidence"))?;
        ensure!(outcome["last_candidate"].is_null(), "closed budget became a final candidate");
        let index = object(&records.join("evidence").join(format!("run-{number}-budget-review-index.json")))?;
        ensure!(index["receipt"] == outcome["last_receipt"], "native budget receipt changed");
        let subject: Value = serde_json::from_slice(&checked_reference(
            &index["snapshot"],
            &records.join("evidence"),
            2 * 1024 * 1024,
        )?)?;
        ensure!(subject == decision["subject"], "native budget snapshot changed");
        reference(&records.join("evidence").join(format!("run-{number}-budget-review-index.json")))?
    } else {
        ensure!(outcome["last_candidate"] == decision["subject"], "original native candidate changed");
        reference(&records.join(format!("review-decision-{number}.json")))?
    };
    let _ = checked_reference(
        &json!({"path":basis["events_path"],"sha256":basis["events_sha256"]}),
        &records.join("evidence"),
        8 * 1024 * 1024,
    )?;
    let start = object(&records.join("task.json"))?;
    ensure!(
        start["execution"] == serde_json::to_value(source)?
            && start["dispatch"] == serde_json::to_value(&original.dispatch)?
            && start["start"]["task"] == object(&records.join("evidence/task.json"))?,
        "source native Task terms changed"
    );
    Ok(proof)
}
fn references(value: &Value, root: &Path) -> Result<()> {
    if let (Some(path), Some(hash)) =
        (value.get("path").and_then(Value::as_str), value.get("sha256").and_then(Value::as_str))
    {
        if hash.len() == 64 {
            let path = PathBuf::from(path).canonicalize()?;
            ensure!(path.starts_with(root), "original reference escaped Task evidence");
            ensure!(agent::file_hash(&path)? == hash, "original source evidence reference changed");
        }
    }
    match value {
        Value::Object(map) => {
            for v in map.values() {
                references(v, root)?;
            }
        }
        Value::Array(values) => {
            for v in values {
                references(v, root)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn child_terms(ledger: &Ledger, snapshot: &Value, id: &str) -> Result<(Dispatch, protocol::Event, Value)> {
    uuid::Uuid::parse_str(id)?;
    let rows = snapshot["children"]
        .as_array()
        .context("original child set missing")?
        .iter()
        .filter(|c| c["relation"]["child_id"] == id)
        .collect::<Vec<_>>();
    ensure!(rows.len() == 1, "business receipt is not one original service child");
    let dispatch: Dispatch =
        serde_json::from_str(
            &ledger.db.query_row("SELECT dispatch_json FROM operations WHERE id=?", [id], |r| r.get::<_, String>(0))?,
        )?;
    let event = ledger.terminal(id)?;
    ensure!(
        event.kind != "unknown"
            && rows[0]["operation"]["payload_hash"] == dispatch.payload_hash
            && rows[0]["operation"]["execution"] == event.kind,
        "original business receipt binding changed"
    );
    Ok((dispatch, event, rows[0]["relation"].clone()))
}
fn callback_matches(callback: &Value, arguments: &str, relation: &Value, task_id: &str) -> Result<()> {
    ensure!(
        callback["run_id"] == relation["run_id"]
            && callback["native_call_id"] == relation["call_id"]
            && callback["args_sha256"] == relation["args_sha256"]
            && relation["args_sha256"] == protocol::hash(arguments.as_bytes())
            && callback["arguments"] == serde_json::from_str::<Value>(arguments)?,
        "business callback differs from the original service arguments"
    );
    match callback["kind"].as_str() {
        Some("tool_call") => ensure!(
            callback["version"] == 1 && callback["task_id"] == task_id && callback["tool_name"] == "reach_execute",
            "original tool callback authority changed"
        ),
        Some("resume_settled_tool") => {}
        _ => anyhow::bail!("unknown business receipt callback kind"),
    }
    Ok(())
}
// A business result can contain path+sha256 describing a mutable user file.
// Check its exact Ledger/service wrapper first; exclude only that data body from
// the in-memory native-reference walk. Never edit or recreate the stored files.
fn business_reference_view(
    ledger: &Ledger,
    original: &Original,
    records: &Path,
    snapshot: &Value,
    name: &str,
    value: &mut Value,
) -> Result<()> {
    let evidence = records.join("evidence");
    if let Some(id) = name.strip_prefix("child-").and_then(|n| n.strip_suffix(".json")) {
        let (dispatch, event, relation) = child_terms(ledger, snapshot, id)?;
        ensure!(
            value["dispatch"] == serde_json::to_value(&dispatch)? && value["event"] == serde_json::to_value(&event)?,
            "original child receipt file changed"
        );
        callback_matches(
            &value["callback"],
            value["argumentsJson"].as_str().context("original arguments missing")?,
            &relation,
            &original.dispatch.operation_id,
        )?;
        value["event"].as_object_mut().context("child event missing")?.remove("data");
    } else if let Some(id) = name.strip_prefix("result-").and_then(|n| n.strip_suffix(".json")) {
        let (_, event, _) = child_terms(ledger, snapshot, id)?;
        ensure!(
            *value == json!({"operationId":id,"state":event.kind,"result":event.data}),
            "original full business result changed"
        );
        value.as_object_mut().context("result wrapper missing")?.remove("result");
    } else if let Some(rpc) = name.strip_prefix("jsonl-").and_then(|n| n.strip_suffix("-reply.json")) {
        if value["kind"] != "tool_reply" {
            return Ok(());
        }
        ensure!(
            value["version"] == 1
                && value["rpc_id"] == rpc
                && value["task_id"] == original.dispatch.operation_id
                && value["tool_name"] == "reach_execute",
            "original tool reply authority changed"
        );
        let request = object(&evidence.join(format!("jsonl-{rpc}-request.json")))?;
        for key in ["version", "rpc_id", "task_id", "run_id", "tool_name", "native_call_id", "args_sha256"] {
            ensure!(value[key] == request[key], "original request/reply correlation changed");
        }
        // JSONL v1 operation_receipt is an original receipt path, not a path/SHA object.
        let child_path = value_path(&value["result"]["operation_receipt"])?.canonicalize()?;
        ensure!(child_path.starts_with(evidence.canonicalize()?), "tool receipt escaped original evidence");
        let child = object(&child_path)?;
        let id = child["dispatch"]["operationId"].as_str().context("reply child id missing")?;
        ensure!(
            child_path == evidence.join(format!("child-{id}.json")).canonicalize()?,
            "reply points to a different child receipt"
        );
        let (dispatch, event, relation) = child_terms(ledger, snapshot, id)?;
        ensure!(
            child["dispatch"] == serde_json::to_value(&dispatch)?
                && child["event"] == serde_json::to_value(&event)?
                && child["callback"] == request,
            "reply original child wrapper changed"
        );
        callback_matches(
            &request,
            child["argumentsJson"].as_str().context("reply original arguments missing")?,
            &relation,
            &original.dispatch.operation_id,
        )?;
        let mut expected = json!({"operationId":id,"state":event.kind,"result":event.data});
        let window = original.record["resultWindowBytes"].as_u64().context("original result window missing")? as usize;
        let bytes = serde_json::to_vec(&expected)?;
        if bytes.len() > window {
            let full = evidence.join(format!("result-{id}.json"));
            ensure!(read(&full, 4 * 1024 * 1024)? == bytes, "retained full result bytes changed");
            let actual = &value["result"]["value"]["resultRef"];
            ensure!(
                value_path(&actual["path"])?.canonicalize()? == full.canonicalize()?,
                "business resultRef escaped its original file"
            );
            let mut end = window;
            while std::str::from_utf8(&bytes[..end]).is_err() {
                end -= 1;
            }
            expected = json!({"operationId":id,"state":event.kind,"resultRef":{"path":actual["path"],"sha256":protocol::hash(&bytes),"bytes":bytes.len()},"resultWindow":{"offset":0,"nextOffset":end,"totalBytes":bytes.len(),"eof":false,"text":std::str::from_utf8(&bytes[..end])?},"desktop":{"helperGeneration":event.data["helperGeneration"],"sessionRef":event.data["sessionRef"],"snapshotId":event.data["snapshotId"]}});
        }
        ensure!(
            value["result"]["value"] == expected
                && value["result"]["is_error"] == (event.kind != "succeeded")
                && value["result"]["settlement"] == "Settled",
            "original rendered business receipt changed"
        );
        let images =
            if event.kind == "succeeded" { agent::images(ledger, &dispatch, &evidence, true)? } else { Vec::new() };
        if images.is_empty() {
            ensure!(value["result"].get("images").is_none(), "unexpected typed tool image");
        } else {
            let actual = value["result"]["images"].as_array().context("typed original images missing")?;
            ensure!(actual.len() == images.len(), "typed original image count changed");
            for (a, b) in actual.iter().zip(images) {
                for key in ["sha256", "bytes", "mime_type", "width", "height"] {
                    ensure!(a[key] == b[key], "typed original image metadata changed");
                }
                ensure!(
                    value_path(&a["path"])?.canonicalize()? == value_path(&b["path"])?.canonicalize()?,
                    "typed original image path changed"
                );
            }
        }
        if let Some(raw) = value.pointer_mut("/result/value").and_then(Value::as_object_mut) {
            raw.remove("result");
        }
    }
    Ok(())
}
fn validate_source_files(
    ledger: &Ledger,
    original: &Original,
    source: &Dispatch,
    records: &Path,
    snapshot: &Value,
) -> Result<()> {
    for root in [records.to_owned(), records.join("evidence")] {
        for file in fs::read_dir(root)? {
            let file = file?;
            if file.file_type()?.is_file() && file.path().extension().is_some_and(|s| s == "json") {
                let mut value = object(&file.path())?;
                let name = file.file_name().to_string_lossy().into_owned();
                if let Some(run) = name.strip_prefix("admitted-").and_then(|s| s.strip_suffix(".json")) {
                    uuid::Uuid::parse_str(run)?;
                    let origin = snapshot["runOrigins"]
                        .as_array()
                        .context("original Run origins missing")?
                        .iter()
                        .find(|r| r["run_id"] == run)
                        .context("historical admission lost its service owner")?;
                    let admitted: Value = serde_json::from_str(
                        origin["admission_json"].as_str().context("historical service admission missing")?,
                    )?;
                    let mut sent = value.clone();
                    sent["dispatchId"] = json!(source.dispatch_id);
                    sent["payloadHash"] = json!(source.payload_hash);
                    ensure!(
                        origin["admitted_execution_id"] == source.operation_id && admitted == sent,
                        "historical native admission differs from the service original"
                    );
                    // Native release intentionally removed this exact Session fence.
                    // Its historical hash is pinned by the original admission ACK;
                    // every other reference must still exist and match its bytes.
                    ensure!(
                        location(&value_path(&value["fence"]["path"])?)? == original.fence
                            && !original.fence.try_exists()?,
                        "historical released fence identity changed"
                    );
                    value.as_object_mut().context("admission is not an object")?.remove("fence");
                }
                business_reference_view(ledger, original, records, snapshot, &name, &mut value)?;
                references(&value, &original.root)?;
            }
        }
    }
    Ok(())
}
async fn call(api: &Api, execution: &Dispatch, method: &str) -> Result<Value> {
    api.call(
        reqwest::Method::POST,
        &format!("/api/v1/node/agents/{}/finalize/{method}", execution.operation_id),
        Some(&json!({"dispatchId":execution.dispatch_id,"payloadHash":execution.payload_hash})),
    )
    .await
}

pub async fn execute(
    ledger: &mut Ledger,
    api: &Api,
    execution: &Dispatch,
    control: &mut Option<&mut Control>,
    runtime: &Runtime,
) -> Result<(String, Value)> {
    let original =
        Original::load_saved(ledger, execution.command["rootOperationId"].as_str().context("original Task missing")?)?;
    ensure!(!original.fence.try_exists()?, "original native fence is still present; not a finalization");
    let context = call(api, execution, "context").await?;
    let source: Dispatch = serde_json::from_value(context["sourceDispatch"].clone())?;
    source.validate(&execution.node_id, execution.epoch)?;
    ensure!(
        context["rootDispatch"] == serde_json::to_value(&original.dispatch)?
            && context["executionId"] == execution.operation_id
            && context["sourceExecutionId"] == execution.command["sourceExecutionId"]
            && context["activeExecutionId"] == execution.operation_id,
        "finalizer service authority changed"
    );
    let records = if source.operation_id == original.dispatch.operation_id {
        original.root.clone()
    } else {
        original.root.join("attempts").join(&source.operation_id)
    }
    .canonicalize()?;
    let released_path = records.join("evidence/released.json");
    ensure!(
        agent::file_hash(&released_path)? == execution.command["releasedSha256"],
        "original released bytes changed"
    );
    let outcome = object(&released_path)?;
    ensure!(
        outcome["fence_presence"] == "Released"
            && outcome["task_accepted"] == false
            && outcome["reconciliation_fence"].is_null(),
        "original native Task is not released"
    );
    let stop = outcome["stop"].as_str().context("native stop missing")?;
    ensure!(
        ["AwaitingHostAcceptance", "BudgetExhausted", "NeedsChanges"].contains(&stop),
        "original native stop has no reviewed finalization contract"
    );
    let mut conservative = object(&records.join("evidence/outcome.json"))?;
    conservative["fence_presence"] = json!("Released");
    conservative["reconciliation_fence"] = Value::Null;
    ensure!(conservative == outcome, "original release differs from the published conservative outcome");
    let source_owner_path = records.join("sidecar-owner.json");
    let source_owner_ref = reference(&source_owner_path)?;
    ensure!(
        source_owner_ref == context["sourceOwnerEvent"]["processOwner"]
            && context["sourceOwnerEvent"]["taskId"] == original.dispatch.operation_id,
        "original owner was not pinned before execution"
    );
    let owner: Owner = serde_json::from_slice(&read(&source_owner_path, 16384)?)?;
    ensure!(
        owner.task_id == original.dispatch.operation_id
            && owner.execution_id == source.operation_id
            && owner.dispatch_id == source.dispatch_id
            && owner.payload_hash == source.payload_hash
            && owner.node_id == execution.node_id
            && owner.epoch == execution.epoch
            && json!(owner.sidecar_sha256) == original.record["sidecarSha256"],
        "original process ownership changed"
    );
    let observed = agent_process::observe(&owner)?;
    ensure!(
        observed["sidecar"]["originalAlive"] == false
            && (observed["job"]["activeProcesses"] == 0 || observed["job"]["observation"] == "not_found"),
        "original sidecar or descendants remain alive"
    );
    let normal_path = records.join("process-settled.json");
    let has_normal = normal_path.try_exists()?;
    if has_normal {
        let normal = object(&normal_path)?;
        ensure!(
            normal["kind"] == "normal_join_receipt"
                && normal["processOwner"] == source_owner_ref
                && normal["sidecarWaited"] == true
                && normal["jobEmpty"] == true,
            "original normal join receipt changed"
        );
    } else {
        ensure!(observed["host"]["originalAlive"] == false, "original Host still alive without a join receipt");
    }
    for row in context["executions"].as_array().context("execution history missing")? {
        if number(row, "generation")? > number(&context, "sourceGeneration")? {
            let directory = original
                .root
                .join("attempts")
                .join(row["execution_id"].as_str().context("historical execution missing")?);
            ensure!(
                !directory.join("evidence/task.json").try_exists()?
                    && !directory.join("evidence/resume.json").try_exists()?,
                "a later native authority exists after the proposed released source"
            );
        }
    }
    let destination = original.root.join("attempts").join(&execution.operation_id);
    fs::create_dir_all(destination.parent().context("finalizer parent missing")?)?;
    fs::create_dir(&destination).context("finalizer evidence already exists; no implicit repeat")?;
    save_new(&destination.join("source-process-observation.json"), &observed)?;
    save_new(
        &destination.join("finalization-request.json"),
        &json!({"dispatch":execution,"context":context,"inspectorSha256":runtime.sha}),
    )?;
    let mut consumption = agent_resume::consumption_at(&original, &records.join("evidence"))?;
    ensure!(
        outcome["runs"] == consumption["consumedRuns"] && outcome["observed_calls"] == consumption["consumedCalls"],
        "native released consumption changed"
    );
    let runs = consumption["runs"]
        .as_array()
        .context("native runs missing")?
        .iter()
        .map(|r| r["runId"].clone())
        .collect::<Vec<_>>();
    let basis = &outcome["last_receipt"]["basis"];
    let request = json!({"session_path":original.session,"cwd":original.dispatch.command["cwd"],"from_raw":basis["raw_start"],"expected_prefix_proof":null,"expected_runs":runs,"require_context":true,"limits":{"max_messages":100000,"max_input_bytes":67108864,"max_output_bytes":67108864}});
    let mut inspector =
        Inspector::start(runtime, &original.dispatch, execution, request, &destination.join("inspection")).await?;
    let (_signal, stop_signal) = watch::channel(false);
    let result=async{
        inspector.live()?;let review=validate_native(&original,&source,&records,&inspector,&outcome)?;
        let snapshot=loop{inspector.live()?;control::executing(ledger,control)?;ensure!(!control::stopping(control),"finalizer cancelled before sealing");let snapshot=call(api,execution,"snapshot").await?;inspector.live()?;if snapshot["ready"]==true{break snapshot;}tokio::time::sleep(Duration::from_millis(20)).await;};
        let raw=snapshot["snapshotJson"].as_str().context("finalization snapshot missing")?;ensure!(snapshot["snapshotSha256"]==protocol::hash(raw.as_bytes()),"finalizer snapshot bytes changed");let snap:Value=serde_json::from_str(raw)?;agent_resume::compare_children(ledger,&snap)?;agent_resume::compare_models(&original,&snap)?;validate_source_files(ledger,&original,&source,&records,&snap)?;
        let children=snap["children"].as_array().context("child set missing")?.iter().map(|c|c["operation"]["id"].clone()).collect::<Vec<_>>();
        let process=if has_normal{json!({"kind":"normal_join_receipt","owner":source_owner_ref,"receipt":reference(&normal_path)?,"observation":reference(&destination.join("source-process-observation.json"))?})}else{json!({"kind":"recovered_process_exit","owner":source_owner_ref,"observation":reference(&destination.join("source-process-observation.json"))?})};
        consumption["receiptId"]=json!(execution.operation_id);consumption["released"]=reference(&released_path)?;consumption["inspectionSha256"]=inspector.frame["result_ref"]["sha256"].clone();
        let proof=json!({"version":1,"sourceExecutionId":source.operation_id,"sourceGeneration":context["sourceGeneration"],"snapshotSha256":snapshot["snapshotSha256"],"released":reference(&released_path)?,"originalOutcome":reference(&records.join("evidence/outcome.json"))?,"originalTask":reference(&original.root.join("task.json"))?,"sourceTask":reference(&records.join("task.json"))?,"review":review,"inspection":inspector.frame["result_ref"],"inspectionRequestSha256":inspector.request_sha,"leaseId":inspector.lease,"inspectorSha256":runtime.sha,"sessionStateSha256":inspector.record["snapshot"]["inspection"]["snapshot_sha256"],"lastRunId":basis["run_id"],"consumption":consumption,"process":process,"callbackDisposition":"source_owner_exited","nativeTerminalObserved":records.join("terminal.json").try_exists()?});
        let state=if stop=="AwaitingHostAcceptance"{"succeeded"}else{"failed"};let mut result=json!({"taskId":original.dispatch.operation_id,"sessionId":original.dispatch.command["sessionId"],"taskAccepted":false,"finalizedReadOnly":true,"status":if state=="succeeded"{"awaiting_review"}else{"budget_or_feedback_incomplete"},"childOperationIds":children,"outcome":outcome,"finalizationProof":proof});
        inspector.live()?;ensure!(!control::stopping(control),"finalizer stopped before sealing");
        let commitment=json!({"version":1,"taskId":original.dispatch.operation_id,"executionId":execution.operation_id,"sourceExecutionId":source.operation_id,"sourceGeneration":context["sourceGeneration"],"generation":context["executionGeneration"],"dispatchId":execution.dispatch_id,"payloadHash":execution.payload_hash,"nodeId":execution.node_id,"epoch":execution.epoch,"state":state,"result":result});
        save_new(&destination.join("prepared-result.json"),&commitment)?;
        result["finalizationProof"]["inspectionSeal"]=inspector.seal(&commitment).await?;
        // The inspector's atomic seal publication is the lock-bound commit point.
        // Do not revoke a valid seal because the inspector later dies or ACK is lost.
        save_new(&destination.join("sealed-result.json"),&json!({"state":state,"result":result}))?;ledger.event(execution,state,result.clone())?;
        agent::ack(ledger,execution,&stop_signal,control).await?;
        Ok((state.to_owned(),result))
    }.await;
    let committed = result.is_ok();
    let cleanup = inspector.close(committed).await;
    match result {
        Ok(value) => {
            cleanup?;
            Ok(value)
        }
        Err(error) => {
            let _ = cleanup;
            Err(error)
        }
    }
}

#[cfg(test)]
mod business_view_tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};

    struct Fixture {
        ledger: Ledger,
        original: Original,
        records: PathBuf,
        snapshot: Value,
        child: Dispatch,
        frame: Value,
        reply: Value,
        temp: PathBuf,
    }
    fn fixture(large: bool, image: bool) -> Result<Fixture> {
        fixture_with_state(large, image, "succeeded")
    }
    fn fixture_with_state(large: bool, image: bool, state: &str) -> Result<Fixture> {
        let temp = fs::canonicalize(std::env::temp_dir())?.join(format!("reach-business-view-{}", protocol::id()));
        let mut ledger = Ledger::open(&temp)?;
        let parent = Dispatch {
            operation_id: protocol::id(),
            node_id: protocol::id(),
            epoch: 1,
            dispatch_id: protocol::id(),
            payload_hash: "a".repeat(64),
            command: json!({"kind":"agent.delegate"}),
            created_at: 1,
        };
        let records = ledger.root.join("agents").join(&parent.operation_id);
        fs::create_dir_all(records.join("evidence"))?;
        let command = json!({"kind":"file.write","path":"mutable-user-file.txt","contentBase64":"eA=="});
        let arguments = serde_json::to_string(&json!({"command":command}))?;
        let child = Dispatch {
            operation_id: protocol::id(),
            node_id: parent.node_id.clone(),
            epoch: 1,
            dispatch_id: protocol::id(),
            payload_hash: "b".repeat(64),
            command,
            created_at: 1,
        };
        ledger.accept(&child)?;
        ledger.event(&child, "running", json!({"syntheticTest":true}))?;
        if image {
            let bytes = STANDARD.decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2qkAAAAASUVORK5CYII=",
            )?;
            let id = protocol::id();
            let hash = protocol::hash(&bytes);
            ledger.event(&child,"output",json!({"type":"artifact.manifest","artifactId":id,"mimeType":"image/png","chunkCount":1,"byteLength":bytes.len(),"sha256":hash,"width":1,"height":1}))?;
            ledger.event(&child,"output",json!({"type":"artifact.chunk","artifactId":id,"index":0,"dataBase64":STANDARD.encode(&bytes),"sha256":hash}))?;
            ledger.event(&child, "output", json!({"type":"artifact.complete","artifactId":id}))?;
        }
        ledger.event(&child,state,json!({"path":ledger.root.join("mutable-user-file.txt"),"sha256":"c".repeat(64),"text":if large{"x".repeat(9000)}else{"original".into()}}))?;
        let run = protocol::id();
        let frame = json!({"kind":"tool_call","version":1,"task_id":parent.operation_id,"run_id":run,"rpc_id":"rpc-1","tool_name":"reach_execute","native_call_id":"original-call","args_sha256":protocol::hash(arguments.as_bytes()),"arguments":serde_json::from_str::<Value>(&arguments)?});
        let window = if large { 256 } else { 4096 };
        let result = agent::settled_tool(&ledger, &child, &records.join("evidence"), &frame, &arguments, window)?;
        let mut reply = frame.clone();
        reply["kind"] = json!("tool_reply");
        reply.as_object_mut().unwrap().remove("arguments");
        reply["result"] = result;
        save_new(&records.join("evidence/jsonl-rpc-1-request.json"), &frame)?;
        save_new(&records.join("evidence/jsonl-rpc-1-reply.json"), &reply)?;
        let snapshot = json!({"children":[{"relation":{"child_id":child.operation_id,"run_id":run,"call_id":"original-call","args_sha256":protocol::hash(arguments.as_bytes())},"operation":{"payload_hash":child.payload_hash,"execution":state}}]});
        let original = Original {
            root: records.canonicalize()?,
            dispatch: parent,
            record: json!({"resultWindowBytes":window}),
            session: ledger.root.join("session.json"),
            fence: ledger.root.join("unused.fence"),
        };
        Ok(Fixture { ledger, original, records, snapshot, child, frame, reply, temp })
    }
    impl Drop for Fixture {
        fn drop(&mut self) { /* Retain this tiny unit fixture for failure inspection. */
        }
    }
    fn view(f: &Fixture, name: &str, v: &mut Value) -> Result<()> {
        business_reference_view(&f.ledger, &f.original, &f.records, &f.snapshot, name, v)
    }
    #[test]
    fn mutable_business_paths_are_data_after_exact_child_and_rpc_binding() -> Result<()> {
        let f = fixture(false, false)?;
        let name = format!("child-{}.json", f.child.operation_id);
        let mut child = object(&f.records.join("evidence").join(&name))?;
        let before = agent::file_hash(&f.records.join("evidence").join(&name))?;
        ensure!(!f.temp.join("mutable-user-file.txt").exists(), "the business file is intentionally absent");
        view(&f, &name, &mut child)?;
        references(&child, &f.original.root)?;
        let mut reply = f.reply.clone();
        view(&f, "jsonl-rpc-1-reply.json", &mut reply)?;
        references(&reply, &f.original.root)?;
        ensure!(
            agent::file_hash(&f.records.join("evidence").join(&name))? == before,
            "reference view changed original bytes"
        );
        Ok(())
    }
    #[test]
    fn changed_business_body_and_wrong_callback_are_rejected_before_exclusion() -> Result<()> {
        let f = fixture(false, false)?;
        let name = format!("child-{}.json", f.child.operation_id);
        let mut child = object(&f.records.join("evidence").join(&name))?;
        child["event"]["data"]["text"] = json!("changed");
        ensure!(view(&f, &name, &mut child).is_err(), "changed child body accepted");
        let mut reply = f.reply.clone();
        reply["result"]["value"]["result"]["text"] = json!("changed");
        ensure!(view(&f, "jsonl-rpc-1-reply.json", &mut reply).is_err(), "changed rendered body accepted");
        let mut reply = f.reply.clone();
        reply["native_call_id"] = json!("other-call");
        ensure!(view(&f, "jsonl-rpc-1-reply.json", &mut reply).is_err(), "different callback accepted");
        Ok(())
    }
    #[test]
    fn large_result_original_bytes_and_internal_reference_remain_checked() -> Result<()> {
        let f = fixture(true, false)?;
        let name = format!("result-{}.json", f.child.operation_id);
        let mut body = object(&f.records.join("evidence").join(&name))?;
        view(&f, &name, &mut body)?;
        references(&body, &f.original.root)?;
        let mut reply = f.reply.clone();
        view(&f, "jsonl-rpc-1-reply.json", &mut reply)?;
        ensure!(reply.pointer("/result/value/resultRef").is_some(), "internal reference removed");
        references(&reply, &f.original.root)?;
        let outside = f.ledger.root.join("outside-result.json");
        fs::write(&outside, b"outside")?;
        let mut bad = f.reply.clone();
        bad["result"]["value"]["resultRef"]["path"] = json!(outside);
        ensure!(view(&f, "jsonl-rpc-1-reply.json", &mut bad).is_err(), "foreign resultRef accepted");
        let mut bad = f.reply.clone();
        bad["result"]["value"]["resultRef"]["sha256"] = json!("0".repeat(64));
        ensure!(view(&f, "jsonl-rpc-1-reply.json", &mut bad).is_err(), "wrong original result SHA accepted");
        Ok(())
    }
    #[test]
    fn recovered_settled_callback_keeps_its_original_run_and_arguments_contract() -> Result<()> {
        let f = fixture(false, false)?;
        let name = format!("child-{}.json", f.child.operation_id);
        let mut child = object(&f.records.join("evidence").join(&name))?;
        child["callback"] = json!({"kind":"resume_settled_tool","run_id":f.frame["run_id"],"native_call_id":f.frame["native_call_id"],"arguments":f.frame["arguments"],"args_sha256":f.frame["args_sha256"]});
        view(&f, &name, &mut child)?;
        let mut bad = object(&f.records.join("evidence").join(&name))?;
        bad["callback"]["args_sha256"] = json!("0".repeat(64));
        ensure!(view(&f, &name, &mut bad).is_err(), "changed recovered arguments accepted");
        Ok(())
    }
    #[test]
    fn failed_artifact_result_keeps_its_original_non_image_tool_reply() -> Result<()> {
        let f = fixture_with_state(false, true, "failed")?;
        ensure!(
            f.reply["result"]["is_error"] == true && f.reply["result"].get("images").is_none(),
            "failed original result unexpectedly carried typed images"
        );
        ensure!(
            !fs::read_dir(f.records.join("evidence"))?
                .any(|p| p.is_ok_and(|p| p.file_name().to_string_lossy().starts_with("image-"))),
            "no Task PNG was produced for the failed child"
        );
        let mut reply = f.reply.clone();
        view(&f, "jsonl-rpc-1-reply.json", &mut reply)?;
        references(&reply, &f.original.root)?;
        ensure!(
            !fs::read_dir(f.records.join("evidence"))?
                .any(|p| p.is_ok_and(|p| p.file_name().to_string_lossy().starts_with("image-"))),
            "readonly finalizer invented failed-child image materialization"
        );
        Ok(())
    }
    #[test]
    fn typed_images_are_retained_verified_and_never_recreated_during_readonly_finalization() -> Result<()> {
        let f = fixture(false, true)?;
        let mut reply = f.reply.clone();
        view(&f, "jsonl-rpc-1-reply.json", &mut reply)?;
        ensure!(reply.pointer("/result/images/0").is_some(), "typed image removed");
        references(&reply, &f.original.root)?;
        let mut bad = f.reply.clone();
        bad["result"]["images"][0]["sha256"] = json!("0".repeat(64));
        ensure!(view(&f, "jsonl-rpc-1-reply.json", &mut bad).is_err(), "wrong typed image accepted");
        let path = value_path(&f.reply["result"]["images"][0]["path"])?;
        fs::remove_file(&path)?;
        let mut missing = f.reply.clone();
        ensure!(view(&f, "jsonl-rpc-1-reply.json", &mut missing).is_err(), "missing retained image accepted");
        ensure!(!path.exists(), "readonly verification recreated an image");
        Ok(())
    }
}
