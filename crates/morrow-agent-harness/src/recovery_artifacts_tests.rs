use super::*;
use crate::{storage::Admission, TaskKind, TaskSpec, ToolCallReconciliation};
use morrow_agent_core::{
    artifact_provenance::HostArtifactReceipt,
    rpi_ai::{Api, AssistantMessage, StopReason, ToolCall, ToolCallType, ToolResultMessage},
    RuntimePaths,
};

fn assistant(ids: &[&str]) -> AgentMessage {
    let mut message = AssistantMessage::empty(Api::OpenaiCompletions, "fixture", "model", 1);
    message.stop_reason = StopReason::ToolUse;
    message.content = ids
        .iter()
        .map(|id| {
            Content::ToolCall(ToolCall {
                kind: ToolCallType,
                id: (*id).into(),
                name: "write_file".into(),
                arguments: json!({"path":id}),
                thought_signature: None,
                namespace: None,
            })
        })
        .collect();
    AgentMessage::Assistant(Box::new(message))
}

fn result(id: &str, unknown: bool) -> AgentMessage {
    AgentMessage::ToolResult(Box::new(ToolResultMessage {
        role: Default::default(),
        tool_call_id: id.into(),
        tool_name: "write_file".into(),
        content: vec![Content::text("original result")],
        details: unknown.then(|| json!({"effects_unknown":true})),
        usage: None,
        added_tool_names: vec![],
        is_error: false,
        timestamp: 1,
    }))
}

struct Fixture {
    _directory: Option<tempfile::TempDir>,
    root: PathBuf,
    spec: TaskSpec,
    request: RunRequest,
    plans: Vec<RecoveryPlan>,
    settlement: ToolCallSettlement,
}

impl Fixture {
    fn new(legacy: bool) -> Self {
        Self::with_settlement(legacy, ToolCallSettlement::Completed { output: "Host checked actual effect".into() })
    }

    fn with_settlement(legacy: bool, settlement: ToolCallSettlement) -> Self {
        Self::with_options(legacy, settlement, "session-1", true)
    }

    fn with_options(legacy: bool, settlement: ToolCallSettlement, session_id: &str, open_calls: bool) -> Self {
        let retained = std::env::var_os("MORROW_RECOVERY_EVIDENCE");
        let directory = match &retained {
            Some(base) => {
                fs::create_dir_all(base).unwrap();
                tempfile::Builder::new().prefix("recovery-").tempdir_in(base).unwrap()
            }
            None => tempfile::tempdir().unwrap(),
        };
        let root = directory.path().canonicalize().unwrap();
        let directory = if retained.is_some() {
            let _ = directory.keep();
            eprintln!("Recovery evidence [{}] {}", std::thread::current().name().unwrap_or("fixture"), root.display());
            None
        } else {
            Some(directory)
        };
        let session = root.join("session.json");
        let spec = TaskSpec {
            task_id: "task-1".into(),
            criteria_revision: "criteria-1".into(),
            authorization_revision: "auth-1".into(),
            kind: TaskKind::Coding,
            evidence_dir: root.join("original"),
            max_runs: 8,
            max_calls: 32,
            deadline_unix_ms: 4_102_444_800_000,
        };
        let admission = Admission::acquire(&spec, &session, &json!({})).unwrap();
        let mut record = json!({"task_id":"task-1","run_id":"original","run_number":1,"session_path":session,
            "criteria_revision":"criteria-1","authorization_revision":"auth-1","remaining_calls":4});
        if !legacy {
            record["raw_start"] = json!(2);
            record["session_id"] = json!(session_id);
        }
        storage::write_new(&spec.evidence_dir.join("run-1-admission.json"), &record).unwrap();
        let messages = vec![
            assistant(&["prior"]),
            result("prior", false),
            assistant(if open_calls { &["done", "open-1", "open-2"] } else { &["done"] }),
            result("done", true),
        ];
        Journal::for_session(&session)
            .commit(
                json!({"version":2,"cwd":root,"messages":[],"raw_base":0,
            "pending_run":"original","completed_runs":[]}),
                0,
                &messages,
                &[],
            )
            .unwrap();
        drop(admission);
        let mut request = RunRequest::new(
            "resume",
            "Continue after settlement",
            RuntimePaths::new(&root, &session, root.join("environment")),
        );
        request.session_key = session_id.into();
        let mut fixture = Self { _directory: directory, root, spec, request, plans: Vec::new(), settlement };
        fixture.plans = fixture.takeover("first", 1).unwrap();
        fixture
    }

