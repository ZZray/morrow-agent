use std::fs;

use fs2::FileExt;
use morrow_agent_harness::{
    append_skill_provenance, append_tool_artifact,
    core::artifact_provenance::{
        parse_provenance_time_ms, sha256_hex, ArtifactStatus, HostArtifactReceipt, SkillArtifactBinding,
        SkillProvenance, SkillValidationReceipt, ToolArtifact,
    },
    query_provenance, skill_provenance_path, tool_artifacts_path, EvidenceScope, ProvenanceKind, ProvenanceQuery,
    ProvenanceRecord, ProvenanceScopeErrorKind, ProvenanceSourceState, ProvenanceStatus,
};

fn populated_scope(root: &std::path::Path, task: &str, time: &str) -> (EvidenceScope, ToolArtifact, SkillProvenance) {
    let scope =
        EvidenceScope { task_id: task.into(), session_id: format!("session-{task}"), evidence_dir: root.join(task) };
    fs::create_dir(&scope.evidence_dir).unwrap();
    let candidate = ToolArtifact {
        version: ToolArtifact::VERSION,
        artifact_id: "same-artifact-id".into(),
        task_id: scope.task_id.clone(),
        session_id: scope.session_id.clone(),
        run_id: "run-1".into(),
        native_call_id: "exec-1".into(),
        tool: "exec".into(),
        input_sha256: "a".repeat(64),
        output_sha256: "b".repeat(64),
        artifact_ref: "journal/1/result-2".into(),
        status: ArtifactStatus::Candidate,
        created_at: time.into(),
        host_receipt: None,
    };
    append_tool_artifact(&scope.evidence_dir, &candidate).unwrap();
    let artifact = candidate
        .verify(HostArtifactReceipt {
            receipt_id: format!("host-{task}"),
            artifact_id: candidate.artifact_id.clone(),
            task_id: candidate.task_id.clone(),
            session_id: candidate.session_id.clone(),
            run_id: candidate.run_id.clone(),
            native_call_id: candidate.native_call_id.clone(),
            input_sha256: candidate.input_sha256.clone(),
            output_sha256: candidate.output_sha256.clone(),
            verifier: "host".into(),
            verifier_version: "1".into(),
            verified_at: "1970-01-01T00:00:01Z".into(),
            committed: true,
            settled: true,
        })
        .unwrap();
    append_tool_artifact(&scope.evidence_dir, &artifact).unwrap();
    let receipt = SkillValidationReceipt {
        receipt_id: format!("skill-host-{task}"),
        skill_name: "skill-one".into(),
        bundle_hash: "c".repeat(64),
        source_artifacts: vec![SkillArtifactBinding {
            artifact_id: artifact.artifact_id.clone(),
            host_receipt_id: artifact.host_receipt.as_ref().unwrap().receipt_id.clone(),
            input_sha256: artifact.input_sha256.clone(),
            output_sha256: artifact.output_sha256.clone(),
        }],
        task_id: scope.task_id.clone(),
        session_id: scope.session_id.clone(),
        run_id: "run-1".into(),
        verifier: "host".into(),
        verifier_version: "1".into(),
        verified_at: "1970-01-01T00:00:01Z".into(),
        committed: true,
        settled: true,
    };
    let skill = SkillProvenance::verified(
        "skill-one".into(),
        "c".repeat(64),
        std::slice::from_ref(&artifact),
        vec![receipt],
        "host".into(),
        "1".into(),
        "1970-01-01T01:00:01+01:00".into(),
    )
    .unwrap();
    append_skill_provenance(&scope.evidence_dir, &skill).unwrap();
    (scope, artifact, skill)
}

