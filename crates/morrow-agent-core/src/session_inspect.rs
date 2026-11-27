//! Read-only Session inspection snapshot. Caller holds the Harness OS Session lock.
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use rpi_agent::AgentMessage;
use rpi_ai::Content;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    agent::{self, InterruptedRun, OpenToolCall},
    context_memory, effect_status,
    png_image::sha256_hex,
    session_journal::{self, Head, Journal, RECORD_BYTES},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectionLimits {
    pub max_messages: usize,
    pub max_input_bytes: usize,
    pub max_output_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InspectionRequest {
    pub session_path: PathBuf,
    pub cwd: PathBuf,
    #[serde(default)]
    pub from_raw: usize,
    #[serde(default)]
    pub expected_prefix_proof: Option<String>,
    #[serde(default)]
    pub expected_runs: Vec<String>,
    #[serde(default)]
    pub require_context: bool,
    pub limits: InspectionLimits,
}

#[derive(Serialize)]
struct InspectionOutput<'a> {
    request: &'a InspectionRequest,
    absent: bool,
    canonical_session_path: PathBuf,
    canonical_cwd: PathBuf,
    snapshot_sha256: Option<String>,
    head: Option<Head>,
    from_raw: usize,
    to_raw: usize,
    range_proof: String,
    full_proof: String,
    transcript_closed: bool,
    pending_run: Option<InterruptedRun>,
    unknown_effect_result_indices: Vec<usize>,
    inputs: Vec<Value>,
    calls: Vec<Value>,
    context: Value,
    runs: Vec<Value>,
}

pub fn canonical_target(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "Session inspection requires an absolute path");
    if path.exists() {
        return Ok(path.canonicalize()?);
    }
    let parent = path.parent().context("Session path has no parent directory")?;
    let name = path.file_name().context("Session path has no file name")?;
    Ok(parent.canonicalize()?.join(name))
}

fn read_bounded_input(path: &Path, remaining: &mut usize) -> Result<Value> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({ "path": path, "state": { "kind": "absent" } }));
        }
        Err(err) => return Err(err.into()),
    };
    ensure!(meta.file_type().is_file(), "Session input is not a regular file: {}", path.display());
    let cap = (*remaining).saturating_add(1);
    let mut file = File::open(path)?;
    ensure!(file.metadata()?.is_file(), "Session input handle is not a regular file: {}", path.display());
    let mut bytes = Vec::new();
    file.by_ref().take(cap as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= *remaining, "Session inspection input exceeds max_input_bytes");
    *remaining -= bytes.len();
    Ok(json!({
        "path": path.canonicalize()?,
        "state": {
            "kind": "file",
            "bytes": bytes.len(),
            "sha256": sha256_hex(&bytes),
        }
    }))
}

fn sorted_dir_files(dir: &Path) -> Result<Vec<PathBuf>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        paths.push(entry.path());
    }
    paths.sort();
    Ok(paths)
}

