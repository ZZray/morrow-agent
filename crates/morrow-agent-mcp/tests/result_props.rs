//! Property 48: `tools/call` result conversion (requirement 42.5).
use base64::Engine;
use morrow_agent_core::rpi_agent::TextContentOrImage;
use morrow_agent_mcp::tool::convert_result;
use proptest::prelude::*;
use serde_json::{json, Value};

#[test]
fn error_evidence_keeps_original_text_and_bound_identity_without_changing_error_contract() {
    use morrow_agent_mcp::tool::{convert_result_with_evidence, truncate_error};
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    for count in [10_999, 11_000, 11_001, 50_001] {
        let text = format!("\u{feff}{}\r\n", "原😀e\u{301}".repeat(count));
        let wire = json!({"isError":true,"content":[{"type":"text","text":text}],
            "structuredContent":{"server":"forged","call_id":"foreign","full_result_path":"untrusted"}});
        let original = format!("{text}\nstructuredContent: {}", wire["structuredContent"]);
        let receipt = convert_result_with_evidence("srv", "tool", "actual/1", &wire, Some(dir.path()));
        assert_eq!((&*receipt.server, &*receipt.tool, &*receipt.call_id), ("srv", "tool", "actual/1"));
        assert_eq!(receipt.error.as_deref(), Some(truncate_error(&original).as_str()));
        let details = &receipt.result.details;
        assert_eq!(std::fs::read(details["full_result_path"].as_str().unwrap()).unwrap(), original.as_bytes());
        assert_eq!(details["full_result_bytes"], original.len());
        assert_eq!(details["full_result_sha256"], format!("{:x}", Sha256::digest(original.as_bytes())));
        assert_eq!(details["original_chars"], original.chars().count());
        assert_eq!(receipt.into_result().unwrap_err(), truncate_error(&original));
    }
    // Exact scalar threshold and error head/tail remain unchanged.
    for count in [10_999, 11_000, 11_001] {
        let original = "😀".repeat(count);
        let wire = json!({"isError":true,"content":[{"type":"text","text":original}]});
        let saved = convert_result_with_evidence("s", "t", "id", &wire, Some(dir.path()));
        assert_eq!(saved.result.details["full_result_path"].is_string(), count > 11_000);
        assert_eq!(saved.into_result().unwrap_err(), truncate_error(&original));
    }
    let bad_dir = dir.path().join("not-a-directory");
    std::fs::write(&bad_dir, "keep").unwrap();
    for save in [None, Some(bad_dir.as_path())] {
        let receipt = convert_result_with_evidence(
            "s",
            "t",
            "id",
            &json!({"isError":true,
            "content":[{"type":"text","text":"x".repeat(12_000)}]}),
            save,
        );
        assert!(receipt.error.is_some());
        assert_eq!(receipt.result.details["truncated"], true);
        assert!(receipt.result.details["full_result_path"].is_null());
        assert!(receipt.into_result().is_err());
    }
    assert_eq!(std::fs::read_to_string(bad_dir).unwrap(), "keep");
    let structured = json!({"message":"x".repeat(1_100_000)});
    let receipt = convert_result_with_evidence(
        "s",
        "t",
        "structured-error",
        &json!({"isError":true,"structuredContent":structured}),
        Some(dir.path()),
    );
    let original = format!("structuredContent: {structured}");
    assert_eq!(
        std::fs::read_to_string(receipt.result.details["full_result_path"].as_str().unwrap()).unwrap(),
        original
    );
    assert!(receipt.result.details.get("structuredContent").is_none());
    assert!(serde_json::to_vec(&receipt.result.details).unwrap().len() < 2048);
    assert_eq!(receipt.into_result().unwrap_err(), truncate_error(&original));
    let unsaved = convert_result_with_evidence(
        "s",
        "t",
        "structured-unsaved",
        &json!({"isError":true,"structuredContent":structured}),
        None,
    );
    assert_eq!(unsaved.result.details["truncated"], true);
    assert!(unsaved.result.details.get("structuredContent").is_none());
    assert!(serde_json::to_vec(&unsaved.result.details).unwrap().len() < 2048);
    assert_eq!(unsaved.into_result().unwrap_err(), truncate_error(&original));
}

