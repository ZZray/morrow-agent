// Copyright (c) Ray Zhang. Starferry transport merged into Reach Node (REQ-01).
// Provenance: adapted from ARA `tools/ssh-tunnel` (`direct.go`, `device.go`, `common.go`, Copyright 2026 Ray Zhang, MIT),
// aligned to Reach persistent (nodeId, epoch) identity, scoped SSH key grants, and structured operation receipts.
use crate::{api::Api, control::Control, ledger::Ledger, protocol::Dispatch};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::HashMap,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
    sync::{mpsc, watch, Notify},
    time::Instant,
};

const MAGIC: &[u8; 4] = b"RYSF";
const PKT_HELLO: u8 = 1;
const PKT_HELLO_ACK: u8 = 2;
const PKT_OPEN: u8 = 3;
const PKT_OPEN_ACK: u8 = 4;
const PKT_DATA: u8 = 5;
const PKT_ACK: u8 = 6;
const PKT_EOF: u8 = 7;
const PKT_CLOSE: u8 = 8;

const HEADER_LEN: usize = 19;
const MAC_LEN: usize = 16;
const MAX_PAYLOAD: usize = 1200;
const MAX_STREAMS: usize = 16;
const MAX_DIRECT_HELLO_PEERS: usize = 16;
const MAX_RELAY_B64_CHARS: usize = 88_000;
const DEFAULT_STUN_SERVERS: [&str; 2] = ["stun.cloudflare.com:3478", "stun.l.google.com:19302"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candidate {
    pub host: String,
    pub port: u16,
    pub kind: String,
}

fn hmac_sha256_trunc16(key: &[u8; 32], message: &[u8]) -> [u8; 16] {
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..32 {
        ipad[i] ^= key[i];
        opad[i] ^= key[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    let full = outer.finalize();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

fn constant_time_eq_16(a: &[u8; 16], b: &[u8; 16]) -> bool {
    let mut diff = 0u8;
    for i in 0..16 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn push_len_prefixed(hasher: &mut Sha256, part: &[u8]) {
    hasher.update((part.len() as u32).to_be_bytes());
    hasher.update(part);
}

pub fn derive_dir_key(session_id: &str, controller_hex: &str, node_hex: &str, dir: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    push_len_prefixed(&mut h, b"ry-starferry-v1");
    push_len_prefixed(&mut h, session_id.as_bytes());
    push_len_prefixed(&mut h, &controller_hex.to_ascii_lowercase().into_bytes());
    push_len_prefixed(&mut h, &node_hex.to_ascii_lowercase().into_bytes());
    push_len_prefixed(&mut h, dir.as_bytes());
    let digest = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn encode_packet(key: &[u8; 32], pkt_type: u8, stream_id: u32, seq: u32, ack: u32, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(HEADER_LEN + payload.len() + MAC_LEN);
    buf.extend_from_slice(MAGIC);
    buf.push(pkt_type);
    buf.extend_from_slice(&stream_id.to_be_bytes());
    buf.extend_from_slice(&seq.to_be_bytes());
    buf.extend_from_slice(&ack.to_be_bytes());
    buf.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    buf.extend_from_slice(payload);
    let tag = hmac_sha256_trunc16(key, &buf);
    buf.extend_from_slice(&tag);
    buf
}

fn decode_packet(key: &[u8; 32], raw: &[u8]) -> Option<(u8, u32, u32, u32, Vec<u8>)> {
    if raw.len() < HEADER_LEN + MAC_LEN || &raw[..4] != MAGIC {
        return None;
    }
    let pkt_type = raw[4];
    let stream_id = u32::from_be_bytes([raw[5], raw[6], raw[7], raw[8]]);
    let seq = u32::from_be_bytes([raw[9], raw[10], raw[11], raw[12]]);
    let ack = u32::from_be_bytes([raw[13], raw[14], raw[15], raw[16]]);
    let len = u16::from_be_bytes([raw[17], raw[18]]) as usize;
    if len > MAX_PAYLOAD || raw.len() != HEADER_LEN + len + MAC_LEN {
        return None;
    }
    let body_end = HEADER_LEN + len;
    let mut wire_tag = [0u8; 16];
    wire_tag.copy_from_slice(&raw[body_end..]);
    let expected = hmac_sha256_trunc16(key, &raw[..body_end]);
    if !constant_time_eq_16(&wire_tag, &expected) {
        return None;
    }
    Some((pkt_type, stream_id, seq, ack, raw[HEADER_LEN..body_end].to_vec()))
}

fn bind_dual_stack_udp() -> io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_only_v6(false)?;
    socket.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)).into())?;
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket.into())
}

fn endpoint_on_socket(peer: SocketAddr, dual_stack: bool) -> Option<SocketAddr> {
    match (peer, dual_stack) {
        (SocketAddr::V4(addr), true) => Some(SocketAddr::from((addr.ip().to_ipv6_mapped(), addr.port()))),
        (SocketAddr::V6(_), false) => None,
        _ => Some(peer),
    }
}

fn scope_free_ipv6(ip: Ipv6Addr) -> bool {
    !ip.is_unspecified() && !ip.is_unicast_link_local() && !ip.is_multicast() && ip.to_ipv4_mapped().is_none()
}

async fn query_stun_srflx(sock: &UdpSocket, stun_addr: &str) -> Option<Candidate> {
    let stun_addr = stun_addr.strip_prefix("stun:").unwrap_or(stun_addr);
    let target: SocketAddr = tokio::net::lookup_host(stun_addr).await.ok()?.find(SocketAddr::is_ipv4)?;
    let target = endpoint_on_socket(target, sock.local_addr().ok()?.is_ipv6())?;
    let mut tx_id = [0u8; 12];
    getrandom::fill(&mut tx_id).ok()?;
    let mut req = Vec::with_capacity(20);
    req.extend_from_slice(&0x0001u16.to_be_bytes());
    req.extend_from_slice(&0u16.to_be_bytes());
    req.extend_from_slice(&0x2112A442u32.to_be_bytes());
    req.extend_from_slice(&tx_id);
    sock.send_to(&req, target).await.ok()?;
    let mut buf = [0u8; 512];
    let n = loop {
        let (n, source) = sock.recv_from(&mut buf).await.ok()?;
        if source == target
            && n >= 20
            && u16::from_be_bytes([buf[0], buf[1]]) == 0x0101
            && buf[4..8] == 0x2112A442u32.to_be_bytes()
            && buf[8..20] == tx_id
        {
            break n;
        }
    };
    let msg_len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    let end = 20 + msg_len;
    if end != n {
        return None;
    }
    let mut pos = 20usize;
    while pos + 4 <= end {
        let attr_type = u16::from_be_bytes([buf[pos], buf[pos + 1]]);
        let attr_len = u16::from_be_bytes([buf[pos + 2], buf[pos + 3]]) as usize;
        pos += 4;
        if pos + attr_len > end {
            break;
        }
        if attr_type == 0x0020 && attr_len == 8 && buf[pos + 1] == 0x01 {
            let xport = u16::from_be_bytes([buf[pos + 2], buf[pos + 3]]) ^ 0x2112;
            if xport == 0 {
                return None;
            }
            let xip = u32::from_be_bytes([buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]]) ^ 0x2112A442;
            let ip = Ipv4Addr::from(xip);
            return Some(Candidate { host: ip.to_string(), port: xport, kind: "srflx".into() });
        }
        pos += (attr_len + 3) & !3;
    }
    None
}