#[test]
fn authorized_scopes_filter_without_collision_or_index_and_return_exact_originals() {
    let directory = tempfile::tempdir().unwrap();
    let (first, _, _) = populated_scope(directory.path(), "task-1", "1000");
    let (second, _, _) = populated_scope(directory.path(), "task-2", "1000");
    let (unauthorized, _, _) = populated_scope(directory.path(), "task-3", "1000");
    fs::write(tool_artifacts_path(&unauthorized.evidence_dir), "unreadable unauthorized data").unwrap();
    let scopes = [first.clone(), second];
    let all = query_provenance(&scopes, &ProvenanceQuery::default()).unwrap();
    assert!(all.scope_errors.is_empty());
    assert_eq!(all.entries.len(), 4);
    for entry in &all.entries {
        assert_eq!(entry.source_state, ProvenanceSourceState::HostReceiptBound);
        assert_eq!(entry.source_files.len(), if matches!(entry.record, ProvenanceRecord::Skill(_)) { 2 } else { 1 });
        for source in &entry.source_files {
            assert!(source.path.starts_with(entry.scope.evidence_dir.canonicalize().unwrap()));
            assert_eq!(source.sha256, sha256_hex(&fs::read(&source.path).unwrap()));
        }
    }
    assert_eq!(all, query_provenance(&scopes, &ProvenanceQuery::default()).unwrap());
    let filters = [
        (ProvenanceQuery { task_id: Some("task-1".into()), ..Default::default() }, 2),
        (ProvenanceQuery { session_id: Some("session-task-2".into()), ..Default::default() }, 2),
        (ProvenanceQuery { task_id: Some("task-3".into()), ..Default::default() }, 0),
        (ProvenanceQuery { kind: Some(ProvenanceKind::Artifact), ..Default::default() }, 2),
        (ProvenanceQuery { artifact_id: Some("same-artifact-id".into()), ..Default::default() }, 4),
        (ProvenanceQuery { skill_name: Some("skill-one".into()), ..Default::default() }, 2),
        (ProvenanceQuery { bundle_hash: Some("c".repeat(64)), ..Default::default() }, 2),
        (ProvenanceQuery { host_receipt_id: Some("host-task-1".into()), ..Default::default() }, 2),
        (ProvenanceQuery { host_receipt_id: Some("skill-host-task-1".into()), ..Default::default() }, 1),
        (ProvenanceQuery { run_id: Some("other-run".into()), ..Default::default() }, 0),
        (ProvenanceQuery { status: Some(ProvenanceStatus::Candidate), ..Default::default() }, 0),
    ];
    for (query, count) in filters {
        let report = query_provenance(&scopes, &query).unwrap();
        assert!(report.scope_errors.is_empty(), "{query:?}");
        assert_eq!(report.entries.len(), count, "{query:?}");
    }
    assert!(query_provenance(&[], &ProvenanceQuery::default()).unwrap().entries.is_empty());
}

#[test]
fn legal_revocations_remain_queryable_with_source_status_and_unchanged_files() {
    let directory = tempfile::tempdir().unwrap();
    let (scope, mut artifact, mut skill) = populated_scope(directory.path(), "task-1", "1000");
    artifact.revoke().unwrap();
    append_tool_artifact(&scope.evidence_dir, &artifact).unwrap();
    let report = query_provenance(std::slice::from_ref(&scope), &ProvenanceQuery::default()).unwrap();
    assert!(report.scope_errors.is_empty());
    assert!(report.entries.iter().any(|entry| matches!(entry.record, ProvenanceRecord::Skill(_))
        && entry.source_state == ProvenanceSourceState::SourcesRevoked));
    skill.refresh_status(&"d".repeat(64)).unwrap();
    append_skill_provenance(&scope.evidence_dir, &skill).unwrap();
    let before = fs::read(skill_provenance_path(&scope.evidence_dir)).unwrap();
    let query = ProvenanceQuery { status: Some(ProvenanceStatus::Revoked), ..Default::default() };
    let report = query_provenance(std::slice::from_ref(&scope), &query).unwrap();
    assert!(report.scope_errors.is_empty());
    assert_eq!(report.entries.len(), 2);
    assert_eq!(fs::read(skill_provenance_path(&scope.evidence_dir)).unwrap(), before);
}

