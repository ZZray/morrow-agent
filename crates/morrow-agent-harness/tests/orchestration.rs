mod common;

use anyhow::{ensure, Result};
use async_trait::async_trait;
use common::{call, text, Fault, Host, Provider};
use fs2::FileExt;
use morrow_agent_harness::{
    core::{
        rpi_agent::{AgentError, AgentTool, AgentToolResult, ToolResultPartial},
        rpi_ai::{Schema, Tool},
        RunRequest,
    },
    orchestration::*,
    *,
};
use serde_json::json;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const CONFIG: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
fn now() -> u64 {
    common::now_ms()
}
fn fixture() -> (Option<tempfile::TempDir>, PathBuf) {
    if let Some(parent) = std::env::var_os("MORROW_ORCHESTRATION_EVIDENCE") {
        fs::create_dir_all(&parent).unwrap();
        let root = tempfile::tempdir_in(parent).unwrap().keep().canonicalize().unwrap();
        eprintln!("orchestration evidence {}", root.display());
        (None, root)
    } else {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        (Some(directory), root)
    }
}
fn enqueue(store: &Store, root: &Path, id: &str) -> Assignment {
    store
        .enqueue(
            Trigger { id: format!("trigger-{id}"), revision: "1".into(), source_ref: "host:inbox/1".into() },
            Mandate {
                id: format!("mandate-{id}"),
                revision: "1".into(),
                authorization_ref: "host:approval/1".into(),
                configuration_sha256: CONFIG.into(),
            },
            AssignmentSpec {
                id: id.into(),
                trigger_id: format!("trigger-{id}"),
                mandate_id: format!("mandate-{id}"),
                task: TaskSpec {
                    task_id: id.into(),
                    criteria_revision: "actual-file-correct-v1".into(),
                    authorization_revision: "single-file-v1".into(),
                    kind: TaskKind::Coding,
                    evidence_dir: root.join(id),
                    max_runs: 3,
                    max_calls: 8,
                    deadline_unix_ms: now() + 120_000,
                },
                session_id: "test/session".into(),
                session_path: root.join("session.json"),
                cwd: root.into(),
                configuration_sha256: CONFIG.into(),
                options: TaskOptions::default(),
            },
            now(),
        )
        .unwrap()
}
fn intent(id: &str, root: &Path) -> DispatchIntent {
    DispatchIntent {
        attempt_id: "attempt-1".into(),
        run_id: "run-1".into(),
        evidence_dir: root.join(id),
        mode: DispatchMode::Start,
    }
}
fn claim(store: &Store) -> Claim {
    store.claim_next("worker", now(), now() + 120_000).unwrap().unwrap()
}
fn proof(root: &Path, a: &Assignment, decision: RecoveryDecision) -> FileReference {
    let proof = RecoveryAuthorization {
        assignment_id: a.specification.id.clone(),
        attempt_id: a.attempts.last().unwrap().intent.attempt_id.clone(),
        task_id: a.specification.task.task_id.clone(),
        session_path: a.specification.session_path.clone(),
        configuration_sha256: CONFIG.into(),
        committed: true,
        settled: true,
        decision,
    };
    let path = root.join(format!("recovery-{decision:?}.json"));
    let raw = serde_json::to_vec(&proof).unwrap();
    fs::write(&path, &raw).unwrap();
    FileReference { path: path.canonicalize().unwrap(), sha256: core::artifact_provenance::sha256_hex(&raw) }
}
fn child(root: &Path, mode: &str, endpoint: &str) -> std::process::Output {
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "orchestration_child", "--nocapture"])
        .env("MORROW_QUEUE_CHILD_ROOT", root)
        .env("MORROW_QUEUE_CHILD_MODE", mode)
        .env("MORROW_QUEUE_ENDPOINT", endpoint)
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(86),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

