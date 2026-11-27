//! Validated PNG tool-image payloads, separated text/image byte accounting, and
//! interrupted-Run image settlement contracts.
use std::fs::OpenOptions;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use base64::Engine;
use rpi_agent::AgentMessage;
use rpi_ai::{Content, ImageContent, Message, UserContent};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RUN_IMAGE_BYTES: usize = 16 * 1024 * 1024;
pub const ACTIVE_IMAGE_BYTES: usize = 24 * 1024 * 1024;
pub const PRIOR_IMAGE_COMPACT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_CALL_IMAGES: usize = 4;
pub const MAX_RECONCILED_IMAGES: usize = 16;
pub const MAX_IMAGE_DIMENSION: u32 = 8192;
pub const MAX_IMAGE_PIXELS: u64 = 16_777_216;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PngDimensions {
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettledToolImage {
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<PathBuf>,
    pub sha256: String,
    pub bytes: usize,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

impl SettledToolImage {
    pub fn load_verified(&self, allowed_root: Option<&Path>) -> Result<(ImageContent, Vec<u8>)> {
        ensure!(self.mime_type == "image/png", "settled tool image must declare image/png");
        ensure!(self.bytes > 0 && self.bytes <= MAX_IMAGE_BYTES, "settled tool image byte length out of bounds");
        ensure!(is_lower_sha256(&self.sha256), "settled tool image sha256 must be 64 lowercase hex chars");
        ensure!(self.path.is_absolute(), "settled tool image path must be absolute");
        let meta = std::fs::symlink_metadata(&self.path).context("settled tool image missing")?;
        ensure!(meta.file_type().is_file(), "settled tool image must be a regular file, not a symlink or directory");
        let canonical_file = std::fs::canonicalize(&self.path).context("settled tool image canonicalize failed")?;
        for root in [allowed_root, self.root.as_deref()].into_iter().flatten() {
            ensure!(root.is_absolute(), "settled tool image root must be absolute");
            let canonical_root = std::fs::canonicalize(root).context("settled tool image root unavailable")?;
            ensure!(canonical_file.starts_with(&canonical_root), "settled tool image escaped allowed root");
        }
        let mut file = OpenOptions::new().read(true).open(&canonical_file).context("open settled tool image")?;
        ensure!(
            file.metadata().context("stat opened settled tool image")?.is_file(),
            "opened image handle is not a regular file"
        );
        let mut bytes = Vec::with_capacity(self.bytes.min(64 * 1024));
        file.by_ref().take((MAX_IMAGE_BYTES as u64) + 1).read_to_end(&mut bytes).context("read settled tool image")?;
        ensure!(bytes.len() == self.bytes, "settled tool image byte count differs from receipt");
        let actual_sha = sha256_hex(&bytes);
        ensure!(actual_sha == self.sha256, "settled tool image sha256 differs from receipt");
        let dims = validate_png_bytes(&bytes)?;
        ensure!(
            dims.width == self.width && dims.height == self.height,
            "settled tool image PNG dimensions differ from receipt"
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok((ImageContent { kind: Default::default(), data: encoded, mime_type: "image/png".into() }, bytes))
    }
}

pub fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn decode_base64(data: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(data).context("invalid base64 image payload")
}

fn crc32_png(chunk_type: &[u8; 4], data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in chunk_type.iter().chain(data.iter()) {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Strictly validate a single static RFC-2083 PNG image (signature, IHDR bounds,
/// chunk framing, IEEE CRC-32 on every chunk, IDAT presence, exact IEND tail,
/// and no APNG animation chunks).
pub fn validate_png_bytes(bytes: &[u8]) -> Result<PngDimensions> {
    ensure!(!bytes.is_empty() && bytes.len() <= MAX_IMAGE_BYTES, "PNG byte length out of bounds");
    ensure!(bytes.len() >= 33 && bytes[..8] == PNG_SIGNATURE, "invalid PNG signature");
    let mut offset = 8usize;
    let mut dimensions: Option<PngDimensions> = None;
    let mut color_type = 0u8;
    let mut seen_plte = false;
    let mut seen_idat = false;
    let mut seen_iend = false;

    while offset < bytes.len() {
        ensure!(!seen_iend, "trailing bytes after PNG IEND chunk");
        ensure!(offset + 12 <= bytes.len(), "truncated PNG chunk header");
        let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let chunk_type: [u8; 4] = bytes[offset + 4..offset + 8].try_into().unwrap();
        ensure!(chunk_type.iter().all(|b| b.is_ascii_alphabetic()), "invalid PNG chunk type");
        let data_start = offset + 8;
        let data_end = data_start.checked_add(length).context("PNG chunk length overflow")?;
        let crc_end = data_end.checked_add(4).context("PNG chunk CRC overflow")?;
        ensure!(crc_end <= bytes.len(), "truncated PNG chunk body");
        let data = &bytes[data_start..data_end];
        let expected_crc = u32::from_be_bytes(bytes[data_end..crc_end].try_into().unwrap());
        ensure!(crc32_png(&chunk_type, data) == expected_crc, "corrupt PNG chunk CRC");

        if matches!(&chunk_type, b"acTL" | b"fcTL" | b"fdAT") {
            bail!("animated APNG chunks are not supported");
        }

        if dimensions.is_none() {
            ensure!(&chunk_type == b"IHDR" && length == 13, "PNG must start with a 13-byte IHDR chunk");
            let width = u32::from_be_bytes(data[0..4].try_into().unwrap());
            let height = u32::from_be_bytes(data[4..8].try_into().unwrap());
            ensure!(
                (1..=MAX_IMAGE_DIMENSION).contains(&width) && (1..=MAX_IMAGE_DIMENSION).contains(&height),
                "PNG dimensions out of bounds ({width}x{height})"
            );
            ensure!(u64::from(width) * u64::from(height) <= MAX_IMAGE_PIXELS, "PNG pixel count exceeds safety bound");
            let bit_depth = data[8];
            color_type = data[9];
            let valid_depth = match color_type {
                0 => matches!(bit_depth, 1 | 2 | 4 | 8 | 16),
                2 | 4 | 6 => matches!(bit_depth, 8 | 16),
                3 => matches!(bit_depth, 1 | 2 | 4 | 8),
                _ => false,
            };
            ensure!(valid_depth, "invalid PNG color type or bit depth");
            ensure!(data[10] == 0 && data[11] == 0 && data[12] <= 1, "invalid PNG compression, filter, or interlace");
            dimensions = Some(PngDimensions { width, height });
        } else {
            ensure!(&chunk_type != b"IHDR", "duplicate PNG IHDR chunk");
            match &chunk_type {
                b"PLTE" => {
                    ensure!(!seen_idat, "PNG PLTE chunk after IDAT");
                    ensure!(
                        matches!(color_type, 2 | 3 | 6)
                            && !seen_plte
                            && !data.is_empty()
                            && data.len().is_multiple_of(3)
                            && data.len() <= 256 * 3,
                        "invalid PNG PLTE chunk"
                    );
                    seen_plte = true;
                }
                b"IDAT" => {
                    if color_type == 3 {
                        ensure!(seen_plte, "indexed PNG missing PLTE before IDAT");
                    }
                    seen_idat = true;
                }
                b"IEND" => {
                    ensure!(length == 0 && seen_idat, "PNG IEND chunk invalid or missing IDAT");
                    seen_iend = true;
                }
                _ => {}
            }
        }
        offset = crc_end;
    }

    ensure!(seen_iend, "missing PNG IEND chunk");
    dimensions.context("missing PNG IHDR")
}

pub fn content_image_bytes(blocks: &[Content]) -> usize {
    blocks
        .iter()
        .map(|block| match block {
            Content::Image(image) => image.data.len(),
            _ => 0,
        })
        .sum()
}

pub fn message_image_bytes(message: &AgentMessage) -> usize {
    match message {
        AgentMessage::User(user) => match &user.content {
            UserContent::Text(_) => 0,
            UserContent::Blocks(blocks) => content_image_bytes(blocks),
        },
        AgentMessage::Assistant(assistant) => content_image_bytes(&assistant.content),
        AgentMessage::ToolResult(result) => content_image_bytes(&result.content),
        AgentMessage::Custom(_) => 0,
    }
}

pub fn messages_image_bytes(messages: &[AgentMessage]) -> usize {
    messages.iter().map(message_image_bytes).sum()
}

/// Returns `(text_json_bytes, image_base64_bytes)`. When no `Content::Image`
/// blocks are present, `image_base64_bytes == 0` and `text_json_bytes` equals
/// `serde_json::to_vec(messages)?.len()` to the exact byte.
pub fn split_messages_bytes(messages: &[AgentMessage]) -> Result<(usize, usize)> {
    let total = serde_json::to_vec(messages)?.len();
    let image = messages_image_bytes(messages);
    Ok((total.saturating_sub(image), image))
}

pub fn context_image_bytes(context: &rpi_ai::Context) -> usize {
    context
        .messages
        .iter()
        .map(|message| match message {
            Message::User(user) => match &user.content {
                UserContent::Text(_) => 0,
                UserContent::Blocks(blocks) => content_image_bytes(blocks),
            },
            Message::Assistant(assistant) => content_image_bytes(&assistant.content),
            Message::ToolResult(result) => content_image_bytes(&result.content),
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_1X1_PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn validates_canonical_png_and_rejects_corrupt_apng_or_oversized_dimensions() {
        let valid = base64::engine::general_purpose::STANDARD.decode(VALID_1X1_PNG_B64).unwrap();
        let dims = validate_png_bytes(&valid).unwrap();
        assert_eq!(dims, PngDimensions { width: 1, height: 1 });

        let mut bad_crc = valid.clone();
        let idx = bad_crc.len() - 15;
        bad_crc[idx] ^= 0x01;
        assert!(validate_png_bytes(&bad_crc).is_err());

        let mut trailing = valid.clone();
        trailing.push(0);
        assert!(validate_png_bytes(&trailing).is_err());

        // Construct valid-CRC IHDR with 8193x1 (exceeds MAX_IMAGE_DIMENSION)
        let mut ihdr = [0u8; 13];
        ihdr[0..4].copy_from_slice(&8193u32.to_be_bytes());
        ihdr[4..8].copy_from_slice(&1u32.to_be_bytes());
        ihdr[8] = 8;
        ihdr[9] = 6;
        let mut oversized = Vec::from(PNG_SIGNATURE);
        oversized.extend_from_slice(&13u32.to_be_bytes());
        oversized.extend_from_slice(b"IHDR");
        oversized.extend_from_slice(&ihdr);
        oversized.extend_from_slice(&crc32_png(b"IHDR", &ihdr).to_be_bytes());
        assert!(validate_png_bytes(&oversized).unwrap_err().to_string().contains("dimensions out of bounds"));

        // Inject APNG acTL chunk with valid CRC right after valid IHDR
        let valid_ihdr = &valid[8..33];
        let actl_data = [0u8, 0, 0, 2, 0, 0, 0, 0];
        let mut apng = Vec::from(PNG_SIGNATURE);
        apng.extend_from_slice(valid_ihdr);
        apng.extend_from_slice(&(actl_data.len() as u32).to_be_bytes());
        apng.extend_from_slice(b"acTL");
        apng.extend_from_slice(&actl_data);
        apng.extend_from_slice(&crc32_png(b"acTL", &actl_data).to_be_bytes());
        apng.extend_from_slice(&valid[33..]);
        assert!(validate_png_bytes(&apng).unwrap_err().to_string().contains("APNG"));
    }
}
