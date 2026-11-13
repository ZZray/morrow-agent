// Copyright (c) Ray Zhang. Arm process containment before sending worker input.
use anyhow::{ensure, Result};

#[cfg(windows)]
pub struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Job {
    fn create(name: Option<&str>) -> Result<Self> {
        use windows_sys::Win32::{
            Foundation::{GetLastError, SetLastError, ERROR_ALREADY_EXISTS},
            System::JobObjects::*,
        };
        let wide = if let Some(name) = name {
            ensure!(
                name.starts_with("Global\\RY.Reach.Agent.")
                    && name.len() < 160
                    && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"\\.-".contains(&c)),
                "invalid recoverable job name"
            );
            Some(name.encode_utf16().chain([0]).collect::<Vec<_>>())
        } else {
            None
        };
        unsafe {
            SetLastError(0);
            let handle = CreateJobObjectW(std::ptr::null(), wide.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()));
            ensure!(!handle.is_null(), "cannot create worker job: {}", std::io::Error::last_os_error());
            let existing = GetLastError() == ERROR_ALREADY_EXISTS;
            let job = Self(handle);
            ensure!(!existing, "recoverable job identity is already owned");
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            ensure!(
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as _,
                    std::mem::size_of_val(&limits) as u32
                ) != 0,
                "cannot configure worker job"
            );
            Ok(job)
        }
    }
    pub fn assign_named(child: &tokio::process::Child, name: &str) -> Result<Self> {
        let job = Self::create(Some(name))?;
        let process = child.raw_handle().ok_or_else(|| anyhow::anyhow!("worker has no process handle"))?;
        ensure!(
            unsafe { windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(job.0, process as _) } != 0,
            "cannot contain recoverable worker: {}",
            std::io::Error::last_os_error()
        );
        Ok(job)
    }
    pub fn observe_named(name: &str) -> Result<Option<u32>> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND},
            System::JobObjects::*,
        };
        ensure!(
            name.starts_with("Global\\RY.Reach.Agent.")
                && name.len() < 160
                && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"\\.-".contains(&c)),
            "invalid original job name"
        );
        let wide = name.encode_utf16().chain([0]).collect::<Vec<_>>();
        unsafe {
            // WinNT JOB_OBJECT_QUERY access right; no terminate/assign permission is requested.
            let handle = OpenJobObjectW(0x0004, 0, wide.as_ptr());
            if handle.is_null() {
                let error = GetLastError();
                ensure!(error == ERROR_FILE_NOT_FOUND, "cannot observe original job: OS error {error}");
                return Ok(None);
            }
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                handle,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            );
            let error = std::io::Error::last_os_error();
            CloseHandle(handle);
            ensure!(ok != 0, "cannot query original job: {error}");
            Ok(Some(info.ActiveProcesses))
        }
    }
    pub fn assign(child: &tokio::process::Child) -> Result<Self> {
        let process = child.raw_handle().ok_or_else(|| anyhow::anyhow!("worker has no process handle"))?;
        // The child remains owned by the caller for the duration of this call.
        unsafe { Self::assign_handle(process as _) }
    }
    /// # Safety
    /// `process` must be a live owned process handle with PROCESS_SET_QUOTA and PROCESS_TERMINATE.
    pub unsafe fn assign_handle(process: windows_sys::Win32::Foundation::HANDLE) -> Result<Self> {
        unsafe {
            let job = Self::create(None)?;
            ensure!(
                windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(job.0, process) != 0,
                "cannot contain worker: {}",
                std::io::Error::last_os_error()
            );
            Ok(job)
        }
    }
    pub fn terminate(&self) -> Result<()> {
        ensure!(
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1) } != 0,
            "worker tree termination failed"
        );
        Ok(())
    }
    pub fn empty(&self) -> Result<bool> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            ensure!(
                QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut()
                ) != 0,
                "cannot query worker job"
            );
            Ok(info.ActiveProcesses == 0)
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(unix)]
pub struct Job(i32);
#[cfg(unix)]
impl Job {
    pub fn assign_named(child: &tokio::process::Child, _name: &str) -> Result<Self> {
        Self::assign(child)
    }
    pub fn assign(child: &tokio::process::Child) -> Result<Self> {
        Ok(Self(child.id().ok_or_else(|| anyhow::anyhow!("no child id"))? as i32))
    }
    pub fn terminate(&self) -> Result<()> {
        let result = unsafe { libc::kill(-self.0, libc::SIGKILL) };
        ensure!(
            result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH),
            "cannot terminate worker group"
        );
        Ok(())
    }
    pub fn empty(&self) -> Result<bool> {
        Ok(unsafe { libc::kill(-self.0, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH))
    }
}
#[cfg(unix)]
impl Drop for Job {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}
