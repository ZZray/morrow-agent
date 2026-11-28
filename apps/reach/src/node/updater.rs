// Copyright (c) Ray Zhang. Reach / namespace RY.
use crate::{
    api::{Api, HttpError},
    ledger::Identity,
};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Client, Method, RequestBuilder, Url};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fmt::Display,
    fs::{self, File, OpenOptions},
    io::Write,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

const INSTALLER: &str = "Reach-Node-Setup-x64.exe";
const WORKER_AGENT_INSTALLER: &str = "Reach-Worker-Agent-Setup-x64.exe";
const UPDATE_ROUTE: &str = "/api/v1/node/update";
const INITIAL_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(300);
const MAX_MANIFEST: usize = 16 * 1024;
const MAX_INSTALLER: u64 = 128 * 1024 * 1024;
const VERSION: &str = env!("REACH_COMPILED_VERSION");

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct UpdateBinding {
    server: String,
    secret: String,
    development: bool,
    node_id: String,
    epoch: u64,
}
impl UpdateBinding {
    pub(crate) fn from_identity(identity: &Identity) -> Option<Self> {
        if identity.revoked || identity.pending_pair.is_some() {
            return None;
        }
        Some(Self {
            server: identity.server.clone()?,
            secret: identity.secret.clone(),
            development: identity.development,
            node_id: identity.node_id.clone()?,
            epoch: identity.epoch,
        })
    }
}

#[derive(Clone, Copy)]
enum Package {
    Node,
    WorkerAgent,
}
impl Package {
    fn asset_kind(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::WorkerAgent => "agent",
        }
    }

    fn tag_prefix(self) -> &'static str {
        match self {
            Self::Node => "reach-v",
            Self::WorkerAgent => "reach-worker-agent-v",
        }
    }
}

#[derive(Debug)]
enum ProbeError {
    Unavailable(String),
    Invalid(String),
}

type ProbeResult<T> = std::result::Result<T, ProbeError>;

fn invalid(error: impl Display) -> ProbeError {
    ProbeError::Invalid(error.to_string())
}

