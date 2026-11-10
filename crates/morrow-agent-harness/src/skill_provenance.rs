//! Join native Skill verification with Host-reviewed source artifacts.

use std::path::Path;

use anyhow::{ensure, Context, Result};
use morrow_agent_core::{
    artifact_provenance::{SkillLibraryBinding, SkillProvenance, SkillProvenanceStatus, SkillValidationReceipt},
    environment_library::Roots,
    rpi_agent::AgentMessage,
    rpi_ai::Content,
    session_journal::Journal,
    skill_library,
};
use serde_json::Value;

use crate::{auto_artifacts, provenance, storage, ReviewBasis};

/// Filters always name the authority whose records are being queried.
#[derive(Clone, Debug)]
pub struct SkillProvenanceQuery<'a> {
    pub task_id: &'a str,
    pub session_id: &'a str,
    pub skill_name: Option<&'a str>,
    pub bundle_hash: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub source_artifact_id: Option<&'a str>,
    pub library_scope: Option<&'a str>,
    pub bundle_id: Option<&'a str>,
}

impl SkillProvenanceQuery<'_> {
    fn matches(&self, record: &SkillProvenance) -> bool {
        record.task_id == self.task_id
            && record.session_id == self.session_id
            && self.skill_name.is_none_or(|value| record.skill_name == value)
            && self.bundle_hash.is_none_or(|value| record.bundle_hash == value)
            && self.run_id.is_none_or(|value| record.run_id == value)
            && self.source_artifact_id.is_none_or(|value| record.source_artifact_ids.iter().any(|id| id == value))
            && self
                .library_scope
                .is_none_or(|value| record.library_binding.as_ref().is_some_and(|binding| binding.scope == value))
            && self
                .bundle_id
                .is_none_or(|value| record.library_binding.as_ref().is_some_and(|binding| binding.bundle_id == value))
    }

    fn validate(&self) -> Result<()> {
        ensure!(!self.task_id.is_empty() && !self.session_id.is_empty(), "Skill query requires Task and Session");
        Ok(())
    }
}

/// Read the latest historical state, including legal revocations. This does
/// not establish current bundle availability or current source validity.
pub fn query_skill_provenance(evidence_dir: &Path, query: &SkillProvenanceQuery<'_>) -> Result<Vec<SkillProvenance>> {
    query.validate()?;
    let (records, _) = provenance::skill_snapshot(evidence_dir)?;
    Ok(records.into_iter().filter(|record| query.matches(record)).collect())
}

/// Resolve currently usable verification in one library scope. Selected
/// revoked, replaced, legacy-unbound or invalid-source records are refused.
pub fn verified_skill_provenance(
    evidence_dir: &Path,
    roots: &Roots,
    scope: &str,
    query: &SkillProvenanceQuery<'_>,
) -> Result<Vec<SkillProvenance>> {
    query.validate()?;
    ensure!(matches!(scope, "project" | "global"), "invalid Skill library scope");
    let (records, artifacts) = provenance::skill_snapshot(evidence_dir)?;
    let selected: Vec<_> = records
        .into_iter()
        .filter(|record| {
            query.matches(record) && record.library_binding.as_ref().is_none_or(|binding| binding.scope == scope)
        })
        .collect();
    for record in &selected {
        ensure!(record.status == SkillProvenanceStatus::Verified, "Skill provenance is revoked");
        let binding = record.library_binding.as_ref().context("Skill provenance has no library binding")?;
        ensure!(binding.scope == scope, "Skill library scope mismatch");
        let current = skill_library::read_verification(roots, scope, &record.skill_name)?;
        ensure!(binding.bundle_id == current.bundle_id, "owned Skill bundle was replaced");
        ensure!(record.bundle_hash == current.bundle_hash, "Skill bundle content changed");
        ensure!(current.verified_hash.as_deref() == Some(record.bundle_hash.as_str()), "Skill hash is unverified");
        ensure!(current.verified_run.as_deref() == Some(record.run_id.as_str()), "Skill verification Run changed");
        provenance::validate_sources(record, &artifacts)?;
        let evidence = current.evidence.as_ref().context("Skill native verification evidence is missing")?;
        ensure!(
            storage::hash(&serde_json::to_vec(evidence)?) == binding.native_evidence_sha256,
            "Skill native evidence changed"
        );
        ensure!(evidence.source == "native_current_run" && evidence.run == record.run_id, "Skill evidence Run changed");
        let source_calls: Vec<_> = record
            .source_artifact_ids
            .iter()
            .map(|id| {
                artifacts
                    .iter()
                    .find(|artifact| artifact.artifact_id == *id)
                    .map(|artifact| artifact.native_call_id.as_str())
                    .context("Skill source artifact is missing")
            })
            .collect::<Result<_>>()?;
        ensure!(
            source_calls == evidence.receipts.iter().map(|receipt| receipt.tool_call_id.as_str()).collect::<Vec<_>>(),
            "Skill native evidence changed"
        );
    }
    Ok(selected)
}