struct ExitTool {
    root: PathBuf,
    exit: bool,
    schema: Tool,
}
#[async_trait]
impl AgentTool for ExitTool {
    fn schema(&self) -> &Tool {
        &self.schema
    }
    fn label(&self) -> &str {
        "effect_once"
    }
    async fn execute(
        &self,
        _: &str,
        _: serde_json::Value,
        _: CancellationToken,
        _: Arc<dyn Fn(ToolResultPartial) + Send + Sync>,
    ) -> std::result::Result<AgentToolResult, AgentError> {
        if !self.exit {
            return Err(AgentError::Tool("interrupted external effect must never be replayed".into()));
        }
        let mut file =
            fs::OpenOptions::new().create_new(true).write(true).open(self.root.join("effect-once.txt")).unwrap();
        file.write_all(b"one committed effect").unwrap();
        file.sync_all().unwrap();
        std::process::exit(86)
    }
}
struct QueueHost {
    inner: Host,
    reject_resume: bool,
}
impl QueueHost {
    fn new(root: &Path, provider: &Provider, endpoint: &str, exit: bool) -> Self {
        let mut inner = Host::new(root, provider, Fault::None);
        inner.endpoint = endpoint.into();
        inner.read_tool = Some(Arc::new(ExitTool {
            root: root.into(),
            exit,
            schema: Tool {
                name: "effect_once".into(),
                description: "One Host-owned external effect.".into(),
                parameters: Schema(json!({"type":"object","properties":{}})),
                constrained_sampling: None,
            },
        }));
        Self { inner, reject_resume: false }
    }
    fn request(&self, id: &str) -> RunRequest {
        self.inner.request(id)
    }
}
#[async_trait]
impl HarnessHost for QueueHost {
    async fn verify(&self, candidate: Candidate, cancel: CancellationToken) -> Result<ReviewReceipt> {
        if self.inner.root.join("effect-once.txt").exists() {
            Ok(ReviewReceipt {
                basis: candidate.basis,
                committed: true,
                settlement: Settlement::Settled,
                verdict: Verdict::Verified,
                evidence: vec![self.inner.root.join("effect-once.txt").display().to_string()],
            })
        } else {
            self.inner.verify(candidate, cancel).await
        }
    }
    async fn prepare_continuation(&self, value: Continuation, cancel: CancellationToken) -> Result<RunRequest> {
        self.inner.prepare_continuation(value, cancel).await
    }
    async fn reconcile_resume(&self, review: ResumeReview, _: CancellationToken) -> Result<ResumeReceipt> {
        ensure!(!self.reject_resume, "Host reconciliation deliberately unavailable");
        ensure!(
            fs::read(self.inner.root.join("effect-once.txt"))? == b"one committed effect",
            "original external receipt missing"
        );
        Ok(ResumeReceipt {
            committed: true,
            settlement: Settlement::Settled,
            tool_calls: review
                .interrupted_run
                .iter()
                .flat_map(|run| run.open_tool_calls.iter())
                .map(|call| ToolCallReconciliation {
                    call_id: call.id.clone(),
                    settlement: ToolCallSettlement::Completed {
                        output: "Host checked the original committed effect".into(),
                    },
                })
                .collect(),
            evidence: vec![self.inner.root.join("effect-once.txt").display().to_string()],
        })
    }
}

