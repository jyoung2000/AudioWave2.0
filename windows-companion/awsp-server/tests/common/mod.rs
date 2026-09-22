//! Shared test harness: a library database in the companion's schema, a running server on a real
//! iroh endpoint, and a minimal AWSP client.
#![allow(dead_code)]

use std::{
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use awsp_server::{
    AllowEntry, Config, Event, Server, ServerOptions, Tier,
    config::RelayModeConfig,
    protocol::{ALPN, AudioHeader, Frame, parse_audio_header, read_frame, write_json},
};
use iroh::{
    Endpoint, EndpointAddr, RelayMap, RelayMode, RelayUrl, SecretKey, TransportAddr,
    endpoint::{Connection, ReadError, ReadExactError, RecvStream, SendStream, presets},
    tls::CaTlsConfig,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    time::timeout,
};

pub const T: Duration = Duration::from_secs(20);

pub fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("AWSP_LOG").unwrap_or_else(|_| "awsp_server=info".into()))
        .with_test_writer()
        .try_init();
}

/// Create a database with the companion's tables (store.ts) holding `tracks`: `(id, file,
/// duration_ms)`. Each file's folder becomes a `folders` row, its name the `relative_path`.
pub fn make_library(db: &Path, tracks: &[(&str, &Path, u64)]) {
    let c = rusqlite::Connection::open(db).unwrap();
    c.execute_batch(
        "CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, watch INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'music', track_count INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, last_scan_error TEXT, created_at TEXT NOT NULL);
         CREATE TABLE tracks (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, relative_path TEXT NOT NULL, track TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, content_hash TEXT, updated_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(folder_id, relative_path));
         CREATE VIRTUAL TABLE tracks_fts USING fts5(title, artist, album, tokenize='unicode61 remove_diacritics 2');
         PRAGMA journal_mode = WAL;",
    )
    .unwrap();
    for (i, (id, file, duration_ms)) in tracks.iter().enumerate() {
        let folder = file.parent().unwrap().to_string_lossy().to_string();
        let folder_id = format!("folder-{i}");
        c.execute(
            "INSERT OR IGNORE INTO folders (id, path, display_name, created_at) VALUES (?1, ?2, 'Music', '2026-01-01T00:00:00Z')",
            rusqlite::params![folder_id, folder],
        )
        .unwrap();
        let folder_id: String = c.query_row("SELECT id FROM folders WHERE path = ?1", [&folder], |r| r.get(0)).unwrap();
        let name = file.file_name().unwrap().to_string_lossy().to_string();
        let track = json!({ "id": id, "title": format!("Track {id}"), "artistName": "Test Artist", "albumName": "Test Album", "durationMs": duration_ms });
        let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0) as i64;
        c.execute(
            "INSERT INTO tracks (id, folder_id, relative_path, track, size_bytes, mtime_ms, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, '2026-01-01T00:00:00Z')",
            rusqlite::params![id, folder_id, name, track.to_string(), size],
        )
        .unwrap();
        c.execute(
            "INSERT INTO tracks_fts (rowid, title, artist, album) SELECT rowid, ?2, 'Test Artist', 'Test Album' FROM tracks WHERE id = ?1",
            rusqlite::params![id, format!("Track {id}")],
        )
        .unwrap();
    }
}

pub fn secret_hex(key: &SecretKey) -> String {
    hex::encode(key.to_bytes())
}

pub fn allow(key: &SecretKey, tier_cap: Tier) -> AllowEntry {
    AllowEntry { id: key.public().to_string(), name: "test device".into(), tier_cap, paired_at: "2026-01-01T00:00:00Z".into() }
}

pub struct Harness {
    pub server: Server,
    pub events: mpsc::UnboundedReceiver<Event>,
    pub addr: EndpointAddr,
    pub dir: TempDir,
}

impl Harness {
    /// Wait for the first event matching `pred`, discarding others.
    pub async fn event(&mut self, pred: impl Fn(&Event) -> bool) -> Event {
        timeout(T, async {
            loop {
                let e = self.events.recv().await.expect("event channel open");
                if pred(&e) {
                    return e;
                }
            }
        })
        .await
        .expect("timed out waiting for an event")
    }
}

pub fn base_config(dir: &Path) -> Config {
    Config {
        secret_key_hex: secret_hex(&SecretKey::generate()),
        library_db: dir.join("companion.sqlite"),
        cache_dir: dir.join("cache"),
        server_name: "Test Companion".into(),
        allowlist: vec![],
        relay_mode: RelayModeConfig::Disabled,
        relay_urls: vec![],
        relay_only: false,
        bind_port: None,
        insecure_relay_tls: false,
    }
}

/// Start a server from `cfg` (the library in `dir` must already exist). With relays disabled the
/// returned address is the server's loopback socket; relay-only it is the relay URL.
pub async fn start(cfg: Config, dir: TempDir) -> Harness {
    let endpoint = cfg.bind_endpoint().await.expect("bind server endpoint");
    let (tx, events) = mpsc::unbounded_channel();
    let server = Server::start(
        endpoint,
        ServerOptions {
            server_name: cfg.server_name.clone(),
            library_db: cfg.library_db.clone(),
            cache_dir: cfg.cache_dir.clone(),
            allowlist: cfg.allowlist.clone(),
            ffmpeg: None,
        },
        tx,
    );
    let ep = server.endpoint();
    let addr = if cfg.relay_only {
        timeout(T, ep.online()).await.expect("server reached the relay");
        let url: RelayUrl = cfg.relay_urls[0].parse().unwrap();
        EndpointAddr::from_parts(ep.id(), [TransportAddr::Relay(url)])
    } else {
        let port = ep.bound_sockets().into_iter().find(SocketAddr::is_ipv4).expect("an IPv4 socket").port();
        EndpointAddr::from_parts(ep.id(), [TransportAddr::Ip(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))])
    };
    Harness { server, events, addr, dir }
}

