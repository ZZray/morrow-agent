// Copyright (c) Ray Zhang. SYSTEM selects and launches one explicit Windows logon.
use crate::desktop_pipe::{self, wide, Handle, Identity};
use anyhow::{ensure, Context, Result};
use std::{
    path::{Component, Path, PathBuf},
    ptr,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Environment::*, RemoteDesktop::*, Threading::*},
};

pub fn session_identity(session: u32) -> Result<Identity> {
    unsafe {
        let mut state = ptr::null_mut();
        let mut bytes = 0;
        ensure!(
            WTSQuerySessionInformationW(ptr::null_mut(), session, WTSConnectState, &mut state, &mut bytes) != 0,
            "cannot query desktop session"
        );
        let active = bytes >= 4 && *state.cast::<WTS_CONNECTSTATE_CLASS>() == WTSActive;
        WTSFreeMemory(state.cast());
        ensure!(active && session > 0, "desktop session is not active");
        let mut token = ptr::null_mut();
        ensure!(
            WTSQueryUserToken(session, &mut token) != 0,
            "cannot query interactive user token: {}",
            std::io::Error::last_os_error()
        );
        desktop_pipe::token_identity(Handle(token).0)
    }
}
// WinNT.h ACE_HEADER type tags.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
struct Environment(*mut std::ffi::c_void);
impl Drop for Environment {
    fn drop(&mut self) {
        unsafe {
            DestroyEnvironmentBlock(self.0);
        }
    }
}
#[derive(Debug)]
pub struct SessionUnavailable(pub String);
impl std::fmt::Display for SessionUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for SessionUnavailable {}
pub fn select_session(owner: &str) -> Result<Identity> {
    ensure!(crate::windows_identity::current_sid()? == "S-1-5-18", "WTS launch requires the SYSTEM service");
    unsafe {
        let mut sessions = ptr::null_mut();
        let mut count = 0;
        ensure!(
            WTSEnumerateSessionsW(ptr::null_mut(), 0, 1, &mut sessions, &mut count) != 0,
            "cannot enumerate desktop sessions"
        );
        let result = (|| {
            let mut candidates = Vec::new();
            for info in std::slice::from_raw_parts(sessions, count as usize) {
                if info.SessionId == 0 || info.State != WTSActive {
                    continue;
                }
                let identity = session_identity(info.SessionId)?;
                if identity.user_sid == owner {
                    candidates.push(identity);
                }
            }
            ensure!(
                candidates.len() == 1,
                "desktop unavailable: expected exactly one active logon for the installation binding owner"
            );
            Ok(candidates.remove(0))
        })();
        WTSFreeMemory(sessions.cast());
        result
    }
}
pub struct Process {
    pub handle: Handle,
    pub pid: u32,
    thread: Handle,
}
impl Process {
    pub fn resume(&self) -> Result<()> {
        ensure!(unsafe { ResumeThread(self.thread.0) } == 1, "cannot resume suspended desktop helper");
        Ok(())
    }
    pub fn exited(&self) -> Result<bool> {
        Ok(!unsafe { desktop_pipe::alive(self.handle.0) }?)
    }
    pub async fn wait(&mut self) -> Result<()> {
        while !self.exited()? {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Ok(())
    }
    pub fn abort_suspended(&self) -> Result<()> {
        if self.exited()? {
            return Ok(());
        }
        ensure!(unsafe { TerminateProcess(self.handle.0, 1) } != 0, "cannot terminate unstarted desktop process");
        ensure!(
            unsafe { WaitForSingleObject(self.handle.0, 5000) } == WAIT_OBJECT_0,
            "unstarted desktop process did not exit"
        );
        Ok(())
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        // Especially important before Job assignment: never orphan a suspended process.
        if !matches!(self.exited(), Ok(true)) {
            unsafe {
                TerminateProcess(self.handle.0, 1);
                WaitForSingleObject(self.handle.0, 5000);
            }
        }
    }
}
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            result.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            result.push_str(&"\\".repeat(slashes));
        }
        slashes = 0;
        result.push(c);
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}
pub fn launch(exe: &Path, args: &[String], identity: &Identity) -> Result<Process> {
    ensure!(session_identity(identity.session_id)? == *identity, "Windows logon changed before launch");
    unsafe {
        let mut token = ptr::null_mut();
        ensure!(WTSQueryUserToken(identity.session_id, &mut token) != 0, "cannot obtain user token");
        let token = Handle(token);
        ensure!(desktop_pipe::token_identity(token.0)? == *identity, "Windows logon changed during token acquisition");
        let mut environment = ptr::null_mut();
        ensure!(CreateEnvironmentBlock(&mut environment, token.0, 0) != 0, "cannot create desktop user environment");
        let environment = Environment(environment);
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of_val(&startup) as u32;
        let mut desktop = wide("WinSta0\\Default");
        startup.lpDesktop = desktop.as_mut_ptr();
        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        let command = std::iter::once(exe.to_string_lossy().to_string())
            .chain(args.iter().cloned())
            .map(|s| quote(&s))
            .collect::<Vec<_>>()
            .join(" ");
        ensure!(!command.contains('\0') && command.encode_utf16().count() < 32766, "invalid desktop command line");
        let mut command = wide(command);
        let ok = CreateProcessAsUserW(
            token.0,
            wide(exe).as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment.0,
            wide(exe.parent().context("missing desktop directory")?).as_ptr(),
            &startup,
            &mut process,
        );
        let error = std::io::Error::last_os_error();
        ensure!(ok != 0, "cannot launch desktop user process: {error}");
        Ok(Process { handle: Handle(process.hProcess), thread: Handle(process.hThread), pid: process.dwProcessId })
    }
}