#[test]
fn orchestration_child() {
    let Some(root) = std::env::var_os("MORROW_QUEUE_CHILD_ROOT") else { return };
    let root = PathBuf::from(root);
    let mode = std::env::var("MORROW_QUEUE_CHILD_MODE").unwrap();
    let store = Store::open(root.join("queue")).unwrap();
    if mode == "stage" {
        fs::write(root.join("queue/state-staged-crashed.json"), b"uncommitted partial data").unwrap();
        std::process::exit(86)
    }
    if mode == "hold-claim" {
        let _claim = claim(&store);
        fs::write(root.join("claim-held"), b"held").unwrap();
        for _ in 0..500 {
            if root.join("release-claim").exists() {
                std::process::exit(86)
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("parent did not release child claim")
    }
    let provider = Provider::new(vec![]);
    let endpoint = std::env::var("MORROW_QUEUE_ENDPOINT").unwrap();
    let host = Arc::new(QueueHost::new(&root, &provider, &endpoint, mode == "unknown-effect"));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    if mode == "before-continue" {
        let intent: DispatchIntent =
            serde_json::from_slice(&fs::read(root.join("queued-continuation.json")).unwrap()).unwrap();
        let _handle = runtime.block_on(async {
            store
                .claim_reviewed("task", "child", now(), now() + 120_000)
                .unwrap()
                .dispatch(intent, host.request("run-2"), host, CONFIG)
                .unwrap()
        });
        std::process::exit(86)
    }
    if mode == "after-harness" {
        let _claim = store.claim_recovery("task", "child", now(), now() + 120_000).unwrap();
        let spec = store.snapshot().unwrap().assignments["task"].specification.task.clone();
        let outcome = runtime.block_on(async {
            start_with_options(spec, host.request("run-1"), host, TaskOptions::default()).unwrap().wait().await
        });
        assert_eq!(outcome.fence_presence, FencePresence::Released);
        std::process::exit(86)
    }
    let handle = runtime.block_on(async {
        claim(&store).dispatch(intent("task", &root), host.request("run-1"), host, CONFIG).unwrap()
    });
    if mode == "before-harness" {
        std::process::exit(86)
    }
    runtime.block_on(async {
        let _ = handle.wait().await;
    });
    panic!("unknown-effect child should exit inside actual tool")
}

#[test]
fn queue_reopens_idempotently_retains_unpublished_stages_and_cursors() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    let original = enqueue(&store, &root, "task");
    let s = store.snapshot().unwrap();
    let spec = original.specification.clone();
    let repeated = store
        .enqueue(s.triggers[&spec.trigger_id].clone(), s.mandates[&spec.mandate_id].clone(), spec.clone(), now())
        .unwrap();
    assert_eq!(repeated.queued_sequence, original.queued_sequence);
    let replayed_after_deadline = store
        .enqueue(
            s.triggers[&spec.trigger_id].clone(),
            s.mandates[&spec.mandate_id].clone(),
            spec.clone(),
            spec.task.deadline_unix_ms + 1,
        )
        .unwrap();
    assert_eq!(replayed_after_deadline.queued_sequence, original.queued_sequence);
    let mut expired_new = spec.clone();
    expired_new.id = "expired-new".into();
    assert!(store
        .enqueue(
            s.triggers[&spec.trigger_id].clone(),
            s.mandates[&spec.mandate_id].clone(),
            expired_new,
            spec.task.deadline_unix_ms + 1
        )
        .is_err());
    let mut changed = spec;
    changed.task.max_calls += 1;
    assert!(store
        .enqueue(s.triggers[&changed.trigger_id].clone(), s.mandates[&changed.mandate_id].clone(), changed, now())
        .is_err());
    child(&root, "stage", "");
    let reopened = Store::open(root.join("queue")).unwrap();
    assert_eq!(reopened.snapshot().unwrap().assignments.len(), 1);
    assert!(root.join("queue/state-staged-crashed.json").exists());
    assert_eq!(reopened.events_after(0).unwrap().len(), 1);
    assert!(reopened.events_after(1).unwrap().is_empty());
    store.cancel("task", now()).unwrap();
    assert_eq!(reopened.snapshot().unwrap().assignments["task"].phase, Phase::Settled);
    assert!(store.claim_next("worker", now(), now() + 1000).unwrap().is_none());
}

#[test]
fn expired_lease_does_not_steal_a_live_worker_or_repeat_unstarted_work() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "orchestration_child", "--nocapture"])
        .env("MORROW_QUEUE_CHILD_ROOT", &root)
        .env("MORROW_QUEUE_CHILD_MODE", "hold-claim")
        .spawn()
        .unwrap();
    for _ in 0..500 {
        if root.join("claim-held").exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(root.join("claim-held").exists());
    assert!(store.claim_next("competitor", now(), now() + 1000).unwrap().is_none());
    assert_eq!(store.watchdog(now() + 240_000).unwrap(), vec!["task"]);
    assert!(store.claim_recovery("task", "recovery", now(), now() + 1000).is_err());
    fs::write(root.join("release-claim"), b"release").unwrap();
    assert_eq!(child.wait().unwrap().code(), Some(86));
    store.claim_recovery("task", "recovery", now(), now() + 1000).unwrap().release_unstarted(now()).unwrap();
    assert_eq!(store.snapshot().unwrap().assignments["task"].phase, Phase::Settled);
}

#[tokio::test]
async fn real_dispatch_joins_harness_and_keeps_supervision_after_observer_drop() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let provider =
        Provider::new(vec![call("write-1", "write_answer", json!({"content":"correct"})), text("Submitted.")]);
    let host = Arc::new(QueueHost::new(&root, &provider, &provider.endpoint, false));
    let handle = claim(&store).dispatch(intent("task", &root), host.request("run-1"), host, CONFIG).unwrap();
    drop(handle);
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if store.snapshot().unwrap().assignments["task"].phase == Phase::Settled {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await
        }
    })
    .await
    .unwrap();
    let record = &store.snapshot().unwrap().assignments["task"];
    assert!(!record.attempts[0].runs.is_empty());
    assert_eq!(record.attempts[0].runs[0].run_id, "run-1");
    assert_eq!(fs::read(root.join("answer.txt")).unwrap(), b"correct");
    assert_eq!(record.attempts[0].outcome.as_ref().unwrap().stop, TaskStop::AwaitingHostAcceptance);
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
    let data = fs::read_to_string(root.join("queue/state.json")).unwrap();
    assert!(!data.contains("harness-fixture-key"));
    assert!(!data.contains("Submitted."));
}

#[tokio::test]
async fn persisted_intent_before_admission_needs_host_proof_and_retries_exact_identity() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    child(&root, "before-harness", "");
    assert!(!root.join("task").exists());
    assert_eq!(store.snapshot().unwrap().assignments["task"].phase, Phase::Dispatching);
    let owner = store.claim_recovery("task", "recovery", now(), now() + 120_000).unwrap();
    assert!(owner.harvest_released().is_err());
    let owner = store.claim_recovery("task", "recovery", now(), now() + 120_000).unwrap();
    let original = store.snapshot().unwrap().assignments["task"].clone();
    let proof = proof(&root, &original, RecoveryDecision::NeverAdmitted);
    let provider =
        Provider::new(vec![call("write-1", "write_answer", json!({"content":"correct"})), text("Submitted.")]);
    let host = Arc::new(QueueHost::new(&root, &provider, &provider.endpoint, false));
    let report = owner.retry_unadmitted(host.request("run-1"), host, CONFIG, proof).unwrap().wait().await;
    assert!(report.error.is_none(), "{report:?}");
    let state = store.snapshot().unwrap();
    assert_eq!(state.assignments["task"].attempts.len(), 1);
    assert_eq!(state.assignments["task"].attempts[0].intent.run_id, "run-1");
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}

