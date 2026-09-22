//! The AWSP server: the accept loop, the allowlist gate, pairing, control sessions and audio
//! streams (docs/AWSP.md §1–§5).

use std::{
    collections::HashMap,
    path::PathBuf,
    str::FromStr,
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

use base64::Engine;
use iroh::{
    Endpoint, EndpointId,
    endpoint::{Connection, Incoming, PathList, RecvStream, SendStream, VarInt},
};
use iroh_tickets::{Ticket, endpoint::EndpointTicket};
use n0_future::StreamExt;
use rand::RngCore;
use serde_json::{Value, json};
use tokio::{
    sync::{broadcast, mpsc, watch},
    task::JoinHandle,
    time::timeout,
};
use tracing::{debug, info, warn};

use crate::{
    config::{AllowEntry, Command, Event, Tier, iso, now_iso},
    library::{Library, TrackFile},
    media::{Media, codec_for},
    pairing::{PairOutcome, Pairing},
    player::PlayerState,
    protocol::{
        AudioRequest, Frame, FrameError, MAX_FRAME, PROTOCOL_VERSION, audio_header, codec, codes, copy_range,
        read_frame, read_frame_bytes, resolve_range, write_json,
    },
};

/// How long an unknown endpoint has to open its control stream and send `pair`.
const PAIR_TIMEOUT: Duration = Duration::from_secs(10);
/// How long an allowlisted endpoint has to open its control stream.
const CONTROL_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// How long an audio stream has to send its request frame.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const STATE_INTERVAL: Duration = Duration::from_secs(5);
const RESUME_TTL: Duration = Duration::from_secs(600);

pub struct ServerOptions {
    pub server_name: String,
    pub library_db: PathBuf,
    pub cache_dir: PathBuf,
    pub allowlist: Vec<AllowEntry>,
    /// The ffmpeg executable; `None` means `AWSP_FFMPEG` or `ffmpeg` on PATH.
    pub ffmpeg: Option<String>,
}

struct Shared {
    endpoint: Endpoint,
    server_name: String,
    allow: RwLock<HashMap<EndpointId, AllowEntry>>,
    pairing: Mutex<Pairing>,
    live: Mutex<HashMap<EndpointId, Vec<Connection>>>,
    resume: Mutex<HashMap<String, (EndpointId, Instant)>>,
    player: watch::Sender<PlayerState>,
    deltas: broadcast::Sender<Value>,
    library: Arc<Library>,
    media: Media,
    events: mpsc::UnboundedSender<Event>,
}

impl Shared {
    fn emit(&self, event: Event) {
        let _ = self.events.send(event);
    }

    fn is_allowed(&self, peer: &EndpointId) -> bool {
        self.allow.read().expect("allow lock").contains_key(peer)
    }

    fn tier_cap(&self, peer: &EndpointId) -> Tier {
        self.allow.read().expect("allow lock").get(peer).map_or(Tier::Lossless, |e| e.tier_cap)
    }

    fn modify(&self, f: impl FnOnce(&mut PlayerState)) {
        self.player.send_modify(|s| {
            f(s);
            s.seq += 1;
        });
    }

    async fn lookup(&self, track_id: &str) -> Option<TrackFile> {
        let lib = self.library.clone();
        let id = track_id.to_string();
        match tokio::task::spawn_blocking(move || lib.lookup(&id)).await {
            Ok(Ok(found)) => found,
            Ok(Err(e)) => {
                warn!("library lookup failed: {e:#}");
                None
            }
            Err(_) => None,
        }
    }

    /// Move to the next/previous queue entry; at the end of the queue, stop.
    async fn step(&self, forward: bool) {
        let target = {
            let s = self.player.borrow();
            s.neighbour(forward).map(|i| (i, s.queue[i].clone()))
        };
        match target {
            Some((i, id)) => {
                let duration = self.lookup(&id).await.and_then(|t| t.duration_ms());
                self.modify(|s| {
                    if s.queue.get(i) == Some(&id) {
                        s.load(i, duration);
                    }
                });
            }
            None if forward => self.modify(PlayerState::stop),
            None => {}
        }
    }

    fn issue_resume(&self, peer: EndpointId) -> String {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        let token = hex::encode(bytes);
        let mut map = self.resume.lock().expect("resume lock");
        map.retain(|_, (_, at)| at.elapsed() < RESUME_TTL);
        map.insert(token.clone(), (peer, Instant::now()));
        token
    }

    /// A token is valid once, for ten minutes, and only for the endpoint it was issued to.
    fn take_resume(&self, token: &str, peer: EndpointId) -> bool {
        let mut map = self.resume.lock().expect("resume lock");
        match map.get(token) {
            Some((owner, at)) if *owner == peer && at.elapsed() < RESUME_TTL => {
                map.remove(token);
                true
            }
            _ => false,
        }
    }

    fn register(&self, peer: EndpointId, conn: &Connection) {
        self.live.lock().expect("live lock").entry(peer).or_default().push(conn.clone());
    }

    fn unregister(&self, peer: EndpointId, conn: &Connection) {
        let mut live = self.live.lock().expect("live lock");
        if let Some(list) = live.get_mut(&peer) {
            list.retain(|c| c.stable_id() != conn.stable_id());
            if list.is_empty() {
                live.remove(&peer);
            }
        }
    }
}

/// `direct` or `relay` for a connection's selected path (or, before one is selected, its first
/// path), with that path's RTT.
pub fn path_kind(paths: &PathList<'_>) -> Option<(&'static str, u64)> {
    let mut fallback = None;
    for p in paths.iter() {
        let kind = if p.is_relay() { "relay" } else { "direct" };
        let rtt = p.rtt().as_millis() as u64;
        if p.is_selected() {
            return Some((kind, rtt));
        }
        fallback.get_or_insert((kind, rtt));
    }
    fallback
}

pub struct Server {
    shared: Arc<Shared>,
    tasks: Vec<JoinHandle<()>>,
}

impl Server {
    /// Start serving on an already bound endpoint (its ALPNs must include `awsp/1`).
    pub fn start(endpoint: Endpoint, opts: ServerOptions, events: mpsc::UnboundedSender<Event>) -> Server {
        let mut allow = HashMap::new();
        for entry in opts.allowlist {
            match EndpointId::from_str(&entry.id) {
                Ok(id) => {
                    allow.insert(id, entry);
                }
                Err(e) => {
                    let _ = events.send(Event::Error { message: format!("allowlist entry {:?} is not an endpoint id: {e}", entry.id) });
                }
            }
        }
        let shared = Arc::new(Shared {
            endpoint,
            server_name: opts.server_name,
            allow: RwLock::new(allow),
            pairing: Mutex::new(Pairing::default()),
            live: Mutex::new(HashMap::new()),
            resume: Mutex::new(HashMap::new()),
            player: watch::Sender::new(PlayerState::default()),
            deltas: broadcast::channel(16).0,
            library: Arc::new(Library::new(opts.library_db)),
            media: Media::new(opts.cache_dir, opts.ffmpeg),
            events,
        });
        let accept = tokio::spawn(accept_loop(shared.clone()));
        let ticker = tokio::spawn(ticker(shared.clone()));
        Server { shared, tasks: vec![accept, ticker] }
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.shared.endpoint
    }

    /// The `ready` event: waits (bounded) for the home relay so the ticket carries its URL.
    pub async fn ready_event(&self, online_timeout: Option<Duration>) -> Event {
        let ep = &self.shared.endpoint;
        if let Some(t) = online_timeout
            && timeout(t, ep.online()).await.is_err() {
                self.shared.emit(Event::Error { message: "no home relay yet; the ticket has no relay URL".into() });
            }
        let addr = ep.addr();
        let relay_url = addr.relay_urls().next().map(ToString::to_string);
        Event::Ready { endpoint_id: ep.id().to_string(), ticket: EndpointTicket::new(addr).encode_string(), relay_url }
    }

    /// Apply a main-process command. Returns `false` for `shutdown`.
    pub fn command(&self, cmd: Command) -> bool {
        let sh = &self.shared;
        match cmd {
            Command::NewPairingCode => {
                let (code, ttl) = sh.pairing.lock().expect("pairing lock").issue();
                let expires = time::OffsetDateTime::now_utc() + ttl;
                sh.emit(Event::PairingCode { code, expires_at: iso(expires) });
            }
            Command::Revoke { id } => match EndpointId::from_str(&id) {
                Ok(peer) => {
                    sh.allow.write().expect("allow lock").remove(&peer);
                    sh.resume.lock().expect("resume lock").retain(|_, (owner, _)| *owner != peer);
                    let conns = sh.live.lock().expect("live lock").remove(&peer).unwrap_or_default();
                    for c in conns {
                        c.close(VarInt::from_u32(codes::UNKNOWN_DEVICE), b"revoked");
                    }
                    info!("revoked {peer}");
                }
                Err(e) => sh.emit(Event::Error { message: format!("revoke: bad id {id:?}: {e}") }),
            },
            Command::SetTierCap { id, tier } => {
                let found = EndpointId::from_str(&id)
                    .ok()
                    .and_then(|peer| sh.allow.write().expect("allow lock").get_mut(&peer).map(|e| e.tier_cap = tier))
                    .is_some();
                if !found {
                    sh.emit(Event::Error { message: format!("set_tier_cap: {id:?} is not paired") });
                }
            }
            Command::Shutdown => return false,
        }
        true
    }

    pub async fn shutdown(self) {
        for t in &self.tasks {
            t.abort();
        }
        self.shared.endpoint.close().await;
    }
}

async fn accept_loop(sh: Arc<Shared>) {
    while let Some(incoming) = sh.endpoint.accept().await {
        let sh = sh.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(sh, incoming).await {
                debug!("connection ended: {e:#}");
            }
        });
    }
}

