#![windows_subsystem = "windows"]
// Copyright (c) Ray Zhang. Self-contained installer, no temporary script execution.
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Write,
    os::windows::{ffi::OsStrExt, process::CommandExt},
    process::{Command, Stdio},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::Threading::*,
    UI::{Shell::*, WindowsAndMessaging::*},
};
#[path = "../../../../src/windows_identity.rs"]
mod windows_identity;

const PAYLOAD: &[u8] = include_bytes!(env!("REACH_SETUP_NODE"));
const SCRIPT: &str = include_str!("../../install.ps1");
const PACKAGE_CHECKS: &str = include_str!("../../payload.ps1");
const OWNERSHIP: &str = include_str!("../../ownership.ps1");
const MAINTENANCE_WRITES: &str = include_str!("../../maintenance-writes.ps1");
const MAINTENANCE_ENTRY: &str = include_str!("../../maintenance-entry.ps1");
const UNINSTALL_FILES: &str = include_str!("../../uninstall-files.ps1");
const UNINSTALL_TRANSACTION: &str = include_str!("../../uninstall-transaction.ps1");
const UNINSTALL_HOST: &str = include_str!("../../uninstall-host.ps1");
const NOTICES: &[u8] = include_bytes!(env!("REACH_SETUP_NOTICES"));
fn maintenance_script() -> String {
    format!("{PACKAGE_CHECKS}\n{OWNERSHIP}\n{MAINTENANCE_WRITES}\n{MAINTENANCE_ENTRY}\n{UNINSTALL_FILES}\n{UNINSTALL_TRANSACTION}\n{UNINSTALL_HOST}\n{SCRIPT}\n")
}
fn recovery_script() -> String {
    format!("$MaintenanceOperation='uninstall'\n{}", maintenance_script())
}
fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
fn administrator() -> Result<bool> {
    unsafe {
        let mut sid = ptr::null_mut();
        let authority = SID_IDENTIFIER_AUTHORITY { Value: [0, 0, 0, 0, 0, 5] };
        ensure!(
            AllocateAndInitializeSid(&authority, 2, 32, 544, 0, 0, 0, 0, 0, 0, &mut sid) != 0,
            "cannot identify administrator token"
        );
        let mut member = 0;
        let ok = CheckTokenMembership(ptr::null_mut(), sid, &mut member);
        FreeSid(sid);
        ensure!(ok != 0, "cannot inspect administrator token");
        Ok(member != 0)
    }
}
fn system_directory() -> Result<std::path::PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let size = unsafe {
        windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32)
    } as usize;
    ensure!(size > 0 && size < buffer.len(), "cannot locate Windows system directory");
    Ok(String::from_utf16(&buffer[..size])?.into())
}
fn elevate(owner: &str, uninstall: bool) -> Result<()> {
    let path = wide(std::env::current_exe()?);
    let verb = wide("runas");
    let args = wide(format!("--elevated --owner {owner}{}", if uninstall { " --uninstall" } else { "" }));
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of_val(&info) as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = path.as_ptr();
        info.lpParameters = args.as_ptr();
        info.nShow = SW_HIDE;
        ensure!(
            ShellExecuteExW(&mut info) != 0,
            "Windows elevation was not completed: {}",
            std::io::Error::last_os_error()
        );
        ensure!(!info.hProcess.is_null(), "elevated installer process missing");
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1;
        let ok = GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if ok != 0 && code == 2 {
            std::process::exit(2);
        } // Child already displayed the precise failure.
        ensure!(ok != 0 && code == 0, "elevated installation failed; inspect the Reach installation receipt");
    }
    Ok(())
}
fn run() -> Result<()> {
    let complete = env!("REACH_SETUP_KIND") == "complete";
    let digest = format!("{:x}", Sha256::digest(PAYLOAD));
    ensure!(digest == env!("REACH_SETUP_SHA"), "embedded payload integrity mismatch");
    ensure!(
        if complete { PAYLOAD.starts_with(b"PK") } else { PAYLOAD.starts_with(b"MZ") },
        "embedded payload format mismatch"
    );
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--inspect"] {
        println!(
            "Reach setup {}\nnode_sha256={}\nscript_sha256={}\npayload_bytes={}\nnotices_sha256={}\npayload_sha256={}\npayload_manifest_sha256={}\npayload_checks_sha256={}\ndesktop_bundled={}\nownership_sha256={}\nmaintenance_writes_sha256={}",
            env!("CARGO_PKG_VERSION"),
            env!("REACH_SETUP_COMPONENT_NODE_SHA"),
            format_args!("{:x}", Sha256::digest(SCRIPT.as_bytes())),
            PAYLOAD.len(),
            format_args!("{:x}",Sha256::digest(NOTICES)),
            digest,
            env!("REACH_SETUP_MANIFEST_SHA"),
            format_args!("{:x}",Sha256::digest(PACKAGE_CHECKS.as_bytes())),
            complete,
            format_args!("{:x}",Sha256::digest(OWNERSHIP.as_bytes())),
            format_args!("{:x}",Sha256::digest(MAINTENANCE_WRITES.as_bytes()))
        );
        for (name, source) in [
            ("maintenance_entry", MAINTENANCE_ENTRY),
            ("uninstall_files", UNINSTALL_FILES),
            ("uninstall_transaction", UNINSTALL_TRANSACTION),
            ("uninstall_host", UNINSTALL_HOST),
            ("recovery_script", recovery_script().as_str()),
        ] {
            println!("{name}_sha256={:x}", Sha256::digest(source.as_bytes()));
        }
        println!("agent_bundled={complete}\nagent_sha256={}", env!("REACH_SETUP_AGENT_SHA"));
        return Ok(());
    }
    if args == ["--verify-payload"] {
        ensure!(complete, "payload verification requires the complete package");
        let script = format!(
            "$ErrorActionPreference='Stop'\n{PACKAGE_CHECKS}\ntry {{\nAdd-Type -AssemblyName System.IO.Compression\n$bytes=[Convert]::FromBase64String('{}')\n$stream=[IO.MemoryStream]::new($bytes,$false)\nif((ReachHashStream $stream $bytes.Length)-cne'{digest}'){{throw 'Payload changed in transit'}}\n$stream.Position=0\n$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read,$true)\n$result=ReadReachPayload $zip\nif($result.manifest.schema-ne2 -or $result.manifest.agentBundled-ne$true -or $result.manifest.agentSha256-cne'{agent_sha}'){{throw 'Embedded Agent package identity mismatch'}}\n$manifestStream=[IO.MemoryStream]::new($result.manifestBytes,$false)\nif((ReachHashStream $manifestStream $result.manifestBytes.Length)-cne'{}'){{throw 'Manifest identity mismatch'}}\n[Console]::Out.WriteLine(('verified_files='+$result.declared.Count+'; bytes='+$result.totalBytes+'; powershell='+$PSVersionTable.PSVersion))\nexit 0\n}} catch {{[Console]::Error.WriteLine($_.Exception.Message);exit 1}}\n",
            STANDARD.encode(PAYLOAD), env!("REACH_SETUP_MANIFEST_SHA"), agent_sha=env!("REACH_SETUP_AGENT_SHA")
        );
        return run_powershell(&script);
    }
    let uninstall = args == ["--uninstall"] || (args.len() == 4 && args[3] == "--uninstall");
    let elevated = args.first().is_some_and(|arg| arg == "--elevated");
    let owner = if args.is_empty() || args == ["--uninstall"] {
        windows_identity::current_sid()?
    } else {
        ensure!(
            (args.len() == 3 || (args.len() == 4 && uninstall)) && elevated && args[1] == "--owner",
            "unsupported installer arguments"
        );
        args[2].clone()
    };
    ensure!(
        owner.starts_with("S-1-")
            && owner.len() < 184
            && owner.chars().all(|c| c.is_ascii_digit() || c == 'S' || c == '-'),
        "invalid binding owner"
    );
    if !administrator()? {
        ensure!(!elevated, "elevated maintenance requires an administrator token");
        return elevate(&owner, uninstall);
    }
    // The script is delivered over a private pipe, never loaded from a user-writable temporary file.
    let mut script = format!(
        "$MaintenanceOperation='{}'\n$RecoveryScriptBytes=[Convert]::FromBase64String('{}')\n$SetupExecutable=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}'))\n",
        if uninstall { "uninstall" } else { "install" }, STANDARD.encode(recovery_script()),
        STANDARD.encode(std::env::current_exe()?.to_str().context("installer path is not Unicode")?)
    );
    if !uninstall {
        script.push_str(&format!("$ExpectedAgentSha='{}'\n", env!("REACH_SETUP_AGENT_SHA")));
        script.push_str(&format!("$BindingOwner='{owner}'\n$PayloadSha='{digest}'\n$ExpectedManifestSha='{}'\n$CompletePackage=${}\n$Payload=[Convert]::FromBase64String('{}')\n$Notices=[Convert]::FromBase64String('{}')\n",
            env!("REACH_SETUP_MANIFEST_SHA"), complete, STANDARD.encode(PAYLOAD), STANDARD.encode(NOTICES)));
    }
    script.push_str(&maintenance_script());
    run_powershell(&script)
}
fn run_powershell(script: &str) -> Result<()> {
    let system = system_directory()?;
    let powershell = system.join("WindowsPowerShell/v1.0/powershell.exe");
    // Read and parse the whole private stream. Interactive stdin command parsing
    // would require blank lines after compound statements and can silently skip them.
    let mut child = Command::new(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))",
        ])
        .current_dir(&system)
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().context("installer input pipe missing")?.write_all(script.as_bytes())?;
    let output = child.wait_with_output()?;
    ensure!(output.status.success(), "installation failed: {}", String::from_utf8_lossy(&output.stderr));
    std::io::stdout().write_all(&output.stdout)?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        let interactive =
            std::env::args().len() == 1 || std::env::args().any(|arg| arg == "--elevated" || arg == "--uninstall");
        if interactive {
            unsafe {
                MessageBoxW(
                    ptr::null_mut(),
                    wide(error.to_string()).as_ptr(),
                    wide("Reach installation failed").as_ptr(),
                    MB_OK | MB_ICONERROR,
                );
            }
        }
        std::process::exit(if interactive { 2 } else { 1 });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_recovery_script_parses_without_embedding_the_payload() -> Result<()> {
        let script = recovery_script();
        ensure!(script.starts_with("$MaintenanceOperation='uninstall'\n"), "recovery mode missing");
        ensure!(script.len() < 2_097_152, "recovery entry is too large");
        // Parse the actual assembled source in Windows PowerShell 5.1. Do not
        // execute it: the normal entry would require UAC and mutate the host.
        run_powershell(&format!(
            "$source=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('{}'))\n$tokens=$null;$errors=$null\n$null=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)\nif($errors.Count){{[Console]::Error.WriteLine(($errors.Message -join '; '));exit 1}}\nexit 0\n",
            STANDARD.encode(script)
        ))
    }

    #[test]
    fn native_identity_and_private_script_transport_work_without_elevation() -> Result<()> {
        ensure!(windows_identity::current_sid()?.starts_with("S-1-"), "missing native SID");
        let system = system_directory()?;
        ensure!(system.is_absolute(), "system directory is not absolute");
        let powershell = system.join("WindowsPowerShell/v1.0/powershell.exe");
        // Identical transport, including a multiline try/function block and a
        // large embedded value. No installer instructions are executed here.
        let mut child = Command::new(powershell)
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))",
            ])
            .current_dir(&system)
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let script = format!("$value='{}'\ntry {{\nfunction Count {{ return $value.Length }}\n[Console]::Out.WriteLine((Count)); exit 7\n}} catch {{ exit 9 }}\n", "x".repeat(3_000_000));
        child.stdin.take().context("private pipe missing")?.write_all(script.as_bytes())?;
        let output = child.wait_with_output()?;
        ensure!(output.status.code() == Some(7), "compound script was not fully executed");
        ensure!(String::from_utf8(output.stdout)?.trim() == "3000000", "private input was truncated");
        Ok(())
    }
}
