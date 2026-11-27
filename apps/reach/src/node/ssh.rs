// Copyright (c) Ray Zhang. Default OpenSSH detection/preparation and pairing-scoped Ed25519 key lifecycle (REQ-02).
use crate::protocol::hash;
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const ED25519_WIRE_PREFIX: &[u8; 19] = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20";
const INTENTS_FILE: &str = "ssh-key-intents.json";
const INTENTS_LOCK: &str = "ssh-key-intents.lock";
const MAX_SSH_FILE_BYTES: usize = 1_048_576; // 1 MiB cap for authorized_keys and intents
const MAX_RETAINED_CLEANED_GRANTS: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStatus {
    pub ready: bool,
    pub mode: String,
    pub port: u16,
    pub user: Option<String>,
    pub host_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authorized_keys_path: Option<String>,
    pub shared_admin_keys: bool,
    pub reused_existing: bool,
    pub managed_grant_count: usize,
    pub error: Option<String>,
}

impl SshStatus {
    pub fn heartbeat_value(&self) -> Value {
        let mut obj = json!({
            "ready": self.ready,
            "port": self.port,
            "sharedAdminKeys": self.shared_admin_keys,
            "error": self.error,
        });
        if let Some(u) = &self.user {
            obj["user"] = json!(u);
        }
        if let Some(hk) = &self.host_key {
            obj["hostKey"] = json!(hk);
        }
        obj
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevSshOverride {
    pub port: u16,
    pub user: String,
    pub host_key: String,
    pub authorized_keys_path: String,
    #[serde(default)]
    pub shared_admin_keys: bool,
    #[serde(default = "default_true")]
    pub ready: bool,
    #[serde(default)]
    pub error: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshGrant {
    pub grant_id: String,
    pub node_id: String,
    pub epoch: u64,
    pub path: String,
    pub line: String,
    pub marker: String,
    pub prefix_length: usize,
    pub prefix_sha256: String,
    pub added_separator: String,
    pub state: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntentStore {
    pub schema: u32,
    pub grants: Vec<SshGrant>,
}

pub fn validate_ed25519_public_key(text: &str) -> Result<String> {
    ensure!(
        !text.contains('\r') && !text.contains('\n') && !text.contains('\0'),
        "SSH public key must be a single line without NUL bytes"
    );
    let parts: Vec<&str> = text.trim().split_ascii_whitespace().collect();
    ensure!(
        (2..=3).contains(&parts.len()) && parts[0] == "ssh-ed25519",
        "expected one Ed25519 public key without authorized_keys options"
    );
    let blob = STANDARD.decode(parts[1]).context("invalid Ed25519 public key base64")?;
    ensure!(blob.len() == 51 && blob.starts_with(ED25519_WIRE_PREFIX), "invalid Ed25519 public key wire structure");
    Ok(format!("ssh-ed25519 {}", STANDARD.encode(&blob)))
}

fn validate_no_reparse(path: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        crate::windows_host::validate_state_path(path)?;
    }
    let abs = std::path::absolute(path)?;
    for ancestor in abs.ancestors() {
        if let Ok(meta) = fs::symlink_metadata(ancestor) {
            ensure!(!meta.file_type().is_symlink(), "refusing symlink on SSH path: {}", ancestor.display());
        }
    }
    Ok(())
}

fn read_bounded_bytes<R: Read>(reader: &mut R, limit: usize, label: &str) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    reader.take((limit as u64).saturating_add(1)).read_to_end(&mut buf)?;
    ensure!(buf.len() <= limit, "{label} exceeds maximum supported size ({limit} bytes)");
    Ok(buf)
}

fn lock_intents(state_dir: &Path) -> Result<File> {
    let lock_path = state_dir.join(INTENTS_LOCK);
    validate_no_reparse(&lock_path)?;
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&lock_path)?;
    file.lock_exclusive().context("cannot lock ssh-key-intents.lock")?;
    Ok(file)
}

fn load_intents(state_dir: &Path) -> Result<IntentStore> {
    let file = state_dir.join(INTENTS_FILE);
    validate_no_reparse(&file)?;
    if !file.exists() {
        return Ok(IntentStore { schema: 1, grants: Vec::new() });
    }
    let mut handle = File::open(&file).context("cannot open ssh-key-intents.json")?;
    ensure!(handle.metadata()?.is_file(), "ssh-key-intents.json is not a regular file");
    let bytes = read_bounded_bytes(&mut handle, MAX_SSH_FILE_BYTES, "ssh-key-intents.json")?;
    let mut parsed: IntentStore = serde_json::from_slice(&bytes).context("invalid ssh-key-intents.json")?;
    if parsed.schema == 0 {
        parsed.schema = 1;
    }
    Ok(parsed)
}

fn save_intents(state_dir: &Path, store: &IntentStore) -> Result<()> {
    let target = state_dir.join(INTENTS_FILE);
    validate_no_reparse(&target)?;
    let mut active_or_failed = Vec::new();
    let mut cleaned = Vec::new();
    for g in &store.grants {
        if g.state == "cleaned" {
            cleaned.push(g.clone());
        } else {
            active_or_failed.push(g.clone());
        }
    }
    if cleaned.len() > MAX_RETAINED_CLEANED_GRANTS {
        let drop_count = cleaned.len() - MAX_RETAINED_CLEANED_GRANTS;
        cleaned.drain(..drop_count);
    }
    active_or_failed.extend(cleaned);

    let tmp = state_dir.join(format!("{INTENTS_FILE}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let payload = serde_json::to_vec_pretty(&IntentStore { schema: 1, grants: active_or_failed })?;
    {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(&payload)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, &target)?;
    #[cfg(windows)]
    let _ = crate::windows_host::protect_state(state_dir);
    Ok(())
}

fn active_grant_count(state_dir: &Path) -> usize {
    load_intents(state_dir)
        .map(|s| s.grants.iter().filter(|g| g.state == "authorized" || g.state == "authorizing").count())
        .unwrap_or(0)
}

fn probe_local_tcp(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

#[cfg(not(windows))]
fn current_login_user() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Administrator".into())
}

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsSshTarget {
    user: String,
    authorized_keys_path: String,
    host_key: String,
    shared_admin_keys: bool,
}

#[cfg(windows)]
fn windows_ssh_target(state_dir: &Path) -> Result<WindowsSshTarget> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct InstallationOwner {
        schema: u32,
        binding_owner: String,
    }
    // This SID is captured before installer elevation and retained across upgrades.
    // Never infer the SSH account from the LocalSystem host's environment.
    let owner_file = state_dir.parent().context("state directory has no parent")?.join("Reach.installation.json");
    let owner_sid = if owner_file.exists() {
        validate_no_reparse(&owner_file)?;
        let owner: InstallationOwner = serde_json::from_reader(File::open(&owner_file)?)?;
        ensure!(owner.schema == 1, "unsupported retained installation owner");
        owner.binding_owner
    } else {
        crate::windows_host::current_sid()?
    };
    let script = concat!(
        "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n",
        include_str!("../../packaging/windows/ssh.ps1"),
        "\n$command=GetReachSshCommand\nif(-not $command){throw 'sshd service is not installed'}\n",
        "ResolveReachSshTarget $env:REACH_SSH_OWNER_SID $command | ConvertTo-Json -Compress\n"
    );
    let output = windows_ssh_powershell(script, Some(&owner_sid)).context("SSH target lookup failed")?;
    let mut target: WindowsSshTarget =
        serde_json::from_slice(&output).context("invalid SSH target lookup output")?;
    target.host_key = validate_ed25519_public_key(&target.host_key)?;
    Ok(target)
}

#[cfg(windows)]
pub fn enable_installed_windows_ssh() -> Result<Value> {
    let script = concat!(
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$MaintenanceOperation='ssh-enable'\n",
        include_str!("../../packaging/windows/payload.ps1"),
        "\n",
        include_str!("../../packaging/windows/ownership.ps1"),
        "\n",
        include_str!("../../packaging/windows/maintenance-writes.ps1"),
        "\n",
        include_str!("../../packaging/windows/ssh.ps1"),
        "\n",
        include_str!("../../packaging/windows/install.ps1"),
    );
    let output = windows_ssh_powershell(script, None).context("SSH enable failed")?;
    let receipt: Value = serde_json::from_slice(&output).context("invalid SSH enable receipt")?;
    ensure!(receipt["status"] == "ready", "SSH maintenance did not report ready");
    Ok(receipt)
}

#[cfg(windows)]
fn windows_ssh_powershell(script: &str, owner_sid: Option<&str>) -> Result<Vec<u8>> {
    use std::{os::windows::process::CommandExt, process::Stdio};
    let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut command = Command::new(system.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
    if let Some(owner_sid) = owner_sid {
        command.env("REACH_SSH_OWNER_SID", owner_sid);
    }
    let mut child = command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))",
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().context("Windows SSH maintenance input unavailable")?.write_all(script.as_bytes())?;
    let output = child.wait_with_output()?;
    ensure!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr).trim());
    Ok(output.stdout)
}

