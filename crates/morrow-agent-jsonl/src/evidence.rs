use crate::protocol::Reference;
use anyhow::{ensure, Context, Result};
use morrow_agent_harness::{core::artifact_provenance::ToolArtifact, ArtifactReceiptRef, ReviewBasis};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn read_reference(path: &Path) -> Result<(Reference, Vec<u8>)> {
    let path = path.canonicalize()?;
    let mut file = File::open(&path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok((Reference { path, sha256: hash(&bytes) }, bytes))
}

pub fn write_new(path: &Path, value: &Value) -> Result<Reference> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    file.write_all(&bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    File::open(path.parent().context("evidence_parent_missing")?)?.sync_all()?;
    Ok(Reference { path: path.canonicalize()?, sha256: hash(&bytes) })
}

pub fn checked_candidate(candidate: &morrow_agent_harness::Candidate) -> Result<Reference> {
    let (reference, bytes) = read_reference(&candidate_path(candidate)?)?;
    let stored: morrow_agent_harness::Candidate = serde_json::from_slice(&bytes)?;
    let expected = serde_json::to_value(candidate)?;
    ensure!(
        serde_json::to_value(stored)? == expected && serde_json::from_slice::<Value>(&bytes)? == expected,
        "candidate_reference_content_mismatch"
    );
    Ok(reference)
}

fn bounded_reference(path: &Path) -> Result<(Reference, Vec<u8>)> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 16 * 1024 * 1024,
        "budget_reference_not_bounded_file"
    );
    let path = path.canonicalize()?;
    let mut bytes = Vec::new();
    File::open(&path)?.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 16 * 1024 * 1024, "budget_reference_grew");
    Ok((Reference { path, sha256: hash(&bytes) }, bytes))
}

pub fn checked_value(path: &Path, expected: &Value) -> Result<Reference> {
    let (reference, bytes) = bounded_reference(path)?;
    ensure!(serde_json::from_slice::<Value>(&bytes)? == *expected, "budget_reference_content_mismatch");
    Ok(reference)
}

/// Persist Host artifact declarations under the same review authority. An
/// already-identical record is a reference, not another ledger transition.
/// Earlier valid appends remain available if a later transition is refused.
pub fn append_review_artifacts(
    directory: &Path,
    basis: &ReviewBasis,
    artifacts: Vec<ToolArtifact>,
) -> Result<Vec<ArtifactReceiptRef>> {
    let mut ids = std::collections::HashSet::new();
    for artifact in &artifacts {
        artifact.validate()?;
        ensure!(ids.insert(artifact.artifact_id.as_str()), "duplicate_review_artifact");
        ensure!(
            artifact.task_id == basis.task_id
                && artifact.session_id == basis.session_id
                && artifact.run_id == basis.run_id,
            "review_artifact_binding_mismatch"
        );
    }
    let existing = morrow_agent_harness::read_tool_artifacts(directory)?;
    let mut references = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        if !existing.iter().any(|record| record == &artifact) {
            morrow_agent_harness::append_tool_artifact(directory, &artifact)?;
        }
        references.push(ArtifactReceiptRef {
            artifact_id: artifact.artifact_id,
            artifact_ref: artifact.artifact_ref,
            task_id: artifact.task_id,
            session_id: artifact.session_id,
            run_id: artifact.run_id,
            native_call_id: artifact.native_call_id,
            input_sha256: artifact.input_sha256,
            output_sha256: artifact.output_sha256,
            status: artifact.status,
        });
    }
    Ok(references)
}

pub fn checked_budget_snapshot(snapshot: &morrow_agent_harness::BudgetStopSnapshot) -> Result<Reference> {
    ensure!(snapshot.termination.is_reviewable(), "budget_termination_not_reviewable");
    let directory = snapshot.basis.events_path.parent().context("budget_snapshot_parent_missing")?;
    let path = morrow_agent_harness::budget_snapshot_path(directory, snapshot.basis.run_number);
    let (reference, bytes) = bounded_reference(&path)?;
    let stored: morrow_agent_harness::BudgetStopSnapshot = serde_json::from_slice(&bytes)?;
    let expected = serde_json::to_value(snapshot)?;
    ensure!(
        serde_json::to_value(stored)? == expected && serde_json::from_slice::<Value>(&bytes)? == expected,
        "budget_snapshot_content_mismatch"
    );
    Ok(reference)
}

