mod common;

use anyhow::{bail, Result};
use async_trait::async_trait;
use common::{text, write_answer, Fault, Host, Provider};
use morrow_agent_harness::core::artifact_provenance::{sha256_hex, ArtifactStatus, HostArtifactReceipt, ToolArtifact};
use morrow_agent_harness::core::RunRequest;
use morrow_agent_harness::*;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArtifactMode {
    Verified,
    Candidate,
    Missing,
    UnknownArtifact,
    UnknownReview,
    Uncommitted,
    UnknownSettlement,
    CancelCallback,
    DeadlineCallback,
    TamperEvents,
    TamperJournal,
    FailSecondCallback,
    ManifestCollision,
    IndexCollision,
}

struct ArtifactHost {
    inner: Host,
    mode: ArtifactMode,
    callback_started: Notify,
    callback_joined: AtomicBool,
    callback_cancelled_at: AtomicU64,
}

impl ArtifactHost {
    fn new(root: &std::path::Path, provider: &Provider, mode: ArtifactMode) -> Self {
        Self {
            inner: Host::new(root, provider, Fault::None),
            mode,
            callback_started: Notify::new(),
            callback_joined: AtomicBool::new(false),
            callback_cancelled_at: AtomicU64::new(0),
        }
    }

    fn artifact_ref(artifact: &ToolArtifact) -> ArtifactReceiptRef {
        ArtifactReceiptRef {
            artifact_id: artifact.artifact_id.clone(),
            artifact_ref: artifact.artifact_ref.clone(),
            task_id: artifact.task_id.clone(),
            session_id: artifact.session_id.clone(),
            run_id: artifact.run_id.clone(),
            native_call_id: artifact.native_call_id.clone(),
            input_sha256: artifact.input_sha256.clone(),
            output_sha256: artifact.output_sha256.clone(),
            status: artifact.status,
        }
    }
}

#[async_trait]
impl HarnessHost for ArtifactHost {
    async fn verify(&self, candidate: Candidate, cancellation: CancellationToken) -> Result<ReviewReceipt> {
        let mut receipt = self.inner.verify(candidate, cancellation).await?;
        match self.mode {
            ArtifactMode::UnknownReview => receipt.verdict = Verdict::Unknown,
            ArtifactMode::Uncommitted => receipt.committed = false,
            ArtifactMode::UnknownSettlement => receipt.settlement = Settlement::Unknown,
            _ => {}
        }
        Ok(receipt)
    }

    async fn verify_budget_snapshot(
        &self,
        snapshot: BudgetStopSnapshot,
        cancellation: CancellationToken,
    ) -> Result<ReviewReceipt> {
        assert!(snapshot.termination.is_reviewable());
        self.verify(
            Candidate { basis: snapshot.basis, output: snapshot.diagnostic_output, goal: snapshot.goal },
            cancellation,
        )
        .await
    }

    async fn verify_stop_snapshot(
        &self,
        snapshot: StopSnapshot,
        cancellation: CancellationToken,
    ) -> Result<ReviewReceipt> {
        assert!(snapshot.truncated.is_some());
        self.verify(
            Candidate { basis: snapshot.basis, output: snapshot.diagnostic_output, goal: snapshot.goal },
            cancellation,
        )
        .await
    }