/// Auto-advance at the end of a track, and publish library changes.
async fn ticker(sh: Arc<Shared>) {
    let lib = sh.library.clone();
    let mut marker = tokio::task::spawn_blocking(move || lib.max_updated_at().ok().flatten()).await.ok().flatten();
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let mut n: u64 = 0;
    loop {
        tick.tick().await;
        n += 1;
        if sh.player.borrow().at_end() {
            sh.step(true).await;
        }
        if !n.is_multiple_of(10) {
            continue;
        }
        let lib = sh.library.clone();
        let since = marker.clone();
        let delta = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Value>> {
            let now = lib.max_updated_at()?;
            if now.is_none() || now <= since {
                return Ok(None);
            }
            Ok(Some(lib.delta_since(since.as_deref().unwrap_or(""))?))
        })
        .await;
        if let Ok(Ok(Some(delta))) = delta {
            marker = delta["until"].as_str().map(str::to_string);
            let _ = sh.deltas.send(delta);
        }
    }
}

async fn handle_connection(sh: Arc<Shared>, incoming: Incoming) -> anyhow::Result<()> {
    let conn = incoming.accept()?.await?;
    let peer = conn.remote_id();

    // The allowlist gate. A known endpoint gets its control stream accepted; an unknown one gets
    // exactly one stream, whose first frame must be `pair` — anything else closes with 0x1.
    let (send, recv, first) = if sh.is_allowed(&peer) {
        match timeout(CONTROL_OPEN_TIMEOUT, conn.accept_bi()).await {
            Ok(Ok((s, r))) => (s, r, None),
            _ => {
                conn.close(VarInt::from_u32(codes::NORMAL), b"no control stream");
                return Ok(());
            }
        }
    } else {
        let first = timeout(PAIR_TIMEOUT, async {
            let (s, mut r) = conn.accept_bi().await?;
            let f = read_frame(&mut r).await?;
            anyhow::Ok((s, r, f))
        })
        .await;
        match first {
            Ok(Ok((s, r, Some(f)))) if f.kind == "pair" => (s, r, Some(f)),
            _ => {
                info!("awsp refused unknown endpoint {peer}");
                conn.close(VarInt::from_u32(codes::UNKNOWN_DEVICE), b"unknown-device");
                return Ok(());
            }
        }
    };

    sh.register(peer, &conn);
    let watcher = tokio::spawn(watch_paths(sh.clone(), conn.clone(), peer));
    let audio = tokio::spawn(accept_audio(sh.clone(), conn.clone(), peer));
    {
        let sh = sh.clone();
        let conn = conn.clone();
        tokio::spawn(async move {
            let reason = conn.closed().await;
            debug!("{peer} closed: {reason}");
            watcher.abort();
            audio.abort();
            sh.unregister(peer, &conn);
            info!("awsp disconnected {peer}");
            sh.emit(Event::Disconnected { peer: peer.to_string() });
        });
    }

    Session::new(sh, conn, peer).run(send, recv, first).await;
    Ok(())
}