/// The Harness-persisted `run-N-stop-snapshot.json` still equals the reviewed snapshot.
pub fn checked_stop_snapshot(snapshot: &morrow_agent_harness::StopSnapshot) -> Result<Reference> {
    let directory = snapshot.basis.events_path.parent().context("stop_snapshot_parent_missing")?;
    let path = morrow_agent_harness::stop_snapshot_path(directory, snapshot.basis.run_number);
    let (reference, bytes) = bounded_reference(&path)?;
    let stored: morrow_agent_harness::StopSnapshot = serde_json::from_slice(&bytes)?;
    let expected = serde_json::to_value(snapshot)?;
    ensure!(
        serde_json::to_value(stored)? == expected && serde_json::from_slice::<Value>(&bytes)? == expected,
        "stop_snapshot_content_mismatch"
    );
    Ok(reference)
}

/// A trusted index is correlated with the exact current receipt, never a scan
/// for an older successful Run. A missing index can represent a rejected review.
pub fn checked_budget_review(directory: &Path, receipt: &morrow_agent_harness::ReviewReceipt) -> Result<Reference> {
    let path = morrow_agent_harness::budget_review_index_path(directory, receipt.basis.run_number);
    let (reference, bytes) = bounded_reference(&path)?;
    let record: morrow_agent_harness::BudgetStopReviewRecord = serde_json::from_slice(&bytes)?;
    ensure!(record.version == 1 && record.kind == "closed_budget_snapshot_review", "budget_review_index_kind");
    ensure!(
        serde_json::from_slice::<Value>(&bytes)? == serde_json::to_value(&record)?,
        "budget_review_index_extra_fields"
    );
    ensure!(serde_json::to_value(&record.receipt)? == serde_json::to_value(receipt)?, "budget_review_receipt_mismatch");
    let (snapshot_reference, snapshot_bytes) = bounded_reference(&record.snapshot.path)?;
    ensure!(snapshot_reference.sha256 == record.snapshot.sha256, "budget_review_snapshot_hash_mismatch");
    let snapshot: morrow_agent_harness::BudgetStopSnapshot = serde_json::from_slice(&snapshot_bytes)?;
    ensure!(snapshot.basis == receipt.basis, "budget_review_snapshot_basis_mismatch");
    let expected = checked_budget_snapshot(&snapshot)?;
    ensure!(
        expected.path == snapshot_reference.path && expected.sha256 == snapshot_reference.sha256,
        "budget_review_snapshot_path_mismatch"
    );
    ensure!(
        receipt.committed
            && receipt.settlement == morrow_agent_harness::Settlement::Settled
            && receipt.verdict != morrow_agent_harness::Verdict::Unknown,
        "budget_review_not_committed_settled"
    );
    Ok(reference)
}

pub fn rpc_path(directory: &Path, rpc: &str, suffix: &str) -> PathBuf {
    directory.join(format!("jsonl-{rpc}-{suffix}.json"))
}

