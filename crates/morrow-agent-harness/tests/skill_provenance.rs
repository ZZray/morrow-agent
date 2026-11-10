mod common;

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Barrier, Mutex},
    time::Duration,
};

use anyhow::{ensure, Result};
use async_trait::async_trait;
use common::{call, text, Fault, Host, Provider};
use morrow_agent_harness::{
    core::{
        artifact_provenance::{
            HostArtifactReceipt, SkillArtifactBinding, SkillProvenance, SkillProvenanceStatus, SkillValidationReceipt,
        },
        environment_library::{self, Roots},
        RunRequest,
    },
    *,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

const NAME: &str = "proof-skill";

struct SkillHost {
    inner: Host,
    roots: Roots,
    recorded: Mutex<Option<SkillProvenance>>,
}

#[async_trait]
impl HarnessHost for SkillHost {
    async fn verify(&self, candidate: Candidate, _: CancellationToken) -> Result<ReviewReceipt> {
        let proof = self.roots.project_skills.join(NAME).join("proof.txt");
        ensure!(fs::read(&proof)? == b"skill-proof", "actual skill resource differs");
        Ok(ReviewReceipt {
            basis: candidate.basis,
            committed: true,
            settlement: Settlement::Settled,
            verdict: Verdict::Verified,
            evidence: vec![proof.display().to_string()],
        })
    }

    async fn review_artifacts(&self, basis: ReviewBasis, _: CancellationToken) -> Result<Vec<ArtifactReceiptRef>> {
        let directory = basis.events_path.parent().unwrap();
        let candidate = read_tool_artifacts(directory)?
            .into_iter()
            .find(|artifact| artifact.native_call_id == "exec-proof")
            .unwrap();
        let artifact = candidate.verify(HostArtifactReceipt {
            receipt_id: "exec-checked".into(),
            artifact_id: candidate.artifact_id.clone(),
            task_id: candidate.task_id.clone(),
            session_id: candidate.session_id.clone(),
            run_id: candidate.run_id.clone(),
            native_call_id: candidate.native_call_id.clone(),
            input_sha256: candidate.input_sha256.clone(),
            output_sha256: candidate.output_sha256.clone(),
            verifier: "skill-test-host".into(),
            verifier_version: "1".into(),
            verified_at: "2026-11-11T10:00:00Z".into(),
            committed: true,
            settled: true,
        })?;
        append_tool_artifact(directory, &artifact)?;
        let current = core::skill_library::read_verification(&self.roots, "project", NAME)?;
        let validation = SkillValidationReceipt {
            receipt_id: "skill-checked".into(),
            skill_name: NAME.into(),
            bundle_hash: current.bundle_hash,
            source_artifacts: vec![SkillArtifactBinding {
                artifact_id: artifact.artifact_id.clone(),
                host_receipt_id: "exec-checked".into(),
                input_sha256: artifact.input_sha256.clone(),
                output_sha256: artifact.output_sha256.clone(),
            }],
            task_id: basis.task_id.clone(),
            session_id: basis.session_id.clone(),
            run_id: basis.run_id.clone(),
            verifier: "skill-test-host".into(),
            verifier_version: "1".into(),
            verified_at: "2026-11-11T10:00:01Z".into(),
            committed: true,
            settled: true,
        };
        let record = record_skill_verification(
            directory,
            &basis,
            &self.roots,
            "project",
            NAME,
            "verify-proof",
            vec![validation],
        )?;
        *self.recorded.lock().unwrap() = Some(record);
        Ok(vec![ArtifactReceiptRef {
            artifact_id: artifact.artifact_id,
            artifact_ref: artifact.artifact_ref,
            task_id: artifact.task_id,
            session_id: artifact.session_id,
            run_id: artifact.run_id,
            native_call_id: artifact.native_call_id,
            input_sha256: artifact.input_sha256,
            output_sha256: artifact.output_sha256,
            status: artifact.status,
        }])
    }

    async fn prepare_continuation(&self, _: Continuation, _: CancellationToken) -> Result<RunRequest> {
        anyhow::bail!("fixture must finish in one Run")
    }
}

struct Fixture {
    _directory: Option<tempfile::TempDir>,
    root: PathBuf,
    roots: Roots,
    evidence: PathBuf,
    record: SkillProvenance,
    basis: ReviewBasis,
}

impl Fixture {
    async fn run() -> Self {
        Self::run_with_grouped_tools(false).await
    }

    async fn run_with_grouped_tools(grouped: bool) -> Self {
        let retained = std::env::var_os("MORROW_SKILL_EVIDENCE");
        let directory = match &retained {
            Some(base) => {
                fs::create_dir_all(base).unwrap();
                tempfile::Builder::new().prefix("skill-").tempdir_in(base).unwrap()
            }
            None => tempfile::tempdir().unwrap(),
        };
        let root = directory.path().canonicalize().unwrap();
        let directory = if retained.is_some() {
            let _ = directory.keep();
            eprintln!("Skill evidence [{}] {}", std::thread::current().name().unwrap_or("fixture"), root.display());
            None
        } else {
            Some(directory)
        };
        fs::create_dir(root.join(".git")).unwrap();
        let roots = environment_library::resolve(&root.join("environment"), &root, None).unwrap();
        // The provider knows the deterministic bundle it asks skill_create to
        // write. The production reader and Journal validate the actual bytes.
        let doc = "---\nname: \"proof-skill\"\ndescription: \"Read proof\"\n---\n\nRead proof.txt.\n";
        let mut digest = Sha256::new();
        for (path, bytes) in [("SKILL.md", doc.as_bytes()), ("proof.txt", b"skill-proof".as_slice())] {
            digest.update((path.len() as u64).to_be_bytes());
            digest.update(path.as_bytes());
            digest.update((bytes.len() as u64).to_be_bytes());
            digest.update(bytes);
        }
        let hash = format!("{:x}", digest.finalize());
        let command = if cfg!(windows) {
            "Get-Content -Raw -LiteralPath '.handwave/skills/proof-skill/proof.txt'"
        } else {
            "cat .handwave/skills/proof-skill/proof.txt"
        };
        let mut responses = vec![
            call(
                "create-proof",
                "skill_create",
                json!({"scope":"project","name":NAME,"description":"Read proof",
                "instructions":"Read proof.txt.","resources":{"proof.txt":"skill-proof"}}),
            ),
            call("exec-proof", "exec", json!({"cmd":command,"timeout":15})),
            call(
                "verify-proof",
                "skill_verify",
                json!({"scope":"project","name":NAME,"expected_hash":hash,"evidence_ids":["exec-proof"]}),
            ),
            text("Skill exercised and evidence attached."),
        ];
        if grouped {
            let mut verify = responses.remove(2)["delta"]["tool_calls"][0].clone();
            verify["index"] = json!(1);
            responses[1]["delta"]["tool_calls"].as_array_mut().unwrap().push(verify);
        }
        let provider = Provider::new(responses);
        let host = Arc::new(SkillHost {
            inner: Host::new(&root, &provider, Fault::None),
            roots: roots.clone(),
            recorded: Mutex::new(None),
        });
        let mut request = host.inner.request("skill-run");
        request.enable_local_tools = true;
        request.objective =
            "Create proof-skill, read its proof.txt through exec, and attach that native evidence.".into();
        let spec = host.inner.spec("skill-task");
        let evidence = spec.evidence_dir.clone();
        let outcome = tokio::time::timeout(Duration::from_secs(60), start(spec, request, host.clone()).unwrap().wait())
            .await
            .unwrap();
        assert_eq!(outcome.stop, TaskStop::AwaitingHostAcceptance, "{outcome:?}");
        let record = host.recorded.lock().unwrap().clone().unwrap();
        let basis = outcome.last_candidate.as_ref().unwrap().basis.clone();
        Self { _directory: directory, root, roots, evidence, record, basis }
    }

    fn query(&self) -> SkillProvenanceQuery<'_> {
        SkillProvenanceQuery {
            task_id: &self.record.task_id,
            session_id: &self.record.session_id,
            skill_name: Some(NAME),
            bundle_hash: Some(&self.record.bundle_hash),
            run_id: Some(&self.record.run_id),
            source_artifact_id: Some(&self.record.source_artifact_ids[0]),
            library_scope: Some("project"),
            bundle_id: None,
        }
    }
}

