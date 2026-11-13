// Copyright (c) Ray Zhang. Durable identities for observing the ORIGINAL sidecar containment after a crash.
use crate::{job::Job, protocol::Dispatch};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use windows_sys::Win32::{Foundation::*, System::Threading::*};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub creation_time: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub version: u32,
    pub task_id: String,
    pub execution_id: String,
    pub dispatch_id: String,
    pub payload_hash: String,
    pub node_id: String,
    pub epoch: u64,
    pub sidecar_sha256: String,
    pub boot_id: String,
    pub host: ProcessIdentity,
    pub sidecar: ProcessIdentity,
    pub job_name: String,
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

// BootIdentifier is generated for this OS boot. Fail closed when the OS cannot
// provide it; a copied state directory must not turn foreign PIDs into exit proof.
pub fn boot_id() -> Result<String> {
    #[repr(C)]
    struct BootEnvironment {
        identifier: windows_sys::core::GUID,
        firmware_type: u32,
        flags: u64,
    }
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtQuerySystemInformation(
            class: u32,
            information: *mut core::ffi::c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
    }
    let mut information: BootEnvironment = unsafe { std::mem::zeroed() };
    let mut returned = 0;
    let status = unsafe {
        NtQuerySystemInformation(
            90,
            &mut information as *mut _ as _,
            std::mem::size_of_val(&information) as u32,
            &mut returned,
        )
    };
    ensure!(
        status >= 0 && returned as usize >= std::mem::size_of::<windows_sys::core::GUID>(),
        "cannot prove original Windows boot identity"
    );
    let g = information.identifier;
    ensure!(
        g.data1 != 0 || g.data2 != 0 || g.data3 != 0 || g.data4.iter().any(|v| *v != 0),
        "Windows boot identity is empty"
    );
    Ok(format!(
        "{:08x}-{:04x}-{:04x}-{}",
        g.data1,
        g.data2,
        g.data3,
        g.data4.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
fn open(pid: u32) -> Result<Option<Handle>> {
    ensure!(pid > 0, "original process PID missing");
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        ensure!(error == ERROR_INVALID_PARAMETER, "cannot observe original process: OS error {error}");
        Ok(None)
    } else {
        Ok(Some(Handle(handle)))
    }
}
fn creation(handle: &Handle) -> Result<String> {
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exited = created;
    let mut kernel = created;
    let mut user = created;
    ensure!(
        unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) } != 0,
        "cannot read original process creation time"
    );
    Ok(((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)).to_string())
}
fn identity(pid: u32) -> Result<ProcessIdentity> {
    let process = open(pid)?.context("original process disappeared before containment record")?;
    Ok(ProcessIdentity { pid, creation_time: creation(&process)? })
}
fn observe_process(expected: &ProcessIdentity) -> Result<Value> {
    let _: u64 = expected.creation_time.parse()?;
    let Some(process) = open(expected.pid)? else {
        return Ok(json!({"identity":expected,"observation":"not_found","originalAlive":false}));
    };
    let actual = creation(&process)?;
    if actual != expected.creation_time {
        return Ok(
            json!({"identity":expected,"observation":"pid_reused","observedCreationTime":actual,"originalAlive":false}),
        );
    }
    let status = unsafe { WaitForSingleObject(process.0, 0) };
    ensure!([WAIT_OBJECT_0, WAIT_TIMEOUT].contains(&status), "cannot query original process exit");
    Ok(
        json!({"identity":expected,"observation":if status==WAIT_OBJECT_0{"exited"}else{"alive"},"originalAlive":status==WAIT_TIMEOUT}),
    )
}
pub fn capture(
    root: &Dispatch,
    execution: &Dispatch,
    child: &tokio::process::Child,
    sha: &str,
    job_name: &str,
) -> Result<Owner> {
    ensure!(
        Job::observe_named(job_name)?.is_some_and(|count| count > 0),
        "new containment has no assigned original sidecar"
    );
    Ok(Owner {
        version: 1,
        task_id: root.operation_id.clone(),
        execution_id: execution.operation_id.clone(),
        dispatch_id: execution.dispatch_id.clone(),
        payload_hash: execution.payload_hash.clone(),
        node_id: execution.node_id.clone(),
        epoch: execution.epoch,
        sidecar_sha256: sha.into(),
        boot_id: boot_id()?,
        host: identity(std::process::id())?,
        sidecar: identity(child.id().context("sidecar PID missing")?)?,
        job_name: job_name.into(),
    })
}
pub fn observe(owner: &Owner) -> Result<Value> {
    ensure!(owner.version == 1 && owner.boot_id == boot_id()?, "original sidecar belongs to another OS boot");
    let host = observe_process(&owner.host)?;
    let sidecar = observe_process(&owner.sidecar)?;
    let job = Job::observe_named(&owner.job_name)?;
    Ok(
        json!({"version":1,"kind":"original_containment_observation","bootId":owner.boot_id,"host":host,"sidecar":sidecar,"job":match job{Some(active)=>json!({"observation":"queried","activeProcesses":active}),None=>json!({"observation":"not_found","osError":ERROR_FILE_NOT_FOUND})}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boot_and_process_times_are_stable_and_lossless() -> Result<()> {
        ensure!(boot_id()? == boot_id()?, "boot identity drifted");
        let own = identity(std::process::id())?;
        ensure!(observe_process(&own)?["originalAlive"] == true, "live process declared exited");
        let raw = serde_json::to_value(&own)?;
        ensure!(raw["creationTime"].is_string(), "FILETIME must not round through a JS number");
        let mut reused = own.clone();
        reused.creation_time = "1".into();
        ensure!(
            observe_process(&reused)?["observation"] == "pid_reused",
            "PID reuse was confused with original liveness"
        );
        Ok(())
    }
    #[tokio::test]
    async fn named_job_collision_and_real_exit_are_observable() -> Result<()> {
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(0x08000000)
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let name = format!("Global\\RY.Reach.Agent.{}.{}", crate::protocol::id(), crate::protocol::id());
        let job = Job::assign_named(&child, &name)?;
        ensure!(Job::observe_named(&name)?.is_some_and(|n| n > 0), "original sidecar was not observed alive");
        let own = identity(child.id().context("child PID missing")?)?;
        // A second assignment cannot join the existing containment under the same identity.
        ensure!(Job::assign_named(&child, &name).is_err(), "job collision was accepted");
        ensure!(observe_process(&own)?["originalAlive"] == true, "collision killed the original process");
        job.terminate()?;
        child.wait().await?;
        ensure!(job.empty()? && observe_process(&own)?["originalAlive"] == false, "original worker did not exit");
        drop(job);
        ensure!(Job::observe_named(&name)?.is_none(), "retired job name did not disappear");
        Ok(())
    }
    #[tokio::test]
    async fn an_exited_parent_does_not_hide_a_live_descendant_in_the_original_job() -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let evidence = std::env::var_os("REACH_PROCESS_EVIDENCE_ROOT")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("reach-original-job-{}", crate::protocol::id()));
        std::fs::create_dir_all(&evidence)?;
        let pid_path = evidence.join("descendant-pid.txt");
        let script=format!("$null=[Console]::ReadLine(); $s=[Diagnostics.ProcessStartInfo]::new('powershell.exe'); $s.Arguments='-NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 30\"'; $s.UseShellExecute=$false; $s.CreateNoWindow=$true; $p=[Diagnostics.Process]::Start($s); [IO.File]::WriteAllText('{}',[string]$p.Id)",pid_path.to_string_lossy().replace('\'',"''"));
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x08000000)
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let name = format!("Global\\RY.Reach.Agent.{}.{}", crate::protocol::id(), crate::protocol::id());
        let job = Job::assign_named(&child, &name)?;
        let parent = identity(child.id().context("original parent PID missing")?)?;
        child.stdin.take().context("fixture stdin missing")?.write_all(b"go\n").await?;
        let status = child.wait().await?;
        ensure!(status.success(), "descendant fixture could not start");
        let descendant = identity(std::fs::read_to_string(&pid_path)?.trim().parse()?)?;
        let parent_state = observe_process(&parent)?;
        let descendant_state = observe_process(&descendant)?;
        let active = Job::observe_named(&name)?;
        ensure!(
            parent_state["originalAlive"] == false
                && descendant_state["originalAlive"] == true
                && active.is_some_and(|count| count > 0),
            "parent exit was confused with containment exit"
        );
        std::fs::write(
            evidence.join("before-termination.json"),
            serde_json::to_vec(
                &json!({"scope":"actual child and descendant OS Job, no native Task","bootId":boot_id()?,"jobName":name,"parent":parent_state,"descendant":descendant_state,"activeProcesses":active}),
            )?,
        )?;
        job.terminate()?;
        let end = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while (!job.empty()? || observe_process(&descendant)?["originalAlive"] == true)
            && tokio::time::Instant::now() < end
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        ensure!(
            job.empty()? && observe_process(&descendant)?["originalAlive"] == false,
            "original descendant did not exit"
        );
        drop(job);
        ensure!(Job::observe_named(&name)?.is_none(), "retired containment still exists");
        std::fs::write(
            evidence.join("after-termination.json"),
            serde_json::to_vec(
                &json!({"parent":observe_process(&parent)?,"descendant":observe_process(&descendant)?,"jobObservation":"not_found"}),
            )?,
        )?;
        Ok(())
    }
}
