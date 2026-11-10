mod common;

use anyhow::Result;
use async_trait::async_trait;
use common::*;
use morrow_agent_harness::{
    core::{
        rpi_agent::{AgentError, AgentTool, AgentToolResult, ToolResultPartial},
        rpi_ai::{Schema, Tool},
        RunRequest,
    },
    *,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

const CHILD_INPUT: &str = "MORROW_REVIEWED_CONTINUATION_INPUT";

fn fixture() -> (Option<tempfile::TempDir>, std::path::PathBuf) {
    if let Some(parent) = std::env::var_os("MORROW_CONTINUATION_EVIDENCE") {
        std::fs::create_dir_all(&parent).unwrap();
        let root = tempfile::tempdir_in(parent).unwrap().keep().canonicalize().unwrap();
        eprintln!("reviewed continuation evidence {}", root.display());
        (None, root)
    } else {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        (Some(directory), root)
    }
}

struct CrashTool {
    root: std::path::PathBuf,
    schema: Tool,
}

impl CrashTool {
    fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            schema: Tool {
                name: "crash_once".into(),
                description: "Record one external effect then terminate this fixture process.".into(),
                parameters: Schema(json!({"type":"object","properties":{},"additionalProperties":false})),
                constrained_sampling: None,
            },
        }
    }
}

#[async_trait]
impl AgentTool for CrashTool {
    fn schema(&self) -> &Tool {
        &self.schema
    }
    fn label(&self) -> &str {
        "crash_once"
    }
    async fn execute(
        &self,
        _: &str,
        _: Value,
        _: CancellationToken,
        _: Arc<dyn Fn(ToolResultPartial) + Send + Sync>,
    ) -> Result<AgentToolResult, AgentError> {
        use std::io::Write;
        let mut receipt = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.root.join("external-effect.txt"))
            .map_err(|error| AgentError::Tool(error.to_string()))?;
        receipt.write_all(b"performed once").unwrap();
        receipt.sync_all().unwrap();
        std::process::exit(73);
    }
}

struct ReviewedHost {
    inner: Host,
}

#[async_trait]
impl HarnessHost for ReviewedHost {
    async fn verify(&self, candidate: Candidate, cancellation: CancellationToken) -> Result<ReviewReceipt> {
        self.inner.verify(candidate, cancellation).await
    }
    async fn prepare_continuation(
        &self,
        continuation: Continuation,
        cancellation: CancellationToken,
    ) -> Result<RunRequest> {
        self.inner.prepare_continuation(continuation, cancellation).await
    }
    async fn reconcile_resume(&self, review: ResumeReview, _: CancellationToken) -> Result<ResumeReceipt> {
        anyhow::ensure!(
            std::fs::read(self.inner.root.join("external-effect.txt"))? == b"performed once",
            "external effect receipt missing"
        );
        Ok(ResumeReceipt {
            committed: true,
            settlement: Settlement::Settled,
            tool_calls: review
                .interrupted_run
                .into_iter()
                .flat_map(|run| run.open_tool_calls)
                .map(|call| ToolCallReconciliation {
                    call_id: call.id,
                    settlement: ToolCallSettlement::Completed { output: "Host confirmed original effect once".into() },
                })
                .collect(),
            evidence: vec![self.inner.root.join("external-effect.txt").display().to_string()],
        })
    }
}

fn review(evidence: &Path) -> ReviewedContinuation {
    let bytes = std::fs::read(evidence.join("released.json")).unwrap();
    let outcome: TaskOutcome = serde_json::from_slice(&bytes).unwrap();
    let mut receipt = outcome.last_receipt.unwrap();
    receipt.verdict = Verdict::NeedsChanges {
        feedback: "Host requests another checked submission under the original criteria.".into(),
    };
    let receipt_path = evidence.parent().unwrap().join(format!("feedback-{}.json", receipt.basis.run_number));
    receipt.evidence.push(receipt_path.display().to_string());
    std::fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    std::fs::OpenOptions::new().write(true).open(&receipt_path).unwrap().sync_all().unwrap();
    ReviewedContinuation {
        previous_evidence_dir: evidence.into(),
        expected_released_sha256: format!("{:x}", Sha256::digest(&bytes)),
        review: Some(receipt),
    }
}

fn read_outcome(evidence: &Path) -> TaskOutcome {
    serde_json::from_slice(&std::fs::read(evidence.join("released.json")).unwrap()).unwrap()
}

