//! Fit note windows to the model projection. The native journal retains the tool receipts.
use anyhow::{Context, Result};
use rpi_agent::AgentMessage;
use rpi_ai::Content;
use serde_json::{json, Value};

/// Only the JSON string inside the text block changes. Its serialized length
/// includes the second layer of escaping around the tool's JSON response.
fn wire_bytes(text: &str) -> Result<usize> {
    Ok(serde_json::to_vec(text)?.len())
}

/// Keep the continuation cursor after the potentially long page body.
pub(super) fn encode_page(page: &Value) -> Result<String> {
    #[derive(serde::Serialize)]
    struct OrderedPage<'a> {
        #[serde(flatten)]
        fields: std::collections::BTreeMap<&'a String, &'a Value>,
        next_offset: &'a Value,
    }
    let object = page.as_object().context("expected a Session note page object")?;
    let fields = object.iter().filter(|(key, _)| key.as_str() != "next_offset").collect();
    let next_offset = object.get("next_offset").context("Session note page has no continuation cursor")?;
    Ok(serde_json::to_string(&OrderedPage { fields, next_offset })?)
}

struct Page<'a> {
    output: &'a mut String,
    metadata: Value,
    text: String,
    offset: u64,
    bytes: u64,
}

impl Page<'_> {
    fn render(&mut self, end: usize) -> Result<String> {
        self.metadata["text"] = json!(&self.text[..end]);
        let next = self.offset + end as u64;
        self.metadata["next_offset"] = json!((next < self.bytes).then_some(next));
        encode_page(&self.metadata)
    }

    fn fit(&mut self, allowance: usize) -> Result<usize> {
        let boundaries: Vec<_> = self.text.char_indices().skip(1).map(|(i, _)| i).collect();
        // The full page has already been tested. One scalar is reserved even
        // if the surrounding transcript still requires ordinary compaction.
        let mut best = self.render(boundaries.first().copied().unwrap_or(self.text.len()))?;
        let mut low = 0;
        let mut high = boundaries.len();
        while low < high {
            let mid = low + (high - low) / 2;
            let candidate = self.render(boundaries[mid])?;
            if wire_bytes(&candidate)? <= allowance {
                best = candidate;
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        let used = wire_bytes(&best)?;
        *self.output = best;
        Ok(used)
    }
}

fn note_text(message: &mut AgentMessage) -> Option<&mut String> {
    let AgentMessage::ToolResult(result) = message else { return None };
    result_text(result)
}

fn result_text(result: &mut rpi_ai::ToolResultMessage) -> Option<&mut String> {
    if result.is_error || result.tool_name != "session_memory_read" {
        return None;
    }
    let [Content::Text(block)] = result.content.as_mut_slice() else { return None };
    Some(&mut block.text)
}

fn omit_texts<'a>(outputs: impl Iterator<Item = &'a mut String>) -> Result<usize> {
    let mut saved = 0;
    for output in outputs {
        let Ok(page) = serde_json::from_str::<Value>(output) else { continue };
        if !page["text"].is_string() {
            continue;
        }
        let locator = json!({"id":page["id"],"offset":page["offset"].as_u64().unwrap_or(0),"sources":page["sources"],
            "omitted":"Earlier note text; use session_memory_read to read it again."})
        .to_string();
        let saving = wire_bytes(output)?.saturating_sub(wire_bytes(&locator)?);
        if saving > 0 {
            *output = locator;
            saved += saving;
        }
    }
    Ok(saved)
}

// A later successful read at a higher offset witnesses forward progress. Keep
// the newest pair. A different tool, note, error, or visible answer ends the chain.
fn read_position(assistant: &rpi_ai::AssistantMessage, result: &rpi_ai::ToolResultMessage) -> Option<(String, u64)> {
    if assistant.stop_reason != rpi_ai::StopReason::ToolUse
        || result.is_error
        || result.tool_name != "session_memory_read"
    {
        return None;
    }
    let mut call = None;
    for content in &assistant.content {
        match content {
            Content::Thinking(_) => (),
            Content::Text(block) if block.text.is_empty() => (),
            Content::ToolCall(tool)
                if call.is_none() && tool.name == result.tool_name && tool.id == result.tool_call_id =>
            {
                call = Some(tool)
            }
            _ => return None,
        }
    }
    let call = call?;
    let [Content::Text(block)] = result.content.as_slice() else { return None };
    let page: Value = serde_json::from_str(&block.text).ok()?;
    let id = call.arguments["id"].as_str()?;
    let offset = page["offset"].as_u64()?;
    if page["id"] != id || !page["text"].is_string() || call.arguments["offset"].as_u64().unwrap_or(0) != offset {
        return None;
    }
    Some((id.to_owned(), offset))
}

