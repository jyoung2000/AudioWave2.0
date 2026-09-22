//! The PWA's AWSP client (docs/AWSP.md §6): iroh's browser build, compiled to wasm and driven from
//! a dedicated worker (`music-player/src/shell/awsp-worker.ts`).
//!
//! This crate is the transport and the wire format only — an endpoint, a connection, the control
//! stream's length-prefixed JSON frames and an audio stream's request, 16-byte header and bytes. The
//! policy around it (pairing, `hello` and `resume_token`, pings, reconnection with backoff, resuming a
//! fetch from the last contiguous byte) lives in the worker, in TypeScript, where it is testable
//! without a Rust toolchain.
//!
//! A browser cannot hole punch and has no UDP: every connection is carried by the relay's WebSocket,
//! end-to-end encrypted QUIC inside it. The client's home relay is the server's (from the ticket) or
//! an override, so nothing else is contacted.
//!
//! Every method that awaits returns a `Promise` built from owned clones, never a future borrowing
//! `self`: the worker calls `recv()` and `fetch()` concurrently on the same connection.

use std::{rc::Rc, str::FromStr};

use iroh::{
    Endpoint, EndpointAddr, RelayMap, RelayMode, RelayUrl, SecretKey, TransportAddr,
    endpoint::{Connection, ConnectionError, ReadError, ReadExactError, RecvStream, SendStream, VarInt, presets},
};
use iroh_tickets::endpoint::EndpointTicket;
use js_sys::{Promise, Uint8Array};
use tokio::sync::Mutex;
use tracing::level_filters::LevelFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

const ALPN: &[u8] = b"awsp/1";
/// Largest control frame (§3.1).
const MAX_FRAME: usize = 256 * 1024;
/// The read unit of an audio stream, as the server writes it (§3.2).
const CHUNK: usize = 64 * 1024;
/// Control stream: frame too large (§3.1).
const FRAME_TOO_LARGE: u32 = 0x20;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
    // iroh's own warnings only; the connection lines AWSP logs at INFO are the worker's (§5).
    let _ = tracing_subscriber::fmt()
        .with_max_level(LevelFilter::WARN)
        .with_writer(MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG))
        .without_time()
        .with_ansi(false)
        .try_init();
}

fn js_err(e: impl std::fmt::Display) -> JsValue {
    JsError::new(&e.to_string()).into()
}

/// A read error as the worker tells them apart: `awsp-reset:<code>` is the server refusing this
/// stream (§3.2 codes), `awsp-lost:` is the connection going away (the worker reconnects).
fn read_err(e: ReadError) -> JsValue {
    match e {
        ReadError::Reset(code) => js_err(format!("awsp-reset:{}", code.into_inner())),
        other => js_err(format!("awsp-lost: {other}")),
    }
}

/// `{"endpoint_id": "…", "relay_urls": ["…"]}` for a ticket, so the worker can pick the home relay
/// before it binds the endpoint.
#[wasm_bindgen]
pub fn ticket_info(ticket: &str) -> Result<String, JsError> {
    let t = EndpointTicket::from_str(ticket.trim()).map_err(|e| JsError::new(&format!("not an AWSP ticket: {e}")))?;
    let addr = t.endpoint_addr();
    let relays: Vec<String> = addr.relay_urls().map(ToString::to_string).collect();
    Ok(serde_json::json!({ "endpoint_id": addr.id.to_string(), "relay_urls": relays }).to_string())
}

/// The client's iroh endpoint and its identity.
#[wasm_bindgen]
pub struct AwspClient {
    endpoint: Endpoint,
    secret: [u8; 32],
}

#[wasm_bindgen]
impl AwspClient {
    /// Bind an endpoint. `secret` is the stored 32-byte key, or empty for a new identity; `relays`
    /// are the home relays (the ticket's, or an override).
    pub async fn create(secret: Vec<u8>, relays: Vec<String>) -> Result<AwspClient, JsError> {
        let key = if secret.is_empty() {
            SecretKey::generate()
        } else {
            let bytes: [u8; 32] = secret.try_into().map_err(|_| JsError::new("the secret key must be 32 bytes"))?;
            SecretKey::from_bytes(&bytes)
        };
        let urls = relays
            .iter()
            .map(|u| u.parse::<RelayUrl>().map_err(|e| JsError::new(&format!("bad relay url {u}: {e}"))))
            .collect::<Result<Vec<_>, _>>()?;
        if urls.is_empty() {
            return Err(JsError::new("no relay: the ticket carries none and no override was given"));
        }
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(key.clone())
            .relay_mode(RelayMode::Custom(RelayMap::from_iter(urls)))
            .bind()
            .await
            .map_err(|e| JsError::new(&format!("binding the endpoint failed: {e}")))?;
        Ok(AwspClient { endpoint, secret: key.to_bytes() })
    }