fn outbound(error: reqwest::Error) -> ProbeError {
    if error.is_redirect() {
        invalid(error.without_url())
    } else {
        ProbeError::Unavailable(error.without_url().to_string())
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: u32,
    tag: String,
    version: String,
    commit: String,
    platform: String,
    installer: String,
    size: u64,
    sha256: String,
    agent_sha256: Option<String>,
}

fn version(text: &str) -> Option<[u16; 3]> {
    let mut parts = text.split('.');
    let mut version = [0; 3];
    for part in &mut version {
        let text = parts.next()?;
        *part = text.parse().ok()?;
        if text != part.to_string() {
            return None;
        }
    }
    parts.next().is_none().then_some(version)
}

fn lowercase_digest(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn verify_manifest(
    key: &[u8],
    bytes: &[u8],
    signature: &[u8],
    tag: &str,
    package: Package,
    current: [u16; 3],
) -> ProbeResult<Manifest> {
    UnparsedPublicKey::new(&ED25519, key)
        .verify(bytes, signature)
        .map_err(|_| invalid("release manifest Ed25519 signature is invalid"))?;
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|_| invalid("invalid signed release manifest"))?;
    let package_matches = if matches!(package, Package::WorkerAgent) {
        manifest.schema == 2
            && manifest.installer == WORKER_AGENT_INSTALLER
            && manifest.agent_sha256.as_deref().is_some_and(|sha| lowercase_digest(sha, 64))
    } else {
        manifest.schema == 1 && manifest.installer == INSTALLER && manifest.agent_sha256.is_none()
    };
    if !package_matches
        || manifest.tag != tag
        || tag.strip_prefix(package.tag_prefix()) != Some(&manifest.version)
        || !version(&manifest.version).is_some_and(|next| next > current)
        || !lowercase_digest(&manifest.commit, 40)
        || manifest.platform != "windows-x64"
        || !(256..=MAX_INSTALLER).contains(&manifest.size)
        || !lowercase_digest(&manifest.sha256, 64)
    {
        return Err(invalid("signed manifest does not match a newer release or the expected Windows package"));
    }
    Ok(manifest)
}

#[derive(Deserialize)]
struct ReleaseCatalog {
    configured: bool,
    releases: Vec<Release>,
}
#[derive(Deserialize)]
struct Release {
    version: String,
    tag: String,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    kind: String,
    os: Option<String>,
    arch: String,
    bytes: u64,
    sha256: String,
    update: Option<Update>,
}
#[derive(Deserialize)]
struct Update {
    manifest: String,
    signature: String,
    url: String,
}
struct Candidate {
    manifest: Manifest,
    url: String,
}

enum Selection {
    Unconfigured,
    Current,
    Available(Candidate),
}

impl Selection {
    fn confirms(&self, manifest: &Manifest) -> bool {
        matches!(self, Self::Available(candidate) if &candidate.manifest == manifest)
    }
}

fn select_update(catalog: Value, package: Package, signer: &[u8], current: [u16; 3]) -> ProbeResult<Selection> {
    let catalog: ReleaseCatalog =
        serde_json::from_value(catalog).map_err(|_| invalid("invalid Reach release catalog"))?;
    if !catalog.configured {
        return Ok(Selection::Unconfigured);
    }
    // The catalog only locates a candidate. The signed manifest authorizes the update.
    let latest = catalog
        .releases
        .into_iter()
        .filter_map(|release| {
            let announced = version(&release.version).filter(|announced| *announced > current)?;
            let asset = release.assets.into_iter().find(|asset| {
                asset.kind == package.asset_kind()
                    && asset.os.as_deref().unwrap_or("windows") == "windows"
                    && asset.arch == "x64"
                    && asset.update.is_some()
            })?;
            Some((announced, release.version, release.tag, asset))
        })
        .max_by_key(|(announced, _, _, _)| *announced);
    let Some((_, announced_version, tag, asset)) = latest else { return Ok(Selection::Current) };
    let update = asset.update.expect("selected signed update asset");
    let bytes = STANDARD.decode(update.manifest).map_err(|_| invalid("invalid release manifest encoding"))?;
    let signature = STANDARD.decode(update.signature).map_err(|_| invalid("invalid release signature encoding"))?;
    if bytes.len() > MAX_MANIFEST || signature.len() != 64 {
        return Err(invalid("invalid signed release metadata size"));
    }
    let manifest = verify_manifest(signer, &bytes, &signature, &tag, package, current)?;
    if manifest.version != announced_version
        || manifest.installer != asset.name
        || manifest.size != asset.bytes
        || manifest.sha256 != asset.sha256
    {
        return Err(invalid("Reach release catalog differs from the signed manifest"));
    }
    Ok(Selection::Available(Candidate { manifest, url: update.url }))
}

async fn query_site(api: &Api, package: Package, signer: &[u8], current: [u16; 3]) -> ProbeResult<Selection> {
    let catalog = api.call(Method::GET, UPDATE_ROUTE, None).await.map_err(|error| {
        let reason = error.downcast_ref::<HttpError>().map_or_else(
            || "Reach update discovery failed".to_owned(),
            |error| format!("Reach update discovery HTTP {}", error.status),
        );
        ProbeError::Unavailable(reason)
    })?;
    select_update(catalog, package, signer, current)
}

fn download_client() -> reqwest::Result<Client> {
    Client::builder()
        .user_agent("RY-Reach-Updater")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(90))
        .redirect(Policy::none())
        .build()
}

fn download_request(
    client: &Client,
    binding: &UpdateBinding,
    manifest: &Manifest,
    location: &str,
) -> ProbeResult<(RequestBuilder, &'static str, String)> {
    let site = Url::parse(&binding.server).map_err(invalid)?;
    let file = format!("{UPDATE_ROUTE}/files/{}/{}", manifest.tag, manifest.installer);
    let expected_path = format!("{}{}", site.path().trim_end_matches('/'), file);
    let url = if location == file.trim_start_matches('/') {
        let mut url = site.clone();
        url.set_path(&expected_path);
        url
    } else {
        let absolute = location
            .strip_prefix("https://")
            .filter(|url| !url.contains('\\'))
            .ok_or_else(|| invalid("expected the selected site file or an absolute HTTPS download URL"))?;
        let url = Url::parse(location).map_err(invalid)?;
        let authority_and_path = absolute.split(['?', '#']).next().unwrap_or_default();
        if authority_and_path.find('/').is_some_and(|start| &authority_and_path[start..] != url.path()) {
            return Err(invalid("release download path is not canonical"));
        }
        url
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(invalid("release download requires an HTTPS URL without credentials or a fragment"));
    }
    let origin = url.origin();
    let bound_file = site.origin() == origin && url.path() == expected_path && url.query().is_none();
    let request = client.get(url);
    if bound_file {
        Ok((request.bearer_auth(&binding.secret), "bound-site", origin.ascii_serialization()))
    } else {
        Ok((request, "anonymous-https", origin.ascii_serialization()))
    }
}

