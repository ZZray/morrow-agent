// Copyright (c) Ray Zhang. Interactive Host; Node owns identity and the operation ledger.
mod capture;
#[path = "../../src/desktop_pipe.rs"]
pub mod desktop_pipe;
#[path = "../../src/node/job.rs"]
mod job;
mod session;
mod supervise;
#[path = "../../src/windows_identity.rs"]
mod windows_identity;

use anyhow::{ensure, Context, Result};
use clap::Parser;
use morrow_agent_mcp::{McpConfig, McpOptions, McpSession, ServerConfig};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(author = "Ray Zhang")]
struct Cli {
    /// Ordinary-user developer transport only; not the production service entry.
    #[arg(long)]
    development: bool,
    /// Node arms its enclosing Job before releasing this startup gate.
    #[arg(long, hide = true)]
    parent_start: bool,
    #[arg(long, hide = true)]
    service_pipe: Option<String>,
    #[arg(long, hide = true)]
    parent_pid: Option<u32>,
    #[arg(long, hide = true)]
    worker: bool,
    #[arg(long)]
    python: PathBuf,
    #[arg(long)]
    config: PathBuf,
    #[arg(long)]
    results: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    tool: String,
    #[serde(default)]
    arguments: Value,
    helper_generation: String,
    session_ref: session::SessionRef,
    #[serde(default)]
    snapshot_id: String,
}

async fn send(value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    ensure!(bytes.len() < 16 * 1024 * 1024, "desktop reply exceeds transport bound");
    bytes.push(b'\n');
    let mut stdout = tokio::io::stdout();
    stdout.write_all(&bytes).await?;
    stdout.flush().await?;
    Ok(())
}

// Dedicated bounded reader observes cancellation/EOF without losing partial frames.
fn input() -> tokio::sync::mpsc::Receiver<Result<Request>> {
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        let mut reader = BufReader::new(tokio::io::stdin());
        loop {
            let mut line = Vec::new();
            let request = async {
                let n = (&mut reader).take(2_097_153).read_until(b'\n', &mut line).await?;
                if n == 0 {
                    return Ok(None);
                }
                ensure!(n <= 2_097_152 && line.last() == Some(&b'\n'), "invalid or oversized desktop frame");
                let request: Request = serde_json::from_slice(&line)?;
                ensure!(!request.id.is_empty() && request.id.len() <= 128, "invalid desktop request id");
                Ok(Some(request))
            }
            .await;
            match request {
                Ok(Some(request)) => {
                    if tx.send(Ok(request)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = tx.send(Err(error)).await;
                    break;
                }
            }
        }
    });
    rx
}

fn matches(request: &Request, generation: &str, identity: &session::SessionRef) -> bool {
    request.helper_generation == generation && request.session_ref == *identity
}

fn boolean(value: &Value, default: bool) -> bool {
    value.as_bool().or_else(|| value.as_str().map(|s| s.eq_ignore_ascii_case("true"))).unwrap_or(default)
}

fn main() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    let result = runtime.block_on(run());
    // Tokio's blocking stdin read cannot be cancelled. Do not let a reader
    // waiting for the next line keep a stopped helper alive indefinitely.
    runtime.shutdown_timeout(Duration::from_millis(100));
    result
}

