// Copyright (c) Ray Zhang. Resident 6-state machine, node config, and bounded offline backoff.
use crate::{api, ledger::Ledger};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_HEARTBEAT_SECONDS: u64 = 60;
pub const MIN_HEARTBEAT_SECONDS: u64 = 30;
pub const MAX_HEARTBEAT_SECONDS: u64 = 3600;
pub const DEFAULT_BACKOFF_BASE_MS: u64 = 5_000;
pub const DEFAULT_BACKOFF_CAP_MS: u64 = 300_000;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)).unwrap_or(0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResidentState {
    AwaitingInitialization,
    AwaitingPairing,
    Connecting,
    Connected,
    OfflineBackoff,
    AuthOrConfigError,
}

impl ResidentState {
    pub fn label(self) -> &'static str {
        match self {
            Self::AwaitingInitialization => "等待初始化",
            Self::AwaitingPairing => "等待配对",
            Self::Connecting => "连接中",
            Self::Connected => "已连接",
            Self::OfflineBackoff => "离线退避",
            Self::AuthOrConfigError => "认证/配置错误",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidentSnapshot {
    pub state: ResidentState,
    pub state_label: &'static str,
    pub updated_at_ms: u64,
    pub last_connected_at_ms: Option<u64>,
    pub last_heartbeat_at_ms: Option<u64>,
    pub backoff_attempt: u32,
    pub next_retry_at_ms: Option<u64>,
    pub error_code: Option<String>,
    pub error_detail: Option<String>,
    pub recovery_hint: Option<String>,
}

impl Default for ResidentSnapshot {
    fn default() -> Self {
        Self {
            state: ResidentState::AwaitingInitialization,
            state_label: ResidentState::AwaitingInitialization.label(),
            updated_at_ms: now_ms(),
            last_connected_at_ms: None,
            last_heartbeat_at_ms: None,
            backoff_attempt: 0,
            next_retry_at_ms: None,
            error_code: None,
            error_detail: None,
            recovery_hint: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct ResidentTracker(Arc<Mutex<ResidentSnapshot>>);

impl ResidentTracker {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(ResidentSnapshot::default())))
    }

    pub fn awaiting_initialization(&self) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.state = ResidentState::AwaitingInitialization;
        guard.state_label = ResidentState::AwaitingInitialization.label();
        guard.updated_at_ms = now_ms();
        guard.backoff_attempt = 0;
        guard.next_retry_at_ms = None;
        guard.error_code = None;
        guard.error_detail = None;
        guard.recovery_hint =
            Some("运行 ryreach 或 ryreach config set server-url <https://...> 初始化服务器地址".into());
    }

    pub fn awaiting_pairing(&self, note: Option<String>) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.state = ResidentState::AwaitingPairing;
        guard.state_label = ResidentState::AwaitingPairing.label();
        guard.updated_at_ms = now_ms();
        guard.backoff_attempt = 0;
        guard.next_retry_at_ms = None;
        guard.error_code = None;
        guard.error_detail = note;
        guard.recovery_hint = Some("在管理端生成一次性配对码后运行 ryreach pair <code>".into());
    }

    pub fn connecting(&self) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if guard.state != ResidentState::Connected {
            guard.state = ResidentState::Connecting;
            guard.state_label = ResidentState::Connecting.label();
            guard.updated_at_ms = now_ms();
            guard.next_retry_at_ms = None;
        }
    }

    pub fn connected(&self) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let ts = now_ms();
        guard.state = ResidentState::Connected;
        guard.state_label = ResidentState::Connected.label();
        guard.updated_at_ms = ts;
        guard.last_connected_at_ms = Some(ts);
        guard.backoff_attempt = 0;
        guard.next_retry_at_ms = None;
        guard.error_code = None;
        guard.error_detail = None;
        guard.recovery_hint = None;
    }

    pub fn record_heartbeat(&self) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let ts = now_ms();
        guard.last_heartbeat_at_ms = Some(ts);
        guard.updated_at_ms = ts;
    }

    pub fn offline_backoff(&self, attempt: u32, delay_ms: u64, detail: impl Into<String>) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let ts = now_ms();
        guard.state = ResidentState::OfflineBackoff;
        guard.state_label = ResidentState::OfflineBackoff.label();
        guard.updated_at_ms = ts;
        guard.backoff_attempt = attempt;
        guard.next_retry_at_ms = Some(ts.saturating_add(delay_ms));
        guard.error_code = Some("network_unavailable".into());
        guard.error_detail = Some(detail.into());
        guard.recovery_hint = Some("服务保持运行并按有上限退避自动重连；未知操作绝不自动重放".into());
    }

    pub fn auth_or_config_error(&self, code: impl Into<String>, detail: impl Into<String>, hint: impl Into<String>) {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.state = ResidentState::AuthOrConfigError;
        guard.state_label = ResidentState::AuthOrConfigError.label();
        guard.updated_at_ms = now_ms();
        guard.backoff_attempt = 0;
        guard.next_retry_at_ms = None;
        guard.error_code = Some(code.into());
        guard.error_detail = Some(detail.into());
        guard.recovery_hint = Some(hint.into());
    }

    pub fn current_backoff_attempt(&self) -> u32 {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).backoff_attempt
    }

    pub fn to_json(&self) -> Value {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        serde_json::to_value(&*guard).unwrap_or_else(|_| json!({}))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeConfig {
    pub saved_heartbeat_seconds: u64,
    pub effective_heartbeat_seconds: u64,
    pub effective_config_version: u64,
    pub ack_config_version: u64,
    #[serde(default)]
    pub pending_config_receipt: Option<Value>,
    #[serde(default)]
    pub last_config_error: Option<Value>,
    #[serde(default)]
    pub server_generation: u64,
    #[serde(default)]
    pub last_probe: Option<Value>,
    #[serde(default)]
    pub server_secrets: BTreeMap<String, String>,
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            saved_heartbeat_seconds: DEFAULT_HEARTBEAT_SECONDS,
            effective_heartbeat_seconds: DEFAULT_HEARTBEAT_SECONDS,
            effective_config_version: 0,
            ack_config_version: 0,
            pending_config_receipt: None,
            last_config_error: None,
            server_generation: 0,
            last_probe: None,
            server_secrets: BTreeMap::new(),
        }
    }
}