    fn takeover(&self, name: &str, consumed_runs: usize) -> Result<Vec<RecoveryPlan>> {
        let owner = Admission::fenced(&self.request.state_path)?;
        let mut spec = self.spec.clone();
        spec.evidence_dir = self.root.join(name);
        let evidence = storage::new_evidence(&spec)?;
        let interrupted = agent::interrupted_run(&self.request.state_path, &self.root)?;
        let receipt = ResumeReceipt {
            committed: true,
            settlement: Settlement::Settled,
            tool_calls: interrupted
                .iter()
                .flat_map(|run| &run.open_tool_calls)
                .map(|call| ToolCallReconciliation { call_id: call.id.clone(), settlement: self.settlement.clone() })
                .collect(),
            evidence: vec!["host-receipt:original-effect".into()],
        };
        let review = ResumeReview {
            task_id: spec.task_id.clone(),
            session_path: self.request.state_path.clone(),
            resume_evidence_dir: evidence.clone(),
            fenced_evidence_dir: PathBuf::from(owner.record["evidence_dir"].as_str().unwrap()),
            fence: owner.record.clone(),
            fenced_outcome: None,
            interrupted_run: interrupted,
            consumed_runs,
            consumed_calls: consumed_runs * 4,
        };
        let plans = prepare(&review, &self.request, &receipt)?;
        let record = json!({"version":1,"kind":"fenced_task_resume","fenced_evidence_dir":review.fenced_evidence_dir,
            "fence":review.fence,"consumed_runs":consumed_runs,"consumed_calls":consumed_runs*4,
            "interrupted_run":review.interrupted_run,"receipt":receipt,"artifact_recovery":plans});
        let admission = owner.take_over(&spec, &self.request.state_path, evidence, &json!({}), &record)?;
        drop(admission);
        Ok(plans)
    }

    fn child(&self, stage: &str) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "recovery_artifacts::tests::recovery_child", "--nocapture"])
            .env("MORROW_RECOVERY_CHILD_ROOT", &self.root)
            .env("MORROW_RECOVERY_CHILD_STAGE", stage)
            .output()
            .unwrap();
        fs::write(self.root.join(format!("child-{stage}.txt")), [&output.stdout[..], &output.stderr[..]].concat())
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(86),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn pending_successor(&self) {
        let journal = Journal::for_session(&self.request.state_path);
        let head = journal.open().unwrap();
        let mut messages = journal.read(0, head.raw_count, 8 * 1024 * 1024).unwrap();
        messages.push(assistant(&["successor-call"]));
        let mut metadata = head.metadata;
        metadata["pending_run"] = json!("successor");
        journal.commit(metadata, 0, &messages, &["original".into()]).unwrap();
        storage::write_new(&self.root.join("first/run-2-admission.json"), &json!({"task_id":"task-1","run_id":"successor",
            "run_number":2,"session_path":self.request.state_path,"raw_start":head.raw_count,"session_id":"session-1","remaining_calls":4})).unwrap();
    }
}

