//! Host-owned, no-model management helpers for the SpinMind integration.
//!
//! These functions reuse the Harness queue and the Core context/Skill stores.
//! They never create an Agent loop. Settled Task close releases a Session fence
//! after checking the Host declaration and original native evidence.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

use morrow_agent_core::{
    agent::{self, InterruptedRun},
    context_memory::{self, Store as ContextStore},
    environment_library::{self, Roots},
    session_journal::Journal,
    skill_library,
};

use crate::{orchestration::Store, storage};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryRoots {
    pub environment_dir: PathBuf,
    pub global_knowledge: PathBuf,
    pub project_knowledge: PathBuf,
    pub global_skills: PathBuf,
    pub project_skills: PathBuf,
}

impl From<Roots> for LibraryRoots {
    fn from(value: Roots) -> Self {
        Self {
            environment_dir: value.environment_dir,
            global_knowledge: value.global_knowledge,
            project_knowledge: value.project_knowledge,
            global_skills: value.global_skills,
            project_skills: value.project_skills,
        }
    }
}

pub fn resolve_roots(state_dir: &Path, cwd: &Path, global: Option<&Path>) -> Result<LibraryRoots> {
    Ok(environment_library::resolve(state_dir, cwd, global)?.into())
}

pub fn skill_catalog(roots: &LibraryRoots) -> Result<Value> {
    let roots = roots_from_public(roots);
    skill_library::management_catalog(&roots)
}

pub fn skill_catalog_page(roots: &LibraryRoots, offset: usize, limit: usize) -> Result<Value> {
    skill_library::management_catalog_page(&roots_from_public(roots), offset, limit)
}

pub fn goal_snapshot(session: &Path, cwd: &Path) -> Result<Value> {
    let session = storage::canonical(session)?;
    let cwd = storage::canonical(cwd)?;
    let _admission = storage::Admission::released(&session)?;
    Ok(serde_json::to_value(morrow_agent_core::agent::session_goal(&session, &cwd)?)?)
}

/// Observe native background ownership while a waiting Goal still has its Task fence.
pub fn job_snapshot(session: &Path, cwd: &Path, device: &str, session_id: &str, job_id: Option<&str>) -> Result<Value> {
    use morrow_agent_core::managed_jobs::{Manager, Owner, Policy};
    let session = storage::canonical(session)?;
    let cwd = storage::canonical(cwd)?;
    let goal = morrow_agent_core::agent::session_goal(&session, &cwd)?.context("Session has no Goal")?;
    let lease = goal.budget.as_ref().context("Goal has no Job lease")?.lease.clone();
    anyhow::ensure!(
        lease.goal_id == goal.id && lease.device == device && lease.session == session_id,
        "Job owner differs from Goal lease"
    );
    let manager = Manager::new(
        &session,
        &cwd,
        Policy {
            worker_executable: None,
            owner: Owner::new(&session, device, session_id)?,
            goal_id: goal.id.clone(),
            lease_expires_at: lease.expires_at,
            max_jobs: 8,
            max_log_bytes: 8 * 1024 * 1024,
            max_seconds: 3600,
        },
    )?;
    let mut jobs = Vec::new();
    for receipt in manager.inventory_for_goal()? {
        if job_id.is_some_and(|id| receipt.job_id != id) {
            continue;
        }
        let mut value = serde_json::to_value(receipt)?;
        value.as_object_mut().unwrap().remove("worker_nonce");
        jobs.push(value);
    }
    anyhow::ensure!(job_id.is_none() || !jobs.is_empty(), "Job is not in the current Goal owner scope");
    Ok(json!({"goal_id":goal.id,"goal_status":goal.status,"device":device,"session_id":session_id,"jobs":jobs}))
}

pub fn goal_control(
    session: &Path,
    cwd: &Path,
    goal_id: &str,
    command: &str,
    command_id: &str,
    expected_revision: Option<u64>,
    reviewed_run: &str,
) -> Result<Value> {
    let session = storage::canonical(session)?;
    let cwd = storage::canonical(cwd)?;
    let _admission = storage::Admission::released(&session)?;
    Ok(serde_json::to_value(morrow_agent_core::agent::control_goal(
        &session,
        &cwd,
        goal_id,
        command,
        command_id,
        expected_revision,
        reviewed_run,
    )?)?)
}