#[cfg(windows)]
fn query_windows_sshd_service() -> (bool, bool, Option<PathBuf>) {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::System::Services::*;
    fn wide(v: impl AsRef<OsStr>) -> Vec<u16> {
        v.as_ref().encode_wide().chain(Some(0)).collect()
    }
    unsafe {
        let scm = OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_CONNECT);
        if scm.is_null() {
            return (false, false, None);
        }
        let svc = OpenServiceW(scm, wide("sshd").as_ptr(), SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG);
        CloseServiceHandle(scm);
        if svc.is_null() {
            return (false, false, None);
        }
        let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
        let mut needed = 0u32;
        let running = QueryServiceStatusEx(
            svc,
            SC_STATUS_PROCESS_INFO,
            &mut status as *mut _ as _,
            std::mem::size_of_val(&status) as u32,
            &mut needed,
        ) != 0
            && status.dwCurrentState == SERVICE_RUNNING;

        let mut cfg_bytes = 0u32;
        let _ = QueryServiceConfigW(svc, ptr::null_mut(), 0, &mut cfg_bytes);
        let mut exe_path: Option<PathBuf> = None;
        if cfg_bytes > 0 && cfg_bytes <= 65536 {
            let mut buf = vec![0u8; cfg_bytes as usize];
            if QueryServiceConfigW(svc, buf.as_mut_ptr() as _, cfg_bytes, &mut cfg_bytes) != 0 {
                let cfg = &*(buf.as_ptr() as *const QUERY_SERVICE_CONFIGW);
                if !cfg.lpBinaryPathName.is_null() {
                    let mut len = 0usize;
                    while *cfg.lpBinaryPathName.add(len) != 0 && len < 4096 {
                        len += 1;
                    }
                    let raw = String::from_utf16_lossy(std::slice::from_raw_parts(cfg.lpBinaryPathName, len));
                    let trimmed = raw.trim();
                    let parsed = if let Some(rest) = trimmed.strip_prefix('"') {
                        rest.split('"').next().map(PathBuf::from)
                    } else {
                        trimmed.split_whitespace().next().map(PathBuf::from)
                    };
                    exe_path = parsed;
                }
            }
        }
        CloseServiceHandle(svc);
        (true, running, exe_path)
    }
}