/// Log and report the connection type on establishment and on every change (§5).
async fn watch_paths(sh: Arc<Shared>, conn: Connection, peer: EndpointId) {
    let mut last: Option<&'static str> = None;
    let mut stream = conn.paths_stream();
    while let Some(list) = stream.next().await {
        if let Some((kind, rtt)) = path_kind(&list)
            && last != Some(kind) {
                last = Some(kind);
                info!("awsp connection {peer} type={kind} rtt={rtt}");
                sh.emit(Event::Connection { peer: peer.to_string(), kind: kind.to_string(), rtt_ms: rtt });
            }
    }
}

async fn accept_audio(sh: Arc<Shared>, conn: Connection, peer: EndpointId) {
    while let Ok((send, recv)) = conn.accept_bi().await {
        if !sh.is_allowed(&peer) {
            conn.close(VarInt::from_u32(codes::UNKNOWN_DEVICE), b"unknown-device");
            return;
        }
        tokio::spawn(serve_audio(sh.clone(), peer, send, recv));
    }
}

/// One audio fetch (§3.2): request → 16-byte header → exactly the range → `finish()`; or a reset
/// with an error code before the header.
async fn serve_audio(sh: Arc<Shared>, peer: EndpointId, mut send: SendStream, mut recv: RecvStream) {
    let reset = |send: &mut SendStream, code: u32| {
        let _ = send.reset(VarInt::from_u32(code));
    };
    let req: AudioRequest = match timeout(REQUEST_TIMEOUT, read_frame_bytes(&mut recv)).await {
        Ok(Ok(Some(bytes))) => match serde_json::from_slice(&bytes) {
            Ok(r) => r,
            Err(_) => return reset(&mut send, codes::BAD_REQUEST),
        },
        _ => return reset(&mut send, codes::BAD_REQUEST),
    };
    let Some(asked) = req.tier() else { return reset(&mut send, codes::TIER) };
    let tier = asked.clamp_to(sh.tier_cap(&peer));
    let Some(track) = sh.lookup(&req.track_id).await else { return reset(&mut send, codes::NOT_FOUND) };

    let (file, codec) = if tier == Tier::Lossless {
        let codec = codec_for(&track.path, &track.track);
        (track.path.clone(), codec)
    } else {
        match sh.media.transcoded(&track.id, tier, &track.path, track.mtime_ms).await {
            Ok(p) => (p, codec::OPUS),
            Err(e) => {
                warn!("tier {} of {} failed: {e:#}", tier.name(), track.id);
                return reset(&mut send, codes::TIER);
            }
        }
    };
    let Ok(meta) = tokio::fs::metadata(&file).await else { return reset(&mut send, codes::NOT_FOUND) };
    let total = meta.len();
    let Some((start, end)) = resolve_range(total, req.byte_start, req.byte_end) else {
        return reset(&mut send, codes::RANGE);
    };
    let header = audio_header(&req.track_id, total, codec, tier);
    if send.write_all(&header).await.is_err() {
        return;
    }
    match copy_range(&mut send, &file, start, end).await {
        Ok(n) => {
            debug!("served {} [{start}..={end}] {n} bytes tier={}", req.track_id, tier.name());
            let _ = send.finish();
        }
        // STOP_SENDING from the client (a seek) or a lost connection: nothing more to say.
        Err(e) => debug!("audio stream for {} ended early: {e}", req.track_id),
    }
}

