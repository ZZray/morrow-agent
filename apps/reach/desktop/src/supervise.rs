// Copyright (c) Ray Zhang. Development parent; production Node uses WTS/pipe.
use anyhow::{ensure, Context, Result};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    process::Command,
};

pub async fn run() -> Result<()> {
    run_with(tokio::io::stdin(), tokio::io::stdout(), None).await
}
pub async fn run_with<R, W>(mut source: R, destination: W, service_pid: Option<u32>) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut child = Command::new(std::env::current_exe()?)
        .args(std::env::args_os().skip(1))
        .arg("--worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    // Worker cannot start Python until start arrives on stdin. No input is
    // forwarded before this assign, closing the backend spawn/containment gap.
    let job = crate::job::Job::assign(&child)?;
    let mut stdin = child.stdin.take().context("missing worker stdin")?;
    let mut stdout = child.stdout.take().context("missing worker stdout")?;
    let input = async move {
        let result = tokio::io::copy(&mut source, &mut stdin).await;
        let _ = stdin.shutdown().await;
        // ChildStdin's shutdown does not close the OS pipe; release ownership
        // now so the worker observes EOF while the parent waits for settlement.
        drop(stdin);
        result
    };
    let mut output = tokio::spawn(async move {
        let mut writer = destination;
        let result = tokio::io::copy(&mut stdout, &mut writer).await;
        (result, writer)
    });
    tokio::pin!(input);
    let mut output_result = None;
    let mut authority_lost = false;
    let authority = async {
        loop {
            if let Some(expected) = service_pid {
                if crate::desktop_pipe::service_pid().ok() != Some(expected) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    let status = tokio::select! {
        status = child.wait() => Some(status?),
        _ = &mut input => {
            tokio::time::timeout(Duration::from_secs(5), child.wait()).await.ok().transpose()?
        },
        result = &mut output => { output_result = Some(result); None },
        _=authority, if service_pid.is_some()=>{authority_lost=true;None},
    };
    job.terminate()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !job.empty()? {
        ensure!(tokio::time::Instant::now() < deadline, "desktop process tree did not settle");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let status = match status {
        Some(status) => status,
        None => child.wait().await?,
    };
    let (result, mut writer) = match output_result {
        Some(result) => result?,
        None => tokio::time::timeout(Duration::from_secs(3), output).await??,
    };
    result?;
    let mut frame = serde_json::to_vec(
        &serde_json::json!({"event":"desktop_host_exited","processTreeEmpty":true,"workerExitCode":status.code()}),
    )?;
    frame.push(b'\n');
    writer.write_all(&frame).await?;
    writer.flush().await?;
    ensure!(!authority_lost, "Reach service identity or running state changed");
    ensure!(status.success(), "desktop worker failed: {status}");
    Ok(())
}