/// Reference conversion written from requirement 42.5.
fn reference(result: &Value) -> (bool, String, Vec<(String, String)>) {
    let failed = result["isError"] == json!(true);
    let mut texts = Vec::new();
    let mut images = Vec::new();
    for item in result["content"].as_array().cloned().unwrap_or_default() {
        if item["type"] == "text" && item["text"].is_string() {
            texts.push(item["text"].as_str().unwrap().to_string());
        } else if item["type"] == "image" && item["data"].is_string() && item["mimeType"].is_string() {
            let (data, mime) = (item["data"].as_str().unwrap(), item["mimeType"].as_str().unwrap());
            match base64::engine::general_purpose::STANDARD.decode(data) {
                Ok(bytes) if failed => texts.push(format!("[image: {mime}, {} bytes]", bytes.len())),
                Ok(_) => images.push((data.to_string(), mime.to_string())),
                Err(_) => texts.push(format!("[image: {mime}, invalid base64 data omitted]")),
            }
        } else {
            texts.push(item.to_string());
        }
    }
    let mut text = texts.join("\n");
    let structured = result.get("structuredContent").filter(|v| !v.is_null());
    if failed {
        if let Some(structured) = structured {
            text = if text.is_empty() {
                format!("structuredContent: {structured}")
            } else {
                format!("{text}\nstructuredContent: {structured}")
            };
        }
        if text.is_empty() {
            text = "MCP tool reported an error without text.".into();
        }
        let n = text.chars().count();
        if n > 11_000 {
            let head: String = text.chars().take(5_000).collect();
            let tail: String = text.chars().skip(n - 5_000).collect();
            text = format!("{head}\n\n[... {} characters omitted ...]\n\n{tail}", n - 10_000);
        }
        return (true, text, Vec::new());
    }
    if text.is_empty() && images.is_empty() {
        text = structured.map_or("(MCP tool returned no content)".to_string(), |s| s.to_string());
    }
    (false, text, images)
}

fn item() -> impl Strategy<Value = Value> {
    let long = (
        prop_oneof![Just('a'), Just('é'), Just('漢')],
        prop_oneof![Just(0usize), Just(4_999), Just(11_001), Just(30_000), Just(50_001), Just(60_000)],
    )
        .prop_map(|(c, n)| json!({"type":"text","text": std::iter::repeat_n(c, n).collect::<String>()}));
    prop_oneof![
        "[a-z ]{0,40}".prop_map(|t| json!({"type":"text","text":t})),
        long,
        proptest::collection::vec(any::<u8>(), 0..64).prop_map(|bytes| json!({"type":"image","mimeType":"image/png","data": base64::engine::general_purpose::STANDARD.encode(bytes)})),
        Just(json!({"type":"image","mimeType":"image/jpeg","data":"***not base64***"})),
        Just(json!({"type":"resource","resource":{"uri":"file:///a","mimeType":"text/plain","text":"inside"}})),
        Just(json!({"type":"resource_link","uri":"file:///b","name":"b"})),
        Just(json!({"type":"audio","data":"AAAA","mimeType":"audio/wav"})),
        Just(json!("bare string")),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn conversion_matches_reference(
        items in proptest::collection::vec(item(), 0..4),
        failed in any::<bool>(),
        structured in prop_oneof![Just(Value::Null), Just(json!({"rows":[1,2],"ok":true}))],
        save in any::<bool>(),
    ) {
        let mut result = json!({"content": items});
        if failed { result["isError"] = json!(true); }
        if !structured.is_null() { result["structuredContent"] = structured.clone(); }
        let dir = tempfile::tempdir().unwrap();
        let results_dir = save.then(|| dir.path().join("results"));
        let (expect_error, expected, images) = reference(&result);
        let actual = convert_result("srv", "tool", "call/1", &result, results_dir.as_deref());
        if expect_error {
            prop_assert_eq!(actual.unwrap_err(), expected);
            return Ok(());
        }
        let actual = actual.unwrap();
        prop_assert_eq!(&actual.details["server"], "srv");
        if !structured.is_null() {
            prop_assert_eq!(&actual.details["structuredContent"], &structured);
        }
        let mut content = actual.content.iter();
        let n = expected.chars().count();
        let text = match content.next() {
            Some(TextContentOrImage::Text(text)) => text.text.clone(),
            other => { prop_assert!(expected.is_empty(), "{:?}", other); String::new() }
        };
        if n <= 50_000 {
            prop_assert_eq!(&text, &expected);
            prop_assert!(actual.details.get("original_chars").is_none());
        } else if save {
            let path = actual.details["full_result_path"].as_str().unwrap();
            prop_assert_eq!(std::fs::read_to_string(path).unwrap(), expected.clone());
            use sha2::Digest;
            prop_assert_eq!(&actual.details["full_result_bytes"], &json!(expected.len()));
            prop_assert_eq!(&actual.details["full_result_sha256"], &json!(format!("{:x}", sha2::Sha256::digest(expected.as_bytes()))));
            let excerpt: String = expected.chars().take(2_000).collect();
            prop_assert_eq!(text, format!("MCP result has {n} characters; the full text is saved to {path}. First 2000 characters:\n{excerpt}"));
        } else {
            let head: String = expected.chars().take(50_000).collect();
            prop_assert_eq!(text, format!("{head}\n\n[... result truncated: {} characters omitted ...]", n - 50_000));
            prop_assert_eq!(&actual.details["truncated"], &json!(true));
        }
        let actual_images: Vec<(String, String)> = actual.content.iter().filter_map(|c| match c {
            TextContentOrImage::Image(image) => Some((image.data.clone(), image.mime_type.clone())),
            _ => None,
        }).collect();
        prop_assert_eq!(actual_images, images);
    }
}