#[test]
fn candidates_unknown_effects_and_unreviewed_revocations_remain_unverified() {
    let directory = tempfile::tempdir().unwrap();
    let (scope, mut artifact, _) = populated_scope(directory.path(), "task-1", "1000");
    fs::remove_file(skill_provenance_path(&scope.evidence_dir)).unwrap();
    fs::remove_file(tool_artifacts_path(&scope.evidence_dir)).unwrap();
    artifact.status = ArtifactStatus::Candidate;
    artifact.host_receipt = None;
    append_tool_artifact(&scope.evidence_dir, &artifact).unwrap();
    let mut unknown = artifact.clone();
    unknown.artifact_id = "unknown-artifact".into();
    unknown.status = ArtifactStatus::Unknown;
    append_tool_artifact(&scope.evidence_dir, &unknown).unwrap();
    let report = query_provenance(std::slice::from_ref(&scope), &ProvenanceQuery::default()).unwrap();
    assert!(report.scope_errors.is_empty());
    assert_eq!(report.entries.len(), 2);
    assert!(report.entries.iter().all(|entry| entry.source_state == ProvenanceSourceState::Unverified));
    artifact.revoke().unwrap();
    append_tool_artifact(&scope.evidence_dir, &artifact).unwrap();
    for status in [ProvenanceStatus::Unknown, ProvenanceStatus::Revoked] {
        let query = ProvenanceQuery { status: Some(status), ..Default::default() };
        let report = query_provenance(std::slice::from_ref(&scope), &query).unwrap();
        assert!(report.scope_errors.is_empty());
        assert_eq!(report.entries.len(), 1);
        assert_eq!(report.entries[0].source_state, ProvenanceSourceState::Unverified);
    }
}

#[test]
fn missing_or_damaged_sources_report_scope_errors_and_other_tasks_continue() {
    let directory = tempfile::tempdir().unwrap();
    let (good, _, _) = populated_scope(directory.path(), "good", "1000");
    let (missing, _, _) = populated_scope(directory.path(), "missing", "1000");
    fs::remove_file(tool_artifacts_path(&missing.evidence_dir)).unwrap();
    let (damaged, _, _) = populated_scope(directory.path(), "damaged", "1000");
    fs::write(tool_artifacts_path(&damaged.evidence_dir), "{broken\n").unwrap();
    let (wrong_scope, _, _) = populated_scope(directory.path(), "wrong-scope", "1000");
    let wrong_scope = EvidenceScope { task_id: "another-task".into(), ..wrong_scope };
    let empty = EvidenceScope {
        task_id: "old-task".into(),
        session_id: "old-session".into(),
        evidence_dir: directory.path().join("old"),
    };
    fs::create_dir(&empty.evidence_dir).unwrap();
    let absent = EvidenceScope { evidence_dir: directory.path().join("absent"), ..empty.clone() };
    let report =
        query_provenance(&[missing, damaged, good.clone(), wrong_scope, empty, absent], &ProvenanceQuery::default())
            .unwrap();
    assert_eq!(report.entries.len(), 2);
    assert!(report.entries.iter().all(|entry| entry.scope == good));
    assert_eq!(
        report.scope_errors.iter().map(|error| error.kind).collect::<Vec<_>>(),
        vec![
            ProvenanceScopeErrorKind::InvalidSource,
            ProvenanceScopeErrorKind::InvalidLedger,
            ProvenanceScopeErrorKind::IdentityMismatch,
            ProvenanceScopeErrorKind::Unavailable,
        ]
    );
}

#[test]
fn source_errors_survive_record_and_time_filters_and_detect_changed_bindings() {
    let directory = tempfile::tempdir().unwrap();
    let (scope, _, _) = populated_scope(directory.path(), "task-1", "1000");
    let path = skill_provenance_path(&scope.evidence_dir);
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["validation_receipts"][0]["source_artifacts"][0]["input_sha256"] = serde_json::json!("d".repeat(64));
    fs::write(&path, format!("{record}\n")).unwrap();
    for query in [
        ProvenanceQuery::default(),
        ProvenanceQuery { kind: Some(ProvenanceKind::Artifact), ..Default::default() },
        ProvenanceQuery { time_to_ms: Some(0), ..Default::default() },
        ProvenanceQuery { skill_name: Some("unrelated".into()), ..Default::default() },
    ] {
        let report = query_provenance(std::slice::from_ref(&scope), &query).unwrap();
        assert!(report.entries.is_empty());
        assert_eq!(report.scope_errors.len(), 1);
        assert_eq!(report.scope_errors[0].kind, ProvenanceScopeErrorKind::InvalidSource);
    }
    fs::remove_file(tool_artifacts_path(&scope.evidence_dir)).unwrap();
    let query = ProvenanceQuery { kind: Some(ProvenanceKind::Artifact), ..Default::default() };
    let report = query_provenance(&[scope], &query).unwrap();
    assert!(report.entries.is_empty());
    assert_eq!(report.scope_errors[0].kind, ProvenanceScopeErrorKind::InvalidSource);
}