pub fn prepare_or_detect(state_dir: &Path, development: bool, attempt_start: bool) -> SshStatus {
    let managed_grant_count = active_grant_count(state_dir);
    if development {
        if let Ok(raw_cfg) = std::env::var("REACH_DEV_SSH_CONFIG_JSON") {
            match serde_json::from_str::<DevSshOverride>(&raw_cfg) {
                Ok(dev) => match validate_ed25519_public_key(&dev.host_key) {
                    Ok(valid_hk) => {
                        let listener_up = dev.ready && probe_local_tcp(dev.port);
                        let err = if !dev.ready {
                            Some(dev.error.unwrap_or_else(|| "OpenSSH preparation disabled in fixture".into()))
                        } else if !listener_up {
                            Some(format!("SSH listener on 127.0.0.1:{} is not reachable", dev.port))
                        } else {
                            None
                        };
                        return SshStatus {
                            ready: listener_up,
                            mode: if listener_up { "reused_existing".into() } else { "not_listening".into() },
                            port: dev.port,
                            user: Some(dev.user),
                            host_key: Some(valid_hk),
                            authorized_keys_path: Some(dev.authorized_keys_path),
                            shared_admin_keys: dev.shared_admin_keys,
                            reused_existing: listener_up,
                            managed_grant_count,
                            error: err,
                        };
                    }
                    Err(e) => {
                        return SshStatus {
                            ready: false,
                            mode: "config_error".into(),
                            port: dev.port,
                            user: Some(dev.user),
                            host_key: None,
                            authorized_keys_path: None,
                            shared_admin_keys: false,
                            reused_existing: false,
                            managed_grant_count,
                            error: Some(format!("invalid host public key: {e}")),
                        };
                    }
                },
                Err(e) => {
                    return SshStatus {
                        ready: false,
                        mode: "config_error".into(),
                        port: 22,
                        user: None,
                        host_key: None,
                        authorized_keys_path: None,
                        shared_admin_keys: false,
                        reused_existing: false,
                        managed_grant_count,
                        error: Some(format!("invalid REACH_DEV_SSH_CONFIG_JSON: {e}")),
                    };
                }
            }
        }
    }

    #[cfg(windows)]
    {
        let (mut installed, mut running, svc_exe) = query_windows_sshd_service();
        let sys_root =
            std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let candidate_sshd = svc_exe.or_else(|| {
            let p1 = sys_root.join(r"System32\OpenSSH\sshd.exe");
            if p1.exists() {
                return Some(p1);
            }
            let pf = std::env::var_os("ProgramFiles")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
            let p2 = pf.join(r"OpenSSH\sshd.exe");
            if p2.exists() {
                return Some(p2);
            }
            None
        });

        if !installed && candidate_sshd.is_none() {
            return SshStatus {
                ready: false,
                mode: "missing_sshd".into(),
                port: 22,
                user: None,
                host_key: None,
                authorized_keys_path: None,
                shared_admin_keys: false,
                reused_existing: false,
                managed_grant_count,
                error: Some("目标机尚未安装 OpenSSH Server (sshd.exe)；已有 SSH 客户端与非 Reach 配置保持不变".into()),
            };
        }

        if installed && !running && attempt_start {
            // Preserve existing configuration & host keys; use explicit System32\sc.exe path.
            let sc_exe = sys_root.join(r"System32\sc.exe");
            if sc_exe.exists() {
                let _ = Command::new(sc_exe).args(["start", "sshd"]).output();
                let (_, now_running, _) = query_windows_sshd_service();
                running = now_running;
                installed = true;
            }
        }

        let target = match windows_ssh_target(state_dir) {
            Ok(target) => target,
            Err(error) => {
                return SshStatus {
                    ready: false,
                    mode: "config_error".into(),
                    port: 22,
                    user: None,
                    host_key: None,
                    authorized_keys_path: None,
                    shared_admin_keys: false,
                    reused_existing: installed,
                    managed_grant_count,
                    error: Some(error.to_string()),
                };
            }
        };

        let listening = running && probe_local_tcp(22);
        let ready = listening;
        let error = if !installed {
            Some("sshd 服务尚未注册；未改动本机配置".into())
        } else if !running {
            Some("sshd 服务已安装但未处于运行状态；已有配置与主机密钥保留".into())
        } else if !listening {
            Some("sshd 服务运行中但未在 22 端口监听；保留原配置未覆盖".into())
        } else {
            None
        };

        SshStatus {
            ready,
            mode: if ready { "reused_existing".into() } else { "degraded".into() },
            port: 22,
            user: Some(target.user),
            host_key: Some(target.host_key),
            authorized_keys_path: Some(target.authorized_keys_path),
            shared_admin_keys: target.shared_admin_keys,
            reused_existing: installed,
            managed_grant_count,
            error,
        }
    }

    #[cfg(not(windows))]
    {
        let _ = attempt_start;
        let host_key = fs::read_to_string("/etc/ssh/ssh_host_ed25519_key.pub")
            .ok()
            .and_then(|raw| validate_ed25519_public_key(raw.trim()).ok());
        let listening = probe_local_tcp(22);
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/root"));
        let auth_path = home.join(".ssh/authorized_keys");
        let ready = listening && host_key.is_some();
        SshStatus {
            ready,
            mode: if ready { "reused_existing".into() } else { "missing_or_stopped".into() },
            port: 22,
            user: Some(current_login_user()),
            host_key,
            authorized_keys_path: Some(auth_path.to_string_lossy().into_owned()),
            shared_admin_keys: false,
            reused_existing: ready,
            managed_grant_count,
            error: if ready {
                None
            } else {
                Some("sshd is not listening on port 22 or Ed25519 host key is unreadable".into())
            },
        }
    }
}