pub fn load_config(ledger: &Ledger) -> Result<NodeConfig> {
    let raw: Option<String> =
        ledger.db.query_row("SELECT value FROM config WHERE key='node_config'", [], |row| row.get(0)).optional()?;
    match raw {
        Some(value) => Ok(serde_json::from_str(&value).context("invalid node_config record")?),
        None => Ok(NodeConfig::default()),
    }
}

pub fn save_config(ledger: &Ledger, cfg: &NodeConfig) -> Result<()> {
    ledger.db.execute(
        "INSERT INTO config VALUES('node_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [serde_json::to_string(cfg)?],
    )?;
    Ok(())
}

pub fn derive_standalone_state(ledger: &Ledger, cfg: &NodeConfig) -> Value {
    let Ok(identity) = ledger.identity() else {
        return json!({"state":"auth_or_config_error","stateLabel":"认证/配置错误"});
    };
    if identity.server.is_none() {
        return json!({
            "state": "awaiting_initialization",
            "stateLabel": ResidentState::AwaitingInitialization.label(),
            "recoveryHint": "运行 ryreach 或 ryreach config set server-url <https://...> 初始化服务器地址",
        });
    }
    if identity.revoked {
        return json!({
            "state": "auth_or_config_error",
            "stateLabel": ResidentState::AuthOrConfigError.label(),
            "errorCode": "node_unpaired",
            "errorDetail": "设备配对已被服务端撤销",
            "recoveryHint": "运行 ryreach pair <code> 重新完成可信配对",
        });
    }
    if let Some(probe) = &cfg.last_probe {
        if probe["isTlsOrConfigError"] == true {
            return json!({
                "state": "auth_or_config_error",
                "stateLabel": ResidentState::AuthOrConfigError.label(),
                "errorCode": probe["code"].clone(),
                "errorDetail": probe["detail"].clone(),
                "recoveryHint": "检查服务器地址与 TLS 证书后重新执行 ryreach config set server-url",
            });
        }
    }
    if identity.node_id.is_none() || identity.pending_pair.is_some() {
        return json!({
            "state": "awaiting_pairing",
            "stateLabel": ResidentState::AwaitingPairing.label(),
            "recoveryHint": "运行 ryreach pair <code> 完成可信配对",
        });
    }
    json!({
        "state": "offline_backoff",
        "stateLabel": ResidentState::OfflineBackoff.label(),
        "recoveryHint": "常驻宿主当前未附着此状态目录；启动服务或 host 后自动重连",
    })
}