fn native_read(pair: &[AgentMessage]) -> Option<(String, u64)> {
    let [AgentMessage::Assistant(assistant), AgentMessage::ToolResult(result)] = pair else { return None };
    read_position(assistant, result)
}

fn fold_repeated_reads<T>(
    messages: &mut Vec<T>,
    read: impl Fn(&[T]) -> Option<(String, u64)>,
    output: impl Fn(&mut T) -> Option<&mut String>,
) -> Result<()> {
    let mut keep = vec![true; messages.len()];
    let mut i = 0;
    while i + 1 < messages.len() {
        let Some((id, mut offset)) = read(&messages[i..i + 2]) else {
            i += 1;
            continue;
        };
        let start = i;
        let mut prior = Vec::new();
        i += 2;
        while let Some((next_id, next_offset)) = messages.get(i..i + 2).and_then(&read) {
            if next_id != id || next_offset <= offset {
                break;
            }
            prior.push(offset);
            offset = next_offset;
            i += 2;
        }
        if !prior.is_empty() {
            // Keep the actual read positions alongside the surviving receipt.
            // Without the first call, the model can mistake a continuation for
            // the initial ID-only read and restart at zero.
            let text = output(&mut messages[i - 1]).context("missing read receipt for folded note pages")?;
            let mut page: Value = serde_json::from_str(text)?;
            page["prior_read_offsets"] = json!(prior);
            *text = encode_page(&page)?;
            keep[start..i - 2].fill(false);
        }
    }
    let mut flags = keep.into_iter();
    messages.retain(|_| flags.next().unwrap());
    Ok(())
}

pub(super) fn summarize_notes(messages: &mut Vec<AgentMessage>) -> Result<()> {
    fold_repeated_reads(messages, native_read, note_text)?;
    omit_texts(messages.iter_mut().filter_map(note_text))?;
    Ok(())
}

/// A host with large tool schemas can exhaust the complete request budget
/// even after the transcript fits. Use the actual request's byte excess.
pub(crate) fn fit_request(context: &mut rpi_ai::Context, budget: crate::model_caps::TextBudget) -> Result<()> {
    fn provider_note(message: &mut rpi_ai::Message) -> Option<&mut String> {
        let rpi_ai::Message::ToolResult(result) = message else { return None };
        result_text(result)
    }
    fold_repeated_reads(
        &mut context.messages,
        |pair| {
            let [rpi_ai::Message::Assistant(assistant), rpi_ai::Message::ToolResult(result)] = pair else {
                return None;
            };
            read_position(assistant, result)
        },
        provider_note,
    )?;
    let excess = budget.request_json_bytes(context)?.saturating_sub(budget.request_bytes);
    if excess > 0 {
        let active =
            context.messages.iter().rposition(|m| matches!(m, rpi_ai::Message::Assistant(_))).map_or(0, |i| i + 1);
        let (history, batch) = context.messages.split_at_mut(active);
        let saved = omit_texts(history.iter_mut().filter_map(provider_note))?;
        fit_batch(batch.iter_mut().filter_map(provider_note), excess.saturating_sub(saved))?;
    }
    budget.check(context)
}

pub(super) fn fit(messages: &mut Vec<AgentMessage>, limit: usize) -> Result<()> {
    let total = serde_json::to_vec(messages)?.len();
    if total <= limit {
        return Ok(());
    }
    let original_len = messages.len();
    fold_repeated_reads(messages, native_read, note_text)?;
    let total = if messages.len() == original_len { total } else { serde_json::to_vec(messages)?.len() };
    if total <= limit {
        return Ok(());
    }
    // Steering may follow the newest tool batch before the model sees it.
    let active = messages.iter().rposition(|m| matches!(m, AgentMessage::Assistant(_))).map_or(0, |i| i + 1);
    let (history, batch) = messages.split_at_mut(active);
    let excess = (total - limit).saturating_sub(omit_texts(history.iter_mut().filter_map(note_text))?);
    fit_batch(batch.iter_mut().filter_map(note_text), excess)
}

