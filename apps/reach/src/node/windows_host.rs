// Copyright (c) Ray Zhang. Windows service and authenticated local control transport.
use crate::{
    control::{self, Command, Control, Request},
    ledger::Ledger,
    pairing, runtime,
};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::{c_void, OsStr},
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    path::{Path, PathBuf},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
        Arc, OnceLock,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, ServerOptions},
    sync::{mpsc, oneshot},
    task::JoinSet,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Pipes::*, Services::*},
};

pub const SERVICE_NAME: &str = "RYReach";
const SERVICE_PIPE: &str = r"\\.\pipe\RY.Reach.Control.v1";
const MAX_FRAME: usize = 16_384;

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
pub fn current_sid() -> Result<String> {
    crate::windows_identity::current_sid()
}
fn validate_sid(sid: &str) -> Result<()> {
    ensure!(
        sid.starts_with("S-1-") && sid.len() < 184 && sid.chars().all(|c| c.is_ascii_digit() || c == 'S' || c == '-'),
        "invalid binding owner SID"
    );
    Ok(())
}

struct Descriptor(PSECURITY_DESCRIPTOR);
impl Descriptor {
    fn new(sddl: &str) -> Result<Self> {
        let mut value = ptr::null_mut();
        ensure!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(sddl).as_ptr(),
                    1,
                    &mut value,
                    ptr::null_mut(),
                )
            } != 0,
            "invalid Windows security descriptor: {}",
            std::io::Error::last_os_error()
        );
        Ok(Self(value))
    }
}
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub fn validate_state_path(root: &Path) -> Result<()> {
    let absolute = std::path::absolute(root)?;
    for path in absolute.ancestors() {
        let attributes = unsafe { GetFileAttributesW(wide(path).as_ptr()) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            let error = std::io::Error::last_os_error();
            ensure!(matches!(error.raw_os_error(), Some(2 | 3)), "cannot inspect Reach state path: {error}");
            continue;
        }
        ensure!(attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0, "Reach state path must not traverse a reparse point");
    }
    Ok(())
}
// Exact DACL replaces any pre-existing explicit grants as well as inheritance.
pub fn protect_state(root: &Path) -> Result<()> {
    validate_state_path(root)?;
    let sid = current_sid()?;
    let descriptor = Descriptor::new(&format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{sid})"))?;
    let (mut present, mut defaulted, mut dacl) = (0, 0, ptr::null_mut());
    ensure!(
        unsafe { GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut dacl, &mut defaulted) } != 0
            && present != 0,
        "state DACL missing"
    );
    let mut paths = vec![root.to_owned()];
    for name in
        ["node.sqlite", "node.sqlite-wal", "node.sqlite-shm", "reach.lock", "control-owner.json", "control-owner.tmp"]
    {
        let path = root.join(name);
        if path.exists() {
            validate_state_path(&path)?;
            paths.push(path);
        }
    }
    for path in paths {
        let status = unsafe {
            SetNamedSecurityInfoW(
                wide(&path).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                ptr::null_mut(),
                ptr::null_mut(),
                dacl,
                ptr::null_mut(),
            )
        };
        ensure!(
            status == 0,
            "cannot protect Reach state directory: {}",
            std::io::Error::from_raw_os_error(status as i32)
        );
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    pid: u32,
    pipe: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireRequest {
    version: u32,
    id: String,
    command: Command,
}

fn listener(name: &str, owner: &str, creator: &str, first: bool) -> Result<NamedPipeServer> {
    validate_sid(owner)?;
    validate_sid(creator)?;
    // Do not grant GENERIC_WRITE: it includes FILE_CREATE_PIPE_INSTANCE.
    let descriptor =
        Descriptor::new(&format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x12019b;;;{owner})(A;;0x4;;;{creator})"))?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    Ok(unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .max_instances(32)
            .create_with_security_attributes_raw(name, &mut attributes as *mut _ as _)
    }?)
}