#[test]
fn released_result_is_harvested_after_process_loss_without_dispatch() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let provider =
        Provider::new(vec![call("write-1", "write_answer", json!({"content":"correct"})), text("Submitted.")]);
    child(&root, "before-harness", &provider.endpoint);
    child(&root, "after-harness", &provider.endpoint);
    let old = fs::read(root.join("task/released.json")).unwrap();
    let report = store.claim_recovery("task", "harvester", now(), now() + 1000).unwrap().harvest_released().unwrap();
    assert_eq!(report.stop, TaskStop::AwaitingHostAcceptance);
    assert_eq!(store.snapshot().unwrap().assignments["task"].phase, Phase::Settled);
    assert_eq!(fs::read(root.join("task/released.json")).unwrap(), old);
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn actual_process_unknown_effect_requires_checked_resume_and_is_not_replayed() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let provider = Provider::new(vec![call("effect-1", "effect_once", json!({})), text("Confirmed existing effect.")]);
    child(&root, "unknown-effect", &provider.endpoint);
    assert_eq!(fs::read(root.join("effect-once.txt")).unwrap(), b"one committed effect");
    let owner = store.claim_recovery("task", "recovery", now(), now() + 120_000).unwrap();
    assert!(owner.harvest_released().is_err());
    let owner = store.claim_recovery("task", "recovery", now(), now() + 120_000).unwrap();
    let bad = proof(&root, &store.snapshot().unwrap().assignments["task"], RecoveryDecision::NeverAdmitted);
    let host = Arc::new(QueueHost::new(&root, &provider, &provider.endpoint, false));
    assert!(owner.retry_unadmitted(host.request("run-1"), host.clone(), CONFIG, bad).is_err());
    let owner = store.claim_recovery("task", "recovery", now(), now() + 120_000).unwrap();
    let proof =
        proof(&root, &store.snapshot().unwrap().assignments["task"], RecoveryDecision::ContinueAfterReconciliation);
    owner.authorize_recovery(proof).unwrap();
    let fence = fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.to_string_lossy().ends_with(".fence.json"))
        .unwrap();
    let mode = DispatchMode::Resume {
        expected_fence_sha256: core::artifact_provenance::sha256_hex(&fs::read(fence).unwrap()),
    };
    let report = owner
        .dispatch(
            DispatchIntent {
                attempt_id: "attempt-2".into(),
                run_id: "run-2".into(),
                evidence_dir: root.join("resumed"),
                mode,
            },
            host.request("run-2"),
            host,
            CONFIG,
        )
        .unwrap()
        .wait()
        .await;
    assert!(report.error.is_none(), "{report:?}");
    assert_eq!(report.outcome.as_ref().unwrap().stop, TaskStop::AwaitingHostAcceptance);
    assert_eq!(report.outcome.as_ref().unwrap().runs, 2);
    assert_eq!(report.outcome.as_ref().unwrap().observed_calls, 5);
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
    assert_eq!(store.snapshot().unwrap().assignments["task"].attempts.len(), 2);
    assert_eq!(fs::read(root.join("effect-once.txt")).unwrap(), b"one committed effect");
}

