// Copyright (c) Ray Zhang. All identity mutations execute in the Ledger owner.
use crate::{ledger::Ledger, pairing::PairInput};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};
use tokio::sync::{mpsc, oneshot};

pub const IDLE: u8 = 0;
pub const EXECUTING: u8 = 1;
pub const PAIRING: u8 = 2;
pub const STOPPING: u8 = 3;

#[derive(Serialize, Deserialize)]
#[serde(tag = "method", content = "input", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Status,
    Pair(PairInput),
    MaintenanceStop,
    // Only the explicit foreground host exposes this; SCM owns production stop.
    StopHost,
}

pub struct Request {
    pub command: Command,
    pub reply: oneshot::Sender<std::result::Result<Value, String>>,
    pub _admission: Option<PairAdmission>,
}
pub struct PairAdmission(pub Arc<AtomicU8>);
impl Drop for PairAdmission {
    fn drop(&mut self) {
        let _ = self.0.compare_exchange(PAIRING, IDLE, Ordering::SeqCst, Ordering::SeqCst);
    }
}
pub struct ExecutionPhase(Arc<AtomicU8>);
impl Drop for ExecutionPhase {
    fn drop(&mut self) {
        let _ = self.0.compare_exchange(EXECUTING, IDLE, Ordering::SeqCst, Ordering::SeqCst);
    }
}

pub struct Control {
    pub receiver: mpsc::Receiver<Request>,
    pub stop: Arc<AtomicBool>,
    pub phase: Arc<AtomicU8>,
    pub foreground: bool,
    pub desktop_owner: Option<String>,
}
impl Control {
    pub fn stopping(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
    pub fn set_phase(&self, phase: u8) {
        self.phase.store(phase, Ordering::SeqCst);
    }
    pub fn execution_phase(&self) -> ExecutionPhase {
        self.set_phase(EXECUTING);
        ExecutionPhase(self.phase.clone())
    }
    pub fn handle(&self, ledger: &Ledger, request: Request, busy: bool) -> Result<Option<Request>> {
        match request.command {
            Command::Status => {
                let mut status = ledger.summary()?;
                status["host"] = json!({"pid":std::process::id(),"phase":self.phase.load(Ordering::SeqCst),"stopping":self.stopping(),"foreground":self.foreground});
                let _ = request.reply.send(Ok(status));
            }
            Command::Pair(_) | Command::MaintenanceStop if busy || self.stopping() => {
                let _ = self.phase.compare_exchange(PAIRING, IDLE, Ordering::SeqCst, Ordering::SeqCst);
                let _ = request.reply.send(Err("Node is busy; pairing was not queued or applied".into()));
            }
            Command::Pair(_) | Command::MaintenanceStop => return Ok(Some(request)),
            Command::StopHost if self.foreground => {
                self.stop.store(true, Ordering::SeqCst);
                self.set_phase(STOPPING);
                let _ = request.reply.send(Ok(json!({"stopRequested":true})));
            }
            Command::StopHost => {
                let _ = request.reply.send(Err("use Windows service control to stop the installed Node".into()));
            }
        }
        Ok(None)
    }
}

pub fn stopping(control: &Option<&mut Control>) -> bool {
    control.as_ref().is_some_and(|c| c.stopping())
}

// Called only between completed network polls. No in-flight dispatch is dropped.
pub fn idle(ledger: &Ledger, control: &mut Option<&mut Control>) -> Result<Option<Request>> {
    if let Some(control) = control {
        while let Ok(request) = control.receiver.try_recv() {
            let busy = ledger.next_event()?.is_some() || ledger.has_active_operations()?;
            if let Some(pair) = control.handle(ledger, request, busy)? {
                return Ok(Some(pair));
            }
        }
    }
    Ok(None)
}

pub fn executing(ledger: &Ledger, control: &mut Option<&mut Control>) -> Result<()> {
    if let Some(control) = control {
        control.set_phase(EXECUTING);
        while let Ok(request) = control.receiver.try_recv() {
            control.handle(ledger, request, true)?;
        }
    }
    Ok(())
}
