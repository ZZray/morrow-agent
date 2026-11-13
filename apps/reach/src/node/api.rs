// Copyright (c) Ray Zhang.
use anyhow::{ensure, Result};
use reqwest::{Client, Method, Url};
use serde_json::Value;
use std::time::Duration;

#[derive(Debug)]
pub struct HttpError {
    pub status: u16,
    pub code: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_address_preserves_only_the_supported_mount() {
        for value in ["https://118.25.103.226", "https://118.25.103.226/", "https://118.25.103.226/reach"] {
            assert!(Api::new(value, "", false).is_ok(), "{value}");
        }
        for value in [
            "https://example.test/reach/",
            "https://example.test/reach/../reach",
            "https://example.test/%72each",
            "https://example.test/other",
            "https://user@example.test/reach",
            "https://example.test/reach?q=1",
            "https://example.test/reach#x",
            "http://118.25.103.226/reach",
        ] {
            assert!(Api::new(value, "", false).is_err(), "{value}");
        }
    }
}
impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Reach HTTP {}: {}", self.status, self.code)
    }
}
impl std::error::Error for HttpError {}
impl HttpError {
    pub fn permanent(&self) -> bool {
        (400..500).contains(&self.status) && ![408, 429].contains(&self.status)
    }
}

#[derive(Clone)]
pub struct Api {
    client: Client,
    origin: String,
    token: String,
}
impl Api {
    // Dedicated model transport: no ordinary API total timeout or JSON buffering.
    pub fn model_client(&self) -> Result<Client> {
        Ok(Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()?)
    }
    pub async fn model_request(
        &self,
        client: &Client,
        parent: &crate::protocol::Dispatch,
        run: &str,
        route_hash: &str,
        request_id: &str,
        body: Vec<u8>,
    ) -> Result<reqwest::Response> {
        client
            .post(format!("{}/api/v1/node/agents/{}/model/requests/{request_id}", self.origin, parent.operation_id))
            .bearer_auth(&self.token)
            .header("content-type", "application/json")
            .header("x-reach-dispatch-id", &parent.dispatch_id)
            .header("x-reach-payload-hash", &parent.payload_hash)
            .header("x-reach-run-id", run)
            .header("x-reach-model-route", route_hash)
            .body(body)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("model request connection failed; no replay"))
    }
    pub fn new(origin: &str, token: &str, development: bool) -> Result<Self> {
        let url = Url::parse(origin)?;
        ensure!(
            url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && ["/", "/reach"].contains(&url.path())
                && (origin == url.origin().ascii_serialization()
                    || origin == format!("{}/", url.origin().ascii_serialization())
                    || origin == format!("{}/reach", url.origin().ascii_serialization())),
            "server must be a canonical HTTPS origin, optionally followed by /reach"
        );
        let loopback = url.host_str().is_some_and(|host| ["127.0.0.1", "[::1]"].contains(&host));
        ensure!(
            url.scheme() == "https" || (development && loopback && url.scheme() == "http"),
            "valid HTTPS required; development HTTP permits literal loopback only"
        );
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12))
            .build()?;
        Ok(Self { client, origin: origin.trim_end_matches('/').into(), token: token.into() })
    }
    pub async fn call(&self, method: Method, route: &str, body: Option<&Value>) -> Result<Value> {
        let mut request = self.client.request(method, format!("{}{route}", self.origin));
        if !self.token.is_empty() {
            request = request.bearer_auth(&self.token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let mut response =
            request.send().await.map_err(|_| anyhow::anyhow!("Reach connection failed; original receipts retained"))?;
        let status = response.status();
        ensure!(response.content_length().unwrap_or(0) <= 2_097_152, "Reach response exceeds limit");
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(bytes.len() + chunk.len() <= 2_097_152, "Reach response exceeds limit");
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)?;
        if !status.is_success() {
            return Err(HttpError {
                status: status.as_u16(),
                code: value["error"]["code"].as_str().unwrap_or("request_failed").into(),
            }
            .into());
        }
        Ok(value)
    }
}
