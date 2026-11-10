//! Durable Host queue over the existing Harness. Lease expiry never grants replay.
//!
//! The Host owns authorization and reconstructs credentials/callbacks. The store
//! contains identities and receipts, not RunRequest values or an Agent loop.
use crate::{
    core::{self, RunRequest},
    storage, FencePresence, HarnessHost, ResumeChecks, ReviewedContinuation, TaskOptions, TaskOutcome, TaskSpec,
    TaskStop,
};
use anyhow::{ensure, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

const STORE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ASSIGNMENTS: usize = 1024;
const MAX_EVENTS: usize = 32768;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trigger {
    pub id: String,
    pub revision: String,
    pub source_ref: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mandate {
    pub id: String,
    pub revision: String,
    pub authorization_ref: String,
    pub configuration_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AssignmentSpec {
    pub id: String,
    pub trigger_id: String,
    pub mandate_id: String,
    pub task: TaskSpec,
    pub session_id: String,
    pub session_path: PathBuf,
    pub cwd: PathBuf,
    pub configuration_sha256: String,
    pub options: TaskOptions,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Queued,
    Claimed,
    Dispatching,
    Running,
    RecoveryRequired,
    Settled,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lease {
    pub worker_id: String,
    pub generation: u64,
    pub token: String,
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DispatchMode {
    Start,
    Resume { expected_fence_sha256: String },
    Continue { source: Box<ReviewedContinuation> },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DispatchIntent {
    pub attempt_id: String,
    pub run_id: String,
    pub evidence_dir: PathBuf,
    pub mode: DispatchMode,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileReference {
    pub path: PathBuf,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutcomeRecord {
    pub original: FileReference,
    pub stop: TaskStop,
    pub fence_presence: FencePresence,
    pub runs: usize,
    pub observed_calls: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Attempt {
    pub intent: DispatchIntent,
    pub outcome: Option<OutcomeRecord>,
    pub admission_failed: bool,
    pub recovery_receipt: Option<FileReference>,
    pub runs: Vec<RunReference>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RunReference {
    pub run_id: String,
    pub run_number: usize,
    pub admission: FileReference,
}
/// Host decision about one exact attempt, backed by an immutable receipt.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecoveryAuthorization {
    pub assignment_id: String,
    pub attempt_id: String,
    pub task_id: String,
    pub session_path: PathBuf,
    pub configuration_sha256: String,
    pub committed: bool,
    pub settled: bool,
    pub decision: RecoveryDecision,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryDecision {
    ContinueAfterReconciliation,
    NeverAdmitted,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobReference {
    pub task_id: String,
    pub run_id: String,
    pub job_id: String,
    pub request: FileReference,
    pub receipt_sha256: String,
    pub state: String,
    pub effects_unknown: bool,
    /// The Run that called job_start, which may idempotently observe an older Job.
    pub invocation: JobInvocation,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobInvocation {
    pub run: RunReference,
    pub events_path: PathBuf,
    pub tool_call_id: String,
    pub start_sequence: u64,
    pub end_sequence: u64,
    pub end_sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Assignment {
    pub specification: AssignmentSpec,
    pub queued_sequence: u64,
    pub phase: Phase,
    pub lease: Option<Lease>,
    pub cancellation_requested: bool,
    pub attempts: Vec<Attempt>,
    pub jobs: Vec<JobReference>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub sequence: u64,
    pub at_ms: u64,
    pub assignment_id: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    pub revision: u64,
    pub triggers: BTreeMap<String, Trigger>,
    pub mandates: BTreeMap<String, Mandate>,
    pub assignments: BTreeMap<String, Assignment>,
    pub events: Vec<Event>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            triggers: BTreeMap::new(),
            mandates: BTreeMap::new(),
            assignments: BTreeMap::new(),
            events: vec![],
        }
    }
}
#[derive(Clone, Debug)]
pub struct Store {
    directory: PathBuf,
}
/// Exclusive process ownership. Dropping a Claim does not requeue an assignment.
pub struct Claim {
    store: Store,
    assignment_id: String,
    lease: Lease,
    _worker: File,
}
#[derive(Clone, Debug)]
pub struct DispatchReport {
    pub outcome: Option<Arc<TaskOutcome>>,
    pub error: Option<String>,
}
#[derive(Clone)]
pub struct DispatchHandle {
    store: Store,
    assignment_id: String,
    result: watch::Receiver<Option<Arc<DispatchReport>>>,
}

#[derive(Debug)]
pub struct StoreBusy;
impl std::fmt::Display for StoreBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("orchestration store busy")
    }
}
impl std::error::Error for StoreBusy {}

fn identifier(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 256 && value.trim() == value && !value.chars().any(char::is_control),
        "invalid orchestration identifier"
    );
    Ok(())
}
fn digest(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid configuration SHA256"
    );
    Ok(())
}
fn equal<T: Serialize>(left: &T, right: &T) -> Result<bool> {
    Ok(serde_json::to_value(left)? == serde_json::to_value(right)?)
}
fn clock_ms() -> Result<u64> {
    Ok(u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?)
}
fn bytes(path: &Path) -> Result<Vec<u8>> {
    let mut data = vec![];
    File::open(path)?.take(STORE_BYTES + 1).read_to_end(&mut data)?;
    ensure!(data.len() as u64 <= STORE_BYTES, "orchestration file exceeds bound");
    Ok(data)
}
fn has_prepared_continuation(assignment: &Assignment) -> Result<bool> {
    for attempt in &assignment.attempts {
        if let DispatchMode::Continue { source } = &attempt.intent.mode {
            let claim = source.previous_evidence_dir.join("continuation-claim.json");
            if claim.is_file() && !attempt.intent.evidence_dir.join("released.json").is_file() {
                let record: serde_json::Value = serde_json::from_slice(&bytes(&claim)?)?;
                if record["run_id"] == attempt.intent.run_id
                    && record["spec"]["evidence_dir"].as_str().map(Path::new)
                        == Some(attempt.intent.evidence_dir.as_path())
                {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

impl Store {
    pub fn open(directory: impl AsRef<Path>) -> Result<Self> {
        ensure!(directory.as_ref().is_absolute(), "absolute Host store directory required");
        fs::create_dir_all(directory.as_ref())?;
        Ok(Self { directory: directory.as_ref().canonicalize()? })
    }
    fn lock(&self, exclusive: bool) -> Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join("store.lock"))?;
        match if exclusive { FileExt::try_lock_exclusive(&file) } else { FileExt::try_lock_shared(&file) } {
            Ok(()) => (),
            Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                return Err(StoreBusy.into());
            }
            Err(error) => return Err(error.into()),
        }
        Ok(file)
    }
    fn load(&self) -> Result<Snapshot> {
        let path = self.directory.join("state.json");
        let state: Snapshot = if path.exists() { serde_json::from_slice(&bytes(&path)?)? } else { Snapshot::default() };
        ensure!(
            state.version == 1 && state.assignments.len() <= MAX_ASSIGNMENTS && state.events.len() <= MAX_EVENTS,
            "invalid orchestration snapshot"
        );
        ensure!(
            state.events.iter().enumerate().all(|(i, e)| e.sequence == i as u64 + 1),
            "orchestration event sequence is corrupt"
        );
        Ok(state)
    }
    fn publish(&self, state: &Snapshot) -> Result<()> {
        let data = serde_json::to_vec(state)?;
        ensure!(data.len() as u64 <= STORE_BYTES, "orchestration snapshot exceeds bound");
        let staged = self.directory.join(format!("state-staged-{}.json", core::fresh_id()));
        let mut file = OpenOptions::new().create_new(true).write(true).open(&staged)?;
        file.write_all(&data)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&staged, self.directory.join("state.json"))?;
        storage::sync_parent(&self.directory.join("state.json"))
    }
    fn mutate<T>(&self, change: impl FnOnce(&mut Snapshot) -> Result<T>) -> Result<T> {
        let _guard = self.lock(true)?;
        let mut state = self.load()?;
        let result = change(&mut state)?;
        state.revision = state.revision.checked_add(1).context("store revision overflow")?;
        self.publish(&state)?;
        Ok(result)
    }
    fn event(state: &mut Snapshot, id: &str, kind: &str, at: u64) -> Result<()> {
        ensure!(state.events.len() < MAX_EVENTS, "orchestration event capacity reached");
        state.events.push(Event {
            sequence: state.events.len() as u64 + 1,
            at_ms: at,
            assignment_id: id.into(),
            kind: kind.into(),
        });
        Ok(())
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let _guard = self.lock(false)?;
        self.load()
    }
    pub fn events_after(&self, sequence: u64) -> Result<Vec<Event>> {
        Ok(self.snapshot()?.events.into_iter().filter(|e| e.sequence > sequence).collect())
    }
    pub fn enqueue(
        &self,
        trigger: Trigger,
        mandate: Mandate,
        mut spec: AssignmentSpec,
        at_ms: u64,
    ) -> Result<Assignment> {
        for id in [
            &trigger.id,
            &trigger.revision,
            &mandate.id,
            &mandate.revision,
            &spec.id,
            &spec.task.task_id,
            &spec.session_id,
        ] {
            identifier(id)?;
        }
        ensure!(
            !trigger.source_ref.trim().is_empty() && !mandate.authorization_ref.trim().is_empty(),
            "Host source and authorization references required"
        );
        digest(&spec.configuration_sha256)?;
        ensure!(spec.configuration_sha256 == mandate.configuration_sha256, "Mandate configuration mismatch");
        ensure!(
            spec.trigger_id == trigger.id && spec.mandate_id == mandate.id,
            "assignment authorization identity mismatch"
        );
        spec.cwd = storage::canonical(&spec.cwd)?;
        spec.session_path = storage::canonical(&spec.session_path)?;
        spec.task.evidence_dir = storage::canonical(&spec.task.evidence_dir)?;
        self.mutate(|state| {
            if let Some(old) = state.triggers.get(&trigger.id) {
                ensure!(old == &trigger, "Trigger ID reused with different content");
            }
            if let Some(old) = state.mandates.get(&mandate.id) {
                ensure!(old == &mandate, "Mandate ID reused with different content");
            }
            if let Some(old) = state.assignments.get(&spec.id) {
                ensure!(equal(&old.specification, &spec)?, "Assignment ID reused with different content");
                return Ok(old.clone());
            }
            ensure!(
                spec.task.max_calls > 0 && spec.task.max_runs > 0 && spec.task.deadline_unix_ms > at_ms,
                "invalid assignment Task budget"
            );
            ensure!(state.assignments.len() < MAX_ASSIGNMENTS, "assignment capacity reached");
            let id = spec.id.clone();
            let record = Assignment {
                specification: spec,
                queued_sequence: state.events.len() as u64 + 1,
                phase: Phase::Queued,
                lease: None,
                cancellation_requested: false,
                attempts: vec![],
                jobs: vec![],
            };
            state.triggers.insert(trigger.id.clone(), trigger);
            state.mandates.insert(mandate.id.clone(), mandate);
            state.assignments.insert(id.clone(), record.clone());
            Self::event(state, &id, "queued", at_ms)?;
            Ok(record)
        })
    }
    fn worker_lock(&self, id: &str) -> Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join(format!("worker-{}.lock", storage::hash(id.as_bytes()))))?;
        FileExt::try_lock_exclusive(&file).context("assignment worker still owns execution")?;
        Ok(file)
    }
    pub fn claim_next(&self, worker_id: &str, at_ms: u64, expires_at_ms: u64) -> Result<Option<Claim>> {
        identifier(worker_id)?;
        ensure!(expires_at_ms > at_ms, "worker lease must be in the future");
        let _guard = self.lock(true)?;
        let mut state = self.load()?;
        let id = state
            .assignments
            .values()
            .filter(|a| a.phase == Phase::Queued)
            .min_by_key(|a| a.queued_sequence)
            .map(|a| a.specification.id.clone());
        let Some(id) = id else { return Ok(None) };
        let lock = self.worker_lock(&id)?;
        let assignment = state.assignments.get_mut(&id).unwrap();
        let lease = Lease {
            worker_id: worker_id.into(),
            generation: assignment.lease.as_ref().map_or(1, |l| l.generation + 1),
            token: core::fresh_id(),
            expires_at_ms,
        };
        assignment.phase = Phase::Claimed;
        assignment.lease = Some(lease.clone());
        Self::event(&mut state, &id, "claimed", at_ms)?;
        state.revision += 1;
        self.publish(&state)?;
        Ok(Some(Claim { store: self.clone(), assignment_id: id, lease, _worker: lock }))
    }
    /// A process lock, not an expired clock, proves the previous supervisor is gone.
    pub fn claim_recovery(&self, id: &str, worker_id: &str, at_ms: u64, expires_at_ms: u64) -> Result<Claim> {
        self.claim_owner(id, worker_id, at_ms, expires_at_ms, false)
    }
    /// Explicit Host request to continue a released Task; this does not accept it.
    pub fn claim_reviewed(&self, id: &str, worker_id: &str, at_ms: u64, expires_at_ms: u64) -> Result<Claim> {
        self.claim_owner(id, worker_id, at_ms, expires_at_ms, true)
    }
    fn claim_owner(&self, id: &str, worker_id: &str, at_ms: u64, expires_at_ms: u64, reviewed: bool) -> Result<Claim> {
        identifier(worker_id)?;
        ensure!(expires_at_ms > at_ms, "worker lease must be in the future");
        let lock = self.worker_lock(id)?;
        let lease = self.mutate(|state| {
            let assignment = state.assignments.get_mut(id).context("unknown assignment")?;
            if reviewed {
                ensure!(
                    assignment.phase == Phase::Settled
                        && assignment
                            .attempts
                            .iter()
                            .rev()
                            .find_map(|attempt| attempt.outcome.as_ref())
                            .is_some_and(|outcome| outcome.fence_presence == FencePresence::Released
                                && matches!(outcome.stop, TaskStop::AwaitingHostAcceptance | TaskStop::NeedsChanges)),
                    "reviewed claim requires a released candidate"
                );
            } else {
                ensure!(
                    matches!(
                        assignment.phase,
                        Phase::Claimed | Phase::Dispatching | Phase::Running | Phase::RecoveryRequired
                    ),
                    "assignment does not need recovery"
                );
            }
            let lease = Lease {
                worker_id: worker_id.into(),
                generation: assignment.lease.as_ref().map_or(1, |l| l.generation + 1),
                token: core::fresh_id(),
                expires_at_ms,
            };
            assignment.lease = Some(lease.clone());
            assignment.phase = Phase::RecoveryRequired;
            Self::event(state, id, if reviewed { "reviewed_continuation_claimed" } else { "recovery_claimed" }, at_ms)?;
            Ok(lease)
        })?;
        Ok(Claim { store: self.clone(), assignment_id: id.into(), lease, _worker: lock })
    }
    pub fn cancel(&self, id: &str, at_ms: u64) -> Result<()> {
        self.mutate(|state| {
            let a = state.assignments.get_mut(id).context("unknown assignment")?;
            if a.phase == Phase::Settled || a.cancellation_requested {
                return Ok(());
            }
            a.cancellation_requested = true;
            if a.phase == Phase::Queued {
                a.phase = Phase::Settled;
            }
            Self::event(state, id, "cancellation_requested", at_ms)
        })
    }
    pub fn watchdog(&self, at_ms: u64) -> Result<Vec<String>> {
        self.mutate(|state| {
            let mut expired = vec![];
            for a in state.assignments.values_mut() {
                if a.phase != Phase::Settled
                    && a.phase != Phase::Queued
                    && a.lease.as_ref().is_some_and(|l| l.expires_at_ms <= at_ms)
                    && a.phase != Phase::RecoveryRequired
                {
                    a.phase = Phase::RecoveryRequired;
                    a.cancellation_requested = true;
                    expired.push(a.specification.id.clone());
                }
            }
            for id in &expired {
                Self::event(state, id, "lease_expired_recovery_required", at_ms)?;
            }
            Ok(expired)
        })
    }
}

impl Store {
    /// Read a native Manager receipt, retaining its original Task/Run and owner proof.
    pub fn observe_job(
        &self,
        assignment_id: &str,
        run_id: &str,
        job_id: &str,
        device: &str,
        manager: &core::managed_jobs::Manager,
    ) -> Result<JobReference> {
        identifier(job_id)?;
        ensure!(job_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "invalid native Job ID");
        let state = self.snapshot()?;
        let a = state.assignments.get(assignment_id).context("unknown assignment")?;
        let owner = core::managed_jobs::Owner::new(&a.specification.session_path, device, &a.specification.session_id)?;
        let session = a.specification.session_path.canonicalize()?;
        let base =
            if session.is_dir() { session.as_path() } else { session.parent().context("Session parent missing")? };
        let path = base
            .join("managed-jobs")
            .join(storage::hash(&serde_json::to_vec(&owner)?))
            .join(job_id)
            .join("request.json");
        let raw = bytes(&path)?;
        let request: serde_json::Value = serde_json::from_slice(&raw)?;
        let receipt = manager.status(job_id)?;
        ensure!(
            request["owner"] == serde_json::to_value(&owner)?
                && request["job_id"] == job_id
                && request["worker_nonce"] == receipt.worker_nonce,
            "Job receipt belongs to another Session owner"
        );
        // Native requests do not name a Run. Prove the calling Run from its
        // original Harness admission and job_start/result pair instead of
        // accepting the Host's run_id assertion alone.
        let mut invocation = None;
        for attempt in &a.attempts {
            if !attempt.intent.evidence_dir.is_dir() {
                continue;
            }
            for entry in fs::read_dir(&attempt.intent.evidence_dir)? {
                let path = entry?.path();
                let Some(number) = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(|name| name.strip_prefix("run-"))
                    .and_then(|name| name.strip_suffix("-admission.json"))
                    .and_then(|number| number.parse::<usize>().ok())
                else {
                    continue;
                };
                let raw = bytes(&path)?;
                let admission: serde_json::Value = serde_json::from_slice(&raw)?;
                if admission["run_id"] != run_id {
                    continue;
                }
                ensure!(
                    admission["task_id"] == a.specification.task.task_id
                        && admission["session_path"] == serde_json::to_value(&a.specification.session_path)?
                        && admission["session_id"] == a.specification.session_id
                        && admission["run_number"] == number,
                    "Job Run admission belongs to another Task/Session"
                );
                let events_path = attempt.intent.evidence_dir.join(format!("run-{number}-events.jsonl"));
                let events = bytes(&events_path)?;
                let mut starts = BTreeMap::new();
                for line in events.split_inclusive(|byte| *byte == b'\n') {
                    // An active event pump may have an uncommitted trailing line.
                    if line.last() != Some(&b'\n') {
                        break;
                    }
                    let envelope: crate::EventEnvelope = serde_json::from_slice(line)?;
                    ensure!(
                        envelope.task_id == a.specification.task.task_id && envelope.run_id == run_id,
                        "Job event belongs to another Task/Run"
                    );
                    let event = &envelope.event;
                    if event["title"] != "job_start" {
                        continue;
                    }
                    let id = event["step_id"].as_str().context("Job tool call ID missing")?;
                    if event["type"] == "tool_start" {
                        let args: serde_json::Value =
                            serde_json::from_str(event["detail"].as_str().context("Job arguments missing")?)?;
                        if args["op_id"] == request["spec"]["op_id"] {
                            starts.insert(id.to_owned(), envelope.seq);
                        }
                    } else if event["type"] == "tool_end" && event["status"] == "completed" {
                        // The native tool deliberately removes worker_nonce
                        // from model-visible output. Its request/status owner
                        // binding was checked above; the event binds the Run
                        // to the public Job ID and original op_id.
                        let result: serde_json::Value =
                            serde_json::from_str(event["output"].as_str().context("Job tool receipt missing")?)?;
                        if result["job_id"] == job_id {
                            let start_sequence =
                                *starts.get(id).context("Job result lacks matching original invocation")?;
                            if invocation.is_none() {
                                invocation = Some(JobInvocation {
                                    run: RunReference {
                                        run_id: run_id.into(),
                                        run_number: number,
                                        admission: FileReference {
                                            path: path.canonicalize()?,
                                            sha256: storage::hash(&raw),
                                        },
                                    },
                                    events_path: events_path.canonicalize()?,
                                    tool_call_id: id.into(),
                                    start_sequence,
                                    end_sequence: envelope.seq,
                                    end_sha256: storage::hash(line),
                                });
                            }
                        }
                    }
                }
            }
        }
        let invocation = invocation.context("Job has no verified invocation in the supplied Run")?;
        let record = JobReference {
            task_id: a.specification.task.task_id.clone(),
            run_id: run_id.into(),
            job_id: job_id.into(),
            request: FileReference { path: path.canonicalize()?, sha256: storage::hash(&raw) },
            receipt_sha256: storage::hash(&serde_json::to_vec(&receipt)?),
            state: receipt.state,
            effects_unknown: receipt.effects_unknown,
            invocation,
        };
        self.mutate(|state| {
            let a = state.assignments.get_mut(assignment_id).context("unknown assignment")?;
            if let Some(previous) = a.jobs.iter_mut().find(|job| job.job_id == job_id) {
                ensure!(previous.run_id == run_id && previous.request == record.request, "Job source identity changed");
                *previous = record.clone();
            } else {
                a.jobs.push(record.clone());
            }
            Store::event(state, assignment_id, "native_job_observed", clock_ms()?)
        })?;
        Ok(record)
    }
}

impl Claim {
    fn assignment<'a>(&self, state: &'a mut Snapshot) -> Result<&'a mut Assignment> {
        let a = state.assignments.get_mut(&self.assignment_id).context("assignment disappeared")?;
        ensure!(
            a.lease.as_ref().is_some_and(|l| l.token == self.lease.token
                && l.generation == self.lease.generation
                && l.worker_id == self.lease.worker_id),
            "stale worker ownership"
        );
        Ok(a)
    }
    pub fn heartbeat(&self, at_ms: u64, expires_at_ms: u64) -> Result<()> {
        ensure!(expires_at_ms > at_ms, "worker lease must be in the future");
        self.store.mutate(|state| {
            let a = self.assignment(state)?;
            ensure!(a.phase != Phase::Settled, "assignment is settled");
            a.lease.as_mut().unwrap().expires_at_ms = expires_at_ms;
            Ok(())
        })
    }
    /// No execution was requested. This cannot clear a persisted dispatch intent.
    pub fn release_unstarted(self, at_ms: u64) -> Result<()> {
        self.store.mutate(|state| {
            let a = self.assignment(state)?;
            ensure!(a.attempts.is_empty(), "dispatch intent exists; inspect its original receipts");
            a.phase = if a.cancellation_requested { Phase::Settled } else { Phase::Queued };
            Store::event(state, &self.assignment_id, "unstarted_owner_released", at_ms)
        })
    }
    fn checked_recovery_receipt(&self, reference: &FileReference, decision: RecoveryDecision) -> Result<()> {
        let raw = bytes(&reference.path)?;
        ensure!(storage::hash(&raw) == reference.sha256, "Host recovery receipt bytes changed");
        let proof: RecoveryAuthorization = serde_json::from_slice(&raw)?;
        let state = self.store.snapshot()?;
        let a = &state.assignments[&self.assignment_id];
        let attempt = a.attempts.last().context("no original dispatch intent")?;
        ensure!(
            proof.committed
                && proof.settled
                && proof.decision == decision
                && proof.assignment_id == self.assignment_id
                && proof.attempt_id == attempt.intent.attempt_id
                && proof.task_id == a.specification.task.task_id
                && proof.session_path == a.specification.session_path
                && proof.configuration_sha256 == a.specification.configuration_sha256,
            "Host recovery receipt differs from original attempt"
        );
        Ok(())
    }
    /// Only an explicit Host reconciliation may clear a durable cancellation request.
    pub fn authorize_recovery(&self, reference: FileReference) -> Result<()> {
        self.checked_recovery_receipt(&reference, RecoveryDecision::ContinueAfterReconciliation)?;
        self.store.mutate(|state| {
            let a = self.assignment(state)?;
            ensure!(a.phase == Phase::RecoveryRequired, "assignment is not awaiting recovery");
            a.cancellation_requested = false;
            a.attempts.last_mut().unwrap().recovery_receipt = Some(reference);
            Store::event(state, &self.assignment_id, "Host_recovery_authorized", clock_ms()?)
        })
    }
    /// Retry the exact persisted Start or Continue intent only after the Host
    /// proves that its successor Run was never admitted. Continue delegates the
    /// prepared single-successor claim checks to continue_reviewed unchanged.
    pub fn retry_unadmitted(
        self,
        request: RunRequest,
        host: Arc<dyn HarnessHost>,
        configuration_sha256: &str,
        reference: FileReference,
    ) -> Result<DispatchHandle> {
        tokio::runtime::Handle::try_current().context("dispatch requires a Tokio runtime")?;
        self.checked_recovery_receipt(&reference, RecoveryDecision::NeverAdmitted)?;
        let state = self.store.snapshot()?;
        let a = &state.assignments[&self.assignment_id];
        let intent = a.attempts.last().context("no original dispatch")?.intent.clone();
        ensure!(!matches!(intent.mode, DispatchMode::Resume { .. }), "a fenced resume requires checked recovery");
        ensure!(
            request.id == intent.run_id
                && request.session_key == a.specification.session_id
                && storage::canonical(&request.state_path)? == a.specification.session_path
                && storage::canonical(&request.cwd)? == a.specification.cwd
                && configuration_sha256 == a.specification.configuration_sha256,
            "retry changed original request identity"
        );
        let session = storage::Admission::released(&a.specification.session_path)?;
        if matches!(intent.mode, DispatchMode::Start) {
            ensure!(!intent.evidence_dir.exists(), "original evidence exists; harvest or reconcile instead");
        } else if intent.evidence_dir.exists() {
            ensure!(
                !intent.evidence_dir.join("outcome.json").exists()
                    && !intent.evidence_dir.join("released.json").exists(),
                "successor result already exists; harvest or reconcile instead"
            );
            for entry in fs::read_dir(&intent.evidence_dir)? {
                let name = entry?.file_name();
                let name = name.to_string_lossy();
                ensure!(
                    !(name.starts_with("run-") && name.ends_with("-admission.json")),
                    "successor Run was already admitted"
                );
            }
        }
        ensure!(
            core::agent::interrupted_run(&request.state_path, &request.cwd)?.is_none(),
            "native Run still has unknown effects"
        );
        let journal = core::session_journal::Journal::for_session(&request.state_path);
        ensure!(!journal.exists() || !journal.contains_run(&intent.run_id)?, "original Run was already admitted");
        let mut spec = a.specification.task.clone();
        spec.evidence_dir = intent.evidence_dir.clone();
        self.store.mutate(|state| {
            let a = self.assignment(state)?;
            ensure!(
                a.phase == Phase::RecoveryRequired && !a.cancellation_requested,
                "retry needs explicit uncancelled recovery ownership"
            );
            a.attempts.last_mut().unwrap().recovery_receipt = Some(reference);
            a.phase = Phase::Dispatching;
            Store::event(state, &self.assignment_id, "original_unadmitted_intent_retried", clock_ms()?)
        })?;
        drop(session);
        Ok(self.launch(intent, spec, request, host))
    }
    /// Persist intent, then transfer process ownership to a detached joined supervisor.
    /// The configuration digest is a Host authorization assertion, not a sandbox.
    pub fn dispatch(
        self,
        mut intent: DispatchIntent,
        mut request: RunRequest,
        host: Arc<dyn HarnessHost>,
        configuration_sha256: &str,
    ) -> Result<DispatchHandle> {
        tokio::runtime::Handle::try_current().context("dispatch requires a Tokio runtime")?;
        identifier(&intent.attempt_id)?;
        identifier(&intent.run_id)?;
        intent.evidence_dir = storage::canonical(&intent.evidence_dir)?;
        if let DispatchMode::Continue { source } = &mut intent.mode {
            source.previous_evidence_dir = source.previous_evidence_dir.canonicalize()?;
        }
        request.cwd = storage::canonical(&request.cwd)?;
        request.state_path = storage::canonical(&request.state_path)?;
        let spec = self.store.mutate(|state| {
            let a = self.assignment(state)?;
            ensure!(!a.cancellation_requested, "assignment cancellation requested");
            ensure!(
                configuration_sha256 == a.specification.configuration_sha256,
                "Host configuration digest differs from Mandate"
            );
            ensure!(
                request.id == intent.run_id
                    && request.session_key == a.specification.session_id
                    && request.state_path == a.specification.session_path
                    && request.cwd == a.specification.cwd,
                "dispatch Task/Session/Run paths differ"
            );
            ensure!(
                a.attempts.iter().all(|old| old.intent.attempt_id != intent.attempt_id
                    && old.intent.run_id != intent.run_id
                    && old.intent.evidence_dir != intent.evidence_dir),
                "dispatch attempt identity reused"
            );
            match &intent.mode {
                DispatchMode::Start => ensure!(
                    a.phase == Phase::Claimed
                        && a.attempts.is_empty()
                        && intent.evidence_dir == a.specification.task.evidence_dir,
                    "fresh start cannot replace an original attempt"
                ),
                DispatchMode::Resume { expected_fence_sha256 } => {
                    digest(expected_fence_sha256)?;
                    ensure!(
                        a.phase == Phase::RecoveryRequired && !a.attempts.is_empty(),
                        "resume requires original dispatch evidence"
                    );
                    let owner = storage::Admission::fenced(&request.state_path)?;
                    ensure!(
                        owner.record["task_id"] == a.specification.task.task_id
                            && a.attempts.iter().any(|attempt| owner.record["evidence_dir"].as_str().map(Path::new)
                                == Some(attempt.intent.evidence_dir.as_path()))
                            && owner.sha256() == *expected_fence_sha256,
                        "recovery fence belongs to another attempt"
                    );
                }
                DispatchMode::Continue { source } => {
                    ensure!(
                        !has_prepared_continuation(a)?,
                        "prepared continuation requires retry of its exact original intent"
                    );
                    ensure!(
                        a.phase == Phase::RecoveryRequired && !a.attempts.is_empty(),
                        "continuation requires original released evidence"
                    );
                    ensure!(
                        a.attempts.iter().any(|attempt| source.previous_evidence_dir == attempt.intent.evidence_dir),
                        "continuation source differs from original attempt"
                    );
                }
            }
            let mut spec = a.specification.task.clone();
            spec.evidence_dir = intent.evidence_dir.clone();
            a.attempts.push(Attempt {
                intent: intent.clone(),
                outcome: None,
                admission_failed: false,
                recovery_receipt: None,
                runs: Vec::new(),
            });
            a.phase = Phase::Dispatching;
            Store::event(state, &self.assignment_id, "dispatch_intent", clock_ms()?)?;
            Ok(spec)
        })?;
        Ok(self.launch(intent, spec, request, host))
    }
    fn launch(
        self,
        intent: DispatchIntent,
        spec: TaskSpec,
        request: RunRequest,
        host: Arc<dyn HarnessHost>,
    ) -> DispatchHandle {
        let (send, receiver) = watch::channel(None);
        let handle =
            DispatchHandle { store: self.store.clone(), assignment_id: self.assignment_id.clone(), result: receiver };
        tokio::spawn(async move {
            let result = self.supervise(intent, spec, request, host).await;
            let report = match result {
                Ok(outcome) => DispatchReport { outcome: Some(outcome), error: None },
                Err(error) => DispatchReport { outcome: None, error: Some(format!("{error:#}")) },
            };
            let _ = send.send(Some(Arc::new(report)));
        });
        handle
    }
    async fn supervise(
        self,
        intent: DispatchIntent,
        spec: TaskSpec,
        request: RunRequest,
        host: Arc<dyn HarnessHost>,
    ) -> Result<Arc<TaskOutcome>> {
        let state = self.store.snapshot()?;
        let assignment = &state.assignments[&self.assignment_id];
        if assignment.cancellation_requested {
            self.store.mutate(|state| {
                let a = self.assignment(state)?;
                // A cancelled recovery attempt cannot settle effects inherited
                // from the original admitted Run.
                a.phase = if a.attempts.len() == 1 && matches!(intent.mode, DispatchMode::Start) {
                    Phase::Settled
                } else {
                    Phase::RecoveryRequired
                };
                Store::event(state, &self.assignment_id, "cancelled_before_harness_admission", clock_ms()?)
            })?;
            anyhow::bail!("assignment cancelled before Harness admission");
        }
        let options = assignment.specification.options;
        let started = match intent.mode.clone() {
            DispatchMode::Start => crate::start_with_options(spec, request, host, options),
            DispatchMode::Resume { expected_fence_sha256 } => {
                crate::resume_checked(
                    spec,
                    request,
                    host,
                    options,
                    ResumeChecks { expected_fence_sha256: Some(expected_fence_sha256), refuse_larger_run_caps: true },
                )
                .await
            }
            DispatchMode::Continue { source } => crate::continue_reviewed(spec, request, host, options, *source),
        };
        let task = match started {
            Ok(task) => task,
            Err(error) => {
                self.store.mutate(|state| {
                    let a = self.assignment(state)?;
                    a.phase = Phase::RecoveryRequired;
                    a.attempts.last_mut().unwrap().admission_failed = true;
                    Store::event(state, &self.assignment_id, "admission_requires_reconciliation", clock_ms()?)
                })?;
                return Err(error);
            }
        };
        // From here on, every failure must still join Core and Host callbacks.
        let mut persistence_failed = false;
        if let Err(error) = self.store.mutate(|state| {
            let a = self.assignment(state)?;
            if a.phase != Phase::RecoveryRequired {
                a.phase = Phase::Running;
            }
            Store::event(state, &self.assignment_id, "harness_started", clock_ms()?)
        }) {
            if !error.is::<StoreBusy>() {
                task.cancel();
                persistence_failed = true;
            }
        }
        let started_at = match clock_ms() {
            Ok(now) => now,
            Err(_) => {
                task.cancel();
                persistence_failed = true;
                0
            }
        };
        let lease_duration = self.lease.expires_at_ms.saturating_sub(started_at).max(100);
        let heartbeat_period = Duration::from_millis((lease_duration / 3).clamp(50, 10_000));
        let mut next_heartbeat = tokio::time::Instant::now() + heartbeat_period;
        let outcome = loop {
            tokio::select! {
                outcome=task.wait()=>break outcome,
                _=tokio::time::sleep(Duration::from_millis(50))=>{
                    match self.store.snapshot() {
                        Ok(state)=>{ if state.assignments[&self.assignment_id].cancellation_requested { task.cancel(); } },
                        Err(error) if error.is::<StoreBusy>() => (),
                        Err(_)=>{task.cancel();persistence_failed=true;}
                    }
                    if tokio::time::Instant::now() >= next_heartbeat {
                        match clock_ms() {
                            Ok(now)=>{
                                match self.heartbeat(now,now.saturating_add(lease_duration)) {
                                    Ok(()) => next_heartbeat = tokio::time::Instant::now() + heartbeat_period,
                                    Err(error) if error.is::<StoreBusy>() => (),
                                    Err(_) => {task.cancel();persistence_failed=true;}
                                }
                            },
                            Err(_)=>{task.cancel();persistence_failed=true;}
                        }
                    }
                }
            }
        };
        self.save_outcome(&intent, &outcome)?;
        ensure!(!persistence_failed, "supervisor joined after persistence failure; inspect original Harness outcome");
        Ok(outcome)
    }
    fn save_outcome(&self, intent: &DispatchIntent, outcome: &TaskOutcome) -> Result<()> {
        let name = if outcome.fence_presence == FencePresence::Released { "released.json" } else { "outcome.json" };
        let path = intent.evidence_dir.join(name);
        let raw = bytes(&path)?;
        let original: TaskOutcome = serde_json::from_slice(&raw)?;
        ensure!(
            equal(&original, outcome)?
                && original.task_id
                    == self.store.snapshot()?.assignments[&self.assignment_id].specification.task.task_id,
            "Harness outcome differs from original evidence"
        );
        let record = OutcomeRecord {
            original: FileReference { path: path.canonicalize()?, sha256: storage::hash(&raw) },
            stop: outcome.stop,
            fence_presence: outcome.fence_presence,
            runs: outcome.runs,
            observed_calls: outcome.observed_calls,
        };
        let state = self.store.snapshot()?;
        let specification = &state.assignments[&self.assignment_id].specification;
        let mut runs = Vec::new();
        for number in 1..=outcome.runs {
            let path = intent.evidence_dir.join(format!("run-{number}-admission.json"));
            if !path.exists() {
                continue;
            }
            let raw = bytes(&path)?;
            let admission: serde_json::Value = serde_json::from_slice(&raw)?;
            ensure!(
                admission["task_id"] == specification.task.task_id
                    && admission["session_path"] == serde_json::to_value(&specification.session_path)?
                    && admission["run_number"] == number,
                "observed native Run belongs to another Task or Session"
            );
            if let Some(session) = admission.get("session_id") {
                ensure!(
                    session == &serde_json::json!(specification.session_id),
                    "observed native Run Session identity changed"
                );
            }
            runs.push(RunReference {
                run_id: admission["run_id"].as_str().context("native Run ID absent")?.into(),
                run_number: number,
                admission: FileReference { path: path.canonicalize()?, sha256: storage::hash(&raw) },
            });
        }
        self.store.mutate(|state| {
            let a = self.assignment(state)?;
            let attempt = a
                .attempts
                .iter_mut()
                .find(|attempt| attempt.intent.attempt_id == intent.attempt_id)
                .context("outcome belongs to another dispatch")?;
            attempt.outcome = Some(record);
            attempt.runs = runs;
            a.phase = if outcome.fence_presence == FencePresence::Released && outcome.unknown_effects.is_empty() {
                Phase::Settled
            } else {
                Phase::RecoveryRequired
            };
            Store::event(state, &self.assignment_id, "harness_joined", clock_ms()?)
        })
    }
    /// Harvest the original released result after a crash between Harness join and queue publication.
    pub fn harvest_released(self) -> Result<Arc<TaskOutcome>> {
        let state = self.store.snapshot()?;
        let a = &state.assignments[&self.assignment_id];
        let _session = storage::Admission::released(&a.specification.session_path)?;
        ensure!(!has_prepared_continuation(a)?, "prepared continuation requires retry of its exact original intent");
        // Admission can fail before creating its new evidence directory. Find
        // the latest actual released result across all original attempts while
        // Session ownership proves no later admitted work remains fenced.
        let intent = a
            .attempts
            .iter()
            .rev()
            .find(|attempt| attempt.intent.evidence_dir.join("released.json").is_file())
            .context("no original released result")?
            .intent
            .clone();
        let actual_spec: TaskSpec = serde_json::from_slice(&bytes(&intent.evidence_dir.join("task.json"))?)?;
        let mut expected = a.specification.task.clone();
        expected.evidence_dir = intent.evidence_dir.clone();
        ensure!(equal(&actual_spec, &expected)?, "harvest Task terms differ from original intent");
        let authorization =
            crate::AuthorizationSnapshot::read(&crate::authorization_snapshot_path(&intent.evidence_dir))?;
        ensure!(
            authorization.task_id == expected.task_id
                && authorization.declaration["session"] == a.specification.session_id
                && authorization.declaration["state"] == serde_json::to_value(&a.specification.session_path)?,
            "harvest Session authority mismatch"
        );
        let outcome: TaskOutcome = serde_json::from_slice(&bytes(&intent.evidence_dir.join("released.json"))?)?;
        ensure!(
            outcome.fence_presence == FencePresence::Released && outcome.unknown_effects.is_empty(),
            "result is not released and settled"
        );
        let outcome = Arc::new(outcome);
        self.save_outcome(&intent, &outcome)?;
        Ok(outcome)
    }
}
impl DispatchHandle {
    pub fn cancel(&self) -> Result<()> {
        self.store.cancel(&self.assignment_id, clock_ms()?)
    }
    pub async fn wait(&self) -> Arc<DispatchReport> {
        let mut result = self.result.clone();
        loop {
            if let Some(report) = result.borrow().clone() {
                return report;
            }
            if result.changed().await.is_err() {
                return Arc::new(DispatchReport {
                    outcome: None,
                    error: Some("supervisor stopped before publication; inspect original dispatch intent".into()),
                });
            }
        }
    }
}