async fn download(request: RequestBuilder, manifest: &Manifest, installer: &Path) -> ProbeResult<()> {
    let mut response = request.send().await.map_err(outbound)?;
    if response.status().is_redirection() {
        return Err(invalid("release download redirect rejected"));
    }
    if !response.status().is_success() {
        return Err(ProbeError::Unavailable(format!("release download HTTP {}", response.status().as_u16())));
    }
    if response.content_length().is_some_and(|length| length != manifest.size) {
        return Err(invalid("installer Content-Length differs from the signed size"));
    }
    let mut output = OpenOptions::new().write(true).create_new(true).open(installer).map_err(invalid)?;
    let mut digest = Sha256::new();
    let mut size = 0;
    while let Some(chunk) = response.chunk().await.map_err(outbound)? {
        size += chunk.len() as u64;
        if size > manifest.size {
            return Err(invalid("installer exceeded the signed size"));
        }
        digest.update(&chunk);
        output.write_all(&chunk).map_err(invalid)?;
    }
    if size != manifest.size || format!("{:x}", digest.finalize()) != manifest.sha256 {
        return Err(invalid("installer bytes differ from the signed SHA-256 or size"));
    }
    output.sync_all().map_err(invalid)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Installation {
    schema: u32,
    version: String,
    node_state_schema: u32,
    node_path: PathBuf,
    binding_owner: String,
    #[serde(default)]
    desktop_bundled: bool,
}

fn inspect_installation(owner: &str) -> Result<Option<Package>> {
    let binary = std::env::current_exe()?;
    let installation = binary.ancestors().nth(3).context("installed version directory missing")?;
    let record: Installation = serde_json::from_slice(&fs::read(installation.join("install.json"))?)?;
    ensure!(
        record.node_state_schema == 1
            && record.version == VERSION
            && record.binding_owner == owner
            && record.node_path.canonicalize()? == binary.canonicalize()?,
        "the running service is not an installation supported by this update channel"
    );
    match record.schema {
        1 => Ok(Some(Package::Node)),
        2 if record.desktop_bundled => Ok(None),
        2 => Ok(Some(Package::WorkerAgent)),
        _ => anyhow::bail!("unsupported Reach installation record"),
    }
}

fn write_record(directory: &Path, name: &str, record: &Value) -> Result<()> {
    let temporary = directory.join(format!("receipt-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        serde_json::to_writer(&mut file, record)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, directory.join(name))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn clean_old_installers(directory: &Path) {
    let Ok(files) = fs::read_dir(directory) else { return };
    for entry in files.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_prefix("setup-")?.strip_suffix(".exe")) else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_ok()
            && entry
                .metadata()
                .and_then(|data| data.modified())
                .is_ok_and(|updated| updated.elapsed().is_ok_and(|elapsed| elapsed > Duration::from_secs(900)))
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

enum CheckResult {
    NoUpdate(&'static str),
    Ready(Manifest),
}

fn retain_attempt(candidate_selected: bool, result: &ProbeResult<CheckResult>) -> bool {
    candidate_selected || matches!(result, Err(ProbeError::Invalid(_)))
}

fn discard_changed_binding(status: &mut Value, checked: &UpdateBinding, active: Option<&UpdateBinding>) -> bool {
    if active == Some(checked) {
        return false;
    }
    status["site"] = Value::Null;
    status["result"] = json!("binding_changed");
    true
}

async fn check(
    directory: &Path,
    owner: &str,
    bindings: &watch::Receiver<Option<UpdateBinding>>,
    client: &Client,
    signer: &[u8],
    current: [u16; 3],
) -> Result<()> {
    let package = inspect_installation(owner)?;
    clean_old_installers(directory);
    let attempt_id = uuid::Uuid::new_v4();
    let installer = directory.join(format!("setup-{attempt_id}.exe"));
    let receipt = format!("attempt-{attempt_id}.json");
    let mut status = json!({
        "currentVersion": VERSION,
        "checkedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
        "attempts": [],
    });

    let Some(package) = package else {
        status["result"] = json!("desktop_package_not_supported");
        return write_record(directory, "last-check.json", &status);
    };
    let binding = bindings.borrow().clone();
    let Some(binding) = binding else {
        status["result"] = json!("awaiting_binding");
        return write_record(directory, "last-check.json", &status);
    };
    let result: ProbeResult<CheckResult> = async {
        let api = Api::new(&binding.server, &binding.secret, binding.development)
            .map_err(|_| invalid("invalid update site configuration"))?;
        status["site"] = json!(binding.server);
        let Candidate { manifest, url } = match query_site(&api, package, signer, current).await? {
            Selection::Unconfigured => return Ok(CheckResult::NoUpdate("unconfigured")),
            Selection::Current => return Ok(CheckResult::NoUpdate("current")),
            Selection::Available(candidate) => candidate,
        };
        let (request, mode, origin) = download_request(client, &binding, &manifest, &url)?;
        status["candidate"] = json!({
            "source": "reach", "site": binding.server, "downloadMode": mode, "downloadOrigin": origin,
            "version": manifest.version, "tag": manifest.tag, "commit": manifest.commit,
            "installerSha256": manifest.sha256, "size": manifest.size, "agentSha256": manifest.agent_sha256,
        });
        download(request, &manifest, &installer).await?;
        // The binding can be revoked or its published release withdrawn during a download.
        let confirmation = match query_site(&api, package, signer, current).await {
            Ok(offered) => offered.confirms(&manifest),
            Err(error) => {
                status["candidate"]["confirmation"] = json!("failed");
                return Err(error);
            }
        };
        status["candidate"]["confirmation"] = json!(if confirmation { "verified" } else { "changed" });
        if !confirmation {
            let _ = fs::remove_file(&installer);
            return Ok(CheckResult::NoUpdate("candidate_changed"));
        }
        Ok(CheckResult::Ready(manifest))
    }
    .await;
    let (outcome, reason) = match &result {
        Ok(CheckResult::Ready(_)) => ("verified", None),
        Ok(CheckResult::NoUpdate(outcome)) => (*outcome, None),
        Err(ProbeError::Unavailable(reason)) => ("unavailable", Some(reason)),
        Err(ProbeError::Invalid(reason)) => ("invalid", Some(reason)),
    };
    status["attempts"] = json!([{
        "source": "reach", "site": status["site"], "outcome": outcome, "reason": reason,
    }]);
    // Hold the current snapshot through the synchronous final receipt or Setup handoff.
    let active = bindings.borrow();
    let retain = retain_attempt(status.get("candidate").is_some(), &result);
    if discard_changed_binding(&mut status, &binding, active.as_ref()) {
        let _ = fs::remove_file(&installer);
    } else {
        match result {
            Ok(CheckResult::Ready(manifest)) => {
                status["result"] = json!("verified");
                write_record(directory, &receipt, &status)?;
                let launch = (|| -> Result<u32> {
                    let log = directory.join(format!("attempt-{attempt_id}.log"));
                    let stdout = File::create(log)?;
                    let stderr = stdout.try_clone()?;
                    // Setup asks this service to stop through the normal maintenance pipe.
                    let mut process = Command::new(&installer);
                    process.args([
                        "--silent",
                        "--elevated",
                        "--owner",
                        owner,
                        "--auto-update",
                        "--expected-version",
                        &manifest.version,
                    ]);
                    if let Some(sha) = &manifest.agent_sha256 {
                        process.args(["--expected-agent-sha256", sha]);
                    }
                    Ok(process
                        .current_dir(directory)
                        .stdin(Stdio::null())
                        .stdout(Stdio::from(stdout))
                        .stderr(Stdio::from(stderr))
                        .creation_flags(0x08000000)
                        .spawn()?
                        .id())
                })();
                match launch {
                    Ok(pid) => {
                        status["result"] = json!("installer_started");
                        status["installerPid"] = json!(pid);
                    }
                    Err(error) => {
                        let _ = fs::remove_file(&installer);
                        status["result"] = json!("start_failed");
                        status["error"] = json!(error.to_string());
                    }
                }
            }
            Ok(CheckResult::NoUpdate(outcome)) => status["result"] = json!(outcome),
            Err(error) => {
                let _ = fs::remove_file(&installer);
                status["result"] = json!(if matches!(error, ProbeError::Invalid(_)) {
                    "verification_failed"
                } else {
                    "all_sources_unavailable"
                });
            }
        }
    }
    if retain {
        write_record(directory, &receipt, &status)?;
    }
    write_record(directory, "last-check.json", &status)
}

fn decode_signer(pin: &str) -> Result<[u8; 32]> {
    ensure!(pin.len() == 64 && pin.bytes().all(|byte| byte.is_ascii_hexdigit()), "invalid update signing key");
    let mut key = [0; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&pin[index * 2..index * 2 + 2], 16)?;
    }
    Ok(key)
}

pub fn channel_info() -> Value {
    let public_key = option_env!("REACH_UPDATE_PUBLIC_KEY_HEX");
    json!({
        "source": "bound-reach",
        "publicKey": public_key.map(str::to_ascii_lowercase),
    })
}

pub async fn run(root: PathBuf, owner: String, bindings: watch::Receiver<Option<UpdateBinding>>) {
    let Some(pin) = option_env!("REACH_UPDATE_PUBLIC_KEY_HEX") else { return };
    let result: Result<()> = async {
        ensure!(crate::windows_host::current_sid()? == "S-1-5-18", "updates require the LocalSystem service");
        let signer = decode_signer(pin)?;
        let current = version(VERSION).context("invalid compiled Reach version")?;
        let directory = root.join("update");
        crate::windows_host::validate_state_path(&directory)?;
        fs::create_dir_all(&directory)?;
        let client = download_client()?;
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            if let Err(error) = check(&directory, &owner, &bindings, &client, &signer, current).await {
                let record = json!({"currentVersion": VERSION, "result": "check_failed", "error": error.to_string()});
                if let Err(receipt_error) = write_record(&directory, "last-check.json", &record) {
                    eprintln!("Reach updater could not save its check result: {receipt_error}");
                }
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    }
    .await;
    if let Err(error) = result {
        eprintln!("Reach updater could not start: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn signed_release(signer: &Ed25519KeyPair, version: &str, package: Package) -> Value {
        let tag = format!("{}{version}", package.tag_prefix());
        let (installer, schema) = match package {
            Package::Node => (INSTALLER, 1),
            Package::WorkerAgent => (WORKER_AGENT_INSTALLER, 2),
        };
        let mut manifest = json!({
            "schema": schema, "tag": tag, "version": version, "commit": "a".repeat(40),
            "platform": "windows-x64", "installer": installer, "size": 1024, "sha256": "b".repeat(64),
        });
        if matches!(package, Package::WorkerAgent) {
            manifest["agent_sha256"] = json!("c".repeat(64));
        }
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let signature = signer.sign(&bytes);
        json!({
            "version": version, "tag": tag,
            "assets": [{
                "name": installer, "kind": package.asset_kind(), "os": "windows", "arch": "x64",
                "bytes": 1024, "sha256": "b".repeat(64), "signed": false,
                "update": {
                    "manifest": STANDARD.encode(bytes),
                    "signature": STANDARD.encode(signature.as_ref()),
                    "url": "https://downloads.example/reach/release.exe",
                }
            }]
        })
    }

    #[test]
    fn selects_latest_newer_signed_release_for_the_installed_package() {
        let signer = Ed25519KeyPair::from_seed_unchecked(&[6; 32]).unwrap();
        let mut linux = signed_release(&signer, "0.9.0", Package::WorkerAgent);
        linux["assets"][0]["os"] = json!("linux");
        let mut manual = signed_release(&signer, "0.8.0", Package::WorkerAgent);
        manual["assets"][0].as_object_mut().unwrap().remove("update");
        let mut arm = signed_release(&signer, "0.7.0", Package::WorkerAgent);
        arm["assets"][0]["arch"] = json!("arm64");
        let mut legacy = signed_release(&signer, "0.4.0", Package::Node);
        legacy["assets"][0].as_object_mut().unwrap().remove("os");
        let catalog = json!({
            "configured": true,
            "releases": [
                linux, manual, arm,
                signed_release(&signer, "0.2.0", Package::WorkerAgent),
                legacy,
                signed_release(&signer, "0.3.0", Package::WorkerAgent),
            ],
        });
        let key = signer.public_key().as_ref();
        let agent = offered(select_update(catalog.clone(), Package::WorkerAgent, key, [0, 1, 0]).unwrap());
        assert_eq!(agent.manifest.version, "0.3.0");
        assert_eq!(agent.manifest.installer, WORKER_AGENT_INSTALLER);
        assert_eq!(agent.manifest.agent_sha256, Some("c".repeat(64)));
        let node = offered(select_update(catalog.clone(), Package::Node, key, [0, 1, 0]).unwrap());
        assert_eq!(node.manifest.version, "0.4.0");
        assert_eq!(node.manifest.installer, INSTALLER);
        assert!(node.manifest.agent_sha256.is_none());
        assert!(matches!(select_update(catalog, Package::WorkerAgent, key, [0, 3, 0]).unwrap(), Selection::Current));
        let unconfigured = json!({"configured": false, "releases": []});
        assert!(matches!(select_update(unconfigured, Package::Node, key, [0, 1, 0]).unwrap(), Selection::Unconfigured));
    }

    #[test]
    fn signed_installer_identity_cannot_be_changed_by_catalog_fields() {
        let signer = Ed25519KeyPair::from_seed_unchecked(&[6; 32]).unwrap();
        let key = signer.public_key().as_ref();
        let release = signed_release(&signer, "0.2.0", Package::WorkerAgent);
        let mut mismatch = release.clone();
        mismatch["tag"] = json!("reach-worker-agent-v0.3.0");
        let verify =
            |entry| select_update(json!({"configured":true,"releases":[entry]}), Package::WorkerAgent, key, [0, 1, 0]);
        assert!(verify(mismatch).is_err());
        let mut mismatch = release.clone();
        mismatch["version"] = json!("0.3.0");
        assert!(verify(mismatch).is_err());
        for (field, value) in [("bytes", json!(2048)), ("sha256", json!("a".repeat(64))), ("name", json!(INSTALLER))] {
            let mut mismatch = release.clone();
            mismatch["assets"][0][field] = value;
            assert!(verify(mismatch).is_err());
        }
        let mut swapped = release;
        swapped["assets"][0]["kind"] = json!("node");
        assert!(select_update(json!({"configured":true,"releases":[swapped]}), Package::Node, key, [0, 1, 0]).is_err());
    }

    #[test]
    fn verifies_original_bytes_newer_version_and_signed_git_and_package_identity() {
        let signer = Ed25519KeyPair::from_seed_unchecked(&[6; 32]).unwrap();
        let key = signer.public_key().as_ref();
        let release = signed_release(&signer, "0.2.0", Package::WorkerAgent);
        let tag = release["tag"].as_str().unwrap();
        let update = &release["assets"][0]["update"];
        let bytes = STANDARD.decode(update["manifest"].as_str().unwrap()).unwrap();
        let signature = STANDARD.decode(update["signature"].as_str().unwrap()).unwrap();
        let verify = |bytes: &[u8], signature: &[u8], current| {
            verify_manifest(key, bytes, signature, tag, Package::WorkerAgent, current)
        };
        assert!(verify(&bytes, &signature, [0, 1, 0]).is_ok());
        assert!(verify(&bytes, &signature, [0, 2, 0]).is_err());
        assert!(verify(&bytes, &signature, [0, 3, 0]).is_err());
        let mut changed = bytes.clone();
        changed.push(b'\n');
        assert!(verify(&changed, &signature, [0, 1, 0]).is_err());
        let original: Value = serde_json::from_slice(&bytes).unwrap();
        for (field, value) in [
            ("commit", json!("A".repeat(40))),
            ("agent_sha256", Value::Null),
            ("schema", json!(1)),
            ("platform", json!("linux-x64")),
            ("installer", json!(INSTALLER)),
            ("size", json!(MAX_INSTALLER + 1)),
            ("sha256", json!("z".repeat(64))),
        ] {
            let mut manifest = original.clone();
            manifest[field] = value;
            let changed = serde_json::to_vec(&manifest).unwrap();
            let signature = signer.sign(&changed);
            assert!(verify(&changed, signature.as_ref(), [0, 1, 0]).is_err(), "{field}");
        }
    }

    fn offered(selection: Selection) -> Candidate {
        let Selection::Available(candidate) = selection else { panic!("expected a signed candidate") };
        candidate
    }

    #[test]
    fn completed_download_requires_the_same_signed_candidate_from_a_fresh_catalog() {
        let signer = Ed25519KeyPair::from_seed_unchecked(&[6; 32]).unwrap();
        let release = signed_release(&signer, "0.2.0", Package::WorkerAgent);
        let select = |catalog| select_update(catalog, Package::WorkerAgent, signer.public_key().as_ref(), [0, 1, 0]);
        let original = offered(select(json!({"configured":true,"releases":[release.clone()]})).unwrap());
        let mut rotated = release.clone();
        rotated["assets"][0]["update"]["url"] = json!("https://example.org/release.exe?token=rotated");
        assert!(select(json!({"configured":true,"releases":[rotated]})).unwrap().confirms(&original.manifest));
        let newer = signed_release(&signer, "0.3.0", Package::WorkerAgent);
        assert!(!select(json!({"configured":true,"releases":[release.clone(),newer]}))
            .unwrap()
            .confirms(&original.manifest));
        assert!(!select(json!({"configured":true,"releases":[]})).unwrap().confirms(&original.manifest));
        assert!(!select(json!({"configured":false,"releases":[]})).unwrap().confirms(&original.manifest));
        let mut invalid_signature = release;
        invalid_signature["assets"][0]["update"]["signature"] = json!(STANDARD.encode([0; 64]));
        assert!(select(json!({"configured":true,"releases":[invalid_signature]})).is_err());
    }

    #[test]
    fn a_changed_binding_discards_all_stale_site_outcomes() {
        let previous = UpdateBinding::from_identity(&paired_identity()).unwrap();
        let mut identity = paired_identity();
        identity.server = Some("https://other.example/reach".into());
        let next = UpdateBinding::from_identity(&identity).unwrap();
        for result in ["current", "unconfigured", "verification_failed", "all_sources_unavailable", "verified"] {
            let mut status = json!({"site": previous.server, "result": result, "attempts": [{"site":previous.server}]});
            assert!(!discard_changed_binding(&mut status, &previous, Some(&previous)));
            assert_eq!(status["result"], result);
            assert!(discard_changed_binding(&mut status, &previous, Some(&next)));
            assert_eq!(status["result"], "binding_changed");
            assert!(status["site"].is_null());
            assert_eq!(status["attempts"][0]["site"], previous.server);
        }
    }

    #[test]
    fn ordinary_offline_checks_do_not_accumulate_attempt_receipts() {
        let unavailable = Err(ProbeError::Unavailable("site unreachable".into()));
        let invalid = Err(ProbeError::Invalid("invalid update signature".into()));
        let changed = Ok(CheckResult::NoUpdate("candidate_changed"));
        assert!(!retain_attempt(false, &unavailable));
        assert!(!retain_attempt(false, &Ok(CheckResult::NoUpdate("current"))));
        assert!(retain_attempt(false, &invalid));
        assert!(retain_attempt(true, &unavailable));
        assert!(retain_attempt(true, &changed));
    }

    fn paired_identity() -> Identity {
        Identity {
            installation_id: "local-installation".into(),
            secret: "fixture-device-token".into(),
            node_id: Some("bound-node".into()),
            epoch: 3,
            server: Some("https://ray.example/reach".into()),
            development: false,
            pending_pair: None,
            last_pair: None,
            revoked: false,
        }
    }

    #[test]
    fn only_a_live_pairing_produces_an_update_binding() {
        let identity = paired_identity();
        let binding = UpdateBinding::from_identity(&identity).unwrap();
        let mut changed = identity.clone();
        changed.epoch += 1;
        assert!(binding != UpdateBinding::from_identity(&changed).unwrap());
        changed.pending_pair = Some(json!({}));
        assert!(UpdateBinding::from_identity(&changed).is_none());
        changed.pending_pair = None;
        changed.revoked = true;
        assert!(UpdateBinding::from_identity(&changed).is_none());
        changed.revoked = false;
        changed.node_id = None;
        assert!(UpdateBinding::from_identity(&changed).is_none());
    }

    #[test]
    fn device_bearer_is_only_sent_for_the_selected_file_under_the_bound_mount() {
        use reqwest::header::AUTHORIZATION;
        let binding = UpdateBinding::from_identity(&paired_identity()).unwrap();
        let signer = Ed25519KeyPair::from_seed_unchecked(&[6; 32]).unwrap();
        let release = signed_release(&signer, "0.2.0", Package::Node);
        let candidate = offered(
            select_update(
                json!({"configured":true,"releases":[release]}),
                Package::Node,
                signer.public_key().as_ref(),
                [0, 1, 0],
            )
            .unwrap(),
        );
        let manifest = &candidate.manifest;
        let client = download_client().unwrap();
        let file = "https://ray.example/reach/api/v1/node/update/files/reach-v0.2.0/Reach-Node-Setup-x64.exe";
        let (request, mode, origin) = download_request(&client, &binding, manifest, file).unwrap();
        assert_eq!(mode, "bound-site");
        assert_eq!(origin, "https://ray.example");
        assert_eq!(request.build().unwrap().headers()[AUTHORIZATION], "Bearer fixture-device-token");
        let relative = "api/v1/node/update/files/reach-v0.2.0/Reach-Node-Setup-x64.exe";
        for server in ["https://ray.example", "https://www.ray.example/reach", "https://203.0.113.7/reach"] {
            let mut identity = paired_identity();
            identity.server = Some(server.into());
            let binding = UpdateBinding::from_identity(&identity).unwrap();
            let (request, mode, _) = download_request(&client, &binding, manifest, relative).unwrap();
            let request = request.build().unwrap();
            assert_eq!(mode, "bound-site");
            assert_eq!(request.url().as_str(), format!("{server}/{relative}"));
            assert_eq!(request.headers()[AUTHORIZATION], "Bearer fixture-device-token");
        }

        for url in [
            "https://oss.example/reach/releases/release.exe?download=1",
            "https://ray.example:8443/reach/api/v1/node/update/files/reach-v0.2.0/Reach-Node-Setup-x64.exe",
            "https://ray.example/api/v1/node/update/files/reach-v0.2.0/Reach-Node-Setup-x64.exe",
            "https://ray.example/reach/api/v1/node/update/files/reach-v0.3.0/Reach-Node-Setup-x64.exe",
            "https://ray.example/reach/api/v1/node/update/files/reach-v0.2.0/Reach-Worker-Agent-Setup-x64.exe",
            "https://ray.example/reach/api/v1/node/update/files/reach-v0.2.0/Reach-Node-Setup-x64.exe?download=1",
            "https://ray.example/other-app/release.exe",
        ] {
            let (request, mode, origin) = download_request(&client, &binding, manifest, url).unwrap();
            assert_eq!(mode, "anonymous-https");
            assert!(!origin.contains('?'));
            assert!(!request.build().unwrap().headers().contains_key(AUTHORIZATION));
        }
        for url in [
            "/api/v1/node/update/files/reach-v0.2.0/Reach-Node-Setup-x64.exe",
            "//oss.example/release.exe",
            "https:oss.example/release.exe",
            "api/v1/node/update/files/reach-v0.3.0/Reach-Node-Setup-x64.exe",
            "api/v1/node/update/files/../reach-v0.2.0/Reach-Node-Setup-x64.exe",
            "api/v1/node/update/files/%2e%2e/reach-v0.2.0/Reach-Node-Setup-x64.exe",
            "https://ray.example/reach/api/v1/node/update/files/../files/reach-v0.2.0/Reach-Node-Setup-x64.exe",
            "http://ray.example/reach/release.exe",
            "https://user@ray.example/reach/release.exe",
            "https://ray.example/reach/release.exe#fragment",
        ] {
            assert!(download_request(&client, &binding, manifest, url).is_err());
        }
    }

    #[tokio::test]
    async fn refuses_download_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let responder = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/redirect", responder.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut request, _) = responder.accept().await.unwrap();
            let mut incoming = [0; 1024];
            assert!(request.read(&mut incoming).await.unwrap() > 0);
            request
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let signer = Ed25519KeyPair::from_seed_unchecked(&[6; 32]).unwrap();
        let release = signed_release(&signer, "0.2.0", Package::Node);
        let candidate = offered(
            select_update(
                json!({"configured":true,"releases":[release]}),
                Package::Node,
                signer.public_key().as_ref(),
                [0, 1, 0],
            )
            .unwrap(),
        );
        let path = std::env::temp_dir().join(format!("reach-download-{}.exe", uuid::Uuid::new_v4()));
        let client = download_client().unwrap();
        let result = download(client.get(url), &candidate.manifest, &path).await;
        assert!(matches!(result, Err(ProbeError::Invalid(reason)) if reason == "release download redirect rejected"));
        assert!(!path.exists());
        server.await.unwrap();
    }

    #[test]
    fn installed_version_parser_accepts_only_three_canonical_components() {
        assert_eq!(version("0.1.11"), Some([0, 1, 11]));
        assert_eq!(version("0.1.65535"), Some([0, 1, 65535]));
        for invalid in ["0.1", "0.1.011", "0.1.1.1", "0.1.65536", "0.1.-1", "0.1.+1", "0.1.1-preview"] {
            assert!(version(invalid).is_none(), "{invalid}");
        }
    }
}
