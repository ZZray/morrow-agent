//! Host-authorized historical queries over persisted provenance ledgers.

use std::{collections::HashMap, fs, io::Read, path::PathBuf};

use anyhow::{ensure, Context, Result};
use morrow_agent_core::artifact_provenance::{
    parse_provenance_time_ms, ArtifactStatus, SkillProvenance, SkillProvenanceStatus, ToolArtifact,
};
use serde::{Deserialize, Serialize};

use crate::{provenance, storage};

/// Each directory is an explicit Host grant for one Task and Session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceScope {
    pub task_id: String,
    pub session_id: String,
    pub evidence_dir: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceKind {
    Artifact,
    Skill,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceStatus {
    Candidate,
    Verified,
    Revoked,
    Unknown,
}

/// Filters narrow the supplied scopes. Times use [from, to) in Unix milliseconds.
/// Artifact IDs match artifacts and Skill source IDs. Skill names and bundle
/// hashes select Skill records. Host receipt IDs include Skill source bindings.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProvenanceQuery {
    pub task_id: Option<String>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub kind: Option<ProvenanceKind>,
    pub artifact_id: Option<String>,
    pub skill_name: Option<String>,
    pub bundle_hash: Option<String>,
    pub host_receipt_id: Option<String>,
    pub status: Option<ProvenanceStatus>,
    pub time_from_ms: Option<i64>,
    pub time_to_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "record", rename_all = "snake_case")]
pub enum ProvenanceRecord {
    Artifact(ToolArtifact),
    Skill(SkillProvenance),
}

/// Historical receipt bindings only. Current business files and Skill library
/// availability remain outside this query's evidence-directory grants.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceSourceState {
    Unverified,
    HostReceiptBound,
    SourcesRevoked,
}

