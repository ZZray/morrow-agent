use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{ensure, Context, Result};
use serde_json::Value;

use crate::{storage, AuthorizationSnapshot, BudgetStopSnapshot, BudgetStopSnapshotReference};

const SNAPSHOT_BYTES: u64 = 8 * 1024 * 1024;
const AUTHORIZATION_SNAPSHOT_FILE: &str = "authorization-snapshot.json";

pub fn authorization_snapshot_path(evidence_dir: &Path) -> PathBuf {
    evidence_dir.join(AUTHORIZATION_SNAPSHOT_FILE)
}

pub(crate) fn persist_authorization(snapshot: &AuthorizationSnapshot, evidence_dir: &Path) -> Result<()> {
    snapshot.validate()?;
    let path = authorization_snapshot_path(evidence_dir);
    storage::write_new(&path, snapshot)?;
    ensure!(read_authorization(&path)? == *snapshot, "authorization snapshot changed after write");
    Ok(())
}

pub(crate) fn read_authorization(path: &Path) -> Result<AuthorizationSnapshot> {
    let metadata = std::fs::metadata(path)?;
    ensure!(metadata.len() <= SNAPSHOT_BYTES, "authorization snapshot exceeds byte limit");
    AuthorizationSnapshot::read(path)
}

pub fn budget_snapshot_path(evidence_dir: &Path, run_number: usize) -> PathBuf {
    evidence_dir.join(format!("run-{run_number}-budget-snapshot.json"))
}

pub fn budget_review_index_path(evidence_dir: &Path, run_number: usize) -> PathBuf {
    evidence_dir.join(format!("run-{run_number}-budget-review-index.json"))
}

pub(crate) fn persist(snapshot: &BudgetStopSnapshot, evidence_dir: &Path) -> Result<BudgetStopSnapshotReference> {
    let path = budget_snapshot_path(evidence_dir, snapshot.basis.run_number);
    storage::write_new(&path, snapshot)?;
    let reference = BudgetStopSnapshotReference { sha256: storage::file_hash(&path)?, path };
    check(snapshot, &reference)?;
    Ok(reference)
}

pub(crate) fn check(snapshot: &BudgetStopSnapshot, reference: &BudgetStopSnapshotReference) -> Result<()> {
    let evidence = snapshot.basis.events_path.parent().context("snapshot evidence parent missing")?;
    ensure!(reference.path == budget_snapshot_path(evidence, snapshot.basis.run_number), "snapshot path changed");
    let mut bytes = Vec::new();
    File::open(&reference.path)?.take(SNAPSHOT_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= SNAPSHOT_BYTES, "budget snapshot exceeds byte limit");
    ensure!(storage::hash(&bytes) == reference.sha256, "budget snapshot bytes changed");
    let raw: Value = serde_json::from_slice(&bytes)?;
    ensure!(raw == serde_json::to_value(snapshot)?, "budget snapshot differs from reviewed source");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        core::termination::{BudgetStopCause, ClosedBudgetTermination},
        AuthorizationSnapshot, ReviewBasis,
    };

    #[test]
    fn authorization_snapshot_roundtrips_and_rejects_tampering() {
        let directory = tempfile::tempdir().unwrap();
        let snapshot = AuthorizationSnapshot::new(
            "task-1",
            "criteria-v1",
            "authorization-v1",
            serde_json::json!({"model":"test-model","tools":["read_file"],"token_hash":"a".repeat(64)}),
            "b".repeat(64),
        )
        .unwrap();
        persist_authorization(&snapshot, directory.path()).unwrap();
        assert_eq!(AuthorizationSnapshot::read(&authorization_snapshot_path(directory.path())).unwrap(), snapshot);

        let path = authorization_snapshot_path(directory.path());
        let mut tampered = std::fs::read_to_string(&path).unwrap();
        tampered = tampered.replace("test-model", "other-model");
        std::fs::write(&path, tampered).unwrap();
        assert!(read_authorization(&path).unwrap_err().to_string().contains("declaration hash changed"));
    }

    #[test]
    fn authorization_snapshot_size_is_checked_before_reading_contents() {
        let directory = tempfile::tempdir().unwrap();
        let path = authorization_snapshot_path(directory.path());
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(SNAPSHOT_BYTES + 1).unwrap();
        assert!(read_authorization(&path).unwrap_err().to_string().contains("exceeds byte limit"));
    }

    #[test]
    fn oversized_valid_snapshot_file_is_rejected_even_with_its_actual_hash() {
        // This unit checks only the file boundary. Native review eligibility is
        // exercised by the real Core/Host integration tests.
        let directory = tempfile::tempdir().unwrap();
        let snapshot = BudgetStopSnapshot {
            basis: ReviewBasis {
                task_id: "file-bound-test".into(),
                criteria_revision: "criteria".into(),
                authorization_revision: "grant".into(),
                run_id: "original".into(),
                session_id: String::new(),
                run_number: 1,
                session_path: directory.path().join("session.json"),
                events_path: directory.path().join("run-1-events.jsonl"),
                events_sha256: "events".into(),
                event_count: 1,
                run_calls: 1,
                total_calls: 1,
                journal_head_sha256: "head".into(),
                raw_start: 0,
                raw_end: 1,
                raw_proof: "proof".into(),
            },
            diagnostic_output: String::new(),
            goal: None,
            termination: ClosedBudgetTermination {
                version: 1,
                cause: BudgetStopCause::CallBudgetExhausted,
                native_round_closed: true,
                model_final_stop: false,
            },
        };
        let mut reference = persist(&snapshot, directory.path()).unwrap();
        let initial = std::fs::metadata(&reference.path).unwrap().len();
        let mut file = std::fs::OpenOptions::new().append(true).open(&reference.path).unwrap();
        std::io::copy(&mut std::io::repeat(b' ').take(SNAPSHOT_BYTES + 1 - initial), &mut file).unwrap();
        file.sync_all().unwrap();
        drop(file);
        let actual = std::fs::read(&reference.path).unwrap();
        assert_eq!(actual.len() as u64, SNAPSHOT_BYTES + 1);
        assert_eq!(serde_json::from_slice::<Value>(&actual).unwrap(), serde_json::to_value(&snapshot).unwrap());
        reference.sha256 = storage::hash(&actual);
        assert_eq!(check(&snapshot, &reference).unwrap_err().to_string(), "budget snapshot exceeds byte limit");
    }
}
