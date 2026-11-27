//! Regression tests for bounded recall of accepted Session notes.
use super::*;

struct Fixture {
    root: PathBuf,
    path: PathBuf,
    store: Shared,
}

impl Fixture {
    fn new() -> Self {
        let mut suffix = [0_u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let root = std::env::temp_dir().join(format!("morrow-session-memory-{:016x}", u64::from_ne_bytes(suffix)));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("session.context.json");
        let mut store = Store::load(&path, "fixture".into(), &[]).unwrap();
        store.cloud_migrated = true;
        Self { root, path, store: Arc::new(Mutex::new(store)) }
    }

    fn source(&self, text: &str) -> String {
        self.store.lock().unwrap().add_reference("objective", text.into(), "source-run").unwrap()
    }

    fn note(&self, source: &str, text: &str) -> String {
        self.store
            .lock()
            .unwrap()
            .propose(Proposal { kind: "fact".into(), text: text.into(), source_ids: vec![source.into()] }, "note-run")
            .unwrap()
    }

    fn command(&self, text: &str) {
        self.store.lock().unwrap().command(text, "review-run", 0).unwrap();
    }

    fn accept(&self, source: &str, text: &str) -> String {
        let id = self.note(source, text);
        self.command(&format!("/memory accept {id}"));
        id
    }

    fn view(&self) -> Value {
        let projected = self.store.lock().unwrap().projection(&[]).unwrap();
        let AgentMessage::User(message) = &projected[0] else { panic!("expected working context") };
        let rpi_ai::UserContent::Text(text) = &message.content else { panic!("expected text working context") };
        serde_json::from_str(text.lines().last().unwrap()).unwrap()
    }

    fn perform(&self, name: &str, args: Value) -> Result<Value> {
        let tool = MemoryTool {
            store: self.store.clone(),
            path: self.path.clone(),
            run: "recall-run".into(),
            token: String::new(),
            evidence: Arc::new(|| panic!("reading notes needs no native Run evidence")),
            schema: Tool {
                name: name.into(),
                description: String::new(),
                parameters: Schema(json!({"type":"object"})),
                constrained_sampling: None,
            },
        };
        let encoded = tool.perform(args, &CancellationToken::new())?;
        let result: Value = serde_json::from_str(&encoded)?;
        if name == "session_memory_read" {
            assert!(encoded.ends_with(&format!(",\"next_offset\":{}}}", result["next_offset"])));
        }
        Ok(result)
    }

    fn reopen(&self) -> Vec<u8> {
        let mut store = self.store.lock().unwrap();
        store.save(&self.path).unwrap();
        *store = Store::load(&self.path, "fixture".into(), &[]).unwrap();
        std::fs::read(&self.path).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // The fixture created this exact, randomly named directory.
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn existing_notes_reopen_with_bounded_projection_and_complete_on_demand_recall() {
    let fixture = Fixture::new();
    let source_text = "User-verified setup";
    let source = fixture.source(source_text);
    let old_text = "Old, uniquely searchable Étiquette";
    let old = fixture.accept(&source, old_text);
    for index in 2..=14 {
        fixture.accept(&source, &format!("Accepted fact {index}"));
    }
    let large_text = "\"\n".repeat(4096);
    let large = fixture.accept(&source, &large_text);
    let audit = fixture.reopen();
    assert_eq!(serde_json::from_slice::<Value>(&audit).unwrap()["version"], 1);

    let view = fixture.view();
    let inline = view["accepted_memories"].as_array().unwrap();
    assert_eq!(view["accepted_memory_count"], 15);
    assert!(view["memory_retrieval"].as_str().unwrap().contains("session_memory_search"));
    assert_eq!(inline.len(), 8);
    assert!(serde_json::to_vec(inline).unwrap().len() <= 8192);
    assert!(inline.contains(&json!({"id":"mem-14","kind":"fact","text":"Accepted fact 14","source_ids":[source]})));
    assert!(inline.iter().all(|row| row["id"] != old && row["id"] != large));

    let mut ids = Vec::new();
    let mut args = json!({});
    for size in [6, 6, 3] {
        let page = fixture.perform("session_memory_search", args).unwrap();
        let rows = page["matches"].as_array().unwrap();
        assert_eq!(rows.len(), size);
        ids.extend(rows.iter().map(|row| row["id"].as_str().unwrap().to_owned()));
        args = json!({"before":page["next_before"]});
    }
    assert!(args["before"].is_null());
    assert_eq!(ids, (1..=15).rev().map(|index| format!("mem-{index}")).collect::<Vec<_>>());

    let found = fixture.perform("session_memory_search", json!({"query":"UNIQUELY SEARCHABLE"})).unwrap();
    assert_eq!(
        found["matches"],
        json!([{"id":old,"kind":"fact","match_offset":5,"excerpt_offset":0,"excerpt":old_text}])
    );
    let found_by_id = fixture.perform("session_memory_search", json!({"query":large})).unwrap();
    assert_eq!(found_by_id["matches"].as_array().unwrap().len(), 1);
    assert_eq!(found_by_id["matches"][0]["id"], large);
    assert_eq!(found_by_id["matches"][0].get("match_offset"), Some(&Value::Null));
    let read = fixture.perform("session_memory_read", json!({"id":large})).unwrap();
    assert_eq!(read["text"], large_text);
    assert_eq!(read["sources"], json!([{"id":source,"hash":hash(source_text.as_bytes())}]));

    assert_eq!(fixture.store.lock().unwrap().memories.last().unwrap().text.as_str(), large_text);
    assert_eq!(std::fs::read(&fixture.path).unwrap(), audit);
}

#[test]
fn note_windows_and_search_positions_use_utf8_bytes_and_recheck_sources() {
    let fixture = Fixture::new();
    let source = fixture.source("User-verified page source");
    let prefix = "字".repeat(23);
    let note = format!("{prefix}匹配🌙尾");
    let id = fixture.accept(&source, &note);
    let read = |args| fixture.perform("session_memory_read", args);
    let full = read(json!({"id":id})).unwrap();
    assert_eq!(full["text"], note);
    assert_eq!(full["offset"], 0);
    assert_eq!(full["bytes"], note.len());
    assert_eq!(full.get("next_offset"), Some(&Value::Null));

    let found = fixture.perform("session_memory_search", json!({"query":"匹配"})).unwrap();
    let hit = &found["matches"][0];
    assert_eq!(hit["match_offset"], prefix.len());
    assert_eq!(hit["excerpt_offset"], prefix.len() - 48);
    assert_eq!(hit["excerpt"], note[prefix.len() - 48..]);

    let page = read(json!({"id":id,"offset":hit["match_offset"],"limit":8})).unwrap();
    assert_eq!(page["text"], "匹配");
    assert_eq!(page["offset"], prefix.len());
    assert_eq!(page["next_offset"], prefix.len() + "匹配".len());
    assert_eq!(page["sources"], full["sources"]);
    let tail_args = json!({"id":id,"offset":page["next_offset"]});
    let tail = read(tail_args.clone()).unwrap();
    assert_eq!(tail["text"], "🌙尾");
    assert_eq!(tail.get("next_offset"), Some(&Value::Null));
    let eof = read(json!({"id":id,"offset":note.len()})).unwrap();
    assert_eq!(eof["text"], "");
    assert_eq!(eof.get("next_offset"), Some(&Value::Null));

    for invalid in [
        json!({"id":id,"offset":1}),
        json!({"id":id,"offset":note.len()+1}),
        json!({"id":id,"offset":-1}),
        json!({"id":id,"offset":"0"}),
        json!({"id":id,"limit":1}),
        json!({"id":id,"limit":0}),
        json!({"id":id,"limit":8193}),
        json!({"id":id,"limit":2.5}),
    ] {
        assert!(read(invalid.clone()).is_err(), "accepted {invalid}");
    }
    fixture.command(&format!("/reference correct {source} updated source"));
    assert!(read(tail_args).unwrap_err().to_string().contains("current adopted Session note not found"));
}

#[test]
fn note_previews_fit_remaining_working_context_headroom() {
    let fixture = Fixture::new();
    let source = fixture.source("Source shared by three notes");
    let extra_source = "x".repeat(160);
    while serde_json::to_vec(&fixture.view()).unwrap().len() < 92 * 1024 {
        fixture.source(&extra_source);
    }
    for _ in 0..3 {
        fixture.accept(&source, &"a".repeat(3000));
    }
    let view = fixture.view();
    let previews = view["accepted_memories"].as_array().unwrap();
    assert_eq!(view["accepted_memory_count"], 3);
    assert_eq!(previews.len(), 1);
    assert_eq!(previews[0]["id"], "mem-3");
    assert!(serde_json::to_vec(&view).unwrap().len() <= 96 * 1024);
}

#[test]
fn closed_turn_summary_retains_a_locator_for_a_long_note_read() {
    let fixture = Fixture::new();
    let source = fixture.source("Test source");
    let note = format!("{}summary-tail-marker", "\"\n".repeat(3900));
    let id = fixture.accept(&source, &note);
    let receipt = fixture.perform("session_memory_read", json!({"id":id})).unwrap();
    let mut assistant = rpi_ai::AssistantMessage::empty(rpi_ai::Api::OpenaiCompletions, "test", "test", 0);
    let mut call = assistant.clone();
    call.stop_reason = rpi_ai::StopReason::ToolUse;
    call.content.push(Content::ToolCall(rpi_ai::ToolCall {
        kind: rpi_ai::ToolCallType,
        id: "read-1".into(),
        name: "session_memory_read".into(),
        arguments: json!({"id":id}),
        thought_signature: None,
        namespace: None,
    }));
    assistant.content.push(Content::text("Done"));
    let result = AgentMessage::ToolResult(Box::new(rpi_ai::ToolResultMessage {
        role: Default::default(),
        tool_call_id: "read-1".into(),
        tool_name: "session_memory_read".into(),
        content: vec![Content::text(receipt.to_string())],
        details: None,
        usage: None,
        added_tool_names: vec![],
        is_error: false,
        timestamp: 0,
    }));
    let messages = [
        user("Read the note".into()),
        AgentMessage::Assistant(Box::new(call)),
        result.clone(),
        AgentMessage::Assistant(Box::new(assistant)),
        user("x".repeat(4000)),
    ];
    let store = fixture.store.lock().unwrap();
    let limit = serde_json::to_vec(&messages[4..]).unwrap().len() + 256;
    let projection = store.projection_with_note_budget(&messages, limit).unwrap();
    let (cut, summary) = store.summary_content_with_projection(&messages, &projection, 4, limit).unwrap().unwrap();
    assert_eq!(cut, 4);
    let rpi_ai::UserContent::Text(summary) = summary else { panic!("expected a text summary") };
    assert!(!summary.contains("summary-tail-marker"));
    let input: Value = serde_json::from_str(&summary).unwrap();
    let closed: Vec<AgentMessage> = serde_json::from_value(input["closed_old_messages"].clone()).unwrap();
    let AgentMessage::ToolResult(tool) = &closed[2] else { panic!("expected a retained tool result") };
    let [Content::Text(block)] = tool.content.as_slice() else { panic!("expected a text locator") };
    let locator: Value = serde_json::from_str(&block.text).unwrap();
    assert_eq!(locator["id"], id);
    assert_eq!(locator["offset"], 0);
    assert_eq!(locator["sources"], receipt["sources"]);
    assert!(locator.get("text").is_none());
    assert_eq!(messages[2], result);
    assert_eq!(receipt["text"], note);

    // Compaction must measure the current proposal as the model sees it.
    let mut messages = messages.to_vec();
    let AgentMessage::Assistant(mut proposal) = messages[1].clone() else { unreachable!() };
    let Content::ToolCall(call) = &mut proposal.content[0] else { unreachable!() };
    call.id = "propose-2".into();
    call.name = "memory_propose".into();
    call.arguments = json!({"kind":"fact","text":note,"source_ids":[source]});
    let AgentMessage::ToolResult(mut candidate) = result else { unreachable!() };
    candidate.tool_name = call.name.clone();
    candidate.tool_call_id = call.id.clone();
    candidate.content = vec![Content::text(json!({"id":"mem-2","status":"candidate","adopted":false}).to_string())];
    messages.extend([AgentMessage::Assistant(proposal), AgentMessage::ToolResult(candidate)]);
    let limit = 6000;
    assert!(serde_json::to_vec(&messages[4..]).unwrap().len() > limit);
    let projected = store.projection_with_note_budget(&messages, limit).unwrap();
    assert!(store.summary_content_with_projection(&messages, &projected, 4, limit).unwrap().is_some());
}

#[test]
fn unaccepted_revoked_and_stale_notes_are_absent_from_projection_and_retrieval() {
    let fixture = Fixture::new();
    let active = fixture.source("Stable local source");
    let corrected = fixture.source("Stale reference version");
    let candidate = fixture.note(&active, "shared marker candidate");
    let revoked = fixture.accept(&active, "shared marker revoked");
    let stale_source = fixture.accept(&corrected, "shared marker corrected");
    let current = fixture.accept(&active, "shared marker current");
    fixture.command(&format!("/memory revoke {revoked}"));
    fixture.command(&format!("/reference correct {corrected} corrected source data"));

    let snapshot = CloudSnapshot {
        version: 1,
        status: "ready".into(),
        device_id: "test-device".into(),
        epoch: "epoch-1".into(),
        records: vec![],
    };
    fixture.store.lock().unwrap().sync_cloud(Some(snapshot.clone()), 0);
    let stale_cloud = fixture.accept(&active, "shared marker cloud");
    assert!(fixture.perform("session_memory_read", json!({"id":stale_cloud})).is_ok());
    fixture.store.lock().unwrap().sync_cloud(Some(CloudSnapshot { epoch: "epoch-2".into(), ..snapshot }), 0);
    let audit = fixture.reopen();

    let view = fixture.view();
    assert_eq!(view["accepted_memory_count"], 1);
    assert_eq!(view["accepted_memories"][0]["id"], current);
    let found = fixture.perform("session_memory_search", json!({"query":"shared marker"})).unwrap();
    assert_eq!(found["matches"].as_array().unwrap().len(), 1);
    assert_eq!(found["matches"][0]["id"], current);
    for id in [candidate, revoked, stale_source, stale_cloud] {
        assert!(fixture.perform("session_memory_read", json!({"id":id})).is_err());
        let found = fixture.perform("session_memory_search", json!({"query":id})).unwrap();
        assert_eq!(found["matches"], json!([]));
    }
    assert_eq!(fixture.store.lock().unwrap().memories.len(), 5);
    assert_eq!(std::fs::read(&fixture.path).unwrap(), audit);
}
