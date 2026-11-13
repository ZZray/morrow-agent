// Copyright (c) Ray Zhang. Receives input only after containment is armed.
use crate::protocol::hash;
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

// Only time spent waiting for command pipe data counts as a stalled drain.
// Sending a frame may block while the Node durably journals earlier output.
#[derive(Clone, Copy, Default)]
struct OutputDrain {
    reading_since: [Option<Instant>; 2],
}
impl OutputDrain {
    fn stalled(&self, finished: [bool; 2], exited: Instant, now: Instant) -> bool {
        let idle = Duration::from_secs(2);
        now.duration_since(exited) >= idle
            && finished.iter().any(|done| !done)
            && finished
                .iter()
                .enumerate()
                .all(|(i, done)| *done || self.reading_since[i].is_some_and(|since| now.duration_since(since) >= idle))
    }
}

fn frame(value: &Value) -> Result<()> {
    let stdout = std::io::stdout();
    let mut stream = stdout.lock();
    serde_json::to_writer(&mut stream, value)?;
    writeln!(stream)?;
    stream.flush()?;
    Ok(())
}
pub fn run() -> Result<()> {
    let mut bytes = Vec::new();
    std::io::stdin().take(2_097_153).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 2_097_152, "worker input too large");
    let input: Value = serde_json::from_slice(&bytes)?;
    let command = &input["command"];
    let result = match command["kind"].as_str() {
        Some("command.run") => command_run(command),
        Some("file.read") => file_read(command),
        Some("file.write") => file_write(command),
        Some("directory.list") => directory_list(command),
        _ => bail!("unsupported worker operation"),
    };
    let output = match result {
        Ok(value) => value,
        Err(error) => {
            json!({"kind":"result","state":"failed","data":{"error":error.to_string(),"effectsMayHaveOccurred":true}})
        }
    };
    frame(&output)
}
fn success(data: Value) -> Value {
    json!({"kind":"result","state":"succeeded","data":data})
}
fn text<'a>(command: &'a Value, key: &str) -> Result<&'a str> {
    command[key].as_str().with_context(|| format!("missing {key}"))
}

