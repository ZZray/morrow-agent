// Copyright (c) Ray Zhang. Verify original MCP images before issuing a capture ID.
use anyhow::{ensure, Context, Result};
use base64::Engine;
use morrow_agent_core::rpi_agent::{AgentToolResult, TextContentOrImage};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::{Cursor, Read},
    path::Path,
};

const TEXT_MAX: usize = 8_388_608;

pub fn content(result: &AgentToolResult) -> Vec<Value> {
    result
        .content
        .iter()
        .map(|part| match part {
            TextContentOrImage::Text(value) => json!({"type":"text","text":value.text}),
            TextContentOrImage::Image(value) => json!({"type":"image","mimeType":value.mime_type,"data":value.data}),
        })
        .collect()
}

/// Recover the adapter's original result text, never a path supplied in the
/// backend's nested structuredContent. The helper reads it under its own user.
pub fn full_content(result: &AgentToolResult, directory: &Path) -> Result<Vec<Value>> {
    ensure!(result.details["truncated"] != true, "backend full text was not saved; only an excerpt is available");
    let mut parts = content(result);
    if let Some(path) = result.details["full_result_path"].as_str() {
        let path = Path::new(path);
        ensure!(
            path.is_absolute() && path.parent() == Some(directory),
            "full result is outside this helper generation"
        );
        ensure!(!std::fs::symlink_metadata(path)?.file_type().is_symlink(), "full result is a link");
        ensure!(
            path.canonicalize()?.parent() == Some(directory),
            "full result resolved outside this helper generation"
        );
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1).custom_flags(0x00200000); // read sharing only, OPEN_REPARSE_POINT
        }
        let file = options.open(path)?;
        let info = file.metadata()?;
        ensure!(info.is_file() && info.len() <= TEXT_MAX as u64, "full result is not a bounded ordinary file");
        #[cfg(windows)]
        {
            use std::os::windows::{ffi::OsStringExt, fs::MetadataExt, io::AsRawHandle};
            ensure!(info.file_attributes() & 0x400 == 0, "full result is a reparse point");
            let mut buffer = vec![0u16; 32768];
            let count = unsafe {
                windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW(
                    file.as_raw_handle() as _,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    0,
                )
            } as usize;
            ensure!(count > 0 && count < buffer.len(), "cannot identify the opened full result");
            let opened = std::path::PathBuf::from(std::ffi::OsString::from_wide(&buffer[..count]));
            ensure!(opened.parent() == Some(directory), "opened full result belongs to a different generation");
        }
        let mut bytes = Vec::new();
        file.take((TEXT_MAX + 1) as u64).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= TEXT_MAX && bytes.len() as u64 == info.len(), "full result changed while reading");
        ensure!(
            result.details["full_result_bytes"].as_u64() == Some(bytes.len() as u64)
                && result.details["full_result_sha256"].as_str()
                    == Some(format!("{:x}", Sha256::digest(&bytes)).as_str()),
            "saved full result differs from original MCP text"
        );
        let text = String::from_utf8(bytes).context("full result is not valid UTF-8")?;
        ensure!(
            result.details["original_chars"].as_u64() == Some(text.chars().count() as u64),
            "full result character count differs"
        );
        ensure!(parts.first().is_some_and(|v| v["type"] == "text"), "full result has no original text position");
        parts[0] = json!({"type":"text","text":text});
    } else {
        ensure!(result.details["original_chars"].is_null(), "original text count has no saved full result");
    }
    Ok(parts)
}

/// Replace large text with immutable source bytes after labels/error detection.
pub fn text_sources(parts: &mut [Value], saved_full_text: bool) -> Result<Vec<Value>> {
    let mut files = Vec::new();
    for (index, part) in parts.iter_mut().enumerate() {
        let Some(text) = part["text"].as_str().filter(|_| part["type"] == "text") else { continue };
        if text.len() <= 65_536 && !(saved_full_text && index == 0) {
            continue;
        }
        ensure!(text.len() <= TEXT_MAX, "desktop text exceeds artifact bound");
        let sha = format!("{:x}", Sha256::digest(text.as_bytes()));
        files.push(json!({"contentIndex":index,"mimeType":"text/plain","bytes":text.len(),"sha256":sha,"characterCount":text.chars().count()}));
        *part = json!({"type":"artifact_source","mimeType":"text/plain","data":base64::engine::general_purpose::STANDARD.encode(text.as_bytes())});
    }
    Ok(files)
}