#[tokio::test]
async fn same_assistant_exec_then_skill_verify_uses_preceding_native_result() {
    let fixture = Fixture::run_with_grouped_tools(true).await;
    assert_eq!(
        verified_skill_provenance(&fixture.evidence, &fixture.roots, "project", &fixture.query()).unwrap(),
        vec![fixture.record]
    );
}

#[tokio::test]
async fn actual_skill_verify_is_queryable_after_process_restart() {
    let fixture = Fixture::run().await;
    assert_eq!(query_skill_provenance(&fixture.evidence, &fixture.query()).unwrap(), vec![fixture.record.clone()]);
    assert_eq!(
        verified_skill_provenance(&fixture.evidence, &fixture.roots, "project", &fixture.query()).unwrap(),
        vec![fixture.record.clone()]
    );
    let binding = fixture.record.library_binding.as_ref().unwrap();
    assert_eq!(binding.skill_verify_call_id, "verify-proof");
    fs::write(fixture.root.join("restart-record.json"), serde_json::to_vec(&fixture.record).unwrap()).unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "skill_query_in_fresh_process", "--nocapture"])
        .env("MORROW_SKILL_RESTART_ROOT", &fixture.root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("fresh-process-skill-verified"));
}

#[test]
fn skill_query_in_fresh_process() {
    let Some(root) = std::env::var_os("MORROW_SKILL_RESTART_ROOT") else { return };
    let root = PathBuf::from(root);
    let record: SkillProvenance = serde_json::from_slice(&fs::read(root.join("restart-record.json")).unwrap()).unwrap();
    let roots = environment_library::resolve(&root.join("environment"), &root, None).unwrap();
    let query = SkillProvenanceQuery {
        task_id: &record.task_id,
        session_id: &record.session_id,
        skill_name: Some(NAME),
        bundle_hash: Some(&record.bundle_hash),
        run_id: Some(&record.run_id),
        source_artifact_id: None,
        library_scope: Some("project"),
        bundle_id: None,
    };
    assert_eq!(verified_skill_provenance(&root.join("skill-task"), &roots, "project", &query).unwrap(), vec![record]);
    println!("fresh-process-skill-verified");
}

