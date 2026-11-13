// Copyright (c) Ray Zhang. Local-only desktop transport shared by Node and helper.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    ptr,
    time::Duration,
};
use tokio::net::windows::named_pipe::{NamedPipeClient, NamedPipeServer, ServerOptions};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Pipes::*, Services::*, Threading::*},
};
// WinNT.h: the high two group-attribute bits identify the logon SID.
const SE_GROUP_LOGON_ID: u32 = 0xc000_0000;

pub fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
pub struct Handle(pub HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
/// # Safety
/// `sid` must point to a valid SID for the duration of the call.
pub unsafe fn sid_text(sid: PSID) -> Result<String> {
    unsafe {
        let mut text = ptr::null_mut();
        ensure!(ConvertSidToStringSidW(sid, &mut text) != 0, "cannot format Windows SID");
        let mut len = 0;
        while *text.add(len) != 0 {
            len += 1;
        }
        let result = String::from_utf16(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        Ok(result?)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub user_sid: String,
    pub logon_sid: String,
    pub session_id: u32,
    pub logon_id: String,
}
/// # Safety
/// The caller holds a valid token handle with TOKEN_QUERY access.
pub unsafe fn token_identity(token: HANDLE) -> Result<Identity> {
    unsafe {
        let read = |class| -> Result<Vec<usize>> {
            let mut size = 0;
            GetTokenInformation(token, class, ptr::null_mut(), 0, &mut size);
            ensure!(size > 0 && size <= 65536, "invalid token information size");
            let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
            ensure!(
                GetTokenInformation(token, class, buffer.as_mut_ptr().cast(), size, &mut size) != 0,
                "cannot read token identity"
            );
            Ok(buffer)
        };
        let (user, groups, stats, session) =
            (read(TokenUser)?, read(TokenLogonSid)?, read(TokenStatistics)?, read(TokenSessionId)?);
        let groups = &*groups.as_ptr().cast::<TOKEN_GROUPS>();
        ensure!(
            groups.GroupCount == 1 && groups.Groups[0].Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID,
            "missing unique Windows logon SID"
        );
        let stats = &*stats.as_ptr().cast::<TOKEN_STATISTICS>();
        Ok(Identity {
            user_sid: sid_text((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid)?,
            logon_sid: sid_text(groups.Groups[0].Sid)?,
            session_id: *session.as_ptr().cast::<u32>(),
            logon_id: format!("{:08x}:{:08x}", stats.AuthenticationId.HighPart as u32, stats.AuthenticationId.LowPart),
        })
    }
}
/// # Safety
/// The caller holds a valid process handle with query access.
pub unsafe fn process_identity(process: HANDLE) -> Result<Identity> {
    unsafe {
        let mut token = ptr::null_mut();
        ensure!(OpenProcessToken(process, TOKEN_QUERY, &mut token) != 0, "cannot query desktop peer token");
        token_identity(Handle(token).0)
    }
}
pub fn process(pid: u32) -> Result<Handle> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) };
    ensure!(!handle.is_null(), "cannot hold desktop peer process");
    Ok(Handle(handle))
}
/// # Safety
/// The caller holds a valid process handle with SYNCHRONIZE access.
pub unsafe fn alive(process: HANDLE) -> Result<bool> {
    let status = unsafe { WaitForSingleObject(process, 0) };
    ensure!(status == WAIT_OBJECT_0 || status == WAIT_TIMEOUT, "cannot observe desktop peer process");
    Ok(status == WAIT_TIMEOUT)
}
pub fn validate_name(name: &str) -> Result<()> {
    let suffix = name.strip_prefix(r"\\.\pipe\RY.Reach.Desktop.").context("invalid desktop pipe prefix")?;
    uuid::Uuid::parse_str(suffix)?;
    Ok(())
}
pub fn server(name: &str, logon_sid: &str) -> Result<NamedPipeServer> {
    validate_name(name)?;
    ensure!(
        logon_sid.starts_with("S-1-5-5-")
            && logon_sid.len() < 184
            && logon_sid.chars().all(|v| v == 'S' || v == '-' || v.is_ascii_digit()),
        "invalid desktop logon SID"
    );
    unsafe {
        // Only this logon can transfer data. FILE_CREATE_PIPE_INSTANCE (0x4) stays with SYSTEM.
        let mut descriptor = ptr::null_mut();
        ensure!(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(format!("D:P(A;;GA;;;SY)(A;;0x12019b;;;{logon_sid})")).as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut()
            ) != 0,
            "cannot create desktop pipe DACL"
        );
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let result = ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .max_instances(1)
            .create_with_security_attributes_raw(name, &mut attributes as *mut _ as _);
        LocalFree(descriptor);
        Ok(result?)
    }
}
/// # Safety
/// `held_process` is the still-owned process handle returned by launch.
pub unsafe fn verify_client(
    pipe: &NamedPipeServer,
    expected_pid: u32,
    held_process: HANDLE,
    expected: &Identity,
) -> Result<()> {
    let (mut pid, mut session) = (0, 0);
    ensure!(
        unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle() as _, &mut pid) } != 0
            && pid == expected_pid
            && unsafe { GetNamedPipeClientSessionId(pipe.as_raw_handle() as _, &mut session) } != 0
            && session == expected.session_id
            && alive(held_process)?
            && process_identity(held_process)? == *expected,
        "desktop client identity mismatch"
    );
    Ok(())
}
pub fn service_pid() -> Result<u32> {
    unsafe {
        let manager = OpenSCManagerW(ptr::null(), ptr::null(), SC_MANAGER_CONNECT);
        ensure!(!manager.is_null(), "cannot query SCM");
        let service = OpenServiceW(manager, wide("RYReach").as_ptr(), SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG);
        CloseServiceHandle(manager);
        ensure!(!service.is_null(), "Reach SYSTEM service unavailable");
        let result = (|| {
            let mut status: SERVICE_STATUS_PROCESS = std::mem::zeroed();
            let mut size = 0;
            ensure!(
                QueryServiceStatusEx(
                    service,
                    SC_STATUS_PROCESS_INFO,
                    &mut status as *mut _ as _,
                    std::mem::size_of_val(&status) as u32,
                    &mut size
                ) != 0
                    && status.dwCurrentState == SERVICE_RUNNING
                    && status.dwProcessId > 0,
                "Reach service is not running"
            );
            QueryServiceConfigW(service, ptr::null_mut(), 0, &mut size);
            ensure!(size > 0 && size <= 65536, "invalid Reach service configuration");
            let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
            ensure!(
                QueryServiceConfigW(service, buffer.as_mut_ptr().cast(), size, &mut size) != 0,
                "cannot query Reach service account"
            );
            let config = &*buffer.as_ptr().cast::<QUERY_SERVICE_CONFIGW>();
            ensure!(
                config.dwServiceType == SERVICE_WIN32_OWN_PROCESS && !config.lpServiceStartName.is_null(),
                "unexpected Reach service type"
            );
            let mut len = 0;
            while *config.lpServiceStartName.add(len) != 0 {
                len += 1;
                ensure!(len < 256, "invalid service account");
            }
            let account = String::from_utf16(std::slice::from_raw_parts(config.lpServiceStartName, len))?;
            ensure!(account.eq_ignore_ascii_case("LocalSystem"), "Reach service is not LocalSystem");
            Ok(status.dwProcessId)
        })();
        CloseServiceHandle(service);
        result
    }
}
pub async fn connect(name: &str, expected_pid: u32, development: bool) -> Result<(NamedPipeClient, Handle)> {
    validate_name(name)?;
    ensure!(expected_pid > 0, "missing desktop parent PID");
    let parent = process(expected_pid)?;
    ensure!(unsafe { alive(parent.0) }?, "desktop parent already exited");
    let expected = if development {
        Some(unsafe { process_identity(GetCurrentProcess()) }?)
    } else {
        ensure!(service_pid()? == expected_pid, "desktop parent is not the running Reach service");
        None
    };
    let end = tokio::time::Instant::now() + Duration::from_secs(5);
    let handle = loop {
        let handle = unsafe {
            CreateFileW(
                wide(name).as_ptr(),
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
        ensure!(
            error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && tokio::time::Instant::now() < end,
            "cannot connect desktop pipe: {error}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    let pipe = unsafe { NamedPipeClient::from_raw_handle(handle as _) }?;
    let mut peer = 0;
    ensure!(
        unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as _, &mut peer) } != 0
            && peer == expected_pid
            && unsafe { alive(parent.0) }?,
        "desktop server PID mismatch; no frame sent"
    );
    if let Some(expected) = expected {
        ensure!(unsafe { process_identity(parent.0) }? == expected, "development desktop parent logon mismatch");
    } else {
        ensure!(service_pid()? == peer, "Reach service changed during desktop authentication");
    }
    Ok((pipe, parent))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    fn name() -> String {
        format!(r"\\.\pipe\RY.Reach.Desktop.{}", uuid::Uuid::new_v4())
    }
    #[tokio::test]
    async fn actual_named_pipe_authenticates_logon_and_rejects_wrong_client_before_input() {
        let pid = std::process::id();
        let held = process(pid).unwrap();
        let identity = unsafe { process_identity(held.0) }.unwrap();
        let name = name();
        let mut server = server(&name, &identity.logon_sid).unwrap();
        let (accepted, client) = tokio::join!(server.connect(), connect(&name, pid, true));
        accepted.unwrap();
        let (mut client, _) = client.unwrap();
        assert!(unsafe { verify_client(&server, pid.wrapping_add(1), held.0, &identity) }.is_err());
        unsafe { verify_client(&server, pid, held.0, &identity) }.unwrap();
        client.write_all(b"authenticated").await.unwrap();
        let mut bytes = [0; 13];
        server.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"authenticated");
        drop(client);
        assert!(server.read_u8().await.is_err());
    }
    #[tokio::test]
    async fn wrong_server_pid_and_production_scm_mismatch_send_no_payload() {
        let held = process(std::process::id()).unwrap();
        let identity = unsafe { process_identity(held.0) }.unwrap();
        let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut other = tokio::process::Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 20"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x08000000)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let name = name();
        let mut server = server(&name, &identity.logon_sid).unwrap();
        let (accepted, rejected) = tokio::join!(server.connect(), connect(&name, other.id().unwrap(), true));
        accepted.unwrap();
        assert!(rejected.err().unwrap().to_string().contains("server PID mismatch"));
        assert!(server.read_u8().await.is_err());
        other.kill().await.unwrap();
        other.wait().await.unwrap();
        let result = connect(&name, std::process::id(), false).await;
        assert!(result.is_err(), "an ordinary test process must never authenticate as the SCM service");
    }
}