enum Out {
    Frame(Frame),
    Reset(u32),
}

enum Flow {
    Continue,
    Close(u32, &'static [u8]),
}

struct Session {
    sh: Arc<Shared>,
    conn: Connection,
    peer: EndpointId,
    out: Option<mpsc::Sender<Out>>,
    greeted: bool,
    frames_seen: u64,
    pusher: Option<JoinHandle<()>>,
}

impl Session {
    fn new(sh: Arc<Shared>, conn: Connection, peer: EndpointId) -> Self {
        Session { sh, conn, peer, out: None, greeted: false, frames_seen: 0, pusher: None }
    }

    async fn run(mut self, mut send: SendStream, mut recv: RecvStream, first: Option<Frame>) {
        let (tx, mut rx) = mpsc::channel::<Out>(64);
        self.out = Some(tx);
        let player = self.sh.player.clone();
        let writer = tokio::spawn(async move {
            let mut id = 0u64;
            while let Some(out) = rx.recv().await {
                match out {
                    Out::Frame(mut f) => {
                        id += 1;
                        f.id = id;
                        if f.seq == 0 {
                            f.seq = player.borrow().seq;
                        }
                        if write_json(&mut send, &f).await.is_err() {
                            return;
                        }
                    }
                    Out::Reset(code) => {
                        let _ = send.reset(VarInt::from_u32(code));
                        return;
                    }
                }
            }
            let _ = send.finish();
            let _ = timeout(Duration::from_secs(2), send.stopped()).await;
        });

        let mut flow = Flow::Continue;
        if let Some(f) = first {
            flow = self.handle(f).await;
        }
        while matches!(flow, Flow::Continue) {
            flow = match read_frame(&mut recv).await {
                Ok(Some(f)) => self.handle(f).await,
                Ok(None) => Flow::Close(codes::NORMAL, b"bye"),
                Err(FrameError::TooLarge(n)) => {
                    warn!("{}: control frame of {n} bytes", self.peer);
                    let _ = recv.stop(VarInt::from_u32(codes::FRAME_TOO_LARGE));
                    self.send(Out::Reset(codes::FRAME_TOO_LARGE)).await;
                    Flow::Close(codes::NORMAL, b"frame-too-large")
                }
                Err(FrameError::Json(e)) => {
                    self.error(None, "bad-frame", &e.to_string()).await;
                    Flow::Continue
                }
                Err(_) => Flow::Close(codes::NORMAL, b"control stream lost"),
            };
        }
        if let Some(p) = self.pusher.take() {
            p.abort();
        }
        self.out = None;
        let _ = writer.await;
        if let Flow::Close(code, reason) = flow {
            self.conn.close(VarInt::from_u32(code), reason);
        }
    }

