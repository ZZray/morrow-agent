// Copyright (c) Ray Zhang. Reach / namespace RY.
use anyhow::{ensure, Context, Result};
use reqwest::{redirect::Policy, Client, Response, Url};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fmt::Display,
    fs::{self, File, OpenOptions},
    io::Write,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    str,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const INSTALLER: &str = "Reach-Node-Setup-x64.exe";
const WORKER_AGENT_INSTALLER: &str = "Reach-Worker-Agent-Setup-x64.exe";
const MANIFEST: &str = "reach-update.json";
const SIGNATURE: &str = "reach-update.sig";
const INITIAL_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(300);
const MAX_METADATA: usize = 4 * 1024 * 1024;
const MAX_INSTALLER: u64 = 128 * 1024 * 1024;
const VERSION: &str = env!("REACH_COMPILED_VERSION");

#[derive(Clone, Copy)]
enum Source {
    Github,
    Gitee,
}
impl Source {
    fn name(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitee => "gitee",
        }
    }

    fn repository(self) -> &'static str {
        match self {
            Self::Github => "https://github.com/ZZray/morrow-agent",
            Self::Gitee => "https://gitee.com/rzjw/morrow-agent",
        }
    }

    fn allows(self, url: &Url) -> bool {
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
            return false;
        }
        match self {
            Self::Github => matches!(
                url.host_str(),
                Some("github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com")
            ),
            Self::Gitee => matches!(url.host_str(), Some("gitee.com" | "foruda.gitee.com")),
        }
    }

    fn client(self) -> Result<Client> {
        let mut builder = Client::builder()
            .user_agent("RY-Reach-Updater")
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(90))
            .redirect(Policy::custom(move |request| {
                if request.previous().len() > 5 || !self.allows(request.url()) {
                    request.error("invalid Reach release redirect")
                } else {
                    request.follow()
                }
            }));
        if matches!(self, Self::Github) {
            if let Some(proxy) = std::env::var_os("REACH_UPDATE_GITHUB_PROXY") {
                let proxy = proxy.into_string().map_err(|_| anyhow::anyhow!("invalid GitHub update proxy"))?;
                builder = builder.proxy(reqwest::Proxy::https(&proxy).context("invalid GitHub update proxy")?);
            }
        }
        builder.build().context("cannot construct release HTTP client")
    }
}

#[derive(Clone, Copy)]
enum Package {
    Node,
    WorkerAgent,
}
impl Package {
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

#[derive(Debug, Deserialize)]
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

fn git_packet<'a>(source: &mut &'a [u8]) -> ProbeResult<Option<&'a [u8]>> {
    let malformed = || invalid("invalid Git reference advertisement");
    let header = source.get(..4).ok_or_else(malformed)?;
    if !header.iter().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(malformed());
    }
    let length = usize::from_str_radix(str::from_utf8(header).map_err(invalid)?, 16).map_err(invalid)?;
    if length == 0 {
        *source = &source[4..];
        return Ok(None);
    }
    let packet = source.get(4..length).ok_or_else(malformed)?;
    *source = &source[length..];
    Ok(Some(packet))
}