#[tokio::test]
async fn prepared_continuation_retries_the_exact_persisted_intent_after_process_restart() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    let assignment = enqueue(&store, &root, "task");
    let provider = Provider::new(vec![
        call("write-1", "write_answer", json!({"content":"correct"})),
        text("First submitted."),
        call("write-2", "write_answer", json!({"content":"correct"})),
        text("Revised submission."),
    ]);
    let host = Arc::new(QueueHost::new(&root, &provider, &provider.endpoint, false));
    let first = claim(&store)
        .dispatch(intent("task", &root), host.request("run-1"), host.clone(), CONFIG)
        .unwrap()
        .wait()
        .await;
    let first_bytes = fs::read(root.join("task/released.json")).unwrap();
    let mut receipt = first.outcome.as_ref().unwrap().last_receipt.clone().unwrap();
    let feedback = "Host requests the prepared successor.";
    receipt.verdict = Verdict::NeedsChanges { feedback: feedback.into() };
    let review_path = root.join("prepared-review.json");
    receipt.evidence.push(review_path.display().to_string());
    fs::write(review_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    let target = root.join("prepared");
    let source = ReviewedContinuation {
        previous_evidence_dir: root.join("task"),
        expected_released_sha256: core::artifact_provenance::sha256_hex(&first_bytes),
        review: Some(receipt.clone()),
    };
    let intent = DispatchIntent {
        attempt_id: "attempt-2".into(),
        run_id: "run-2".into(),
        evidence_dir: target.clone(),
        mode: DispatchMode::Continue { source: Box::new(source.clone()) },
    };
    fs::write(root.join("queued-continuation.json"), serde_json::to_vec(&intent).unwrap()).unwrap();
    child(&root, "before-continue", &provider.endpoint);
    assert_eq!(store.snapshot().unwrap().assignments["task"].phase, Phase::Dispatching);
    let mut specification = assignment.specification.task.clone();
    specification.evidence_dir = target.clone();
    let authority: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("task/authority-record.json")).unwrap()).unwrap();
    let objective = format!("{}\n\nHost review feedback\n{}", host.request("run-2").objective, feedback);
    let record = json!({"version":1,"kind":"reviewed_task_continuation","previous_evidence_dir":root.join("task"),
        "released_sha256":source.expected_released_sha256,"spec":specification,"run_id":"run-2",
        "objective_sha256":core::artifact_provenance::sha256_hex(objective.as_bytes()),"consumed_runs":1,"consumed_calls":2,
        "receipt":receipt,"authority":authority,"options":TaskOptions::default()});
    // Controlled durable-state fixture for the precise native window after
    // successor claim publication and before Session fence publication.
    fs::create_dir(&target).unwrap();
    for (name, value) in [
        ("task.json", json!(specification)),
        ("task-options.json", json!(TaskOptions::default())),
        ("authority-record.json", authority),
        ("continuation.json", record.clone()),
    ] {
        let path = target.join(name);
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        fs::OpenOptions::new().write(true).open(path).unwrap().sync_all().unwrap();
    }
    fs::copy(authorization_snapshot_path(&root.join("task")), authorization_snapshot_path(&target)).unwrap();
    let claim_path = root.join("task/continuation-claim.json");
    let claim_bytes = serde_json::to_vec(&record).unwrap();
    fs::write(&claim_path, &claim_bytes).unwrap();
    fs::OpenOptions::new().write(true).open(&claim_path).unwrap().sync_all().unwrap();
    let reopened = Store::open(root.join("queue")).unwrap();
    let owner = reopened.claim_recovery("task", "competing", now(), now() + 120_000).unwrap();
    let error = owner
        .dispatch(
            DispatchIntent {
                attempt_id: "wrong-attempt-3".into(),
                run_id: "wrong-run-3".into(),
                evidence_dir: root.join("competing"),
                mode: DispatchMode::Continue { source: Box::new(source.clone()) },
            },
            host.request("wrong-run-3"),
            host.clone(),
            CONFIG,
        )
        .err()
        .unwrap();
    assert!(error.to_string().contains("prepared continuation"));
    assert_eq!(reopened.snapshot().unwrap().assignments["task"].attempts.len(), 2);
    assert!(!root.join("competing").exists());
    assert!(reopened
        .claim_recovery("task", "harvester", now(), now() + 120_000)
        .unwrap()
        .harvest_released()
        .unwrap_err()
        .to_string()
        .contains("prepared continuation"));
    let reference = proof(&root, &reopened.snapshot().unwrap().assignments["task"], RecoveryDecision::NeverAdmitted);
    let report = reopened
        .claim_recovery("task", "recovery", now(), now() + 120_000)
        .unwrap()
        .retry_unadmitted(host.request("run-2"), host, CONFIG, reference)
        .unwrap()
        .wait()
        .await;
    assert!(report.error.is_none(), "{report:?}");
    let outcome = report.outcome.as_ref().unwrap();
    assert_eq!((outcome.runs, outcome.observed_calls), (2, 4));
    assert!(!outcome.task_accepted);
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(snapshot.assignments["task"].attempts.len(), 2);
    assert_eq!(snapshot.assignments["task"].phase, Phase::Settled);
    assert_eq!(fs::read(claim_path).unwrap(), claim_bytes);
    assert_eq!(provider.requests.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn repeated_failed_resume_admissions_keep_the_original_fence_source_recoverable() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let provider = Provider::new(vec![call("effect-1", "effect_once", json!({})), text("Confirmed original effect.")]);
    child(&root, "unknown-effect", &provider.endpoint);
    let fence = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.to_string_lossy().ends_with(".fence.json"))
        .unwrap();
    for index in 2..=3 {
        let mut host = QueueHost::new(&root, &provider, &provider.endpoint, false);
        host.reject_resume = true;
        let host = Arc::new(host);
        let owner = store.claim_recovery("task", "recovery", now(), now() + 120_000).unwrap();
        let report = owner
            .dispatch(
                DispatchIntent {
                    attempt_id: format!("attempt-{index}"),
                    run_id: format!("run-{index}"),
                    evidence_dir: root.join(format!("failed-{index}")),
                    mode: DispatchMode::Resume {
                        expected_fence_sha256: core::artifact_provenance::sha256_hex(&fs::read(&fence).unwrap()),
                    },
                },
                host.request(&format!("run-{index}")),
                host,
                CONFIG,
            )
            .unwrap()
            .wait()
            .await;
        assert!(
            report.error.as_deref().unwrap().contains("Host reconciliation deliberately unavailable"),
            "{report:?}"
        );
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
        assert_eq!(store.snapshot().unwrap().assignments["task"].phase, Phase::RecoveryRequired);
    }
    let owner = store.claim_recovery("task", "recovery", now(), now() + 120_000).unwrap();
    let host = Arc::new(QueueHost::new(&root, &provider, &provider.endpoint, false));
    let report = owner
        .dispatch(
            DispatchIntent {
                attempt_id: "attempt-4".into(),
                run_id: "run-4".into(),
                evidence_dir: root.join("resumed"),
                mode: DispatchMode::Resume {
                    expected_fence_sha256: core::artifact_provenance::sha256_hex(&fs::read(&fence).unwrap()),
                },
            },
            host.request("run-4"),
            host,
            CONFIG,
        )
        .unwrap()
        .wait()
        .await;
    assert!(report.error.is_none(), "{report:?}");
    assert_eq!(report.outcome.as_ref().unwrap().stop, TaskStop::AwaitingHostAcceptance);
    assert_eq!(report.outcome.as_ref().unwrap().runs, 2);
    assert_eq!(store.snapshot().unwrap().assignments["task"].attempts.len(), 4);
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
    assert_eq!(fs::read(root.join("effect-once.txt")).unwrap(), b"one committed effect");
}