fn fit_batch<'a>(outputs: impl Iterator<Item = &'a mut String>, excess: usize) -> Result<()> {
    if excess == 0 {
        return Ok(());
    }
    let mut pages = Vec::new();
    let mut available = 0;
    for output in outputs {
        let Ok(mut page) = serde_json::from_str::<Value>(output) else { continue };
        let Some(text) = page.get_mut("text").map(Value::take) else { continue };
        let Value::String(text) = text else { continue };
        let old_size = wire_bytes(output)?;
        // Only new paged receipts support adjusting the emitted cursor. A
        // redacted or legacy receipt with different byte coordinates stays intact.
        let (Some(offset), Some(bytes)) = (page["offset"].as_u64(), page["bytes"].as_u64()) else { continue };
        if offset.checked_add(text.len() as u64) != Some(page["next_offset"].as_u64().unwrap_or(bytes)) {
            continue;
        }
        let Some(first) = text.chars().next() else { continue };
        let mut page = Page { output, metadata: page, text, offset, bytes };
        let min_size = wire_bytes(&page.render(first.len_utf8())?)?;
        available += old_size.saturating_sub(min_size);
        pages.push((old_size, min_size, page));
    }
    let mut extra = available.saturating_sub(excess);
    // Satisfy small requests first. If several long reads share the batch,
    // reserve one UTF-8 scalar plus metadata for each before sharing the rest.
    pages.sort_by_key(|(full, min, _)| full.saturating_sub(*min));
    let count = pages.len();
    for (i, (full, min, mut page)) in pages.into_iter().enumerate() {
        let allowance = min + extra / (count - i);
        if full <= allowance {
            extra -= full.saturating_sub(min);
            continue;
        }
        extra -= page.fit(allowance)?.saturating_sub(min);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_batch(notes: &[(&str, &str, usize)]) -> Vec<AgentMessage> {
        let mut assistant = rpi_ai::AssistantMessage::empty(rpi_ai::Api::OpenaiCompletions, "test", "test", 0);
        assistant.stop_reason = rpi_ai::StopReason::ToolUse;
        let mut results = Vec::new();
        for &(id, text, offset) in notes {
            let call_id = format!("{id}-{offset}");
            assistant.content.push(Content::ToolCall(rpi_ai::ToolCall {
                kind: rpi_ai::ToolCallType,
                id: call_id.clone(),
                name: "session_memory_read".into(),
                arguments: json!({"id":id,"offset":offset}),
                thought_signature: None,
                namespace: None,
            }));
            let page = json!({"id":id,"kind":"fact","text":&text[offset..],"offset":offset,"bytes":text.len(),
                "next_offset":null,"sources":[{"id":"ref-1","hash":"source-hash"}]});
            results.push(AgentMessage::ToolResult(Box::new(rpi_ai::ToolResultMessage {
                role: Default::default(),
                tool_call_id: call_id,
                tool_name: "session_memory_read".into(),
                content: vec![Content::text(encode_page(&page).unwrap())],
                details: None,
                usage: None,
                added_tool_names: vec![],
                is_error: false,
                timestamp: 0,
            })));
        }
        results.insert(0, AgentMessage::Assistant(Box::new(assistant)));
        results
    }

    fn page(message: &AgentMessage) -> Value {
        let AgentMessage::ToolResult(result) = message else { panic!("expected tool result") };
        let [Content::Text(text)] = result.content.as_slice() else { panic!("expected text receipt") };
        serde_json::from_str(&text.text).unwrap()
    }

    #[test]
    fn follow_projected_cursors_to_reassemble_8008_bytes_without_changing_raw_receipts() {
        let note = format!("{}末尾OK", "\"\n".repeat(4000));
        assert_eq!(note.len(), 8008);
        let mut native = vec![super::super::user("h".repeat(2000))];
        let mut retrieved = String::new();
        let mut offset = 0;
        let mut reads = 0;
        let mut prior = Vec::new();
        loop {
            reads += 1;
            assert!(reads <= 8, "tail not reached within the model call budget");
            let mut batch = read_batch(&[("mem-1", &note, offset)]);
            let AgentMessage::Assistant(assistant) = &mut batch[0] else { unreachable!() };
            assistant.content.insert(
                0,
                Content::Thinking(rpi_ai::ThinkingContent {
                    kind: Default::default(),
                    thinking: "r".repeat(2500),
                    thinking_signature: None,
                    redacted: false,
                }),
            );
            native.extend(batch);
            let mut projected = native.clone();
            fit(&mut projected, 13_312).unwrap();
            assert!(serde_json::to_vec(&projected).unwrap().len() <= 13_312);
            crate::agent::validate_transcript(&projected).unwrap();
            let result = page(projected.last().unwrap());
            if projected.len() < native.len() {
                assert_eq!(result["prior_read_offsets"], json!(prior));
            }
            prior.push(offset);
            let AgentMessage::ToolResult(tool) = projected.last().unwrap() else { unreachable!() };
            let [Content::Text(block)] = tool.content.as_slice() else { unreachable!() };
            assert!(block.text.ends_with(&format!(",\"next_offset\":{}}}", result["next_offset"])));
            assert_eq!(result["offset"], offset);
            assert_eq!(result["sources"], json!([{"id":"ref-1","hash":"source-hash"}]));
            let text = result["text"].as_str().unwrap();
            assert!(!text.is_empty());
            retrieved.push_str(text);
            match result["next_offset"].as_u64() {
                Some(next) => {
                    assert_eq!(next as usize, retrieved.len());
                    offset = next as usize;
                }
                None => break,
            }
        }
        assert!(reads > 1, "fixture must take multiple reads");
        assert_eq!(retrieved, note);
        assert_eq!(page(&native[2])["text"], note);
    }

    #[test]
    fn subsequent_read_preserves_visible_text_errors_and_unrelated_note_calls() {
        let note = "\"\n".repeat(3500);
        for (first, visible, error) in [("mem-1", true, false), ("mem-1", false, true), ("mem-2", false, false)] {
            let mut messages = read_batch(&[(first, &note, 0)]);
            if visible {
                let AgentMessage::Assistant(assistant) = &mut messages[0] else { unreachable!() };
                assistant.content.insert(0, Content::text("This observation must stay visible."));
            }
            if error {
                let AgentMessage::ToolResult(tool) = &mut messages[1] else { unreachable!() };
                tool.is_error = true;
                tool.content = vec![Content::text("Read failed")];
            }
            messages.extend(read_batch(&[("mem-1", &note, 1500)]));
            fit(&mut messages, 4096).unwrap();
            crate::agent::validate_transcript(&messages).unwrap();
            assert!(serde_json::to_vec(&messages).unwrap().len() <= 4096);
            let ids: Vec<_> = messages
                .iter()
                .filter_map(|message| match message {
                    AgentMessage::ToolResult(r) => Some(r.tool_call_id.as_str()),
                    _ => None,
                })
                .collect();
            assert_eq!(ids, [format!("{first}-0"), "mem-1-1500".to_owned()]);
            if visible {
                assert!(serde_json::to_string(&messages).unwrap().contains("This observation must stay visible."));
            }
        }
    }

    #[test]
    fn batch_keeps_short_read_and_returns_a_nonempty_window_for_both_long_reads() {
        let long = "\"🌙\n".repeat(1200);
        let mut messages = read_batch(&[("mem-1", &long, 0), ("mem-2", "短笔记", 0), ("mem-3", &long, 0)]);
        let short = page(&messages[2]);
        fit(&mut messages, 4096).unwrap();
        assert!(serde_json::to_vec(&messages).unwrap().len() <= 4096);
        assert_eq!(page(&messages[2]), short);
        for index in [1, 3] {
            let result = page(&messages[index]);
            let next = result["next_offset"].as_u64().unwrap() as usize;
            assert!(next > 0 && next < long.len());
            assert_eq!(result["text"], long[..next]);
        }
    }

    #[test]
    fn insufficient_budget_preserves_one_scalar_and_leaves_projection_over_limit() {
        let mut messages = read_batch(&[("mem-1", "🌙abc", 0)]);
        fit(&mut messages, 1).unwrap();
        assert!(serde_json::to_vec(&messages).unwrap().len() > 1);
        let result = page(&messages[1]);
        assert_eq!(result["text"], "🌙");
        assert_eq!(result["next_offset"], "🌙".len());
    }

    #[test]
    fn full_request_accounts_for_host_schemas_and_keeps_unconsumed_page_after_steering() {
        let note = "\"\n".repeat(2700);
        let mut messages = read_batch(&[("mem-1", &note, 0)]);
        messages.push(super::super::user("Also check the source.".into()));
        fit(&mut messages, 13_312).unwrap();
        let projected = page(&messages[1]);
        let mut context = rpi_ai::Context {
            system_prompt: Some("Test host".into()),
            tools: vec![rpi_ai::Tool {
                name: "host_tool".into(),
                description: "x".repeat(18_000),
                parameters: rpi_ai::Schema(json!({"type":"object"})),
                constrained_sampling: None,
            }],
            messages: messages
                .into_iter()
                .map(|m| match m {
                    AgentMessage::Assistant(a) => rpi_ai::Message::Assistant(a),
                    AgentMessage::ToolResult(r) => rpi_ai::Message::ToolResult(r),
                    AgentMessage::User(u) => rpi_ai::Message::User(u),
                    _ => unreachable!(),
                })
                .collect(),
        };
        let budget = crate::model_caps::TextBudget { projection_bytes: 13_312, request_bytes: 26_624 };
        assert!(budget.check(&context).is_err());
        fit_request(&mut context, budget).unwrap();
        let delivered = page(&context.messages[1].clone().into());
        let next = delivered["next_offset"].as_u64().unwrap() as usize;
        assert!(next > 0 && next < projected["next_offset"].as_u64().unwrap() as usize);
        assert_eq!(delivered["text"], note[..next]);
        assert!(budget.request_json_bytes(&context).unwrap() <= budget.request_bytes);
    }
}