async fn connection(
    mut pipe: NamedPipeServer,
    tx: mpsc::Sender<Request>,
    phase: Arc<AtomicU8>,
    stop: Arc<AtomicBool>,
    foreground: bool,
) -> Result<()> {
    let size = pipe.read_u32_le().await? as usize;
    ensure!((1..=MAX_FRAME).contains(&size), "invalid control frame size");
    let mut bytes = vec![0; size];
    pipe.read_exact(&mut bytes).await?;
    let request: WireRequest = serde_json::from_slice(&bytes)?;
    ensure!(request.version == 1 && !request.id.is_empty() && request.id.len() <= 64, "unsupported control request");
    let is_pair = matches!(request.command, Command::Pair(_) | Command::MaintenanceStop);
    let result = if is_pair
        && phase.compare_exchange(control::IDLE, control::PAIRING, Ordering::SeqCst, Ordering::SeqCst).is_err()
    {
        Err("Node is busy; pairing was not queued or applied".to_string())
    } else if matches!(request.command, Command::StopHost) {
        if foreground {
            stop.store(true, Ordering::SeqCst);
            phase.store(control::STOPPING, Ordering::SeqCst);
            Ok(json!({"stopRequested":true}))
        } else {
            Err("use Windows service control to stop the installed Node".to_string())
        }
    } else {
        let (reply, receive) = oneshot::channel();
        // Queue saturation rejects, rather than admitting unbounded future mutations.
        let admission = is_pair.then(|| control::PairAdmission(phase.clone()));
        match tx.try_send(Request { command: request.command, reply, _admission: admission }) {
            Ok(()) => receive.await.unwrap_or_else(|_| {
                Err("Node stopped before the request was applied; query original pairing status".into())
            }),
            Err(_) => {
                if is_pair {
                    let _ = phase.compare_exchange(control::PAIRING, control::IDLE, Ordering::SeqCst, Ordering::SeqCst);
                }
                Err("Node control queue is busy; request was not accepted".into())
            }
        }
    };
    let response = match result {
        Ok(value) => json!({"version":1,"id":request.id,"ok":true,"result":value}),
        Err(error) => json!({"version":1,"id":request.id,"ok":false,"error":error}),
    };
    let bytes = serde_json::to_vec(&response)?;
    ensure!(bytes.len() <= MAX_FRAME, "control response exceeds limit");
    pipe.write_u32_le(bytes.len() as u32).await?;
    pipe.write_all(&bytes).await?;
    // Keep the pipe instance alive until the peer confirms it read the reply.
    let _ = tokio::time::timeout(Duration::from_secs(2), pipe.read_u8()).await;
    Ok(())
}

pub async fn serve(root: PathBuf, owner_sid: String, stop: Arc<AtomicBool>, foreground: bool) -> Result<()> {
    let mut ledger = Ledger::open(&root)?;
    let pipe_name =
        if foreground { format!(r"\\.\pipe\RY.Reach.Dev.{}", uuid::Uuid::new_v4()) } else { SERVICE_PIPE.into() };
    let creator_sid = current_sid()?;
    let mut server = listener(&pipe_name, &owner_sid, &creator_sid, true)?;
    if foreground {
        let temporary = ledger.root.join("control-owner.tmp");
        std::fs::write(&temporary, serde_json::to_vec(&Owner { pid: std::process::id(), pipe: pipe_name.clone() })?)?;
        std::fs::rename(temporary, ledger.root.join("control-owner.json"))?;
    }
    let phase = Arc::new(AtomicU8::new(control::IDLE));
    let (tx, receiver) = mpsc::channel(16);
    let mut control = Control {
        receiver,
        stop: stop.clone(),
        phase: phase.clone(),
        foreground,
        desktop_owner: if foreground { None } else { Some(owner_sid.clone()) },
    };
    let listener_stop = stop.clone();
    let transport = tokio::task::spawn_local(async move {
        struct StopOnExit(Arc<AtomicBool>);
        impl Drop for StopOnExit {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let _guard = StopOnExit(listener_stop.clone());
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                result = server.connect(), if connections.len() < 16 => {
                    result?;
                    let next = listener(&pipe_name, &owner_sid, &creator_sid, false).context("cannot create successor control pipe")?;
                    let connected = std::mem::replace(&mut server, next);
                    let (tx, phase, stop) = (tx.clone(), phase.clone(), listener_stop.clone());
                    connections.spawn_local(async move { let _ = tokio::time::timeout(Duration::from_secs(35), connection(connected, tx, phase, stop, foreground)).await; });
                },
                _ = tokio::time::sleep(Duration::from_millis(100)) => { if listener_stop.load(Ordering::SeqCst) { break; } },
                _ = connections.join_next(), if !connections.is_empty() => {},
            }
        }
        let _ =
            tokio::time::timeout(Duration::from_secs(3), async { while connections.join_next().await.is_some() {} })
                .await;
        connections.abort_all();
        while connections.join_next().await.is_some() {}
        Ok::<_, anyhow::Error>(())
    });
    if !foreground {
        report_status(SERVICE_RUNNING, 0)?;
    }
    let outcome: Result<()> = async {
        while !control.stopping() {
            ensure!(!transport.is_finished(), "Windows control transport stopped");
            let identity = ledger.identity()?;
            let request = if identity.server.is_some() && identity.pending_pair.is_none() {
                match runtime::run_managed(&mut ledger, false, Some(&mut control)).await {
                    Ok(request) => request,
                    Err(error) => {
                        eprintln!("Node connection suspended: {error}");
                        // Retain the owner and IPC while the remote binding is unavailable.
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        control::idle(&ledger, &mut Some(&mut control))?
                    }
                }
            } else {
                tokio::select! {
                    request = control.receiver.recv() => match request { Some(request) => control.handle(&ledger, request, false)?, None => bail!("control transport closed") },
                    _ = tokio::time::sleep(Duration::from_millis(100)) => None,
                }
            };
            if let Some(request) = request {
                control.set_phase(control::PAIRING);
                // The runtime has joined the old uploader before returning any mutation.
                let result = if control.stopping() { Err(anyhow::anyhow!("Node is stopping; request was not applied")) } else {
                    match request.command {
                        Command::Pair(input) => pairing::pair(&mut ledger, input).await,
                        Command::MaintenanceStop => maintenance_stop(&ledger, &control).await,
                        _ => Err(anyhow::anyhow!("unexpected host mutation")),
                    }
                };
                let _ = request.reply.send(result.map_err(|e|e.to_string()));
                if !control.stopping() { control.set_phase(control::IDLE); }
            }
        }
        Ok(())
    }.await;
    stop.store(true, Ordering::SeqCst);
    control.set_phase(control::STOPPING);
    // Normal shutdown retains the ledger until both execution and transport settle.
    let transport_result = transport.await?;
    outcome.and(transport_result)
}

