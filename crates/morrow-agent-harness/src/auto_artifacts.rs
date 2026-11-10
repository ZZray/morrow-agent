use std::{collections::HashMap, path::Path};

use anyhow::{ensure, Context, Result};
use morrow_agent_core::{
    artifact_provenance::{sha256_hex, ArtifactStatus, ToolArtifact},
    rpi_agent::AgentMessage,
    rpi_ai::Content,
    session_journal::Journal,
};
use serde_json::{Map, Value};

use crate::append_tool_artifact;

#[cfg(test)]
use crate::ReviewBasis;

const MAX_JOURNAL_BYTES: usize = 64 * 1024 * 1024;
const JOURNAL_PAGE_MESSAGES: usize = 16;

#[derive(Clone)]
struct PendingCall {
    raw_index: usize,
    name: String,
    arguments: Value,
}

/// Derive journal-backed candidate artifacts from one exact Run range.
///
/// These records prove the native call/result pairing and their typed hashes.
/// They are not business files and cannot become verified without a Host receipt.
#[cfg(test)]
fn derive(journal: &Journal, basis: &ReviewBasis) -> Result<Vec<ToolArtifact>> {
    ensure!(journal.proof(basis.raw_start, basis.raw_end)? == basis.raw_proof, "artifact journal proof changed");
    derive_range(journal, &basis.task_id, &basis.session_id, &basis.run_id, basis.raw_start, basis.raw_end, false)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_run(
    journal: &Journal,
    evidence_dir: &Path,
    task_id: &str,
    session_id: &str,
    run_id: &str,
    raw_start: usize,
    raw_end: usize,
    allow_unresolved: bool,
) -> Result<Vec<ToolArtifact>> {
    let artifacts = derive_range(journal, task_id, session_id, run_id, raw_start, raw_end, allow_unresolved)?;
    for artifact in &artifacts {
        append_tool_artifact(evidence_dir, artifact)?;
    }
    Ok(artifacts)
}

pub(crate) fn derive_range(
    journal: &Journal,
    task_id: &str,
    session_id: &str,
    run_id: &str,
    raw_start: usize,
    raw_end: usize,
    allow_unresolved: bool,
) -> Result<Vec<ToolArtifact>> {
    ensure!(raw_start <= raw_end, "artifact journal range is invalid");
    let mut pending = HashMap::<String, PendingCall>::new();
    let mut artifacts = Vec::new();
    let mut cursor = raw_start;

    while cursor < raw_end {
        let page_end = cursor.saturating_add(JOURNAL_PAGE_MESSAGES).min(raw_end);
        let messages = journal.read(cursor, page_end, MAX_JOURNAL_BYTES)?;
        for (offset, message) in messages.into_iter().enumerate() {
            let raw_index = cursor + offset;
            match message {
                AgentMessage::Assistant(assistant) => {
                    for content in assistant.content {
                        let Content::ToolCall(call) = content else { continue };
                        ensure!(!call.id.is_empty(), "journal tool call has no native call ID");
                        ensure!(!call.name.is_empty(), "journal tool call has no tool name");
                        ensure!(
                            pending
                                .insert(
                                    call.id.clone(),
                                    PendingCall { raw_index, name: call.name, arguments: call.arguments },
                                )
                                .is_none(),
                            "journal contains a duplicate native tool call ID"
                        );
                    }
                }
                AgentMessage::ToolResult(result) => {
                    let result_value = serde_json::to_value(&result)?;
                    let call_id = result.tool_call_id.clone();
                    let call = pending.remove(&call_id).context("journal ToolResult has no matching ToolCall")?;
                    ensure!(call.name == result.tool_name, "journal ToolCall and ToolResult tool names differ");
                    let status =
                        if result.details.as_ref().is_some_and(morrow_agent_core::effect_status::reports_unknown) {
                            ArtifactStatus::Unknown
                        } else {
                            ArtifactStatus::Candidate
                        };
                    let identity = format!("{task_id}:{session_id}:{run_id}:{call_id}:{raw_index}");
                    artifacts.push(ToolArtifact {
                        version: ToolArtifact::VERSION,
                        artifact_id: format!("journal-{}", sha256_hex(identity.as_bytes())),
                        task_id: task_id.to_owned(),
                        session_id: session_id.to_owned(),
                        run_id: run_id.to_owned(),
                        native_call_id: call_id,
                        tool: call.name,
                        input_sha256: canonical_sha256(&call.arguments)?,
                        output_sha256: canonical_sha256(&result_value)?,
                        artifact_ref: format!("journal/{}/result-{raw_index}", call.raw_index),
                        status,
                        created_at: result.timestamp.to_string(),
                        host_receipt: None,
                    });
                }
                _ => {}
            }
        }
        cursor = page_end;
    }
    if !allow_unresolved {
        ensure!(pending.is_empty(), "journal contains an unresolved native tool call");
    }
    for artifact in &artifacts {
        artifact.validate()?;
    }
    Ok(artifacts)
}

fn canonical_sha256(value: &Value) -> Result<String> {
    Ok(sha256_hex(&serde_json::to_vec(&canonical(value))?))
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            Value::Object(
                entries.into_iter().map(|(key, value)| (key.clone(), canonical(value))).collect::<Map<_, _>>(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{read_tool_artifacts, ReviewBasis};
    use morrow_agent_core::{
        rpi_ai::{Api, AssistantMessage, StopReason, ToolCall, ToolCallType, ToolResultMessage},
        session_journal::Journal,
    };
    use serde_json::json;
    use tempfile::tempdir;

    fn basis(session_path: &Path, proof: String, raw_end: usize) -> ReviewBasis {
        ReviewBasis {
            task_id: "task-1".into(),
            criteria_revision: "criteria-1".into(),
            authorization_revision: "auth-1".into(),
            run_id: "run-1".into(),
            session_id: "session-1".into(),
            run_number: 1,
            session_path: session_path.to_owned(),
            events_path: session_path.join("events.jsonl"),
            events_sha256: "a".repeat(64),
            event_count: 2,
            run_calls: 1,
            total_calls: 1,
            journal_head_sha256: "b".repeat(64),
            raw_start: 0,
            raw_end,
            raw_proof: proof,
        }
    }

    fn messages(details: Option<Value>, is_error: bool) -> Vec<AgentMessage> {
        let mut assistant = AssistantMessage::empty(Api::OpenaiCompletions, "fixture", "model", 1);
        assistant.stop_reason = StopReason::ToolUse;
        assistant.content = vec![Content::ToolCall(ToolCall {
            kind: ToolCallType,
            id: "call-1".into(),
            name: "write_answer".into(),
            arguments: json!({"b": 2, "a": 1}),
            thought_signature: None,
            namespace: None,
        })];
        vec![
            AgentMessage::Assistant(Box::new(assistant)),
            AgentMessage::ToolResult(Box::new(ToolResultMessage {
                role: Default::default(),
                tool_call_id: "call-1".into(),
                tool_name: "write_answer".into(),
                content: vec![Content::text("done")],
                details,
                usage: None,
                added_tool_names: vec![],
                is_error,
                timestamp: 1,
            })),
        ]
    }

    fn multi_messages() -> Vec<AgentMessage> {
        let mut assistant = AssistantMessage::empty(Api::OpenaiCompletions, "fixture", "model", 1);
        assistant.stop_reason = StopReason::ToolUse;
        assistant.content = vec![
            Content::ToolCall(ToolCall {
                kind: ToolCallType,
                id: "call-1".into(),
                name: "write_answer".into(),
                arguments: json!({"content": "first"}),
                thought_signature: None,
                namespace: None,
            }),
            Content::ToolCall(ToolCall {
                kind: ToolCallType,
                id: "call-2".into(),
                name: "write_answer".into(),
                arguments: json!({"content": "second"}),
                thought_signature: None,
                namespace: None,
            }),
        ];
        vec![
            AgentMessage::Assistant(Box::new(assistant)),
            AgentMessage::ToolResult(Box::new(ToolResultMessage {
                role: Default::default(),
                tool_call_id: "call-1".into(),
                tool_name: "write_answer".into(),
                content: vec![Content::text("first done")],
                details: None,
                usage: None,
                added_tool_names: vec![],
                is_error: false,
                timestamp: 1,
            })),
            AgentMessage::ToolResult(Box::new(ToolResultMessage {
                role: Default::default(),
                tool_call_id: "call-2".into(),
                tool_name: "write_answer".into(),
                content: vec![Content::text("second failed")],
                details: None,
                usage: None,
                added_tool_names: vec![],
                is_error: true,
                timestamp: 2,
            })),
        ]
    }

    fn paged_messages() -> Vec<AgentMessage> {
        let mut messages = Vec::new();
        for index in 0..17 {
            let call_id = format!("call-{index}");
            let mut assistant = AssistantMessage::empty(Api::OpenaiCompletions, "fixture", "model", index as i64 + 1);
            assistant.stop_reason = StopReason::ToolUse;
            assistant.content = vec![Content::ToolCall(ToolCall {
                kind: ToolCallType,
                id: call_id.clone(),
                name: "write_answer".into(),
                arguments: json!({"index": index}),
                thought_signature: None,
                namespace: None,
            })];
            messages.push(AgentMessage::Assistant(Box::new(assistant)));
            if index == 7 {
                let mut idle = AssistantMessage::empty(Api::OpenaiCompletions, "fixture", "model", 100);
                idle.content = vec![Content::text("page boundary")];
                messages.push(AgentMessage::Assistant(Box::new(idle)));
            }
            messages.push(AgentMessage::ToolResult(Box::new(ToolResultMessage {
                role: Default::default(),
                tool_call_id: call_id,
                tool_name: "write_answer".into(),
                content: vec![Content::text("done")],
                details: None,
                usage: None,
                added_tool_names: vec![],
                is_error: false,
                timestamp: index as i64,
            })));
        }
        messages
    }

    fn journal_with(messages: &[AgentMessage]) -> (tempfile::TempDir, Journal, String) {
        let directory = tempdir().unwrap();
        let path = directory.path().join("session.json");
        let journal = Journal::for_session(&path);
        let metadata = json!({"pending_run": Value::Null});
        let head = journal.commit(metadata, 0, messages, &["run-1".into()]).unwrap();
        let proof = journal.proof(0, head.raw_count).unwrap();
        (directory, journal, proof)
    }

    #[test]
    fn derives_candidate_with_canonical_input_and_typed_output_hash() {
        let messages = messages(None, false);
        let (directory, journal, proof) = journal_with(&messages);
        let basis = basis(&directory.path().join("session.json"), proof, 2);
        let artifacts = derive(&journal, &basis).unwrap();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].status, ArtifactStatus::Candidate);
        assert_eq!(artifacts[0].artifact_ref, "journal/0/result-1");
        assert_eq!(artifacts[0].input_sha256, canonical_sha256(&json!({"a": 1, "b": 2})).unwrap());
    }

    #[test]
    fn unknown_effect_is_recorded_as_unknown_and_mismatches_fail_closed() {
        let messages = messages(Some(json!({"effects_unknown": true})), true);
        let (directory, journal, proof) = journal_with(&messages);
        let basis = basis(&directory.path().join("session.json"), proof, 2);
        let artifacts = derive(&journal, &basis).unwrap();
        assert_eq!(artifacts[0].status, ArtifactStatus::Unknown);

        let mut tampered = basis.clone();
        tampered.raw_proof = "journal-v1:tampered".into();
        assert!(derive(&journal, &tampered).is_err());
    }

    #[test]
    fn multiple_tool_results_preserve_order_and_known_errors_remain_candidates() {
        let messages = multi_messages();
        let (directory, journal, proof) = journal_with(&messages);
        let basis = basis(&directory.path().join("session.json"), proof, 3);
        let artifacts = derive(&journal, &basis).unwrap();
        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[0].native_call_id, "call-1");
        assert_eq!(artifacts[0].artifact_ref, "journal/0/result-1");
        assert_eq!(artifacts[1].native_call_id, "call-2");
        assert_eq!(artifacts[1].artifact_ref, "journal/0/result-2");
        assert!(artifacts.iter().all(|artifact| artifact.status == ArtifactStatus::Candidate));
        assert_ne!(artifacts[0].output_sha256, artifacts[1].output_sha256);
    }

    #[test]
    fn artifact_identity_and_scope_include_the_run_boundary() {
        let messages = messages(None, false);
        let (directory, journal, proof) = journal_with(&messages);
        let first_basis = basis(&directory.path().join("session.json"), proof.clone(), 2);
        let mut second_basis = first_basis.clone();
        second_basis.run_id = "run-2".into();

        let first = derive(&journal, &first_basis).unwrap().pop().unwrap();
        let second = derive(&journal, &second_basis).unwrap().pop().unwrap();
        assert_ne!(first.artifact_id, second.artifact_id);
        assert_eq!(first.run_id, "run-1");
        assert_eq!(second.run_id, "run-2");
        assert_eq!(first.artifact_ref, second.artifact_ref);
    }

    #[test]
    fn journal_ranges_are_processed_across_pages_without_losing_pending_calls() {
        let messages = paged_messages();
        let (directory, journal, proof) = journal_with(&messages);
        let basis = basis(&directory.path().join("session.json"), proof, messages.len());
        let artifacts = derive(&journal, &basis).unwrap();
        assert_eq!(artifacts.len(), 17);
        assert_eq!(artifacts.first().unwrap().native_call_id, "call-0");
        assert_eq!(artifacts.last().unwrap().native_call_id, "call-16");
        assert_eq!(artifacts[7].artifact_ref, "journal/14/result-16");
    }

    #[test]
    fn persisting_the_same_run_twice_fails_without_duplicate_records() {
        let messages = messages(None, false);
        let (directory, journal, proof) = journal_with(&messages);
        let evidence = tempdir().unwrap();
        let first = persist_run(&journal, evidence.path(), "task-1", "session-1", "run-1", 0, 2, false).unwrap();
        assert_eq!(first.len(), 1);
        assert!(persist_run(&journal, evidence.path(), "task-1", "session-1", "run-1", 0, 2, false).is_err());
        assert_eq!(read_tool_artifacts(evidence.path()).unwrap().len(), 1);
        assert_eq!(proof, journal.proof(0, 2).unwrap());
        drop(directory);
    }

    #[test]
    fn unmatched_results_are_rejected() {
        let mut messages = messages(None, false);
        if let AgentMessage::ToolResult(result) = &mut messages[1] {
            result.tool_call_id = "missing".into();
        }
        let (directory, journal, proof) = journal_with(&messages);
        let basis = basis(&directory.path().join("session.json"), proof, 2);
        assert!(derive(&journal, &basis).is_err());
    }

    #[test]
    fn duplicate_pending_call_ids_and_mismatched_tool_names_are_rejected() {
        let original = messages(None, false);
        let duplicate = vec![original[0].clone(), original[0].clone(), original[1].clone()];
        let (_directory, journal, _proof) = journal_with(&duplicate);
        assert!(derive_range(&journal, "task-1", "session-1", "run-1", 0, duplicate.len(), false).is_err());

        let mut mismatched = original;
        if let AgentMessage::ToolResult(result) = &mut mismatched[1] {
            result.tool_name = "another_tool".into();
        }
        let (_directory, journal, _proof) = journal_with(&mismatched);
        assert!(derive_range(&journal, "task-1", "session-1", "run-1", 0, mismatched.len(), false).is_err());
    }

    #[test]
    fn partial_persistence_keeps_an_unknown_artifact_when_a_later_duplicate_fails() {
        let mut messages = multi_messages();
        if let AgentMessage::ToolResult(result) = &mut messages[1] {
            result.details = Some(json!({"effects_unknown": true}));
        }
        let (directory, journal, proof) = journal_with(&messages);
        let basis = basis(&directory.path().join("session.json"), proof, messages.len());
        let derived = derive(&journal, &basis).unwrap();
        let evidence = tempdir().unwrap();
        append_tool_artifact(evidence.path(), &derived[1]).unwrap();

        assert!(
            persist_run(&journal, evidence.path(), "task-1", "session-1", "run-1", 0, messages.len(), false).is_err()
        );
        let persisted = read_tool_artifacts(evidence.path()).unwrap();
        assert!(persisted.iter().any(
            |artifact| artifact.artifact_id == derived[0].artifact_id && artifact.status == ArtifactStatus::Unknown
        ));
    }

    #[test]
    fn interrupted_call_can_leave_no_candidate_without_hiding_the_open_effect() {
        let mut messages = messages(None, false);
        messages.pop();
        let (directory, journal, _proof) = journal_with(&messages);
        let evidence = tempdir().unwrap();
        let artifacts = persist_run(&journal, evidence.path(), "task-1", "session-1", "run-1", 0, 1, true).unwrap();
        assert!(artifacts.is_empty());
        assert!(read_tool_artifacts(evidence.path()).unwrap().is_empty());
        drop(directory);
    }
}
