// Copyright (c) Ray Zhang. Persistent development desktop transport; no action replay.
use crate::{
    job::Job,
    ledger::Ledger,
    protocol::{self, Dispatch},
};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Child,
    sync::mpsc,
    task::JoinHandle,
    time::Instant,
};

const FRAME_MAX: usize = 16 * 1024 * 1024;
const CHUNK_BYTES: usize = 65_536;
const IMAGE_MAX: usize = 8_388_608;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    helper: PathBuf,
    python: PathBuf,
    config: PathBuf,
}
struct Connection {
    child: Process,
    stdin: Option<Box<dyn AsyncWrite + Unpin + Send>>,
    job: Job,
    frames: mpsc::Receiver<Result<Value>>,
    reader: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<()>>,
    #[cfg(windows)]
    pipe: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
    #[cfg(windows)]
    session: Option<crate::desktop_pipe::Identity>,
    ready: Value,
    started: Option<Value>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(task) = &self.reader {
            task.abort();
        }
        if let Some(task) = &self.stderr {
            task.abort();
        }
    }
}
pub struct Desktop {
    config: Option<Config>,
    connection: Option<Connection>,
    results: PathBuf,
    ledger_root: PathBuf,
    production_owner: Option<String>,
}
enum Process {
    Ordinary(Box<Child>),
    #[cfg(windows)]
    Interactive(crate::windows_desktop::Process),
}
impl Process {
    fn exited(&mut self) -> Result<bool> {
        match self {
            Self::Ordinary(child) => Ok(child.try_wait()?.is_some()),
            #[cfg(windows)]
            Self::Interactive(child) => child.exited(),
        }
    }
    async fn wait(&mut self) -> Result<()> {
        match self {
            Self::Ordinary(child) => {
                child.wait().await?;
                Ok(())
            }
            #[cfg(windows)]
            Self::Interactive(child) => child.wait().await,
        }
    }
    #[cfg(windows)]
    fn pid(&self) -> Result<u32> {
        match self {
            Self::Ordinary(child) => child.id().context("desktop child exited"),
            Self::Interactive(child) => Ok(child.pid),
        }
    }
    #[cfg(windows)]
    fn handle(&self) -> Result<windows_sys::Win32::Foundation::HANDLE> {
        match self {
            Self::Ordinary(child) => Ok(child.raw_handle().context("desktop child handle missing")? as _),
            Self::Interactive(child) => Ok(child.handle.0),
        }
    }
}
fn read_config(path: &Path) -> Result<Config> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(16_385).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 16_384, "desktop configuration is oversized");
    Ok(serde_json::from_slice(&bytes)?)
}
impl Desktop {
    pub fn new(development: bool, root: &Path, owner: Option<&str>) -> Result<Self> {
        let mut value = Self {
            config: None,
            connection: None,
            results: root.join("desktop-results"),
            ledger_root: root.to_owned(),
            production_owner: None,
        };
        // SYSTEM/service never loads the development stdin backend.
        if !cfg!(windows) {
            return Ok(value);
        }
        #[cfg(windows)]
        if crate::windows_identity::current_sid()? == "S-1-5-18" {
            if let Some(owner) = owner {
                let exe = std::env::current_exe()?;
                let package = exe.parent().context("missing Node package directory")?;
                let path = package.join("desktop-runtime.json");
                if path.exists() {
                    crate::windows_desktop::validate_runtime_tree(package)?;
                    let mut config = read_config(&path)?;
                    config.helper = crate::windows_desktop::packaged_path(package, &config.helper)?;
                    config.python = crate::windows_desktop::packaged_path(package, &config.python)?;
                    config.config = crate::windows_desktop::packaged_path(package, &config.config)?;
                    let home = config.python.parent().context("missing packaged Python home")?;
                    ensure!(
                        !home.join("pyvenv.cfg").exists(),
                        "production desktop requires embedded Python, not a venv"
                    );
                    let paths = std::fs::read_to_string(home.join("python314._pth"))?;
                    for line in paths.lines().map(str::trim).filter(|line| !line.is_empty() && !line.starts_with('#')) {
                        ensure!(
                            line == "."
                                || Path::new(line).components().all(|c| matches!(c, std::path::Component::Normal(_))),
                            "embedded Python path must stay in the package"
                        );
                        ensure!(
                            line != "import site" && home.join(line).exists(),
                            "unsupported embedded Python search path"
                        );
                    }
                    value.config = Some(config);
                    value.production_owner = Some(owner.into());
                }
            }
            return Ok(value);
        }
        if !development {
            return Ok(value);
        }
        if let Some(path) = std::env::var_os("REACH_DESKTOP_CONFIG") {
            let path = PathBuf::from(path);
            ensure!(path.is_absolute(), "REACH_DESKTOP_CONFIG must be absolute");
            let config = read_config(&path)?;
            for path in [&config.helper, &config.python, &config.config] {
                ensure!(path.is_absolute() && path.is_file(), "desktop runtime requires absolute existing files");
            }
            value.config = Some(config);
        }
        Ok(value)
    }
    pub fn capabilities(&self) -> Vec<&'static str> {
        let mut caps = protocol::CAPABILITIES.to_vec();
        caps.push("file.read.artifact");
        if self.config.is_some() {
            caps.extend_from_slice(protocol::DESKTOP_CAPABILITIES);
        }
        caps
    }
    pub fn retained(&self) -> bool {
        self.connection.as_ref().is_some_and(|connection| connection.started.is_some())
    }
    #[cfg(not(windows))]
    async fn spawn(&mut self) -> Result<()> {
        anyhow::bail!("interactive desktop requires Windows")
    }
    #[cfg(windows)]
    async fn spawn(&mut self) -> Result<()> {
        use crate::desktop_pipe;
        let config = self.config.as_ref().context("desktop runtime unavailable")?;
        let identity = match &self.production_owner {
            Some(owner) => crate::windows_desktop::select_session(owner)
                .map_err(|error| crate::windows_desktop::SessionUnavailable(error.to_string()))?,
            None => {
                unsafe { desktop_pipe::process_identity(windows_sys::Win32::System::Threading::GetCurrentProcess()) }?
            }
        };
        let results = if self.production_owner.is_some() {
            crate::windows_desktop::spool(&self.ledger_root, &identity)?
        } else {
            std::fs::create_dir_all(&self.results)?;
            self.results.clone()
        };
        let name = format!(r"\\.\pipe\RY.Reach.Desktop.{}", protocol::id());
        let pipe = desktop_pipe::server(&name, &identity.logon_sid)?;
        let mut args = vec![
            "--service-pipe".to_string(),
            name,
            "--parent-pid".into(),
            std::process::id().to_string(),
            "--python".into(),
            config.python.to_string_lossy().into_owned(),
            "--config".into(),
            config.config.to_string_lossy().into_owned(),
            "--results".into(),
            results.to_string_lossy().into_owned(),
        ];
        let (child, job, stderr) = if self.production_owner.is_some() {
            let child = crate::windows_desktop::launch(&config.helper, &args, &identity)?;
            let job = match unsafe { Job::assign_handle(child.handle.0) } {
                Ok(job) => job,
                Err(error) => {
                    child.abort_suspended()?;
                    return Err(error);
                }
            };
            let ready_to_resume = (|| {
                ensure!(
                    crate::windows_desktop::session_identity(identity.session_id)? == identity,
                    "Windows logon changed before resume"
                );
                child.resume()
            })();
            if let Err(error) = ready_to_resume {
                child.abort_suspended()?;
                return Err(error);
            }
            (Process::Interactive(child), job, None)
        } else {
            args.push("--development".into());
            let mut child = tokio::process::Command::new(&config.helper)
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .creation_flags(0x08000000)
                .spawn()?;
            let job = match Job::assign(&child) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err(error);
                }
            };
            let mut stderr = child.stderr.take().context("desktop stderr missing")?;
            let task = tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                while matches!(stderr.read(&mut buffer).await,Ok(n) if n>0) {}
            });
            (Process::Ordinary(Box::new(child)), job, Some(task))
        };
        // No await may occur between process creation/Job ownership and storing this owner.
        // The helper still waits for the authenticated pipe startup gate.
        let (_, frames) = mpsc::channel(1);
        self.connection = Some(Connection {
            child,
            stdin: None,
            job,
            frames,
            reader: None,
            stderr,
            pipe: Some(pipe),
            session: self.production_owner.as_ref().map(|_| identity.clone()),
            ready: Value::Null,
            started: None,
        });
        let connection = self.connection.as_mut().unwrap();
        let pipe = connection.pipe.as_mut().unwrap();
        pipe.connect().await?;
        unsafe { desktop_pipe::verify_client(pipe, connection.child.pid()?, connection.child.handle()?, &identity) }?;
        connection.validate_session()?;
        let pipe = connection.pipe.take().unwrap();
        let (reader, writer) = tokio::io::split(pipe);
        connection.install_io(reader, writer);
        connection.stdin.as_mut().unwrap().write_all(b"\n").await?;
        let ready = connection.next().await?;
        ensure!(
            ready["event"] == "desktop_host_ready" && ready["backendStarted"] == false,
            "invalid desktop ready frame"
        );
        uuid::Uuid::parse_str(ready["helperGeneration"].as_str().context("desktop generation missing")?)?;
        let expected = json!({"sessionId":identity.session_id,"userSid":identity.user_sid,"logonId":identity.logon_id,"windowStation":"WinSta0","desktop":"Default"});
        ensure!(ready["sessionRef"] == expected, "desktop ready logon mismatch");
        connection.validate_session()?;
        connection.ready = ready;
        Ok(())
    }
    pub async fn request(&mut self, dispatch: &Dispatch) -> Result<Value> {
        let describe = dispatch.command["kind"] == "desktop.describe";
        if self.config.is_none() {
            return Ok(json!({"status":"failed","reason":"desktop_unavailable","effectsMayHaveOccurred":false}));
        }
        let dead = match self.connection.as_mut() {
            Some(c) => c.child.exited()?,
            None => false,
        };
        if dead {
            self.shutdown().await?;
        }
        if describe {
            if self.connection.is_none() {
                if let Err(error) = self.spawn().await {
                    #[cfg(windows)]
                    if let Some(unavailable) = error.downcast_ref::<crate::windows_desktop::SessionUnavailable>() {
                        return Ok(
                            json!({"status":"failed","reason":"desktop_session_unavailable","error":unavailable.to_string(),"effectsMayHaveOccurred":false}),
                        );
                    }
                    return Err(error);
                }
            }
            let connection = self.connection.as_mut().unwrap();
            if connection.started.is_none() {
                connection.send(json!({"id":dispatch.dispatch_id,"method":"start","helperGeneration":connection.ready["helperGeneration"],"sessionRef":connection.ready["sessionRef"]})).await?;
                let reply = connection.reply(&dispatch.dispatch_id).await?;
                ensure!(
                    reply["status"] == "succeeded"
                        && reply["tools"].is_array()
                        && reply["helperGeneration"] == connection.ready["helperGeneration"]
                        && reply["sessionRef"] == connection.ready["sessionRef"],
                    "invalid desktop start response"
                );
                connection.started = Some(reply);
            }
            connection.validate_session()?;
            let mut reply = connection.started.clone().unwrap();
            reply["id"] = json!(dispatch.dispatch_id);
            reply["helperPid"] = connection.ready["pid"].clone();
            reply["displays"] = connection.ready["displays"].clone();
            return Ok(reply);
        }
        let Some(connection) = self.connection.as_mut() else {
            return Ok(
                json!({"status":"failed","reason":"desktop_generation_unavailable","effectsMayHaveOccurred":false}),
            );
        };
        if connection.started.is_none()
            || dispatch.command["helperGeneration"] != connection.ready["helperGeneration"]
            || dispatch.command["sessionRef"] != connection.ready["sessionRef"]
        {
            return Ok(json!({"status":"failed","reason":"desktop_identity_mismatch","effectsMayHaveOccurred":false}));
        }
        let arguments: Value =
            serde_json::from_str(dispatch.command["argumentsJson"].as_str().context("desktop arguments missing")?)?;
        ensure!(arguments.is_object(), "desktop arguments must be an object");
        connection.send(json!({"id":dispatch.dispatch_id,"method":"call","tool":dispatch.command["tool"],"arguments":arguments,
            "helperGeneration":dispatch.command["helperGeneration"],"sessionRef":dispatch.command["sessionRef"],"snapshotId":dispatch.command["snapshotId"]})).await?;
        let reply = connection.reply(&dispatch.dispatch_id).await?;
        validate_reply_identity(&reply, &connection.ready)?;
        Ok(reply)
    }
    pub async fn shutdown(&mut self) -> Result<()> {
        let Some(mut connection) = self.connection.take() else {
            return Ok(());
        };
        // A duplex pipe has one shared OS handle: writer drop alone does not send EOF.
        if let Some(writer) = connection.stdin.as_mut() {
            if !connection.ready.is_null() {
                let request = json!({"id":protocol::id(),"method":"stop","helperGeneration":connection.ready["helperGeneration"],"sessionRef":connection.ready["sessionRef"]});
                let mut bytes = serde_json::to_vec(&request)?;
                bytes.push(b'\n');
                let _ = tokio::time::timeout(Duration::from_millis(250), writer.write_all(&bytes)).await;
            }
        }
        drop(connection.stdin.take());
        #[cfg(windows)]
        drop(connection.pipe.take());
        if let Some(reader) = connection.reader.take() {
            reader.abort();
            let _ = reader.await;
        }
        // Both split halves have now been released. Job/process settlement is independent.
        // EOF asks the helper to stop. Continue draining bounded frames so its exit cannot deadlock.
        let deadline = tokio::time::sleep(Duration::from_secs(3));
        tokio::pin!(deadline);
        tokio::select! { _ = &mut deadline => {}, _ = connection.child.wait() => {} }
        let terminated = connection.job.terminate();
        let reaped = tokio::time::timeout(Duration::from_secs(5), connection.child.wait()).await;
        let end = Instant::now() + Duration::from_secs(5);
        while !connection.job.empty()? && Instant::now() < end {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        ensure!(
            terminated.is_ok() && matches!(reaped, Ok(Ok(_))) && connection.job.empty()?,
            "desktop process tree did not settle"
        );
        Ok(())
    }
}
impl Connection {
    fn install_io<R, W>(&mut self, stdout: R, stdin: W)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (tx, frames) = mpsc::channel(1);
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let result = read_frame(&mut reader).await;
                let failed = result.is_err();
                if tx.send(result).await.is_err() || failed {
                    break;
                }
            }
        });
        self.stdin = Some(Box::new(stdin));
        self.frames = frames;
        self.reader = Some(reader);
    }
    fn validate_session(&self) -> Result<()> {
        #[cfg(windows)]
        if let Some(expected) = &self.session {
            ensure!(
                crate::windows_desktop::session_identity(expected.session_id)? == *expected,
                "Windows logon changed; retire this desktop generation"
            );
        }
        Ok(())
    }
    async fn next(&mut self) -> Result<Value> {
        loop {
            self.validate_session()?;
            tokio::select! {
                value=self.frames.recv()=>{self.validate_session()?;return value.context("desktop reader exited")?;},
                _=tokio::time::sleep(Duration::from_millis(250))=>{},
            }
        }
    }
    async fn send(&mut self, value: Value) -> Result<()> {
        self.validate_session()?;
        let mut data = serde_json::to_vec(&value)?;
        ensure!(data.len() < 2_097_152, "desktop request too large");
        data.push(b'\n');
        self.stdin.as_mut().context("desktop stdin closed")?.write_all(&data).await?;
        Ok(())
    }
    async fn reply(&mut self, id: &str) -> Result<Value> {
        let reply = self.next().await?;
        ensure!(
            reply["id"] == id && reply.get("event").is_none(),
            "desktop response dispatch mismatch or helper exited"
        );
        ensure!(
            matches!(reply["status"].as_str(), Some("succeeded" | "failed" | "unknown")),
            "invalid desktop response status"
        );
        Ok(reply)
    }
}