pub fn skill_operation(roots: &LibraryRoots, command_id: &str, operation: &str, args: Value) -> Result<Value> {
    skill_library::manage(&roots_from_public(roots), command_id, operation, args)
}

pub fn skill_verification(roots: &LibraryRoots, scope: &str, name: &str) -> Result<Value> {
    let roots = roots_from_public(roots);
    Ok(serde_json::to_value(skill_library::read_verification(&roots, scope, name)?)?)
}

pub fn context_snapshot(session: &Path, cwd: &Path) -> Result<Value> {
    let canonical_session = storage::canonical(session)?;
    let session = canonical_session.as_path();
    let cwd = cwd.canonicalize().context("working directory unavailable")?;
    morrow_agent_core::agent::session_goal(session, &cwd)?;
    let journal = Journal::for_session(session);
    let head = journal.open().context("session journal unavailable")?;
    let context_path = context_memory::path(session);
    let scope = context_memory::hash(session.to_string_lossy().as_bytes());
    let store = ContextStore::load_window(
        &context_path,
        scope,
        &journal.read(head.active_base, head.raw_count, morrow_agent_core::session_journal::CHECKPOINT_ACTIVE_BYTES)?,
        head.active_base,
        journal,
    )?;
    Ok(json!({
        "version": store.version,
        "scope": store.scope,
        "watermark": store.watermark,
        "references": store.references,
        "memories": store.memories,
        "summary": store.summary,
        "cwd": cwd,
    }))
}

/// Apply one of the Core's explicit management commands while holding the
/// Harness Session lock. The command is persisted through the same context
/// sidecar and journal-backed source checks used by the Agent.
pub fn context_command(session: &Path, cwd: &Path, command: &str, command_id: &str) -> Result<Value> {
    let canonical_session = storage::canonical(session)?;
    let session = canonical_session.as_path();
    let _admission = storage::Admission::released(session)?;
    let cwd = cwd.canonicalize().context("working directory unavailable")?;
    morrow_agent_core::agent::session_goal(session, &cwd)?;
    let journal = Journal::for_session(session);
    let head = journal.open().context("session journal unavailable")?;
    let raw =
        journal.read(head.active_base, head.raw_count, morrow_agent_core::session_journal::CHECKPOINT_ACTIVE_BYTES)?;
    let context_path = context_memory::path(session);
    let scope = context_memory::hash(session.to_string_lossy().as_bytes());
    let mut store = ContextStore::load_window(&context_path, scope, &raw, head.active_base, journal)?;
    let output = store.command(command, command_id, head.raw_count)?.context("unsupported context command")?;
    store.save(&context_path)?;
    Ok(json!({ "command_id": command_id, "output": output, "context": store }))
}

pub fn context_add_reference(session: &Path, cwd: &Path, kind: &str, text: String, command_id: &str) -> Result<Value> {
    let canonical_session = storage::canonical(session)?;
    let session = canonical_session.as_path();
    let _admission = storage::Admission::released(session)?;
    let cwd = cwd.canonicalize().context("working directory unavailable")?;
    morrow_agent_core::agent::session_goal(session, &cwd)?;
    let journal = Journal::for_session(session);
    let head = journal.open().context("session journal unavailable")?;
    let raw =
        journal.read(head.active_base, head.raw_count, morrow_agent_core::session_journal::CHECKPOINT_ACTIVE_BYTES)?;
    let context_path = context_memory::path(session);
    let scope = context_memory::hash(session.to_string_lossy().as_bytes());
    let mut store = ContextStore::load_window(&context_path, scope, &raw, head.active_base, journal)?;
    let reference_id = store.add_reference(kind, text, command_id)?;
    store.save(&context_path)?;
    Ok(json!({ "command_id": command_id, "reference_id": reference_id, "context": store }))
}

pub fn queue_snapshot(directory: &Path) -> Result<Value> {
    Ok(serde_json::to_value(Store::open(directory)?.snapshot()?)?)
}

pub fn queue_events(directory: &Path, after: u64) -> Result<Value> {
    Ok(serde_json::to_value(Store::open(directory)?.events_after(after)?)?)
}

pub fn queue_cancel(directory: &Path, assignment_id: &str, at_ms: u64) -> Result<()> {
    Store::open(directory)?.cancel(assignment_id, at_ms)
}