    pub fn secret_key(&self) -> Vec<u8> {
        self.secret.to_vec()
    }

    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    /// Connect to the ticket's endpoint with ALPN `awsp/1`. Resolves an `AwspConnection`.
    pub fn connect(&self, ticket: String, relay_override: Option<String>) -> Promise {
        let ep = self.endpoint.clone();
        future_to_promise(async move {
            let t = EndpointTicket::from_str(ticket.trim()).map_err(|e| js_err(format!("not an AWSP ticket: {e}")))?;
            let mut addr = t.endpoint_addr().clone();
            if let Some(r) = relay_override.filter(|r| !r.is_empty()) {
                let url: RelayUrl = r.parse().map_err(|e| js_err(format!("bad relay url {r}: {e}")))?;
                addr = EndpointAddr::from_parts(addr.id, [TransportAddr::Relay(url)]);
            }
            let conn = ep.connect(addr, ALPN).await.map_err(js_err)?;
            Ok(AwspConnection { conn }.into())
        })
    }

    pub fn close(&self) -> Promise {
        let ep = self.endpoint.clone();
        future_to_promise(async move {
            ep.close().await;
            Ok(JsValue::UNDEFINED)
        })
    }
}

/// One QUIC connection to the server: one control stream, one stream per audio fetch (§3).
#[wasm_bindgen]
pub struct AwspConnection {
    conn: Connection,
}

#[wasm_bindgen]
impl AwspConnection {
    pub fn remote_id(&self) -> String {
        self.conn.remote_id().to_string()
    }

    /// `relay` or `direct`, from the selected path (a browser's is always the relay).
    pub fn connection_type(&self) -> String {
        self.path().map_or("relay", |(k, _)| k).to_string()
    }

    pub fn rtt_ms(&self) -> f64 {
        self.path().map_or(0.0, |(_, rtt)| rtt as f64)
    }

    fn path(&self) -> Option<(&'static str, u64)> {
        let mut fallback = None;
        for p in self.conn.paths().iter() {
            let kind = if p.is_relay() { "relay" } else { "direct" };
            let rtt = p.rtt().as_millis() as u64;
            if p.is_selected() {
                return Some((kind, rtt));
            }
            fallback.get_or_insert((kind, rtt));
        }
        fallback
    }

    /// Open the control stream. Resolves an `AwspControl`.
    pub fn open_control(&self) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            let (send, recv) = conn.open_bi().await.map_err(js_err)?;
            Ok(AwspControl { send: Rc::new(Mutex::new(send)), recv: Rc::new(Mutex::new(recv)) }.into())
        })
    }

    /// One audio fetch (§3.2): the request frame, then the 16-byte header. Resolves an `AwspAudio`
    /// positioned at the first byte of the range, or rejects with `awsp-reset:<code>`.
    pub fn fetch(&self, track_id: String, byte_start: f64, byte_end: Option<f64>, tier: String) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            let (mut send, mut recv) = conn.open_bi().await.map_err(|e| js_err(format!("awsp-lost: {e}")))?;
            let req = serde_json::json!({
                "track_id": track_id,
                "byte_start": byte_start as u64,
                "byte_end": byte_end.map(|e| e as u64),
                "tier": tier,
            });
            write_frame(&mut send, &serde_json::to_vec(&req).map_err(js_err)?).await?;
            let _ = send.finish();
            let mut h = [0u8; 16];
            match recv.read_exact(&mut h).await {
                Ok(()) => {}
                Err(ReadExactError::ReadError(e)) => return Err(read_err(e)),
                Err(e) => return Err(js_err(format!("awsp-lost: {e}"))),
            }
            let expected = blake3::hash(track_id.as_bytes());
            if h[..8] != expected.as_bytes()[..8] {
                let _ = recv.stop(VarInt::from_u32(0));
                return Err(js_err("the header names a different track"));
            }
            let mut len = [0u8; 8];
            len[2..8].copy_from_slice(&h[8..14]);
            Ok(AwspAudio {
                recv: Rc::new(Mutex::new(recv)),
                total_len: u64::from_be_bytes(len) as f64,
                codec: h[14],
                tier: h[15],
            }
            .into())
        })
    }

    pub fn close(&self, code: u32, reason: String) {
        self.conn.close(VarInt::from_u32(code), reason.as_bytes());
    }

    /// Resolves `{"code": <application code or null>, "reason": "…"}` when the connection ends.
    pub fn closed(&self) -> Promise {
        let conn = self.conn.clone();
        future_to_promise(async move {
            let (code, reason) = match conn.closed().await {
                ConnectionError::ApplicationClosed(a) => (Some(a.error_code.into_inner()), String::from_utf8_lossy(&a.reason).to_string()),
                other => (None, other.to_string()),
            };
            Ok(JsValue::from_str(&serde_json::json!({ "code": code, "reason": reason }).to_string()))
        })
    }
}

