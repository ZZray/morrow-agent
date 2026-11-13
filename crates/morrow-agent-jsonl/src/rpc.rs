use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use anyhow::{bail, ensure, Context, Result};
use morrow_agent_harness::{
    core::{artifact_provenance::ToolArtifact, steering::SteeringBuffer},
    task_set::{MAX_GUIDANCE_BYTES, MAX_MESSAGE_ID_BYTES},
    ResumeReceipt, ReviewReceipt, TaskHandle,
};
use serde_json::{json, Value};
use tokio::sync::{oneshot, Notify};
use tokio_util::sync::CancellationToken;

use crate::{
    evidence,
    protocol::{Incoming, ToolReply, TOOL_RESULT_BYTES},
    transport::Output,
};

#[derive(Clone)]
pub struct ToolKey {
    pub native_call_id: String,
    pub tool_name: String,
    pub args_sha256: String,
}

struct Expected {
    kind: &'static str,
    run_id: String,
    tool: Option<ToolKey>,
}

pub enum Reply {
    Tool { rpc_id: String, result: ToolReply },
    Verify(Box<ReviewReceipt>),
    Prepare { run_id: String, objective: String },
    Reconcile(Box<ResumeReceipt>),
    Artifacts(Vec<ToolArtifact>),
}

/// Failure categories of a received frame (10.5). A reply that fails either
/// check is never delivered to its callback.
pub const RPC_MISMATCH: &str = "rpc_mismatch";
pub const INVALID_REPLY_FIELDS: &str = "invalid_reply_fields";
const CALLBACK_UNKNOWN: &str = "external_callback_unknown";

/// Context attached to every failed callback: the `rpc_id` was allocated
/// before admission, so the caller can always name its unknown evidence.
#[derive(Debug)]
pub struct CallFailure {
    pub rpc_id: String,
}

impl std::fmt::Display for CallFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "callback {} failed", self.rpc_id)
    }
}

struct Pending {
    expected: Expected,
    sender: oneshot::Sender<Result<Reply>>,
}

pub struct Bridge {
    pub output: Output,
    pub task_id: String,
    pub evidence_dir: PathBuf,
    pub fault: CancellationToken,
    pub active_run: Mutex<String>,
    pub steering: Arc<Mutex<SteeringBuffer>>,
    guidance_messages: Mutex<BTreeMap<String, String>>,
    stop: CancellationToken,
    local_calls: AtomicUsize,
    local_done: Notify,
    pending: Mutex<HashMap<String, Pending>>,
    serial: AtomicU64,
    grace: Duration,
    category: OnceLock<&'static str>,
}

impl Bridge {
    pub fn new(output: Output, task_id: String, evidence_dir: PathBuf, run_id: String, grace: u64) -> Self {
        Self {
            output,
            task_id,
            evidence_dir,
            fault: CancellationToken::new(),
            active_run: Mutex::new(run_id),
            steering: Arc::new(Mutex::new(SteeringBuffer::default())),
            guidance_messages: Mutex::new(BTreeMap::new()),
            stop: CancellationToken::new(),
            local_calls: AtomicUsize::new(0),
            local_done: Notify::new(),
            pending: Mutex::new(HashMap::new()),
            serial: AtomicU64::new(0),
            grace: Duration::from_millis(grace),
            category: OnceLock::new(),
        }
    }

    pub fn fail(&self) {
        self.fail_with(CALLBACK_UNKNOWN);
    }

    /// Fail every pending callback. The first category is kept; it names why
    /// a resume was refused (`jsonl-resume-rejected.json`).
    pub fn fail_with(&self, category: &'static str) {
        let _ = self.category.set(category);
        self.fault.cancel();
        let pending = std::mem::take(&mut *self.pending.lock().unwrap());
        for (_, item) in pending {
            let _ = item.sender.send(Err(anyhow::anyhow!(category)));
        }
    }

