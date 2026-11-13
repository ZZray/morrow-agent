// Copyright (c) Ray Zhang. One durable owner of a Node's operation effects.
use crate::protocol::{id, Dispatch, Event};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use fs2::FileExt;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Identity {
    pub installation_id: String,
    pub secret: String,
    pub node_id: Option<String>,
    pub epoch: u64,
    pub server: Option<String>,
    pub development: bool,
    pub pending_pair: Option<Value>,
    #[serde(default)]
    pub last_pair: Option<Value>,
    #[serde(default)]
    pub revoked: bool,
}

pub struct Ledger {
    pub db: Connection,
    pub root: PathBuf,
    _lock: File,
}

fn protect_directory(root: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        crate::windows_host::protect_state(root)?;
    }
    Ok(())
}

impl Ledger {
    pub fn open(root: &Path) -> Result<Self> {
        #[cfg(windows)]
        crate::windows_host::validate_state_path(root)?;
        fs::create_dir_all(root)?;
        let root = fs::canonicalize(root)?;
        let database = root.join("node.sqlite");
        if !database.exists() && fs::read_dir(&root)?.next().is_some() {
            bail!("state directory is not empty and is not a Reach state directory");
        }
        protect_directory(&root)?;
        let lock =
            OpenOptions::new().read(true).write(true).create(true).truncate(false).open(root.join("reach.lock"))?;
        lock.try_lock_exclusive().context("another Reach process owns this state directory")?;
        let db = Connection::open(database)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: u64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        ensure!(version <= 1, "Node database belongs to a newer Reach version");
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,dispatch_json TEXT NOT NULL,status TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS outbox(operation_id TEXT NOT NULL REFERENCES operations(id),sequence INTEGER NOT NULL,event_json TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(operation_id,sequence));
          PRAGMA user_version=1;")?;
        let ledger = Self { db, root, _lock: lock };
        if ledger
            .db
            .query_row("SELECT value FROM config WHERE key='identity'", [], |row| row.get::<_, String>(0))
            .optional()?
            .is_none()
        {
            let mut secret = [0u8; 32];
            getrandom::fill(&mut secret).map_err(|_| anyhow::anyhow!("operating system random source failed"))?;
            ledger.save_identity(&Identity {
                installation_id: id(),
                secret: URL_SAFE_NO_PAD.encode(secret),
                node_id: None,
                epoch: 0,
                server: None,
                development: false,
                pending_pair: None,
                last_pair: None,
                revoked: false,
            })?;
        }
        Ok(ledger)
    }
    pub fn identity(&self) -> Result<Identity> {
        let value: String = self.db.query_row("SELECT value FROM config WHERE key='identity'", [], |row| row.get(0))?;
        serde_json::from_str(&value).context("invalid existing identity; it was preserved")
    }
    pub fn save_identity(&self, identity: &Identity) -> Result<()> {
        self.db.execute(
            "INSERT INTO config VALUES('identity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(identity)?],
        )?;
        Ok(())
    }
    pub fn pair_receipt(&self, request_hash: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .db
            .query_row("SELECT value FROM config WHERE key=?", [format!("pair:{request_hash}")], |row| row.get(0))
            .optional()?;
        raw.map(|value| serde_json::from_str(&value).map_err(Into::into)).transpose()
    }
    pub fn complete_pair(&mut self, identity: &Identity, request_hash: &str) -> Result<Value> {
        let receipt = json!({"requestId":request_hash,"inputHash":request_hash,"installationId":identity.installation_id,"nodeId":identity.node_id,"epoch":identity.epoch,"server":identity.server,"revoked":identity.revoked});
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO config VALUES('identity',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(identity)?],
        )?;
        tx.execute(
            "INSERT INTO config VALUES(?,?)",
            [format!("pair:{request_hash}"), serde_json::to_string(&receipt)?],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
    pub fn accept(&mut self, dispatch: &Dispatch) -> Result<bool> {
        let encoded = serde_json::to_string(dispatch)?;
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let prior: Option<String> = tx
            .query_row("SELECT dispatch_json FROM operations WHERE id=?", [&dispatch.operation_id], |row| row.get(0))
            .optional()?;
        if let Some(prior) = prior {
            ensure!(prior == encoded, "same operation ID has changed input");
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO operations(id,dispatch_json,status) VALUES(?,?,'received')",
            params![dispatch.operation_id, encoded],
        )?;
        append_event(&tx, dispatch, "received", json!({"durable":true}))?;
        tx.commit()?;
        Ok(true)
    }
    // This is an authenticated server cursor, not a fabricated local receipt.
    // Missing evidence must never authorize execution of the original action.
    pub fn import_missing(&mut self, dispatch: &Dispatch, sequence: u64, state: &str) -> Result<()> {
        ensure!(sequence <= 9_007_199_254_740_990, "invalid server event cursor");
        ensure!(["not_observed", "received", "running", "unknown"].contains(&state), "invalid pending execution state");
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO operations(id,dispatch_json,status,sequence) VALUES(?,?,?,?)",
            params![dispatch.operation_id, serde_json::to_string(dispatch)?, state, sequence],
        )?;
        if state != "unknown" {
            append_event(
                &tx,
                dispatch,
                "unknown",
                json!({"reason":"local_receipt_missing","serverSequence":sequence,"replayed":false}),
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn event(&mut self, dispatch: &Dispatch, kind: &str, data: Value) -> Result<Event> {
        let tx = self.db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let event = append_event(&tx, dispatch, kind, data)?;
        tx.commit()?;
        Ok(event)
    }
    pub fn recover(&mut self) -> Result<()> {
        let mut statement =
            self.db.prepare("SELECT dispatch_json,sequence FROM operations WHERE status IN ('received','running')")?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(statement);
        for (raw, sequence) in rows {
            let dispatch: Dispatch = serde_json::from_str(&raw)?;
            if sequence == 0 {
                self.event(&dispatch, "received", json!({"recoveredAdmission":true}))?;
            }
            self.event(&dispatch, "unknown", json!({"reason":"node_process_interrupted","replayed":false}))?;
        }
        Ok(())
    }
    pub fn next_event(&self) -> Result<Option<Event>> {
        let raw: Option<String> = self
            .db
            .query_row("SELECT event_json FROM outbox WHERE acknowledged=0 ORDER BY rowid LIMIT 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        raw.map(|value| serde_json::from_str(&value).map_err(Into::into)).transpose()
    }
    pub fn contains(&self, operation_id: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT 1 FROM operations WHERE id=?", [operation_id], |_| Ok(())).optional()?.is_some())
    }
    pub fn acknowledged(&self, operation_id: &str, sequence: u64) -> Result<bool> {
        Ok(self.db.query_row(
            "SELECT acknowledged FROM outbox WHERE operation_id=? AND sequence=?",
            params![operation_id, sequence],
            |r| r.get::<_, bool>(0),
        )?)
    }
    pub fn terminal(&self, operation_id: &str) -> Result<Event> {
        let raw:String=self.db.query_row("SELECT event_json FROM outbox WHERE operation_id=? AND json_extract(event_json,'$.kind') IN ('succeeded','failed','cancelled','unknown') ORDER BY sequence DESC LIMIT 1",[operation_id],|r|r.get(0))?;
        Ok(serde_json::from_str(&raw)?)
    }
    pub fn bind_agent_child(&self, parent: &str, child: &str) -> Result<()> {
        let key = format!("agent-child:{child}");
        let previous: Option<String> =
            self.db.query_row("SELECT value FROM config WHERE key=?", [&key], |r| r.get(0)).optional()?;
        ensure!(previous.as_deref().is_none_or(|p| p == parent), "child belongs to another task");
        self.db.execute("INSERT OR IGNORE INTO config VALUES(?,?)", params![key, parent])?;
        Ok(())
    }
    pub fn has_active_operations(&self) -> Result<bool> {
        Ok(self
            .db
            .query_row("SELECT 1 FROM operations WHERE status IN ('received','running') LIMIT 1", [], |_| Ok(()))
            .optional()?
            .is_some())
    }
    pub fn summary(&self) -> Result<Value> {
        let identity = self.identity()?;
        let mut query = self.db.prepare("SELECT id,status,sequence FROM operations ORDER BY rowid DESC LIMIT 50")?;
        let operations = query.query_map([], |row| Ok(json!({"id":row.get::<_,String>(0)?,"status":row.get::<_,String>(1)?,"sequence":row.get::<_,u64>(2)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(
            json!({"installationId":identity.installation_id,"nodeId":identity.node_id,"epoch":identity.epoch,"server":identity.server,"pairingPending":identity.pending_pair.is_some(),"bindingRevokedAtPairReceipt":identity.revoked,"operations":operations}),
        )
    }
}

fn append_event(tx: &Transaction<'_>, dispatch: &Dispatch, kind: &str, mut data: Value) -> Result<Event> {
    let (sequence, status): (u64, String) = tx.query_row(
        "SELECT sequence,status FROM operations WHERE id=? AND dispatch_json=?",
        params![dispatch.operation_id, serde_json::to_string(dispatch)?],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    ensure!(!["succeeded", "failed", "cancelled", "unknown"].contains(&status.as_str()), "operation already terminal");
    if ["unknown", "cancelled"].contains(&kind) && serde_json::to_vec(&data)?.len() > 4096 {
        data = json!({"reason":"diagnostic_exceeds_bound","replayed":false});
    }
    let event = Event {
        event_id: id(),
        operation_id: dispatch.operation_id.clone(),
        dispatch_id: dispatch.dispatch_id.clone(),
        payload_hash: dispatch.payload_hash.clone(),
        sequence: sequence + 1,
        kind: kind.into(),
        data,
    };
    if ["output", "succeeded", "failed"].contains(&kind) {
        let parent: Option<String> = tx
            .query_row(
                "SELECT value FROM config WHERE key=?",
                [format!("agent-child:{}", dispatch.operation_id)],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(parent) = parent {
            let key = format!("agent-bytes:{parent}");
            let used: Option<String> =
                tx.query_row("SELECT value FROM config WHERE key=?", [&key], |r| r.get(0)).optional()?;
            let total = used
                .unwrap_or_else(|| "0".into())
                .parse::<usize>()?
                .checked_add(serde_json::to_vec(&event)?.len())
                .context("delegation output budget overflow")?;
            ensure!(total <= 32 * 1024 * 1024, "delegation cumulative output budget exceeded");
            tx.execute(
                "INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, total.to_string()],
            )?;
        }
    }
    tx.execute(
        "INSERT INTO outbox(operation_id,sequence,event_json) VALUES(?,?,?)",
        params![event.operation_id, event.sequence, serde_json::to_string(&event)?],
    )?;
    let next = if kind == "output" { status.as_str() } else { kind };
    tx.execute(
        "UPDATE operations SET status=?,sequence=? WHERE id=?",
        params![next, event.sequence, event.operation_id],
    )?;
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_outbox_insert_rolls_back_admission_and_terminal_state() -> Result<()> {
        let parent = fs::canonicalize(std::env::temp_dir())?;
        let root = parent.join(format!("reach-ledger-test-{}", id()));
        let mut ledger = Ledger::open(&root)?;
        let dispatch = Dispatch {
            operation_id: id(),
            node_id: id(),
            epoch: 1,
            dispatch_id: id(),
            payload_hash: "a".repeat(64),
            command: json!({"kind":"directory.list","path":"."}),
            created_at: 1,
        };
        ledger.db.execute_batch("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected durable storage failure'); END;")?;
        assert!(ledger.accept(&dispatch).is_err());
        assert!(!ledger.contains(&dispatch.operation_id)?);
        ledger.db.execute_batch("DROP TRIGGER reject_outbox;")?;
        assert!(ledger.accept(&dispatch)?);
        assert_eq!(ledger.next_event()?.unwrap().sequence, 1);
        ledger.db.execute_batch("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected durable storage failure'); END;")?;
        assert!(ledger.event(&dispatch, "unknown", json!({"reason":"test"})).is_err());
        let state: (String, u64) =
            ledger.db.query_row("SELECT status,sequence FROM operations", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
        assert_eq!(state, ("received".into(), 1));
        drop(ledger);
        let checked = fs::canonicalize(&root)?;
        ensure!(checked.parent() == Some(parent.as_path()), "unexpected test directory");
        fs::remove_dir_all(checked)?;
        Ok(())
    }
}