#[test]
fn duplicate_scopes_and_directory_aliases_are_deduplicated_and_conflicts_are_explicit() {
    let directory = tempfile::tempdir().unwrap();
    let (scope, _, _) = populated_scope(directory.path(), "task-1", "1000");
    let alias = directory.path().join("alias");
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&scope.evidence_dir, &alias).unwrap_or_else(|_| {
        // Directory junctions work on Windows without symbolic-link privilege.
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&alias)
            .arg(&scope.evidence_dir)
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    });
    #[cfg(unix)]
    std::os::unix::fs::symlink(&scope.evidence_dir, &alias).unwrap();
    let aliased = EvidenceScope { evidence_dir: alias, ..scope.clone() };
    let conflicting = EvidenceScope { task_id: "other-task".into(), ..scope.clone() };
    let report = query_provenance(&[scope.clone(), aliased, conflicting, scope], &ProvenanceQuery::default()).unwrap();
    assert_eq!(report.entries.len(), 2);
    assert_eq!(report.scope_errors.len(), 1);
    assert_eq!(report.scope_errors[0].kind, ProvenanceScopeErrorKind::IdentityMismatch);
}

#[test]
fn invalid_scopes_cannot_suppress_a_later_valid_grant_for_the_same_directory() {
    let cwd = std::env::current_dir().unwrap();
    let directory = tempfile::tempdir_in(&cwd).unwrap();
    let (scope, _, _) = populated_scope(directory.path(), "task-1", "1000");
    let relative =
        EvidenceScope { evidence_dir: scope.evidence_dir.strip_prefix(&cwd).unwrap().to_path_buf(), ..scope.clone() };
    let wrong_identity = EvidenceScope { task_id: "wrong-task".into(), ..scope.clone() };
    let report =
        query_provenance(&[relative, wrong_identity, scope.clone(), scope], &ProvenanceQuery::default()).unwrap();
    assert_eq!(report.entries.len(), 2);
    assert_eq!(
        report.scope_errors.iter().map(|error| error.kind).collect::<Vec<_>>(),
        vec![ProvenanceScopeErrorKind::InvalidScope, ProvenanceScopeErrorKind::IdentityMismatch,]
    );
}

#[test]
fn time_filters_accept_epoch_and_rfc3339_and_reject_unknown_times_only_when_needed() {
    assert_eq!(parse_provenance_time_ms("1000").unwrap(), 1000);
    assert_eq!(parse_provenance_time_ms("1970-01-01T01:00:01+01:00").unwrap(), 1000);
    assert!(parse_provenance_time_ms("9223372036854775808").is_err());
    assert!(parse_provenance_time_ms("opaque-time").is_err());
    let directory = tempfile::tempdir().unwrap();
    let (scope, _, _) = populated_scope(directory.path(), "task-1", "1000");
    for (from, to, count) in [(1000, 1001, 2), (0, 1000, 0), (1001, 2000, 0), (1000, 1000, 0)] {
        let query = ProvenanceQuery { time_from_ms: Some(from), time_to_ms: Some(to), ..Default::default() };
        let report = query_provenance(std::slice::from_ref(&scope), &query).unwrap();
        assert!(report.scope_errors.is_empty());
        assert_eq!(report.entries.len(), count);
    }
    assert!(query_provenance(
        std::slice::from_ref(&scope),
        &ProvenanceQuery { time_from_ms: Some(2), time_to_ms: Some(1), ..Default::default() }
    )
    .is_err());
    let (old, _, _) = populated_scope(directory.path(), "opaque", "old-label");
    assert!(query_provenance(std::slice::from_ref(&old), &ProvenanceQuery::default()).unwrap().scope_errors.is_empty());
    let query = ProvenanceQuery { time_from_ms: Some(0), ..Default::default() };
    let report = query_provenance(&[old, scope], &query).unwrap();
    assert_eq!(report.entries.len(), 2);
    assert_eq!(report.scope_errors.len(), 1);
    assert_eq!(report.scope_errors[0].kind, ProvenanceScopeErrorKind::InvalidTime);
}