    pub fn failure_category(&self) -> Option<&'static str> {
        self.category.get().copied()
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    /// Deduplication belongs to this Task's JSONL Host and lasts for this process.
    /// The source text is only delivered once to the original steering buffer.
    pub fn guide(&self, handle: &TaskHandle, message_id: &str, text: &str) -> Result<&'static str, &'static str> {
        if message_id.trim().is_empty()
            || message_id.len() > MAX_MESSAGE_ID_BYTES
            || text.trim().is_empty()
            || text.len() > MAX_GUIDANCE_BYTES
        {
            return Err("guidance_invalid_message");
        }
        let digest = evidence::hash(text.as_bytes());
        let mut messages = self.guidance_messages.lock().unwrap();
        if let Some(previous) = messages.get(message_id) {
            return if *previous == digest { Ok("duplicate") } else { Err("guidance_identity_conflict") };
        }
        // The deduplication ledger outlives individual buffer consumption.
        if messages.len() >= 256 {
            return Err("guidance_capacity_reached");
        }
        handle
            .guide(text.into(), json!({"task_id":self.task_id,"message_id":message_id}))
            .map_err(|_| "guidance_rejected")?;
        messages.insert(message_id.into(), digest);
        Ok("queued")
    }

    /// Call only after Task completion and after joining the input dispatcher.
    /// Preserve the Core's actual context-admission result for every submitted ID.
    pub fn finish_guidance(&self) -> Vec<Value> {
        let messages = self.guidance_messages.lock().unwrap();
        let mut steering = self.steering.lock().unwrap();
        steering.finish();
        let receipts = steering.outcomes_snapshot();
        messages
            .iter()
            .map(|(message_id, input_sha256)| {
                let status = receipts
                    .iter()
                    .find(|receipt| receipt["task_id"] == self.task_id && receipt["message_id"] == *message_id)
                    .and_then(|receipt| receipt["status"].as_str())
                    .filter(|status| matches!(*status, "applied" | "unapplied"))
                    .unwrap_or("unknown");
                json!({"message_id":message_id,"input_sha256":input_sha256,"status":status})
            })
            .collect()
    }

    pub async fn finish_local_callbacks(&self) {
        self.stop.cancel();
        loop {
            let notified = self.local_done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.local_calls.load(Ordering::SeqCst) == 0 {
                break;
            }
            notified.await;
        }
    }

    pub async fn call(
        self: &Arc<Self>,
        kind: &'static str,
        run_id: String,
        request: Value,
        tool: Option<ToolKey>,
        cancellation: CancellationToken,
    ) -> Result<Reply> {
        // Core may drop its tool wait during cancellation. A separately owned
        // local callback survives that waiter and is joined before task_result.
        self.local_calls.fetch_add(1, Ordering::SeqCst);
        let rpc = format!("rpc-{}", self.serial.fetch_add(1, Ordering::SeqCst) + 1);
        let bridge = self.clone();
        let (sender, receiver) = oneshot::channel();
        let call_rpc = rpc.clone();
        tokio::spawn(async move {
            let mut guard = LocalCall { bridge: bridge.clone(), completed: false };
            let result = bridge.run_call(kind, call_rpc, run_id, request, tool, cancellation).await;
            guard.completed = true;
            let _ = sender.send(result);
        });
        receiver
            .await
            .context("external_callback_unknown")
            .and_then(|result| result)
            .map_err(|error| error.context(CallFailure { rpc_id: rpc }))
    }