pub fn image_manifest(parts: &[Value], required: bool) -> Result<Vec<Value>> {
    let mut manifests = Vec::new();
    for (index, part) in parts.iter().enumerate().filter(|(_, p)| p["type"] == "image") {
        ensure!(part["mimeType"] == "image/png", "desktop backend returned an unsupported image type");
        let data = part["data"].as_str().context("desktop image has no data")?;
        ensure!(data.len() <= 12 * 1024 * 1024, "desktop image exceeds encoded bound");
        let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
        let mut decoder = png::Decoder::new(Cursor::new(&bytes));
        decoder.set_limits(png::Limits { bytes: 64 * 1024 * 1024 });
        let mut reader = decoder.read_info()?;
        let size = reader.output_buffer_size().context("desktop image size overflow")?;
        ensure!(size <= 64 * 1024 * 1024, "desktop image exceeds decoded bound");
        let mut output = vec![0; size];
        let frame = reader.next_frame(&mut output)?;
        reader.finish()?;
        ensure!(frame.width > 0 && frame.height > 0, "desktop image is empty");
        manifests.push(json!({"contentIndex": index, "mimeType":"image/png", "bytes":bytes.len(),
            "width":frame.width, "height":frame.height, "sha256":format!("{:x}", Sha256::digest(&bytes))}));
    }
    ensure!(!required || !manifests.is_empty(), "desktop capture returned no valid image");
    Ok(manifests)
}

pub fn backend_reported_error(parts: &[Value]) -> bool {
    parts.iter().any(|p| {
        p["text"].as_str().is_some_and(|s| {
            let s = s.trim_start();
            s.starts_with("Error capturing ")
        })
    })
}