pub fn inspect_session_unlocked(request: &InspectionRequest) -> Result<Value> {
    ensure!(
        request.limits.max_messages > 0 && request.limits.max_input_bytes > 0 && request.limits.max_output_bytes > 0,
        "Session inspection limits must be positive"
    );
    let canonical_session = canonical_target(&request.session_path)?;
    let canonical_cwd = request.cwd.canonicalize().context("Session working directory unavailable")?;
    let context_path = context_memory::path(&canonical_session);
    let journal_dir = session_journal::directory(&canonical_session);

    let mut remaining_input = request.limits.max_input_bytes;
    let mut inputs = Vec::new();
    let session_input = read_bounded_input(&canonical_session, &mut remaining_input)?;
    let snapshot_sha256 = session_input["state"]["sha256"].as_str().map(str::to_owned);
    inputs.push(session_input);
    inputs.push(read_bounded_input(&context_path, &mut remaining_input)?);
    for fixed in ["head.json", "pending.json", "migration.json"] {
        inputs.push(read_bounded_input(&journal_dir.join(fixed), &mut remaining_input)?);
    }
    for segment in sorted_dir_files(&journal_dir.join("segments"))? {
        inputs.push(read_bounded_input(&segment, &mut remaining_input)?);
    }
    for run_file in sorted_dir_files(&journal_dir.join("runs"))? {
        inputs.push(read_bounded_input(&run_file, &mut remaining_input)?);
    }

    let journal = Journal::for_session(&canonical_session);
    if !canonical_session.exists() && !journal.exists() {
        ensure!(
            request.from_raw == 0 && request.expected_runs.is_empty() && !request.require_context,
            "absent Session cannot satisfy non-zero raw offset, expected Runs, or required context"
        );
        let empty_proof = session_journal::empty_proof();
        if let Some(expected_prefix) = &request.expected_prefix_proof {
            ensure!(expected_prefix == &empty_proof, "absent Session prefix proof mismatch");
        }
        let context = if context_path.exists() {
            let scope = context_memory::hash(canonical_session.to_string_lossy().as_bytes());
            let store = context_memory::Store::load(&context_path, scope, &[])?;
            json!({ "kind": "present", "snapshot": store })
        } else {
            json!({ "kind": "absent" })
        };
        let output = InspectionOutput {
            request,
            absent: true,
            canonical_session_path: canonical_session,
            canonical_cwd,
            snapshot_sha256: None,
            head: None,
            from_raw: 0,
            to_raw: 0,
            range_proof: empty_proof.clone(),
            full_proof: empty_proof,
            transcript_closed: true,
            pending_run: None,
            unknown_effect_result_indices: Vec::new(),
            inputs,
            calls: Vec::new(),
            context,
            runs: Vec::new(),
        };
        let serialized = serde_json::to_vec(&output)?;
        ensure!(serialized.len() <= request.limits.max_output_bytes, "Session inspection exceeds max_output_bytes");
        return Ok(serde_json::from_slice(&serialized)?);
    }

    ensure!(journal.exists(), "Session journal missing for existing Session; inspect legacy migration explicitly");
    let head = journal.open()?;
    let session_cwd: PathBuf =
        serde_json::from_value(head.metadata.get("cwd").cloned().context("journal metadata missing cwd")?)?;
    ensure!(session_cwd == canonical_cwd, "Session working directory mismatch");
    ensure!(request.from_raw <= head.raw_count, "Session inspection from_raw exceeds raw_count");
    ensure!(
        head.raw_count - request.from_raw <= request.limits.max_messages,
        "Session inspection message range exceeds max_messages"
    );
    journal.verify_range(0, head.raw_count)?;
    if let Some(expected_prefix) = &request.expected_prefix_proof {
        let actual_prefix = journal.proof(0, request.from_raw)?;
        ensure!(&actual_prefix == expected_prefix, "Session inspection prefix proof mismatch");
    }
    let range_proof = journal.proof(request.from_raw, head.raw_count)?;
    let full_proof = journal.proof(0, head.raw_count)?;
    let slice = journal.read(request.from_raw, head.raw_count, request.limits.max_input_bytes)?;
    let active = journal.read(head.active_base, head.raw_count, session_journal::CHECKPOINT_ACTIVE_BYTES)?;
    let pending_run = agent::interrupted_run(&canonical_session, &canonical_cwd)?;
    let transcript_closed = pending_run.is_none() && agent::validate_transcript(&active).is_ok();

    let mut seen_slice_calls: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut needed_prior_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for msg in &slice {
        match msg {
            AgentMessage::Assistant(assistant) => {
                for block in &assistant.content {
                    if let Content::ToolCall(tc) = block {
                        seen_slice_calls.insert(tc.id.clone());
                    }
                }
            }
            AgentMessage::ToolResult(result) if !seen_slice_calls.contains(&result.tool_call_id) => {
                needed_prior_ids.insert(result.tool_call_id.clone());
            }
            _ => {}
        }
    }
    let mut prior_calls: HashMap<String, (usize, OpenToolCall)> = HashMap::new();
    if request.from_raw > 0 && !needed_prior_ids.is_empty() {
        let floor = request.from_raw.saturating_sub(64);
        for idx in (floor..request.from_raw).rev() {
            let prior = journal.read(idx, idx + 1, RECORD_BYTES)?;
            if let Some(AgentMessage::Assistant(assistant)) = prior.first() {
                for block in &assistant.content {
                    if let Content::ToolCall(tc) = block {
                        if needed_prior_ids.remove(&tc.id) {
                            prior_calls.insert(
                                tc.id.clone(),
                                (
                                    idx,
                                    OpenToolCall {
                                        id: tc.id.clone(),
                                        name: tc.name.clone(),
                                        arguments: tc.arguments.clone(),
                                    },
                                ),
                            );
                        }
                    }
                }
                if needed_prior_ids.is_empty() {
                    break;
                }
            }
        }
    }

    let mut calls: Vec<Value> = Vec::new();
    let mut call_positions: HashMap<String, usize> = HashMap::new();
    let mut unknown_effect_result_indices = Vec::new();

    for (offset, msg) in slice.iter().enumerate() {
        let raw_index = request.from_raw + offset;
        match msg {
            AgentMessage::Assistant(assistant) => {
                for block in &assistant.content {
                    if let Content::ToolCall(tc) = block {
                        let pos = calls.len();
                        call_positions.insert(tc.id.clone(), pos);
                        calls.push(json!({
                            "call_raw_index": raw_index,
                            "result_raw_index": Value::Null,
                            "call": {
                                "id": tc.id,
                                "name": tc.name,
                                "arguments": tc.arguments,
                            },
                            "result": Value::Null,
                            "effects_unknown": false,
                        }));
                    }
                }
            }
            AgentMessage::ToolResult(result) => {
                let unknown = result.details.as_ref().is_some_and(effect_status::reports_unknown);
                if unknown {
                    unknown_effect_result_indices.push(raw_index);
                }
                let result_val = serde_json::to_value(&**result)?;
                if let Some(&pos) = call_positions.get(&result.tool_call_id) {
                    ensure!(
                        calls[pos]["result"].is_null(),
                        "duplicate ToolResult for {} in Session slice",
                        result.tool_call_id
                    );
                    calls[pos]["result_raw_index"] = json!(raw_index);
                    calls[pos]["result"] = result_val;
                    calls[pos]["effects_unknown"] = json!(unknown);
                } else if let Some((call_idx, open)) = prior_calls.get(&result.tool_call_id) {
                    let pos = calls.len();
                    call_positions.insert(result.tool_call_id.clone(), pos);
                    calls.push(json!({
                        "call_raw_index": *call_idx,
                        "result_raw_index": raw_index,
                        "call": open,
                        "result": result_val,
                        "effects_unknown": unknown,
                    }));
                } else {
                    anyhow::bail!("ToolResult {} has no matching ToolCall in Session journal", result.tool_call_id);
                }
            }
            _ => {}
        }
    }

    let context = if context_path.exists() {
        let scope = context_memory::hash(canonical_session.to_string_lossy().as_bytes());
        let store =
            context_memory::Store::load_window(&context_path, scope, &active, head.active_base, journal.clone())?;
        json!({ "kind": "present", "snapshot": store })
    } else {
        ensure!(!request.require_context, "Session inspection requires context sidecar, but it is absent");
        json!({ "kind": "absent" })
    };

    let mut runs = Vec::with_capacity(request.expected_runs.len());
    let mut cached_run_indices: HashMap<String, Value> = HashMap::new();
    for run_id in &request.expected_runs {
        ensure!(journal.contains_run(run_id)?, "expected Run {run_id} is not recorded in Session journal");
        let index = if let Some(existing) = cached_run_indices.get(run_id) {
            existing.clone()
        } else {
            let run_file = journal_dir.join("runs").join(format!("{}.json", sha256_hex(run_id.as_bytes())));
            let val = match std::fs::symlink_metadata(&run_file) {
                Ok(meta) => {
                    ensure!(meta.file_type().is_file(), "Run index file is not a regular file");
                    let mut bytes = Vec::new();
                    let cap = remaining_input.saturating_add(1);
                    File::open(&run_file)?.take(cap as u64).read_to_end(&mut bytes)?;
                    ensure!(bytes.len() <= remaining_input, "Session inspection Run index exceeds max_input_bytes");
                    remaining_input -= bytes.len();
                    json!({
                        "path": run_file.canonicalize()?,
                        "bytes": bytes.len(),
                        "sha256": sha256_hex(&bytes),
                    })
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Value::Null,
                Err(err) => return Err(err.into()),
            };
            cached_run_indices.insert(run_id.clone(), val.clone());
            val
        };
        runs.push(json!({
            "id": run_id,
            "index": index,
        }));
    }

    let to_raw = head.raw_count;
    let output = InspectionOutput {
        request,
        absent: false,
        canonical_session_path: canonical_session,
        canonical_cwd,
        snapshot_sha256,
        head: Some(head),
        from_raw: request.from_raw,
        to_raw,
        range_proof,
        full_proof,
        transcript_closed,
        pending_run,
        unknown_effect_result_indices,
        inputs,
        calls,
        context,
        runs,
    };
    let serialized = serde_json::to_vec(&output)?;
    ensure!(serialized.len() <= request.limits.max_output_bytes, "Session inspection exceeds max_output_bytes");
    Ok(serde_json::from_slice(&serialized)?)
}