#[tokio::test]
async fn cancelling_before_resume_admission_keeps_original_unknown_effects_in_recovery() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let provider = Provider::new(vec![call("effect-1", "effect_once", json!({}))]);
    child(&root, "unknown-effect", &provider.endpoint);
    let owner = store.claim_recovery("task", "recovery", now(), now() + 120_000).unwrap();
    let reference =
        proof(&root, &store.snapshot().unwrap().assignments["task"], RecoveryDecision::ContinueAfterReconciliation);
    owner.authorize_recovery(reference).unwrap();
    let fence = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.to_string_lossy().ends_with(".fence.json"))
        .unwrap();
    let original_fence = fs::read(&fence).unwrap();
    let host = Arc::new(QueueHost::new(&root, &provider, &provider.endpoint, false));
    let handle = owner
        .dispatch(
            DispatchIntent {
                attempt_id: "attempt-2".into(),
                run_id: "run-2".into(),
                evidence_dir: root.join("not-admitted"),
                mode: DispatchMode::Resume {
                    expected_fence_sha256: core::artifact_provenance::sha256_hex(&original_fence),
                },
            },
            host.request("run-2"),
            host,
            CONFIG,
        )
        .unwrap();
    // This current-thread test has not yielded to the detached supervisor yet.
    handle.cancel().unwrap();
    let report = handle.wait().await;
    assert!(report.error.as_deref().unwrap().contains("cancelled before Harness admission"));
    assert_eq!(store.snapshot().unwrap().assignments["task"].phase, Phase::RecoveryRequired);
    assert_eq!(fs::read(&fence).unwrap(), original_fence);
    assert!(!root.join("not-admitted").exists());
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn reviewed_continuation_keeps_original_task_session_and_cumulative_budgets() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let provider = Provider::new(vec![
        call("write-1", "write_answer", json!({"content":"correct"})),
        text("First submitted."),
        call("write-2", "write_answer", json!({"content":"correct"})),
        text("Revised submission."),
    ]);
    let host = Arc::new(QueueHost::new(&root, &provider, &provider.endpoint, false));
    let first = claim(&store)
        .dispatch(intent("task", &root), host.request("run-1"), host.clone(), CONFIG)
        .unwrap()
        .wait()
        .await;
    assert!(first.error.is_none(), "{first:?}");
    let first_bytes = fs::read(root.join("task/released.json")).unwrap();
    let mut review = first.outcome.as_ref().unwrap().last_receipt.clone().unwrap();
    review.verdict = Verdict::NeedsChanges { feedback: "Host requests one revised submission.".into() };
    let path = root.join("host-review.json");
    review.evidence.push(path.display().to_string());
    fs::write(&path, serde_json::to_vec(&review).unwrap()).unwrap();
    for index in 2..=3 {
        let owner = if index == 2 {
            store.claim_reviewed("task", "reviewed-worker", now(), now() + 120_000).unwrap()
        } else {
            store.claim_recovery("task", "recovery-worker", now(), now() + 120_000).unwrap()
        };
        let report = owner
            .dispatch(
                DispatchIntent {
                    attempt_id: format!("failed-attempt-{index}"),
                    run_id: format!("failed-run-{index}"),
                    evidence_dir: root.join(format!("failed-continue-{index}")),
                    mode: DispatchMode::Continue {
                        source: Box::new(ReviewedContinuation {
                            previous_evidence_dir: root.join("task"),
                            expected_released_sha256: "0".repeat(64),
                            review: Some(review.clone()),
                        }),
                    },
                },
                host.request(&format!("failed-run-{index}")),
                host.clone(),
                CONFIG,
            )
            .unwrap()
            .wait()
            .await;
        assert!(report.error.is_some());
        assert_eq!(provider.requests.lock().unwrap().len(), 2);
    }
    let harvested =
        store.claim_recovery("task", "harvester", now(), now() + 120_000).unwrap().harvest_released().unwrap();
    assert_eq!(harvested.stop, TaskStop::AwaitingHostAcceptance);
    let owner = Store::open(root.join("queue"))
        .unwrap()
        .claim_reviewed("task", "reviewed-worker", now(), now() + 120_000)
        .unwrap();
    let report = owner
        .dispatch(
            DispatchIntent {
                attempt_id: "attempt-4".into(),
                run_id: "run-2".into(),
                evidence_dir: root.join("second"),
                mode: DispatchMode::Continue {
                    source: Box::new(ReviewedContinuation {
                        previous_evidence_dir: root.join("task"),
                        expected_released_sha256: core::artifact_provenance::sha256_hex(&first_bytes),
                        review: Some(review),
                    }),
                },
            },
            host.request("run-2"),
            host,
            CONFIG,
        )
        .unwrap()
        .wait()
        .await;
    assert!(report.error.is_none(), "{report:?}");
    let outcome = report.outcome.as_ref().unwrap();
    assert_eq!(outcome.task_id, "task");
    assert_eq!((outcome.runs, outcome.observed_calls), (2, 4));
    assert!(!outcome.task_accepted);
    assert_eq!(outcome.stop, TaskStop::AwaitingHostAcceptance);
    let snapshot = store.snapshot().unwrap();
    let assignment = &snapshot.assignments["task"];
    assert_eq!(assignment.specification.session_id, "test/session");
    assert_eq!(assignment.attempts.len(), 4);
    assert_eq!(assignment.attempts[3].runs[0].run_id, "run-2");
    assert_eq!(assignment.attempts[3].runs[0].run_number, 2);
    assert_eq!(fs::read(root.join("task/released.json")).unwrap(), first_bytes);
    assert_eq!(provider.requests.lock().unwrap().len(), 4);
}

