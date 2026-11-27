//! Exercise native Session note recall through the public Run entry point.
mod support;

use morrow_agent_core::{context_memory, RunMode};
use serde_json::{json, Value};
use support::{call, request, run, text, Provider, TempDir};

fn tool_reply(body: &Value, call_id: &str) -> Value {
    let message = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "tool" && message["tool_call_id"] == call_id)
        .expect("tool result should have reached the model");
    serde_json::from_str(message["content"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn adopted_note_is_recalled_after_reopening_in_plan_without_local_tools() {
    let root = TempDir::new();
    let source = "Please remember that I use the Delta compatibility profile.";
    let distinctive_tail = "Signed fixture label at the end of the saved preference";
    // Escaping this text makes the full record too large for inline recall,
    // while its original text still fits the version 1 note format.
    let note = format!("Delta compatibility profile\n{}{distinctive_tail}", "\"\n".repeat(4000));
    let provider = Provider::new(vec![
        call("propose", "memory_propose", json!({"kind":"preference","text":note,"source_ids":["ref-1"]})),
        text("Preference proposed."),
        call("search", "session_memory_search", json!({"query":"DELTA COMPATIBILITY"})),
        call("read", "session_memory_read", json!({"id":"mem-1"})),
        text("Found the adopted Delta profile preference."),
    ]);

    let (proposed, _) = run(request(root.path(), &provider, &[], 3, source)).await;
    assert_eq!(proposed.code, 0, "{}", proposed.error);
    let proposed_bodies = provider.bodies();
    assert_eq!(proposed_bodies.len(), 2);
    let candidate = tool_reply(&proposed_bodies[1], "propose");
    assert_eq!(candidate, json!({"id":"mem-1","status":"candidate","adopted":false}));
    assert!(!proposed_bodies[1].to_string().contains(distinctive_tail));

    let (adopted, _) = run(request(root.path(), &provider, &[], 1, "/memory accept mem-1")).await;
    assert_eq!(adopted.code, 0, "{}", adopted.error);
    assert_eq!(adopted.text, "/memory accept mem-1: saved");
    assert_eq!(provider.request_count(), 2, "adoption is a controller command");

    let mut plan = request(root.path(), &provider, &[], 4, "Retrieve my saved preference and check its source.");
    plan.mode = RunMode::Plan;
    assert!(!plan.enable_local_tools);
    let (recalled, _) = run(plan).await;
    assert_eq!(recalled.code, 0, "{}", recalled.error);
    assert_eq!(recalled.text, "Found the adopted Delta profile preference.");

    let bodies = provider.bodies();
    assert_eq!(bodies.len(), 5);
    let tools: Vec<_> =
        bodies[2]["tools"].as_array().unwrap().iter().map(|tool| tool["function"]["name"].as_str().unwrap()).collect();
    assert!(tools.contains(&"session_memory_search") && tools.contains(&"session_memory_read"));
    for name in ["memory_propose", "experience_propose", "exec"] {
        assert!(!tools.contains(&name), "Plan exposed {name}");
    }
    assert!(!bodies[2].to_string().contains(distinctive_tail));
    let search = tool_reply(&bodies[3], "search");
    assert_eq!(search["matches"][0]["id"], "mem-1");
    assert!(search["matches"][0]["excerpt"].as_str().unwrap().contains("Delta compatibility profile"));
    assert!(!bodies[3].to_string().contains(distinctive_tail));
    let read = tool_reply(&bodies[4], "read");
    assert_eq!(read["text"], note);
    assert_eq!(read["sources"], json!([{"id":"ref-1","hash":context_memory::hash(source.as_bytes())}]));
}