fn trusted(sid: &str) -> bool {
    matches!(sid, "S-1-5-18" | "S-1-5-32-544" | "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464")
}
pub fn validate_protected(path: &Path, allow_child_creation: bool) -> Result<()> {
    crate::windows_host::validate_state_path(path)?;
    unsafe {
        let mut owner = ptr::null_mut();
        let mut dacl = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        let status = GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        );
        ensure!(status == 0, "cannot read protected runtime security: {status}");
        let result = (|| {
            ensure!(
                !owner.is_null() && trusted(&desktop_pipe::sid_text(owner)?),
                "runtime path has an untrusted owner"
            );
            ensure!(!dacl.is_null(), "runtime path has an unrestricted DACL");
            let mut mask = DELETE
                | WRITE_DAC
                | WRITE_OWNER
                | GENERIC_WRITE
                | GENERIC_ALL
                | FILE_DELETE_CHILD
                | FILE_WRITE_EA
                | FILE_WRITE_ATTRIBUTES;
            if !allow_child_creation {
                mask |= FILE_WRITE_DATA | FILE_APPEND_DATA;
            }
            for i in 0..(*dacl).AceCount as u32 {
                let mut raw = ptr::null_mut();
                ensure!(GetAce(dacl, i, &mut raw) != 0, "cannot read runtime ACE");
                let header = &*raw.cast::<ACE_HEADER>();
                if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 {
                    continue;
                }
                if header.AceType == ACCESS_DENIED_ACE_TYPE {
                    continue;
                }
                ensure!(header.AceType == ACCESS_ALLOWED_ACE_TYPE, "unsupported runtime access rule");
                let ace = &*raw.cast::<ACCESS_ALLOWED_ACE>();
                if ace.Mask & mask != 0 {
                    ensure!(
                        trusted(&desktop_pipe::sid_text(&ace.SidStart as *const _ as _)?),
                        "runtime path permits untrusted mutation"
                    );
                }
            }
            Ok(())
        })();
        LocalFree(descriptor);
        result
    }
}
pub fn validate_runtime_tree(root: &Path) -> Result<()> {
    for path in root.ancestors().skip(1) {
        validate_protected(path, true)?;
    }
    let mut pending = vec![root.to_owned()];
    while let Some(path) = pending.pop() {
        validate_protected(&path, false)?;
        if path.is_dir() {
            for item in std::fs::read_dir(&path)? {
                pending.push(item?.path());
            }
        }
    }
    Ok(())
}
pub fn packaged_path(root: &Path, relative: &Path) -> Result<PathBuf> {
    ensure!(
        !relative.as_os_str().is_empty() && relative.components().all(|c| matches!(c, Component::Normal(_))),
        "desktop package paths must be relative and contained"
    );
    let path = root.join(relative);
    ensure!(path.is_file(), "desktop package component missing");
    Ok(path)
}
fn create_directory(path: &Path, sddl: &str) -> Result<()> {
    unsafe {
        let mut descriptor = ptr::null_mut();
        ensure!(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(sddl).as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut()
            ) != 0,
            "invalid spool security"
        );
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let result = CreateDirectoryW(wide(path).as_ptr(), &attributes);
        let error = std::io::Error::last_os_error();
        LocalFree(descriptor);
        ensure!(result != 0, "cannot create exclusive desktop spool: {error}");
        Ok(())
    }
}
pub fn spool(ledger: &Path, identity: &Identity) -> Result<PathBuf> {
    let parent = ledger.parent().context("missing protected product parent")?;
    validate_protected(parent, false)?;
    let root = parent.join("ReachDesktop");
    if root.exists() {
        validate_protected(&root, false)?;
    } else {
        create_directory(&root, "O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")?;
    }
    let path = root.join(uuid::Uuid::new_v4().to_string());
    create_directory(
        &path,
        &format!("O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{})", identity.logon_sid),
    )?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_command_line_and_package_paths_are_contained() {
        assert_eq!(quote("a\\b\"c\\"), "\"a\\b\\\"c\\\\\"");
        assert!(packaged_path(Path::new("C:\\safe"), Path::new("..\\outside.exe")).is_err());
        assert!(packaged_path(Path::new("C:\\safe"), Path::new("C:\\outside.exe")).is_err());
    }
}