async fn maintenance_stop(ledger: &Ledger, control: &Control) -> Result<Value> {
    let identity = ledger.identity()?;
    ensure!(identity.pending_pair.is_none(), "finish original pairing before maintenance");
    ensure!(
        !ledger.has_active_operations()? && ledger.next_event()?.is_none(),
        "settle original operations and receipts before maintenance"
    );
    if let Some(server) = &identity.server {
        let api = crate::api::Api::new(server, &identity.secret, identity.development)?;
        let pending = api.call(reqwest::Method::GET, "/api/v1/node/pending", None).await?;
        ensure!(
            pending["operations"].as_array().context("invalid pending response")?.is_empty(),
            "reconcile original remote operations before maintenance"
        );
    }
    let mut result = ledger.summary()?;
    result["maintenanceStopRequested"] = Value::Bool(true);
    control.stop.store(true, Ordering::SeqCst);
    control.set_phase(control::STOPPING);
    Ok(result)
}

fn service_pid() -> Result<u32> {
    unsafe {
        let manager = OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_CONNECT);
        ensure!(!manager.is_null(), "cannot query Windows service manager");
        let service = OpenServiceW(manager, wide(SERVICE_NAME).as_ptr(), SERVICE_QUERY_STATUS);
        CloseServiceHandle(manager);
        ensure!(!service.is_null(), "Reach service is not installed or cannot be queried");
        let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
        let mut size = 0;
        let result = QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            &mut status as *mut _ as _,
            std::mem::size_of_val(&status) as u32,
            &mut size,
        );
        CloseServiceHandle(service);
        ensure!(
            result != 0 && status.dwCurrentState == SERVICE_RUNNING && status.dwProcessId != 0,
            "Reach service is not running"
        );
        Ok(status.dwProcessId)
    }
}