fn lowercase_digest(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

// An annotated tag's ^{} line identifies the tagged object, while the direct
// reference identifies the tag object. A lightweight tag has only a direct reference.
fn newest_tag(mut advertisement: &[u8], current: [u16; 3], package: Package) -> ProbeResult<Option<(String, String)>> {
    const SERVICE_HEADER: &[u8] = b"001e# service=git-upload-pack\n0000";
    advertisement = advertisement.strip_prefix(SERVICE_HEADER).ok_or_else(|| {
        ProbeError::Unavailable("repository did not return a smart Git reference advertisement".into())
    })?;
    let mut tags = BTreeMap::<[u16; 3], (Option<&str>, Option<&str>)>::new();
    while let Some(packet) = git_packet(&mut advertisement)? {
        let line = packet.split(|byte| *byte == 0 || *byte == b'\n').next().unwrap_or_default();
        let Some(separator) = line.iter().position(|byte| *byte == b' ') else {
            return Err(invalid("invalid Git reference line"));
        };
        let Some(reference) = line[separator + 1..].strip_prefix(b"refs/tags/")
            .and_then(|reference| reference.strip_prefix(package.tag_prefix().as_bytes()))
        else {
            continue;
        };
        let Ok(reference) = str::from_utf8(reference) else { continue };
        let peeled = reference.strip_suffix("^{}");
        let Some(next) = version(peeled.unwrap_or(reference)).filter(|next| *next > current) else {
            continue;
        };
        let sha = str::from_utf8(&line[..separator]).map_err(invalid)?;
        if !lowercase_digest(sha, 40) {
            return Err(invalid("release tag has an invalid Git object ID"));
        }
        let (direct, dereferenced) = tags.entry(next).or_default();
        let expected = if peeled.is_some() { dereferenced } else { direct };
        if expected.replace(sha).is_some() {
            return Err(invalid("release tag has duplicate Git references"));
        }
    }
    if !advertisement.is_empty() {
        return Err(invalid("unexpected bytes after the Git reference advertisement"));
    }
    tags.pop_last()
        .map(|([major, minor, patch], (direct, peeled))| {
            let direct = direct.ok_or_else(|| invalid("dereferenced release tag has no Git reference"))?;
            Ok((format!("{}{major}.{minor}.{patch}", package.tag_prefix()), peeled.unwrap_or(direct).to_owned()))
        })
        .transpose()
}

fn verify_manifest(
    key: &[u8], bytes: &[u8], signature: &[u8], tag: &str, commit: &str, package: Package,
) -> ProbeResult<Manifest> {
    UnparsedPublicKey::new(&ED25519, key)
        .verify(bytes, signature)
        .map_err(|_| invalid("release manifest Ed25519 signature is invalid"))?;
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(invalid)?;
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
        || version(&manifest.version).is_none()
        || manifest.commit != commit
        || !lowercase_digest(&manifest.commit, 40)
        || manifest.platform != "windows-x64"
        || !(256..=MAX_INSTALLER).contains(&manifest.size)
        || !lowercase_digest(&manifest.sha256, 64)
    {
        return Err(invalid("signed manifest does not match the selected Git tag, commit, or Windows package"));
    }
    Ok(manifest)
}

async fn response(client: &Client, source: Source, location: &str) -> ProbeResult<Response> {
    let url = Url::parse(location).map_err(invalid)?;
    if !source.allows(&url) {
        return Err(invalid("release host rejected"));
    }
    let response = client.get(url).send().await.map_err(outbound)?;
    if !response.status().is_success() {
        return Err(ProbeError::Unavailable(format!("release HTTP {}", response.status().as_u16())));
    }
    Ok(response)
}

async fn metadata(client: &Client, source: Source, location: &str, limit: usize) -> ProbeResult<Vec<u8>> {
    let mut response = response(client, source, location).await?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(outbound)? {
        if chunk.len() > limit - bytes.len() {
            return Err(invalid("release metadata exceeds its size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

struct Candidate {
    manifest: Manifest,
    path: PathBuf,
}

async fn fetch(
    source: Source, package: Package, current: [u16; 3], signer: &[u8], installer: &Path,
) -> ProbeResult<Option<Candidate>> {
    let repository = source.repository();
    let client = source.client().map_err(invalid)?;
    let advertisement =
        metadata(&client, source, &format!("{repository}.git/info/refs?service=git-upload-pack"), MAX_METADATA).await?;
    let Some((tag, commit)) = newest_tag(&advertisement, current, package)? else {
        return Ok(None);
    };
    let release = format!("{repository}/releases/download/{tag}");
    let bytes = metadata(&client, source, &format!("{release}/{MANIFEST}"), 16 * 1024).await?;
    let signature = metadata(&client, source, &format!("{release}/{SIGNATURE}"), 64).await?;
    let manifest = verify_manifest(signer, &bytes, &signature, &tag, &commit, package)?;
    let mut response = response(&client, source, &format!("{release}/{}", manifest.installer)).await?;
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
    Ok(Some(Candidate { manifest, path: installer.to_owned() }))
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

async fn check(directory: &Path, owner: &str, signer: &[u8], current: [u16; 3]) -> Result<()> {
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
    let sources: &[Source] = match package {
        Package::Node => &[Source::Github, Source::Gitee],
        Package::WorkerAgent => &[Source::Gitee],
    };
    for &source in sources {
        let result = fetch(source, package, current, signer, &installer).await;
        let (outcome, reason) = match &result {
            Ok(Some(_)) => ("verified", None),
            Ok(None) => ("current", None),
            Err(ProbeError::Unavailable(reason)) => ("unavailable", Some(reason)),
            Err(ProbeError::Invalid(reason)) => ("invalid", Some(reason)),
        };
        status["attempts"].as_array_mut().expect("new receipt has attempts").push(json!({
            "source": source.name(), "outcome": outcome, "reason": reason,
        }));
        match result {
            Ok(Some(candidate)) => {
                let manifest = candidate.manifest;
                status["candidate"] = json!({
                    "source": source.name(), "version": manifest.version, "tag": manifest.tag,
                    "commit": manifest.commit, "installerSha256": manifest.sha256, "size": manifest.size,
                    "agentSha256": manifest.agent_sha256,
                });
                status["result"] = json!("verified");
                write_record(directory, &receipt, &status)?;
                let launch = (|| -> Result<u32> {
                    let log = directory.join(format!("attempt-{attempt_id}.log"));
                    let stdout = File::create(log)?;
                    let stderr = stdout.try_clone()?;
                    // Do not wait here. Setup asks this service to stop through the normal maintenance pipe.
                    let mut process = Command::new(&candidate.path);
                    process.args(["--silent", "--elevated", "--owner", owner, "--auto-update", "--expected-version", &manifest.version]);
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
                        let _ = fs::remove_file(installer);
                        status["result"] = json!("start_failed");
                        status["error"] = json!(error.to_string());
                    }
                }
                write_record(directory, &receipt, &status)?;
                break;
            }
            Ok(None) => {
                status["result"] = json!("current");
                break;
            }
            Err(ProbeError::Unavailable(_)) => {
                let _ = fs::remove_file(&installer);
                status["result"] = json!("all_sources_unavailable");
            }
            Err(ProbeError::Invalid(_)) => {
                let _ = fs::remove_file(&installer);
                status["result"] = json!("verification_failed");
                write_record(directory, &receipt, &status)?;
                break;
            }
        }
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
        "giteeProject": Source::Gitee.repository(),
        "publicKey": public_key.map(str::to_ascii_lowercase),
    })
}

pub async fn run(root: PathBuf, owner: String) {
    let Some(pin) = option_env!("REACH_UPDATE_PUBLIC_KEY_HEX") else { return };
    let result: Result<()> = async {
        ensure!(crate::windows_host::current_sid()? == "S-1-5-18", "updates require the LocalSystem service");
        let signer = decode_signer(pin)?;
        let current = version(VERSION).context("invalid compiled Reach version")?;
        let directory = root.join("update");
        crate::windows_host::validate_state_path(&directory)?;
        fs::create_dir_all(&directory)?;
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            if let Err(error) = check(&directory, &owner, &signer, current).await {
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

    #[tokio::test]
    #[ignore = "requires network access to both live Git remotes"]
    async fn both_real_remotes_advertise_git_references_over_https() {
        for source in [Source::Github, Source::Gitee] {
            let url = format!("{}.git/info/refs?service=git-upload-pack", source.repository());
            let bytes = metadata(&source.client().unwrap(), source, &url, MAX_METADATA).await.unwrap();
            let _ = newest_tag(&bytes, [0, 0, 0], Package::Node).unwrap();
        }
    }

    #[test]
    fn selects_the_highest_newer_reach_git_tag_and_resolves_annotated_tags() {
        let mut refs = b"001e# service=git-upload-pack\n0000".to_vec();
        for (sha, reference) in [
            ('a', "refs/tags/reach-v0.0.9"),
            ('b', "refs/tags/reach-v0.1.0"),
            ('c', "refs/tags/reach-v0.2.9"),
            ('d', "refs/tags/reach-v0.2.11"),
            ('e', "refs/tags/reach-v0.2.11^{}"),
            ('f', "refs/tags/reach-v00.3.0"),
            ('0', "refs/tags/reach-v0.3.0-preview"),
            ('1', "refs/tags/v0.5.0"),
            ('2', "refs/tags/reach-worker-agent-v0.3.1"),
            ('3', "refs/tags/reach-worker-agent-v0.3.2-preview"),
        ] {
            let line = format!("{} {reference}\n", sha.to_string().repeat(40));
            refs.extend_from_slice(format!("{:04x}{line}", line.len() + 4).as_bytes());
        }
        refs.extend_from_slice(b"0000");
        assert_eq!(newest_tag(&refs, [0, 1, 0], Package::Node).unwrap(), Some(("reach-v0.2.11".into(), "e".repeat(40))));
        assert_eq!(newest_tag(&refs, [0, 2, 11], Package::Node).unwrap(), None);
        assert_eq!(newest_tag(&refs, [0, 1, 0], Package::WorkerAgent).unwrap(), Some(("reach-worker-agent-v0.3.1".into(), "2".repeat(40))));
        assert!(matches!(newest_tag(&refs[..refs.len() - 1], [0, 1, 0], Package::Node), Err(ProbeError::Invalid(_))));
        assert!(matches!(newest_tag(b"proxy unavailable", [0, 1, 0], Package::Node), Err(ProbeError::Unavailable(_))));
    }

    #[test]
    fn signed_manifest_binds_the_exact_bytes_git_commit_and_installer() {
        let signer = Ed25519KeyPair::from_seed_unchecked(&[5; 32]).unwrap();
        let key = signer.public_key().as_ref();
        let commit = "a".repeat(40);
        let tag = "reach-v0.1.1";
        let mut manifest = json!({
            "schema": 1, "tag": tag, "version": "0.1.1", "commit": commit,
            "platform": "windows-x64", "installer": INSTALLER, "size": 1024,
            "sha256": "b".repeat(64),
        });
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let signature = signer.sign(&bytes);
        let package = Package::Node;
        assert!(verify_manifest(key, &bytes, signature.as_ref(), tag, &commit, package).is_ok());
        assert!(verify_manifest(key, &bytes, signature.as_ref(), tag, &"c".repeat(40), package).is_err());
        assert!(verify_manifest(key, &bytes, signature.as_ref(), "reach-v0.1.2", &commit, package).is_err());
        assert!(verify_manifest(&[0; 32], &bytes, signature.as_ref(), tag, &commit, package).is_err());

        manifest["installer"] = json!("subdirectory/setup.exe");
        let wrong_installer = serde_json::to_vec(&manifest).unwrap();
        assert!(verify_manifest(key, &wrong_installer, signature.as_ref(), tag, &commit, package).is_err());
        let signature = signer.sign(&wrong_installer);
        assert!(verify_manifest(key, &wrong_installer, signature.as_ref(), tag, &commit, package).is_err());
    }

    #[test]
    fn worker_agent_channel_requires_the_signed_full_package() {
        let signer = Ed25519KeyPair::from_seed_unchecked(&[6; 32]).unwrap();
        let key = signer.public_key().as_ref();
        let commit = "a".repeat(40);
        let tag = "reach-worker-agent-v0.2.0";
        let package = Package::WorkerAgent;
        let mut manifest = json!({
            "schema": 2, "tag": tag, "version": "0.2.0", "commit": commit, "platform": "windows-x64",
            "installer": WORKER_AGENT_INSTALLER, "size": 1024, "sha256": "b".repeat(64), "agent_sha256": "c".repeat(64),
        });
        let verify = |manifest: &Value, package| {
            let bytes = serde_json::to_vec(manifest).unwrap();
            let signature = signer.sign(&bytes);
            verify_manifest(key, &bytes, signature.as_ref(), tag, &commit, package)
        };
        assert!(verify(&manifest, package).is_ok());
        assert!(verify(&manifest, Package::Node).is_err());
        manifest["installer"] = json!(INSTALLER);
        assert!(verify(&manifest, package).is_err());
        manifest["installer"] = json!(WORKER_AGENT_INSTALLER);
        manifest.as_object_mut().unwrap().remove("agent_sha256");
        assert!(verify(&manifest, package).is_err());
    }

    #[test]
    fn release_assets_are_restricted_to_known_https_hosts() {
        let allows = |source: Source, url| source.allows(&Url::parse(url).unwrap());
        assert!(allows(Source::Github, "https://release-assets.githubusercontent.com/a"));
        assert!(allows(Source::Gitee, "https://foruda.gitee.com/attach_file/a/setup.exe"));
        assert!(!allows(Source::Github, "https://gitee.com/"));
        assert!(!allows(Source::Github, "https://github.com.invalid/"));
        assert!(!allows(Source::Gitee, "http://gitee.com/"));
        assert!(!allows(Source::Gitee, "https://name@gitee.com/"));
        assert!(!allows(Source::Gitee, "https://gitee.com:8080/"));
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