fn host_candidate_for_route(peer: SocketAddr, session_port: u16) -> Option<Candidate> {
    let probe = std::net::UdpSocket::bind(if peer.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" }).ok()?;
    probe.connect(peer).ok()?;
    let ip = probe.local_addr().ok()?.ip();
    if ip.is_unspecified() || ip.is_loopback() || matches!(ip, IpAddr::V6(v6) if !scope_free_ipv6(v6)) {
        return None;
    }
    Some(Candidate { host: ip.to_string(), port: session_port, kind: "host".into() })
}

async fn gather_candidates(sock: &UdpSocket, development: bool, controller_peers: &[SocketAddr]) -> Vec<Candidate> {
    let mut out = Vec::new();
    let Ok(local_addr) = sock.local_addr() else {
        return out;
    };
    let port = local_addr.port();
    out.extend(host_candidate_for_route(SocketAddr::from(([198, 51, 100, 1], 80)), port));
    if local_addr.is_ipv6() {
        // Ask the OS for the source address it would use to reach each IPv6 peer.
        // UDP connect on the probe socket selects a route without sending a packet.
        for peer in controller_peers.iter().copied().filter(SocketAddr::is_ipv6).take(7) {
            if let Some(candidate) = host_candidate_for_route(peer, port) {
                if !out.iter().any(|existing| existing.host == candidate.host) {
                    out.push(candidate);
                }
            }
        }
    }
    if development || std::env::var_os("REACH_DEV_STARFERRY_LOOPBACK").is_some() {
        out.push(Candidate { host: "127.0.0.1".into(), port, kind: "host".into() });
        if local_addr.is_ipv6() {
            out.push(Candidate { host: "::1".into(), port, kind: "host".into() });
        }
    }
    let servers = std::env::var("REACH_STUN_SERVER")
        .map(|server| vec![server])
        .unwrap_or_else(|_| DEFAULT_STUN_SERVERS.iter().map(|server| (*server).to_owned()).collect());
    for server in servers {
        if server.trim().is_empty() {
            continue;
        }
        // Includes DNS and receive time; an unreachable STUN server must not stall relay.
        if let Ok(Some(srflx)) =
            tokio::time::timeout(Duration::from_millis(500), query_stun_srflx(sock, server.trim())).await
        {
            out.push(srflx);
            break;
        }
    }
    out
}

enum DirectInbound {
    Data(u32, Vec<u8>),
    Eof(u32),
    Close,
}

struct DirectStreamControl {
    tx: mpsc::Sender<DirectInbound>,
    highest_acked: Arc<AtomicU32>,
    ack_notify: Arc<Notify>,
}

#[allow(clippy::too_many_arguments)]
async fn serve_direct_udp(
    udp: Arc<UdpSocket>,
    ssh_port: u16,
    c2n_key: [u8; 32],
    n2c_key: [u8; 32],
    initial_peers: Vec<SocketAddr>,
    mut shutdown: watch::Receiver<bool>,
    direct_streams_counter: Arc<AtomicUsize>,
) {
    let mut hello_peers = Vec::new();
    let mut pinned_peer = None;
    let mut streams: HashMap<u32, DirectStreamControl> = HashMap::new();
    let mut highest_opened_stream_id = 0u32;

    for cand in &initial_peers {
        let hello = encode_packet(&n2c_key, PKT_HELLO, 0, 0, 0, b"node-hello");
        let _ = udp.send_to(&hello, cand).await;
    }

    let mut recv_buf = [0u8; 2048];
    let mut cleanup_tick = tokio::time::interval(Duration::from_millis(200));
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            _ = cleanup_tick.tick() => {
                streams.retain(|_, ctrl| !ctrl.tx.is_closed());
            }
            recv_res = udp.recv_from(&mut recv_buf) => {
                let Ok((n, src)) = recv_res else { continue; };
                let Some((pkt_type, stream_id, seq, ack, payload)) = decode_packet(&c2n_key, &recv_buf[..n]) else {
                    continue;
                };
                match pinned_peer {
                    Some(existing) if existing != src => continue,
                    None if !hello_peers.contains(&src) => {
                        // A HELLO may have reached us over a one-way path. Keep
                        // other candidates eligible until the controller opens a stream.
                        if pkt_type != PKT_HELLO || hello_peers.len() >= MAX_DIRECT_HELLO_PEERS {
                            continue;
                        }
                        hello_peers.push(src);
                    }
                    _ => {}
                }
                match pkt_type {
                    PKT_HELLO => {
                        let ack_pkt = encode_packet(&n2c_key, PKT_HELLO_ACK, 0, 0, 0, b"node-hello-ack");
                        let _ = udp.send_to(&ack_pkt, src).await;
                    }
                    PKT_OPEN if stream_id > 0 => {
                        streams.retain(|_, ctrl| !ctrl.tx.is_closed());
                        if let Some(_existing) = streams.get(&stream_id) {
                            // Retransmitted OPEN_STREAM for currently open stream
                            let open_ack = encode_packet(&n2c_key, PKT_OPEN_ACK, stream_id, 0, 0, &[]);
                            let _ = udp.send_to(&open_ack, src).await;
                            continue;
                        }
                        // Anti-replay: reject retired/non-monotonic stream IDs!
                        if stream_id <= highest_opened_stream_id {
                            continue;
                        }
                        if streams.len() >= MAX_STREAMS {
                            let rej = encode_packet(&n2c_key, PKT_CLOSE, stream_id, 0, 0, b"stream_limit");
                            let _ = udp.send_to(&rej, src).await;
                            continue;
                        }
                        pinned_peer.get_or_insert(src);
                        highest_opened_stream_id = stream_id;
                        let (tx, mut rx) = mpsc::channel::<DirectInbound>(128);
                        let highest_acked = Arc::new(AtomicU32::new(0));
                        let ack_notify = Arc::new(Notify::new());
                        streams.insert(stream_id, DirectStreamControl {
                            tx,
                            highest_acked: highest_acked.clone(),
                            ack_notify: ack_notify.clone(),
                        });
                        direct_streams_counter.fetch_add(1, Ordering::SeqCst);
                        let udp_clone = udp.clone();
                        let mut sub_shutdown = shutdown.clone();
                        tokio::spawn(async move {
                            let target_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), ssh_port);
                            let Ok(Ok(tcp)) = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(target_addr)).await else {
                                let close_pkt = encode_packet(&n2c_key, PKT_CLOSE, stream_id, 0, 0, b"connect_failed");
                                let _ = udp_clone.send_to(&close_pkt, src).await;
                                return;
                            };
                            let _ = tcp.set_nodelay(true);
                            let open_ack = encode_packet(&n2c_key, PKT_OPEN_ACK, stream_id, 0, 0, &[]);
                            let _ = udp_clone.send_to(&open_ack, src).await;

                            let (mut tcp_r, mut tcp_w) = tcp.into_split();
                            let udp_in = udp_clone.clone();
                            let c2n_task = tokio::spawn(async move {
                                let mut expected_seq = 1u32;
                                while let Some(item) = rx.recv().await {
                                    match item {
                                        DirectInbound::Data(s, bytes) => {
                                            if s == expected_seq {
                                                if tcp_w.write_all(&bytes).await.is_err() {
                                                    break;
                                                }
                                                expected_seq = expected_seq.saturating_add(1);
                                            }
                                            if s < expected_seq {
                                                let acked = expected_seq.saturating_sub(1);
                                                let pkt = encode_packet(&n2c_key, PKT_ACK, stream_id, 0, acked, &[]);
                                                let _ = udp_in.send_to(&pkt, src).await;
                                            }
                                        }
                                        DirectInbound::Eof(s) => {
                                            if s == expected_seq {
                                                let _ = tcp_w.shutdown().await;
                                            }
                                        }
                                        DirectInbound::Close => break,
                                    }
                                }
                            });

                            let mut out_seq = 1u32;
                            let mut chunk = [0u8; 1024];
                            loop {
                                tokio::select! {
                                    ch = sub_shutdown.changed() => {
                                        if ch.is_err() || *sub_shutdown.borrow() {
                                            break;
                                        }
                                    }
                                    read_res = tcp_r.read(&mut chunk) => {
                                        match read_res {
                                            Ok(0) => {
                                                let eof_pkt = encode_packet(&n2c_key, PKT_EOF, stream_id, out_seq, 0, &[]);
                                                let _ = udp_clone.send_to(&eof_pkt, src).await;
                                                break;
                                            }
                                            Ok(len) => {
                                                let seq_now = out_seq;
                                                out_seq = out_seq.saturating_add(1);
                                                let data_pkt = encode_packet(&n2c_key, PKT_DATA, stream_id, seq_now, 0, &chunk[..len]);
                                                let mut delivered = false;
                                                for _attempt in 0..25 {
                                                    let _ = udp_clone.send_to(&data_pkt, src).await;
                                                    if highest_acked.load(Ordering::SeqCst) >= seq_now {
                                                        delivered = true;
                                                        break;
                                                    }
                                                    let _ = tokio::time::timeout(Duration::from_millis(80), ack_notify.notified()).await;
                                                    if highest_acked.load(Ordering::SeqCst) >= seq_now {
                                                        delivered = true;
                                                        break;
                                                    }
                                                }
                                                if !delivered {
                                                    break;
                                                }
                                            }
                                            Err(_) => break,
                                        }
                                    }
                                }
                            }
                            let _ = tokio::time::timeout(Duration::from_secs(2), c2n_task).await;
                            let close_pkt = encode_packet(&n2c_key, PKT_CLOSE, stream_id, out_seq, 0, &[]);
                            let _ = udp_clone.send_to(&close_pkt, src).await;
                        });
                    }
                    PKT_DATA => {
                        if let Some(ctrl) = streams.get(&stream_id) {
                            // Non-blocking try_send avoids head-of-line blocking across streams; sender retransmits if full.
                            let _ = ctrl.tx.try_send(DirectInbound::Data(seq, payload));
                        }
                    }
                    PKT_ACK => {
                        if let Some(ctrl) = streams.get(&stream_id) {
                            ctrl.highest_acked.fetch_max(ack, Ordering::SeqCst);
                            ctrl.ack_notify.notify_waiters();
                        }
                    }
                    PKT_EOF => {
                        if let Some(ctrl) = streams.get(&stream_id) {
                            let _ = ctrl.tx.try_send(DirectInbound::Eof(seq));
                        }
                    }
                    PKT_CLOSE => {
                        if let Some(ctrl) = streams.remove(&stream_id) {
                            let _ = ctrl.tx.try_send(DirectInbound::Close);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

struct SessionGrantGuard {
    root: PathBuf,
    grant_id: String,
    disarmed: bool,
}

impl Drop for SessionGrantGuard {
    fn drop(&mut self) {
        if !self.disarmed {
            let gid = self.grant_id.clone();
            let _ = crate::ssh::revoke_grants_matching(&self.root, |g| g.grant_id == gid);
        }
    }
}

pub async fn execute_session(
    ledger: &mut Ledger,
    api: &Api,
    dispatch: &Dispatch,
    control: &mut Option<&mut Control>,
) -> Result<(String, Value)> {
    let identity = ledger.identity()?;
    let node_id = identity.node_id.as_deref().context("missing node_id")?;
    uuid::Uuid::parse_str(&dispatch.operation_id).context("invalid operation_id")?;
    let tunnel_session_id = dispatch.command["tunnelSessionId"].as_str().context("missing tunnelSessionId")?;
    uuid::Uuid::parse_str(tunnel_session_id).context("invalid tunnelSessionId")?;
    let grant_id = dispatch.command["grantId"].as_str().context("missing grantId")?;
    uuid::Uuid::parse_str(grant_id).context("invalid grantId")?;
    let public_key = dispatch.command["publicKey"].as_str().context("missing publicKey")?;
    let allow_direct = dispatch.command["allowDirect"].as_bool().unwrap_or(true);
    let controller_key_hex = dispatch.command["controllerKeyHex"].as_str().context("missing controllerKeyHex")?;
    ensure!(
        controller_key_hex.len() == 64 && controller_key_hex.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid controllerKeyHex"
    );
    let ttl_seconds = dispatch.command["ttlSeconds"].as_u64().unwrap_or(300).clamp(10, 3600);

    let auth_val = crate::ssh::authorize_paired_key(
        &ledger.root,
        node_id,
        identity.epoch,
        grant_id,
        public_key,
        identity.development,
    )?;
    let mut grant_guard =
        SessionGrantGuard { root: ledger.root.clone(), grant_id: grant_id.to_owned(), disarmed: false };

    let target = auth_val["target"].clone();
    let ssh_port = u16::try_from(target["port"].as_u64().unwrap_or(22)).unwrap_or(22);

    let mut node_key_raw = [0u8; 32];
    getrandom::fill(&mut node_key_raw).map_err(|_| anyhow::anyhow!("random source failed"))?;
    let mut node_key_hex = String::with_capacity(64);
    for b in node_key_raw {
        use std::fmt::Write as _;
        let _ = write!(node_key_hex, "{b:02x}");
    }

    let controller_peers: Vec<_> = dispatch.command["controllerCandidates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let ip: IpAddr = item["host"].as_str()?.parse().ok()?;
            let port = u16::try_from(item["port"].as_u64()?).ok()?;
            if matches!(ip, IpAddr::V6(v6) if !scope_free_ipv6(v6)) {
                return None;
            }
            Some(SocketAddr::new(ip, port))
        })
        .collect();
    let mut direct_socket: Option<Arc<UdpSocket>> = None;
    let mut node_candidates: Vec<Candidate> = Vec::new();
    if allow_direct {
        // Old controllers only send IPv4 candidates and must only receive IPv4 candidates.
        let dual_stack = controller_peers.iter().any(SocketAddr::is_ipv6);
        let socket = match dual_stack.then(bind_dual_stack_udp).and_then(|result| result.ok()) {
            Some(socket) => Some(socket),
            None => UdpSocket::bind("0.0.0.0:0").await.ok(),
        };
        if let Some(sock) = socket {
            node_candidates = gather_candidates(&sock, identity.development, &controller_peers).await;
            direct_socket = Some(Arc::new(sock));
        }
    }
    let direct_enabled = direct_socket.is_some() && !node_candidates.is_empty();

    if let Err(err) = api
        .call(
            Method::POST,
            &format!("/api/v1/node/tunnels/{tunnel_session_id}/ready"),
            Some(&json!({
                "operationId": dispatch.operation_id,
                "dispatchId": dispatch.dispatch_id,
                "target": target,
                "nodeKeyHex": node_key_hex,
                "nodeCandidates": node_candidates,
                "directEnabled": direct_enabled,
            })),
        )
        .await
    {
        return Ok(("failed".into(), json!({"error": err.to_string()})));
    }

    ledger.event(
        dispatch,
        "output",
        json!({
            "phase": "ready",
            "tunnelSessionId": tunnel_session_id,
            "grantId": grant_id,
            "directEnabled": direct_enabled,
            "target": target,
        }),
    )?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    struct ShutdownOnDrop(watch::Sender<bool>);
    impl Drop for ShutdownOnDrop {
        fn drop(&mut self) {
            let _ = self.0.send(true);
        }
    }
    let shutdown_guard = ShutdownOnDrop(shutdown_tx);

    let direct_streams_counter = Arc::new(AtomicUsize::new(0));
    let mut direct_handle = None;

    if let Some(udp) = direct_socket {
        let c2n_key = derive_dir_key(tunnel_session_id, controller_key_hex, &node_key_hex, "c2n");
        let n2c_key = derive_dir_key(tunnel_session_id, controller_key_hex, &node_key_hex, "n2c");
        let dual_stack = udp.local_addr().is_ok_and(|addr| addr.is_ipv6());
        let initial_peers =
            controller_peers.into_iter().filter_map(|peer| endpoint_on_socket(peer, dual_stack)).collect();
        let counter_clone = direct_streams_counter.clone();
        let rx_clone = shutdown_rx.clone();
        direct_handle = Some(tokio::spawn(async move {
            serve_direct_udp(udp, ssh_port, c2n_key, n2c_key, initial_peers, rx_clone, counter_clone).await;
        }));
    }

    let (relay_out_tx, mut relay_out_rx) = mpsc::channel::<Value>(256);
    let mut relay_streams: HashMap<u32, mpsc::Sender<Option<Vec<u8>>>> = HashMap::new();
    let mut relay_streams_opened = 0usize;
    let mut pending_out_frames: Vec<Value> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(ttl_seconds);
    let mut cancel_check_at = Instant::now() + Duration::from_millis(500);
    let mut cancelled = false;

    while Instant::now() < deadline {
        if crate::control::stopping(control) {
            cancelled = true;
            break;
        }
        crate::control::executing(ledger, control)?;
        if Instant::now() >= cancel_check_at {
            cancel_check_at = Instant::now() + Duration::from_millis(500);
            if let Ok(ctrl) =
                api.call(Method::GET, &format!("/api/v1/node/control/{}", dispatch.operation_id), None).await
            {
                if ctrl["revoked"] == true || ctrl["operation"]["cancel_requested"].as_i64().unwrap_or(0) != 0 {
                    cancelled = true;
                    break;
                }
            }
        }

        while pending_out_frames.len() < 48 {
            match relay_out_rx.try_recv() {
                Ok(frame) => pending_out_frames.push(frame),
                Err(_) => break,
            }
        }

        let poll_res = api
            .call(
                Method::POST,
                &format!("/api/v1/node/tunnels/{tunnel_session_id}/relay"),
                Some(&json!({ "frames": pending_out_frames })),
            )
            .await;

        let Ok(reply) = poll_res else {
            // Retain `pending_out_frames` across transient HTTP errors so active relay streams never lose bytes.
            tokio::time::sleep(Duration::from_millis(150)).await;
            continue;
        };
        let mut had_activity = !pending_out_frames.is_empty();
        pending_out_frames.clear();

        if let Some(in_frames) = reply["frames"].as_array() {
            if !in_frames.is_empty() {
                had_activity = true;
            }
            for f in in_frames {
                let Some(sid_u64) = f["streamId"].as_u64() else {
                    continue;
                };
                let Ok(sid) = u32::try_from(sid_u64) else {
                    continue;
                };
                match f["kind"].as_str().unwrap_or_default() {
                    "open" => {
                        relay_streams.retain(|_, tx| !tx.is_closed());
                        let cur_relay_len = relay_streams.len();
                        if let std::collections::hash_map::Entry::Vacant(entry) = relay_streams.entry(sid) {
                            if cur_relay_len >= MAX_STREAMS {
                                let _ = relay_out_tx
                                    .send(json!({"streamId": sid, "kind": "close", "error": "stream_limit"}))
                                    .await;
                                continue;
                            }
                            relay_streams_opened += 1;
                            let (in_tx, mut in_rx) = mpsc::channel::<Option<Vec<u8>>>(128);
                            entry.insert(in_tx);
                            let out_tx_clone = relay_out_tx.clone();
                            let mut sub_stop = shutdown_rx.clone();
                            tokio::spawn(async move {
                                let target_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), ssh_port);
                                let Ok(Ok(tcp)) =
                                    tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(target_addr)).await
                                else {
                                    let _ = out_tx_clone
                                        .send(json!({"streamId": sid, "kind": "close", "error": "local_target_unavailable"}))
                                        .await;
                                    return;
                                };
                                let _ = tcp.set_nodelay(true);
                                let (mut r, mut w) = tcp.into_split();
                                let writer = tokio::spawn(async move {
                                    while let Some(opt_chunk) = in_rx.recv().await {
                                        match opt_chunk {
                                            Some(bytes) => {
                                                if w.write_all(&bytes).await.is_err() {
                                                    break;
                                                }
                                            }
                                            None => {
                                                let _ = w.shutdown().await;
                                                break;
                                            }
                                        }
                                    }
                                });
                                let mut buf = [0u8; 16384];
                                loop {
                                    tokio::select! {
                                        ch = sub_stop.changed() => {
                                            if ch.is_err() || *sub_stop.borrow() {
                                                break;
                                            }
                                        }
                                        res = r.read(&mut buf) => {
                                            match res {
                                                Ok(0) => {
                                                    let _ = out_tx_clone.send(json!({"streamId": sid, "kind": "eof"})).await;
                                                    break;
                                                }
                                                Ok(n) => {
                                                    let encoded = STANDARD.encode(&buf[..n]);
                                                    if out_tx_clone.send(json!({"streamId": sid, "kind": "data", "dataBase64": encoded})).await.is_err() {
                                                        break;
                                                    }
                                                }
                                                Err(_) => break,
                                            }
                                        }
                                    }
                                }
                                let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
                                let _ = out_tx_clone.send(json!({"streamId": sid, "kind": "close"})).await;
                            });
                        }
                    }
                    "data" => {
                        if let Some(b64) = f["dataBase64"].as_str() {
                            if b64.len() <= MAX_RELAY_B64_CHARS {
                                if let Ok(bytes) = STANDARD.decode(b64) {
                                    if let Some(tx) = relay_streams.get(&sid) {
                                        if tx.try_send(Some(bytes)).is_err() {
                                            relay_streams.remove(&sid);
                                            let _ = relay_out_tx.try_send(json!({"streamId": sid, "kind": "close", "error": "stream_backpressure"}));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    "eof" => {
                        if let Some(tx) = relay_streams.get(&sid) {
                            let _ = tx.try_send(None);
                        }
                    }
                    "close" => {
                        relay_streams.remove(&sid);
                    }
                    _ => {}
                }
            }
        }

        if reply["closed"] == true {
            break;
        }

        tokio::time::sleep(Duration::from_millis(if had_activity { 15 } else { 80 })).await;
    }

    drop(shutdown_guard);
    if let Some(h) = direct_handle {
        let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
    }

    let cleanup = crate::ssh::revoke_grants_matching(&ledger.root, |g| g.grant_id == grant_id)?;
    ensure!(cleanup["revoked"] == true, "Starferry session SSH grant cleanup did not complete");
    grant_guard.disarmed = true;

    let direct_streams = direct_streams_counter.load(Ordering::SeqCst);
    let final_state = if cancelled { "cancelled" } else { "succeeded" };
    Ok((
        final_state.into(),
        json!({
            "tunnelSessionId": tunnel_session_id,
            "grantId": grant_id,
            "directEnabled": direct_enabled,
            "directStreams": direct_streams,
            "relayStreams": relay_streams_opened,
            "sshKeyRevoked": true,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn first_open_on_a_handshaken_path_pins_the_peer() {
        let (node, first_ip) = match bind_dual_stack_udp() {
            Ok(socket) => (socket, IpAddr::V6(Ipv6Addr::LOCALHOST)),
            Err(_) => (UdpSocket::bind("127.0.0.1:0").await.unwrap(), IpAddr::V4(Ipv4Addr::LOCALHOST)),
        };
        let node_port = node.local_addr().unwrap().port();
        let first_addr = SocketAddr::new(first_ip, node_port);
        let nominated_addr = SocketAddr::from((Ipv4Addr::LOCALHOST, node_port));
        let first_path = UdpSocket::bind(SocketAddr::new(first_ip, 0)).await.unwrap();
        let nominated_path = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let ssh = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (stop, shutdown) = watch::channel(false);
        let c2n = [1; 32];
        let n2c = [2; 32];
        let streams = Arc::new(AtomicUsize::new(0));
        let serving = tokio::spawn(serve_direct_udp(
            Arc::new(node),
            ssh.local_addr().unwrap().port(),
            c2n,
            n2c,
            vec![],
            shutdown,
            streams.clone(),
        ));
        let hello = encode_packet(&c2n, PKT_HELLO, 0, 0, 0, &[]);
        let open = encode_packet(&c2n, PKT_OPEN, 1, 0, 0, &[]);
        let mut buffer = [0; 128];
        let ack_deadline = Duration::from_millis(500);
        let quiet_window = Duration::from_millis(50);
        // Receive the first ACK to make the packet order deterministic, but never use that path for an OPEN.
        first_path.send_to(&hello, first_addr).await.unwrap();
        let (length, _) = tokio::time::timeout(ack_deadline, first_path.recv_from(&mut buffer)).await.unwrap().unwrap();
        assert_eq!(decode_packet(&n2c, &buffer[..length]).unwrap().0, PKT_HELLO_ACK);

        nominated_path.send_to(&encode_packet(&c2n, PKT_HELLO_ACK, 0, 0, 0, &[]), nominated_addr).await.unwrap();
        nominated_path.send_to(&open, nominated_addr).await.unwrap();
        assert!(tokio::time::timeout(quiet_window, nominated_path.recv_from(&mut buffer)).await.is_err());
        nominated_path.send_to(&hello, nominated_addr).await.unwrap();
        let (length, _) = tokio::time::timeout(ack_deadline, nominated_path.recv_from(&mut buffer))
            .await
            .expect("both paths must be able to complete the UDP handshake")
            .unwrap();
        assert_eq!(decode_packet(&n2c, &buffer[..length]).unwrap().0, PKT_HELLO_ACK);

        nominated_path.send_to(&open, nominated_addr).await.unwrap();
        let (length, _) =
            tokio::time::timeout(ack_deadline, nominated_path.recv_from(&mut buffer)).await.unwrap().unwrap();
        assert_eq!(decode_packet(&n2c, &buffer[..length]).unwrap().0, PKT_OPEN_ACK);
        first_path.send_to(&open, first_addr).await.unwrap();
        assert!(tokio::time::timeout(quiet_window, first_path.recv_from(&mut buffer)).await.is_err());
        assert_eq!(streams.load(Ordering::SeqCst), 1);
        stop.send(true).unwrap();
        serving.await.unwrap();
    }

    #[tokio::test]
    async fn stun_candidate_uses_transport_socket_and_ignores_wrong_transaction() {
        let ipv4_node = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        for node in std::iter::once(ipv4_node).chain(bind_dual_stack_udp().ok()) {
            let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let server_addr = server.local_addr().unwrap();
            let node_port = node.local_addr().unwrap().port();
            let responding = tokio::spawn(async move {
                let mut request = [0; 32];
                let (_, client) = server.recv_from(&mut request).await.unwrap();
                let mut reply = request[..20].to_vec();
                reply[..4].copy_from_slice(&[1, 1, 0, 12]);
                reply.extend_from_slice(&[0, 0x20, 0, 8, 0, 1]);
                reply.extend_from_slice(&(client.port() ^ 0x2112).to_be_bytes());
                reply.extend_from_slice(&(u32::from(Ipv4Addr::LOCALHOST) ^ 0x2112A442).to_be_bytes());
                reply[8] ^= 1;
                server.send_to(&reply, client).await.unwrap();
                reply[8] ^= 1;
                server.send_to(&reply, client).await.unwrap();
            });
            let candidate =
                tokio::time::timeout(Duration::from_millis(500), query_stun_srflx(&node, &server_addr.to_string()))
                    .await
                    .unwrap()
                    .unwrap();
            responding.await.unwrap();
            assert_eq!(
                (candidate.host.as_str(), candidate.port, candidate.kind.as_str()),
                ("127.0.0.1", node_port, "srflx")
            );
        }
    }

    #[test]
    fn packet_hmac_authenticates_and_rejects_tampering() {
        let key = derive_dir_key("sess-1", &"a".repeat(64), &"b".repeat(64), "c2n");
        let pkt = encode_packet(&key, PKT_DATA, 7, 1, 0, b"ssh-payload");
        let (t, sid, seq, ack, body) = decode_packet(&key, &pkt).expect("valid packet");
        assert_eq!((t, sid, seq, ack, body.as_slice()), (PKT_DATA, 7, 1, 0, b"ssh-payload".as_slice()));

        let mut tampered = pkt.clone();
        tampered[HEADER_LEN] ^= 0x01;
        assert!(decode_packet(&key, &tampered).is_none());
    }
}