pub fn queue_watchdog(directory: &Path, at_ms: u64) -> Result<Value> {
    Ok(serde_json::to_value(Store::open(directory)?.watchdog(at_ms)?)?)
}

pub fn queue_enqueue(
    directory: &Path,
    trigger: crate::orchestration::Trigger,
    mandate: crate::orchestration::Mandate,
    assignment: crate::orchestration::AssignmentSpec,
    at_ms: u64,
) -> Result<Value> {
    let record = Store::open(directory)?.enqueue(trigger, mandate, assignment, at_ms)?;
    Ok(serde_json::to_value(record)?)
}

fn roots_from_public(value: &LibraryRoots) -> Roots {
    Roots {
        environment_dir: value.environment_dir.clone(),
        global_knowledge: value.global_knowledge.clone(),
        project_knowledge: value.project_knowledge.clone(),
        global_skills: value.global_skills.clone(),
        project_skills: value.project_skills.clone(),
    }
}

pub struct HeldSessionInspection {
    _lock: std::fs::File,
    pub snapshot: Value,
}

pub fn inspect_session_held(
    request: &morrow_agent_core::session_inspect::InspectionRequest,
) -> Result<HeldSessionInspection> {
    let canonical_session = storage::canonical(&request.session_path)?;
    let (lock, fence_path) = storage::lock_session(&canonical_session)?;
    let fence = if fence_path.exists() {
        let meta = std::fs::symlink_metadata(&fence_path)?;
        anyhow::ensure!(meta.file_type().is_file(), "Session fence is not a regular file");
        let bytes = std::fs::read(&fence_path)?;
        let record: Value = serde_json::from_slice(&bytes).context("Session fence is not readable JSON")?;
        Some(json!({
            "path": fence_path.canonicalize()?,
            "sha256": storage::hash(&bytes),
            "record": record,
        }))
    } else {
        None
    };
    let closing_candidate = closing_marker_path(&fence_path);
    let closing_marker = match std::fs::symlink_metadata(&closing_candidate) {
        Ok(meta) => {
            anyhow::ensure!(meta.file_type().is_file(), "Session closing marker is not a regular file");
            let bytes = std::fs::read(&closing_candidate)?;
            Some(json!({
                "path": closing_candidate.canonicalize()?,
                "sha256": storage::hash(&bytes),
            }))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.into()),
    };
    let mut canonical_req = request.clone();
    canonical_req.session_path = canonical_session;
    let mut inspection = morrow_agent_core::session_inspect::inspect_session_unlocked(&canonical_req)?;
    inspection["request"] = serde_json::to_value(request)?;
    Ok(HeldSessionInspection {
        _lock: lock,
        snapshot: json!({
            "version": 1,
            "fence": fence,
            "closing_marker": closing_marker,
            "inspection": inspection,
        }),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloseRef {
    pub path: std::path::PathBuf,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CloseRequestSpec {
    task: crate::TaskSpec,
    session_path: std::path::PathBuf,
    cwd: std::path::PathBuf,
    expected_fence_sha256: String,
    expected_authority_sha256: String,
    evidence_dir: std::path::PathBuf,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CloseExpectedSpec {
    fence: Value,
    fenced_outcome: crate::TaskOutcome,
    interrupted_run: Option<InterruptedRun>,
    consumed_runs: usize,
    consumed_calls: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettledTaskCloseDeclaration {
    kind: String,
    version: u32,
    request: CloseRequestSpec,
    expected: CloseExpectedSpec,
    receipt: crate::ResumeReceipt,
    evidence_refs: Vec<CloseRef>,
    session_inspection_ref: CloseRef,
}

fn closing_marker_path(fence_path: &Path) -> PathBuf {
    let mut os = fence_path.as_os_str().to_os_string();
    os.push(".closing.json");
    PathBuf::from(os)
}

fn regular_file_present(path: &Path, label: &str) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            anyhow::ensure!(meta.file_type().is_file(), "{label} must be a regular file, not a symlink or directory");
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

fn checked_close_file(reference: &CloseRef, max_bytes: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    anyhow::ensure!(reference.path.is_absolute(), "close reference path must be absolute");
    let meta = std::fs::symlink_metadata(&reference.path).context("close reference missing")?;
    anyhow::ensure!(
        meta.file_type().is_file() && meta.len() <= max_bytes,
        "close reference is not a bounded regular file"
    );
    let canonical = reference.path.canonicalize().context("close reference canonicalize failed")?;
    let file = std::fs::File::open(&canonical)?;
    anyhow::ensure!(file.metadata()?.is_file(), "opened close reference is not a regular file");
    let mut bytes = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!((bytes.len() as u64) <= max_bytes, "close reference grew beyond bound");
    anyhow::ensure!(storage::hash(&bytes) == reference.sha256, "close reference sha256 mismatch");
    Ok(bytes)
}

fn write_close_record(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("close record has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temporary, value)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary.persist_noclobber(path).context("publish complete close record")?;
    storage::sync_parent(path)
}

fn check_reconciled_close(journal: &Journal, inspected: &InterruptedRun, receipt: &crate::ResumeReceipt) -> Result<()> {
    let head = journal.open()?;
    let result_end =
        inspected.raw_count.checked_add(inspected.open_tool_calls.len()).context("close result range overflow")?;
    let saved = json!({"run_id":inspected.run_id,"open_tool_calls":inspected.open_tool_calls.len(),
        "raw_count":inspected.raw_count,"evidence":receipt.evidence});
    anyhow::ensure!(
        journal.contains_run(&inspected.run_id)?
            && head.raw_count == result_end
            && head.metadata["interrupted_reconciliations"].as_array().is_some_and(|items| items.contains(&saved))
            && receipt.tool_calls.len() == inspected.open_tool_calls.len(),
        "Session has no matching durable close reconciliation"
    );
    for (offset, (call, settlement)) in inspected.open_tool_calls.iter().zip(&receipt.tool_calls).enumerate() {
        crate::recovery_artifacts::check_reconciled_result(
            journal,
            inspected.raw_count + offset,
            call,
            &inspected.run_id,
            settlement,
            &receipt.evidence,
        )?;
    }
    Ok(())
}

pub fn close_settled_task(declaration_path: &Path, expected_sha256: &str) -> Result<Value> {
    let decl_ref = CloseRef { path: declaration_path.to_path_buf(), sha256: expected_sha256.to_owned() };
    let decl_bytes = checked_close_file(&decl_ref, 16 * 1024 * 1024)?;
    let decl: SettledTaskCloseDeclaration =
        serde_json::from_slice(&decl_bytes).context("invalid settled_task_close declaration")?;
    anyhow::ensure!(decl.kind == "settled_task_close" && decl.version == 1, "invalid settled_task_close kind/version");

    let session = storage::canonical(&decl.request.session_path)?;
    let cwd = decl.request.cwd.canonicalize().context("close cwd unavailable")?;
    let closure_dir = storage::canonical(&decl.request.evidence_dir)?;
    anyhow::ensure!(closure_dir.is_dir(), "settled_task_close evidence_dir must already exist");
    let canonical_decl = declaration_path.canonicalize()?;

    let (_lock, fence_path) = storage::lock_session(&session)?;
    let closing_path = closing_marker_path(&fence_path);
    let close_receipt_path = closure_dir.join("close-receipt.json");
    let fence_present = regular_file_present(&fence_path, "Session fence")?;
    let receipt_present = regular_file_present(&close_receipt_path, "close receipt")?;
    let marker = json!({"kind":"settled_task_closing","version":1,"task_id":decl.request.task.task_id,
        "declaration_sha256":expected_sha256});
    let marker_present = regular_file_present(&closing_path, "Session closing marker")?;
    if marker_present {
        let stored: Value = serde_json::from_slice(&std::fs::read(&closing_path)?)?;
        anyhow::ensure!(stored == marker, "Session closing marker binds a different declaration");
    }
    let receipt_payload = json!({
        "kind": "settled_task_close_receipt",
        "version": 1,
        "task_id": decl.request.task.task_id,
        "session_path": session,
        "declaration_sha256": expected_sha256,
        "expected_fence_sha256": decl.request.expected_fence_sha256,
        "task_accepted": false,
    });
    if receipt_present {
        let stored: Value = serde_json::from_slice(&std::fs::read(&close_receipt_path)?)?;
        anyhow::ensure!(stored == receipt_payload, "existing close receipt binds a different declaration");
    }

    // Idempotent completion check when an earlier attempt already released the fence.
    if !fence_present && receipt_present {
        let receipt_bytes = std::fs::read(&close_receipt_path)?;
        if marker_present {
            std::fs::remove_file(&closing_path)?;
            storage::sync_parent(&closing_path)?;
        }
        let receipt_ref = json!({
            "path": close_receipt_path.canonicalize()?,
            "sha256": storage::hash(&receipt_bytes),
        });
        return Ok(json!({
            "version": 1,
            "kind": "settled_task_closed",
            "declaration_ref": { "path": canonical_decl, "sha256": expected_sha256 },
            "original_outcome": decl.expected.fenced_outcome,
            "task_accepted": false,
            "fence_released": true,
            "close_receipt_ref": receipt_ref,
        }));
    }

    anyhow::ensure!(!decl.evidence_refs.is_empty(), "settled_task_close requires evidence_refs");
    let mut saw_inspection = false;
    for item in &decl.evidence_refs {
        let _ = checked_close_file(item, 64 * 1024 * 1024)?;
        if item.sha256 == decl.session_inspection_ref.sha256
            && item.path.canonicalize()? == decl.session_inspection_ref.path.canonicalize()?
        {
            saw_inspection = true;
        }
    }
    anyhow::ensure!(saw_inspection, "session_inspection_ref must appear in evidence_refs");
    let inspection_bytes = checked_close_file(&decl.session_inspection_ref, 64 * 1024 * 1024)?;
    let inspection_doc: Value = serde_json::from_slice(&inspection_bytes)?;
    anyhow::ensure!(
        inspection_doc["snapshot"]["fence"]["sha256"].as_str() == Some(decl.request.expected_fence_sha256.as_str()),
        "session_inspection_ref does not bind expected_fence_sha256"
    );
    anyhow::ensure!(
        decl.receipt.committed
            && decl.receipt.settlement == crate::Settlement::Settled
            && !decl.receipt.evidence.is_empty()
            && decl.receipt.evidence.iter().all(|e| !e.trim().is_empty()),
        "settled_task_close requires a committed Settled receipt with evidence"
    );

    anyhow::ensure!(fence_present, "Session has no active fence to close");
    let fence_bytes = std::fs::read(&fence_path)?;
    anyhow::ensure!(
        storage::hash(&fence_bytes) == decl.request.expected_fence_sha256,
        "Session fence sha256 differs from expected_fence_sha256"
    );
    let fence_record: Value = serde_json::from_slice(&fence_bytes)?;
    anyhow::ensure!(fence_record == decl.expected.fence, "Session fence record differs from expected.fence");
    anyhow::ensure!(
        fence_record["task_id"].as_str() == Some(decl.request.task.task_id.as_str())
            && fence_record["authority"]["declaration_sha256"].as_str()
                == Some(decl.request.expected_authority_sha256.as_str()),
        "Session fence task or authority mismatch"
    );
    let fenced_evidence = storage::canonical(&decl.request.task.evidence_dir)?;
    let outcome_bytes = std::fs::read(fenced_evidence.join("outcome.json")).context("fenced outcome.json missing")?;
    let stored_outcome: crate::TaskOutcome = serde_json::from_slice(&outcome_bytes)?;
    anyhow::ensure!(
        serde_json::to_value(&stored_outcome)? == serde_json::to_value(&decl.expected.fenced_outcome)?
            && !stored_outcome.task_accepted
            && stored_outcome.unknown_effects.is_empty()
            && stored_outcome.runs == decl.expected.consumed_runs
            && stored_outcome.observed_calls == decl.expected.consumed_calls,
        "fenced outcome mismatch or contains unknown effects"
    );

    let actual_interrupted = agent::interrupted_run(&session, &cwd)?;
    anyhow::ensure!(
        !receipt_present || actual_interrupted.is_none(),
        "existing close receipt conflicts with a pending interrupted Run"
    );
    if let Some(inspected) = &decl.expected.interrupted_run {
        let snapshot = &inspection_doc["snapshot"]["inspection"];
        let journal = Journal::for_session(&session);
        anyhow::ensure!(
            inspection_doc["kind"] == "locked_session_inspection"
                && inspection_doc["version"] == 1
                && snapshot["canonical_session_path"] == serde_json::to_value(&session)?
                && snapshot["canonical_cwd"] == serde_json::to_value(&cwd)?
                && snapshot["pending_run"] == serde_json::to_value(inspected)?
                && snapshot["to_raw"] == inspected.raw_count
                && snapshot["full_proof"].as_str() == Some(journal.proof(0, inspected.raw_count)?.as_str()),
            "session_inspection_ref does not bind the original interrupted Run and Journal prefix"
        );
        if marker_present && actual_interrupted.is_none() {
            // The original attempt may have finished the native write and stopped before releasing the fence.
            check_reconciled_close(&journal, inspected, &decl.receipt)?;
        } else {
            anyhow::ensure!(
                actual_interrupted.as_ref() == Some(inspected),
                "Session interrupted_run state changed since inspection"
            );
        }
    } else {
        anyhow::ensure!(actual_interrupted.is_none(), "Session interrupted_run state changed since inspection");
        anyhow::ensure!(
            decl.receipt.tool_calls.is_empty(),
            "no interrupted Run is pending, so receipt.tool_calls must be empty"
        );
    }
    if !marker_present {
        write_close_record(&closing_path, &marker)?;
    }

    if let Some(inspected) = &actual_interrupted {
        agent::reconcile_interrupted_run(&session, &cwd, inspected, &decl.receipt.tool_calls, &decl.receipt.evidence)?;
    } else if decl.expected.interrupted_run.is_none() && (session.exists() || Journal::for_session(&session).exists()) {
        let _ = agent::session_goal(&session, &cwd)?;
    }

    let mut released_outcome = stored_outcome.clone();
    released_outcome.reconciliation_fence = None;
    released_outcome.fence_presence = crate::FencePresence::Released;
    let released_file = fenced_evidence.join("released.json");
    if regular_file_present(&released_file, "released outcome")? {
        let stored: Value = serde_json::from_slice(&std::fs::read(&released_file)?)?;
        anyhow::ensure!(
            stored == serde_json::to_value(&released_outcome)?,
            "existing released outcome differs from original outcome"
        );
    } else {
        write_close_record(&released_file, &released_outcome)?;
    }
    if !receipt_present {
        write_close_record(&close_receipt_path, &receipt_payload)?;
    }
    anyhow::ensure!(regular_file_present(&fence_path, "Session fence")?, "Session fence mutated into non-regular file");
    std::fs::remove_file(&fence_path)?;
    storage::sync_parent(&fence_path)?;
    if regular_file_present(&closing_path, "Session closing marker")? {
        std::fs::remove_file(&closing_path)?;
        storage::sync_parent(&closing_path)?;
    }
    let receipt_bytes = std::fs::read(&close_receipt_path)?;
    let receipt_ref = json!({
        "path": close_receipt_path.canonicalize()?,
        "sha256": storage::hash(&receipt_bytes),
    });
    Ok(json!({
        "version": 1,
        "kind": "settled_task_closed",
        "declaration_ref": { "path": canonical_decl, "sha256": expected_sha256 },
        "original_outcome": decl.expected.fenced_outcome,
        "task_accepted": false,
        "fence_released": true,
        "close_receipt_ref": receipt_ref,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use morrow_agent_core::context_memory::{Memory, Source};

    #[test]
    fn close_record_publishes_complete_json_without_replacing_an_existing_record() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("close-receipt.json");
        let original = json!({"receipt":"original"});
        write_close_record(&path, &original).unwrap();
        assert!(write_close_record(&path, &json!({"receipt":"different"})).is_err());
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap(), original);
    }

    #[test]
    fn close_resumes_only_matching_durable_interrupted_reconciliation() {
        use morrow_agent_core::{
            agent::{ToolCallReconciliation, ToolCallSettlement},
            rpi_agent::AgentMessage,
            rpi_ai::{Api, AssistantMessage, Content, StopReason, ToolCall},
            session_inspect::{InspectionLimits, InspectionRequest},
        };

        for (scenario, error) in [
            ("missing marker", Some("interrupted_run state changed")),
            ("wrong marker", Some("marker binds a different declaration")),
            ("wrong prefix", Some("original interrupted Run and Journal prefix")),
            ("missing witness", Some("no matching durable close reconciliation")),
            ("wrong settlement", Some("recovery result settlement mismatch")),
            ("matching evidence", None),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let cwd = temporary.path().canonicalize().unwrap();
            let session = cwd.join("session.json");
            let closure = cwd.join("closure");
            std::fs::create_dir(&closure).unwrap();
            let task = crate::TaskSpec {
                task_id: "fenced-task".into(),
                criteria_revision: "criteria".into(),
                authorization_revision: "authorization".into(),
                kind: crate::TaskKind::Coding,
                evidence_dir: cwd.join("task"),
                max_runs: 1,
                max_calls: 2,
                deadline_unix_ms: u64::MAX,
            };
            let owner =
                storage::Admission::acquire(&task, &session, &json!({"declaration_sha256":"authority"})).unwrap();
            let fence_path = owner.fence.clone();
            let closing_path = closing_marker_path(&fence_path);
            let outcome = crate::TaskOutcome {
                task_id: task.task_id.clone(),
                stop: crate::TaskStop::Cancelled,
                runs: 1,
                observed_calls: 1,
                last_candidate: None,
                last_receipt: None,
                detail: "interrupted fixture".into(),
                task_accepted: false,
                reconciliation_fence: Some(fence_path.clone()),
                fence_presence: crate::FencePresence::Present,
                unknown_effects: vec![],
                budget_stop: None,
                artifacts: vec![],
            };
            storage::write_new(&owner.evidence.join("outcome.json"), &outcome).unwrap();
            let mut assistant = AssistantMessage::empty(Api::OpenaiCompletions, "fixture", "fixture", 1);
            assistant.stop_reason = StopReason::ToolUse;
            assistant.content.push(Content::ToolCall(ToolCall {
                kind: Default::default(),
                id: "open-call".into(),
                name: "fixture_tool".into(),
                arguments: json!({}),
                thought_signature: None,
                namespace: None,
            }));
            let journal = Journal::for_session(&session);
            let original = [context_memory::user("fixture".into()), AgentMessage::Assistant(Box::new(assistant))];
            let mut metadata = json!({"version":2,"cwd":cwd,"messages":[],"raw_base":0,
                "pending_run":"interrupted-run","completed_runs":[]});
            journal.commit(metadata.clone(), 0, &original, &[]).unwrap();
            drop(owner);

            let held = inspect_session_held(&InspectionRequest {
                session_path: session.clone(),
                cwd: cwd.clone(),
                from_raw: 0,
                expected_prefix_proof: None,
                expected_runs: vec![],
                require_context: false,
                limits: InspectionLimits { max_messages: 16, max_input_bytes: 64 * 1024, max_output_bytes: 64 * 1024 },
            })
            .unwrap();
            let mut snapshot = held.snapshot.clone();
            drop(held);
            let pending: InterruptedRun =
                serde_json::from_value(snapshot["inspection"]["pending_run"].clone()).unwrap();
            if scenario == "wrong prefix" {
                snapshot["inspection"]["full_proof"] = json!("wrong-prefix");
            }
            let inspection_path = cwd.join("inspection.json");
            storage::write_new(
                &inspection_path,
                &json!({"kind":"locked_session_inspection","version":1,"snapshot":snapshot}),
            )
            .unwrap();
            let reference = json!({"path":inspection_path,"sha256":storage::file_hash(&inspection_path).unwrap()});
            let declared_receipt = crate::ResumeReceipt {
                committed: true,
                settlement: crate::Settlement::Settled,
                tool_calls: vec![ToolCallReconciliation {
                    call_id: "open-call".into(),
                    settlement: ToolCallSettlement::Completed { output: "host confirmed".into(), images: vec![] },
                }],
                evidence: vec!["host-receipt:fixture".into()],
            };
            let declaration = closure.join("declaration.json");
            storage::write_new(
                &declaration,
                &json!({
                    "kind":"settled_task_close", "version":1,
                    "request":{"task":task,"session_path":session,"cwd":cwd,"evidence_dir":closure,
                        "expected_fence_sha256":snapshot["fence"]["sha256"],"expected_authority_sha256":"authority"},
                    "expected":{"fence":snapshot["fence"]["record"],"fenced_outcome":outcome,
                        "interrupted_run":pending,"consumed_runs":1,"consumed_calls":1},
                    "receipt":declared_receipt,"evidence_refs":[reference],"session_inspection_ref":reference,
                }),
            )
            .unwrap();
            let sha = storage::file_hash(&declaration).unwrap();
            {
                // Persist only the first half of a close, under its ordinary Session lock.
                let (_lock, _) = storage::lock_session(&session).unwrap();
                if scenario != "missing marker" {
                    let marker_sha = if scenario == "wrong marker" { "different-declaration" } else { &sha };
                    storage::write_new(
                        &closing_path,
                        &json!({"kind":"settled_task_closing","version":1,
                        "task_id":task.task_id,"declaration_sha256":marker_sha}),
                    )
                    .unwrap();
                }
                if scenario == "missing witness" {
                    // A completed Run ID without its native settlement is insufficient.
                    metadata["pending_run"] = Value::Null;
                    journal.commit(metadata, 0, &original, std::slice::from_ref(&pending.run_id)).unwrap();
                } else {
                    let mut receipts = declared_receipt.tool_calls.clone();
                    if scenario == "wrong settlement" {
                        receipts[0].settlement = ToolCallSettlement::NotExecuted;
                    }
                    agent::reconcile_interrupted_run(&session, &cwd, &pending, &receipts, &declared_receipt.evidence)
                        .unwrap();
                }
            }
            let raw_count = journal.open().unwrap().raw_count;
            let result = close_settled_task(&declaration, &sha);
            if let Some(expected_error) = error {
                assert!(result.unwrap_err().to_string().contains(expected_error), "{scenario}");
                assert!(fence_path.is_file(), "{scenario}");
                assert!(!closure.join("close-receipt.json").exists(), "{scenario}");
            } else {
                let closed = result.unwrap();
                assert_eq!(closed["fence_released"], true);
                assert!(!fence_path.exists());
                assert!(!closing_path.exists());
                assert_eq!(close_settled_task(&declaration, &sha).unwrap(), closed);
            }
            assert_eq!(journal.open().unwrap().raw_count, raw_count, "{scenario}");
        }
    }

    #[test]
    fn context_management_preserves_scope_sources_and_native_command_syntax() {
        let temporary = tempfile::tempdir().unwrap();
        let cwd = temporary.path().canonicalize().unwrap();
        let session = cwd.join("session.json");
        Journal::for_session(&session)
            .commit(
                json!({"version":2,"cwd":cwd,"messages":[],"raw_base":0,"pending_run":null,"completed_runs":[]}),
                0,
                &[],
                &[],
            )
            .unwrap();
        let added = context_add_reference(&session, &cwd, "objective", "Observed result".into(), "command-1").unwrap();
        let mut context: ContextStore = serde_json::from_value(added["context"].clone()).unwrap();
        let reference = context.references[0].clone();
        context.memories.push(Memory {
            experience: None,
            cloud_stamp: None,
            adoption: None,
            id: "mem-1".into(),
            kind: "fact".into(),
            text: "Observed result retained".into(),
            status: "candidate".into(),
            sources: vec![Source { id: reference.id.clone(), hash: reference.hash.clone() }],
            source_ids: vec![reference.id.clone()],
            run: "run-1".into(),
        });
        context.save(&context_memory::path(&session)).unwrap();
        context_command(&session, &cwd, "/memory accept mem-1", "command-2").unwrap();
        let restored = context_snapshot(&session, &cwd).unwrap();
        assert_eq!(restored["scope"], context_memory::hash(session.to_string_lossy().as_bytes()));
        assert_eq!(restored["memories"][0]["status"], "accepted");
        assert_eq!(restored["memories"][0]["adoption"]["command"], "/memory accept mem-1");
        context_command(&session, &cwd, "/memory revoke mem-1", "command-3").unwrap();
        assert_eq!(context_snapshot(&session, &cwd).unwrap()["memories"][0]["status"], "revoked");
        assert!(context_command(&session, &cwd, "not a command", "command-4").is_err());
        let other = cwd.join("other");
        std::fs::create_dir(&other).unwrap();
        assert!(context_snapshot(&session, &other).is_err());
        let spec = crate::TaskSpec {
            task_id: "held".into(),
            criteria_revision: "c1".into(),
            authorization_revision: "a1".into(),
            kind: crate::TaskKind::Reasoning,
            evidence_dir: cwd.join("held-evidence"),
            max_runs: 1,
            max_calls: 2,
            deadline_unix_ms: u64::MAX,
        };
        let admission = storage::Admission::acquire(&spec, &session, &json!({})).unwrap();
        assert!(context_command(&session, &cwd, "/reference revoke ref-1", "command-5").is_err());
        drop(admission);
        assert!(context_command(&session, &cwd, "/reference revoke ref-1", "command-6").is_err());
        assert_eq!(context_snapshot(&session, &cwd).unwrap()["references"][0]["status"], "active");
    }
}