/// Register Host validation of a real successful `skill_verify` call. Native
/// execution metadata is checked against Journal bytes before Host provenance
/// is persisted. The Host supplies the business validation receipts.
pub fn record_skill_verification(
    evidence_dir: &Path,
    basis: &ReviewBasis,
    roots: &Roots,
    scope: &str,
    name: &str,
    skill_verify_call_id: &str,
    validation_receipts: Vec<SkillValidationReceipt>,
) -> Result<SkillProvenance> {
    ensure!(
        basis.events_path.parent().context("Skill review evidence parent missing")?.canonicalize()?
            == evidence_dir.canonicalize()?,
        "Skill review evidence directory mismatch"
    );
    let journal = Journal::for_session(&basis.session_path);
    check_basis(&journal, basis)?;
    let current = skill_library::read_verification(roots, scope, name)?;
    ensure!(current.verified_hash.as_deref() == Some(current.bundle_hash.as_str()), "Skill bundle is unverified");
    ensure!(
        current.verified_run.as_deref() == Some(basis.run_id.as_str()),
        "Skill verification belongs to another Run"
    );
    let evidence = current.evidence.as_ref().context("Skill verification evidence missing")?;
    let ids: Vec<_> = evidence.receipts.iter().map(|receipt| receipt.tool_call_id.clone()).collect();
    let messages = journal.read(basis.raw_start, basis.raw_end, 64 * 1024 * 1024)?;
    let mut verified_call = None;
    let mut result_found = false;
    for (index, message) in messages.iter().enumerate() {
        match message {
            AgentMessage::Assistant(assistant) => {
                for content in &assistant.content {
                    let Content::ToolCall(call) = content else { continue };
                    if call.id != skill_verify_call_id {
                        continue;
                    }
                    ensure!(verified_call.is_none(), "duplicate Skill verification call");
                    ensure!(call.name == "skill_verify", "selected native call is not skill_verify");
                    ensure!(
                        call.arguments["scope"] == scope
                            && call.arguments["name"] == name
                            && call.arguments["expected_hash"] == current.bundle_hash
                            && call.arguments["evidence_ids"] == serde_json::to_value(&ids)?,
                        "Skill verification call arguments mismatch"
                    );
                    verified_call = Some(index);
                }
            }
            AgentMessage::ToolResult(result) if result.tool_call_id == skill_verify_call_id => {
                ensure!(verified_call.is_some() && !result_found, "Skill verification result has no unique prior call");
                ensure!(result.tool_name == "skill_verify" && !result.is_error, "Skill verification tool failed");
                // Include earlier results of calls in the same assistant turn.
                // Text receipt hashes and typed ToolResult hashes have separate contracts.
                let native = morrow_agent_core::experience::library_evidence(&basis.run_id, &ids, &messages[..index])?;
                let stored = serde_json::to_value(evidence)?;
                ensure!(
                    native["source"] == stored["source"]
                        && native["run"] == stored["run"]
                        && native["receipts"] == stored["receipts"],
                    "Skill metadata does not match native execution receipts"
                );
                ensure!(
                    evidence.receipts.iter().any(|receipt| matches!(receipt.tool_name.as_str(), "exec" | "run_script")),
                    "Skill verification needs native execution evidence"
                );
                ensure!(
                    !result.details.as_ref().is_some_and(morrow_agent_core::effect_status::reports_unknown),
                    "Skill verification effects are unknown"
                );
                let [Content::Text(text)] = result.content.as_slice() else {
                    anyhow::bail!("Skill verification result is not a single text record");
                };
                let output: Value = serde_json::from_str(&text.text)?;
                ensure!(
                    output["name"] == name
                        && output["content_hash"] == current.bundle_hash
                        && output["status"] == "execution_evidence_attached",
                    "Skill verification result mismatch"
                );
                result_found = true;
            }
            _ => {}
        }
    }
    ensure!(result_found, "successful native Skill verification is missing");
    let derived = auto_artifacts::derive_range(
        &journal,
        &basis.task_id,
        &basis.session_id,
        &basis.run_id,
        basis.raw_start,
        basis.raw_end,
        false,
    )?;
    let stored = crate::read_tool_artifacts(evidence_dir)?;
    let mut sources = Vec::with_capacity(ids.len());
    for id in &ids {
        let candidate = derived
            .iter()
            .find(|artifact| artifact.native_call_id == *id)
            .context("Skill native source artifact missing")?;
        let artifact = stored
            .iter()
            .find(|artifact| artifact.artifact_id == candidate.artifact_id)
            .context("Skill source has no persisted Host artifact")?;
        let mut expected = candidate.clone();
        expected.status = artifact.status;
        expected.host_receipt = artifact.host_receipt.clone();
        ensure!(expected == *artifact, "Skill source artifact differs from Journal");
        sources.push(artifact.clone());
    }
    let receipt = validation_receipts.first().context("Skill Host validation receipt missing")?;
    let verifier = receipt.verifier.clone();
    let verifier_version = receipt.verifier_version.clone();
    let verified_at = receipt.verified_at.clone();
    let mut record = SkillProvenance::verified(
        name.to_owned(),
        current.bundle_hash.clone(),
        &sources,
        validation_receipts,
        verifier,
        verifier_version,
        verified_at,
    )?;
    record.library_binding = Some(SkillLibraryBinding {
        scope: scope.to_owned(),
        bundle_id: current.bundle_id.clone(),
        skill_verify_call_id: skill_verify_call_id.to_owned(),
        native_evidence_sha256: storage::hash(&serde_json::to_vec(evidence)?),
    });
    check_basis(&journal, basis)?;
    ensure!(
        serde_json::to_value(skill_library::read_verification(roots, scope, name)?)? == serde_json::to_value(current)?,
        "Skill bundle or verification changed during registration"
    );
    crate::append_skill_provenance(evidence_dir, &record)?;
    Ok(record)
}

fn check_basis(journal: &Journal, basis: &ReviewBasis) -> Result<()> {
    ensure!(storage::file_hash(&basis.events_path)? == basis.events_sha256, "Skill review event bytes changed");
    ensure!(
        storage::hash(&serde_json::to_vec(&journal.open()?)?) == basis.journal_head_sha256,
        "Skill review journal head changed"
    );
    journal.verify_range(basis.raw_start, basis.raw_end)?;
    ensure!(journal.proof(basis.raw_start, basis.raw_end)? == basis.raw_proof, "Skill review journal source changed");
    Ok(())
}