#[test]
fn recovery_child() {
    let Some(root) = std::env::var_os("MORROW_RECOVERY_CHILD_ROOT") else { return };
    let root = PathBuf::from(root);
    let stage = std::env::var("MORROW_RECOVERY_CHILD_STAGE").unwrap();
    let record: Value = serde_json::from_slice(&fs::read(root.join("first/resume.json")).unwrap()).unwrap();
    let plans: Vec<RecoveryPlan> = serde_json::from_value(record["artifact_recovery"].clone()).unwrap();
    let plan = &plans[0];
    let _owner = Admission::fenced(&plan.session_path).unwrap();
    if stage != "before-reconcile" {
        agent::reconcile_interrupted_run(
            &plan.session_path,
            &plan.cwd,
            &plan.inspected,
            &plan.receipt.tool_calls,
            &plan.receipt.evidence,
        )
        .unwrap();
    }
    if matches!(stage.as_str(), "partial" | "all") {
        let (_, artifacts) = settled_artifacts(plan).unwrap();
        let count = if stage == "partial" { 1 } else { artifacts.len() };
        for artifact in artifacts.iter().take(count) {
            crate::append_tool_artifact(&plan.target_evidence_dir, artifact).unwrap();
        }
    }
    if stage == "complete" {
        recover(&plans).unwrap();
    }
    // Terminate without unwinding or running resource destructors, at the
    // corresponding durable boundary of the production recovery sequence.
    std::process::exit(86);
}

#[test]
fn process_loss_at_each_publication_boundary_recovers_without_reconciliation_replay() {
    for legacy in [false, true] {
        for stage in ["before-reconcile", "after-reconcile", "partial", "all", "complete"] {
            let fixture = Fixture::new(legacy);
            let original_admission = fs::read(fixture.root.join("original/run-1-admission.json")).unwrap();
            fixture.child(stage);
            let plans = fixture.takeover("second", 1).unwrap();
            let owner = Admission::fenced(&fixture.request.state_path).unwrap();
            recover(&plans).unwrap();
            drop(owner);
            let plan = &fixture.plans[0];
            check_completed(plan).unwrap();
            let journal = Journal::for_session(&fixture.request.state_path);
            assert_eq!(journal.open().unwrap().raw_count, 6, "one result per original open call");
            assert!(agent::interrupted_run(&fixture.request.state_path, &fixture.root).unwrap().is_none());
            let artifacts = crate::read_tool_artifacts(&fixture.root.join("first")).unwrap();
            assert_eq!(artifacts.len(), if legacy { 2 } else { 3 });
            assert!(artifacts.iter().all(|artifact| artifact.run_id == "original"
                && artifact.task_id == "task-1"
                && artifact.session_id == "session-1"));
            assert!(artifacts.iter().all(|artifact| artifact.native_call_id != "prior"));
            if !legacy {
                assert_eq!(
                    artifacts.iter().find(|artifact| artifact.native_call_id == "done").unwrap().status,
                    ArtifactStatus::Unknown
                );
            }
            assert!(!fixture.root.join("second/tool-artifacts.jsonl").exists(), "target remains first takeover");
            assert_eq!(fs::read(fixture.root.join("original/run-1-admission.json")).unwrap(), original_admission);
            let second: Value =
                serde_json::from_slice(&fs::read(fixture.root.join("second/resume.json")).unwrap()).unwrap();
            assert_eq!(second["consumed_calls"], 4);
            assert_eq!(second["consumed_runs"], 1);
        }
    }
}

#[test]
fn successor_requires_old_batch_complete_and_preserves_distinct_run_plans() {
    for stage in ["partial", "all", "complete"] {
        let fixture = Fixture::new(false);
        fixture.child(stage);
        fixture.pending_successor();
        let prepared = fixture.takeover("second", 2);
        if stage == "partial" {
            assert!(prepared.is_err());
            assert_eq!(
                agent::interrupted_run(&fixture.request.state_path, &fixture.root).unwrap().unwrap().run_id,
                "successor"
            );
            continue;
        }
        let plans = prepared.unwrap();
        assert_eq!(plans.len(), if stage == "all" { 2 } else { 1 });
        let _owner = Admission::fenced(&fixture.request.state_path).unwrap();
        recover(&plans).unwrap();
        check_completed(&fixture.plans[0]).unwrap();
        let old = crate::read_tool_artifacts(&fixture.root.join("first")).unwrap();
        let new = crate::read_tool_artifacts(&fixture.root.join("second")).unwrap();
        assert!(old.iter().all(|artifact| artifact.run_id == "original"));
        assert_eq!(new.len(), 1);
        assert_eq!(new[0].run_id, "successor");
        assert_eq!(new[0].native_call_id, "successor-call");
    }
}