pub fn authorize_paired_key(
    state_dir: &Path,
    node_id: &str,
    epoch: u64,
    grant_id: &str,
    public_key: &str,
    development: bool,
) -> Result<Value> {
    uuid::Uuid::parse_str(node_id).context("invalid node_id")?;
    uuid::Uuid::parse_str(grant_id).context("invalid grant_id")?;
    ensure!(epoch >= 1, "invalid pairing epoch");
    let canonical_key = validate_ed25519_public_key(public_key)?;
    let status = prepare_or_detect(state_dir, development, true);
    ensure!(status.ready, "target SSH is not ready: {}", status.error.as_deref().unwrap_or("sshd unavailable"));
    let user = status.user.as_deref().unwrap_or("Administrator");
    ensure!(
        !user.is_empty()
            && user.len() <= 128
            && !user.starts_with('-')
            && user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@' | '\\')),
        "unsafe SSH target login user"
    );
    let key_file_str = status.authorized_keys_path.as_deref().context("AuthorizedKeysFile path unavailable")?;
    let key_file = PathBuf::from(key_file_str);
    validate_no_reparse(&key_file)?;
    if let Some(parent) = key_file.parent() {
        validate_no_reparse(parent)?;
        if !parent.exists() {
            fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
            }
        }
    }

    let _intents_guard = lock_intents(state_dir)?;
    let marker = format!("ry-reach:{node_id}:e{epoch}:{grant_id}");
    let line = format!("{canonical_key} {marker}");
    let mut store = load_intents(state_dir)?;
    if let Some(existing) = store.grants.iter().find(|g| g.grant_id == grant_id && g.state == "authorized") {
        ensure!(
            existing.line == line && existing.path == key_file_str,
            "grant_id conflict with different key or target"
        );
        return Ok(json!({
            "authorized": true,
            "replayed": true,
            "grantId": grant_id,
            "marker": marker,
            "target": {
                "address": format!("127.0.0.1:{}", status.port),
                "port": status.port,
                "user": status.user,
                "hostKey": status.host_key,
                "sharedAdminKeys": status.shared_admin_keys,
            },
        }));
    }

    let existed_before = key_file.exists();
    let mut open_opts = OpenOptions::new();
    open_opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_opts.mode(0o600);
    }
    let mut handle = open_opts.open(&key_file)?;
    ensure!(handle.metadata()?.is_file(), "authorized_keys handle is not a regular file");
    handle.lock_exclusive().context("authorized_keys is locked by another process")?;
    if !existed_before {
        #[cfg(windows)]
        {
            // Newly created authorized_keys inherits restricted DACL when inside protected root or state.
            validate_no_reparse(&key_file)?;
        }
    }

    let old_bytes = read_bounded_bytes(&mut handle, MAX_SSH_FILE_BYTES, "authorized_keys")?;
    let body_bytes = old_bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&old_bytes);
    let old_text =
        std::str::from_utf8(body_bytes).context("existing authorized_keys is not valid UTF-8; refusing to modify")?;

    for existing_line in old_text.lines() {
        let trimmed_cr = existing_line.trim_end_matches('\r');
        if trimmed_cr == line {
            let ts = crate::resident::now_ms();
            if !store.grants.iter().any(|g| g.grant_id == grant_id) {
                store.grants.push(SshGrant {
                    grant_id: grant_id.into(),
                    node_id: node_id.into(),
                    epoch,
                    path: key_file_str.into(),
                    line: line.clone(),
                    marker: marker.clone(),
                    prefix_length: old_bytes.len(),
                    prefix_sha256: hash(&old_bytes),
                    added_separator: String::new(),
                    state: "authorized".into(),
                    created_at_ms: ts,
                    updated_at_ms: ts,
                    error: None,
                });
                save_intents(state_dir, &store)?;
            }
            return Ok(json!({
                "authorized": true,
                "replayed": true,
                "grantId": grant_id,
                "marker": marker,
                "target": {
                    "address": format!("127.0.0.1:{}", status.port),
                    "port": status.port,
                    "user": status.user,
                    "hostKey": status.host_key,
                    "sharedAdminKeys": status.shared_admin_keys,
                },
            }));
        }
        ensure!(!trimmed_cr.contains(&marker), "existing edited line already contains marker {marker}");
    }

    let added_separator = if !old_bytes.is_empty() && *old_bytes.last().unwrap_or(&b'\n') != b'\n' {
        "\r\n".to_string()
    } else {
        String::new()
    };
    let addition = format!("{added_separator}{line}\r\n");
    ensure!(old_bytes.len().saturating_add(addition.len()) <= MAX_SSH_FILE_BYTES, "authorized_keys exceeds size limit");
    let ts = crate::resident::now_ms();
    store.grants.retain(|g| g.grant_id != grant_id);
    store.grants.push(SshGrant {
        grant_id: grant_id.into(),
        node_id: node_id.into(),
        epoch,
        path: key_file_str.into(),
        line: line.clone(),
        marker: marker.clone(),
        prefix_length: old_bytes.len(),
        prefix_sha256: hash(&old_bytes),
        added_separator,
        state: "authorizing".into(),
        created_at_ms: ts,
        updated_at_ms: ts,
        error: None,
    });
    save_intents(state_dir, &store)?;

    handle.seek(SeekFrom::End(0))?;
    handle.write_all(addition.as_bytes())?;
    handle.sync_all()?;
    drop(handle);

    if let Some(item) = store.grants.iter_mut().find(|g| g.grant_id == grant_id) {
        item.state = "authorized".into();
        item.updated_at_ms = crate::resident::now_ms();
    }
    save_intents(state_dir, &store)?;

    Ok(json!({
        "authorized": true,
        "replayed": false,
        "grantId": grant_id,
        "marker": marker,
        "target": {
            "address": format!("127.0.0.1:{}", status.port),
            "port": status.port,
            "user": status.user,
            "hostKey": status.host_key,
            "sharedAdminKeys": status.shared_admin_keys,
        },
    }))
}

