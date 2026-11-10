//! Host-owned provenance for reusable tool outputs and Skill validation.
//!
//! These records describe evidence supplied by a Host. They do not execute tools,
//! inspect business systems, or accept a Task.

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_REFERENCE_BYTES: usize = 4096;
const MAX_ARTIFACTS: usize = 64;

fn bounded(value: &str, limit: usize, label: &str) -> Result<()> {
    ensure!(!value.is_empty(), "{label} is required");
    ensure!(value.len() <= limit, "{label} exceeds byte limit");
    ensure!(value.trim() == value && !value.chars().any(char::is_control), "{label} is invalid");
    Ok(())
}

fn artifact_reference(value: &str) -> Result<()> {
    bounded(value, MAX_REFERENCE_BYTES, "artifact reference")?;
    let windows_drive = value.len() >= 2 && value.as_bytes()[1] == b':' && value.as_bytes()[0].is_ascii_alphabetic();
    let has_path_escape = value.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..");
    ensure!(
        !value.starts_with('/')
            && !value.starts_with('\\')
            && !value.contains("://")
            && !value.contains('\\')
            && !windows_drive
            && !has_path_escape
            && !value.contains('?')
            && !value.contains('#'),
        "artifact reference must be a relative or opaque reference without credentials"
    );
    Ok(())
}

fn hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) && value == value.to_ascii_lowercase()
}