pub async fn call(root: Option<&Path>, command: Command) -> Result<Value> {
    let owner = if let Some(root) = root {
        let owner: Owner = serde_json::from_slice(&std::fs::read(root.join("control-owner.json"))?)?;
        ensure!(
            owner.pipe.starts_with(r"\\.\pipe\RY.Reach.Dev.") && owner.pipe.len() < 128,
            "invalid foreground pipe descriptor"
        );
        owner
    } else {
        Owner { pid: service_pid()?, pipe: SERVICE_PIPE.into() }
    };
    let end = tokio::time::Instant::now() + Duration::from_secs(3);
    let handle = loop {
        // Only data permissions: no FILE_CREATE_PIPE_INSTANCE. Identification-only
        // SQOS prevents a hostile pipe server from using the caller's authority.
        let handle = unsafe {
            CreateFileW(
                wide(&owner.pipe).as_ptr(),
                FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | SYNCHRONIZE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                ptr::null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            break handle;
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_PIPE_BUSY as i32) || tokio::time::Instant::now() >= end {
            return Err(error.into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let mut pipe = unsafe { NamedPipeClient::from_raw_handle(handle as _) }?;
    let mut peer = 0;
    ensure!(
        unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as _, &mut peer) } != 0 && peer == owner.pid,
        "control pipe server identity mismatch; no request sent"
    );
    if root.is_none() {
        ensure!(service_pid()? == peer, "Reach service changed during connection; no request sent");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let bytes = serde_json::to_vec(&WireRequest { version: 1, id: id.clone(), command })?;
    ensure!(bytes.len() <= MAX_FRAME, "control request exceeds limit");
    tokio::time::timeout(Duration::from_secs(30), async {
        pipe.write_u32_le(bytes.len() as u32).await?;
        pipe.write_all(&bytes).await?;
        let size = pipe.read_u32_le().await? as usize;
        ensure!((1..=MAX_FRAME).contains(&size), "invalid control response size");
        let mut bytes = vec![0; size];
        pipe.read_exact(&mut bytes).await?;
        let response: Value = serde_json::from_slice(&bytes)?;
        ensure!(response["version"] == 1 && response["id"] == id, "control response identity mismatch");
        let _ = pipe.write_u8(1).await;
        ensure!(response["ok"] == true, "{}", response["error"].as_str().unwrap_or("control request failed"));
        Ok(response["result"].clone())
    })
    .await
    .context("control response unknown; retry original pairing input or query status")?
}

static SERVICE_CONFIG: OnceLock<(PathBuf, String, Arc<AtomicBool>)> = OnceLock::new();
static STATUS_HANDLE: AtomicUsize = AtomicUsize::new(0);
fn report_status(state: u32, exit_code: u32) -> Result<()> {
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING { SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN } else { 0 },
        dwWin32ExitCode: exit_code,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: if state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING { 1 } else { 0 },
        dwWaitHint: if state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING { 30_000 } else { 0 },
    };
    ensure!(
        unsafe { SetServiceStatus(STATUS_HANDLE.load(Ordering::SeqCst) as _, &status) } != 0,
        "cannot report Windows service status"
    );
    Ok(())
}
unsafe extern "system" fn service_control(event: u32, _: u32, _: *mut c_void, _: *mut c_void) -> u32 {
    if matches!(event, SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN) {
        if let Some((_, _, stop)) = SERVICE_CONFIG.get() {
            stop.store(true, Ordering::SeqCst);
        }
        let _ = report_status(SERVICE_STOP_PENDING, 0);
    }
    0
}
unsafe extern "system" fn service_main(_: u32, _: *mut *mut u16) {
    let handle =
        unsafe { RegisterServiceCtrlHandlerExW(wide(SERVICE_NAME).as_ptr(), Some(service_control), ptr::null()) };
    if handle.is_null() {
        return;
    }
    STATUS_HANDLE.store(handle as usize, Ordering::SeqCst);
    let _ = report_status(SERVICE_START_PENDING, 0);
    let result = std::panic::catch_unwind(|| -> Result<()> {
        let (root, owner, stop) = SERVICE_CONFIG.get().context("service configuration missing")?;
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        tokio::task::LocalSet::new().block_on(&runtime, serve(root.clone(), owner.clone(), stop.clone(), false))
    });
    let failed = !matches!(result, Ok(Ok(())));
    let _ = report_status(SERVICE_STOPPED, if failed { ERROR_EXCEPTION_IN_SERVICE } else { 0 });
}
pub fn dispatch(root: PathBuf, owner: String) -> Result<()> {
    validate_sid(&owner)?;
    SERVICE_CONFIG
        .set((root, owner, Arc::new(AtomicBool::new(false))))
        .map_err(|_| anyhow::anyhow!("service dispatcher already initialized"))?;
    let mut name = wide(SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW { lpServiceName: name.as_mut_ptr(), lpServiceProc: Some(service_main) },
        SERVICE_TABLE_ENTRYW { lpServiceName: ptr::null_mut(), lpServiceProc: None },
    ];
    ensure!(
        unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) } != 0,
        "cannot enter Windows service dispatcher: {}",
        std::io::Error::last_os_error()
    );
    Ok(())
}
