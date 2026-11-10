//! Cross-process, reviewed continuation of a released Task in its original Session.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::*;

/// Host authorization to continue one exact released result. `review` may be
/// omitted only when the original receipt already contains correction feedback.
/// A verified candidate requires a new committed NeedsChanges receipt, bound to
/// its original ReviewBasis and supported by Host evidence.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewedContinuation {
    pub previous_evidence_dir: PathBuf,
    pub expected_released_sha256: String,
    pub review: Option<ReviewReceipt>,
}

/// Continue the same Task with its original authority, terms and cumulative
/// budget. This consumes the source result once. If admission crashed after
/// claiming the result, retry the same target evidence and request; an existing
/// Session fence must instead be reconciled with `resume_checked`.
pub fn continue_reviewed(
    mut spec: TaskSpec,
    mut next: RunRequest,
    host: Arc<dyn HarnessHost>,
    options: TaskOptions,
    continuation: ReviewedContinuation,
) -> Result<TaskHandle> {
    tokio::runtime::Handle::try_current().context("continue_reviewed requires a running Tokio runtime")?;
    ensure!(spec.deadline_unix_ms > now_ms()?, "original Task deadline elapsed");
    ensure!(!next.id.trim().is_empty(), "continued Run ID required");
    ensure!(!next.objective.trim().is_empty(), "continued Run objective required");
    ensure!(next.max_calls > 0 && next.max_seconds > 0, "positive Run budgets required");
    spec.evidence_dir = canonical(&spec.evidence_dir)?;
    next.cwd = canonical(&next.cwd)?;
    next.state_path = canonical(&next.state_path)?;
    next.environment_state = canonical(&next.environment_state)?;
    let previous = canonical(&continuation.previous_evidence_dir)?;
    ensure!(previous != spec.evidence_dir, "continued Task requires new evidence");
    let owner = Admission::released(&next.state_path)?;
    let released_bytes = std::fs::read(previous.join("released.json"))?;
    ensure!(
        crate::storage::hash(&released_bytes) == continuation.expected_released_sha256,
        "released result hash mismatch"
    );
    let outcome: TaskOutcome = serde_json::from_slice(&released_bytes)?;
    ensure!(
        outcome.fence_presence == FencePresence::Released
            && outcome.unknown_effects.is_empty()
            && !outcome.task_accepted
            && matches!(outcome.stop, TaskStop::NeedsChanges | TaskStop::AwaitingHostAcceptance),
        "reviewed continuation requires a released, settled candidate awaiting Host review"
    );
    let original: TaskSpec = serde_json::from_slice(&std::fs::read(previous.join("task.json"))?)?;
    ensure!(
        original.task_id == spec.task_id
            && outcome.task_id == spec.task_id
            && original.kind == spec.kind
            && original.criteria_revision == spec.criteria_revision
            && original.authorization_revision == spec.authorization_revision
            && original.max_runs == spec.max_runs
            && original.max_calls == spec.max_calls
            && original.deadline_unix_ms == spec.deadline_unix_ms,
        "reviewed continuation changed original Task terms or budgets"
    );
    let original_options: TaskOptions = serde_json::from_slice(&std::fs::read(previous.join("task-options.json"))?)?;
    ensure!(original_options == options, "reviewed continuation changed Task review options");
    let original_authority: Value = serde_json::from_slice(
        &std::fs::read(previous.join("authority-record.json"))
            .context("original per-Run authority record unavailable; legacy evidence cannot continue_reviewed")?,
    )?;
    let mut authority = Authority::capture(&next)?;
    let snapshot = crate::snapshot::read_authorization(&crate::authorization_snapshot_path(&previous))?;
    ensure!(
        snapshot.task_id == spec.task_id
            && snapshot.criteria_revision == spec.criteria_revision
            && snapshot.authorization_revision == spec.authorization_revision
            && Some(snapshot.authority_sha256.as_str()) == original_authority["declaration_sha256"].as_str()
            && authority.record()?["declaration_sha256"] == original_authority["declaration_sha256"],
        "reviewed continuation changed original Host authority"
    );
    let run_calls =
        usize::try_from(original_authority["run_max_calls"].as_u64().context("original Run call cap missing")?)?;
    let run_seconds = original_authority["run_max_seconds"].as_u64().context("original Run time cap missing")?;
    ensure!(
        next.max_calls <= run_calls && next.max_seconds <= run_seconds,
        "continued Run caps exceed original authority"
    );
    authority.max_calls = next.max_calls;
    authority.max_seconds = next.max_seconds;
    let prior_receipt = outcome.last_receipt.as_ref().context("released result has no Host review")?;
    ensure!(valid_settlement(prior_receipt), "original review is not settled");
    let receipt = continuation.review.as_ref().unwrap_or(prior_receipt);
    ensure!(
        receipt.basis == prior_receipt.basis
            && valid_settlement(receipt)
            && !receipt.evidence.is_empty()
            && receipt.evidence.iter().all(|item| !item.trim().is_empty()),
        "continuation review must be committed, settled and bound to original evidence"
    );
    let Verdict::NeedsChanges { feedback } = &receipt.verdict else {
        anyhow::bail!("continuation requires Host NeedsChanges feedback");
    };
    ensure!(!feedback.trim().is_empty(), "continuation correction feedback is empty");
    let basis = &receipt.basis;
    ensure!(
        basis.task_id == spec.task_id
            && basis.criteria_revision == spec.criteria_revision
            && basis.authorization_revision == spec.authorization_revision
            && canonical(&basis.session_path)? == next.state_path
            && basis.run_number == outcome.runs
            && basis.total_calls == outcome.observed_calls,
        "reviewed continuation source identity or consumption mismatch"
    );
    check_basis(basis)?;
    let journal = morrow_agent_core::session_journal::Journal::for_session(&next.state_path);
    ensure!(!journal.contains_run(&next.id)?, "continued Run ID already exists");
    ensure!(
        agent::interrupted_run(&next.state_path, &next.cwd)?.is_none(),
        "Session has interrupted effects; reconcile first"
    );
    let (consumed_runs, consumed_calls) = consumed(&previous, Some(&outcome))?;
    ensure!(consumed_runs < spec.max_runs && consumed_calls < spec.max_calls, "original Task budget exhausted");
    next.objective = format!("{}\n\nHost review feedback\n{}", next.objective, feedback);
    let record = json!({
        "version":1,"kind":"reviewed_task_continuation","previous_evidence_dir":previous,
        "released_sha256":continuation.expected_released_sha256,"spec":spec,
        "run_id":next.id,"objective_sha256":crate::storage::hash(next.objective.as_bytes()),
        "consumed_runs":consumed_runs,"consumed_calls":consumed_calls,
        "receipt":receipt,"authority":authority.record()?,"options":options,
    });
    let claim_path = previous.join("continuation-claim.json");
    if claim_path.exists() {
        let claim: Value = serde_json::from_slice(&std::fs::read(&claim_path)?)?;
        ensure!(
            claim == record,
            "released result already claimed by another successor: {}",
            claim["spec"]["evidence_dir"]
        );
        let recorded: Value = serde_json::from_slice(&std::fs::read(spec.evidence_dir.join("continuation.json"))?)?;
        ensure!(recorded == record, "claimed successor evidence changed");
        for (name, expected) in [
            ("task.json", &record["spec"]),
            ("task-options.json", &record["options"]),
            ("authority-record.json", &record["authority"]),
        ] {
            let stored: Value = serde_json::from_slice(&std::fs::read(spec.evidence_dir.join(name))?)?;
            ensure!(&stored == expected, "claimed successor {name} changed");
        }
        ensure!(
            crate::snapshot::read_authorization(&crate::authorization_snapshot_path(&spec.evidence_dir))?
                == authority.snapshot(&spec)?,
            "claimed successor authorization snapshot changed"
        );
        ensure!(
            !spec.evidence_dir.join(format!("run-{}-admission.json", consumed_runs + 1)).exists()
                && !spec.evidence_dir.join("outcome.json").exists()
                && !spec.evidence_dir.join("released.json").exists(),
            "claimed successor was already admitted; inspect its outcome or resume its fence"
        );
    } else {
        let evidence = crate::storage::new_evidence(&spec)?;
        write_new(&evidence.join("task.json"), &spec)?;
        write_new(&evidence.join("task-options.json"), &options)?;
        write_new(&evidence.join("authority-record.json"), &authority.record()?)?;
        crate::snapshot::persist_authorization(&authority.snapshot(&spec)?, &evidence)?;
        write_new(&evidence.join("continuation.json"), &record)?;
        write_new(&claim_path, &record)?;
    }
    ensure!(spec.deadline_unix_ms > now_ms()?, "original Task deadline elapsed before continuation admission");
    let admission = owner.admit(&spec, &next.state_path, &authority.record()?, &previous)?;
    let mut progress = Progress::new(&spec);
    progress.outcome.runs = consumed_runs;
    progress.outcome.observed_calls = consumed_calls;
    progress.outcome.detail = "Task continued after committed Host correction feedback".into();
    spawn(spec, authority, admission, progress, next, host, options)
}