/// Hash of the exact ledger bytes observed while holding its shared lock.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenanceFileReference {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenanceEntry {
    pub scope: EvidenceScope,
    pub record: ProvenanceRecord,
    pub source_state: ProvenanceSourceState,
    pub source_files: Vec<ProvenanceFileReference>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceScopeErrorKind {
    InvalidScope,
    Unavailable,
    Busy,
    InvalidLedger,
    IdentityMismatch,
    InvalidSource,
    InvalidTime,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenanceScopeError {
    pub scope: EvidenceScope,
    pub kind: ProvenanceScopeErrorKind,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenanceQueryReport {
    pub entries: Vec<ProvenanceEntry>,
    pub scope_errors: Vec<ProvenanceScopeError>,
}

impl ProvenanceQuery {
    fn matches_record(&self, record: &ProvenanceRecord) -> bool {
        let (run, status, selected) = match record {
            ProvenanceRecord::Artifact(artifact) => {
                let status = match artifact.status {
                    ArtifactStatus::Candidate => ProvenanceStatus::Candidate,
                    ArtifactStatus::Verified => ProvenanceStatus::Verified,
                    ArtifactStatus::Revoked => ProvenanceStatus::Revoked,
                    ArtifactStatus::Unknown => ProvenanceStatus::Unknown,
                };
                let selected = self.kind.is_none_or(|kind| kind == ProvenanceKind::Artifact)
                    && self.skill_name.is_none()
                    && self.bundle_hash.is_none()
                    && self.artifact_id.as_ref().is_none_or(|id| artifact.artifact_id == *id)
                    && self.host_receipt_id.as_ref().is_none_or(|id| {
                        artifact.host_receipt.as_ref().is_some_and(|receipt| receipt.receipt_id == *id)
                    });
                (&artifact.run_id, status, selected)
            }
            ProvenanceRecord::Skill(skill) => {
                let status = match skill.status {
                    SkillProvenanceStatus::Candidate => ProvenanceStatus::Candidate,
                    SkillProvenanceStatus::Verified => ProvenanceStatus::Verified,
                    SkillProvenanceStatus::Revoked => ProvenanceStatus::Revoked,
                };
                let selected = self.kind.is_none_or(|kind| kind == ProvenanceKind::Skill)
                    && self.skill_name.as_ref().is_none_or(|name| skill.skill_name == *name)
                    && self.bundle_hash.as_ref().is_none_or(|hash| skill.bundle_hash == *hash)
                    && self.artifact_id.as_ref().is_none_or(|id| skill.source_artifact_ids.contains(id))
                    && self.host_receipt_id.as_ref().is_none_or(|id| {
                        skill.validation_receipts.iter().any(|receipt| {
                            receipt.receipt_id == *id
                                || receipt.source_artifacts.iter().any(|source| source.host_receipt_id == *id)
                        })
                    });
                (&skill.run_id, status, selected)
            }
        };
        selected && self.run_id.as_ref().is_none_or(|id| run == id) && self.status.is_none_or(|value| status == value)
    }

    fn matches_time(&self, record: &ProvenanceRecord) -> Result<bool> {
        if self.time_from_ms.is_none() && self.time_to_ms.is_none() {
            return Ok(true);
        }
        let value = match record {
            ProvenanceRecord::Artifact(artifact) => artifact.created_at.as_str(),
            ProvenanceRecord::Skill(skill) => {
                skill.verified_at.as_deref().context("Skill verification time is absent")?
            }
        };
        let timestamp = parse_provenance_time_ms(value)?;
        Ok(self.time_from_ms.is_none_or(|from| timestamp >= from) && self.time_to_ms.is_none_or(|to| timestamp < to))
    }
}

fn skill_source_state(skill: &SkillProvenance, artifacts: &[ToolArtifact]) -> Result<ProvenanceSourceState> {
    let mut revoked = false;
    for id in &skill.source_artifact_ids {
        let artifact = artifacts
            .iter()
            .find(|artifact| artifact.artifact_id == *id)
            .context("Skill source artifact is missing")?;
        ensure!(
            artifact.task_id == skill.task_id
                && artifact.session_id == skill.session_id
                && artifact.run_id == skill.run_id,
            "Skill source identity mismatch"
        );
        ensure!(
            matches!(artifact.status, ArtifactStatus::Verified | ArtifactStatus::Revoked),
            "Skill source has no verified history"
        );
        let host = artifact.host_receipt.as_ref().context("Skill source Host receipt is missing")?;
        for receipt in &skill.validation_receipts {
            let binding = receipt
                .source_artifacts
                .iter()
                .find(|source| source.artifact_id == *id)
                .context("Skill source binding is missing")?;
            ensure!(
                host.receipt_id == binding.host_receipt_id
                    && artifact.input_sha256 == binding.input_sha256
                    && artifact.output_sha256 == binding.output_sha256,
                "Skill source receipt or content hash changed"
            );
        }
        revoked |= artifact.status == ArtifactStatus::Revoked;
    }
    Ok(if revoked { ProvenanceSourceState::SourcesRevoked } else { ProvenanceSourceState::HostReceiptBound })
}

fn query_scope(
    scope: &EvidenceScope,
    query: &ProvenanceQuery,
) -> std::result::Result<Vec<ProvenanceEntry>, ProvenanceScopeError> {
    let failure = |kind, message: String| ProvenanceScopeError { scope: scope.clone(), kind, message };
    let root = scope
        .evidence_dir
        .canonicalize()
        .map_err(|error| failure(ProvenanceScopeErrorKind::Unavailable, error.to_string()))?;
    if !root.is_dir() {
        return Err(failure(ProvenanceScopeErrorKind::Unavailable, "evidence directory is unavailable".into()));
    }
    let _guard = provenance::lock(&root, false).map_err(|error| {
        let busy = error.downcast_ref::<std::io::Error>().is_some_and(|source| {
            source.raw_os_error().is_some() && source.raw_os_error() == fs2::lock_contended_error().raw_os_error()
        });
        let kind = if busy { ProvenanceScopeErrorKind::Busy } else { ProvenanceScopeErrorKind::Unavailable };
        failure(kind, error.to_string())
    })?;
    let paths = [provenance::tool_artifacts_path(&root), provenance::skill_provenance_path(&root)];
    let mut references = [None, None];
    for (index, path) in paths.iter().enumerate() {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(failure(ProvenanceScopeErrorKind::Unavailable, error.to_string())),
        };
        let real =
            path.canonicalize().map_err(|error| failure(ProvenanceScopeErrorKind::Unavailable, error.to_string()))?;
        if !real.starts_with(&root) || !metadata.is_file() || metadata.len() > provenance::MAX_FILE_BYTES {
            return Err(failure(
                ProvenanceScopeErrorKind::InvalidLedger,
                "ledger escaped scope or exceeds its file bound".into(),
            ));
        }
        let bytes = (|| -> Result<Vec<u8>> {
            let mut bytes = Vec::new();
            fs::File::open(path)?.take(provenance::MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
            ensure!(bytes.len() as u64 <= provenance::MAX_FILE_BYTES, "provenance file exceeds byte limit");
            Ok(bytes)
        })()
        .map_err(|error| failure(ProvenanceScopeErrorKind::InvalidLedger, error.to_string()))?;
        references[index] = Some(ProvenanceFileReference { path: real, sha256: storage::hash(&bytes) });
    }
    let artifacts = provenance::read_tool_artifacts_unlocked(&root)
        .map_err(|error| failure(ProvenanceScopeErrorKind::InvalidLedger, error.to_string()))?;
    let skills = provenance::read_skill_provenance_unlocked(&root)
        .map_err(|error| failure(ProvenanceScopeErrorKind::InvalidLedger, error.to_string()))?;
    if artifacts.iter().any(|record| record.task_id != scope.task_id || record.session_id != scope.session_id)
        || skills.iter().any(|record| record.task_id != scope.task_id || record.session_id != scope.session_id)
    {
        return Err(failure(
            ProvenanceScopeErrorKind::IdentityMismatch,
            "ledger identity differs from its Host-authorized scope".into(),
        ));
    }
    let skills = skills
        .into_iter()
        .map(|skill| {
            let state = skill_source_state(&skill, &artifacts)
                .map_err(|error| failure(ProvenanceScopeErrorKind::InvalidSource, error.to_string()))?;
            Ok((ProvenanceRecord::Skill(skill), state))
        })
        .collect::<std::result::Result<Vec<_>, ProvenanceScopeError>>()?;
    let artifacts = artifacts.into_iter().map(|artifact| {
        let state = if artifact.host_receipt.is_some() {
            ProvenanceSourceState::HostReceiptBound
        } else {
            ProvenanceSourceState::Unverified
        };
        (ProvenanceRecord::Artifact(artifact), state)
    });
    let mut entries = Vec::new();
    for (record, source_state) in artifacts.chain(skills) {
        if !query.matches_record(&record) {
            continue;
        }
        if !query
            .matches_time(&record)
            .map_err(|error| failure(ProvenanceScopeErrorKind::InvalidTime, error.to_string()))?
        {
            continue;
        }
        let source_files = match &record {
            ProvenanceRecord::Artifact(_) => references[0].iter().cloned().collect(),
            ProvenanceRecord::Skill(_) => references.iter().flatten().cloned().collect(),
        };
        entries.push(ProvenanceEntry { scope: scope.clone(), record, source_state, source_files });
    }
    Ok(entries)
}

/// Query only the listed scopes. A failed scope contributes an explicit error;
/// independent scopes continue. No index or Task acceptance state is created.
pub fn query_provenance(scopes: &[EvidenceScope], query: &ProvenanceQuery) -> Result<ProvenanceQueryReport> {
    ensure!(
        query.time_from_ms.zip(query.time_to_ms).is_none_or(|(from, to)| from <= to),
        "provenance time range is reversed"
    );
    let mut report = ProvenanceQueryReport::default();
    let mut directories = HashMap::new();
    for scope in scopes {
        if query.task_id.as_ref().is_some_and(|id| scope.task_id != *id)
            || query.session_id.as_ref().is_some_and(|id| scope.session_id != *id)
        {
            continue;
        }
        if scope.task_id.trim().is_empty() || scope.session_id.trim().is_empty() || !scope.evidence_dir.is_absolute() {
            report.scope_errors.push(ProvenanceScopeError {
                scope: scope.clone(),
                kind: ProvenanceScopeErrorKind::InvalidScope,
                message: "scope requires Task, Session and an absolute directory".into(),
            });
            continue;
        }
        let directory = scope.evidence_dir.canonicalize().ok();
        let identity = (&scope.task_id, &scope.session_id);
        if let Some(directory) = &directory {
            if let Some(previous) = directories.get(directory) {
                if *previous != identity {
                    report.scope_errors.push(ProvenanceScopeError {
                        scope: scope.clone(),
                        kind: ProvenanceScopeErrorKind::IdentityMismatch,
                        message: "the same evidence directory was granted for conflicting Task or Session identities"
                            .into(),
                    });
                }
                continue;
            }
        }
        match query_scope(scope, query) {
            Ok(entries) => {
                if let Some(directory) = directory {
                    directories.insert(directory, identity);
                }
                report.entries.extend(entries);
            }
            Err(error) => report.scope_errors.push(error),
        }
    }
    Ok(report)
}
