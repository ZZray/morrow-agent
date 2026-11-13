// Copyright (c) Ray Zhang. Shared by foreground CLI and the single service owner.
use crate::{api, ledger::Ledger, protocol};
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairInput {
    pub server: String,
    pub code: String,
    pub name: Option<String>,
    pub development: bool,
}

pub async fn pair(ledger: &mut Ledger, input: PairInput) -> Result<Value> {
    let request_hash = protocol::hash(&serde_json::to_vec(&input)?);
    let PairInput { server, code, name, development } = input;
    let mut identity = ledger.identity()?;
    if identity.pending_pair.is_none() {
        if let Some(receipt) = ledger.pair_receipt(&request_hash)? {
            let mut summary = ledger.summary()?;
            summary["pairingReceipt"] = receipt;
            summary["pairingReplay"] = Value::Bool(true);
            return Ok(summary);
        }
    }
    let input = if let Some(prior) = identity.pending_pair.clone() {
        if prior["server"] != server
            || prior["input"]["code"] != code
            || (!prior["requestHash"].is_null() && prior["requestHash"] != request_hash)
        {
            bail!("an existing pairing attempt must be retried with its original server and code");
        }
        prior["input"].clone()
    } else {
        ensure!((8..=32).contains(&code.encode_utf16().count()), "pairing code must contain 8 to 32 characters");
        let name = name.unwrap_or_else(|| std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Reach node".into()));
        ensure!((1..=128).contains(&name.encode_utf16().count()), "node name must contain 1 to 128 characters");
        ensure!(
            identity.server.as_ref().is_none_or(|current| current == &server),
            "moving an existing binding to another server requires migration; original identity retained"
        );
        ensure!(ledger.next_event()?.is_none(), "upload original receipts before replacing the pairing");
        ensure!(
            !ledger.has_active_operations()?,
            "run the original binding to recover interrupted operations before replacing pairing"
        );
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|_| anyhow::anyhow!("random source failed"))?;
        let platform = if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS };
        let input = json!({"attemptId":protocol::id(),"code":code,"installationId":identity.installation_id,"installationSecret":URL_SAFE_NO_PAD.encode(secret),"name":name,"platform":platform,"version":env!("CARGO_PKG_VERSION")});
        // Validate the network destination before saving a pending attempt.
        api::Api::new(&server, &identity.secret, development)?;
        identity.pending_pair =
            Some(json!({"server":server,"development":development,"input":input,"requestHash":request_hash}));
        ledger.save_identity(&identity)?;
        input
    };
    let pending = identity.pending_pair.as_ref().context("pending pairing missing")?;
    let api = api::Api::new(&server, &identity.secret, pending["development"].as_bool().unwrap_or(false))?;
    let response = match api.call(Method::POST, "/api/v1/node/pair", Some(&input)).await {
        Ok(value) => value,
        Err(error) => {
            // The service checks prior attempt IDs before rejecting the code.
            // Only this definitive rejection can release a persisted attempt.
            if error.downcast_ref::<api::HttpError>().is_some_and(|e| {
                (e.status == 400 && ["invalid_pairing_code", "invalid_request"].contains(&e.code.as_str()))
                    || (e.status == 409 && ["operations_unsettled", "installation_owned"].contains(&e.code.as_str()))
            }) {
                identity.pending_pair = None;
                ledger.save_identity(&identity)?;
            }
            return Err(error);
        }
    };
    let pending = identity.pending_pair.as_ref().context("pending pairing missing")?;
    identity.node_id = Some(response["nodeId"].as_str().context("pairing response missing node ID")?.into());
    identity.epoch = response["epoch"].as_u64().context("pairing response missing epoch")?;
    identity.revoked = response["revoked"].as_bool().context("pairing response missing binding status")?;
    identity.secret = input["installationSecret"].as_str().context("installation credential missing")?.into();
    identity.server = Some(server);
    identity.development = pending["development"].as_bool().unwrap_or(false);
    identity.pending_pair = None;
    identity.last_pair = Some(json!({"requestHash":request_hash,"nodeId":identity.node_id,"epoch":identity.epoch}));
    let receipt = ledger.complete_pair(&identity, &request_hash)?;
    let mut summary = ledger.summary()?;
    summary["pairingReceipt"] = receipt;
    summary["pairingReplay"] = Value::Bool(false);
    Ok(summary)
}
