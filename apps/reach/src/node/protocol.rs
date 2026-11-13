// Copyright (c) Ray Zhang. RY Reach protocol v1.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const CAPABILITIES: &[&str] = &["command.run", "file.read", "file.write", "directory.list"];
pub const DESKTOP_CAPABILITIES: &[&str] = &["desktop.describe", "desktop.call"];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dispatch {
    pub operation_id: String,
    pub node_id: String,
    pub epoch: u64,
    pub dispatch_id: String,
    pub payload_hash: String,
    pub command: Value,
    pub created_at: u64,
}

impl Dispatch {
    pub fn validate(&self, node_id: &str, epoch: u64) -> Result<()> {
        uuid::Uuid::parse_str(&self.operation_id)?;
        uuid::Uuid::parse_str(&self.dispatch_id)?;
        ensure!(
            self.node_id == node_id && self.epoch == epoch,
            "operation belongs to a different installation binding"
        );
        // serde_json Map is key ordered. Command fields are fixed ASCII protocol keys.
        let input = json!({"nodeId": self.node_id, "epoch": self.epoch, "command": self.command});
        ensure!(hash(&serde_json::to_vec(&input)?) == self.payload_hash, "operation payload hash mismatch");
        ensure!(
            CAPABILITIES.contains(&self.command["kind"].as_str().unwrap_or_default())
                || DESKTOP_CAPABILITIES.contains(&self.command["kind"].as_str().unwrap_or_default())
                || self.command["kind"] == "agent.delegate"
                || self.command["kind"] == "agent.resume"
                || self.command["kind"] == "agent.finalize"
                || self.command["kind"] == "agent.inspect",
            "unsupported operation kind"
        );
        Ok(())
    }
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_id: String,
    pub operation_id: String,
    pub dispatch_id: String,
    pub payload_hash: String,
    pub sequence: u64,
    pub kind: String,
    pub data: Value,
}
