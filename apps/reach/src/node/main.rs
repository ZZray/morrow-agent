// Copyright (c) Ray Zhang. Reach / namespace RY.
mod agent;
#[cfg(windows)]
mod agent_closure;
#[cfg(windows)]
mod agent_finalize;
mod agent_guidance;
#[cfg(windows)]
mod agent_process;
mod agent_relay;
mod agent_resume;
mod api;
mod control;
mod desktop;
#[cfg(windows)]
#[path = "../desktop_pipe.rs"]
pub mod desktop_pipe;
mod job;
mod ledger;
mod pairing;
mod protocol;
mod resident;
mod runtime;
mod ssh;
mod starferry;
#[cfg(windows)]
mod windows_desktop;
#[cfg(windows)]
mod windows_host;
#[cfg(windows)]
mod updater;
#[cfg(windows)]
#[path = "../windows_identity.rs"]
mod windows_identity;
mod worker;
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use ledger::Ledger;
use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "ryreach", version = env!("REACH_COMPILED_VERSION"), author = "Ray Zhang")]
struct Cli {
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Action>,
}

#[derive(Subcommand)]
enum ConfigAction {
    Show,
    Set {
        key: String,
        value: String,
        #[arg(long)]
        development: bool,
        #[arg(long)]
        allow_offline: bool,
    },
}

#[cfg(windows)]
#[derive(Subcommand)]
enum SshAction {
    /// Prepare and start the offline OpenSSH component as an administrator.
    Enable,
}

#[derive(Subcommand)]
enum Action {
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    Pair {
        code_positional: Option<String>,
        #[arg(long)]
        server: Option<String>,
        #[arg(long)]
        code: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        development: bool,
    },
    Unpair,
    Preconfigure {
        #[arg(long)]
        server: String,
        #[arg(long)]
        development: bool,
    },
    Run {
        #[arg(long)]
        once: bool,
    },
    Status,
    #[cfg(windows)]
    #[command(hide = true)]
    UpdateChannel,
    #[cfg(windows)]
    Ssh {
        #[command(subcommand)]
        action: SshAction,
    },
    #[cfg(windows)]
    #[command(hide = true)]
    Service {
        #[arg(long)]
        binding_owner: String,
    },
    #[cfg(windows)]
    #[command(hide = true)]
    Host {
        #[arg(long)]
        binding_owner: Option<String>,
    },
    #[cfg(windows)]
    #[command(hide = true)]
    HostStop,
    #[cfg(windows)]
    #[command(hide = true)]
    MaintenanceStop,
    #[command(hide = true)]
    Worker,
}

fn resolve_pair_input(
    code_positional: Option<String>,
    server: Option<String>,
    code: Option<String>,
    name: Option<String>,
    development: bool,
) -> Result<pairing::PairInput> {
    let resolved_code = match (code_positional, code) {
        (Some(a), Some(b)) if a != b => anyhow::bail!("conflicting pairing codes supplied"),
        (Some(a), _) => a,
        (None, Some(b)) => b,
        (None, None) => anyhow::bail!("pairing code required: ryreach pair <code>"),
    };
    Ok(pairing::PairInput { server, code: resolved_code, name, development })
}