#[tokio::test]
#[ignore = "requires MORROW_ORCHESTRATION_JOB_WORKER pointing to a compatible managed-job worker executable"]
async fn native_job_reference_requires_actual_run_invocation_and_survives_reopen() {
    let (_directory, root) = fixture();
    let provider = Provider::new(vec![
        call("bootstrap-write", "write_answer", json!({"content":"correct"})),
        text("Bootstrap complete."),
        call(
            "native-job",
            "job_start",
            json!({"op_id":"queue-native-job","language":"python","script":"from pathlib import Path; Path('job-effect.txt').write_text('one native job')","timeout":10}),
        ),
        text("Job submitted."),
    ]);
    let host = Arc::new(Host::new(&root, &provider, Fault::None));
    // Establish the genuine Session before deriving native Owner scope.
    let bootstrap = start(host.spec("bootstrap"), host.request("bootstrap"), host.clone()).unwrap().wait().await;
    assert_eq!(bootstrap.stop, TaskStop::AwaitingHostAcceptance);
    let state_path = root.join("session.json");
    let manager = Arc::new(
        core::managed_jobs::Manager::new(
            &state_path,
            &root,
            core::managed_jobs::Policy {
                worker_executable: Some(PathBuf::from(
                    std::env::var_os("MORROW_ORCHESTRATION_JOB_WORKER").expect("compatible worker required"),
                )),
                owner: core::managed_jobs::Owner::new(&state_path, "test-device", "test/session").unwrap(),
                goal_id: "task".into(),
                lease_expires_at: now() / 1000 + 60,
                max_jobs: 2,
                max_log_bytes: 32 * 1024,
                max_seconds: 15,
            },
        )
        .unwrap(),
    );
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let mut request = host.request("run-1");
    request.mode = core::RunMode::Goal;
    request.enable_local_tools = true;
    request.worker_executable = Some(PathBuf::from(std::env::var_os("MORROW_ORCHESTRATION_JOB_WORKER").unwrap()));
    request.goal_criteria = vec!["The authorized native Job writes job-effect.txt exactly once.".into()];
    request.goal_lease = Some(core::goal_runtime::Lease {
        goal_id: "run-1".into(),
        controller: "queue-test-host".into(),
        device: "test-device".into(),
        session: "test/session".into(),
        expires_at: now() / 1000 + 60,
        max_calls: 4,
        max_slices: 1,
        allow_jobs: true,
    });
    let report = claim(&store).dispatch(intent("task", &root), request, host, CONFIG).unwrap().wait().await;
    assert!(report.error.is_none(), "{report:?}");
    assert!(report.outcome.as_ref().unwrap().observed_calls > 0, "{report:?}");
    let receipts = manager.unfinished().unwrap();
    let job_id = if let Some(receipt) = receipts.first() {
        receipt.job_id.clone()
    } else {
        let owner = core::managed_jobs::Owner::new(&state_path, "test-device", "test/session").unwrap();
        let directory =
            root.join("managed-jobs").join(core::artifact_provenance::sha256_hex(&serde_json::to_vec(&owner).unwrap()));
        fs::read_dir(directory)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.is_dir())
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned()
    };
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let receipt = manager.status(&job_id).unwrap();
            if receipt.finished_at.is_some() {
                assert_eq!(receipt.state, "succeeded", "{receipt:?}");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(store.observe_job("task", "bootstrap", &job_id, "test-device", &manager).is_err());
    assert!(store.observe_job("task", "run-1", &job_id, "wrong-device", &manager).is_err());
    let observed = store.observe_job("task", "run-1", &job_id, "test-device", &manager).unwrap();
    assert_eq!(observed.invocation.tool_call_id, "native-job");
    assert_eq!(observed.invocation.run.run_id, "run-1");
    assert_eq!(observed.state, "succeeded");
    assert!(!observed.effects_unknown);
    assert_eq!(fs::read_to_string(root.join("job-effect.txt")).unwrap(), "one native job");
    let reopened = Store::open(root.join("queue")).unwrap().snapshot().unwrap();
    assert_eq!(reopened.assignments["task"].jobs[0].job_id, job_id);
    assert!(!fs::read_to_string(root.join("queue/state.json")).unwrap().contains("Path('job-effect.txt')"));
}