pub fn config_summary(ledger: &Ledger, resident: Option<&ResidentTracker>) -> Result<Value> {
    let identity = ledger.identity()?;
    let cfg = load_config(ledger)?;
    let state = match resident {
        Some(tracker) => tracker.to_json(),
        None => derive_standalone_state(ledger, &cfg),
    };
    Ok(json!({
        "installationId": identity.installation_id,
        "serverUrl": identity.server,
        "development": identity.development,
        "paired": identity.node_id.is_some() && !identity.revoked,
        "nodeId": identity.node_id,
        "epoch": identity.epoch,
        "revoked": identity.revoked,
        "pairingPending": identity.pending_pair.is_some(),
        "serverGeneration": cfg.server_generation,
        "heartbeat": {
            "savedSeconds": cfg.saved_heartbeat_seconds,
            "effectiveSeconds": cfg.effective_heartbeat_seconds,
            "effectiveConfigVersion": cfg.effective_config_version,
            "acknowledgedConfigVersion": cfg.ack_config_version,
            "pendingReceipt": cfg.pending_config_receipt,
            "lastError": cfg.last_config_error,
        },
        "lastProbe": cfg.last_probe,
        "resident": state,
    }))
}

fn fresh_secret() -> Result<String> {
    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).map_err(|_| anyhow::anyhow!("random source failed"))?;
    Ok(URL_SAFE_NO_PAD.encode(secret))
}

pub async fn set_server_url(
    ledger: &mut Ledger,
    raw_server: &str,
    development: bool,
    allow_offline: bool,
    resident: Option<&ResidentTracker>,
) -> Result<Value> {
    let canonical = api::canonical_server_url(raw_server, development)?;
    let mut identity = ledger.identity()?;
    let mut cfg = load_config(ledger)?;
    let server_changed = identity.server.as_deref() != Some(canonical.as_str());
    let mut credentials_rotated = false;

    if server_changed && identity.server.is_some() {
        ensure!(
            !ledger.has_active_operations()? && ledger.next_event()?.is_none(),
            "settle original operations and outbox receipts before switching server URL"
        );
        // REQ-05.3: Changing server URL crosses a trust boundary. Archive the previous
        // server's installation credential under its exact origin and assign/restore an
        // isolated per-origin credential so old credentials are NEVER sent to a new server.
        if let Some(prev_origin) = identity.server.as_ref() {
            if cfg.server_secrets.len() >= 16 && !cfg.server_secrets.contains_key(prev_origin) {
                if let Some(first_key) = cfg.server_secrets.keys().next().cloned() {
                    cfg.server_secrets.remove(&first_key);
                }
            }
            cfg.server_secrets.insert(prev_origin.clone(), identity.secret.clone());
        }
        identity.secret = match cfg.server_secrets.get(&canonical) {
            Some(existing) => existing.clone(),
            None => fresh_secret()?,
        };
        crate::ssh::revoke_all_managed_keys(&ledger.root)?;
        identity.node_id = None;
        identity.epoch = 0;
        identity.revoked = false;
        identity.pending_pair = None;
        identity.last_pair = None;
        cfg.server_generation = cfg.server_generation.saturating_add(1);
        cfg.effective_config_version = 0;
        cfg.ack_config_version = 0;
        cfg.pending_config_receipt = None;
        credentials_rotated = true;
    } else if identity.server.is_none() {
        cfg.server_generation = cfg.server_generation.max(1);
    }

    identity.server = Some(canonical.clone());
    identity.development = development;

    let probe = api::probe_unauthenticated(&canonical, development).await;
    match probe {
        Ok(()) => {
            cfg.last_probe = Some(json!({
                "status": "reachable",
                "isTlsOrConfigError": false,
                "checkedAtMs": now_ms(),
            }));
            ledger.save_identity(&identity)?;
            save_config(ledger, &cfg)?;
            if let Some(tracker) = resident {
                if identity.node_id.is_some() && !identity.revoked {
                    tracker.connecting();
                } else {
                    tracker.awaiting_pairing(None);
                }
            }
            Ok(json!({
                "saved": true,
                "verified": true,
                "status": "reachable",
                "serverUrl": canonical,
                "serverSwitched": server_changed,
                "credentialsRotated": credentials_rotated,
                "installationId": identity.installation_id,
                "paired": identity.node_id.is_some() && !identity.revoked,
            }))
        }
        Err(failure) => {
            cfg.last_probe = Some(json!({
                "status": if failure.is_tls_or_config { "tls_or_endpoint_error" } else { "offline_pending" },
                "code": failure.code,
                "detail": failure.detail,
                "isTlsOrConfigError": failure.is_tls_or_config,
                "checkedAtMs": now_ms(),
            }));
            ledger.save_identity(&identity)?;
            save_config(ledger, &cfg)?;
            if let Some(tracker) = resident {
                if failure.is_tls_or_config {
                    tracker.auth_or_config_error(
                        failure.code,
                        failure.detail.clone(),
                        "检查服务器地址与 TLS 证书后重新运行 ryreach config set server-url",
                    );
                } else if identity.node_id.is_some() && !identity.revoked {
                    tracker.offline_backoff(0, DEFAULT_BACKOFF_BASE_MS, failure.detail.clone());
                } else {
                    tracker.awaiting_pairing(Some(format!("离线待连通: {}", failure.detail)));
                }
            }
            if failure.is_tls_or_config {
                bail!("server URL saved ({canonical}) but verification failed [{}]: {}", failure.code, failure.detail);
            }
            if !allow_offline {
                bail!(
                    "server URL saved ({canonical}) as pending_connectivity (offline): {}; pass --allow-offline to accept offline configuration",
                    failure.detail
                );
            }
            Ok(json!({
                "saved": true,
                "verified": false,
                "status": "pending_connectivity",
                "errorCode": failure.code,
                "errorDetail": failure.detail,
                "serverUrl": canonical,
                "serverSwitched": server_changed,
                "credentialsRotated": credentials_rotated,
                "installationId": identity.installation_id,
                "paired": identity.node_id.is_some() && !identity.revoked,
            }))
        }
    }
}