fn unique_ids(ids: &[String]) -> Result<()> {
    ensure!(!ids.is_empty() && ids.len() <= MAX_ARTIFACTS, "source artifact IDs are out of bounds");
    let mut seen = HashSet::new();
    for id in ids {
        bounded(id, MAX_IDENTIFIER_BYTES, "source artifact ID")?;
        ensure!(seen.insert(id), "source artifact IDs must be unique");
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactStatus {
    Candidate,
    Verified,
    Revoked,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostArtifactReceipt {
    pub receipt_id: String,
    pub artifact_id: String,
    pub task_id: String,
    pub session_id: String,
    pub run_id: String,
    pub native_call_id: String,
    pub input_sha256: String,
    pub output_sha256: String,
    pub verifier: String,
    pub verifier_version: String,
    pub verified_at: String,
    pub committed: bool,
    pub settled: bool,
}

impl HostArtifactReceipt {
    pub fn validate(&self) -> Result<()> {
        bounded(&self.receipt_id, MAX_IDENTIFIER_BYTES, "artifact receipt ID")?;
        bounded(&self.artifact_id, MAX_IDENTIFIER_BYTES, "artifact ID")?;
        bounded(&self.task_id, MAX_IDENTIFIER_BYTES, "task ID")?;
        bounded(&self.session_id, MAX_IDENTIFIER_BYTES, "session ID")?;
        bounded(&self.run_id, MAX_IDENTIFIER_BYTES, "Run ID")?;
        bounded(&self.native_call_id, MAX_IDENTIFIER_BYTES, "native call ID")?;
        bounded(&self.verifier, MAX_IDENTIFIER_BYTES, "verifier")?;
        bounded(&self.verifier_version, MAX_IDENTIFIER_BYTES, "verifier version")?;
        bounded(&self.verified_at, MAX_IDENTIFIER_BYTES, "verification time")?;
        ensure!(hash(&self.input_sha256) && hash(&self.output_sha256), "artifact receipt hash is invalid");
        ensure!(self.committed && self.settled, "artifact receipt must be committed and settled");
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolArtifact {
    pub version: u32,
    pub artifact_id: String,
    pub task_id: String,
    pub session_id: String,
    pub run_id: String,
    pub native_call_id: String,
    pub tool: String,
    pub input_sha256: String,
    pub output_sha256: String,
    pub artifact_ref: String,
    pub status: ArtifactStatus,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_receipt: Option<HostArtifactReceipt>,
}

impl ToolArtifact {
    pub const VERSION: u32 = 1;

    pub fn validate(&self) -> Result<()> {
        ensure!(self.version == Self::VERSION, "unsupported ToolArtifact version");
        bounded(&self.artifact_id, MAX_IDENTIFIER_BYTES, "artifact ID")?;
        bounded(&self.task_id, MAX_IDENTIFIER_BYTES, "task ID")?;
        bounded(&self.session_id, MAX_IDENTIFIER_BYTES, "session ID")?;
        bounded(&self.run_id, MAX_IDENTIFIER_BYTES, "Run ID")?;
        bounded(&self.native_call_id, MAX_IDENTIFIER_BYTES, "native call ID")?;
        bounded(&self.tool, MAX_IDENTIFIER_BYTES, "tool name")?;
        artifact_reference(&self.artifact_ref)?;
        bounded(&self.created_at, MAX_IDENTIFIER_BYTES, "artifact creation time")?;
        ensure!(hash(&self.input_sha256) && hash(&self.output_sha256), "artifact hash is invalid");
        if let Some(receipt) = &self.host_receipt {
            receipt.validate()?;
            ensure!(receipt.artifact_id == self.artifact_id, "artifact receipt ID does not match artifact");
            ensure!(receipt.task_id == self.task_id, "artifact receipt Task does not match artifact");
            ensure!(receipt.session_id == self.session_id, "artifact receipt Session does not match artifact");
            ensure!(receipt.run_id == self.run_id, "artifact receipt Run does not match artifact");
            ensure!(receipt.native_call_id == self.native_call_id, "artifact receipt call does not match artifact");
            ensure!(receipt.input_sha256 == self.input_sha256, "artifact input hash does not match receipt");
            ensure!(receipt.output_sha256 == self.output_sha256, "artifact output hash does not match receipt");
        }
        match self.status {
            ArtifactStatus::Candidate => {
                ensure!(self.host_receipt.is_none(), "candidate artifact cannot have a Host receipt")
            }
            ArtifactStatus::Verified => {
                ensure!(self.host_receipt.is_some(), "verified artifact requires a Host receipt")
            }
            ArtifactStatus::Revoked | ArtifactStatus::Unknown => {}
        }
        Ok(())
    }

    pub fn verify(&self, receipt: HostArtifactReceipt) -> Result<Self> {
        self.validate()?;
        ensure!(self.status == ArtifactStatus::Candidate, "only candidate artifacts can be verified");
        receipt.validate()?;
        let mut verified = self.clone();
        verified.status = ArtifactStatus::Verified;
        verified.host_receipt = Some(receipt);
        verified.validate()?;
        Ok(verified)
    }

    pub fn revoke(&mut self) -> Result<()> {
        self.validate()?;
        self.status = ArtifactStatus::Revoked;
        self.validate()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillProvenanceStatus {
    Candidate,
    Verified,
    Revoked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillValidationReceipt {
    pub receipt_id: String,
    pub skill_name: String,
    pub bundle_hash: String,
    pub source_artifacts: Vec<SkillArtifactBinding>,
    pub task_id: String,
    pub session_id: String,
    pub run_id: String,
    pub verifier: String,
    pub verifier_version: String,
    pub verified_at: String,
    pub committed: bool,
    pub settled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillArtifactBinding {
    pub artifact_id: String,
    pub host_receipt_id: String,
    pub input_sha256: String,
    pub output_sha256: String,
}

impl SkillArtifactBinding {
    pub fn validate(&self) -> Result<()> {
        bounded(&self.artifact_id, MAX_IDENTIFIER_BYTES, "Skill source artifact ID")?;
        bounded(&self.host_receipt_id, MAX_IDENTIFIER_BYTES, "Skill source Host receipt ID")?;
        ensure!(hash(&self.input_sha256) && hash(&self.output_sha256), "Skill source artifact hash is invalid");
        Ok(())
    }
}

impl SkillValidationReceipt {
    pub fn validate(&self) -> Result<()> {
        bounded(&self.receipt_id, MAX_IDENTIFIER_BYTES, "Skill validation receipt ID")?;
        bounded(&self.skill_name, MAX_IDENTIFIER_BYTES, "Skill validation Skill name")?;
        ensure!(hash(&self.bundle_hash), "Skill validation bundle hash is invalid");
        ensure!(
            !self.source_artifacts.is_empty() && self.source_artifacts.len() <= MAX_ARTIFACTS,
            "Skill source artifacts are out of bounds"
        );
        let mut artifact_ids = HashSet::new();
        for artifact in &self.source_artifacts {
            artifact.validate()?;
            ensure!(artifact_ids.insert(artifact.artifact_id.as_str()), "Skill source artifacts must be unique");
        }
        bounded(&self.task_id, MAX_IDENTIFIER_BYTES, "Skill validation Task ID")?;
        bounded(&self.session_id, MAX_IDENTIFIER_BYTES, "Skill validation Session ID")?;
        bounded(&self.run_id, MAX_IDENTIFIER_BYTES, "Skill validation Run ID")?;
        bounded(&self.verifier, MAX_IDENTIFIER_BYTES, "Skill validation verifier")?;
        bounded(&self.verifier_version, MAX_IDENTIFIER_BYTES, "Skill validation verifier version")?;
        bounded(&self.verified_at, MAX_IDENTIFIER_BYTES, "Skill validation time")?;
        ensure!(self.committed && self.settled, "Skill validation receipt must be committed and settled");
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillLibraryBinding {
    pub scope: String,
    pub bundle_id: String,
    pub skill_verify_call_id: String,
    pub native_evidence_sha256: String,
}

impl SkillLibraryBinding {
    pub fn validate(&self) -> Result<()> {
        ensure!(matches!(self.scope.as_str(), "project" | "global"), "invalid Skill library scope");
        ensure!(
            self.bundle_id.len() == 32 && self.bundle_id.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid owned Skill bundle ID"
        );
        ensure!(hash(&self.native_evidence_sha256), "invalid native Skill evidence hash");
        bounded(&self.skill_verify_call_id, MAX_IDENTIFIER_BYTES, "Skill verification call ID")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkillProvenance {
    pub version: u32,
    pub skill_name: String,
    pub bundle_hash: String,
    pub source_artifact_ids: Vec<String>,
    pub task_id: String,
    pub session_id: String,
    pub run_id: String,
    pub validation_receipts: Vec<SkillValidationReceipt>,
    pub verifier: String,
    pub verifier_version: String,
    pub status: SkillProvenanceStatus,
    /// Current hash observed after the originally verified bundle changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_bundle_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_binding: Option<SkillLibraryBinding>,
}

impl SkillProvenance {
    pub const VERSION: u32 = 1;

    pub fn validate(&self) -> Result<()> {
        ensure!(self.version == Self::VERSION, "unsupported SkillProvenance version");
        if let Some(binding) = &self.library_binding {
            binding.validate()?;
        }
        bounded(&self.skill_name, MAX_IDENTIFIER_BYTES, "Skill name")?;
        ensure!(hash(&self.bundle_hash), "Skill bundle hash is invalid");
        unique_ids(&self.source_artifact_ids)?;
        bounded(&self.task_id, MAX_IDENTIFIER_BYTES, "Task ID")?;
        bounded(&self.session_id, MAX_IDENTIFIER_BYTES, "Session ID")?;
        bounded(&self.run_id, MAX_IDENTIFIER_BYTES, "Run ID")?;
        ensure!(
            !self.validation_receipts.is_empty() && self.validation_receipts.len() <= MAX_ARTIFACTS,
            "validation receipts are out of bounds"
        );
        let mut receipts = HashSet::new();
        for receipt in &self.validation_receipts {
            receipt.validate()?;
            ensure!(receipts.insert(receipt.receipt_id.as_str()), "validation receipts must be unique");
            ensure!(receipt.skill_name == self.skill_name, "Skill validation receipt name does not match provenance");
            ensure!(receipt.bundle_hash == self.bundle_hash, "Skill validation receipt hash does not match provenance");
            ensure!(
                receipt.source_artifacts.iter().map(|artifact| artifact.artifact_id.as_str()).collect::<Vec<_>>()
                    == self.source_artifact_ids.iter().map(String::as_str).collect::<Vec<_>>(),
                "Skill validation receipt artifacts do not match provenance"
            );
            ensure!(receipt.task_id == self.task_id, "Skill validation receipt Task does not match provenance");
            ensure!(
                receipt.session_id == self.session_id,
                "Skill validation receipt Session does not match provenance"
            );
            ensure!(receipt.run_id == self.run_id, "Skill validation receipt Run does not match provenance");
            ensure!(receipt.verifier == self.verifier, "Skill validation receipt verifier does not match provenance");
            ensure!(
                receipt.verifier_version == self.verifier_version,
                "Skill validation receipt version does not match provenance"
            );
        }
        bounded(&self.verifier, MAX_IDENTIFIER_BYTES, "Skill verifier")?;
        bounded(&self.verifier_version, MAX_IDENTIFIER_BYTES, "Skill verifier version")?;
        match self.status {
            SkillProvenanceStatus::Candidate => {
                ensure!(
                    self.observed_bundle_hash.is_none() && self.verified_hash.is_none() && self.verified_at.is_none(),
                    "candidate Skill cannot have verified fields"
                );
            }
            SkillProvenanceStatus::Verified => {
                ensure!(self.observed_bundle_hash.is_none(), "verified Skill cannot have an observed replacement hash");
                ensure!(
                    self.verified_hash.as_deref() == Some(self.bundle_hash.as_str()),
                    "verified Skill hash must match bundle hash"
                );
                bounded(self.verified_at.as_deref().unwrap_or(""), MAX_IDENTIFIER_BYTES, "Skill verification time")?;
            }
            SkillProvenanceStatus::Revoked => {
                if let Some(observed_hash) = &self.observed_bundle_hash {
                    ensure!(hash(observed_hash), "revoked Skill observed hash is invalid");
                }
                if let Some(verified_hash) = &self.verified_hash {
                    ensure!(hash(verified_hash), "revoked Skill verified hash is invalid");
                }
                if let Some(time) = &self.verified_at {
                    bounded(time, MAX_IDENTIFIER_BYTES, "Skill verification time")?;
                }
            }
        }
        Ok(())
    }

    pub fn verified(
        skill_name: String,
        bundle_hash: String,
        artifacts: &[ToolArtifact],
        validation_receipts: Vec<SkillValidationReceipt>,
        verifier: String,
        verifier_version: String,
        verified_at: String,
    ) -> Result<Self> {
        ensure!(!artifacts.is_empty(), "Skill provenance needs a source artifact");
        for artifact in artifacts {
            artifact.validate()?;
            ensure!(artifact.status == ArtifactStatus::Verified, "Skill provenance requires verified artifacts");
        }
        let first = &artifacts[0];
        let source_artifact_ids = artifacts.iter().map(|artifact| artifact.artifact_id.clone()).collect();
        let provenance = Self {
            version: Self::VERSION,
            skill_name,
            bundle_hash: bundle_hash.clone(),
            source_artifact_ids,
            task_id: first.task_id.clone(),
            session_id: first.session_id.clone(),
            run_id: first.run_id.clone(),
            validation_receipts,
            verifier,
            verifier_version,
            status: SkillProvenanceStatus::Verified,
            observed_bundle_hash: None,
            verified_hash: Some(bundle_hash),
            verified_at: Some(verified_at),
            library_binding: None,
        };
        for artifact in artifacts.iter().skip(1) {
            ensure!(artifact.task_id == provenance.task_id, "Skill source artifacts use different Tasks");
            ensure!(artifact.session_id == provenance.session_id, "Skill source artifacts use different Sessions");
            ensure!(artifact.run_id == provenance.run_id, "Skill source artifacts use different Runs");
        }
        provenance.validate()?;
        Ok(provenance)
    }

    pub fn refresh_status(&mut self, current_bundle_hash: &str) -> Result<()> {
        ensure!(hash(current_bundle_hash), "current Skill bundle hash is invalid");
        self.validate()?;
        if self.status == SkillProvenanceStatus::Verified && self.bundle_hash != current_bundle_hash {
            self.observed_bundle_hash = Some(current_bundle_hash.to_owned());
            self.status = SkillProvenanceStatus::Revoked;
        }
        self.validate()
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

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
            artifact_ref: "artifacts/output.bin".into(),
            status: ArtifactStatus::Candidate,
            created_at: "2026-11-10T10:00:00Z".into(),
            host_receipt: None,
        }
    }

    fn receipt() -> HostArtifactReceipt {
        HostArtifactReceipt {
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
        }
    }

    fn skill_receipt(bundle_hash: &str, artifact_ids: &[&str]) -> SkillValidationReceipt {
        SkillValidationReceipt {
            receipt_id: "validation-1".into(),
            skill_name: "build-skill".into(),
            bundle_hash: bundle_hash.into(),
            source_artifacts: artifact_ids
                .iter()
                .map(|id| SkillArtifactBinding {
                    artifact_id: (*id).into(),
                    host_receipt_id: if *id == "artifact-1" { "receipt-1" } else { "receipt-2" }.into(),
                    input_sha256: "a".repeat(64),
                    output_sha256: "b".repeat(64),
                })
                .collect(),
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
    fn artifact_roundtrip_and_receipt_binding() {
        let artifact = candidate();
        artifact.validate().unwrap();
        let restored: ToolArtifact = serde_json::from_value(serde_json::to_value(&artifact).unwrap()).unwrap();
        assert_eq!(restored, artifact);
        let verified = artifact.verify(receipt()).unwrap();
        assert_eq!(verified.status, ArtifactStatus::Verified);
        assert!(verified.host_receipt.is_some());
        let mut escaped = candidate();
        escaped.artifact_ref = "../secret".into();
        assert!(escaped.validate().is_err());
    }

    #[test]
    fn mismatched_or_unsettled_receipts_are_rejected() {
        let mut mismatch = receipt();
        mismatch.output_sha256 = "c".repeat(64);
        assert!(candidate().verify(mismatch).is_err());
        let mut unsettled = receipt();
        unsettled.settled = false;
        assert!(candidate().verify(unsettled).is_err());
        let mut verified = candidate().verify(receipt()).unwrap();
        assert!(verified.verify(receipt()).is_err());
        verified.revoke().unwrap();
        assert_eq!(verified.status, ArtifactStatus::Revoked);
    }

    #[test]
    fn skill_provenance_requires_verified_same_run_artifacts_and_revokes_on_hash_change() {
        let first = candidate().verify(receipt()).unwrap();
        let mut second = candidate();
        second.artifact_id = "artifact-2".into();
        second.native_call_id = "call-2".into();
        let mut second_receipt = receipt();
        second_receipt.artifact_id = "artifact-2".into();
        second_receipt.native_call_id = "call-2".into();
        let second = second.verify(second_receipt).unwrap();
        let skill_hash = "d".repeat(64);
        let mut provenance = SkillProvenance::verified(
            "build-skill".into(),
            skill_hash.clone(),
            &[first, second],
            vec![skill_receipt(&skill_hash, &["artifact-1", "artifact-2"])],
            "host".into(),
            "1".into(),
            "2026-11-10T10:02:00Z".into(),
        )
        .unwrap();
        assert_eq!(provenance.status, SkillProvenanceStatus::Verified);
        provenance.refresh_status(&"e".repeat(64)).unwrap();
        assert_eq!(provenance.status, SkillProvenanceStatus::Revoked);
        assert_eq!(provenance.verified_hash.as_deref(), Some(skill_hash.as_str()));
        assert_eq!(
            provenance.observed_bundle_hash.as_deref(),
            Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
        );
        let mut candidate = candidate();
        candidate.artifact_id = "candidate".into();
        let candidate_hash = "d".repeat(64);
        assert!(SkillProvenance::verified(
            "build-skill".into(),
            candidate_hash.clone(),
            &[candidate],
            vec![skill_receipt(&candidate_hash, &["candidate"])],
            "host".into(),
            "1".into(),
            "2026-11-10T10:02:00Z".into(),
        )
        .is_err());
    }
}