    async fn run_call(
        &self,
        kind: &'static str,
        rpc: String,
        run_id: String,
        mut request: Value,
        tool: Option<ToolKey>,
        cancellation: CancellationToken,
    ) -> Result<Reply> {
        ensure!(!self.fault.is_cancelled() && !cancellation.is_cancelled(), "callback_not_admitted");
        let fields = request.as_object_mut().context("callback_request_invalid")?;
        fields.insert("kind".into(), json!(kind));
        fields.insert("version".into(), json!(1));
        fields.insert("rpc_id".into(), json!(rpc));
        fields.insert("task_id".into(), json!(self.task_id));
        fields.insert("run_id".into(), json!(run_id));
        let tool_fields = tool.clone();
        let expected = Expected { kind, run_id: run_id.clone(), tool };
        let (sender, mut receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            ensure!(pending.len() < 32, "too_many_pending_callbacks");
            pending.insert(rpc.clone(), Pending { expected, sender });
        }
        let intent = (|| -> Result<()> {
            let wire: Value = serde_json::from_slice(&self.output.encode(&request)?)?;
            evidence::write_new(&evidence::rpc_path(&self.evidence_dir, &rpc, "request"), &wire)?;
            Ok(())
        })();
        if intent.is_err() || self.output.control(request).await.is_err() {
            self.fail();
        }
        let result = tokio::select! {
            biased;
            _ = self.fault.cancelled() => Err(anyhow::anyhow!("external_callback_unknown")),
            result = &mut receiver => result.context("external_callback_unknown").and_then(|v| v),
            _ = async { tokio::select! { _ = cancellation.cancelled() => {}, _ = self.stop.cancelled() => {} } } => {
                let cancel = json!({"kind":"callback_cancel","version":1,"rpc_id":rpc,
                    "task_id":self.task_id,"run_id":run_id,"reason":"cancelled"});
                if self.output.control(cancel).await.is_err() {
                    self.fail();
                    Err(anyhow::anyhow!("external_callback_unknown"))
                } else {
                    match tokio::time::timeout(self.grace, &mut receiver).await {
                        Ok(Ok(reply)) => reply,
                        // 10.4: the reconcile request is never resent; its deadline is a refusal.
                        _ if kind == "reconcile_request" => { self.fail_with("reconcile_timeout"); Err(anyhow::anyhow!("reconcile_timeout")) }
                        _ => { self.fail(); Err(anyhow::anyhow!("external_callback_unknown")) }
                    }
                }
            },
        };
        self.pending.lock().unwrap().remove(&rpc);
        if result.is_err() {
            // Local future completion is NOT remote join or rollback. The
            // caller's original operation receipt remains started/unknown.
            let mut record = json!({"rpc_id":rpc,"task_id":self.task_id,"run_id":run_id,
                "local_callback":"finished","external_settlement":"unknown","no_replay":true});
            if let Some(key) = &tool_fields {
                add_tool_fields(&mut record, key, "callback_unknown");
            }
            let _ = evidence::write_new(&evidence::rpc_path(&self.evidence_dir, &rpc, "unknown"), &record);
        }
        result
    }