pub fn preconfigure_server_url(
    ledger: &mut Ledger,
    raw_server: &str,
    development: bool,
    resident: Option<&ResidentTracker>,
) -> Result<Value> {
    let canonical = api::canonical_server_url(raw_server, development)?;
    let mut identity = ledger.identity()?;
    let mut cfg = load_config(ledger)?;
    if identity.server.as_deref() == Some(canonical.as_str()) {
        return Ok(json!({
            "action": "unchanged",
            "alreadyConfigured": true,
            "installationId": identity.installation_id,
            "serverUrl": canonical,
            "paired": identity.node_id.is_some() && !identity.revoked,
            "nodeId": identity.node_id,
            "epoch": identity.epoch,
        }));
    }
    if let Some(existing) = &identity.server {
        if identity.node_id.is_some()
            || identity.pending_pair.is_some()
            || ledger.has_active_operations()?
            || ledger.next_event()?.is_some()
        {
            bail!(
                "Reach is already bound to {existing}; external installer preconfiguration will not overwrite an active binding"
            );
        }
        identity.secret = fresh_secret()?;
    }
    identity.server = Some(canonical.clone());
    identity.development = development;
    cfg.server_generation = cfg.server_generation.saturating_add(1);
    ledger.save_identity(&identity)?;
    save_config(ledger, &cfg)?;
    if let Some(tracker) = resident {
        tracker.awaiting_pairing(None);
    }
    Ok(json!({
        "action": "configured",
        "alreadyConfigured": false,
        "installationId": identity.installation_id,
        "serverUrl": canonical,
        "paired": false,
        "nodeId": identity.node_id,
        "epoch": identity.epoch,
    }))
}

pub fn set_local_heartbeat(ledger: &mut Ledger, seconds: u64) -> Result<Value> {
    ensure!(
        (MIN_HEARTBEAT_SECONDS..=MAX_HEARTBEAT_SECONDS).contains(&seconds),
        "heartbeat interval must be between {MIN_HEARTBEAT_SECONDS} and {MAX_HEARTBEAT_SECONDS} seconds"
    );
    let mut cfg = load_config(ledger)?;
    cfg.saved_heartbeat_seconds = seconds;
    if cfg.effective_config_version == 0 {
        cfg.effective_heartbeat_seconds = seconds;
    }
    save_config(ledger, &cfg)?;
    Ok(json!({
        "savedHeartbeatSeconds": cfg.saved_heartbeat_seconds,
        "effectiveHeartbeatSeconds": cfg.effective_heartbeat_seconds,
        "effectiveConfigVersion": cfg.effective_config_version,
        "remoteManaged": cfg.effective_config_version > 0,
    }))
}