#[tokio::test]
async fn skill_lookup_refuses_changed_content_metadata_identity_and_foreign_authority() {
    let fixture = Fixture::run().await;
    for field in ["task", "session", "run", "skill", "hash", "source", "scope", "bundle"] {
        let mut query = fixture.query();
        match field {
            "task" => query.task_id = "other-task",
            "session" => query.session_id = "other-session",
            "run" => query.run_id = Some("other-run"),
            "skill" => query.skill_name = Some("other-skill"),
            "hash" => query.bundle_hash = Some("other-hash"),
            "source" => query.source_artifact_id = Some("other-source"),
            "scope" => query.library_scope = Some("global"),
            "bundle" => query.bundle_id = Some("other-bundle"),
            _ => unreachable!(),
        }
        assert!(query_skill_provenance(&fixture.evidence, &query).unwrap().is_empty(), "{field}");
    }
    let mut basis = fixture.basis.clone();
    basis.task_id = "other-task".into();
    assert!(record_skill_verification(
        &fixture.evidence,
        &basis,
        &fixture.roots,
        "project",
        NAME,
        "verify-proof",
        fixture.record.validation_receipts.clone()
    )
    .is_err());
    assert!(record_skill_verification(
        &fixture.evidence,
        &fixture.basis,
        &fixture.roots,
        "project",
        NAME,
        "exec-proof",
        fixture.record.validation_receipts.clone()
    )
    .is_err());
    let bundle = fixture.roots.project_skills.join(NAME);
    fs::write(bundle.join("proof.txt"), "changed").unwrap();
    assert!(verified_skill_provenance(&fixture.evidence, &fixture.roots, "project", &fixture.query()).is_err());
    fs::write(bundle.join("proof.txt"), "skill-proof").unwrap();
    let metadata = bundle.join(".handwave-skill.json");
    let original = fs::read(&metadata).unwrap();
    for field in ["id", "output_hash", "tool_name"] {
        let mut value: Value = serde_json::from_slice(&original).unwrap();
        match field {
            "id" => value["id"] = json!("f".repeat(32)),
            "output_hash" => value["evidence"]["receipts"][0]["output_hash"] = json!("f".repeat(64)),
            "tool_name" => value["evidence"]["receipts"][0]["tool_name"] = json!("run_script"),
            _ => unreachable!(),
        }
        fs::write(&metadata, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            verified_skill_provenance(&fixture.evidence, &fixture.roots, "project", &fixture.query()).is_err(),
            "{field}"
        );
    }
    fs::write(metadata, original).unwrap();
    assert!(verified_skill_provenance(&fixture.evidence, &fixture.roots, "project", &fixture.query()).is_ok());
}

