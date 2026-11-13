// Copyright (c) Ray Zhang. Task-bound loopback transport; organization credentials never reach the sidecar.
use crate::{
    api::Api,
    protocol::{self, Dispatch},
};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
    task::{JoinHandle, JoinSet},
};

pub struct Relay {
    pub endpoint: String,
    pub token: String,
    task: JoinHandle<Result<()>>,
    run: watch::Sender<String>,
    admission: Arc<Semaphore>,
}
#[derive(Clone)]
struct Binding {
    api: Api,
    parent: Dispatch,
    run: watch::Receiver<String>,
    route: String,
    token: String,
    root: PathBuf,
    client: reqwest::Client,
    signal: watch::Sender<bool>,
    admission: Arc<Semaphore>,
}
impl Relay {
    pub async fn bind(
        api: Api,
        parent: Dispatch,
        run: String,
        route: String,
        root: PathBuf,
        stop: watch::Receiver<bool>,
        signal: watch::Sender<bool>,
    ) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("relay entropy unavailable"))?;
        use base64::Engine;
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        Self::serve_on(listener, token, api, parent, run, route, root, stop, signal).await
    }
    /// Resume authority includes the exact endpoint and token. Never substitute a free port.
    #[allow(clippy::too_many_arguments)]
    pub async fn rebind(
        api: Api,
        parent: Dispatch,
        run: String,
        route: String,
        root: PathBuf,
        endpoint: &str,
        token: &str,
        stop: watch::Receiver<bool>,
        signal: watch::Sender<bool>,
    ) -> Result<Self> {
        let url = reqwest::Url::parse(endpoint)?;
        ensure!(
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/v1"
                && url.query().is_none()
                && url.fragment().is_none(),
            "original relay endpoint is invalid"
        );
        let port = url.port().context("original relay port missing")?;
        ensure!(port != 0 && endpoint == format!("http://127.0.0.1:{port}/v1"), "relay endpoint is not exact");
        use base64::Engine;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(token)?;
        ensure!(
            bytes.len() == 32 && base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes) == token,
            "original relay token is invalid"
        );
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .context("original relay port unavailable; no replacement permitted")?;
        Self::serve_on(listener, token.into(), api, parent, run, route, root, stop, signal).await
    }
    #[allow(clippy::too_many_arguments)]
    async fn serve_on(
        listener: TcpListener,
        token: String,
        api: Api,
        parent: Dispatch,
        run: String,
        route: String,
        root: PathBuf,
        mut stop: watch::Receiver<bool>,
        signal: watch::Sender<bool>,
    ) -> Result<Self> {
        let endpoint = format!("http://{}/v1", listener.local_addr()?);
        let (run_tx, run_rx) = watch::channel(run);
        let admission = Arc::new(Semaphore::new(1));
        let binding = Binding {
            client: api.model_client()?,
            api,
            parent,
            run: run_rx,
            route,
            token: token.clone(),
            root,
            signal,
            admission: admission.clone(),
        };
        let task = tokio::spawn(async move {
            let mut calls = JoinSet::new();
            loop {
                if *stop.borrow() {
                    break;
                }
                tokio::select! {biased;
                    _=stop.changed()=>break,
                    _=calls.join_next(),if !calls.is_empty()=>{},
                    accepted=listener.accept()=>{let (socket,peer)=accepted?;if !peer.ip().is_loopback()||calls.len()>=4{drop(socket);continue;}
                        let binding=binding.clone();let mut cancelled=stop.clone();calls.spawn(async move {let _=tokio::select!{biased;_=cancelled.changed()=>Ok(()),_=tokio::time::sleep(Duration::from_secs(610))=>Err(anyhow::anyhow!("model relay deadline")),result=async{let _permit=binding.admission.acquire().await?;serve(socket,&binding).await}=>result};});
                    }
                }
            }
            calls.abort_all();
            while calls.join_next().await.is_some() {}
            Ok(())
        });
        Ok(Self { endpoint, token, task, run: run_tx, admission })
    }
    pub fn finished(&self) -> bool {
        self.task.is_finished()
    }
    pub async fn switch_run(&self, previous: &str, next: &str) -> Result<()> {
        let _permit = tokio::time::timeout(Duration::from_secs(3), self.admission.acquire()).await??;
        ensure!(*self.run.borrow() == previous, "relay previous Run changed");
        self.run.send(next.to_owned()).context("relay Run owner ended")?;
        Ok(())
    }
    pub async fn close(self) -> Result<()> {
        self.task.await??;
        Ok(())
    }
}
async fn serve(mut socket: TcpStream, b: &Binding) -> Result<()> {
    let mut authenticated = false;
    let outcome=async {
        let header_deadline=tokio::time::Instant::now()+Duration::from_secs(2);
        let mut bytes=Vec::new();let header_end=loop{ensure!(bytes.len()<16_384,"relay headers exceed bound");let mut byte=[0u8;1];ensure!(tokio::time::timeout_at(header_deadline,socket.read(&mut byte)).await??==1,"relay request closed");bytes.push(byte[0]);if bytes.ends_with(b"\r\n\r\n"){break bytes.len();}};
        let header=std::str::from_utf8(&bytes[..header_end])?;let mut lines=header.split("\r\n");ensure!(lines.next()==Some("POST /v1/chat/completions HTTP/1.1"),"relay route rejected");
        let mut headers=BTreeMap::new();for line in lines.filter(|s|!s.is_empty()){let (name,value)=line.split_once(':').context("invalid relay header")?;ensure!(headers.insert(name.to_ascii_lowercase(),value.trim().to_owned()).is_none(),"duplicate relay header");}
        ensure!(headers.get("authorization")==Some(&format!("Bearer {}",b.token))&&!headers.contains_key("origin")&&!headers.contains_key("transfer-encoding"),"relay credential or framing rejected");
        authenticated=true;
        ensure!(headers.get("content-type").is_some_and(|v|v.split(';').next()==Some("application/json")),"relay JSON required");
        let length=headers.get("content-length").context("relay content length required")?.parse::<usize>()?;ensure!(length>0&&length<=32*1024*1024,"relay request size rejected");
        let mut body=vec![0;length];socket.read_exact(&mut body).await?;let _:Value=serde_json::from_slice(&body)?;
        let run=b.run.borrow().clone();
        super::agent_resume::admit(&b.api,&b.parent,&b.root,&run).await?;
        let request=protocol::id();super::agent::save_new(&b.root.join(format!("model-{request}.json")),&json!({"requestId":request,"parentId":b.parent.operation_id,"runId":run,"bodySha256":protocol::hash(&body),"routeHash":b.route}))?;
        let body_hash=protocol::hash(&body);let mut response=b.api.model_request(&b.client,&b.parent,&run,&b.route,&request,body).await?;
        let status=response.status().as_u16();let event=response.status().is_success()&&response.headers().get("content-type").is_some_and(|v|v.as_bytes().starts_with(b"text/event-stream"));
        ensure!(event,"broker model request rejected with status {status}");
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await?;
        let mut count=0usize;let mut pending=Vec::new();let mut done=false;
        while let Some(chunk)=response.chunk().await?{count=count.checked_add(chunk.len()).context("model byte overflow")?;ensure!(count<=8*1024*1024,"model response exceeds bound");pending.extend_from_slice(&chunk);
            while let Some(index)=pending.windows(2).position(|b|b==b"\n\n"){let frame:Vec<u8>=pending.drain(..index+2).collect();ensure!(frame.len()<=2*1024*1024&&!done,"invalid broker frame sequence");if frame==b"data: [DONE]\n\n"{done=true;}else{write_chunk(&mut socket,&frame).await?;}}
            ensure!(pending.len()<=2*1024*1024,"broker frame exceeds bound");
        }
        ensure!(pending.is_empty(),"incomplete broker frame");
        let settlement=b.api.call(reqwest::Method::POST,&format!("/api/v1/node/agents/{}/model/requests/{request}/status",b.parent.operation_id),Some(&json!({"dispatchId":b.parent.dispatch_id,"payloadHash":b.parent.payload_hash}))).await?;
        ensure!(settlement["state"]=="stream_complete"&&settlement["request_id"]==request&&settlement["run_id"]==run&&settlement["body_sha256"]==body_hash,"original model stream is not durably complete");
        super::agent::save_new(&b.root.join(format!("model-{request}-transport.json")),&json!({"requestId":request,"responseBytes":count,"transport":"stream_complete","settlement":settlement,"taskAccepted":false}))?;
        if done{write_chunk(&mut socket,b"data: [DONE]\n\n").await?;}
        socket.write_all(b"0\r\n\r\n").await?;
        socket.shutdown().await?;Ok(())
    }.await;
    if outcome.is_err() {
        if authenticated {
            let _ = b.signal.send(true);
        }
        let _ = socket.shutdown().await;
    }
    outcome
}
async fn write_chunk(socket: &mut TcpStream, bytes: &[u8]) -> Result<()> {
    socket.write_all(format!("{:x}\r\n", bytes.len()).as_bytes()).await?;
    socket.write_all(bytes).await?;
    socket.write_all(b"\r\n").await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn an_unauthenticated_loopback_request_does_not_cancel_the_authorized_task() -> Result<()> {
        let api = Api::new("http://127.0.0.1:9", "node-test-token", true)?;
        let parent = Dispatch {
            operation_id: protocol::id(),
            node_id: protocol::id(),
            epoch: 1,
            dispatch_id: protocol::id(),
            payload_hash: "a".repeat(64),
            command: json!({"kind":"agent.delegate"}),
            created_at: 1,
        };
        let (signal, stop) = watch::channel(false);
        let relay = Relay::bind(
            api,
            parent,
            protocol::id(),
            "a".repeat(64),
            std::env::temp_dir(),
            stop.clone(),
            signal.clone(),
        )
        .await?;
        let result = reqwest::Client::new()
            .post(format!("{}/chat/completions", relay.endpoint))
            .bearer_auth("wrong-token")
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await;
        ensure!(result.is_err(), "unauthenticated request must not reach the broker");
        ensure!(!*stop.borrow() && !relay.finished(), "unauthenticated client cancelled a task");
        let _ = signal.send(true);
        relay.close().await?;
        Ok(())
    }
    #[tokio::test]
    async fn exact_rebind_preserves_port_and_token_and_never_chooses_a_substitute() -> Result<()> {
        let api = Api::new("http://127.0.0.1:9", "node-test-token", true)?;
        let parent = Dispatch {
            operation_id: protocol::id(),
            node_id: protocol::id(),
            epoch: 1,
            dispatch_id: protocol::id(),
            payload_hash: "a".repeat(64),
            command: json!({"kind":"agent.delegate"}),
            created_at: 1,
        };
        let (signal, stop) = watch::channel(false);
        let original = Relay::bind(
            api.clone(),
            parent.clone(),
            protocol::id(),
            "a".repeat(64),
            std::env::temp_dir(),
            stop,
            signal.clone(),
        )
        .await?;
        let endpoint = original.endpoint.clone();
        let token = original.token.clone();
        let (next_signal, next_stop) = watch::channel(false);
        let occupied = Relay::rebind(
            api.clone(),
            parent.clone(),
            protocol::id(),
            "a".repeat(64),
            std::env::temp_dir(),
            &endpoint,
            &token,
            next_stop.clone(),
            next_signal.clone(),
        )
        .await;
        ensure!(occupied.is_err(), "an occupied original port must refuse resume");
        let _ = signal.send(true);
        original.close().await?;
        let restored = Relay::rebind(
            api.clone(),
            parent.clone(),
            protocol::id(),
            "a".repeat(64),
            std::env::temp_dir(),
            &endpoint,
            &token,
            next_stop.clone(),
            next_signal.clone(),
        )
        .await?;
        ensure!(restored.endpoint == endpoint && restored.token == token, "relay authority changed");
        for wrong in [
            endpoint.replace("127.0.0.1", "localhost"),
            format!("{endpoint}?replacement=1"),
            "http://127.0.0.1:0/v1".into(),
            endpoint.replace("/v1", "/other"),
        ] {
            ensure!(
                Relay::rebind(
                    api.clone(),
                    parent.clone(),
                    protocol::id(),
                    "a".repeat(64),
                    std::env::temp_dir(),
                    &wrong,
                    &token,
                    next_stop.clone(),
                    next_signal.clone()
                )
                .await
                .is_err(),
                "non-exact relay accepted"
            );
        }
        let _ = next_signal.send(true);
        restored.close().await?;
        let (last_signal, last_stop) = watch::channel(false);
        ensure!(
            Relay::rebind(
                api,
                parent,
                protocol::id(),
                "a".repeat(64),
                std::env::temp_dir(),
                &endpoint,
                "invalid-token",
                last_stop,
                last_signal
            )
            .await
            .is_err(),
            "changed token format accepted"
        );
        Ok(())
    }
}