#[tokio::test]
async fn brief_store_contention_neither_cancels_nor_releases_the_native_worker() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let provider = Provider::new(vec![call("delayed-1", "delayed_cancel", json!({}))]);
    let tool = Arc::new(common::DelayedCancelTool::new(&root));
    let mut host = Host::new(&root, &provider, Fault::None);
    host.read_tool = Some(tool.clone());
    let host = Arc::new(host);
    let owner = store.claim_next("worker", now(), now() + 300).unwrap().unwrap();
    let handle = owner.dispatch(intent("task", &root), host.request("run-1"), host, CONFIG).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !tool.started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let lock = fs::OpenOptions::new().read(true).write(true).open(root.join("queue/store.lock")).unwrap();
    FileExt::try_lock_exclusive(&lock).unwrap();
    assert!(store.snapshot().unwrap_err().is::<StoreBusy>());
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(!tool.cancellation_seen.load(Ordering::SeqCst));
    assert!(!tool.joined.load(Ordering::SeqCst));
    drop(lock);
    handle.cancel().unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !tool.cancellation_seen.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tool.release_settlement();
    let report = handle.wait().await;
    assert!(report.error.is_none(), "{report:?}");
    assert!(tool.joined.load(Ordering::SeqCst));
    assert_eq!(tool.executions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn watchdog_requests_cancel_but_keeps_worker_until_native_callback_joins() {
    let (_directory, root) = fixture();
    let store = Store::open(root.join("queue")).unwrap();
    enqueue(&store, &root, "task");
    let provider = Provider::new(vec![call("delayed-1", "delayed_cancel", json!({}))]);
    let tool = Arc::new(common::DelayedCancelTool::new(&root));
    let mut host = Host::new(&root, &provider, Fault::None);
    host.read_tool = Some(tool.clone());
    let host = Arc::new(host);
    let handle = claim(&store).dispatch(intent("task", &root), host.request("run-1"), host, CONFIG).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !tool.started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await
        }
    })
    .await
    .unwrap();
    assert_eq!(store.watchdog(now() + 240_000).unwrap(), vec!["task"]);
    tokio::time::timeout(Duration::from_secs(10), async {
        while !tool.cancellation_seen.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await
        }
    })
    .await
    .unwrap();
    assert!(store.claim_recovery("task", "other", now(), now() + 1000).is_err());
    assert!(!tool.joined.load(Ordering::SeqCst));
    tool.release_settlement();
    let report = handle.wait().await;
    assert!(report.error.is_none(), "{report:?}");
    assert!(tool.joined.load(Ordering::SeqCst));
    assert_eq!(tool.executions.load(Ordering::SeqCst), 1);
    assert_eq!(store.snapshot().unwrap().assignments["task"].phase, Phase::RecoveryRequired);
}
