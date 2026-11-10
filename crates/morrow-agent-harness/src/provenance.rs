use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use anyhow::{ensure, Context, Result};
use fs2::FileExt;
use morrow_agent_core::artifact_provenance::{ArtifactStatus, SkillProvenance, SkillProvenanceStatus, ToolArtifact};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::storage;

pub(crate) const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const TOOL_ARTIFACTS_FILE: &str = "tool-artifacts.jsonl";
const SKILL_PROVENANCE_FILE: &str = "skill-provenance.jsonl";

pub fn tool_artifacts_path(evidence_dir: &Path) -> PathBuf {
    evidence_dir.join(TOOL_ARTIFACTS_FILE)
}

pub fn skill_provenance_path(evidence_dir: &Path) -> PathBuf {
    evidence_dir.join(SKILL_PROVENANCE_FILE)
}

fn read_records<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let metadata = fs::metadata(path)?;
    ensure!(metadata.is_file() && metadata.len() <= MAX_FILE_BYTES, "provenance file exceeds byte limit");
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= MAX_FILE_BYTES, "provenance file exceeds byte limit");
    let mut records = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        ensure!(line.len() <= MAX_LINE_BYTES, "provenance record exceeds byte limit");
        records.push(serde_json::from_slice(line).context("invalid provenance JSONL record")?);
    }
    Ok(records)
}

fn append_record<T: Serialize>(path: &Path, record: &T) -> Result<()> {
    let bytes = serde_json::to_vec(record)?;
    ensure!(bytes.len() <= MAX_LINE_BYTES, "provenance record exceeds byte limit");
    let current = fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
    ensure!(current.saturating_add(bytes.len() as u64 + 1) <= MAX_FILE_BYTES, "provenance file exceeds byte limit");
    let mut line = bytes;
    line.push(b'\n');
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(&line)?;
    file.sync_all()?;
    storage::sync_parent(path)
}

pub(crate) fn lock(evidence_dir: &Path, exclusive: bool) -> Result<File> {
    let path = evidence_dir.join(".morrow-provenance.lock");
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)?;
    if exclusive { FileExt::try_lock_exclusive(&file) } else { FileExt::try_lock_shared(&file) }
        .context("provenance evidence is busy; retry later")?;
    Ok(file)
}

pub(crate) fn read_tool_artifacts_unlocked(evidence_dir: &Path) -> Result<Vec<ToolArtifact>> {
    let records: Vec<ToolArtifact> = read_records(&tool_artifacts_path(evidence_dir))?;
    let mut positions = HashMap::new();
    let mut artifacts = Vec::with_capacity(records.len());
    for artifact in records {
        artifact.validate()?;
        if let Some(index) = positions.get(&artifact.artifact_id).copied() {
            let previous = &artifacts[index];
            validate_artifact_transition(previous, &artifact)?;
            artifacts[index] = artifact;
        } else {
            positions.insert(artifact.artifact_id.clone(), artifacts.len());
            artifacts.push(artifact);
        }
    }
    Ok(artifacts)
}

fn validate_artifact_transition(previous: &ToolArtifact, next: &ToolArtifact) -> Result<()> {
    ensure!(
        previous.version == next.version
            && previous.artifact_id == next.artifact_id
            && previous.task_id == next.task_id
            && previous.session_id == next.session_id
            && previous.run_id == next.run_id
            && previous.native_call_id == next.native_call_id
            && previous.tool == next.tool
            && previous.input_sha256 == next.input_sha256
            && previous.output_sha256 == next.output_sha256
            && previous.artifact_ref == next.artifact_ref
            && previous.created_at == next.created_at,
        "ToolArtifact transition changed immutable provenance"
    );
    ensure!(
        matches!(
            (previous.status, next.status),
            (ArtifactStatus::Candidate, ArtifactStatus::Verified | ArtifactStatus::Revoked)
                | (ArtifactStatus::Verified, ArtifactStatus::Revoked)
        ),
        "invalid ToolArtifact status transition"
    );
    if previous.status == ArtifactStatus::Verified {
        ensure!(previous.host_receipt == next.host_receipt, "verified ToolArtifact receipt changed during revocation");
    }
    Ok(())
}