#[test]
fn publication_retry_preserves_verified_revoked_and_refuses_source_conflicts() {
    let fixture = Fixture::new(false);
    fixture.child("all");
    let directory = &fixture.root.join("first");
    let candidate = crate::read_tool_artifacts(directory)
        .unwrap()
        .into_iter()
        .find(|artifact| artifact.native_call_id == "open-1")
        .unwrap();
    let verified = candidate
        .verify(HostArtifactReceipt {
            receipt_id: "host-confirmed".into(),
            artifact_id: candidate.artifact_id.clone(),
            task_id: candidate.task_id.clone(),
            session_id: candidate.session_id.clone(),
            run_id: candidate.run_id.clone(),
            native_call_id: candidate.native_call_id.clone(),
            input_sha256: candidate.input_sha256.clone(),
            output_sha256: candidate.output_sha256.clone(),
            verifier: "host".into(),
            verifier_version: "1".into(),
            verified_at: "1".into(),
            committed: true,
            settled: true,
        })
        .unwrap();
    crate::append_tool_artifact(directory, &verified).unwrap();
    recover(&fixture.plans).unwrap();
    let mut revoked = verified;
    revoked.revoke().unwrap();
    crate::append_tool_artifact(directory, &revoked).unwrap();
    let before = fs::read(crate::tool_artifacts_path(directory)).unwrap();
    recover(&fixture.plans).unwrap();
    assert_eq!(before, fs::read(crate::tool_artifacts_path(directory)).unwrap());
    let path = crate::tool_artifacts_path(directory);
    let original = fs::read_to_string(&path).unwrap();
    let changed =
        original.replacen("\"artifact_ref\":\"journal/2/result-3\"", "\"artifact_ref\":\"journal/2/result-9\"", 1);
    assert_ne!(changed, original);
    fs::write(&path, changed).unwrap();
    assert!(recover(&fixture.plans).is_err());
}