pub fn labels(parts: &[Value]) -> Option<Vec<Value>> {
    parts.iter().filter_map(|p| p["text"].as_str()).find_map(|text| {
        let (_, data) = text.rsplit_once("\nReach UI Labels: ")?;
        serde_json::from_str::<Vec<Value>>(data.trim()).ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_part() -> Value {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().unwrap().write_image_data(&[255, 0, 0, 0, 255, 0]).unwrap();
        json!({"type":"image","mimeType":"image/png","data":base64::engine::general_purpose::STANDARD.encode(bytes)})
    }

    #[test]
    fn decode_original_png_and_reject_missing_or_corrupt_pixels() {
        let part = png_part();
        let manifest = image_manifest(std::slice::from_ref(&part), true).unwrap();
        assert_eq!(manifest[0]["width"], 2);
        assert_eq!(manifest[0]["height"], 1);
        assert!(image_manifest(&[], true).is_err());
        assert!(image_manifest(&[], false).unwrap().is_empty());
        let mut bytes = base64::engine::general_purpose::STANDARD.decode(part["data"].as_str().unwrap()).unwrap();
        bytes.truncate(bytes.len() - 10);
        let broken = json!({"type":"image","mimeType":"image/png","data":base64::engine::general_purpose::STANDARD.encode(bytes)});
        assert!(image_manifest(&[broken], true).is_err());
    }

    #[test]
    fn labels_must_be_a_complete_table_and_capture_errors_are_explicit() {
        assert!(labels(&[json!({"text":"Tree\nReach UI Labels: [{\"label\":0}]\n"})]).is_some());
        assert!(labels(&[json!({"text":"Tree\nReach UI Labels: [{ truncated"})]).is_none());
        assert!(backend_reported_error(&[json!({"text":"Error capturing screenshot: invalid region"})]));
        assert!(!backend_reported_error(&[json!({"text":"Error: an actual file's content"})]));
    }

    #[test]
    fn adapter_full_text_roundtrip_preserves_scalar_boundaries_labels_and_errors() {
        let directory =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../work").join(format!("full-text-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        for (unit, count) in [("😀", 49_999), ("😀", 50_000), ("😀", 50_001), ("x", 50_001), ("x", 65_536)] {
            let text = unit.repeat(count);
            let result = morrow_agent_mcp::tool::convert_result(
                "windows",
                "Snapshot",
                "boundary",
                &json!({"content":[{"type":"text","text":text}]}),
                Some(&directory),
            )
            .unwrap();
            let mut parts = full_content(&result, &directory).unwrap();
            assert_eq!(parts[0]["text"], text);
            let files = text_sources(&mut parts, result.details["full_result_path"].is_string()).unwrap();
            assert_eq!(files[0]["characterCount"], count);
            let bytes = base64::engine::general_purpose::STANDARD.decode(parts[0]["data"].as_str().unwrap()).unwrap();
            assert_eq!(bytes, text.as_bytes());
            assert_eq!(result.details["full_result_path"].is_string(), count > 50_000);
        }
        let text = format!("\u{feff}{}\r\nReach UI Labels: [{{\"label\":0}}]", "中文😀e\u{301}\r\n".repeat(12_000));
        let result = morrow_agent_mcp::tool::convert_result(
            "windows",
            "Snapshot",
            "labels",
            &json!({"content":[{"type":"text","text":text}]}),
            Some(&directory),
        )
        .unwrap();
        let parts = full_content(&result, &directory).unwrap();
        assert_eq!(parts[0]["text"], text);
        assert!(labels(&parts).is_some());
        let error = format!("Error capturing screenshot: {}", "x".repeat(60_000));
        let result = morrow_agent_mcp::tool::convert_result(
            "windows",
            "Snapshot",
            "error",
            &json!({"content":[{"type":"text","text":error}]}),
            Some(&directory),
        )
        .unwrap();
        assert!(!backend_reported_error(&content(&result)));
        assert!(backend_reported_error(&full_content(&result, &directory).unwrap()));
    }

    #[test]
    fn missing_corrupt_foreign_or_unsaved_full_text_is_not_claimed_complete() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../work")
            .join(format!("full-text-errors-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        let original = json!({"content":[{"type":"text","text":"文".repeat(50_001)}]});
        let saved =
            morrow_agent_mcp::tool::convert_result("windows", "Read", "saved", &original, Some(&directory)).unwrap();
        let path = Path::new(saved.details["full_result_path"].as_str().unwrap());
        let mut changed = saved.clone();
        changed.details["original_chars"] = json!(2);
        assert!(full_content(&changed, &directory).is_err());
        assert!(full_content(&saved, directory.parent().unwrap()).is_err());
        std::fs::write(path, "字".repeat(50_001)).unwrap();
        assert!(full_content(&saved, &directory).unwrap_err().to_string().contains("original MCP text"));
        std::fs::write(path, [0xff]).unwrap();
        assert!(full_content(&saved, &directory).is_err());
        std::fs::remove_file(path).unwrap();
        assert!(full_content(&saved, &directory).is_err());
        std::fs::create_dir(path).unwrap();
        assert!(full_content(&saved, &directory).is_err());
        let unsaved = morrow_agent_mcp::tool::convert_result("windows", "Read", "unsaved", &original, None).unwrap();
        assert_eq!(unsaved.details["truncated"], true);
        assert!(full_content(&unsaved, &directory).is_err());
        assert!(morrow_agent_mcp::tool::convert_result(
            "windows",
            "Read",
            "failed",
            &json!({"isError":true,"content":original["content"]}),
            Some(&directory)
        )
        .is_err());
    }

    #[test]
    fn error_full_text_is_verified_and_preserved_without_changing_the_failure() {
        let directory =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../work").join(format!("error-text-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        let text = format!("\u{feff}原始错误\r\n{}", "诊断😀e\u{301}\r\n".repeat(3000));
        let raw = json!({"isError":true,"content":[{"type":"text","text":text}]});
        let saved = morrow_agent_mcp::tool::convert_result_with_evidence(
            "windows",
            "Screenshot",
            "original-id",
            &raw,
            Some(&directory),
        );
        assert!(saved.error.is_some());
        let mut parts = full_content(&saved.result, &directory).unwrap();
        assert_eq!(parts[0]["text"], text);
        let files = text_sources(&mut parts, true).unwrap();
        assert_eq!(files[0]["bytes"], text.len());
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(parts[0]["data"].as_str().unwrap()).unwrap(),
            text.as_bytes()
        );
        let path = Path::new(saved.result.details["full_result_path"].as_str().unwrap());
        std::fs::write(path, "tampered").unwrap();
        assert!(full_content(&saved.result, &directory).is_err());
        std::fs::remove_file(path).unwrap();
        assert!(full_content(&saved.result, &directory).is_err());
        assert!(saved.into_result().is_err());
        let unsaved =
            morrow_agent_mcp::tool::convert_result_with_evidence("windows", "Screenshot", "missing", &raw, None);
        assert!(full_content(&unsaved.result, &directory).is_err());
        assert!(unsaved.into_result().is_err());
    }
}