pub fn candidate_path(candidate: &morrow_agent_harness::Candidate) -> Result<PathBuf> {
    Ok(candidate
        .basis
        .events_path
        .parent()
        .context("candidate_parent_missing")?
        .join(format!("run-{}-candidate.json", candidate.basis.run_number)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use morrow_agent_harness::{Candidate, ReviewBasis};
    use serde_json::json;

    struct Fixture {
        directory: PathBuf,
        candidate: Candidate,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "ara-jsonl-candidate-{}-{}",
                std::process::id(),
                morrow_agent_harness::core::fresh_id()
            ));
            std::fs::create_dir(&directory).unwrap();
            let candidate = Candidate {
                basis: ReviewBasis {
                    task_id: "task-fixture".into(),
                    criteria_revision: "criteria-fixture".into(),
                    authorization_revision: "grant-fixture".into(),
                    run_id: "run-fixture".into(),
                    session_id: String::new(),
                    run_number: 1,
                    session_path: directory.join("session.json"),
                    events_path: directory.join("run-1-events.jsonl"),
                    events_sha256: "events-fixture".into(),
                    event_count: 4,
                    run_calls: 1,
                    total_calls: 1,
                    journal_head_sha256: "head-fixture".into(),
                    raw_start: 0,
                    raw_end: 2,
                    raw_proof: "proof-fixture".into(),
                },
                output: "actual candidate output".into(),
                goal: None,
            };
            Self { directory, candidate }
        }

        fn save(&self, value: Value) -> Vec<u8> {
            let mut bytes = serde_json::to_vec(&value).unwrap();
            bytes.push(b'\n');
            std::fs::write(candidate_path(&self.candidate).unwrap(), &bytes).unwrap();
            bytes
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only the single file and new empty directory owned by this test;
            // no recursive cleanup and no product/session files are involved.
            if let Ok(path) = candidate_path(&self.candidate) {
                let _ = std::fs::remove_file(path);
            }
            let _ = std::fs::remove_dir(&self.directory);
        }
    }

    #[test]
    fn candidate_reference_accepts_exact_file_and_hashes_the_same_bytes() {
        let fixture = Fixture::new();
        let bytes = fixture.save(serde_json::to_value(&fixture.candidate).unwrap());
        let reference = checked_candidate(&fixture.candidate).unwrap();
        assert_eq!(reference.path, candidate_path(&fixture.candidate).unwrap().canonicalize().unwrap());
        assert_eq!(reference.sha256, hash(&bytes));
        assert_eq!(std::fs::read(reference.path).unwrap(), bytes);
    }

    #[test]
    fn candidate_reference_refuses_changed_output_with_unchanged_basis() {
        let fixture = Fixture::new();
        let mut changed = serde_json::to_value(&fixture.candidate).unwrap();
        changed["output"] = json!("different disk output");
        assert_eq!(changed["basis"], serde_json::to_value(&fixture.candidate.basis).unwrap());
        fixture.save(changed);
        assert!(checked_candidate(&fixture.candidate).is_err());
    }

    #[test]
    fn candidate_reference_refuses_extra_raw_fields() {
        let fixture = Fixture::new();
        let mut changed = serde_json::to_value(&fixture.candidate).unwrap();
        changed["unexpected"] = json!("not part of the supplied candidate");
        fixture.save(changed);
        assert!(checked_candidate(&fixture.candidate).is_err());
    }

    fn budget_snapshot(fixture: &Fixture) -> morrow_agent_harness::BudgetStopSnapshot {
        morrow_agent_harness::BudgetStopSnapshot {
            basis: fixture.candidate.basis.clone(),
            diagnostic_output: "failed Run diagnostic, not a model final response".into(),
            goal: None,
            termination: serde_json::from_value(json!({"version":1,"cause":"call_budget_exhausted",
                "native_round_closed":true,"model_final_stop":false}))
            .unwrap(),
        }
    }

    #[test]
    fn budget_snapshot_checker_refuses_content_mutation_and_extended_raw_fields() {
        let fixture = Fixture::new();
        let snapshot = budget_snapshot(&fixture);
        let path = morrow_agent_harness::budget_snapshot_path(&fixture.directory, 1);
        let expected = serde_json::to_value(&snapshot).unwrap();
        let reference = write_new(&path, &expected).unwrap();
        assert_eq!(checked_budget_snapshot(&snapshot).unwrap().sha256, reference.sha256);
        let mut changed = expected.clone();
        changed["diagnostic_output"] = json!("changed");
        std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(checked_budget_snapshot(&snapshot).is_err());
        changed = expected;
        changed["effects_settled"] = json!(true);
        std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(checked_budget_snapshot(&snapshot).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn budget_review_index_is_bound_to_the_exact_receipt_and_snapshot() {
        use morrow_agent_harness::{
            BudgetStopReviewRecord, BudgetStopSnapshotReference, ReviewReceipt, Settlement, Verdict,
        };
        let fixture = Fixture::new();
        let snapshot = budget_snapshot(&fixture);
        let path = morrow_agent_harness::budget_snapshot_path(&fixture.directory, 1);
        let reference = write_new(&path, &serde_json::to_value(&snapshot).unwrap()).unwrap();
        let receipt = ReviewReceipt {
            basis: snapshot.basis.clone(),
            committed: true,
            settlement: Settlement::Settled,
            verdict: Verdict::Verified,
            evidence: vec!["host-owned actual file check".into()],
        };
        let record = BudgetStopReviewRecord {
            version: 1,
            kind: "closed_budget_snapshot_review".into(),
            snapshot: BudgetStopSnapshotReference { path: reference.path, sha256: reference.sha256 },
            receipt: receipt.clone(),
        };
        let index = morrow_agent_harness::budget_review_index_path(&fixture.directory, 1);
        write_new(&index, &serde_json::to_value(&record).unwrap()).unwrap();
        assert!(checked_budget_review(&fixture.directory, &receipt).is_ok());
        let mut changed = receipt.clone();
        changed.basis.authorization_revision = "another authority".into();
        assert!(checked_budget_review(&fixture.directory, &changed).is_err());
        let mut body = serde_json::to_value(&snapshot).unwrap();
        body["termination"]["model_final_stop"] = json!(true);
        std::fs::write(&path, serde_json::to_vec(&body).unwrap()).unwrap();
        assert!(checked_budget_review(&fixture.directory, &receipt).is_err());
        std::fs::remove_file(index).unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn budget_continuation_view_requires_the_complete_original_payload() {
        let fixture = Fixture::new();
        let path = fixture.directory.join("jsonl-budget-continuation-2.json");
        let payload = json!({"remaining_calls":1,"deadline_unix_ms":1234});
        let reference = write_new(&path, &payload).unwrap();
        assert_eq!(checked_value(&path, &payload).unwrap().sha256, reference.sha256);
        std::fs::write(&path, b"{\"remaining_calls\":99,\"deadline_unix_ms\":1234}").unwrap();
        assert!(checked_value(&path, &payload).is_err());
        std::fs::remove_file(path).unwrap();
    }

    fn artifact(basis: &ReviewBasis, id: &str) -> ToolArtifact {
        serde_json::from_value(json!({"version":1,"artifact_id":id,"task_id":basis.task_id,
            "session_id":basis.session_id,"run_id":basis.run_id,"native_call_id":"call-1","tool":"write_answer",
            "input_sha256":"a".repeat(64),"output_sha256":"b".repeat(64),"artifact_ref":"answer.txt",
            "status":"candidate","created_at":"1"}))
        .unwrap()
    }

    #[test]
    fn artifact_append_binds_scope_skips_identical_records_and_preserves_valid_transitions() {
        use morrow_agent_harness::{append_tool_artifact, read_tool_artifacts, tool_artifacts_path};
        let mut fixture = Fixture::new();
        fixture.candidate.basis.session_id = "session-1".into();
        let basis = &fixture.candidate.basis;
        let candidate = artifact(basis, "artifact-1");
        append_tool_artifact(&fixture.directory, &candidate).unwrap();
        let path = tool_artifacts_path(&fixture.directory);
        let original = std::fs::read(&path).unwrap();
        let refs = append_review_artifacts(&fixture.directory, basis, vec![candidate.clone()]).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let receipt = serde_json::from_value(json!({"receipt_id":"receipt-1","artifact_id":candidate.artifact_id,
            "task_id":basis.task_id,"session_id":basis.session_id,"run_id":basis.run_id,
            "native_call_id":candidate.native_call_id,"input_sha256":candidate.input_sha256,
            "output_sha256":candidate.output_sha256,"verifier":"host","verifier_version":"1",
            "verified_at":"1","committed":true,"settled":true}))
        .unwrap();
        let verified = candidate.verify(receipt).unwrap();
        let refs = append_review_artifacts(&fixture.directory, basis, vec![verified.clone()]).unwrap();
        assert_eq!(refs[0].status, morrow_agent_harness::core::artifact_provenance::ArtifactStatus::Verified);
        let committed = std::fs::read(&path).unwrap();
        append_review_artifacts(&fixture.directory, basis, vec![verified.clone()]).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), committed);
        assert!(append_review_artifacts(&fixture.directory, basis, vec![candidate]).is_err());
        for field in ["task_id", "session_id", "run_id"] {
            let mut changed = serde_json::to_value(&verified).unwrap();
            changed[field] = json!("other");
            changed["host_receipt"][field] = json!("other");
            let changed = serde_json::from_value(changed).unwrap();
            assert!(append_review_artifacts(&fixture.directory, basis, vec![changed]).is_err(), "{field}");
            assert_eq!(std::fs::read(&path).unwrap(), committed);
        }
        assert!(append_review_artifacts(&fixture.directory, basis, vec![verified.clone(), verified.clone()]).is_err());
        let fresh = artifact(basis, "new-business-artifact");
        let mut invalid_transition = verified.clone();
        invalid_transition.artifact_ref = "changed.txt".into();
        assert!(append_review_artifacts(&fixture.directory, basis, vec![fresh.clone(), invalid_transition]).is_err());
        let persisted = read_tool_artifacts(&fixture.directory).unwrap();
        assert_eq!(persisted, vec![verified, fresh], "valid prefix appends are retained after a later refusal");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(fixture.directory.join(".morrow-provenance.lock")).unwrap();
    }
}