    async fn send(&self, out: Out) {
        if let Some(tx) = &self.out {
            let _ = tx.send(out).await;
        }
    }

    async fn reply(&self, kind: &str, payload: Value, re: u64) {
        self.send(Out::Frame(Frame::reply(kind, payload, re))).await;
    }

    async fn error(&self, re: Option<u64>, code: &str, message: &str) {
        let mut f = Frame::new("error", json!({ "code": code, "message": message }));
        f.re = re;
        self.send(Out::Frame(f)).await;
    }

    async fn send_state(&self) {
        let st = self.sh.player.borrow().clone();
        let mut f = Frame::new("state", st.payload());
        f.seq = st.seq;
        self.send(Out::Frame(f)).await;
    }

    async fn handle(&mut self, f: Frame) -> Flow {
        self.frames_seen += 1;
        let re = f.id;
        let p = &f.payload;
        match f.kind.as_str() {
            "ping" => self.reply("pong", json!({}), re).await,
            "pair" if self.frames_seen == 1 => return self.pair(p, re).await,
            "pair" => self.error(Some(re), "unexpected", "pair is only valid as the first frame").await,
            "hello" => return self.hello(p, re).await,
            _ if !self.greeted => self.error(Some(re), "hello-required", "send hello first").await,
            "play" => match p.get("track_id").and_then(Value::as_str) {
                Some(id) => match self.sh.lookup(id).await {
                    Some(t) => {
                        let offset = p.get("offset_ms").and_then(Value::as_u64).unwrap_or(0);
                        let duration = t.duration_ms();
                        self.sh.modify(|s| s.play(id, offset, duration));
                    }
                    None => self.error(Some(re), "not-found", "no such track").await,
                },
                None => self.sh.modify(PlayerState::resume),
            },
            "pause" => self.sh.modify(PlayerState::pause),
            "seek" => {
                let ms = p.get("ms").and_then(Value::as_u64).unwrap_or(0);
                self.sh.modify(|s| s.seek(ms));
            }
            "next" => self.sh.step(true).await,
            "prev" => self.sh.step(false).await,
            "set_queue" => {
                let ids = p
                    .get("track_ids")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>());
                match ids {
                    Some(ids) => self.sh.modify(|s| s.set_queue(ids)),
                    None => self.error(Some(re), "bad-request", "track_ids must be an array of ids").await,
                }
            }
            "browse" => {
                let lib = self.sh.library.clone();
                let path = p.get("path").and_then(Value::as_str).map(str::to_string);
                let query = p.get("query").and_then(Value::as_str).map(str::to_string);
                let page = p.get("page").and_then(Value::as_u64).unwrap_or(0).min(u64::from(u32::MAX)) as u32;
                match tokio::task::spawn_blocking(move || lib.browse(path.as_deref(), query.as_deref(), page)).await {
                    Ok(Ok(v)) => self.reply("library_page", v, re).await,
                    Ok(Err(e)) => self.error(Some(re), "library", &format!("{e:#}")).await,
                    Err(e) => self.error(Some(re), "library", &e.to_string()).await,
                }
            }
            "get_artwork" => self.artwork(p, re).await,
            "prefetch" => {
                let tier = self.sh.tier_cap(&self.peer);
                if let (Some(id), true) = (p.get("track_id").and_then(Value::as_str), tier != Tier::Lossless) {
                    let sh = self.sh.clone();
                    let id = id.to_string();
                    tokio::spawn(async move {
                        if let Some(t) = sh.lookup(&id).await {
                            let _ = sh.media.transcoded(&t.id, tier, &t.path, t.mtime_ms).await;
                        }
                    });
                }
            }
            "report" => debug!(
                "report from {}: buffer_ms={} throughput_kbps={} dropouts={}",
                self.peer,
                p.get("buffer_ms").unwrap_or(&serde_json::Value::Null),
                p.get("throughput_kbps").unwrap_or(&serde_json::Value::Null),
                p.get("dropouts").unwrap_or(&serde_json::Value::Null)
            ),
            other => self.error(Some(re), "unknown-type", &format!("unknown frame type {other:?}")).await,
        }
        Flow::Continue
    }