    /// The tool call's `rpc-*-unknown` evidence (23.1, 23.5): written by the
    /// failed callback itself, or here for a Host-declared Unknown settlement
    /// and for a call refused before any request was sent.
    pub fn unknown_tool_receipt(
        &self,
        rpc: &str,
        run_id: &str,
        key: &ToolKey,
        reason: &'static str,
    ) -> Result<crate::protocol::Reference> {
        let path = evidence::rpc_path(&self.evidence_dir, rpc, "unknown");
        if !path.exists() {
            let mut record = json!({"rpc_id":rpc,"task_id":self.task_id,"run_id":run_id,
                "local_callback":"finished","external_settlement":"unknown","no_replay":true});
            add_tool_fields(&mut record, key, reason);
            return evidence::write_new(&path, &record);
        }
        let (reference, bytes) = evidence::read_reference(&path)?;
        let stored: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            stored["native_call_id"] == key.native_call_id.as_str()
                && stored["tool_name"] == key.tool_name.as_str()
                && stored["args_sha256"] == key.args_sha256.as_str(),
            "unknown_evidence_tool_mismatch"
        );
        Ok(reference)
    }

    /// Deliver a correlated reply to its pending callback. A refused frame
    /// returns its category: `invalid_reply_fields` for its content, else
    /// `rpc_mismatch` for its kind, version, Task, Run, request or tool identity.
    pub fn receive(&self, incoming: Incoming, raw: &Value) -> std::result::Result<(), &'static str> {
        let check = |ok: bool, category: &'static str| if ok { Ok(()) } else { Err(category) };
        let prepared = |run_id_next: &str, objective: &str| {
            check(!run_id_next.trim().is_empty() && !objective.trim().is_empty(), INVALID_REPLY_FIELDS)
        };
        let (version, rpc, task, run, reply_kind, tool, reply) = match incoming {
            Incoming::ToolReply {
                version,
                rpc_id,
                task_id,
                run_id,
                native_call_id,
                tool_name,
                args_sha256,
                result,
            } => {
                let bytes = serde_json::to_vec(&result_value(&result)).map_err(|_| INVALID_REPLY_FIELDS)?;
                check(bytes.len() <= TOOL_RESULT_BYTES, INVALID_REPLY_FIELDS)?;
                check(!result.operation_receipt.trim().is_empty(), INVALID_REPLY_FIELDS)?;
                (
                    version,
                    rpc_id.clone(),
                    task_id,
                    run_id,
                    "tool_call",
                    Some(ToolKey { native_call_id, tool_name, args_sha256 }),
                    Reply::Tool { rpc_id, result },
                )
            }
            Incoming::VerifyReply { version, rpc_id, task_id, run_id, receipt } => {
                strict_receipt(&raw["receipt"]).map_err(|_| INVALID_REPLY_FIELDS)?;
                (version, rpc_id, task_id, run_id, "verify_request", None, Reply::Verify(Box::new(receipt)))
            }
            Incoming::ReviewArtifactsReply { version, rpc_id, task_id, run_id, artifacts } => {
                let mut ids = std::collections::HashSet::new();
                for artifact in &artifacts {
                    artifact.validate().map_err(|_| INVALID_REPLY_FIELDS)?;
                    check(artifact.task_id == task_id && artifact.run_id == run_id, INVALID_REPLY_FIELDS)?;
                    check(ids.insert(artifact.artifact_id.as_str()), INVALID_REPLY_FIELDS)?;
                }
                (version, rpc_id, task_id, run_id, "review_artifacts_request", None, Reply::Artifacts(artifacts))
            }
            Incoming::VerifyBudgetReply { version, rpc_id, task_id, run_id, receipt } => {
                strict_receipt(&raw["receipt"]).map_err(|_| INVALID_REPLY_FIELDS)?;
                (version, rpc_id, task_id, run_id, "verify_budget_request", None, Reply::Verify(Box::new(receipt)))
            }
            Incoming::VerifyStopReply { version, rpc_id, task_id, run_id, receipt } => {
                strict_receipt(&raw["receipt"]).map_err(|_| INVALID_REPLY_FIELDS)?;
                (version, rpc_id, task_id, run_id, "verify_stop_request", None, Reply::Verify(Box::new(receipt)))
            }
            Incoming::ReconcileReply { version, rpc_id, task_id, run_id, receipt } => {
                strict_resume_receipt(&raw["receipt"]).map_err(|_| INVALID_REPLY_FIELDS)?;
                (version, rpc_id, task_id, run_id, "reconcile_request", None, Reply::Reconcile(Box::new(receipt)))
            }
            Incoming::PrepareStopReply { version, rpc_id, task_id, run_id, run_id_next, objective } => {
                prepared(&run_id_next, &objective)?;
                (
                    version,
                    rpc_id,
                    task_id,
                    run_id,
                    "prepare_stop_request",
                    None,
                    Reply::Prepare { run_id: run_id_next, objective },
                )
            }
            Incoming::PrepareReply { version, rpc_id, task_id, run_id, run_id_next, objective } => {
                prepared(&run_id_next, &objective)?;
                (
                    version,
                    rpc_id,
                    task_id,
                    run_id,
                    "prepare_request",
                    None,
                    Reply::Prepare { run_id: run_id_next, objective },
                )
            }
            Incoming::PrepareBudgetReply { version, rpc_id, task_id, run_id, run_id_next, objective } => {
                prepared(&run_id_next, &objective)?;
                (
                    version,
                    rpc_id,
                    task_id,
                    run_id,
                    "prepare_budget_request",
                    None,
                    Reply::Prepare { run_id: run_id_next, objective },
                )
            }
            Incoming::Cancel { .. } | Incoming::Guide { .. } => return Err(RPC_MISMATCH),
        };
        check(version == 1 && task == self.task_id, RPC_MISMATCH)?;
        let mut pending = self.pending.lock().unwrap();
        let item = pending.get(&rpc).ok_or(RPC_MISMATCH)?;
        check(item.expected.kind == reply_kind && item.expected.run_id == run, RPC_MISMATCH)?;
        match (&item.expected.tool, tool) {
            (None, None) => {}
            (Some(expected), Some(actual)) => check(
                expected.native_call_id == actual.native_call_id
                    && expected.tool_name == actual.tool_name
                    && expected.args_sha256 == actual.args_sha256,
                RPC_MISMATCH,
            )?,
            _ => return Err(RPC_MISMATCH),
        }
        // Persist the actual correlated reply before the local callback consumes
        // a Host settlement declaration. This is still a trusted Host claim.
        evidence::write_new(&evidence::rpc_path(&self.evidence_dir, &rpc, "reply"), raw)
            .map_err(|_| CALLBACK_UNKNOWN)?;
        let item = pending.remove(&rpc).ok_or(RPC_MISMATCH)?;
        let _ = item.sender.send(Ok(reply));
        Ok(())
    }
}