async fn run() -> Result<()> {
    let cli = Cli::parse();
    ensure!(cli.development || cli.service_pipe.is_some(), "desktop Host requires authenticated service transport");
    ensure!(
        cli.python.is_absolute() && cli.config.is_absolute() && cli.results.is_absolute(),
        "desktop runtime paths must be absolute"
    );
    ensure!(cli.python.is_file() && cli.config.is_file(), "desktop runtime/config missing");
    if !cli.worker {
        if let Some(name) = &cli.service_pipe {
            ensure!(!cli.parent_start, "pipe transport does not use the stdin gate");
            let (mut pipe, _parent) =
                desktop_pipe::connect(name, cli.parent_pid.context("missing service parent PID")?, cli.development)
                    .await?;
            let mut gate = [0u8; 1];
            pipe.read_exact(&mut gate).await?;
            ensure!(gate == *b"\n", "invalid authenticated Node startup gate");
            if !cli.development {
                ensure!(
                    desktop_pipe::service_pid()? == cli.parent_pid.unwrap(),
                    "Reach service changed before desktop start"
                );
            }
            let (reader, writer) = tokio::io::split(pipe);
            return supervise::run_with(reader, writer, if cli.development { None } else { cli.parent_pid }).await;
        }
        if cli.parent_start {
            let mut gate = [0u8; 1];
            tokio::io::stdin().read_exact(&mut gate).await?;
            ensure!(gate == *b"\n", "invalid Node startup gate");
        }
        return supervise::run().await;
    }
    session::initialize_dpi()?;
    let identity = session::current()?;
    let generation = uuid::Uuid::new_v4().to_string();
    let mut requests = input();
    send(json!({"event":"desktop_host_ready","pid":std::process::id(),"sessionRef":identity,
        "displays":session::displays()?,"helperGeneration":generation,"backendStarted":false}))
    .await?;
    // Parent must arm its process Job before start. Production replaces stdin
    // with an authenticated named pipe and WTS process launch.
    let start = tokio::time::timeout(Duration::from_secs(30), requests.recv())
        .await?
        .context("desktop parent disconnected before start")??;
    ensure!(start.method == "start" && matches(&start, &generation, &identity), "desktop start identity mismatch");
    ensure!(session::current()? == identity, "Windows session changed before backend start");
    // Keep Python's writable temp/COM lock files in this helper generation's
    // spool. The installed runtime is immutable and shared by all generations.
    let temporary = cli.results.join("tmp").join(&generation);
    std::fs::create_dir_all(&temporary).context("cannot create desktop temporary directory")?;
    let runtime = ServerConfig::Stdio {
        command: cli.python.display().to_string(),
        args: vec![
            "-I".into(),
            "-B".into(),
            "-X".into(),
            "utf8".into(),
            "-m".into(),
            "windows_mcp".into(),
            "serve".into(),
            "--transport".into(),
            "stdio".into(),
            "--config".into(),
            cli.config.display().to_string(),
            "--no-control".into(),
        ],
        env: BTreeMap::from([
            ("ANONYMIZED_TELEMETRY".into(), "false".into()),
            ("POSTHOG_API_KEY".into(), String::new()),
            ("WINDOWS_MCP_WATCHDOG".into(), "off".into()),
            ("TEMP".into(), temporary.display().to_string()),
            ("TMP".into(), temporary.display().to_string()),
        ]),
    };
    let result_directory = cli.results.join("results").join(&generation);
    std::fs::create_dir_all(&result_directory)?;
    let result_directory = result_directory.canonicalize()?;
    let options = McpOptions {
        required: ["windows".into()].into(),
        startup_timeout: Duration::from_secs(60),
        call_timeout: Duration::from_secs(60),
        results_dir: Some(result_directory.clone()),
    };
    let backend = McpSession::connect(
        McpConfig { mcp_servers: [("windows".into(), runtime)].into() },
        options,
        CancellationToken::new(),
    )
    .await?;
    let mut final_response = None;
    let mut stop_response = None;
    let outcome: Result<()> = async {
        ensure!(session::current()? == identity, "Windows session changed during backend start");
        send(json!({"id":start.id,"status":"succeeded","helperGeneration":generation,"sessionRef":identity,
            "tools":backend.tools().iter().map(|tool| tool.schema()).collect::<Vec<_>>(),"excluded":backend.excluded()})).await?;
        let mut snapshot_id = String::new();
        let mut snapshot_displays = Vec::new();
        let mut labels_available = false;
        let mut seen = HashSet::from([start.id]);
        loop {
            let request = tokio::select! {
                request = requests.recv() => match request {Some(request) => request?, None => break},
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    ensure!(session::current()? == identity, "Windows desktop session changed while idle");
                    continue;
                }
            };
            if !matches(&request, &generation, &identity) {
                send(json!({"id":request.id,"status":"failed","reason":"desktop_identity_mismatch","effectsMayHaveOccurred":false})).await?;
                continue;
            }
            if request.method == "stop" {
                stop_response = Some(json!({"id":request.id,"status":"succeeded","stopping":true}));
                break;
            }
            ensure!(request.method == "call", "unsupported desktop method");
            let snapshot = ["Snapshot", "Screenshot"].contains(&request.tool.as_str());
            let uses_labels = request.arguments.get("label").is_some_and(|v| !v.is_null())
                || request.arguments.get("labels").is_some_and(|v| !v.is_null());
            let displays = session::displays()?;
            if !snapshot && (snapshot_id.is_empty() || request.snapshot_id != snapshot_id
                || displays != snapshot_displays || (uses_labels && !labels_available)) {
                send(json!({"id":request.id,"status":"failed","reason":"stale_desktop_snapshot","effectsMayHaveOccurred":false})).await?;
                continue;
            }
            ensure!(session::current()? == identity, "Windows desktop session changed before dispatch");
            let name = format!("mcp__windows__{}", request.tool);
            ensure!(backend.tools().iter().any(|tool| tool.schema().name == name), "desktop tool is unavailable");
            ensure!(seen.len() < 10000, "desktop helper dispatch limit reached");
            if !seen.insert(request.id.clone()) {
                send(json!({"id":request.id,"status":"failed","reason":"duplicate_dispatch_id","executedAgain":false})).await?;
                continue;
            }
            snapshot_id.clear();
            labels_available = false;
            let image_required = request.tool == "Screenshot" || (snapshot && boolean(&request.arguments["use_vision"], false));
            let ui_tree = request.tool == "Snapshot" && boolean(&request.arguments["use_ui_tree"], true);
            let cancel = CancellationToken::new();
            let call = backend.call_tool_with_evidence(&name, &request.id, request.arguments, cancel.clone());
            tokio::pin!(call);
            let mut interruption = None;
            let result = loop {
                tokio::select! {
                    biased;
                    next = requests.recv() => {
                        match next {
                            Some(Ok(next)) if matches(&next, &generation, &identity) && next.method == "stop" => {
                                stop_response = Some(json!({"id":next.id,"status":"succeeded","stopping":true}));
                                interruption = Some("desktop_stop_requested");
                            },
                            Some(Ok(next)) => {
                                send(json!({"id":next.id,"status":"failed","reason":"desktop_busy_or_identity_mismatch","effectsMayHaveOccurred":false})).await?;
                                continue;
                            },
                            _ => interruption = Some("desktop_parent_disconnected_or_invalid_frame"),
                        }
                        cancel.cancel();
                        break None;
                    },
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {
                        if session::current().as_ref().ok() != Some(&identity) || session::displays().as_ref().ok() != Some(&displays) {
                            cancel.cancel();
                            interruption = Some("desktop_session_or_display_changed");
                            break None;
                        }
                    },
                    result = &mut call => break Some(result),
                }
            };
            let mut state = if snapshot { "failed" } else { "unknown" };
            // A failed capture can also leave a synchronous backend thread alive.
            // Dispose this generation after any tool error, including read-only.
            let mut retire = interruption.is_some();
            let mut response = match result {
                Some(Ok(evidence)) => {
                    ensure!(evidence.server == "windows" && evidence.tool == request.tool && evidence.call_id == request.id,
                        "desktop MCP evidence identity mismatch");
                    let is_error = evidence.error.is_some();
                    let result = evidence.result;
                    let full = capture::full_content(&result, &result_directory);
                    let full_error = full.as_ref().err().map(ToString::to_string);
                    let mut parts = full.unwrap_or_else(|_| capture::content(&result));
                    let labels = if is_error { None } else { capture::labels(&parts) };
                    let backend_error = capture::backend_reported_error(&parts);
                    let images = capture::image_manifest(&parts, image_required && !is_error);
                    let files = if full_error.is_none() { capture::text_sources(&mut parts, result.details["full_result_path"].is_string()) } else { Ok(Vec::new()) };
                    let valid = !is_error && !(snapshot && backend_error) && images.is_ok() && files.is_ok() && full_error.is_none() && result.details["effects_unknown"] != true;
                    if valid { state = "succeeded"; } else { retire = true; }
                    let mut reply = json!({"id":request.id,"labels":labels,"content":parts,"details":result.details});
                    if let Some(error) = evidence.error { reply["error"] = json!(error); reply["backendIsError"] = json!(true); }
                    if let Some(error) = full_error { reply["evidenceError"] = json!(error); }
                    match files {
                        Ok(files) => reply["files"] = json!(files),
                        Err(error) => reply["evidenceError"] = json!(error.to_string()),
                    }
                    match images {
                        Ok(manifest) => reply["images"] = json!(manifest),
                        Err(error) => reply["error"] = json!(error.to_string()),
                    }
                    reply
                },
                Some(Err(error)) => { retire = true; json!({"id":request.id,"error":error.to_string()}) },
                None => json!({"id":request.id,"reason":interruption}),
            };
            let changed = session::current().as_ref().ok() != Some(&identity) || session::displays().as_ref().ok() != Some(&displays);
            if changed {
                state = if snapshot { "failed" } else { "unknown" };
                response["reason"] = json!("desktop_session_or_display_changed");
            } else if snapshot && state == "succeeded" {
                snapshot_id = uuid::Uuid::new_v4().to_string();
                snapshot_displays = displays.clone();
                labels_available = ui_tree && response["labels"].is_array();
            }
            response["status"] = json!(state);
            response["effectsMayHaveOccurred"] = json!(!snapshot && state != "succeeded");
            response["helperGeneration"] = json!(generation);
            response["snapshotId"] = json!(snapshot_id);
            response["labelsAvailable"] = json!(labels_available);
            response["sessionRef"] = serde_json::to_value(&identity)?;
            response["displays"] = json!(displays);
            // Shutdown precedes stop acknowledgement. A production parent must
            // additionally terminate/wait its enclosing Job before Node settlement.
            if retire || changed {
                final_response = Some(response);
                break;
            }
            send(response).await?;
        }
        Ok(())
    }.await;
    backend.shutdown().await;
    if let Some(response) = final_response {
        send(response).await?;
    }
    if let Some(response) = stop_response {
        send(response).await?;
    }
    outcome
}