    async fn pair(&mut self, p: &Value, re: u64) -> Flow {
        let code = p.get("code").and_then(Value::as_str).unwrap_or("");
        let name = p.get("device_name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let kind = p.get("client_kind").and_then(Value::as_str).unwrap_or("");
        if !matches!(kind, "pwa" | "android") || name.is_empty() {
            self.error(Some(re), "bad-request", "pair needs device_name and client_kind pwa|android").await;
            return Flow::Close(codes::UNKNOWN_DEVICE, b"unknown-device");
        }
        let outcome = self.sh.pairing.lock().expect("pairing lock").check(code);
        match outcome {
            PairOutcome::Accepted => {
                let entry = AllowEntry { id: self.peer.to_string(), name: name.clone(), tier_cap: Tier::Lossless, paired_at: now_iso() };
                self.sh.allow.write().expect("allow lock").insert(self.peer, entry);
                info!("awsp paired {} ({name}, {kind})", self.peer);
                self.sh.emit(Event::Paired { id: self.peer.to_string(), name, client_kind: kind.to_string() });
                self.reply("paired", json!({ "server_name": self.sh.server_name }), re).await;
                Flow::Continue
            }
            PairOutcome::Rejected => {
                self.error(Some(re), "pair-rejected", "wrong pairing code").await;
                Flow::Close(codes::UNKNOWN_DEVICE, b"unknown-device")
            }
            PairOutcome::NoCode => {
                self.error(Some(re), "pair-no-code", "no pairing code is active").await;
                Flow::Close(codes::UNKNOWN_DEVICE, b"unknown-device")
            }
        }
    }

    async fn hello(&mut self, p: &Value, re: u64) -> Flow {
        if !self.sh.is_allowed(&self.peer) {
            return Flow::Close(codes::UNKNOWN_DEVICE, b"unknown-device");
        }
        let version = p.get("protocol_version").and_then(Value::as_u64);
        if version != Some(PROTOCOL_VERSION) {
            self.error(Some(re), "protocol-version", "this server speaks protocol_version 1").await;
            return Flow::Close(codes::PROTOCOL, b"protocol-version");
        }
        let resumed = p
            .get("resume_token")
            .and_then(Value::as_str)
            .is_some_and(|t| self.sh.take_resume(t, self.peer));
        let token = self.sh.issue_resume(self.peer);
        let connection = path_kind(&self.conn.paths()).map_or("relay", |(k, _)| k);
        self.reply(
            "welcome",
            json!({ "server_name": self.sh.server_name, "resume_token": token, "connection": connection, "resumed": resumed }),
            re,
        )
        .await;
        self.send_state().await;
        if !self.greeted {
            self.greeted = true;
            self.pusher = Some(self.spawn_pusher());
        }
        Flow::Continue
    }

    /// `state` on every change and every 5 s; `library_delta` when the index changes.
    fn spawn_pusher(&self) -> JoinHandle<()> {
        let mut state = self.sh.player.subscribe();
        state.mark_unchanged();
        let mut deltas = self.sh.deltas.subscribe();
        let out = self.out.clone().expect("session writer");
        tokio::spawn(async move {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + STATE_INTERVAL, STATE_INTERVAL);
            loop {
                tokio::select! {
                    r = state.changed() => if r.is_err() { return },
                    _ = tick.tick() => {},
                    d = deltas.recv() => {
                        match d {
                            Ok(v) => if out.send(Out::Frame(Frame::new("library_delta", v))).await.is_err() { return },
                            Err(broadcast::error::RecvError::Lagged(_)) => {},
                            Err(broadcast::error::RecvError::Closed) => return,
                        }
                        continue;
                    }
                }
                let st = state.borrow_and_update().clone();
                let mut f = Frame::new("state", st.payload());
                f.seq = st.seq;
                if out.send(Out::Frame(f)).await.is_err() {
                    return;
                }
                tick.reset();
            }
        })
    }

    async fn artwork(&self, p: &Value, re: u64) {
        let Some(id) = p.get("track_id").and_then(Value::as_str) else {
            return self.error(Some(re), "bad-request", "get_artwork needs track_id").await;
        };
        let size = p.get("size").and_then(Value::as_u64).unwrap_or(512).min(4096) as u32;
        let Some(track) = self.sh.lookup(id).await else {
            return self.error(Some(re), "not-found", "no such track").await;
        };
        match self.sh.media.artwork(&track.id, &track.path, track.mtime_ms, size).await {
            Ok(Some(bytes)) => {
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                if data.len() + 512 > MAX_FRAME {
                    return self.error(Some(re), "too-large", "artwork does not fit a frame; ask for a smaller size").await;
                }
                self.reply("artwork", json!({ "track_id": id, "size": size, "mime": "image/jpeg", "data": data }), re).await;
            }
            Ok(None) => self.reply("artwork", json!({ "track_id": id, "size": size, "mime": null, "data": null }), re).await,
            Err(e) => self.error(Some(re), "artwork", &format!("{e:#}")).await,
        }
    }
}