struct LocalCall {
    bridge: Arc<Bridge>,
    completed: bool,
}

impl Drop for LocalCall {
    fn drop(&mut self) {
        if !self.completed {
            self.bridge.fail();
        }
        self.bridge.local_calls.fetch_sub(1, Ordering::SeqCst);
        self.bridge.local_done.notify_waiters();
    }
}

fn add_tool_fields(record: &mut Value, key: &ToolKey, reason: &str) {
    record["native_call_id"] = json!(key.native_call_id);
    record["tool_name"] = json!(key.tool_name);
    record["args_sha256"] = json!(key.args_sha256);
    record["reason"] = json!(reason);
}

pub fn result_value(result: &ToolReply) -> Value {
    json!({"value":result.value,"is_error":result.is_error,"settlement":result.settlement,
        "operation_receipt":result.operation_receipt})
}

fn keys(value: &Value, allowed: &[&str]) -> Result<()> {
    ensure!(
        value.as_object().context("object_required")?.keys().all(|key| allowed.contains(&key.as_str())),
        "unknown_nested_field"
    );
    Ok(())
}

fn strict_receipt(value: &Value) -> Result<()> {
    keys(value, &["basis", "committed", "settlement", "verdict", "evidence"])?;
    keys(
        &value["basis"],
        &[
            "task_id",
            "criteria_revision",
            "authorization_revision",
            "run_id",
            "session_id",
            "run_number",
            "session_path",
            "events_path",
            "events_sha256",
            "event_count",
            "run_calls",
            "total_calls",
            "journal_head_sha256",
            "raw_start",
            "raw_end",
            "raw_proof",
        ],
    )?;
    if value["verdict"].is_object() {
        keys(&value["verdict"], &["NeedsChanges"])?;
        keys(&value["verdict"]["NeedsChanges"], &["feedback"])?;
    }
    Ok(())
}