    async fn review_artifacts(
        &self,
        basis: ReviewBasis,
        cancellation: CancellationToken,
    ) -> Result<Vec<ArtifactReceiptRef>> {
        let evidence = basis.events_path.parent().unwrap();
        let review_files: Vec<_> = ["review", "budget-review", "stop-review"]
            .into_iter()
            .map(|suffix| evidence.join(format!("run-{}-{suffix}.json", basis.run_number)))
            .filter(|path| path.is_file())
            .collect();
        assert_eq!(review_files.len(), 1, "raw review must be durable before artifact callback");
        let receipt: ReviewReceipt = serde_json::from_slice(&std::fs::read(&review_files[0])?)?;
        assert_eq!(receipt.basis, basis);
        assert!(!review_artifact_manifest_path(evidence, basis.run_number).exists());
        assert!(!evidence.join("outcome.json").exists());
        if basis.run_number > 1 {
            assert!(review_artifact_manifest_path(evidence, basis.run_number - 1).is_file());
        }
        if self.mode == ArtifactMode::FailSecondCallback && basis.run_number == 2 {
            bail!("controlled second artifact callback failure");
        }
        let existing = read_tool_artifacts(evidence)?;
        let journal_candidate = existing
            .iter()
            .find(|artifact| {
                artifact.artifact_id.starts_with("journal-")
                    && artifact.task_id == basis.task_id
                    && artifact.session_id == basis.session_id
                    && artifact.run_id == basis.run_id
                    && artifact.status == ArtifactStatus::Candidate
            })
            .cloned()
            .expect("Harness must derive a journal-backed candidate before Host artifact review");
        let mut artifact = ToolArtifact {
            version: ToolArtifact::VERSION,
            artifact_id: format!("artifact-{}", basis.run_number),
            task_id: basis.task_id.clone(),
            session_id: basis.session_id.clone(),
            run_id: basis.run_id.clone(),
            native_call_id: "call-1".into(),
            tool: "write_answer".into(),
            input_sha256: sha256_hex(b"input"),
            output_sha256: sha256_hex(b"correct"),
            artifact_ref: "answer.txt".into(),
            status: ArtifactStatus::Candidate,
            created_at: "2026-11-10T10:00:00Z".into(),
            host_receipt: None,
        };
        match self.mode {
            ArtifactMode::Missing => return Ok(vec![Self::artifact_ref(&artifact)]),
            ArtifactMode::Candidate | ArtifactMode::UnknownArtifact => {
                if self.mode == ArtifactMode::UnknownArtifact {
                    artifact.status = ArtifactStatus::Unknown;
                }
                append_tool_artifact(basis.events_path.parent().unwrap(), &artifact)?;
            }
            _ => {
                let verified = journal_candidate.verify(HostArtifactReceipt {
                    receipt_id: format!("receipt-{}", basis.run_number),
                    artifact_id: journal_candidate.artifact_id.clone(),
                    task_id: journal_candidate.task_id.clone(),
                    session_id: journal_candidate.session_id.clone(),
                    run_id: journal_candidate.run_id.clone(),
                    native_call_id: journal_candidate.native_call_id.clone(),
                    input_sha256: journal_candidate.input_sha256.clone(),
                    output_sha256: journal_candidate.output_sha256.clone(),
                    verifier: "artifact-test-host".into(),
                    verifier_version: "1".into(),
                    verified_at: "2026-11-10T10:01:00Z".into(),
                    committed: true,
                    settled: true,
                })?;
                if self.mode == ArtifactMode::DeadlineCallback {
                    assert!(!cancellation.is_cancelled());
                    self.callback_started.notify_one();
                    tokio::time::timeout(Duration::from_secs(5), cancellation.cancelled()).await?;
                    self.callback_cancelled_at.store(common::now_ms(), Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    // The Host finishes verification only after the original
                    // Task deadline. Harness must join and retain this late
                    // result without publishing it as accepted evidence.
                    append_tool_artifact(evidence, &verified)?;
                    self.callback_joined.store(true, Ordering::SeqCst);
                    return Ok(vec![Self::artifact_ref(&verified)]);
                }
                append_tool_artifact(basis.events_path.parent().unwrap(), &verified)?;
                match self.mode {
                    ArtifactMode::CancelCallback => {
                        self.callback_started.notify_one();
                        tokio::time::timeout(Duration::from_secs(5), cancellation.cancelled()).await?;
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        self.callback_joined.store(true, Ordering::SeqCst);
                    }
                    ArtifactMode::TamperEvents => {
                        std::fs::OpenOptions::new().append(true).open(&basis.events_path)?.write_all(b"{}\n")?;
                    }
                    ArtifactMode::TamperJournal => {
                        let segment =
                            core::session_journal::directory(&basis.session_path).join("segment-00000000.jsonl");
                        let original = std::fs::read_to_string(&segment)?;
                        let changed = original.replacen("correct", "corrupt", 1);
                        assert_ne!(original, changed);
                        assert_eq!(original.len(), changed.len());
                        std::fs::write(segment, changed)?;
                    }
                    ArtifactMode::ManifestCollision => {
                        std::fs::create_dir(review_artifact_manifest_path(evidence, basis.run_number))?;
                    }
                    ArtifactMode::IndexCollision => {
                        let review_name = review_files[0].file_name().unwrap().to_str().unwrap();
                        let index_name = review_name.replace("-review.json", "-review-index.json");
                        assert_ne!(review_name, index_name);
                        std::fs::create_dir(evidence.join(index_name))?;
                    }
                    _ => {}
                }
                return Ok(vec![Self::artifact_ref(&verified)]);
            }
        }
        Ok(vec![Self::artifact_ref(&artifact)])
    }

    async fn prepare_continuation(
        &self,
        continuation: Continuation,
        cancellation: CancellationToken,
    ) -> Result<RunRequest> {
        self.inner.prepare_continuation(continuation, cancellation).await
    }

    async fn prepare_budget_stop_continuation(
        &self,
        continuation: BudgetStopContinuation,
        _cancellation: CancellationToken,
    ) -> Result<RunRequest> {
        let mut request = self.inner.request(&format!("repair-{}", continuation.next_run_number));
        request.max_calls = 1;
        Ok(request)
    }

    async fn prepare_stop_continuation(
        &self,
        continuation: StopContinuation,
        _cancellation: CancellationToken,
    ) -> Result<RunRequest> {
        Ok(self.inner.request(&format!("repair-{}", continuation.next_run_number)))
    }
}

#[tokio::test]
async fn verified_review_publishes_artifact_manifest_and_outcome_reference() {
    let directory = tempfile::tempdir().unwrap();
    let provider = Provider::new(vec![write_answer("correct"), text("Submitted.")]);
    let host = Arc::new(ArtifactHost::new(directory.path(), &provider, ArtifactMode::Verified));
    let spec = host.inner.spec("artifact");
    let request = host.inner.request("initial");
    let outcome = start(spec, request, host).unwrap().wait().await;
    assert_eq!(outcome.stop, TaskStop::AwaitingHostAcceptance, "{outcome:?}");
    assert_eq!(outcome.artifacts.len(), 1);
    let manifest: ReviewArtifactManifest = serde_json::from_slice(
        &std::fs::read(review_artifact_manifest_path(directory.path().join("artifact").as_path(), 1)).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest.artifacts, outcome.artifacts);
    assert_eq!(manifest.receipt.basis, manifest.basis);
    let persisted: TaskOutcome =
        serde_json::from_slice(&std::fs::read(directory.path().join("artifact/outcome.json")).unwrap()).unwrap();
    assert_eq!(persisted.artifacts, outcome.artifacts);
}

#[tokio::test]
async fn candidate_or_missing_artifact_cannot_back_a_verified_review() {
    for path in REVIEW_PATHS {
        for mode in [ArtifactMode::Candidate, ArtifactMode::Missing, ArtifactMode::UnknownArtifact] {
            let directory = tempfile::tempdir().unwrap();
            let provider = Provider::new(responses(path, "correct"));
            let host = Arc::new(ArtifactHost::new(directory.path(), &provider, mode));
            let outcome = start_path(&host, path).wait().await;
            assert_eq!(outcome.stop, TaskStop::ReconciliationRequired, "{path:?}/{mode:?}: {outcome:?}");
            assert_eq!(outcome.fence_presence, FencePresence::Present);
            assert!(outcome.artifacts.is_empty());
            let evidence = directory.path().join("artifact-flow");
            assert!(evidence.join("run-1-artifacts-callback.json").is_file());
            assert!(!review_artifact_manifest_path(&evidence, 1).exists());
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ReviewPath {
    Ordinary,
    Budget,
    Length,
}

const REVIEW_PATHS: [ReviewPath; 3] = [ReviewPath::Ordinary, ReviewPath::Budget, ReviewPath::Length];

fn responses(path: ReviewPath, answer: &str) -> Vec<Value> {
    let mut responses = vec![write_answer(answer)];
    match path {
        ReviewPath::Ordinary => responses.push(text("Submitted.")),
        ReviewPath::Budget => {}
        ReviewPath::Length => responses.push(json!({"delta":{"content":"unfinished report"},"finish":"length"})),
    }
    responses
}

fn start_path(host: &Arc<ArtifactHost>, path: ReviewPath) -> TaskHandle {
    start_path_with_spec(host, path, host.inner.spec("artifact-flow"))
}

fn start_path_with_spec(host: &Arc<ArtifactHost>, path: ReviewPath, spec: TaskSpec) -> TaskHandle {
    let mut request = host.inner.request("initial");
    let mut options = TaskOptions::default();
    match path {
        ReviewPath::Ordinary => {}
        ReviewPath::Budget => {
            request.max_calls = 1;
            options.budget_stop_review = BudgetStopReviewPolicy::ReviewClosedToolRound;
        }
        ReviewPath::Length => options.length_stop_review = LengthStopReviewPolicy::ReviewClosedLength,
    }
    start_with_options(spec, request, host.clone(), options).unwrap()
}

fn manifest(evidence: &Path, number: usize) -> ReviewArtifactManifest {
    serde_json::from_slice(&std::fs::read(review_artifact_manifest_path(evidence, number)).unwrap()).unwrap()
}

#[tokio::test]
async fn all_review_paths_publish_only_after_the_artifact_callback_and_source_check() {
    for path in REVIEW_PATHS {
        let directory = tempfile::tempdir().unwrap();
        let provider = Provider::new(responses(path, "correct"));
        let host = Arc::new(ArtifactHost::new(directory.path(), &provider, ArtifactMode::Verified));
        let outcome = start_path(&host, path).wait().await;
        assert_eq!(outcome.stop, TaskStop::AwaitingHostAcceptance, "{path:?}: {outcome:?}");
        assert_eq!(outcome.artifacts.len(), 1);
        assert!(!outcome.task_accepted);
        let evidence = directory.path().join("artifact-flow");
        let accepted = manifest(&evidence, 1);
        assert_eq!(accepted.artifacts, outcome.artifacts);
        let callback: ReviewArtifactManifest =
            serde_json::from_slice(&std::fs::read(evidence.join("run-1-artifacts-callback.json")).unwrap()).unwrap();
        assert_eq!(callback.artifacts, accepted.artifacts);
        assert_eq!(callback.basis, accepted.basis);
        let persisted: TaskOutcome =
            serde_json::from_slice(&std::fs::read(evidence.join("outcome.json")).unwrap()).unwrap();
        assert_eq!(persisted.artifacts, accepted.artifacts);
        assert_eq!(provider.requests.lock().unwrap().len(), responses(path, "correct").len());
    }
}

#[tokio::test]
async fn needs_changes_preserves_history_and_publishes_only_the_latest_run_in_outcome() {
    for path in REVIEW_PATHS {
        let directory = tempfile::tempdir().unwrap();
        let second_path = match path {
            ReviewPath::Budget => ReviewPath::Budget,
            _ => ReviewPath::Ordinary,
        };
        let provider = Provider::new([responses(path, "wrong"), responses(second_path, "correct")].concat());
        let host = Arc::new(ArtifactHost::new(directory.path(), &provider, ArtifactMode::Verified));
        let outcome = start_path(&host, path).wait().await;
        assert_eq!(outcome.stop, TaskStop::AwaitingHostAcceptance, "{path:?}: {outcome:?}");
        assert_eq!(outcome.runs, 2);
        let evidence = directory.path().join("artifact-flow");
        let first = manifest(&evidence, 1);
        let second = manifest(&evidence, 2);
        assert!(matches!(first.receipt.verdict, Verdict::NeedsChanges { .. }));
        assert_eq!(second.receipt.verdict, Verdict::Verified);
        assert_eq!(outcome.artifacts, second.artifacts);
        assert_eq!(outcome.artifacts.len(), 1);
        assert_ne!(first.artifacts[0].artifact_id, second.artifacts[0].artifact_id);
        assert_eq!(first.artifacts[0].run_id, "initial");
        assert_eq!(second.artifacts[0].run_id, "repair-2");
        assert_eq!(first.basis.session_path, second.basis.session_path);
        assert_eq!(first.basis.session_id, second.basis.session_id);
        assert_eq!(second.basis.total_calls, outcome.observed_calls);
        assert_eq!(std::fs::read(directory.path().join("answer.txt")).unwrap(), b"correct");
    }
}

#[tokio::test]
async fn rejected_second_callback_clears_previous_run_artifacts_but_retains_its_manifest() {
    for path in REVIEW_PATHS {
        let directory = tempfile::tempdir().unwrap();
        let second_path = match path {
            ReviewPath::Budget => ReviewPath::Budget,
            _ => ReviewPath::Ordinary,
        };
        let provider = Provider::new([responses(path, "wrong"), responses(second_path, "correct")].concat());
        let host = Arc::new(ArtifactHost::new(directory.path(), &provider, ArtifactMode::FailSecondCallback));
        let outcome = start_path(&host, path).wait().await;
        assert_eq!(outcome.stop, TaskStop::ReconciliationRequired, "{path:?}: {outcome:?}");
        assert_eq!(outcome.runs, 2);
        assert!(outcome.artifacts.is_empty());
        let evidence = directory.path().join("artifact-flow");
        assert_eq!(manifest(&evidence, 1).artifacts.len(), 1);
        assert!(!review_artifact_manifest_path(&evidence, 2).exists());
        let persisted: TaskOutcome =
            serde_json::from_slice(&std::fs::read(evidence.join("outcome.json")).unwrap()).unwrap();
        assert!(persisted.artifacts.is_empty());
        assert_eq!(outcome.fence_presence, FencePresence::Present);
    }
}

#[tokio::test]
async fn unknown_or_uncommitted_reviews_keep_callback_evidence_without_publishing_artifacts() {
    for path in REVIEW_PATHS {
        for mode in [ArtifactMode::UnknownReview, ArtifactMode::Uncommitted, ArtifactMode::UnknownSettlement] {
            let directory = tempfile::tempdir().unwrap();
            let provider = Provider::new(responses(path, "correct"));
            let host = Arc::new(ArtifactHost::new(directory.path(), &provider, mode));
            let outcome = start_path(&host, path).wait().await;
            assert_eq!(outcome.stop, TaskStop::ReconciliationRequired, "{path:?}/{mode:?}: {outcome:?}");
            assert!(outcome.artifacts.is_empty());
            assert_eq!(outcome.fence_presence, FencePresence::Present);
            let evidence = directory.path().join("artifact-flow");
            assert!(evidence.join("run-1-artifacts-callback.json").is_file());
            assert!(!review_artifact_manifest_path(&evidence, 1).exists());
            assert!(!budget_review_index_path(&evidence, 1).exists());
            assert!(!evidence.join("run-1-stop-review-index.json").exists());
        }
    }
}

#[tokio::test]
async fn cancelled_artifact_callback_joins_and_keeps_refs_without_accepting_them() {
    for path in REVIEW_PATHS {
        let directory = tempfile::tempdir().unwrap();
        let provider = Provider::new(responses(path, "correct"));
        let host = Arc::new(ArtifactHost::new(directory.path(), &provider, ArtifactMode::CancelCallback));
        let handle = start_path(&host, path);
        tokio::time::timeout(Duration::from_secs(10), host.callback_started.notified()).await.unwrap();
        handle.cancel();
        let outcome = tokio::time::timeout(Duration::from_secs(10), handle.wait()).await.unwrap();
        assert!(host.callback_joined.load(Ordering::SeqCst));
        assert_eq!(outcome.stop, TaskStop::Cancelled, "{path:?}: {outcome:?}");
        assert!(outcome.artifacts.is_empty());
        assert_eq!(outcome.fence_presence, FencePresence::Present);
        let evidence = directory.path().join("artifact-flow");
        let callback: ReviewArtifactManifest =
            serde_json::from_slice(&std::fs::read(evidence.join("run-1-artifacts-callback.json")).unwrap()).unwrap();
        assert_eq!(callback.artifacts.len(), 1);
        assert!(!review_artifact_manifest_path(&evidence, 1).exists());
    }
}

#[tokio::test]
async fn task_deadline_cancels_and_joins_artifact_callback_without_publishing_late_verified_refs() {
    for path in REVIEW_PATHS {
        let directory = tempfile::tempdir().unwrap();
        let provider = Provider::new(responses(path, "correct"));
        let host = Arc::new(ArtifactHost::new(directory.path(), &provider, ArtifactMode::DeadlineCallback));
        let mut spec = host.inner.spec("artifact-flow");
        spec.deadline_unix_ms = common::now_ms() + 2_000;
        let deadline = spec.deadline_unix_ms;
        let handle = start_path_with_spec(&host, path, spec);
        tokio::time::timeout(Duration::from_secs(10), host.callback_started.notified()).await.unwrap();
        assert!(common::now_ms() < deadline, "{path:?}: artifact callback must start before Task expiry");
        assert!(!host.callback_joined.load(Ordering::SeqCst));
        // No explicit cancel: joined() must signal this callback when the real
        // original Task deadline elapses, then await its late Verified result.
        let outcome = tokio::time::timeout(Duration::from_secs(10), handle.wait()).await.unwrap();
        assert!(
            host.callback_cancelled_at.load(Ordering::SeqCst) >= deadline,
            "{path:?}: cancellation preceded Task expiry"
        );
        assert!(host.callback_joined.load(Ordering::SeqCst));
        assert_eq!(outcome.stop, TaskStop::Cancelled, "{path:?}: {outcome:?}");
        assert!(outcome.detail.contains("artifact review callback joined after cancellation/deadline"));
        assert!(outcome.artifacts.is_empty());
        assert!(!outcome.task_accepted);
        assert_eq!(outcome.fence_presence, FencePresence::Present);
        let fence: Value =
            serde_json::from_slice(&std::fs::read(outcome.reconciliation_fence.as_ref().unwrap()).unwrap()).unwrap();
        assert_eq!(fence["state"], "active_or_unknown");
        assert_eq!(fence["deadline_unix_ms"], deadline);
        let evidence = directory.path().join("artifact-flow");
        let callback: ReviewArtifactManifest =
            serde_json::from_slice(&std::fs::read(evidence.join("run-1-artifacts-callback.json")).unwrap()).unwrap();
        assert_eq!(callback.receipt.verdict, Verdict::Verified);
        assert_eq!(callback.artifacts.len(), 1);
        assert_eq!(callback.artifacts[0].status, ArtifactStatus::Verified);
        assert!(!review_artifact_manifest_path(&evidence, 1).exists());
        assert!(!budget_review_index_path(&evidence, 1).exists());
        assert!(!evidence.join("run-1-stop-review-index.json").exists());
        assert!(!evidence.join("released.json").exists());
        let persisted: TaskOutcome =
            serde_json::from_slice(&std::fs::read(evidence.join("outcome.json")).unwrap()).unwrap();
        assert_eq!(persisted.stop, TaskStop::Cancelled);
        assert_eq!(persisted.fence_presence, FencePresence::Present);
        assert!(persisted.artifacts.is_empty());
        assert_eq!(provider.requests.lock().unwrap().len(), responses(path, "correct").len());
    }
}

#[tokio::test]
async fn artifact_callback_source_tampering_prevents_manifest_and_outcome_publication() {
    for path in REVIEW_PATHS {
        for mode in [ArtifactMode::TamperEvents, ArtifactMode::TamperJournal] {
            let directory = tempfile::tempdir().unwrap();
            let provider = Provider::new(responses(path, "correct"));
            let host = Arc::new(ArtifactHost::new(directory.path(), &provider, mode));
            let outcome = start_path(&host, path).wait().await;
            assert_eq!(outcome.stop, TaskStop::ReconciliationRequired, "{path:?}/{mode:?}: {outcome:?}");
            assert!(outcome.artifacts.is_empty());
            assert_eq!(outcome.fence_presence, FencePresence::Present);
            let evidence = directory.path().join("artifact-flow");
            assert!(evidence.join("run-1-artifacts-callback.json").is_file());
            assert!(!review_artifact_manifest_path(&evidence, 1).exists());
            assert!(!budget_review_index_path(&evidence, 1).exists());
            assert!(!evidence.join("run-1-stop-review-index.json").exists());
            let persisted: TaskOutcome =
                serde_json::from_slice(&std::fs::read(evidence.join("outcome.json")).unwrap()).unwrap();
            assert!(persisted.artifacts.is_empty());
        }
    }
}

#[tokio::test]
async fn failed_index_or_manifest_write_keeps_fence_and_callback_without_outcome_refs() {
    for path in REVIEW_PATHS {
        for mode in [ArtifactMode::ManifestCollision, ArtifactMode::IndexCollision] {
            if matches!(path, ReviewPath::Ordinary) && mode == ArtifactMode::IndexCollision {
                continue;
            }
            let directory = tempfile::tempdir().unwrap();
            let provider = Provider::new(responses(path, "correct"));
            let host = Arc::new(ArtifactHost::new(directory.path(), &provider, mode));
            let outcome = start_path(&host, path).wait().await;
            assert_eq!(outcome.stop, TaskStop::ReconciliationRequired, "{path:?}/{mode:?}: {outcome:?}");
            assert_eq!(outcome.fence_presence, FencePresence::Present);
            assert!(outcome.artifacts.is_empty());
            let evidence = directory.path().join("artifact-flow");
            assert!(evidence.join("run-1-artifacts-callback.json").is_file());
            assert!(!review_artifact_manifest_path(&evidence, 1).is_file());
            let persisted: TaskOutcome =
                serde_json::from_slice(&std::fs::read(evidence.join("outcome.json")).unwrap()).unwrap();
            assert!(persisted.artifacts.is_empty());
        }
    }
}