pub fn apply_desired_config(ledger: &Ledger, cfg: &mut NodeConfig, desired: &Value) -> Result<bool> {
    let Some(obj) = desired.as_object() else {
        return Ok(false);
    };
    let Some(target_version) = obj.get("targetVersion").and_then(Value::as_u64) else {
        return Ok(false);
    };
    let Some(request_id) = obj.get("requestId").and_then(Value::as_str) else {
        return Ok(false);
    };
    if uuid::Uuid::parse_str(request_id).is_err() {
        return Ok(false);
    }
    let Some(seconds) = obj.get("heartbeatIntervalSeconds").and_then(Value::as_u64) else {
        return Ok(false);
    };
    if target_version <= cfg.effective_config_version {
        return Ok(false);
    }
    let ts = now_ms();
    if !(MIN_HEARTBEAT_SECONDS..=MAX_HEARTBEAT_SECONDS).contains(&seconds) {
        let err_msg = format!(
            "heartbeat interval {seconds}s out of supported range ({MIN_HEARTBEAT_SECONDS}..={MAX_HEARTBEAT_SECONDS})"
        );
        let receipt = json!({
            "requestId": request_id,
            "targetVersion": target_version,
            "status": "rejected",
            "effectiveHeartbeatSeconds": cfg.effective_heartbeat_seconds,
            "appliedAt": ts,
            "error": err_msg,
        });
        cfg.last_config_error = Some(receipt.clone());
        cfg.pending_config_receipt = Some(receipt);
        save_config(ledger, cfg)?;
        return Ok(true);
    }
    cfg.saved_heartbeat_seconds = seconds;
    cfg.effective_heartbeat_seconds = seconds;
    cfg.effective_config_version = target_version;
    cfg.last_config_error = None;
    cfg.pending_config_receipt = Some(json!({
        "requestId": request_id,
        "targetVersion": target_version,
        "status": "applied",
        "effectiveHeartbeatSeconds": seconds,
        "appliedAt": ts,
        "error": Value::Null,
    }));
    save_config(ledger, cfg)?;
    Ok(true)
}

pub fn acknowledge_config_receipt(ledger: &Ledger, cfg: &mut NodeConfig, ack_version: u64) -> Result<()> {
    if ack_version > cfg.ack_config_version {
        cfg.ack_config_version = ack_version;
    }
    if let Some(pending) = &cfg.pending_config_receipt {
        if pending["targetVersion"].as_u64().is_some_and(|tv| ack_version >= tv) {
            cfg.pending_config_receipt = None;
        }
    }
    save_config(ledger, cfg)
}
pub fn local_unpair(ledger: &mut Ledger, resident: Option<&ResidentTracker>) -> Result<Value> {
    ensure!(
        !ledger.has_active_operations()? && ledger.next_event()?.is_none(),
        "settle active operations and outbox receipts before unpairing locally"
    );
    let mut identity = ledger.identity()?;
    let prior_node = identity.node_id.take();
    let ssh_cleanup = crate::ssh::revoke_all_managed_keys(&ledger.root)?;
    // Preserve installation secret for the same server (store.ts:340) so a subsequent
    // re-pair on this server proves installation ownership without cross-server exposure.
    identity.pending_pair = None;
    identity.revoked = false;
    ledger.save_identity(&identity)?;
    if let Some(tracker) = resident {
        if identity.server.is_some() {
            tracker.awaiting_pairing(None);
        } else {
            tracker.awaiting_initialization();
        }
    }
    Ok(json!({
        "unpaired": true,
        "previousNodeId": prior_node,
        "installationId": identity.installation_id,
        "serverUrl": identity.server,
        "sshCleanup": ssh_cleanup,
    }))
}

pub fn next_backoff_delay_ms(attempt: u32, development: bool) -> u64 {
    let (base_ms, cap_ms) = if development {
        let b = std::env::var("REACH_DEV_BACKOFF_BASE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|&v| (50..=DEFAULT_BACKOFF_CAP_MS).contains(&v))
            .unwrap_or(DEFAULT_BACKOFF_BASE_MS);
        let c = std::env::var("REACH_DEV_BACKOFF_CAP_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|&v| v >= b && v <= DEFAULT_BACKOFF_CAP_MS)
            .unwrap_or(DEFAULT_BACKOFF_CAP_MS);
        (b, c)
    } else {
        (DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CAP_MS)
    };
    let shift = attempt.min(16);
    let exp = base_ms.saturating_mul(1u64 << shift).min(cap_ms);
    let mut rand_byte = [0u8; 1];
    let _ = getrandom::fill(&mut rand_byte);
    // Jitter in [85%, 115%], strictly capped at cap_ms.
    let permille = 850u64 + ((u64::from(rand_byte[0]) * 300) / 255);
    exp.saturating_mul(permille).div_ceil(1000).max(base_ms.min(cap_ms)).min(cap_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_exponential_and_strictly_capped() {
        for attempt in 0..32 {
            let d = next_backoff_delay_ms(attempt, false);
            assert!((4_250..=DEFAULT_BACKOFF_CAP_MS).contains(&d), "attempt {attempt} -> {d}");
        }
        let capped = next_backoff_delay_ms(25, false);
        assert!((255_000..=DEFAULT_BACKOFF_CAP_MS).contains(&capped), "capped={capped}");
    }
}
