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
mod runtime;
#[cfg(windows)]
mod windows_desktop;
#[cfg(windows)]
mod windows_host;
#[cfg(windows)]
#[path = "../windows_identity.rs"]
mod windows_identity;
mod worker;
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use ledger::Ledger;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "reach", version, author = "Ray Zhang")]
struct Cli {
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    Pair {
        #[arg(long)]
        server: String,
        #[arg(long)]
        code: String,
        #[arg(long)]
        name: Option<String>,
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
    if matches!(cli.command, Action::Worker) {
        return worker::run();
    }
    let path = state_path(cli.state_dir.clone())?;
    #[cfg(windows)]
    {
        if let Action::Service { binding_owner } = cli.command {
            return windows_host::dispatch(path, binding_owner);
        }
        if let Action::Host { binding_owner } = cli.command {
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
        if matches!(cli.command, Action::Pair { .. } | Action::Status | Action::HostStop | Action::MaintenanceStop)
            && (cli.state_dir.is_none() || path.join("control-owner.json").exists())
        {
            let command = match cli.command {
                Action::Pair { server, code, name, development } => {
                    control::Command::Pair(pairing::PairInput { server, code, name, development })
                }
                Action::Status => control::Command::Status,
                Action::HostStop => control::Command::StopHost,
                Action::MaintenanceStop => control::Command::MaintenanceStop,
                _ => unreachable!(),
            };
            println!("{}", windows_host::call(cli.state_dir.as_ref().map(|_| path.as_path()), command).await?);
            return Ok(());
        }
    }
    let mut ledger = Ledger::open(&path)?;
    match cli.command {
        Action::Status => println!("{}", ledger.summary()?),
        Action::Run { once } => runtime::run(&mut ledger, once).await?,
        Action::Pair { server, code, name, development } => {
            println!("{}", pairing::pair(&mut ledger, pairing::PairInput { server, code, name, development }).await?);
        }
        Action::Worker => unreachable!(),
        #[cfg(windows)]
        Action::Service { .. } | Action::Host { .. } | Action::HostStop | Action::MaintenanceStop => {
            anyhow::bail!("host control is unavailable; no direct ledger fallback")
        }
    }
    Ok(())
}