fn remove_single_grant_from_file(grant: &SshGrant) -> Result<()> {
    let key_file = PathBuf::from(&grant.path);
    validate_no_reparse(&key_file)?;
    if let Some(parent) = key_file.parent() {
        validate_no_reparse(parent)?;
    }
    if !key_file.exists() {
        return Ok(());
    }
    let mut handle = OpenOptions::new().read(true).write(true).open(&key_file)?;
    ensure!(handle.metadata()?.is_file(), "authorized_keys handle is not a regular file");
    handle.lock_exclusive().context("authorized_keys is locked during revocation")?;
    let bytes = read_bounded_bytes(&mut handle, MAX_SSH_FILE_BYTES, "authorized_keys")?;

    let addition = format!("{}{}\r\n", grant.added_separator, grant.line);
    let addition_bytes = addition.as_bytes();
    let offset = grant.prefix_length;

    let (cut_start, cut_len) = if offset.saturating_add(addition_bytes.len()) <= bytes.len()
        && hash(&bytes[..offset]) == grant.prefix_sha256
        && &bytes[offset..offset + addition_bytes.len()] == addition_bytes
    {
        (offset, addition_bytes.len())
    } else {
        // Concurrent administrator edits (including optional UTF-8 BOM): remove ONLY our exact marked line!
        let bom_len = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
        let text = std::str::from_utf8(&bytes[bom_len..])
            .context("authorized_keys became invalid UTF-8; manual SSH cleanup required")?;
        let mut found_range: Option<(usize, usize)> = None;
        let mut cursor = 0usize;
        for chunk in text.split_inclusive('\n') {
            let clean = chunk.trim_end_matches(['\r', '\n']);
            if clean == grant.line {
                found_range = Some((bom_len + cursor, chunk.len()));
                break;
            }
            cursor += chunk.len();
        }
        if found_range.is_none() && cursor < text.len() {
            let tail = &text[cursor..];
            if tail.trim_end_matches('\r') == grant.line {
                found_range = Some((bom_len + cursor, tail.len()));
            }
        }
        match found_range {
            Some(range) => range,
            None => {
                if text.contains(&grant.marker) {
                    bail!(
                        "managed SSH key {} was manually edited; automatic removal refused to preserve administrator edits",
                        grant.marker
                    );
                }
                return Ok(());
            }
        }
    };

    let mut remaining = Vec::with_capacity(bytes.len().saturating_sub(cut_len));
    remaining.extend_from_slice(&bytes[..cut_start]);
    remaining.extend_from_slice(&bytes[cut_start + cut_len..]);
    handle.seek(SeekFrom::Start(0))?;
    handle.write_all(&remaining)?;
    handle.set_len(remaining.len() as u64)?;
    handle.sync_all()?;
    Ok(())
}