fn read_interactive_server_url() -> Result<Option<String>> {
    let interactive = std::io::stdin().is_terminal() || std::env::var_os("REACH_CLI_INTERACTIVE").is_some();
    if !interactive {
        return Ok(None);
    }
    eprint!("请输入 Reach 服务器地址（HTTPS）：");
    std::io::stderr().flush()?;
    let mut line = String::new();
    let read = std::io::stdin().lock().read_line(&mut line)?;
    if read == 0 {
        return Ok(None);
    }
    let trimmed = line.trim().to_owned();
    if trimmed.is_empty() {
        anyhow::bail!("server URL cannot be empty");
    }
    Ok(Some(trimmed))
}
fn state_path(value: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(value) = value {
        return Ok(value);
    }
    #[cfg(windows)]
    {
        Ok(PathBuf::from(std::env::var_os("ProgramData").context("ProgramData unavailable")?).join("RY").join("Reach"))
    }
    #[cfg(unix)]
    {
        Ok(PathBuf::from(std::env::var_os("HOME").context("HOME unavailable")?).join(".local/state/ry-reach"))
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if matches!(cli.command, Some(Action::Worker)) {
        return worker::run();
    }
    #[cfg(windows)]
    if matches!(cli.command, Some(Action::UpdateChannel)) {
        println!("{}", updater::channel_info());
        return Ok(());
    }
    #[cfg(windows)]
    if matches!(cli.command, Some(Action::Ssh { action: SshAction::Enable })) {
        anyhow::ensure!(cli.state_dir.is_none(), "SSH enable requires the installed Windows Reach service");
        println!("{}", ssh::enable_installed_windows_ssh()?);
        return Ok(());
    }
    let path = state_path(cli.state_dir.clone())?;
    let development_default = std::env::var_os("REACH_CLI_DEVELOPMENT").is_some();
    #[cfg(windows)]
    {
        if let Some(Action::Service { binding_owner }) = cli.command {
            return windows_host::dispatch(path, binding_owner);
        }
        if let Some(Action::Host { binding_owner }) = cli.command {
            anyhow::ensure!(
                cli.state_dir.is_some(),
                "foreground host requires an explicit development state directory"
            );
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let signal = stop.clone();
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                signal.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            return tokio::task::LocalSet::new()
                .run_until(windows_host::serve(
                    path,
                    binding_owner.map(Ok).unwrap_or_else(windows_host::current_sid)?,
                    stop,
                    true,
                ))
                .await;
        }
        let use_ipc = cli.state_dir.is_none() || path.join("control-owner.json").exists();
        if use_ipc && !matches!(cli.command, Some(Action::Run { .. })) {
            let pipe_root = cli.state_dir.as_ref().map(|_| path.as_path());
            match cli.command {
                None => {
                    let status = windows_host::call(pipe_root, control::Command::Status).await?;
                    if status["server"].is_null() {
                        if let Some(entered) = read_interactive_server_url()? {
                            let configured = windows_host::call(
                                pipe_root,
                                control::Command::ConfigSetServer {
                                    server: entered,
                                    development: development_default,
                                    allow_offline: false,
                                },
                            )
                            .await?;
                            println!("{}", configured);
                            return Ok(());
                        }
                    }
                    println!("{}", status);
                    return Ok(());
                }
                Some(Action::Config { action: ConfigAction::Show }) => {
                    println!("{}", windows_host::call(pipe_root, control::Command::ConfigShow).await?);
                    return Ok(());
                }
                Some(Action::Config { action: ConfigAction::Set { key, value, development, allow_offline } }) => {
                    let cmd = match key.as_str() {
                        "server-url" => control::Command::ConfigSetServer { server: value, development, allow_offline },
                        "heartbeat-seconds" => control::Command::ConfigSetHeartbeat {
                            seconds: value.parse().context("heartbeat-seconds must be an integer")?,
                        },
                        _ => anyhow::bail!(
                            "unsupported config key '{key}'; expected 'server-url' or 'heartbeat-seconds'"
                        ),
                    };
                    println!("{}", windows_host::call(pipe_root, cmd).await?);
                    return Ok(());
                }
                Some(Action::Pair { code_positional, server, code, name, development }) => {
                    let input = resolve_pair_input(code_positional, server, code, name, development)?;
                    println!("{}", windows_host::call(pipe_root, control::Command::Pair(input)).await?);
                    return Ok(());
                }
                Some(Action::Unpair) => {
                    println!("{}", windows_host::call(pipe_root, control::Command::Unpair).await?);
                    return Ok(());
                }
                Some(Action::Preconfigure { server, development }) => {
                    println!(
                        "{}",
                        windows_host::call(pipe_root, control::Command::Preconfigure { server, development }).await?
                    );
                    return Ok(());
                }
                Some(Action::Status) => {
                    println!("{}", windows_host::call(pipe_root, control::Command::Status).await?);
                    return Ok(());
                }
                Some(Action::HostStop) => {
                    println!("{}", windows_host::call(pipe_root, control::Command::StopHost).await?);
                    return Ok(());
                }
                Some(Action::MaintenanceStop) => {
                    println!("{}", windows_host::call(pipe_root, control::Command::MaintenanceStop).await?);
                    return Ok(());
                }
                _ => {}
            }
        }
    }
    let mut ledger = Ledger::open(&path)?;
    match cli.command {
        None => {
            let mut status = ledger.summary()?;
            let cfg = resident::load_config(&ledger)?;
            status["resident"] = resident::derive_standalone_state(&ledger, &cfg);
            status["config"] = resident::config_summary(&ledger, None)?;
            let dev_flag = ledger.identity().map(|i| i.development).unwrap_or(false);
            status["ssh"] = serde_json::to_value(ssh::prepare_or_detect(&ledger.root, dev_flag, false))?;
            if status["server"].is_null() {
                if let Some(entered) = read_interactive_server_url()? {
                    let configured =
                        resident::set_server_url(&mut ledger, &entered, development_default, false, None).await?;
                    println!("{}", configured);
                    return Ok(());
                }
            }
            println!("{}", status);
        }
        Some(Action::Status) => {
            let mut status = ledger.summary()?;
            let cfg = resident::load_config(&ledger)?;
            status["resident"] = resident::derive_standalone_state(&ledger, &cfg);
            status["config"] = resident::config_summary(&ledger, None)?;
            let dev_flag = ledger.identity().map(|i| i.development).unwrap_or(false);
            status["ssh"] = serde_json::to_value(ssh::prepare_or_detect(&ledger.root, dev_flag, false))?;
            println!("{}", status);
        }
        Some(Action::Config { action: ConfigAction::Show }) => {
            println!("{}", resident::config_summary(&ledger, None)?);
        }
        Some(Action::Config { action: ConfigAction::Set { key, value, development, allow_offline } }) => {
            match key.as_str() {
                "server-url" => {
                    println!(
                        "{}",
                        resident::set_server_url(&mut ledger, &value, development, allow_offline, None).await?
                    );
                }
                "heartbeat-seconds" => {
                    let secs: u64 = value.parse().context("heartbeat-seconds must be an integer")?;
                    println!("{}", resident::set_local_heartbeat(&mut ledger, secs)?);
                }
                _ => anyhow::bail!("unsupported config key '{key}'; expected 'server-url' or 'heartbeat-seconds'"),
            }
        }
        Some(Action::Unpair) => {
            println!("{}", resident::local_unpair(&mut ledger, None)?);
        }
        Some(Action::Preconfigure { server, development }) => {
            println!("{}", resident::preconfigure_server_url(&mut ledger, &server, development, None)?);
        }
        Some(Action::Run { once }) => runtime::run(&mut ledger, once).await?,
        Some(Action::Pair { code_positional, server, code, name, development }) => {
            let input = resolve_pair_input(code_positional, server, code, name, development)?;
            println!("{}", pairing::pair(&mut ledger, input).await?);
        }
        Some(Action::Worker) => unreachable!(),
        #[cfg(windows)]
        Some(Action::UpdateChannel) => unreachable!(),
        #[cfg(windows)]
        Some(Action::Ssh { .. }) => unreachable!(),
        #[cfg(windows)]
        Some(Action::Service { .. } | Action::Host { .. } | Action::HostStop | Action::MaintenanceStop) => {
            anyhow::bail!("host control is unavailable; no direct ledger fallback")
        }
    }
    Ok(())
}
