//! Bounded, independently reviewed tasks over the actual Lite `execute` entry.
//!
//! Hosts own identities, credentials, paths, tool authorization and Task acceptance.
//! Tool identity checks and Host settlement declarations are not an OS sandbox or
//! proof of external effects. Dropping a waiter does not stop the worker. Cancellation
//! is cooperative: Core and Host futures are joined before releasing Session ownership.
//! A crashed or ambiguous task leaves a durable Session fence; this crate deliberately
//! supplies no automatic fence reset or replay operation. `resume` continues such a
//! Task only after the Host committed a settled reconciliation of what it left behind.

mod auto_artifacts;
mod provenance;
mod runner;
mod skill_provenance;
mod snapshot;
mod stop_review;
mod storage;
pub mod task_set;
mod types;

use std::path::{Path, PathBuf};

pub use morrow_agent_core as core;
pub use provenance::{
    append_skill_provenance, append_tool_artifact, read_skill_provenance, read_tool_artifacts, skill_provenance_path,
    tool_artifacts_path,
};
pub use runner::{resume, resume_checked, start, start_with_options, TaskHandle};
pub use skill_provenance::{
    query_skill_provenance, record_skill_verification, verified_skill_provenance, SkillProvenanceQuery,
};
pub use snapshot::{authorization_snapshot_path, budget_review_index_path, budget_snapshot_path};
pub use stop_review::{stop_review_index_path, stop_snapshot_path};
pub use types::*;

/// Evidence path for the experimental review artifact provenance sidecar.
pub fn review_artifact_manifest_path(evidence_dir: &Path, run_number: usize) -> PathBuf {
    evidence_dir.join(format!("run-{run_number}-artifacts.json"))
}