pub fn revoke_grants_matching<F>(state_dir: &Path, mut should_revoke: F) -> Result<Value>
where
    F: FnMut(&SshGrant) -> bool,
{
    let _intents_guard = lock_intents(state_dir)?;
    let mut store = load_intents(state_dir)?;
    let mut revoked_ids = Vec::new();
    let mut errors = Vec::new();
    for grant in &mut store.grants {
        if (grant.state == "authorized" || grant.state == "authorizing") && should_revoke(grant) {
            match remove_single_grant_from_file(grant) {
                Ok(()) => {
                    grant.state = "cleaned".into();
                    grant.updated_at_ms = crate::resident::now_ms();
                    grant.error = None;
                    revoked_ids.push(grant.grant_id.clone());
                }
                Err(err) => {
                    let msg = err.to_string();
                    grant.error = Some(msg.clone());
                    grant.updated_at_ms = crate::resident::now_ms();
                    errors.push(json!({"grantId": grant.grant_id, "marker": grant.marker, "error": msg}));
                }
            }
        }
    }
    save_intents(state_dir, &store)?;
    ensure!(errors.is_empty(), "managed SSH key revocation incomplete: {}", Value::Array(errors));
    Ok(json!({
        "revoked": true,
        "revokedGrantIds": revoked_ids,
        "remainingActiveGrants": store.grants.iter().filter(|g| g.state == "authorized").count(),
    }))
}