#[tokio::test]
async fn revoked_history_remains_readable_and_every_validation_receipt_is_checked() {
    let fixture = Fixture::run().await;
    let mut invalid = fixture.record.clone();
    invalid.library_binding.as_mut().unwrap().skill_verify_call_id = "another-call".into();
    let mut second = invalid.validation_receipts[0].clone();
    second.receipt_id = "second-validation".into();
    second.source_artifacts[0].host_receipt_id = "wrong-receipt".into();
    invalid.validation_receipts.push(second);
    let error = append_skill_provenance(&fixture.evidence, &invalid).unwrap_err();
    assert!(error.to_string().contains("Host receipt changed"), "{error}");
    let mut source = read_tool_artifacts(&fixture.evidence)
        .unwrap()
        .into_iter()
        .find(|artifact| artifact.artifact_id == fixture.record.source_artifact_ids[0])
        .unwrap();
    source.revoke().unwrap();
    append_tool_artifact(&fixture.evidence, &source).unwrap();
    assert_eq!(query_skill_provenance(&fixture.evidence, &fixture.query()).unwrap(), vec![fixture.record.clone()]);
    assert!(verified_skill_provenance(&fixture.evidence, &fixture.roots, "project", &fixture.query()).is_err());
    let mut revoked = fixture.record.clone();
    revoked.status = SkillProvenanceStatus::Revoked;
    append_skill_provenance(&fixture.evidence, &revoked).unwrap();
    assert_eq!(query_skill_provenance(&fixture.evidence, &fixture.query()).unwrap(), vec![revoked.clone()]);
    assert!(append_skill_provenance(&fixture.evidence, &fixture.record).is_err());
    assert!(append_skill_provenance(&fixture.evidence, &revoked).is_err());
    let lines = fs::read_to_string(skill_provenance_path(&fixture.evidence)).unwrap();
    assert_eq!(lines.lines().count(), 2);
}

#[tokio::test]
async fn simultaneous_readers_share_locks_and_scope_filters_select_independent_records() {
    let fixture = Fixture::run().await;
    let mut global = fixture.record.clone();
    global.library_binding.as_mut().unwrap().scope = "global".into();
    append_skill_provenance(&fixture.evidence, &global).unwrap();
    let mut all = fixture.query();
    all.library_scope = None;
    assert_eq!(query_skill_provenance(&fixture.evidence, &all).unwrap().len(), 2);
    assert_eq!(
        verified_skill_provenance(&fixture.evidence, &fixture.roots, "project", &all).unwrap(),
        vec![fixture.record.clone()]
    );
    let barrier = Arc::new(Barrier::new(8));
    std::thread::scope(|threads| {
        for _ in 0..8 {
            let barrier = barrier.clone();
            let fixture = &fixture;
            threads.spawn(move || {
                barrier.wait();
                for _ in 0..20 {
                    assert_eq!(
                        query_skill_provenance(&fixture.evidence, &fixture.query()).unwrap(),
                        vec![fixture.record.clone()]
                    );
                    verified_skill_provenance(&fixture.evidence, &fixture.roots, "project", &fixture.query()).unwrap();
                }
            });
        }
    });
    let lock =
        fs::OpenOptions::new().read(true).write(true).open(fixture.evidence.join(".morrow-provenance.lock")).unwrap();
    fs2::FileExt::try_lock_exclusive(&lock).unwrap();
    assert!(query_skill_provenance(&fixture.evidence, &fixture.query()).unwrap_err().to_string().contains("busy"));
    fs2::FileExt::unlock(&lock).unwrap();
    fs2::FileExt::try_lock_shared(&lock).unwrap();
    let mut revoked = global;
    revoked.status = SkillProvenanceStatus::Revoked;
    assert!(append_skill_provenance(&fixture.evidence, &revoked).unwrap_err().to_string().contains("busy"));
    fs2::FileExt::unlock(&lock).unwrap();
    append_skill_provenance(&fixture.evidence, &revoked).unwrap();
}