fn child(
    root: &Path,
    provider: &Provider,
    spec: &TaskSpec,
    previous: &Path,
    id: &str,
    mode: &str,
) -> std::process::Output {
    let input = root.join(format!("child-{id}.json"));
    std::fs::write(
        &input,
        serde_json::to_vec(
            &json!({"root":root,"endpoint":provider.endpoint,"spec":spec,"previous":previous,"id":id,"mode":mode}),
        )
        .unwrap(),
    )
    .unwrap();
    std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "reviewed_continuation_child", "--nocapture"])
        .env(CHILD_INPUT, input)
        .output()
        .unwrap()
}

#[test]
fn reviewed_continuation_child() {
    let Some(input) = std::env::var_os(CHILD_INPUT) else { return };
    let input: Value = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    let root = Path::new(input["root"].as_str().unwrap());
    let provider = Provider::new(vec![]);
    let mut inner = Host::new(root, &provider, Fault::None);
    inner.endpoint = input["endpoint"].as_str().unwrap().into();
    inner.read_tool = Some(Arc::new(CrashTool::new(root)));
    let host = Arc::new(ReviewedHost { inner });
    let spec: TaskSpec = serde_json::from_value(input["spec"].clone()).unwrap();
    let request = host.inner.request(input["id"].as_str().unwrap());
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let handle = if input["mode"] == "resume" {
            resume(spec, request, host, TaskOptions::default()).await.unwrap()
        } else {
            continue_reviewed(
                spec,
                request,
                host,
                TaskOptions::default(),
                review(Path::new(input["previous"].as_str().unwrap())),
            )
            .unwrap()
        };
        let outcome = handle.wait().await;
        assert_eq!(outcome.stop, TaskStop::AwaitingHostAcceptance, "{outcome:?}");
        assert!(!outcome.task_accepted);
    });
}

#[tokio::test]
async fn multiple_fresh_process_continuations_keep_task_session_and_budget() {
    let (_directory, root) = fixture();
    let provider = Provider::new(vec![
        write_answer("correct"),
        text("submitted"),
        call("write-second", "write_answer", json!({"content":"correct"})),
        text("submitted"),
        call("write-third", "write_answer", json!({"content":"correct"})),
        text("submitted"),
    ]);
    let mut inner = Host::new(&root, &provider, Fault::None);
    inner.read_tool = Some(Arc::new(CrashTool::new(&root)));
    let host = Arc::new(ReviewedHost { inner });
    let original = host.inner.spec("original");
    let first = start(original.clone(), host.inner.request("first"), host.clone()).unwrap().wait().await;
    assert_eq!(first.stop, TaskStop::AwaitingHostAcceptance);
    let source_bytes = std::fs::read(original.evidence_dir.join("released.json")).unwrap();
    let mut spec = original.clone();
    spec.evidence_dir = root.join("second");
    let output = child(&root, &provider, &spec, &original.evidence_dir, "second", "continue");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let second = read_outcome(&spec.evidence_dir);
    assert_eq!((second.runs, second.observed_calls), (2, 4));
    let previous = spec.evidence_dir.clone();
    spec.evidence_dir = root.join("third");
    let output = child(&root, &provider, &spec, &previous, "third", "continue");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let third = read_outcome(&spec.evidence_dir);
    assert_eq!((third.runs, third.observed_calls), (3, 6));
    assert_eq!(third.task_id, original.task_id);
    assert_eq!(third.last_receipt.unwrap().basis.session_id, first.last_receipt.as_ref().unwrap().basis.session_id);
    assert_eq!(source_bytes, std::fs::read(original.evidence_dir.join("released.json")).unwrap());
    let previous = spec.evidence_dir.clone();
    spec.evidence_dir = root.join("exhausted");
    let error = continue_reviewed(spec, host.inner.request("fourth"), host, TaskOptions::default(), review(&previous))
        .err()
        .unwrap();
    assert!(error.to_string().contains("budget exhausted"), "{error:#}");
    assert!(!root.join("exhausted").exists());
    assert_eq!(provider.requests.lock().unwrap().len(), 6);
}