#[test]
fn concurrent_readers_share_the_lock_and_a_writer_is_reported_without_hiding_other_scopes() {
    let directory = tempfile::tempdir().unwrap();
    let (scope, _, _) = populated_scope(directory.path(), "task-1", "1000");
    let (other, _, _) = populated_scope(directory.path(), "task-2", "1000");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let scope = scope.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let report = query_provenance(&[scope], &ProvenanceQuery::default()).unwrap();
                assert!(report.scope_errors.is_empty());
                assert_eq!(report.entries.len(), 2);
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let file =
        fs::OpenOptions::new().read(true).write(true).open(scope.evidence_dir.join(".morrow-provenance.lock")).unwrap();
    FileExt::try_lock_exclusive(&file).unwrap();
    let report = query_provenance(&[scope, other.clone()], &ProvenanceQuery::default()).unwrap();
    assert_eq!(report.scope_errors.len(), 1);
    assert_eq!(report.scope_errors[0].kind, ProvenanceScopeErrorKind::Busy);
    assert_eq!(report.entries.len(), 2);
    assert!(report.entries.iter().all(|entry| entry.scope == other));
}

#[test]
fn provenance_query_reopens_original_ledgers_in_a_fresh_process() {
    const CHILD_INPUT: &str = "MORROW_PROVENANCE_QUERY_RESTART";
    if let Some(input) = std::env::var_os(CHILD_INPUT) {
        let input = std::path::PathBuf::from(input);
        let (scopes, query): (Vec<EvidenceScope>, ProvenanceQuery) =
            serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
        let report = query_provenance(&scopes, &query).unwrap();
        assert!(report.scope_errors.is_empty());
        assert_eq!(report.entries.len(), 2);
        for entry in &report.entries {
            for reference in &entry.source_files {
                assert_eq!(reference.sha256, sha256_hex(&fs::read(&reference.path).unwrap()));
            }
        }
        fs::write(input.with_extension("result.json"), serde_json::to_vec(&report).unwrap()).unwrap();
        println!("provenance_query_fresh_process_verified");
        return;
    }
    let retained = std::env::var_os("MORROW_PROVENANCE_QUERY_EVIDENCE");
    let directory = if let Some(root) = &retained {
        fs::create_dir_all(root).unwrap();
        tempfile::Builder::new().prefix("query-restart-").tempdir_in(root).unwrap()
    } else {
        tempfile::tempdir().unwrap()
    };
    let (root, _temporary) =
        if retained.is_some() { (directory.keep(), None) } else { (directory.path().to_path_buf(), Some(directory)) };
    let (scope, mut artifact, _) = populated_scope(&root, "task-1", "1000");
    artifact.revoke().unwrap();
    append_tool_artifact(&scope.evidence_dir, &artifact).unwrap();
    let query = ProvenanceQuery { artifact_id: Some(artifact.artifact_id), ..Default::default() };
    let expected = query_provenance(std::slice::from_ref(&scope), &query).unwrap();
    assert!(expected.scope_errors.is_empty());
    let request = root.join("request.json");
    fs::write(&request, serde_json::to_vec(&(vec![scope], query)).unwrap()).unwrap();
    let executable = std::env::current_exe().unwrap();
    fs::write(
        root.join("identity.json"),
        serde_json::to_vec(&serde_json::json!({
            "executable":executable,"sha256":sha256_hex(&fs::read(&executable).unwrap()),
            "test":"provenance_query_reopens_original_ledgers_in_a_fresh_process"
        }))
        .unwrap(),
    )
    .unwrap();
    let output = std::process::Command::new(executable)
        .args(["--exact", "provenance_query_reopens_original_ledgers_in_a_fresh_process", "--nocapture"])
        .env(CHILD_INPUT, &request)
        .output()
        .unwrap();
    fs::write(root.join("child-stdout.txt"), &output.stdout).unwrap();
    fs::write(root.join("child-stderr.txt"), &output.stderr).unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("provenance_query_fresh_process_verified"));
    let reopened: morrow_agent_harness::ProvenanceQueryReport =
        serde_json::from_slice(&fs::read(request.with_extension("result.json")).unwrap()).unwrap();
    assert_eq!(reopened, expected);
}