#[test]
fn tampered_target_plan_and_original_source_are_refused() {
    for mutation in ["target", "task", "session", "run", "index", "receipt", "proof"] {
        let fixture = Fixture::new(false);
        let mut record: Value =
            serde_json::from_slice(&fs::read(fixture.root.join("first/resume.json")).unwrap()).unwrap();
        let plan = &mut record["artifact_recovery"][0];
        match mutation {
            "target" => {
                plan["target_evidence_dir"] = json!(fixture.root.join("unrelated"));
                fs::create_dir(fixture.root.join("unrelated")).unwrap();
            }
            "task" => plan["task_id"] = json!("other-task"),
            "session" => plan["session_id"] = json!("other-session"),
            "run" => plan["inspected"]["run_id"] = json!("other-run"),
            "index" => plan["calls"][0]["result_raw_index"] = json!(99),
            "receipt" => plan["receipt"]["tool_calls"][0]["settlement"]["output"] = json!("different"),
            "proof" => plan["source_proof"] = json!("changed"),
            _ => unreachable!(),
        }
        fs::write(fixture.root.join("first/resume.json"), serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(fixture.takeover("second", 1).is_err(), "{mutation}");
        assert!(agent::interrupted_run(&fixture.request.state_path, &fixture.root).unwrap().is_some());
    }
}

#[test]
fn failed_and_not_executed_settlements_survive_restart_without_duplicate_results() {
    for settlement in
        [ToolCallSettlement::Failed { output: "Host observed failure".into() }, ToolCallSettlement::NotExecuted]
    {
        for stage in ["before-reconcile", "after-reconcile"] {
            let fixture = Fixture::with_settlement(false, settlement.clone());
            fixture.child(stage);
            let plans = fixture.takeover("second", 1).unwrap();
            let _owner = Admission::fenced(&fixture.request.state_path).unwrap();
            recover(&plans).unwrap();
            let journal = Journal::for_session(&fixture.request.state_path);
            let before = journal.proof(0, 6).unwrap();
            recover(&plans).unwrap();
            assert_eq!(journal.open().unwrap().raw_count, 6);
            assert_eq!(journal.proof(0, 6).unwrap(), before);
            let results = journal.read(4, 6, 1024 * 1024).unwrap();
            for (result, id) in results.iter().zip(["open-1", "open-2"]) {
                let AgentMessage::ToolResult(result) = result else { panic!("expected durable ToolResult") };
                assert!(result.is_error);
                assert_eq!(result.tool_call_id, id);
                assert_eq!(result.details.as_ref().unwrap()["settlement"], json!(settlement));
            }
            let artifacts = crate::read_tool_artifacts(&fixture.root.join("first")).unwrap();
            assert_eq!(artifacts.len(), 3);
            assert!(artifacts
                .iter()
                .filter(|artifact| artifact.native_call_id.starts_with("open-"))
                .all(|artifact| { artifact.status == ArtifactStatus::Candidate && artifact.run_id == "original" }));
            check_completed(&fixture.plans[0]).unwrap();
        }
    }
}

#[test]
fn old_resume_without_recovery_field_is_supported_and_malformed_new_fields_are_refused() {
    for value in [None, Some(Value::Null), Some(json!({})), Some(json!([{}]))] {
        let fixture = Fixture::new(true);
        let path = fixture.root.join("first/resume.json");
        let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        match &value {
            None => {
                record.as_object_mut().unwrap().remove("artifact_recovery");
            }
            Some(value) => record["artifact_recovery"] = value.clone(),
        }
        fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
        let prepared = fixture.takeover("second", 1);
        if value.is_some() {
            assert!(prepared.is_err());
            assert!(agent::interrupted_run(&fixture.request.state_path, &fixture.root).unwrap().is_some());
            continue;
        }
        let plans = prepared.unwrap();
        let _owner = Admission::fenced(&fixture.request.state_path).unwrap();
        recover(&plans).unwrap();
        let artifacts = crate::read_tool_artifacts(&fixture.root.join("second")).unwrap();
        assert_eq!(artifacts.len(), 2);
        assert!(artifacts.iter().all(|artifact| artifact.native_call_id.starts_with("open-")));
    }
}

#[test]
fn modified_journal_bytes_refuse_publication() {
    let fixture = Fixture::new(false);
    fixture.child("after-reconcile");
    let path = session_journal::directory(&fixture.request.state_path).join("segment-00000000.jsonl");
    let original = fs::read_to_string(&path).unwrap();
    let changed = original.replacen("original result", "tampered result", 1);
    assert_ne!(original, changed);
    assert_eq!(original.len(), changed.len());
    fs::write(path, changed).unwrap();
    assert!(recover(&fixture.plans).is_err());
    assert!(!fixture.plans[0].marker().exists());
    assert!(!crate::tool_artifacts_path(&fixture.root.join("first")).exists());
}

#[test]
fn empty_native_session_identity_preserves_reconciliation_and_records_unavailable_artifacts() {
    for legacy in [false, true] {
        for open_calls in [false, true] {
            for stage in ["before-reconcile", "after-reconcile"] {
                let fixture = Fixture::with_options(
                    legacy,
                    ToolCallSettlement::Completed { output: "Host observed committed effect".into() },
                    "",
                    open_calls,
                );
                fixture.child(stage);
                let plans = fixture.takeover("second", 1).unwrap();
                let _owner = Admission::fenced(&fixture.request.state_path).unwrap();
                recover(&plans).unwrap();
                recover(&plans).unwrap();
                assert!(agent::interrupted_run(&fixture.request.state_path, &fixture.root).unwrap().is_none());
                let journal = Journal::for_session(&fixture.request.state_path);
                assert!(journal.contains_run("original").unwrap());
                assert_eq!(journal.open().unwrap().raw_count, if open_calls { 6 } else { 4 });
                let plan = &fixture.plans[0];
                assert!(plan.session_id.is_empty());
                assert!(matches!(plan.coverage, Coverage::UnavailableSession { .. }));
                check_completed(plan).unwrap();
                let completion: Completion = serde_json::from_slice(&fs::read(plan.marker()).unwrap()).unwrap();
                assert!(matches!(completion.coverage, Coverage::UnavailableSession { .. }));
                assert!(completion.artifact_ids.is_empty());
                assert!(!crate::tool_artifacts_path(&fixture.root.join("first")).exists());
            }
        }
    }
}

#[test]
fn legacy_resume_without_plan_recovers_already_committed_reconciliation() {
    for legacy in [false, true] {
        for stage in ["prepared", "partial", "complete"] {
            let fixture = Fixture::new(legacy);
            fixture.child("after-reconcile");
            let path = fixture.root.join("first/resume.json");
            let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            record.as_object_mut().unwrap().remove("artifact_recovery");
            let original_record = serde_json::to_vec(&record).unwrap();
            fs::write(&path, &original_record).unwrap();
            let plans = fixture.takeover("second", 1).unwrap();
            assert_eq!(plans.len(), 1);
            let plan = &plans[0];
            assert_eq!(plan.target_evidence_dir, fixture.root.join("second"));
            assert_eq!(plan.previous_reconciliation.as_ref().unwrap().evidence_dir, fixture.root.join("first"));
            assert_eq!(plan.receipt.tool_calls.len(), 2);
            if stage == "partial" {
                let (_, artifacts) = settled_artifacts(plan).unwrap();
                crate::append_tool_artifact(&plan.target_evidence_dir, &artifacts[0]).unwrap();
            }
            if stage == "complete" {
                let _owner = Admission::fenced(&fixture.request.state_path).unwrap();
                recover(&plans).unwrap();
            }
            let inherited = fixture.takeover("third", 1).unwrap();
            let _owner = Admission::fenced(&fixture.request.state_path).unwrap();
            recover(&inherited).unwrap();
            check_completed(plan).unwrap();
            assert_eq!(Journal::for_session(&fixture.request.state_path).open().unwrap().raw_count, 6);
            assert_eq!(fs::read(path).unwrap(), original_record);
            assert_eq!(
                crate::read_tool_artifacts(&fixture.root.join("second")).unwrap().len(),
                if legacy { 2 } else { 3 }
            );
            assert!(!crate::tool_artifacts_path(&fixture.root.join("first")).exists());
            assert!(!crate::tool_artifacts_path(&fixture.root.join("third")).exists());
        }
    }
}

#[test]
fn historical_reconciliation_source_changes_are_refused() {
    let fixture = Fixture::new(true);
    fixture.child("after-reconcile");
    let path = fixture.root.join("first/resume.json");
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record.as_object_mut().unwrap().remove("artifact_recovery");
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let plans = fixture.takeover("second", 1).unwrap();
    record["receipt"]["evidence"] = json!(["different-host-receipt"]);
    fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    let _owner = Admission::fenced(&fixture.request.state_path).unwrap();
    assert!(recover(&plans).is_err());
    assert!(!crate::tool_artifacts_path(&fixture.root.join("second")).exists());
    assert!(!plans[0].marker().exists());
}