pub fn revoke_all_managed_keys(state_dir: &Path) -> Result<Value> {
    revoke_grants_matching(state_dir, |_| true)
}

pub fn revoke_superseded_epochs(state_dir: &Path, active_node_id: &str, active_epoch: u64) -> Result<Value> {
    revoke_grants_matching(state_dir, |g| g.node_id != active_node_id || g.epoch < active_epoch)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ed25519_key(seed: u8) -> String {
        let mut blob = Vec::with_capacity(51);
        blob.extend_from_slice(ED25519_WIRE_PREFIX);
        blob.extend((0..32u8).map(|i| i.wrapping_add(seed)));
        format!("ssh-ed25519 {}", STANDARD.encode(blob))
    }

    #[test]
    fn ed25519_validation_bom_fallback_and_scoped_authorized_keys_cleanup() -> Result<()> {
        let key1 = sample_ed25519_key(1);
        assert_eq!(validate_ed25519_public_key(&key1)?, key1);
        assert!(validate_ed25519_public_key(&format!("command=\"whoami\" {key1}")).is_err());
        assert!(validate_ed25519_public_key(&format!("{key1}\n{key1}")).is_err());
        assert!(validate_ed25519_public_key("ssh-ed25519 AQID").is_err());

        let base = std::env::temp_dir().join(format!("reach-ssh-unit-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&base)?;
        let auth_file = base.join("authorized_keys");
        let original = b"# Existing comment\r\nrestrict ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQ existing-admin";
        fs::write(&auth_file, original)?;

        let grant = SshGrant {
            grant_id: uuid::Uuid::new_v4().to_string(),
            node_id: uuid::Uuid::new_v4().to_string(),
            epoch: 1,
            path: auth_file.to_string_lossy().into_owned(),
            line: format!("{key1} ry-reach:test-node:e1:g1"),
            marker: "ry-reach:test-node:e1:g1".into(),
            prefix_length: original.len(),
            prefix_sha256: hash(original),
            added_separator: "\r\n".into(),
            state: "authorized".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
            error: None,
        };
        let mut with_reach = original.to_vec();
        with_reach.extend_from_slice(format!("\r\n{}\r\n", grant.line).as_bytes());
        fs::write(&auth_file, &with_reach)?;

        // Case 1: untouched prefix -> byte-exact restoration of original file
        remove_single_grant_from_file(&grant)?;
        assert_eq!(fs::read(&auth_file)?, original);

        // Case 2: UTF-8 BOM + concurrent administrator keys -> only Reach line removed, BOM & admin keys preserved!
        let mut bom_concurrent = vec![0xEF, 0xBB, 0xBF];
        bom_concurrent
            .extend_from_slice(format!("{}\r\nssh-ed25519 OTHER_ADMIN_KEY admin@corp\n", grant.line).as_bytes());
        fs::write(&auth_file, &bom_concurrent)?;
        remove_single_grant_from_file(&grant)?;
        let after_bytes = fs::read(&auth_file)?;
        assert!(after_bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let after = std::str::from_utf8(&after_bytes[3..])?;
        assert_eq!(after, "ssh-ed25519 OTHER_ADMIN_KEY admin@corp\n");

        // Case 3: manually edited Reach marker line -> refuses silent overwrite!
        let edited = format!("restrict {}\n", grant.line);
        fs::write(&auth_file, edited.as_bytes())?;
        assert!(remove_single_grant_from_file(&grant).is_err());

        fs::remove_dir_all(&base)?;
        Ok(())
    }
}