pub fn read_tool_artifacts(evidence_dir: &Path) -> Result<Vec<ToolArtifact>> {
    ensure!(evidence_dir.is_dir(), "evidence directory does not exist");
    let _guard = lock(evidence_dir, false)?;
    read_tool_artifacts_unlocked(evidence_dir)
}

pub fn append_tool_artifact(evidence_dir: &Path, artifact: &ToolArtifact) -> Result<()> {
    ensure!(evidence_dir.is_dir(), "evidence directory does not exist");
    let _guard = lock(evidence_dir, true)?;
    artifact.validate()?;
    let artifacts = read_tool_artifacts_unlocked(evidence_dir)?;
    if let Some(existing) = artifacts.iter().find(|existing| existing.artifact_id == artifact.artifact_id) {
        validate_artifact_transition(existing, artifact)?;
    }
    append_record(&tool_artifacts_path(evidence_dir), artifact)
}

pub(crate) fn validate_sources(provenance: &SkillProvenance, artifacts: &[ToolArtifact]) -> Result<()> {
    for artifact_id in &provenance.source_artifact_ids {
        let artifact = artifacts
            .iter()
            .find(|artifact| &artifact.artifact_id == artifact_id)
            .context("Skill source artifact is missing")?;
        ensure!(artifact.status == ArtifactStatus::Verified, "Skill source artifact is not verified");
        ensure!(artifact.task_id == provenance.task_id, "Skill source Task does not match provenance");
        ensure!(artifact.session_id == provenance.session_id, "Skill source Session does not match provenance");
        ensure!(artifact.run_id == provenance.run_id, "Skill source Run does not match provenance");
        let host_receipt = artifact.host_receipt.as_ref().context("verified Skill source receipt is missing")?;
        for receipt in &provenance.validation_receipts {
            let binding = receipt
                .source_artifacts
                .iter()
                .find(|binding| binding.artifact_id == *artifact_id)
                .context("Skill source binding is missing")?;
            ensure!(host_receipt.receipt_id == binding.host_receipt_id, "Skill source Host receipt changed");
            ensure!(artifact.input_sha256 == binding.input_sha256, "Skill source input hash changed");
            ensure!(artifact.output_sha256 == binding.output_sha256, "Skill source output hash changed");
        }
    }
    Ok(())
}

pub(crate) fn read_skill_provenance_unlocked(evidence_dir: &Path) -> Result<Vec<SkillProvenance>> {
    let records: Vec<SkillProvenance> = read_records(&skill_provenance_path(evidence_dir))?;
    let mut provenance: Vec<SkillProvenance> = Vec::new();
    for record in records {
        record.validate()?;
        if let Some(previous) = provenance.iter_mut().find(|previous| same_skill(previous, &record)) {
            validate_skill_transition(previous, &record)?;
            *previous = record;
        } else {
            ensure!(record.status == SkillProvenanceStatus::Verified, "Skill history must start verified");
            provenance.push(record);
        }
    }
    Ok(provenance)
}

pub fn read_skill_provenance(evidence_dir: &Path) -> Result<Vec<SkillProvenance>> {
    let (provenance, artifacts) = skill_snapshot(evidence_dir)?;
    for record in &provenance {
        validate_sources(record, &artifacts)?;
    }
    Ok(provenance)
}

pub(crate) fn skill_snapshot(evidence_dir: &Path) -> Result<(Vec<SkillProvenance>, Vec<ToolArtifact>)> {
    ensure!(evidence_dir.is_dir(), "evidence directory does not exist");
    let _guard = lock(evidence_dir, false)?;
    Ok((read_skill_provenance_unlocked(evidence_dir)?, read_tool_artifacts_unlocked(evidence_dir)?))
}