async fn read_frame<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Result<Value> {
    let mut line = Vec::new();
    let n = reader.take((FRAME_MAX + 1) as u64).read_until(b'\n', &mut line).await?;
    ensure!(n > 0, "desktop transport closed");
    ensure!(n <= FRAME_MAX && line.last() == Some(&b'\n'), "invalid or oversized desktop frame");
    Ok(serde_json::from_slice(&line)?)
}

fn validate_reply_identity(reply: &Value, ready: &Value) -> Result<()> {
    if reply["status"] == "succeeded"
        || ["content", "images", "files", "artifacts"].iter().any(|key| !reply[*key].is_null())
    {
        ensure!(
            reply["helperGeneration"] == ready["helperGeneration"] && reply["sessionRef"] == ready["sessionRef"],
            "desktop response identity mismatch"
        );
    }
    Ok(())
}

pub fn persist_images(ledger: &mut Ledger, dispatch: &Dispatch, reply: &mut Value) -> Result<()> {
    let images = reply["images"].as_array().cloned().unwrap_or_default();
    let files = reply["files"].as_array().cloned().unwrap_or_default();
    let parts = reply["content"].as_array().cloned().unwrap_or_default();
    ensure!(images.len() <= 4 && files.len() <= 4 && parts.len() <= 1024, "desktop artifact count exceeds bound");
    ensure!(
        parts.iter().filter(|part| part["type"] == "image").count() == images.len(),
        "desktop image manifest mismatch"
    );
    ensure!(
        parts.iter().filter(|part| part["type"] == "artifact_source").count() == files.len(),
        "desktop text manifest mismatch"
    );
    let mut total = 0;
    let mut indexes = std::collections::HashSet::new();
    let mut prepared = Vec::new();
    // Validate the whole set before persisting any output.
    for info in images {
        let index = info["contentIndex"].as_u64().context("missing image index")? as usize;
        ensure!(indexes.insert(index), "duplicate image index");
        let part = parts.get(index).context("missing desktop image")?;
        ensure!(part["type"] == "image" && part["mimeType"] == "image/png", "unsupported desktop image");
        let encoded = part["data"].as_str().context("missing image bytes")?;
        ensure!(encoded.len() <= IMAGE_MAX.div_ceil(3) * 4, "encoded image exceeds bound");
        let bytes = STANDARD.decode(encoded)?;
        total += bytes.len();
        let width = info["width"].as_u64().context("missing image width")?;
        let height = info["height"].as_u64().context("missing image height")?;
        ensure!(
            !bytes.is_empty()
                && bytes.len() <= IMAGE_MAX
                && total <= 2 * IMAGE_MAX
                && width > 0
                && width <= 8192
                && height > 0
                && height <= 8192
                && width * height <= IMAGE_MAX as u64
                && info["bytes"] == bytes.len()
                && info["sha256"] == protocol::hash(&bytes)
                && STANDARD.encode(&bytes) == encoded,
            "desktop image integrity mismatch"
        );
        let id = protocol::id();
        let manifest = json!({"type":"artifact.manifest","version":1,"artifactId":id,"mimeType":"image/png",
            "byteLength":bytes.len(),"sha256":protocol::hash(&bytes),"width":width,"height":height,"contentIndex":index,
            "chunkBytes":CHUNK_BYTES,"chunkCount":bytes.len().div_ceil(CHUNK_BYTES)});
        prepared.push((index, manifest, bytes));
    }
    for info in files {
        let index = info["contentIndex"].as_u64().context("missing text index")? as usize;
        ensure!(indexes.insert(index), "duplicate artifact index");
        let part = parts.get(index).context("missing desktop text")?;
        ensure!(
            part["type"] == "artifact_source" && part["mimeType"] == "text/plain" && info["mimeType"] == "text/plain",
            "unsupported desktop text source"
        );
        let encoded = part["data"].as_str().context("missing text bytes")?;
        ensure!(encoded.len() <= IMAGE_MAX.div_ceil(3) * 4, "encoded text exceeds bound");
        let bytes = STANDARD.decode(encoded)?;
        let text = std::str::from_utf8(&bytes).context("artifact text is not UTF-8")?;
        total += bytes.len();
        ensure!(
            bytes.len() <= IMAGE_MAX
                && total <= 2 * IMAGE_MAX
                && info["bytes"] == bytes.len()
                && info["sha256"] == protocol::hash(&bytes)
                && STANDARD.encode(&bytes) == encoded
                && info["characterCount"].as_u64() == Some(text.chars().count() as u64),
            "desktop text integrity mismatch"
        );
        let manifest = json!({"type":"artifact.manifest","version":2,"artifactId":protocol::id(),"mimeType":"text/plain","encoding":"utf-8",
            "byteLength":bytes.len(),"sha256":protocol::hash(&bytes),"characterCount":text.chars().count(),"contentIndex":index,
            "chunkBytes":CHUNK_BYTES,"chunkCount":bytes.len().div_ceil(CHUNK_BYTES)});
        prepared.push((index, manifest, bytes));
    }
    prepared.sort_by_key(|(index, _, _)| *index);
    let mut terminal = reply.clone();
    let mut references = Vec::new();
    let mut image_references = Vec::new();
    for (index, manifest, _) in &prepared {
        let reference = json!({"type":"artifact","artifactId":manifest["artifactId"],"mimeType":manifest["mimeType"],"sha256":manifest["sha256"],"contentIndex":index});
        terminal["content"][*index] = reference.clone();
        if manifest["mimeType"] == "image/png" {
            image_references.push(reference.clone());
        }
        references.push(reference);
    }
    terminal["images"] = json!(image_references);
    terminal["artifacts"] = json!(references);
    if let Some(object) = terminal.as_object_mut() {
        object.remove("files");
    }
    // Check the final receipt BEFORE publishing any artifact; large labels or
    // structuredContent must not leave a partially accepted success response.
    ensure!(
        serde_json::to_vec(&terminal)?.len() <= 1_047_552,
        "desktop metadata exceeds receipt bound; local backend result retained"
    );
    for (_, manifest, bytes) in prepared {
        let id = &manifest["artifactId"];
        ledger.event(dispatch, "output", manifest.clone())?;
        for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
            ledger.event(dispatch, "output", json!({"type":"artifact.chunk","artifactId":id,"index":index,"dataBase64":STANDARD.encode(chunk),"sha256":protocol::hash(chunk)}))?;
        }
        ledger.event(dispatch, "output", json!({"type":"artifact.complete","artifactId":id}))?;
    }
    *reply = terminal;
    Ok(())
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    #[test]
    fn text_artifacts_preserve_bytes_and_reject_bad_sets_before_outbox_writes() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("work").join(format!("text-ledger-{}", protocol::id()));
        let mut ledger = Ledger::open(&root).unwrap();
        let dispatch = Dispatch {
            operation_id: protocol::id(),
            node_id: protocol::id(),
            epoch: 1,
            dispatch_id: protocol::id(),
            payload_hash: "a".repeat(64),
            created_at: 0,
            command: json!({"kind":"desktop.call"}),
        };
        ledger.accept(&dispatch).unwrap();
        ledger.event(&dispatch, "running", json!({})).unwrap();
        let text = format!("\u{feff}{}", "原文😀\r\n".repeat(20_000));
        let bytes = text.as_bytes();
        let source = json!({"type":"artifact_source","mimeType":"text/plain","data":STANDARD.encode(bytes)});
        let file = json!({"contentIndex":0,"mimeType":"text/plain","bytes":bytes.len(),"sha256":protocol::hash(bytes),"characterCount":text.chars().count()});
        let original =
            json!({"status":"unknown","effectsMayHaveOccurred":true,"content":[source],"files":[file],"images":[]});
        let ready = json!({"helperGeneration":protocol::id(),"sessionRef":{"sessionId":1}});
        for state in ["unknown", "failed"] {
            for field in ["helperGeneration", "sessionRef"] {
                let mut bad = original.clone();
                bad["status"] = json!(state);
                bad["helperGeneration"] = ready["helperGeneration"].clone();
                bad["sessionRef"] = ready["sessionRef"].clone();
                bad[field] = json!("different generation");
                assert!(validate_reply_identity(&bad, &ready).is_err());
                let count: u64 = ledger.db.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0)).unwrap();
                assert_eq!(count, 2);
            }
        }
        for mode in ["digest", "count", "metadata"] {
            let mut bad = original.clone();
            match mode {
                "digest" => bad["files"][0]["sha256"] = json!("0".repeat(64)),
                "count" => bad["files"][0]["characterCount"] = json!(1),
                _ => bad["details"] = json!("x".repeat(1_048_576)),
            }
            assert!(persist_images(&mut ledger, &dispatch, &mut bad).is_err());
            let count: u64 = ledger.db.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0)).unwrap();
            assert_eq!(count, 2);
        }
        let mut good = original;
        persist_images(&mut ledger, &dispatch, &mut good).unwrap();
        assert_eq!(good["status"], "unknown");
        assert_eq!(good["images"], json!([]));
        assert_eq!(good["artifacts"][0], good["content"][0]);
        let mut statement = ledger.db.prepare("SELECT event_json FROM outbox ORDER BY sequence").unwrap();
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let mut recovered = Vec::new();
        for row in rows {
            let event: Value = serde_json::from_str(&row).unwrap();
            if event["data"]["type"] == "artifact.chunk" {
                recovered.extend(STANDARD.decode(event["data"]["dataBase64"].as_str().unwrap()).unwrap());
            }
        }
        assert_eq!(recovered, bytes);
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn unavailable_wts_before_launch_is_failed_without_a_helper() {
        let root = std::env::temp_dir();
        let exe = std::env::current_exe().unwrap();
        let mut desktop = Desktop {
            config: Some(Config { helper: exe.clone(), python: exe.clone(), config: exe }),
            connection: None,
            results: root.clone(),
            ledger_root: root,
            production_owner: Some("S-1-5-21-0-0-0-999999".into()),
        };
        let dispatch = Dispatch {
            operation_id: protocol::id(),
            node_id: protocol::id(),
            epoch: 1,
            dispatch_id: protocol::id(),
            payload_hash: String::new(),
            created_at: 0,
            command: json!({"kind":"desktop.describe"}),
        };
        let reply = desktop.request(&dispatch).await.unwrap();
        assert_eq!(reply["status"], "failed");
        assert_eq!(reply["reason"], "desktop_session_unavailable");
        assert_eq!(reply["effectsMayHaveOccurred"], false);
        assert!(desktop.connection.is_none());
    }
    #[tokio::test]
    async fn bounded_reader_rejects_oversized_truncated_and_invalid_frames() {
        for bytes in [b"{\"id\":1}".as_slice(), b"\xff\n".as_slice()] {
            assert!(read_frame(&mut BufReader::new(bytes)).await.is_err());
        }
        let (mut sender, receiver) = tokio::io::duplex(1024);
        let producer = tokio::spawn(async move {
            let chunk = [b'x'; 65536];
            for _ in 0..258 {
                if sender.write_all(&chunk).await.is_err() {
                    break;
                }
            }
        });
        let mut reader = BufReader::new(receiver);
        assert!(read_frame(&mut reader).await.unwrap_err().to_string().contains("oversized"));
        drop(reader);
        producer.await.unwrap();
        assert_eq!(read_frame(&mut BufReader::new(b"{\"id\":1}\n".as_slice())).await.unwrap()["id"], 1);
    }
}
