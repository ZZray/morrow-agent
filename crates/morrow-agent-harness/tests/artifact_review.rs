mod common;

use anyhow::Result;
use async_trait::async_trait;
use common::{now_ms, text, write_answer, Fault, Host, Provider};
use morrow_agent_harness::core::artifact_provenance::{sha256_hex, ArtifactStatus, HostArtifactReceipt, ToolArtifact};
use morrow_agent_harness::core::RunRequest;
use morrow_agent_harness::*;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
enum ArtifactMode {
    Verified,
    Candidate,
    Missing,
}

struct ArtifactHost {
    inner: Host,
    mode: ArtifactMode,
}

impl ArtifactHost {
    fn new(root: &std::path::Path, provider: &Provider, mode: ArtifactMode) -> Self {
        Self { inner: Host::new(root, provider, Fault::None), mode }
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
        self.inner.verify(candidate, cancellation).await
    }

    async fn review_artifacts(
        &self,
        basis: ReviewBasis,
        _cancellation: CancellationToken,
    ) -> Result<Vec<ArtifactReceiptRef>> {
        let artifact = ToolArtifact {
            version: ToolArtifact::VERSION,
            artifact_id: "artifact-1".into(),
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
            ArtifactMode::Candidate => {
                append_tool_artifact(basis.events_path.parent().unwrap(), &artifact)?;
            }
            ArtifactMode::Verified => {
                let verified = artifact.verify(HostArtifactReceipt {
                    receipt_id: "receipt-1".into(),
                    artifact_id: artifact.artifact_id.clone(),
                    task_id: artifact.task_id.clone(),
                    session_id: artifact.session_id.clone(),
                    run_id: artifact.run_id.clone(),
                    native_call_id: artifact.native_call_id.clone(),
                    input_sha256: artifact.input_sha256.clone(),
                    output_sha256: artifact.output_sha256.clone(),
                    verifier: "artifact-test-host".into(),
                    verifier_version: "1".into(),
                    verified_at: "2026-11-10T10:01:00Z".into(),
                    committed: true,
                    settled: true,
                })?;
                append_tool_artifact(basis.events_path.parent().unwrap(), &verified)?;
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
    for mode in [ArtifactMode::Candidate, ArtifactMode::Missing] {
        let directory = tempfile::tempdir().unwrap();
        let provider = Provider::new(vec![write_answer("correct"), text("Submitted.")]);
        let host = Arc::new(ArtifactHost::new(directory.path(), &provider, mode));
        let mut spec = host.inner.spec("artifact-rejected");
        spec.deadline_unix_ms = now_ms() + 30_000;
        let outcome = start(spec, host.inner.request("initial"), host).unwrap().wait().await;
        assert_eq!(outcome.stop, TaskStop::ReconciliationRequired, "{outcome:?}");
        assert!(outcome.reconciliation_fence.is_some());
        assert!(outcome.artifacts.is_empty());
    }
}
