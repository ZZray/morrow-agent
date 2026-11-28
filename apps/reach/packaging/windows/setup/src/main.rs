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
const ADDRESS_DIALOG: &str = include_str!("../../configure-address.ps1");
const PACKAGE_CHECKS: &str = include_str!("../../payload.ps1");
const OWNERSHIP: &str = include_str!("../../ownership.ps1");
const MAINTENANCE_WRITES: &str = include_str!("../../maintenance-writes.ps1");
const MAINTENANCE_ENTRY: &str = include_str!("../../maintenance-entry.ps1");
const UNINSTALL_FILES: &str = include_str!("../../uninstall-files.ps1");
const UNINSTALL_TRANSACTION: &str = include_str!("../../uninstall-transaction.ps1");
const UNINSTALL_HOST: &str = include_str!("../../uninstall-host.ps1");
const NOTICES: &[u8] = include_bytes!(env!("REACH_SETUP_NOTICES"));
const OPENSSH: &[u8] = include_bytes!(env!("REACH_SETUP_OPENSSH"));
const SSH_PREPARATION: &str = include_str!("../../ssh.ps1");
fn maintenance_script() -> String {
    format!("{PACKAGE_CHECKS}\n{OWNERSHIP}\n{MAINTENANCE_WRITES}\n{MAINTENANCE_ENTRY}\n{UNINSTALL_FILES}\n{UNINSTALL_TRANSACTION}\n{UNINSTALL_HOST}\n{SSH_PREPARATION}\n{SCRIPT}\n")
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
fn elevate(owner: &str, uninstall: bool, silent: bool, server_url: Option<&str>) -> Result<()> {
    let path = wide(std::env::current_exe()?);
    let verb = wide("runas");
    let mut raw_args = format!("--elevated --owner {owner}{}", if uninstall { " --uninstall" } else { "" });
    if silent {
        raw_args.push_str(" --silent");
    }
    if let Some(url) = server_url {
        raw_args.push_str(&format!(" --server-url-b64 {}", STANDARD.encode(url)));
    }
    let args = wide(raw_args);
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
    let openssh_sha = format!("{:x}", Sha256::digest(OPENSSH));
    ensure!(
        openssh_sha == "23f50f3458c4c5d0b12217c6a5ddfde0137210a30fa870e98b29827f7b43aba5",
        "embedded OpenSSH integrity mismatch"
    );
    let kind = env!("REACH_SETUP_KIND");
    let complete = kind != "node";
    let desktop_bundled = kind == "complete";
    let digest = format!("{:x}", Sha256::digest(PAYLOAD));
    ensure!(digest == env!("REACH_SETUP_SHA"), "embedded payload integrity mismatch");
    ensure!(
        if complete { PAYLOAD.starts_with(b"PK") } else { PAYLOAD.starts_with(b"MZ") },
        "embedded payload format mismatch"
    );
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--inspect"] {
        println!("openssh_sha256={openssh_sha}\nssh_preparation_sha256={:x}", Sha256::digest(SSH_PREPARATION));
        println!(
            "Reach setup {}\nnode_sha256={}\nscript_sha256={}\npayload_bytes={}\nnotices_sha256={}\npayload_sha256={}\npayload_manifest_sha256={}\npayload_checks_sha256={}\ndesktop_bundled={}\nownership_sha256={}\nmaintenance_writes_sha256={}",
            env!("REACH_SETUP_VERSION"),
            env!("REACH_SETUP_COMPONENT_NODE_SHA"),
            format_args!("{:x}", Sha256::digest(SCRIPT.as_bytes())),
            PAYLOAD.len(),
            format_args!("{:x}",Sha256::digest(NOTICES)),
            digest,
            env!("REACH_SETUP_MANIFEST_SHA"),
            format_args!("{:x}",Sha256::digest(PACKAGE_CHECKS.as_bytes())),
            desktop_bundled,
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
        println!("auto_update_worker_agent={}", complete && !desktop_bundled);
        println!("address_dialog_sha256={:x}", Sha256::digest(ADDRESS_DIALOG));
        return Ok(());
    }
    if args == ["--verify-payload"] {
        ensure!(complete, "payload verification requires the complete package");
        let script = format!(
            "$ErrorActionPreference='Stop'\n{PACKAGE_CHECKS}\ntry {{\nAdd-Type -AssemblyName System.IO.Compression\n$bytes=[Convert]::FromBase64String('{}')\n$stream=[IO.MemoryStream]::new($bytes,$false)\nif((ReachHashStream $stream $bytes.Length)-cne'{digest}'){{throw 'Payload changed in transit'}}\n$stream.Position=0\n$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read,$true)\n$result=ReadReachPayload $zip\nif($result.manifest.schema-ne2 -or $result.manifest.version-cne'{version}' -or $result.manifest.agentBundled-ne$true -or $result.manifest.agentSha256-cne'{agent_sha}' -or $result.manifest.desktopBundled-cne${desktop_bundled}){{throw 'Embedded complete package identity mismatch'}}\nif(-not $result.declared.ContainsKey('openssh-vendor.zip') -or $result.declared['openssh-vendor.zip'].sha256-cne'{openssh_sha}'){{throw 'Complete package is missing its verified offline OpenSSH component'}}\n$manifestStream=[IO.MemoryStream]::new($result.manifestBytes,$false)\nif((ReachHashStream $manifestStream $result.manifestBytes.Length)-cne'{}'){{throw 'Manifest identity mismatch'}}\n[Console]::Out.WriteLine(('verified_files='+$result.declared.Count+'; bytes='+$result.totalBytes+'; powershell='+$PSVersionTable.PSVersion))\nexit 0\n}} catch {{[Console]::Error.WriteLine($_.Exception.Message);exit 1}}\n",
            STANDARD.encode(PAYLOAD), env!("REACH_SETUP_MANIFEST_SHA"), agent_sha=env!("REACH_SETUP_AGENT_SHA"), version=env!("REACH_SETUP_VERSION")
        );
        return run_powershell(&script);
    }
    let mut uninstall = false;
    let mut elevated = false;
    let mut silent = false;
    let mut auto_update = false;
    let mut expected_version: Option<&str> = None;
    let mut expected_agent_sha256: Option<&str> = None;
    let mut explicit_owner: Option<String> = None;
    let mut preconfigured_server_url: Option<String> = None;
    let mut idx = 0;
    while idx < args.len() {
        match args[idx].as_str() {
            "--uninstall" => uninstall = true,
            "--elevated" => elevated = true,
            "--silent" => silent = true,
            "--auto-update" => auto_update = true,
            "--expected-version" => {
                ensure!(expected_version.is_none(), "duplicate expected update version");
                idx += 1;
                expected_version = Some(args.get(idx).context("missing expected update version")?);
            }
            "--expected-agent-sha256" => {
                ensure!(expected_agent_sha256.is_none(), "duplicate expected Agent digest");
                idx += 1;
                expected_agent_sha256 = Some(args.get(idx).context("missing expected Agent digest")?);
            }
            "--owner" => {
                idx += 1;
                explicit_owner = Some(args.get(idx).context("missing --owner value")?.clone());
            }
            "--server-url" => {
                idx += 1;
                let raw = args.get(idx).context("missing --server-url value")?.trim().to_owned();
                ensure!(!raw.is_empty() && raw.len() <= 512, "invalid --server-url value");
                preconfigured_server_url = Some(raw);
            }
            "--server-url-b64" => {
                idx += 1;
                let encoded = args.get(idx).context("missing --server-url-b64 value")?;
                let decoded = String::from_utf8(STANDARD.decode(encoded).context("invalid --server-url-b64")?)?;
                ensure!(!decoded.is_empty() && decoded.len() <= 512, "invalid --server-url-b64 value");
                preconfigured_server_url = Some(decoded);
            }
            _ => anyhow::bail!("unsupported installer arguments"),
        }
        idx += 1;
    }
    ensure!(
        if auto_update {
            expected_version == Some(env!("REACH_SETUP_VERSION"))
                && if complete {
                    expected_agent_sha256 == Some(env!("REACH_SETUP_AGENT_SHA"))
                } else {
                    expected_agent_sha256.is_none()
                }
        } else {
            expected_version.is_none() && expected_agent_sha256.is_none()
        },
        "Setup version or Agent digest differs from the verified update manifest"
    );
    ensure!(
        !auto_update || (silent && elevated && !uninstall && preconfigured_server_url.is_none()
            && windows_identity::current_sid()? == "S-1-5-18"),
        "automatic update requires the LocalSystem installation service"
    );
    ensure!(!(uninstall && preconfigured_server_url.is_some()), "--server-url cannot be combined with --uninstall");
    let owner = match explicit_owner {
        Some(explicit) => {
            ensure!(elevated, "unsupported installer arguments");
            explicit
        }
        None => {
            ensure!(!elevated, "unsupported installer arguments");
            windows_identity::current_sid()?
        }
    };
    ensure!(
        owner.starts_with("S-1-")
            && owner.len() < 184
            && owner.chars().all(|c| c.is_ascii_digit() || c == 'S' || c == '-'),
        "invalid binding owner"
    );
    if !administrator()? {
        ensure!(!elevated, "elevated maintenance requires an administrator token");
        elevate(&owner, uninstall, silent, preconfigured_server_url.as_deref())?;
    } else {
        // The script is delivered over a private pipe, never loaded from a user-writable temporary file.
        let mut script = format!(
            "$MaintenanceOperation='{}'\n$RecoveryScriptBytes=[Convert]::FromBase64String('{}')\n$SetupExecutable=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}'))\n",
            if uninstall { "uninstall" } else { "install" }, STANDARD.encode(recovery_script()),
            STANDARD.encode(std::env::current_exe()?.to_str().context("installer path is not Unicode")?)
        );
        if !uninstall {
            script.push_str(&format!(
                "$ReachInstallVersion='{}'\n$ReachAutoUpdate=${auto_update}\n",
                env!("REACH_SETUP_VERSION")
            ));
            script.push_str(&format!("$OpenSshArchive=[Convert]::FromBase64String('{}')\n", STANDARD.encode(OPENSSH)));
            script.push_str(&format!(
                "$ExpectedAgentSha='{}'\n$ExpectedDesktopBundled=${desktop_bundled}\n",
                env!("REACH_SETUP_AGENT_SHA")
            ));
            script.push_str(&format!("$BindingOwner='{owner}'\n$PayloadSha='{digest}'\n$ExpectedManifestSha='{}'\n$CompletePackage=${}\n$Payload=[Convert]::FromBase64String('{}')\n$Notices=[Convert]::FromBase64String('{}')\n",
                env!("REACH_SETUP_MANIFEST_SHA"), complete, STANDARD.encode(PAYLOAD), STANDARD.encode(NOTICES)));
        }
        if let Some(url) = &preconfigured_server_url {
            script.push_str(&format!(
                "$PreconfiguredServerUrl=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}'))\n",
                STANDARD.encode(url)
            ));
        }
        script.push_str(&maintenance_script());
        run_powershell(&script)?;
    }
    // Let the original caller configure its binding after the maintenance process commits and releases the locks.
    if args.is_empty() {
        if let Err(error) = show_address_dialog() {
            show_message(
                "Reach 已安装",
                &format!("无法打开地址配置。可以在 PowerShell 运行 ryreach。\n\n{error}"),
                MB_ICONWARNING,
            );
        }
    }
    Ok(())
}
fn show_address_dialog() -> Result<()> {
    let output = powershell_output(ADDRESS_DIALOG)?;
    ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

fn run_powershell(script: &str) -> Result<()> {
    let output = powershell_output(script)?;
    ensure!(output.status.success(), "installation failed: {}", String::from_utf8_lossy(&output.stderr));
    std::io::stdout().write_all(&output.stdout)?;
    Ok(())
}
fn powershell_output(script: &str) -> Result<std::process::Output> {
    let system = system_directory()?;
    let powershell = system.join("WindowsPowerShell/v1.0/powershell.exe");
    // Read the whole script with an explicit decoder. Windows PowerShell 5.1
    // also uses Console.OutputEncoding to decode UTF-8 output from reach.exe.
    let mut child = Command::new(powershell)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$utf8=[Text.UTF8Encoding]::new($false,$true); \
             [Console]::OutputEncoding=$utf8; $OutputEncoding=$utf8; \
             $reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),$utf8,$false); \
             $source=$reader.ReadToEnd(); $reader.Dispose(); \
             & ([ScriptBlock]::Create($source))",
        ])
        .current_dir(&system)
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().context("installer input pipe missing")?.write_all(script.as_bytes())?;
    Ok(child.wait_with_output()?)
}
fn show_message(title: &str, message: &str, icon: u32) {
    unsafe {
        MessageBoxW(ptr::null_mut(), wide(message).as_ptr(), wide(title).as_ptr(), MB_OK | icon);
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        let interactive = !std::env::args().any(|arg| arg == "--silent")
            && (std::env::args().len() == 1 || std::env::args().any(|arg| arg == "--elevated" || arg == "--uninstall"));
        if interactive {
            show_message("Reach 安装失败", &error.to_string(), MB_ICONERROR);
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
        // Use the installer entry point for a multiline script and large payload.
        let script = format!("$value='{}'\ntry {{\nfunction Count {{ return $value.Length }}\n[Console]::Out.WriteLine((Count)); exit 7\n}} catch {{ exit 9 }}\n", "x".repeat(3_000_000));
        let output = powershell_output(&script)?;
        ensure!(output.status.code() == Some(7), "compound script was not fully executed");
        ensure!(String::from_utf8(output.stdout)?.trim() == "3000000", "private input was truncated");
        Ok(())
    }

    #[test]
    fn windows_powershell_reads_utf8_node_status_and_diagnostics() -> Result<()> {
        let output = powershell_output(r#"
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$stateLabel='等待初始化'
$recoveryHint='运行 ryreach 初始化服务器地址'
$nativeScript='[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Console]::Out.WriteLine(''{"resident":{"stateLabel":"等待初始化","recoveryHint":"运行 ryreach 初始化服务器地址"}}'')'
$nativeCommand=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($nativeScript))
$native=Join-Path $PSHOME 'powershell.exe'
$raw=& $native -NoLogo -NoProfile -NonInteractive -EncodedCommand $nativeCommand 2>&1
if($LASTEXITCODE -ne 0){throw 'Native status fixture failed'}
$status=$raw | ConvertFrom-Json
if($status.resident.stateLabel -cne $stateLabel -or $status.resident.recoveryHint -cne $recoveryHint){
    throw 'Native UTF-8 status did not decode correctly'
}
[Console]::Out.WriteLine($stateLabel)
[Console]::Error.WriteLine($recoveryHint)
exit 7
"#)?;
        ensure!(
            output.status.code() == Some(7),
            "UTF-8 probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8(output.stdout)?.trim(), "等待初始化");
        assert_eq!(String::from_utf8(output.stderr)?.trim(), "运行 ryreach 初始化服务器地址");
        Ok(())
    }
}