async fn write_frame(send: &mut SendStream, body: &[u8]) -> Result<(), JsValue> {
    if body.len() > MAX_FRAME {
        return Err(js_err("frame too large"));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    send.write_all(&out).await.map_err(|e| js_err(format!("awsp-lost: {e}")))
}

/// The control stream: length-prefixed JSON frames both ways (§3.1).
#[wasm_bindgen]
pub struct AwspControl {
    send: Rc<Mutex<SendStream>>,
    recv: Rc<Mutex<RecvStream>>,
}

#[wasm_bindgen]
impl AwspControl {
    /// Send one frame (the JSON text of `{id, type, seq, payload}`).
    pub fn send(&self, json: String) -> Promise {
        let send = self.send.clone();
        future_to_promise(async move {
            write_frame(&mut *send.lock().await, json.as_bytes()).await?;
            Ok(JsValue::UNDEFINED)
        })
    }

    /// The next frame's JSON text, or `null` at a clean end of the stream.
    pub fn recv(&self) -> Promise {
        let recv = self.recv.clone();
        future_to_promise(async move {
            let mut r = recv.lock().await;
            let mut len = [0u8; 4];
            match r.read_exact(&mut len).await {
                Ok(()) => {}
                Err(ReadExactError::FinishedEarly(0)) => return Ok(JsValue::NULL),
                Err(ReadExactError::ReadError(e)) => return Err(read_err(e)),
                Err(e) => return Err(js_err(format!("awsp-lost: {e}"))),
            }
            let len = u32::from_be_bytes(len) as usize;
            if len > MAX_FRAME {
                let _ = r.stop(VarInt::from_u32(FRAME_TOO_LARGE));
                return Err(js_err("frame-too-large"));
            }
            let mut body = vec![0u8; len];
            match r.read_exact(&mut body).await {
                Ok(()) => {}
                Err(ReadExactError::ReadError(e)) => return Err(read_err(e)),
                Err(e) => return Err(js_err(format!("awsp-lost: {e}"))),
            }
            String::from_utf8(body).map(|s| JsValue::from_str(&s)).map_err(js_err)
        })
    }

    /// Finish the send side (a clean goodbye).
    pub fn finish(&self) -> Promise {
        let send = self.send.clone();
        future_to_promise(async move {
            let _ = send.lock().await.finish();
            Ok(JsValue::UNDEFINED)
        })
    }
}

/// An audio stream after its header: the range's bytes, in chunks of up to 64 KiB.
#[wasm_bindgen]
pub struct AwspAudio {
    recv: Rc<Mutex<RecvStream>>,
    total_len: f64,
    codec: u8,
    tier: u8,
}

#[wasm_bindgen]
impl AwspAudio {
    /// The whole file's length in bytes (§3.2 `total_len`).
    #[wasm_bindgen(getter)]
    pub fn total_len(&self) -> f64 {
        self.total_len
    }

    #[wasm_bindgen(getter)]
    pub fn codec(&self) -> u8 {
        self.codec
    }

    #[wasm_bindgen(getter)]
    pub fn tier(&self) -> u8 {
        self.tier
    }

    /// The next chunk as a `Uint8Array`, or `null` when the server finished the range.
    pub fn read(&self) -> Promise {
        let recv = self.recv.clone();
        future_to_promise(async move {
            match recv.lock().await.read_chunk(CHUNK).await {
                Ok(Some(bytes)) => Ok(Uint8Array::from(&bytes[..]).into()),
                Ok(None) => Ok(JsValue::NULL),
                Err(e) => Err(read_err(e)),
            }
        })
    }

    /// Stop the stream (`STOP_SENDING`, code 0): a seek or a cancelled request (§3.2).
    pub fn cancel(&self) -> Promise {
        let recv = self.recv.clone();
        future_to_promise(async move {
            let _ = recv.lock().await.stop(VarInt::from_u32(0));
            Ok(JsValue::UNDEFINED)
        })
    }
}
