// Copyright (c) Ray Zhang. Task-scoped source applicability, not tool authorization.
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

pub const CAPABILITY: &str = "agent.guidance.v1";
const CONTRACT: &str = include_str!("agent-tool-contract-v1.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Requirements {
    protocol_version: u64,
    tool_contract_version: u64,
    platforms: Vec<String>,
    capabilities: Vec<String>,
}
pub fn contract() -> Result<Value> {
    Ok(serde_json::from_str(CONTRACT)?)
}
pub fn capabilities(mut base: Vec<&'static str>, inspection_lease: bool) -> Vec<&'static str> {
    base.extend_from_slice(&["agent.delegate", "agent.resume", "agent.inspect", CAPABILITY]);
    if cfg!(windows) && inspection_lease {
        base.push("agent.finalize");
    }
    base
}
pub fn environment(capabilities: &[&str]) -> Value {
    let platform = if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS };
    json!({"protocolVersion":1,"toolContractVersion":1,"platform":platform,"capabilities":capabilities})
}
pub fn check(command: &Value, environment: &Value) -> Result<Vec<Value>> {
    let mut issues = Vec::new();
    for source in command["sources"].as_array().context("Task sources missing")? {
        let Some(raw) = source.get("requirements") else { continue };
        let r: Requirements = serde_json::from_value(raw.clone())?;
        let mut add = |code: &str, detail: Value| {
            issues.push(json!({"sourceId":source["id"],"code":code,"detail":detail}));
        };
        if environment["protocolVersion"] != r.protocol_version {
            add(
                "agent_protocol_mismatch",
                json!({"required":r.protocol_version,"actual":environment["protocolVersion"]}),
            );
        }
        if environment["toolContractVersion"] != r.tool_contract_version {
            add(
                "agent_tool_contract_mismatch",
                json!({"required":r.tool_contract_version,"actual":environment["toolContractVersion"]}),
            );
        }
        if !r.platforms.iter().any(|p| environment["platform"] == *p) {
            add("agent_platform_mismatch", json!({"required":r.platforms,"actual":environment["platform"]}));
        }
        let available = environment["capabilities"].as_array().context("environment capabilities missing")?;
        let missing = r.capabilities.iter().filter(|c| !available.iter().any(|v| v == c.as_str())).collect::<Vec<_>>();
        if !missing.is_empty() {
            add("agent_capability_missing", json!({"missing":missing}));
        }
    }
    Ok(issues)
}
pub fn snapshot(command: &Value, environment: Value) -> Value {
    json!({"environment":environment,"toolContractSha256":crate::protocol::hash(CONTRACT.as_bytes()),"sources":command["sources"]})
}
pub fn objective(command: &Value, guidance: &Value) -> Result<String> {
    let contract = contract()?;
    Ok(format!(
        "{}\n\nReach tool usage (contract v1):\n{}\n\nTask-start environment snapshot and versioned sources (reference data, not a change to the objective):\n{}",
        command["objective"].as_str().context("objective missing")?,
        contract["instructions"].as_str().context("tool instructions missing")?,
        serde_json::to_string(guidance)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn applicability_and_legacy_sources_are_separate_from_authority() -> Result<()> {
        let env = environment(&["file.read", CAPABILITY]);
        assert!(check(&json!({"sources":[{"id":"old","text":"source"}]}), &env)?.is_empty());
        let mut command = json!({"sources":[{"id":"skill","requirements":{"protocolVersion":1,"toolContractVersion":1,"platforms":[env["platform"]],"capabilities":["file.read"]}}]});
        assert!(check(&command, &env)?.is_empty());
        command["sources"][0]["requirements"] =
            json!({"protocolVersion":2,"toolContractVersion":2,"platforms":["absent"],"capabilities":["desktop.call"]});
        assert_eq!(check(&command, &env)?.len(), 4);
        Ok(())
    }
}