fn command_run(input: &Value) -> Result<Value> {
    let command = text(input, "command")?;
    ensure!(command.len() <= 262144, "command exceeds protocol limit");
    #[cfg(windows)]
    let mut process = {
        let mut p = Command::new("powershell.exe");
        p.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]);
        p
    };
    #[cfg(unix)]
    let mut process = {
        let mut p = Command::new("/bin/sh");
        p.args(["-c", command]);
        p
    };
    if let Some(cwd) = input["cwd"].as_str() {
        process.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x08000000);
    }
    let mut child = process
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not start command")?;
    frame(&json!({"kind":"output","data":{"processStarted":true,"pid":child.id()}}))?;
    let total = Arc::new(Mutex::new(0usize));
    let drain = Arc::new(Mutex::new(OutputDrain::default()));
    let stdout = child.stdout.take().context("no command stdout")?;
    let stderr = child.stderr.take().context("no command stderr")?;
    let reader = |mut pipe: Box<dyn Read + Send>, stream: &'static str, index: usize, total: Arc<Mutex<usize>>| {
        let drain = drain.clone();
        std::thread::spawn(move || -> Result<()> {
            let mut bytes = [0u8; 8192];
            loop {
                drain.lock().map_err(|_| anyhow::anyhow!("output drain state unavailable"))?.reading_since[index] =
                    Some(Instant::now());
                let read = pipe.read(&mut bytes);
                drain.lock().map_err(|_| anyhow::anyhow!("output drain state unavailable"))?.reading_since[index] =
                    None;
                let n = read?;
                if n == 0 {
                    return Ok(());
                }
                let mut size = total.lock().map_err(|_| anyhow::anyhow!("output accounting unavailable"))?;
                *size += n;
                if *size > 16 * 1024 * 1024 {
                    frame(&json!({"kind":"limit","data":{"reason":"output_exceeds_16MiB"}}))?;
                    return Ok(());
                }
                frame(&json!({"kind":"output","data":{"stream":stream,"base64":STANDARD.encode(&bytes[..n])}}))?;
            }
        })
    };
    let out = reader(Box::new(stdout), "stdout", 0, total.clone());
    let err = reader(Box::new(stderr), "stderr", 1, total);
    let status = child.wait()?;
    let exited = Instant::now();
    loop {
        let finished = [out.is_finished(), err.is_finished()];
        if finished.iter().all(|done| *done) {
            break;
        }
        // A descendant can retain an idle pipe. A reader sending already-read
        // bytes is not evidence of that condition. Node's operation deadline,
        // cancellation and enclosing Job still bound a blocked sender.
        let phase = *drain.lock().map_err(|_| anyhow::anyhow!("output drain state unavailable"))?;
        if phase.stalled(finished, exited, Instant::now()) && (!out.is_finished() || !err.is_finished()) {
            return Ok(
                json!({"kind":"result","state":"unknown","data":{"reason":"output_drain_stalled","exitCode":status.code(),"pid":child.id(),"outputComplete":false,"effectsMayHaveOccurred":true}}),
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    out.join().map_err(|_| anyhow::anyhow!("stdout reader panicked"))??;
    err.join().map_err(|_| anyhow::anyhow!("stderr reader panicked"))??;
    Ok(
        json!({"kind":"result","state":if status.success(){"succeeded"}else{"failed"},"data":{"exitCode":status.code(),"pid":child.id()}}),
    )
}
fn file_read(input: &Value) -> Result<Value> {
    let path = text(input, "path")?;
    let artifact = input["resultFormat"] == "artifact";
    ensure!(input["resultFormat"].is_null() || artifact, "unsupported file read representation");
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Keep the same source object and exclude writers while capturing a range.
        options.share_mode(1);
    }
    let mut file = options.open(path)?;
    let before = file.metadata()?;
    ensure!(before.is_file(), "path is not a regular file");
    let version = file_version(&file)?;
    if let Some(expected) = input["expectedFileVersion"].as_str() {
        ensure!(expected == version, "file version changed; no bytes captured");
    }
    let offset = input["offset"].as_u64().unwrap_or(0);
    let length = input["length"].as_u64().unwrap_or(65536);
    ensure!((1..=1_048_576).contains(&length), "invalid read length");
    if artifact {
        ensure!(offset <= before.len(), "artifact range starts past the source file");
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file).take(length).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(before.len() == after.len() && version == file_version(&file)?, "file changed during read");
    let next_offset = offset.checked_add(bytes.len() as u64).context("file offset overflow")?;
    let captured = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis();
    let mut data = json!({"path":path,"offset":offset,"length":bytes.len(),"totalBytes":after.len(),"sha256":hash(&bytes),"nextOffset":next_offset,"eof":next_offset>=after.len(),
        "fileVersion":version,"versionPolicy":"opened_file_identity_size_and_change_times","capturedAt":captured,"workingDirectory":std::env::current_dir()?.to_string_lossy()});
    if artifact {
        let id = crate::protocol::id();
        let reference = json!({"type":"artifact","artifactId":id,"mimeType":"application/octet-stream","sha256":hash(&bytes),"contentIndex":0});
        data["resultFormat"] = json!("artifact");
        data["content"] = json!([reference.clone()]);
        data["artifacts"] = json!([reference]);
        // The artifact is this immutable byte range, not a claim to contain the whole source file.
        data["artifactScope"] = json!("file_byte_range");
        let terminal = success(data.clone());
        ensure!(serde_json::to_vec(&terminal)?.len() <= 1_900_000, "file source metadata exceeds receipt bound");
        let mut provenance = data;
        provenance.as_object_mut().unwrap().remove("content");
        provenance.as_object_mut().unwrap().remove("artifacts");
        provenance["type"] = json!("file.capture");
        provenance["artifactId"] = json!(id);
        // Source identity survives a crash after complete but before terminal.
        frame(&json!({"kind":"output","data":provenance}))?;
        frame(
            &json!({"kind":"output","data":{"type":"artifact.manifest","version":2,"artifactId":id,"mimeType":"application/octet-stream",
            "byteLength":bytes.len(),"sha256":hash(&bytes),"contentIndex":0,"chunkBytes":65536,"chunkCount":bytes.len().div_ceil(65536)}}),
        )?;
        for (index, chunk) in bytes.chunks(65536).enumerate() {
            frame(
                &json!({"kind":"output","data":{"type":"artifact.chunk","artifactId":id,"index":index,"dataBase64":STANDARD.encode(chunk),"sha256":hash(chunk)}}),
            )?;
        }
        frame(&json!({"kind":"output","data":{"type":"artifact.complete","artifactId":id}}))?;
        return Ok(terminal);
    } else {
        data["contentBase64"] = json!(STANDARD.encode(&bytes));
    }
    Ok(success(data))
}

// A conservative source-version precondition for consecutive reads. This is not
// a whole-file content hash or protection from a privileged timestamp forgery.
fn file_version(file: &File) -> Result<String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx, BY_HANDLE_FILE_INFORMATION,
            FILE_BASIC_INFO,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        let handle = file.as_raw_handle() as _;
        ensure!(unsafe { GetFileInformationByHandle(handle, &mut info) } != 0, "cannot identify source file");
        ensure!(
            unsafe {
                GetFileInformationByHandleEx(
                    handle,
                    FileBasicInfo,
                    &mut basic as *mut _ as _,
                    std::mem::size_of_val(&basic) as u32,
                )
            } != 0,
            "cannot inspect source file change times"
        );
        Ok(hash(&serde_json::to_vec(&json!({"version":1,"platform":"windows","volume":info.dwVolumeSerialNumber,
            "idHigh":info.nFileIndexHigh,"idLow":info.nFileIndexLow,"bytesHigh":info.nFileSizeHigh,"bytesLow":info.nFileSizeLow,
            "created":basic.CreationTime,"modified":basic.LastWriteTime,"changed":basic.ChangeTime}))?))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let info = file.metadata()?;
        Ok(hash(&serde_json::to_vec(
            &json!({"version":1,"platform":"unix","device":info.dev(),"inode":info.ino(),"bytes":info.len(),
            "modifiedSeconds":info.mtime(),"modifiedNanos":info.mtime_nsec(),"changedSeconds":info.ctime(),"changedNanos":info.ctime_nsec()}),
        )?))
    }
}
fn file_write(input: &Value) -> Result<Value> {
    let path = Path::new(text(input, "path")?);
    let bytes = STANDARD.decode(text(input, "contentBase64")?).context("invalid base64")?;
    ensure!(bytes.len() <= 1_048_576, "write exceeds 1 MiB");
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    // Existing handles, ACLs, attributes and hard links remain attached to the
    // same file. Windows excludes concurrent writers and path replacement.
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let (mut file, created) = match options.open(path) {
        Ok(file) => (file, false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && input["expectedSha256"].is_null() => {
            (options.create_new(true).open(path)?, true)
        }
        Err(error) => return Err(error.into()),
    };
    ensure!(file.metadata()?.is_file(), "path is not a regular file");
    if let Some(expected) = input["expectedSha256"].as_str() {
        ensure!(handle_hash(&mut file)? == expected, "file hash precondition changed; no write committed");
    }
    let candidate = hash(&bytes);
    let commit: Result<()> = (|| {
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&bytes)?;
        file.set_len(bytes.len() as u64)?;
        file.sync_all()?;
        ensure!(handle_hash(&mut file)? == candidate, "written handle readback mismatch");
        // Opening for read must share the existing write handle on Windows.
        ensure!(handle_hash(&mut File::open(path)?)? == candidate, "path readback mismatch");
        Ok(())
    })();
    if let Err(error) = commit {
        return Ok(
            json!({"kind":"result","state":"unknown","data":{"reason":"write_commit_or_readback_failed","error":error.to_string(),"path":path,"candidateSha256":candidate,"effectsMayHaveOccurred":true}}),
        );
    }
    Ok(success(
        json!({"path":path,"bytes":bytes.len(),"sha256":candidate,"created":created,"verification":"same_handle_and_path_readback","commitPolicy":"in_place; interruption_may_leave_partial_effects","concurrency":"handle_recheck_not_filesystem_CAS"}),
    ))
}
fn handle_hash(file: &mut File) -> Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn directory_list(input: &Value) -> Result<Value> {
    let path = text(input, "path")?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(path)? {
        if entries.len() >= 1000 {
            truncated = true;
            break;
        }
        let entry = entry?;
        let metadata = entry.metadata()?;
        entries.push(
            json!({"name":entry.file_name().to_string_lossy(),"directory":metadata.is_dir(),"bytes":metadata.len()}),
        );
    }
    Ok(success(json!({"path":path,"entries":entries,"truncated":truncated,"limit":1000})))
}