fn same_skill(left: &SkillProvenance, right: &SkillProvenance) -> bool {
    left.skill_name == right.skill_name
        && left.bundle_hash == right.bundle_hash
        && left.task_id == right.task_id
        && left.session_id == right.session_id
        && left.run_id == right.run_id
        && left
            .library_binding
            .as_ref()
            .map(|binding| (&binding.scope, &binding.bundle_id, &binding.skill_verify_call_id))
            == right
                .library_binding
                .as_ref()
                .map(|binding| (&binding.scope, &binding.bundle_id, &binding.skill_verify_call_id))
}

fn validate_skill_transition(previous: &SkillProvenance, next: &SkillProvenance) -> Result<()> {
    ensure!(
        previous.status == SkillProvenanceStatus::Verified && next.status == SkillProvenanceStatus::Revoked,
        "invalid Skill provenance status transition"
    );
    let mut expected = previous.clone();
    expected.status = next.status;
    expected.observed_bundle_hash = next.observed_bundle_hash.clone();
    ensure!(expected == *next, "Skill revocation changed immutable provenance");
    Ok(())
}

pub fn append_skill_provenance(evidence_dir: &Path, provenance: &SkillProvenance) -> Result<()> {
    ensure!(evidence_dir.is_dir(), "evidence directory does not exist");
    let _guard = lock(evidence_dir, true)?;
    provenance.validate()?;
    let existing = read_skill_provenance_unlocked(evidence_dir)?;
    if let Some(previous) = existing.iter().find(|record| same_skill(record, provenance)) {
        validate_skill_transition(previous, provenance)?;
    } else {
        ensure!(provenance.status == SkillProvenanceStatus::Verified, "Skill history must start verified");
    }
    if provenance.status == SkillProvenanceStatus::Verified {
        let artifacts = read_tool_artifacts_unlocked(evidence_dir)?;
        validate_sources(provenance, &artifacts)?;
    }
    append_record(&skill_provenance_path(evidence_dir), provenance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use morrow_agent_core::artifact_provenance::{
        ArtifactStatus, HostArtifactReceipt, SkillArtifactBinding, SkillProvenance, SkillProvenanceStatus,
        SkillValidationReceipt, ToolArtifact,
    };

    fn candidate() -> ToolArtifact {
        ToolArtifact {
            version: ToolArtifact::VERSION,
            artifact_id: "artifact-1".into(),
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            native_call_id: "call-1".into(),
            tool: "exec".into(),
            input_sha256: "a".repeat(64),
            output_sha256: "b".repeat(64),
            artifact_ref: "output.bin".into(),
            status: ArtifactStatus::Candidate,
            created_at: "2026-11-10T10:00:00Z".into(),
            host_receipt: None,
        }
    }

    fn verified() -> ToolArtifact {
        let receipt = HostArtifactReceipt {
            receipt_id: "receipt-1".into(),
            artifact_id: "artifact-1".into(),
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            native_call_id: "call-1".into(),
            input_sha256: "a".repeat(64),
            output_sha256: "b".repeat(64),
            verifier: "host".into(),
            verifier_version: "1".into(),
            verified_at: "2026-11-10T10:01:00Z".into(),
            committed: true,
            settled: true,
        };
        candidate().verify(receipt).unwrap()
    }

    fn validation_receipt() -> SkillValidationReceipt {
        SkillValidationReceipt {
            receipt_id: "validation-1".into(),
            skill_name: "build-skill".into(),
            bundle_hash: "c".repeat(64),
            source_artifacts: vec![SkillArtifactBinding {
                artifact_id: "artifact-1".into(),
                host_receipt_id: "receipt-1".into(),
                input_sha256: "a".repeat(64),
                output_sha256: "b".repeat(64),
            }],
            task_id: "task-1".into(),
            session_id: "session-1".into(),
            run_id: "run-1".into(),
            verifier: "host".into(),
            verifier_version: "1".into(),
            verified_at: "2026-11-10T10:02:00Z".into(),
            committed: true,
            settled: true,
        }
    }

    #[test]
    fn tool_artifact_jsonl_roundtrip_allows_one_verified_transition_and_rejects_invalid_duplicates() {
        let directory = tempfile::tempdir().unwrap();
        let candidate_artifact = candidate();
        append_tool_artifact(directory.path(), &candidate_artifact).unwrap();
        assert_eq!(read_tool_artifacts(directory.path()).unwrap().len(), 1);
        assert!(append_tool_artifact(directory.path(), &candidate_artifact).is_err());
        let verified_artifact = verified();
        append_tool_artifact(directory.path(), &verified_artifact).unwrap();
        assert_eq!(read_tool_artifacts(directory.path()).unwrap(), vec![verified_artifact.clone()]);
        assert!(append_tool_artifact(directory.path(), &verified_artifact).is_err());

        let mut changed = candidate();
        changed.output_sha256 = "c".repeat(64);
        assert!(append_tool_artifact(directory.path(), &changed).is_err());

        let mut revoked = verified_artifact.clone();
        revoked.revoke().unwrap();
        append_tool_artifact(directory.path(), &revoked).unwrap();
        assert_eq!(read_tool_artifacts(directory.path()).unwrap(), vec![revoked]);

        let verified_directory = tempfile::tempdir().unwrap();
        append_tool_artifact(verified_directory.path(), &verified()).unwrap();
        let path = tool_artifacts_path(verified_directory.path());
        let mut tampered = std::fs::read_to_string(&path).unwrap();
        tampered = tampered.replacen(
            &format!("\"output_sha256\":\"{}\"", "b".repeat(64)),
            &format!("\"output_sha256\":\"{}\"", "c".repeat(64)),
            1,
        );
        std::fs::write(path, tampered).unwrap();
        assert!(read_tool_artifacts(verified_directory.path()).is_err());

        let unknown_directory = tempfile::tempdir().unwrap();
        let mut unknown = candidate();
        unknown.status = ArtifactStatus::Unknown;
        append_tool_artifact(unknown_directory.path(), &unknown).unwrap();
        assert!(append_tool_artifact(unknown_directory.path(), &verified()).is_err());
    }

    #[test]
    fn only_verified_same_run_artifacts_can_be_persisted_as_skill_provenance() {
        let directory = tempfile::tempdir().unwrap();
        let artifact = verified();
        append_tool_artifact(directory.path(), &artifact).unwrap();
        let provenance = SkillProvenance::verified(
            "build-skill".into(),
            "c".repeat(64),
            &[artifact],
            vec![validation_receipt()],
            "host".into(),
            "1".into(),
            "2026-11-10T10:02:00Z".into(),
        )
        .unwrap();
        append_skill_provenance(directory.path(), &provenance).unwrap();
        assert_eq!(read_skill_provenance(directory.path()).unwrap(), vec![provenance.clone()]);
        assert!(append_skill_provenance(directory.path(), &provenance).is_err());
        let artifact_path = tool_artifacts_path(directory.path());
        let tampered_artifact = std::fs::read_to_string(&artifact_path)
            .unwrap()
            .replace("\"status\":\"verified\"", "\"status\":\"revoked\"");
        std::fs::write(artifact_path, tampered_artifact).unwrap();
        assert!(read_skill_provenance(directory.path()).is_err());
        let mut candidate_provenance = provenance;
        candidate_provenance.status = SkillProvenanceStatus::Candidate;
        candidate_provenance.verified_hash = None;
        candidate_provenance.verified_at = None;
        assert!(append_skill_provenance(directory.path(), &candidate_provenance).is_err());
    }

    #[test]
    fn old_evidence_without_provenance_files_remains_readable() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("task.json"), br#"{"version":1}"#).unwrap();
        assert!(read_tool_artifacts(directory.path()).unwrap().is_empty());
        assert!(read_skill_provenance(directory.path()).unwrap().is_empty());
    }
}