#[tokio::test]
async fn crash_during_reviewed_continuation_resumes_cumulative_budget_without_replay() {
    let (_directory, root) = fixture();
    let provider = Provider::new(vec![
        write_answer("correct"),
        text("submitted"),
        call("external-1", "crash_once", json!({})),
        call("write-resumed", "write_answer", json!({"content":"correct"})),
        text("submitted"),
    ]);
    let mut inner = Host::new(&root, &provider, Fault::None);
    inner.read_tool = Some(Arc::new(CrashTool::new(&root)));
    let host = Arc::new(ReviewedHost { inner });
    let mut original = host.inner.spec("original");
    original.max_runs = 5;
    original.max_calls = 16;
    start(original.clone(), host.inner.request("first"), host.clone()).unwrap().wait().await;
    let mut spec = original.clone();
    spec.evidence_dir = root.join("crashed");
    let output = child(&root, &provider, &spec, &original.evidence_dir, "crashed", "continue");
    assert_eq!(output.status.code(), Some(73), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(spec.evidence_dir.join("run-2-admission.json").is_file());
    assert!(!spec.evidence_dir.join("released.json").exists());
    spec.evidence_dir = root.join("resumed");
    let output = child(&root, &provider, &spec, &root.join("crashed"), "resumed", "resume");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let outcome = read_outcome(&spec.evidence_dir);
    assert_eq!((outcome.runs, outcome.observed_calls), (3, 8));
    assert_eq!(std::fs::read(root.join("external-effect.txt")).unwrap(), b"performed once");
    assert_eq!(provider.requests.lock().unwrap().len(), 5);
    let previous = spec.evidence_dir.clone();
    spec.evidence_dir = root.join("after-resume");
    // The next process retains the same Task after both a continuation and a fenced recovery.
    let output = child(&root, &provider, &spec, &previous, "after-resume", "continue");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(read_outcome(&spec.evidence_dir).runs, 4);
}

#[tokio::test]
async fn continuation_rejects_changed_authority_missing_caps_and_uncommitted_review() {
    let (_directory, root) = fixture();
    let provider = Provider::new(vec![write_answer("correct"), text("submitted")]);
    let host = Arc::new(Host::new(&root, &provider, Fault::None));
    let original = host.spec("original");
    start(original.clone(), host.request("first"), host.clone()).unwrap().wait().await;
    let mut spec = original.clone();
    spec.evidence_dir = root.join("next");
    let mut request = host.request("next");
    request.max_calls += 1;
    let error =
        continue_reviewed(spec.clone(), request, host.clone(), TaskOptions::default(), review(&original.evidence_dir))
            .err()
            .unwrap();
    assert!(error.to_string().contains("caps exceed"), "{error:#}");
    let mut request = host.request("next");
    request.token = "changed".into();
    let error =
        continue_reviewed(spec.clone(), request, host.clone(), TaskOptions::default(), review(&original.evidence_dir))
            .err()
            .unwrap();
    assert!(error.to_string().contains("Host authority"), "{error:#}");
    let mut correction = review(&original.evidence_dir);
    correction.review.as_mut().unwrap().committed = false;
    let error = continue_reviewed(spec.clone(), host.request("next"), host.clone(), TaskOptions::default(), correction)
        .err()
        .unwrap();
    assert!(error.to_string().contains("committed"), "{error:#}");
    let mut enlarged = spec.clone();
    enlarged.max_calls += 1;
    let error = continue_reviewed(
        enlarged,
        host.request("next"),
        host.clone(),
        TaskOptions::default(),
        review(&original.evidence_dir),
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("Task terms or budgets"), "{error:#}");
    let mut correction = review(&original.evidence_dir);
    correction.review = None;
    let error = continue_reviewed(spec.clone(), host.request("next"), host.clone(), TaskOptions::default(), correction)
        .err()
        .unwrap();
    assert!(error.to_string().contains("NeedsChanges feedback"), "{error:#}");
    let mut correction = review(&original.evidence_dir);
    correction.review.as_mut().unwrap().basis.run_id = "different".into();
    let error = continue_reviewed(spec.clone(), host.request("next"), host.clone(), TaskOptions::default(), correction)
        .err()
        .unwrap();
    assert!(error.to_string().contains("bound to original evidence"), "{error:#}");
    std::fs::remove_file(original.evidence_dir.join("authority-record.json")).unwrap();
    let error =
        continue_reviewed(spec, host.request("next"), host, TaskOptions::default(), review(&original.evidence_dir))
            .err()
            .unwrap();
    assert!(error.to_string().contains("legacy evidence"), "{error:#}");
    assert!(!root.join("next").exists());
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn needs_changes_can_receive_committed_host_feedback_after_release() {
    let (_directory, root) = fixture();
    let provider =
        Provider::new(vec![write_answer("wrong"), text("submitted"), write_answer("correct"), text("submitted")]);
    let host = Arc::new(Host::new(&root, &provider, Fault::EmptyFeedback));
    let original = host.spec("original");
    let outcome = start(original.clone(), host.request("first"), host.clone()).unwrap().wait().await;
    assert_eq!(outcome.stop, TaskStop::NeedsChanges);
    let mut spec = original.clone();
    spec.evidence_dir = root.join("continued");
    let outcome = continue_reviewed(
        spec,
        host.request("continued"),
        host,
        TaskOptions::default(),
        review(&original.evidence_dir),
    )
    .unwrap()
    .wait()
    .await;
    assert_eq!(outcome.stop, TaskStop::AwaitingHostAcceptance);
    assert_eq!((outcome.runs, outcome.observed_calls), (2, 4));
    assert!(provider.requests.lock().unwrap()[2].to_string().contains("Host requests another checked submission"));
}

#[tokio::test]
async fn durable_claim_recovers_only_its_prepared_successor_before_fence_publication() {
    let (_directory, root) = fixture();
    let provider = Provider::new(vec![
        write_answer("correct"),
        text("submitted"),
        call("write-successor", "write_answer", json!({"content":"correct"})),
        text("submitted"),
    ]);
    let host = Arc::new(Host::new(&root, &provider, Fault::None));
    let original = host.spec("original");
    start(original.clone(), host.request("first"), host.clone()).unwrap().wait().await;
    let mut spec = original.clone();
    spec.evidence_dir = root.join("prepared");
    let correction = review(&original.evidence_dir);
    let receipt = correction.review.as_ref().unwrap();
    let Verdict::NeedsChanges { feedback } = &receipt.verdict else { panic!("fixture feedback missing") };
    let request = host.request("successor");
    let objective = format!("{}\n\nHost review feedback\n{}", request.objective, feedback);
    let authority: Value =
        serde_json::from_slice(&std::fs::read(original.evidence_dir.join("authority-record.json")).unwrap()).unwrap();
    let options = TaskOptions::default();
    let record = json!({
        "version":1,"kind":"reviewed_task_continuation","previous_evidence_dir":original.evidence_dir,
        "released_sha256":correction.expected_released_sha256,"spec":spec,
        "run_id":"successor","objective_sha256":format!("{:x}", Sha256::digest(objective.as_bytes())),
        "consumed_runs":1,"consumed_calls":2,"receipt":receipt,"authority":authority,"options":options,
    });
    // Reconstruct the precise durable state after claim publication and before
    // fence publication. No Run or external operation was admitted in this window.
    std::fs::create_dir(&spec.evidence_dir).unwrap();
    for (name, value) in [
        ("task.json", json!(spec)),
        ("task-options.json", json!(options)),
        ("authority-record.json", authority),
        ("continuation.json", record.clone()),
    ] {
        std::fs::write(spec.evidence_dir.join(name), serde_json::to_vec(&value).unwrap()).unwrap();
    }
    std::fs::copy(authorization_snapshot_path(&original.evidence_dir), authorization_snapshot_path(&spec.evidence_dir))
        .unwrap();
    std::fs::write(original.evidence_dir.join("continuation-claim.json"), serde_json::to_vec(&record).unwrap())
        .unwrap();
    let mut competing = spec.clone();
    competing.evidence_dir = root.join("competing");
    let error =
        continue_reviewed(competing, host.request("other"), host.clone(), options, correction.clone()).err().unwrap();
    assert!(error.to_string().contains("already claimed"), "{error:#}");
    assert!(!root.join("competing").exists());
    let outcome =
        continue_reviewed(spec.clone(), request, host.clone(), options, correction.clone()).unwrap().wait().await;
    assert_eq!(outcome.stop, TaskStop::AwaitingHostAcceptance);
    assert_eq!((outcome.runs, outcome.observed_calls), (2, 4));
    let error = continue_reviewed(spec, host.request("successor"), host, options, correction).err().unwrap();
    assert!(error.to_string().contains("journal head changed"), "{error:#}");
    assert_eq!(provider.requests.lock().unwrap().len(), 4);
}