pub async fn direct_client(key: SecretKey) -> Endpoint {
    Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .relay_mode(RelayMode::Disabled)
        .bind_addr(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .unwrap()
        .bind()
        .await
        .expect("bind client")
}

pub async fn relay_only_client(key: SecretKey, relay: RelayUrl) -> Endpoint {
    let ep = Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .relay_mode(RelayMode::Custom(RelayMap::from(relay)))
        .ca_tls_config(CaTlsConfig::insecure_skip_verify())
        .clear_ip_transports()
        .bind()
        .await
        .expect("bind relay-only client");
    timeout(T, ep.online()).await.expect("client reached the relay");
    ep
}

pub async fn connect(client: &Endpoint, addr: &EndpointAddr) -> Connection {
    timeout(T, client.connect(addr.clone(), ALPN)).await.expect("connect timed out").expect("connect")
}

/// The client's control stream.
pub struct Control {
    pub send: SendStream,
    pub recv: RecvStream,
    next_id: u64,
}

impl Control {
    pub async fn open(conn: &Connection) -> Control {
        let (send, recv) = conn.open_bi().await.expect("open control stream");
        Control { send, recv, next_id: 0 }
    }

    pub async fn send(&mut self, kind: &str, payload: Value) -> u64 {
        self.next_id += 1;
        let f = Frame { id: self.next_id, kind: kind.into(), seq: 0, payload, re: None };
        write_json(&mut self.send, &f).await.expect("send frame");
        self.next_id
    }

    /// The next frame of `kind`, skipping `state` pushes and other frames.
    pub async fn expect(&mut self, kind: &str) -> Frame {
        timeout(T, async {
            loop {
                let f = read_frame(&mut self.recv).await.expect("read frame").expect("control stream open");
                if f.kind == kind {
                    return f;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {kind}"))
    }

    pub async fn hello(&mut self) -> Frame {
        self.send("hello", json!({ "device_name": "test", "client_kind": "android", "protocol_version": 1 })).await;
        self.expect("welcome").await
    }
}

/// An audio fetch: `Ok((header, bytes))`, or `Err(reset code)`.
pub async fn fetch(conn: &Connection, req: Value) -> Result<(AudioHeader, Vec<u8>), u64> {
    let (mut send, mut recv) = conn.open_bi().await.map_err(|_| u64::MAX)?;
    write_json(&mut send, &req).await.map_err(|_| u64::MAX)?;
    let _ = send.finish();
    let mut h = [0u8; 16];
    match recv.read_exact(&mut h).await {
        Ok(()) => {}
        Err(ReadExactError::ReadError(ReadError::Reset(code))) => return Err(code.into_inner()),
        Err(_) => return Err(u64::MAX),
    }
    let mut body = Vec::new();
    AsyncReadExt::read_to_end(&mut recv, &mut body).await.map_err(|_| u64::MAX)?;
    Ok((parse_audio_header(&h), body))
}

pub async fn ffmpeg_available() -> bool {
    tokio::process::Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// A 24-bit / 96 kHz stereo FLAC of `seconds` of decorrelated pink noise (near-incompressible,
/// so the stream runs at a realistic hi-res bitrate). `None` when ffmpeg is missing.
pub async fn hires_flac(dir: &Path, seconds: u32) -> Option<PathBuf> {
    if !ffmpeg_available().await {
        eprintln!("SKIPPED: ffmpeg is not on PATH, the 24/96 FLAC fixture cannot be generated");
        return None;
    }
    let out = dir.join(format!("hires-{seconds}s.flac"));
    let graph = format!(
        "anoisesrc=r=96000:d={seconds}:c=pink:a=0.25:seed=1[l];anoisesrc=r=96000:d={seconds}:c=pink:a=0.25:seed=2[r];[l][r]amerge=inputs=2[out]"
    );
    let status = tokio::process::Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-filter_complex", &graph, "-map", "[out]", "-ac", "2", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-c:a", "flac"])
        .arg(&out)
        .status()
        .await
        .expect("run ffmpeg");
    assert!(status.success(), "ffmpeg failed to generate the fixture");
    Some(out)
}

pub fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

/// A TCP proxy in front of the relay whose forwarding can be stalled in both directions: bytes
/// already read are held, nothing is dropped, the TCP connections stay open.
pub async fn stallable_proxy(target: SocketAddr, stall: Arc<AtomicBool>) -> SocketAddr {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((inbound, _)) = listener.accept().await {
            let stall = stall.clone();
            tokio::spawn(async move {
                let Ok(outbound) = TcpStream::connect(target).await else { return };
                let _ = inbound.set_nodelay(true);
                let _ = outbound.set_nodelay(true);
                let (ri, wi) = inbound.into_split();
                let (ro, wo) = outbound.into_split();
                tokio::spawn(pump(ri, wo, stall.clone()));
                tokio::spawn(pump(ro, wi, stall));
            });
        }
    });
    addr
}

async fn pump(mut from: tokio::net::tcp::OwnedReadHalf, mut to: tokio::net::tcp::OwnedWriteHalf, stall: Arc<AtomicBool>) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match from.read(&mut buf).await {
            Ok(0) | Err(_) => {
                let _ = to.shutdown().await;
                return;
            }
            Ok(n) => n,
        };
        while stall.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        if to.write_all(&buf[..n]).await.is_err() {
            return;
        }
    }
}