/// Exact `ResumeReceipt` key sets (10.3, 10.5); typed parsing checks the
/// value types and that no field is missing.
fn strict_resume_receipt(value: &Value) -> Result<()> {
    keys(value, &["committed", "settlement", "tool_calls", "evidence"])?;
    for call in value["tool_calls"].as_array().context("tool_calls_array_required")? {
        keys(call, &["call_id", "settlement"])?;
        let settlement = &call["settlement"];
        match settlement["kind"].as_str() {
            Some("not_executed") => keys(settlement, &["kind"])?,
            Some("completed" | "failed") => keys(settlement, &["kind", "output"])?,
            _ => bail!("settlement_kind_invalid"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::decode;
    use proptest::prelude::*;

    /// Reply variants and their category: `None` is delivered.
    const VARIANTS: [(&str, Option<&str>); 15] = [
        ("valid", None),
        ("valid_not_executed", None),
        ("other_rpc_id", Some(RPC_MISMATCH)),
        ("other_task_id", Some(RPC_MISMATCH)),
        ("other_run_id", Some(RPC_MISMATCH)),
        ("version_2", Some(RPC_MISMATCH)),
        ("missing_receipt_field", Some(INVALID_REPLY_FIELDS)),
        ("extra_receipt_field", Some(INVALID_REPLY_FIELDS)),
        ("committed_wrong_type", Some(INVALID_REPLY_FIELDS)),
        ("evidence_wrong_type", Some(INVALID_REPLY_FIELDS)),
        ("unknown_settlement_kind", Some(INVALID_REPLY_FIELDS)),
        ("extra_tool_call_field", Some(INVALID_REPLY_FIELDS)),
        ("not_executed_with_output", Some(INVALID_REPLY_FIELDS)),
        ("extra_frame_field", Some(INVALID_REPLY_FIELDS)),
        ("not_json", Some(INVALID_REPLY_FIELDS)),
    ];
    const FIELDS: [&str; 4] = ["committed", "settlement", "tool_calls", "evidence"];

    struct Fixture {
        directory: PathBuf,
        bridge: Bridge,
        receiver: oneshot::Receiver<Result<Reply>>,
    }

    impl Fixture {
        fn new() -> Self {
            Self::for_kind("reconcile_request")
        }

        fn for_kind(kind: &'static str) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "ara-jsonl-reconcile-prop-{}-{}",
                std::process::id(),
                morrow_agent_harness::core::fresh_id()
            ));
            std::fs::create_dir(&directory).unwrap();
            let bridge = Bridge::new(
                Output::stdout("prop-secret-token".into()),
                "task-1".into(),
                directory.clone(),
                "run-1".into(),
                1000,
            );
            let (sender, receiver) = oneshot::channel();
            let expected = Expected { kind, run_id: "run-1".into(), tool: None };
            bridge.pending.lock().unwrap().insert("rpc-1".into(), Pending { expected, sender });
            Self { directory, bridge, receiver }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only the one reply file and the new empty directory of this case.
            let _ = std::fs::remove_file(evidence::rpc_path(&self.directory, "rpc-1", "reply"));
            let _ = std::fs::remove_dir(&self.directory);
        }
    }

    fn variant(name: &str, other: &str, field: usize, evidence: &[String]) -> Vec<u8> {
        let mut receipt = json!({"committed":true,"settlement":"Settled",
            "tool_calls":[{"call_id":"call-7","settlement":{"kind":"completed","output":"Host log: done."}}],
            "evidence":evidence});
        let mut frame =
            json!({"kind":"reconcile_reply","version":1,"rpc_id":"rpc-1","task_id":"task-1","run_id":"run-1"});
        match name {
            "valid_not_executed" => receipt["tool_calls"][0]["settlement"] = json!({"kind":"not_executed"}),
            "other_rpc_id" => frame["rpc_id"] = json!(other),
            "other_task_id" => frame["task_id"] = json!(other),
            "other_run_id" => frame["run_id"] = json!(other),
            "version_2" => frame["version"] = json!(2),
            "missing_receipt_field" => {
                receipt.as_object_mut().unwrap().remove(FIELDS[field]);
            }
            "extra_receipt_field" => receipt[other] = json!(true),
            "committed_wrong_type" => receipt["committed"] = json!("true"),
            "evidence_wrong_type" => receipt["evidence"] = json!(other),
            "unknown_settlement_kind" => receipt["tool_calls"][0]["settlement"]["kind"] = json!("unknown"),
            "extra_tool_call_field" => receipt["tool_calls"][0]["replayed"] = json!(false),
            "not_executed_with_output" => {
                receipt["tool_calls"][0]["settlement"] = json!({"kind":"not_executed","output":other})
            }
            "extra_frame_field" => frame["review"] = json!({}),
            _ => {}
        }
        frame["receipt"] = receipt;
        let mut bytes = serde_json::to_vec(&frame).unwrap();
        if name == "not_json" {
            bytes.truncate(bytes.len() - 1);
        }
        bytes
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(256))]

        // Feature: ara-lite-core-capability, Property 19: 结算回复关联
        /// Property 19 (10.3, 10.5): a reply reaches the pending reconcile
        /// callback only with every correlation field equal and a strictly
        /// valid receipt, and only after its reply evidence is written.
        #[test]
        fn reconcile_reply_correlation(
            index in 0usize..VARIANTS.len(),
            suffix in "[a-z0-9-]{1,12}",
            field in 0usize..FIELDS.len(),
            evidence in proptest::collection::vec("[ -~]{1,24}", 0..3),
        ) {
            let (name, category) = VARIANTS[index];
            let other = format!("other-{suffix}");
            let mut fixture = Fixture::new();
            let bytes = variant(name, &other, field, &evidence);
            let result = decode(&bytes)
                .ok_or(INVALID_REPLY_FIELDS)
                .and_then(|(message, raw)| fixture.bridge.receive(message, &raw));
            let reply_path = evidence::rpc_path(&fixture.directory, "rpc-1", "reply");
            prop_assert_eq!(result.err(), category, "{}", name);
            if category.is_none() {
                let raw: Value = serde_json::from_slice(&bytes).unwrap();
                let stored: Value = serde_json::from_slice(&std::fs::read(&reply_path).unwrap()).unwrap();
                prop_assert_eq!(&stored, &raw);
                let Ok(Ok(Reply::Reconcile(receipt))) = fixture.receiver.try_recv() else {
                    return Err(TestCaseError::fail("valid reply was not delivered"));
                };
                prop_assert_eq!(serde_json::to_value(*receipt).unwrap(), raw["receipt"].clone());
                prop_assert_eq!(fixture.bridge.pending_count(), 0);
            } else {
                prop_assert!(!reply_path.exists(), "a refused reply leaves no reply evidence");
                prop_assert!(fixture.receiver.try_recv().is_err(), "a refused reply is not delivered");
                prop_assert_eq!(fixture.bridge.pending_count(), 1);
            }
        }
    }

    #[test]
    fn first_failure_category_is_kept_and_fail_is_callback_unknown() {
        let fixture = Fixture::new();
        assert_eq!(fixture.bridge.failure_category(), None);
        fixture.bridge.fail_with("stdin_closed");
        fixture.bridge.fail();
        assert_eq!(fixture.bridge.failure_category(), Some("stdin_closed"));
        assert_eq!(fixture.bridge.pending_count(), 0);
        let other = Fixture::new();
        other.bridge.fail();
        assert_eq!(other.bridge.failure_category(), Some(CALLBACK_UNKNOWN));
    }

    #[test]
    fn guidance_completion_preserves_context_admission_and_closes_pending_messages() {
        let fixture = Fixture::new();
        let bridge = &fixture.bridge;
        bridge.guidance_messages.lock().unwrap().extend([
            ("applied".into(), evidence::hash(b"first")),
            ("pending".into(), evidence::hash(b"second")),
            ("missing".into(), evidence::hash(b"third")),
        ]);
        {
            let mut steering = bridge.steering.lock().unwrap();
            steering.submit("first".into(), json!({"task_id":bridge.task_id,"message_id":"applied"})).unwrap();
            let notes = steering.take_pending();
            steering.complete(notes, true);
            steering.submit("second".into(), json!({"task_id":bridge.task_id,"message_id":"pending"})).unwrap();
            steering.submit("other Task".into(), json!({"task_id":"other","message_id":"missing"})).unwrap();
        }
        let receipts = bridge.finish_guidance();
        assert_eq!(
            receipts,
            vec![
                json!({"message_id":"applied","input_sha256":evidence::hash(b"first"),"status":"applied"}),
                json!({"message_id":"missing","input_sha256":evidence::hash(b"third"),"status":"unknown"}),
                json!({"message_id":"pending","input_sha256":evidence::hash(b"second"),"status":"unapplied"}),
            ]
        );
        assert_eq!(bridge.finish_guidance(), receipts);
        assert!(bridge.steering.lock().unwrap().is_empty());
    }

    fn artifact_reply() -> Value {
        json!({"kind":"review_artifacts_reply","version":1,"rpc_id":"rpc-1","task_id":"task-1","run_id":"run-1",
            "artifacts":[{"version":1,"artifact_id":"artifact-1","task_id":"task-1","session_id":"session-1",
                "run_id":"run-1","native_call_id":"call-1","tool":"write_answer","input_sha256":"a".repeat(64),
                "output_sha256":"b".repeat(64),"artifact_ref":"answer.txt","status":"candidate","created_at":"1"}]})
    }

    #[test]
    fn artifact_reply_requires_real_pending_kind_and_all_correlation_fields() {
        for changed in ["valid", "version", "rpc_id", "task_id", "run_id", "kind"] {
            let mut fixture =
                Fixture::for_kind(if changed == "kind" { "verify_request" } else { "review_artifacts_request" });
            let mut raw = artifact_reply();
            match changed {
                "version" => raw["version"] = json!(2),
                "rpc_id" => raw["rpc_id"] = json!("other-rpc"),
                "task_id" => {
                    raw["task_id"] = json!("other-task");
                    raw["artifacts"][0]["task_id"] = json!("other-task");
                }
                "run_id" => {
                    raw["run_id"] = json!("other-run");
                    raw["artifacts"][0]["run_id"] = json!("other-run");
                }
                _ => {}
            }
            let bytes = serde_json::to_vec(&raw).unwrap();
            let (incoming, raw) = decode(&bytes).unwrap();
            let result = fixture.bridge.receive(incoming, &raw);
            let reply_path = evidence::rpc_path(&fixture.directory, "rpc-1", "reply");
            if changed == "valid" {
                assert_eq!(result, Ok(()));
                let stored: Value = serde_json::from_slice(&std::fs::read(&reply_path).unwrap()).unwrap();
                assert_eq!(stored, raw);
                let Ok(Ok(Reply::Artifacts(artifacts))) = fixture.receiver.try_recv() else {
                    panic!("reply not delivered")
                };
                assert_eq!(artifacts.len(), 1);
                assert_eq!(artifacts[0].artifact_id, "artifact-1");
                let (duplicate, raw) = decode(&bytes).unwrap();
                assert_eq!(fixture.bridge.receive(duplicate, &raw), Err(RPC_MISMATCH));
            } else {
                assert_eq!(result, Err(RPC_MISMATCH), "{changed}");
                assert!(!reply_path.exists());
                assert!(fixture.receiver.try_recv().is_err());
                assert_eq!(fixture.bridge.pending_count(), 1);
            }
        }
        let mut unsolicited = Fixture::for_kind("review_artifacts_request");
        unsolicited.bridge.pending.lock().unwrap().clear();
        let (incoming, raw) = decode(&serde_json::to_vec(&artifact_reply()).unwrap()).unwrap();
        assert_eq!(unsolicited.bridge.receive(incoming, &raw), Err(RPC_MISMATCH));
        assert!(!evidence::rpc_path(&unsolicited.directory, "rpc-1", "reply").exists());
        assert!(unsolicited.receiver.try_recv().is_err());
    }

    #[test]
    fn artifact_reply_rejects_malformed_nested_records_without_delivery() {
        for changed in [
            "missing",
            "list_type",
            "unknown_frame",
            "unknown_artifact",
            "unknown_receipt",
            "receipt_type",
            "bad_hash",
            "empty_call",
            "wrong_task",
            "wrong_run",
            "duplicate_id",
            "verified_without_receipt",
        ] {
            let mut fixture = Fixture::for_kind("review_artifacts_request");
            let mut raw = artifact_reply();
            match changed {
                "missing" => {
                    raw.as_object_mut().unwrap().remove("artifacts");
                }
                "list_type" => raw["artifacts"] = json!({}),
                "unknown_frame" => raw["extra"] = json!(1),
                "unknown_artifact" => raw["artifacts"][0]["extra"] = json!(1),
                "unknown_receipt" => raw["artifacts"][0]["host_receipt"] = json!({"extra":1}),
                "receipt_type" => raw["artifacts"][0]["host_receipt"] = json!(true),
                "bad_hash" => raw["artifacts"][0]["output_sha256"] = json!("bad"),
                "empty_call" => raw["artifacts"][0]["native_call_id"] = json!(""),
                "wrong_task" => raw["artifacts"][0]["task_id"] = json!("other-task"),
                "wrong_run" => raw["artifacts"][0]["run_id"] = json!("other-run"),
                "duplicate_id" => {
                    let duplicate = raw["artifacts"][0].clone();
                    raw["artifacts"].as_array_mut().unwrap().push(duplicate);
                }
                "verified_without_receipt" => raw["artifacts"][0]["status"] = json!("verified"),
                _ => unreachable!(),
            }
            let result = decode(&serde_json::to_vec(&raw).unwrap())
                .ok_or(INVALID_REPLY_FIELDS)
                .and_then(|(message, value)| fixture.bridge.receive(message, &value));
            assert_eq!(result, Err(INVALID_REPLY_FIELDS), "{changed}");
            assert_eq!(fixture.bridge.pending_count(), 1);
            assert!(fixture.receiver.try_recv().is_err());
            assert!(!evidence::rpc_path(&fixture.directory, "rpc-1", "reply").exists());
        }
        let mut duplicate_keys = serde_json::to_vec(&artifact_reply()).unwrap();
        duplicate_keys.pop();
        duplicate_keys.extend_from_slice(b",\"artifacts\":[]}");
        assert!(decode(&duplicate_keys).is_none());
    }

    #[test]
    fn review_receipt_basis_accepts_session_identity_and_legacy_omission() {
        let mut basis = json!({
            "task_id":"task-1", "criteria_revision":"criteria-1", "authorization_revision":"auth-1",
            "run_id":"run-1", "session_id":"session-1", "run_number":1,
            "session_path":"session.json", "events_path":"events.jsonl", "events_sha256":"hash",
            "event_count":1, "run_calls":1, "total_calls":1, "journal_head_sha256":"head",
            "raw_start":0, "raw_end":1, "raw_proof":"proof"
        });
        let receipt = json!({"basis":basis,"committed":true,"settlement":"Settled","verdict":"Verified","evidence":[]});
        assert!(strict_receipt(&receipt).is_ok());
        basis.as_object_mut().unwrap().remove("session_id");
        let mut legacy = receipt;
        legacy["basis"] = basis;
        assert!(strict_receipt(&legacy).is_ok());
    }
}
