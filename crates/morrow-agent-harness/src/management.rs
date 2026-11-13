//! Host-owned, no-model management helpers for the SpinMind integration.
//!
//! These functions reuse the Harness queue and the Core context/Skill stores.
//! They never create an Agent loop and never remove a Session fence.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use morrow_agent_core::{
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
        &journal.read(head.active_base, head.raw_count, morrow_agent_core::session_journal::CHECKPOINT_BYTES)?,
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
    let raw = journal.read(head.active_base, head.raw_count, morrow_agent_core::session_journal::CHECKPOINT_BYTES)?;
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
    let raw = journal.read(head.active_base, head.raw_count, morrow_agent_core::session_journal::CHECKPOINT_BYTES)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use morrow_agent_core::context_memory::{Memory, Source};

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
