//! Durable compensation for artifact publication after native Run reconciliation.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{ensure, Context, Result};
use morrow_agent_core::{
    agent::{self, InterruptedRun, ToolCallSettlement},
    artifact_provenance::{ArtifactStatus, ToolArtifact},
    rpi_agent::AgentMessage,
    rpi_ai::Content,
    session_journal::{self, Journal},
    RunRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{auto_artifacts, storage, ResumeReceipt, ResumeReview, Settlement};

const MAX_PLANS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Coverage {
    FullRun {
        raw_start: usize,
    },
    /// Older admissions did not persist their Run boundary. Only the original
    /// inspected open calls can be attributed to this Run with certainty.
    ReconciledCalls {
        raw_start: usize,
    },
    /// Native Hosts historically allowed an empty Session key. Reconciliation
    /// remains available, but ToolArtifacts cannot claim an absent identity.
    UnavailableSession {
        raw_start: usize,
    },
}

impl Coverage {
    fn raw_start(&self) -> usize {
        match *self {
            Self::FullRun { raw_start }
            | Self::ReconciledCalls { raw_start }
            | Self::UnavailableSession { raw_start } => raw_start,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CallLocation {
    call_id: String,
    call_raw_index: usize,
    result_raw_index: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedReconciliation {
    evidence_dir: PathBuf,
    resume_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecoveryPlan {
    version: u32,
    task_id: String,
    session_id: String,
    session_path: PathBuf,
    cwd: PathBuf,
    original_evidence_dir: PathBuf,
    target_evidence_dir: PathBuf,
    run_number: usize,
    admission_sha256: String,
    inspected: InterruptedRun,
    coverage: Coverage,
    calls: Vec<CallLocation>,
    source_proof: String,
    receipt: ResumeReceipt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_reconciliation: Option<SavedReconciliation>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Completion {
    version: u32,
    plan_sha256: String,
    raw_end: usize,
    raw_proof: String,
    artifact_ids: Vec<String>,
    coverage: Coverage,
}

impl RecoveryPlan {
    fn marker(&self) -> PathBuf {
        self.target_evidence_dir.join(format!("recovered-run-{}-artifacts.json", self.run_number))
    }

    fn raw_end(&self) -> Result<usize> {
        self.inspected.raw_count.checked_add(self.calls.len()).context("recovery result range overflow")
    }

    fn completion(&self, journal: &Journal, artifacts: &[ToolArtifact]) -> Result<Completion> {
        Ok(Completion {
            version: 1,
            plan_sha256: storage::hash(&serde_json::to_vec(self)?),
            raw_end: self.raw_end()?,
            raw_proof: journal.proof(self.coverage.raw_start(), self.raw_end()?)?,
            artifact_ids: artifacts.iter().map(|artifact| artifact.artifact_id.clone()).collect(),
            coverage: self.coverage.clone(),
        })
    }
}

/// Prepare without changing the native Session or any existing evidence. The
/// caller persists these plans in resume.json before publishing its new fence.
pub(crate) fn prepare(review: &ResumeReview, next: &RunRequest, receipt: &ResumeReceipt) -> Result<Vec<RecoveryPlan>> {
    let prior_path = review.fenced_evidence_dir.join("resume.json");
    let prior_record: Option<Value> =
        if prior_path.is_file() { Some(serde_json::from_slice(&fs::read(&prior_path)?)?) } else { None };
    let prior: Vec<RecoveryPlan> = match prior_record.as_ref().and_then(|record| record.get("artifact_recovery")) {
        None => Vec::new(),
        Some(value) => serde_json::from_value(value.clone()).context("invalid saved artifact recovery plans")?,
    };
    ensure!(prior.len() <= MAX_PLANS, "too many saved artifact recovery plans");
    let mut plans = Vec::new();
    let mut seen = HashSet::new();
    let mut covered_current = false;
    for plan in prior {
        ensure!(
            plan.task_id == review.task_id
                && plan.session_id == next.session_key
                && plan.session_path == next.state_path
                && plan.cwd == next.cwd,
            "saved artifact recovery authority mismatch"
        );
        ensure!(seen.insert(plan.inspected.run_id.clone()), "duplicate artifact recovery Run");
        check_chain(&review.fenced_evidence_dir, &plan)?;
        validate_plan(&plan)?;
        let same_pending = review.interrupted_run.as_ref().is_some_and(|run| run.run_id == plan.inspected.run_id);
        if plan.marker().exists() {
            check_completed(&plan)?;
            ensure!(!same_pending, "completed recovery Run is still pending");
            continue;
        }
        if same_pending {
            ensure!(review.interrupted_run.as_ref() == Some(&plan.inspected), "pending recovery Run changed");
            ensure!(receipt.tool_calls == plan.receipt.tool_calls, "Host settlement conflicts with saved recovery");
            covered_current = true;
        } else if review.interrupted_run.is_some() {
            // A later native Run may coexist only with fully published old
            // artifacts. Recreate the missing completion marker after takeover.
            let (_, artifacts) = settled_artifacts(&plan)?;
            check_existing(&plan, &artifacts)?;
        }
        plans.push(plan);
    }
    if let Some(inspected) = review.interrupted_run.as_ref().filter(|_| !covered_current) {
        plans.push(prepare_plan(review, next, receipt, inspected, None)?);
    }
    if let Some(record) =
        prior_record.filter(|record| record.get("artifact_recovery").is_none() && review.interrupted_run.is_none())
    {
        if let Some(inspected) = serde_json::from_value::<Option<InterruptedRun>>(record["interrupted_run"].clone())? {
            let original_receipt: ResumeReceipt = serde_json::from_value(record["receipt"].clone())?;
            ensure!(
                record["version"] == 1 && record["kind"] == "fenced_task_resume",
                "unknown historical resume format"
            );
            ensure!(
                original_receipt.committed
                    && original_receipt.settlement == Settlement::Settled
                    && !original_receipt.evidence.is_empty()
                    && original_receipt.tool_calls.len() == inspected.open_tool_calls.len(),
                "historical reconciliation is not fully settled"
            );
            let mut historical_review = review.clone();
            historical_review.consumed_runs =
                usize::try_from(record["consumed_runs"].as_u64().context("old resume Run count missing")?)?;
            historical_review.fenced_evidence_dir =
                PathBuf::from(record["fenced_evidence_dir"].as_str().context("old resume parent missing")?);
            let source = SavedReconciliation {
                evidence_dir: review.fenced_evidence_dir.clone(),
                resume_sha256: storage::file_hash(&prior_path)?,
            };
            let plan = prepare_plan(&historical_review, next, &original_receipt, &inspected, Some(source))?;
            // The old record can describe a completed reconciliation even
            // though the native pending marker has already been cleared.
            settled_artifacts(&plan)?;
            plans.push(plan);
        }
    }
    ensure!(plans.len() <= MAX_PLANS, "too many pending artifact recovery plans");
    Ok(plans)
}

fn prepare_plan(
    review: &ResumeReview,
    next: &RunRequest,
    receipt: &ResumeReceipt,
    inspected: &InterruptedRun,
    previous_reconciliation: Option<SavedReconciliation>,
) -> Result<RecoveryPlan> {
    let mut original = review.fenced_evidence_dir.canonicalize()?;
    let mut visited = HashSet::new();
    let admission_path = loop {
        ensure!(visited.insert(original.clone()) && visited.len() <= MAX_PLANS, "invalid resume evidence chain");
        let admission = original.join(format!("run-{}-admission.json", review.consumed_runs));
        if admission.is_file() {
            break admission;
        }
        let parent: Value = serde_json::from_slice(&fs::read(original.join("resume.json"))?)?;
        original = PathBuf::from(parent["fenced_evidence_dir"].as_str().context("resume evidence parent missing")?)
            .canonicalize()?;
    };
    let admission: Value = serde_json::from_slice(&fs::read(&admission_path)?)?;
    ensure!(
        admission["task_id"] == review.task_id
            && admission["run_id"] == inspected.run_id
            && admission["run_number"] == review.consumed_runs
            && admission["session_path"] == serde_json::to_value(&next.state_path)?,
        "original Run admission mismatch"
    );
    let journal = Journal::for_session(&next.state_path);
    let mut call_index = inspected.raw_count;
    if !inspected.open_tool_calls.is_empty() {
        let mut found = false;
        for index in (0..inspected.raw_count).rev() {
            let messages = journal.read(index, index + 1, 8 * 1024 * 1024)?;
            if matches!(messages.first(), Some(AgentMessage::Assistant(_))) {
                call_index = index;
                found = true;
                break;
            }
        }
        ensure!(found, "interrupted tool calls have no Assistant source");
    }
    let coverage = match (admission.get("raw_start"), admission.get("session_id")) {
        (None, None) => Coverage::ReconciledCalls { raw_start: call_index },
        (Some(start), Some(session)) => {
            ensure!(session == &json!(next.session_key), "original Run Session mismatch");
            let raw_start = usize::try_from(start.as_u64().context("original raw_start invalid")?)?;
            ensure!(raw_start <= call_index, "original Run range excludes open calls");
            Coverage::FullRun { raw_start }
        }
        _ => anyhow::bail!("incomplete original Run range metadata"),
    };
    let coverage = if next.session_key.is_empty() {
        Coverage::UnavailableSession { raw_start: coverage.raw_start() }
    } else {
        coverage
    };
    journal.verify_range(coverage.raw_start(), inspected.raw_count)?;
    let calls = inspected
        .open_tool_calls
        .iter()
        .enumerate()
        .map(|(index, call)| {
            Ok(CallLocation {
                call_id: call.id.clone(),
                call_raw_index: call_index,
                result_raw_index: inspected.raw_count.checked_add(index).context("recovery result index overflow")?,
            })
        })
        .collect::<Result<_>>()?;
    Ok(RecoveryPlan {
        version: 1,
        task_id: review.task_id.clone(),
        session_id: next.session_key.clone(),
        session_path: next.state_path.clone(),
        cwd: next.cwd.clone(),
        original_evidence_dir: original,
        target_evidence_dir: review.resume_evidence_dir.clone(),
        run_number: review.consumed_runs,
        admission_sha256: storage::file_hash(&admission_path)?,
        inspected: inspected.clone(),
        source_proof: journal.proof(coverage.raw_start(), inspected.raw_count)?,
        coverage,
        calls,
        receipt: receipt.clone(),
        previous_reconciliation,
    })
}

/// Caller holds the Harness Session lock throughout takeover and recovery.
/// All effects here are durable reconciliation and evidence publication.
pub(crate) fn recover(plans: &[RecoveryPlan]) -> Result<()> {
    for plan in plans {
        validate_plan(plan)?;
        if plan.marker().exists() {
            check_completed(plan)?;
            continue;
        }
        if let Some(pending) = agent::interrupted_run(&plan.session_path, &plan.cwd)? {
            if pending.run_id == plan.inspected.run_id {
                ensure!(pending == plan.inspected, "interrupted recovery Run changed");
                agent::reconcile_interrupted_run(
                    &plan.session_path,
                    &plan.cwd,
                    &plan.inspected,
                    &plan.receipt.tool_calls,
                    &plan.receipt.evidence,
                )?;
            } else {
                // Repeating a fully persisted earlier batch is allowed while
                // its successor is pending. No missing earlier row is invented.
                let (_, artifacts) = settled_artifacts(plan)?;
                check_existing(plan, &artifacts)?;
            }
        }
        let (journal, artifacts) = settled_artifacts(plan)?;
        let existing = crate::read_tool_artifacts(&plan.target_evidence_dir)?;
        for artifact in &artifacts {
            match existing.iter().find(|record| record.artifact_id == artifact.artifact_id) {
                Some(record) => same_source(artifact, record)?,
                None => crate::append_tool_artifact(&plan.target_evidence_dir, artifact)?,
            }
        }
        check_existing(plan, &artifacts)?;
        let completion = plan.completion(&journal, &artifacts)?;
        session_journal::atomic_write(&plan.marker(), &serde_json::to_vec(&completion)?)?;
    }
    Ok(())
}

fn validate_plan(plan: &RecoveryPlan) -> Result<()> {
    ensure!(plan.version == 1 && plan.run_number > 0, "invalid artifact recovery plan");
    ensure!(
        plan.session_id.is_empty() == matches!(plan.coverage, Coverage::UnavailableSession { .. }),
        "recovery coverage does not match Session identity availability"
    );
    ensure!(
        plan.original_evidence_dir.canonicalize()? == plan.original_evidence_dir
            && plan.target_evidence_dir.canonicalize()? == plan.target_evidence_dir,
        "recovery evidence path changed"
    );
    check_chain(&plan.target_evidence_dir, plan)?;
    let original_task: Value = serde_json::from_slice(&fs::read(plan.original_evidence_dir.join("task.json"))?)?;
    let mut target_task: Value = serde_json::from_slice(&fs::read(plan.target_evidence_dir.join("task.json"))?)?;
    target_task["evidence_dir"] = original_task["evidence_dir"].clone();
    ensure!(original_task == target_task && original_task["task_id"] == plan.task_id, "recovery Task changed");
    let target_resume: Value = serde_json::from_slice(&fs::read(plan.target_evidence_dir.join("resume.json"))?)?;
    let expected_plan = serde_json::to_value(plan)?;
    ensure!(
        target_resume["artifact_recovery"].as_array().is_some_and(|plans| plans.contains(&expected_plan)),
        "recovery plan differs from first takeover"
    );
    let reconciliation = if let Some(source) = &plan.previous_reconciliation {
        let path = source.evidence_dir.join("resume.json");
        ensure!(storage::file_hash(&path)? == source.resume_sha256, "old reconciliation record changed");
        let record: Value = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(record["version"] == 1 && record["kind"] == "fenced_task_resume", "unknown historical resume format");
        ensure!(record.get("artifact_recovery").is_none(), "historical reconciliation already had recovery plans");
        let mut source_task: Value = serde_json::from_slice(&fs::read(source.evidence_dir.join("task.json"))?)?;
        source_task["evidence_dir"] = original_task["evidence_dir"].clone();
        ensure!(source_task == original_task, "historical reconciliation Task changed");
        ensure!(
            record["fence"]["task_id"] == plan.task_id
                && record["fence"]["session_path"] == serde_json::to_value(&plan.session_path)?,
            "historical reconciliation authority mismatch"
        );
        record
    } else {
        target_resume
    };
    ensure!(
        reconciliation["receipt"] == serde_json::to_value(&plan.receipt)?
            && reconciliation["interrupted_run"] == serde_json::to_value(&plan.inspected)?
            && reconciliation["consumed_runs"] == plan.run_number,
        "recovery plan differs from original reconciliation"
    );
    let admission_path = plan.original_evidence_dir.join(format!("run-{}-admission.json", plan.run_number));
    ensure!(storage::file_hash(&admission_path)? == plan.admission_sha256, "original admission changed");
    let admission: Value = serde_json::from_slice(&fs::read(admission_path)?)?;
    ensure!(
        admission["task_id"] == plan.task_id
            && admission["run_id"] == plan.inspected.run_id
            && admission["session_path"] == serde_json::to_value(&plan.session_path)?,
        "recovery admission authority mismatch"
    );
    ensure!(
        plan.receipt.committed && plan.receipt.settlement == Settlement::Settled && !plan.receipt.evidence.is_empty(),
        "recovery receipt is not settled"
    );
    ensure!(
        plan.calls.len() == plan.inspected.open_tool_calls.len() && plan.calls.len() == plan.receipt.tool_calls.len(),
        "recovery call count mismatch"
    );
    let journal = Journal::for_session(&plan.session_path);
    journal.verify_range(plan.coverage.raw_start(), plan.inspected.raw_count)?;
    ensure!(
        journal.proof(plan.coverage.raw_start(), plan.inspected.raw_count)? == plan.source_proof,
        "original recovery source changed"
    );
    for (index, ((location, call), receipt)) in
        plan.calls.iter().zip(&plan.inspected.open_tool_calls).zip(&plan.receipt.tool_calls).enumerate()
    {
        ensure!(
            location.call_id == call.id
                && receipt.call_id == call.id
                && location.call_raw_index >= plan.coverage.raw_start()
                && location.call_raw_index < plan.inspected.raw_count
                && location.result_raw_index == plan.inspected.raw_count + index,
            "recovery call location mismatch"
        );
        let messages = journal.read(location.call_raw_index, location.call_raw_index + 1, 8 * 1024 * 1024)?;
        let Some(AgentMessage::Assistant(assistant)) = messages.first() else {
            anyhow::bail!("recovery call source is not Assistant")
        };
        let matches: Vec<_> = assistant
            .content
            .iter()
            .filter_map(|content| match content {
                Content::ToolCall(native) if native.id == call.id => Some(native),
                _ => None,
            })
            .collect();
        ensure!(
            matches.len() == 1 && matches[0].name == call.name && matches[0].arguments == call.arguments,
            "original recovery call changed"
        );
    }
    Ok(())
}

fn check_chain(current: &Path, plan: &RecoveryPlan) -> Result<()> {
    let mut directory = current.canonicalize()?;
    let mut visited = HashSet::new();
    let mut found_target = false;
    let mut found_reconciliation = plan.previous_reconciliation.is_none();
    loop {
        ensure!(visited.insert(directory.clone()) && visited.len() <= MAX_PLANS, "invalid recovery evidence chain");
        found_target |= directory == plan.target_evidence_dir;
        found_reconciliation |=
            plan.previous_reconciliation.as_ref().is_some_and(|source| directory == source.evidence_dir);
        if directory == plan.original_evidence_dir {
            ensure!(found_target, "recovery target is outside the Session resume chain");
            ensure!(found_reconciliation, "historical reconciliation is outside the Session resume chain");
            return Ok(());
        }
        let record: Value = serde_json::from_slice(&fs::read(directory.join("resume.json"))?)?;
        ensure!(
            record["fence"]["task_id"] == plan.task_id
                && record["fence"]["session_path"] == serde_json::to_value(&plan.session_path)?,
            "recovery chain authority mismatch"
        );
        directory = PathBuf::from(record["fenced_evidence_dir"].as_str().context("recovery chain parent missing")?)
            .canonicalize()?;
    }
}

fn settled_artifacts(plan: &RecoveryPlan) -> Result<(Journal, Vec<ToolArtifact>)> {
    let journal = Journal::for_session(&plan.session_path);
    ensure!(journal.contains_run(&plan.inspected.run_id)?, "original recovery Run is not durably complete");
    let raw_end = plan.raw_end()?;
    journal.verify_range(plan.coverage.raw_start(), raw_end)?;
    ensure!(
        journal.proof(plan.coverage.raw_start(), plan.inspected.raw_count)? == plan.source_proof,
        "original recovery prefix changed"
    );
    for ((location, call), receipt) in
        plan.calls.iter().zip(&plan.inspected.open_tool_calls).zip(&plan.receipt.tool_calls)
    {
        let messages = journal.read(location.result_raw_index, location.result_raw_index + 1, 8 * 1024 * 1024)?;
        let Some(AgentMessage::ToolResult(result)) = messages.first() else { anyhow::bail!("recovery result missing") };
        let (is_error, text) = match &receipt.settlement {
            ToolCallSettlement::NotExecuted => {
                (true, "Host reconciliation: this call was interrupted and did not execute.".to_owned())
            }
            ToolCallSettlement::Completed { output } => {
                (false, format!("Host reconciliation of an interrupted call (completed):\n{output}"))
            }
            ToolCallSettlement::Failed { output } => {
                (true, format!("Host reconciliation of an interrupted call (failed):\n{output}"))
            }
        };
        let expected_details = json!({"source":"host_reconciled_interrupted_run","run_id":plan.inspected.run_id,
            "settlement":receipt.settlement,"evidence":plan.receipt.evidence});
        ensure!(
            result.tool_call_id == call.id
                && result.tool_name == call.name
                && result.is_error == is_error
                && result.details.as_ref() == Some(&expected_details),
            "recovery result settlement mismatch"
        );
        let [Content::Text(actual)] = result.content.as_slice() else {
            anyhow::bail!("recovery result content mismatch")
        };
        ensure!(
            actual.text == morrow_agent_core::local_tools::bounded(text, 128 * 1024),
            "recovery result output mismatch"
        );
    }
    if matches!(plan.coverage, Coverage::UnavailableSession { .. }) {
        return Ok((journal, Vec::new()));
    }
    let mut artifacts = auto_artifacts::derive_range(
        &journal,
        &plan.task_id,
        &plan.session_id,
        &plan.inspected.run_id,
        plan.coverage.raw_start(),
        raw_end,
        false,
    )?;
    if matches!(plan.coverage, Coverage::ReconciledCalls { .. }) {
        artifacts.retain(|artifact| plan.calls.iter().any(|call| call.call_id == artifact.native_call_id));
    }
    Ok((journal, artifacts))
}

fn same_source(candidate: &ToolArtifact, existing: &ToolArtifact) -> Result<()> {
    let mut expected = candidate.clone();
    if candidate.status == ArtifactStatus::Candidate {
        ensure!(
            matches!(existing.status, ArtifactStatus::Candidate | ArtifactStatus::Verified | ArtifactStatus::Revoked),
            "recovery artifact status conflicts"
        );
        expected.status = existing.status;
        expected.host_receipt = existing.host_receipt.clone();
    }
    ensure!(expected == *existing, "recovery artifact immutable source changed");
    Ok(())
}

fn check_existing(plan: &RecoveryPlan, artifacts: &[ToolArtifact]) -> Result<()> {
    let existing = crate::read_tool_artifacts(&plan.target_evidence_dir)?;
    for artifact in artifacts {
        let stored = existing
            .iter()
            .find(|record| record.artifact_id == artifact.artifact_id)
            .context("recovery artifact publication incomplete")?;
        same_source(artifact, stored)?;
    }
    Ok(())
}

fn check_completed(plan: &RecoveryPlan) -> Result<()> {
    let (journal, artifacts) = settled_artifacts(plan)?;
    check_existing(plan, &artifacts)?;
    let completion: Completion = serde_json::from_slice(&fs::read(plan.marker())?)?;
    ensure!(completion == plan.completion(&journal, &artifacts)?, "recovery completion marker changed");
    Ok(())
}

#[cfg(test)]
#[path = "recovery_artifacts_tests.rs"]
mod tests;
