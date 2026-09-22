//! AWSP server integration tests over real iroh connections (docs/AWSP.md §8).

mod common;

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use awsp_server::{
    Command, Event, Tier,
    config::RelayModeConfig,
    protocol::{codec, codes, track_id_hash},
};
use common::*;
use iroh::{
    SecretKey,
    endpoint::{ConnectionError, VarInt},
};
use rand::RngCore;
use serde_json::json;
use tokio::sync::Mutex;

fn closed_with(err: &ConnectionError, code: u32) -> bool {
    matches!(err, ConnectionError::ApplicationClosed(c) if c.error_code == VarInt::from_u32(code))
}

/// 1. Range correctness: open-ended, single-byte, chunk-crossing, last-byte and clamped ranges
/// return exactly the file's bytes; bad ranges, tracks and tiers reset with the spec's codes.
#[tokio::test]
async fn range_requests_return_exact_bytes() {
    init_tracing();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("noise.flac");
    let mut data = vec![0u8; 300_007];
    rand::rng().fill_bytes(&mut data);
    std::fs::write(&file, &data).unwrap();
    let mut cfg = base_config(dir.path());
    make_library(&cfg.library_db, &[("t1", &file, 1000)]);
    let key = SecretKey::generate();
    cfg.allowlist = vec![allow(&key, Tier::Lossless)];
    let h = start(cfg, dir).await;

    let client = direct_client(key).await;
    let conn = connect(&client, &h.addr).await;
    let mut control = Control::open(&conn).await;
    let welcome = control.hello().await;
    assert_eq!(welcome.payload["server_name"], "Test Companion");
    assert_eq!(welcome.payload["connection"], "direct");
    assert_eq!(welcome.payload["resume_token"].as_str().unwrap().len(), 64);
    control.expect("state").await;
    let id = control.send("ping", json!({})).await;
    assert_eq!(control.expect("pong").await.re, Some(id));
    control.send("browse", json!({ "query": "Track", "page": 0 })).await;
    let page = control.expect("library_page").await;
    assert_eq!(page.payload["total"], 1);
    assert_eq!(page.payload["items"][0]["id"], "t1");

    let len = data.len() as u64;
    let cases: &[(u64, Option<u64>)] = &[
        (0, None),
        (0, Some(0)),
        (5, None),
        (1000, Some(70_000)),
        (65_536, Some(131_071)),
        (len - 1, None),
        (len - 1, Some(len - 1)),
        (len - 100, Some(len + 500)),
    ];
    for &(start, end) in cases {
        let (header, body) = fetch(&conn, json!({ "track_id": "t1", "byte_start": start, "byte_end": end, "tier": "lossless" }))
            .await
            .unwrap_or_else(|code| panic!("range {start}..{end:?} reset with {code:#x}"));
        let stop = end.unwrap_or(len - 1).min(len - 1);
        assert_eq!(header.total_len, len);
        assert_eq!(header.codec, codec::FLAC);
        assert_eq!(header.tier, 0);
        assert_eq!(header.track_id_hash, track_id_hash("t1"));
        assert_eq!(body, &data[start as usize..=stop as usize], "range {start}..{end:?}");
    }

    let reset = |req| fetch(&conn, req);
    assert_eq!(reset(json!({ "track_id": "t1", "byte_start": len })).await.unwrap_err(), codes::RANGE as u64);
    assert_eq!(reset(json!({ "track_id": "t1", "byte_start": 10, "byte_end": 5 })).await.unwrap_err(), codes::RANGE as u64);
    assert_eq!(reset(json!({ "track_id": "nope", "byte_start": 0 })).await.unwrap_err(), codes::NOT_FOUND as u64);
    assert_eq!(reset(json!({ "track_id": "t1", "byte_start": 0, "tier": "ultra" })).await.unwrap_err(), codes::TIER as u64);
    assert_eq!(reset(json!({ "nonsense": true })).await.unwrap_err(), codes::BAD_REQUEST as u64);
    println!("range test: {} ranges byte-exact, 5 error resets correct", cases.len());
}

/// 2. Bit identity: a 24-bit/96 kHz FLAC streamed whole over a real iroh connection is
/// byte-for-byte the file (SHA-256). Also: the tier cap clamps a lossless request to Opus.
#[tokio::test]
async fn hires_flac_is_bit_identical() {
    init_tracing();
    let dir = tempfile::tempdir().unwrap();
    let Some(flac) = hires_flac(dir.path(), 20).await else { return };
    let source = std::fs::read(&flac).unwrap();
    let mut cfg = base_config(dir.path());
    make_library(&cfg.library_db, &[("hires", &flac, 20_000)]);
    let key = SecretKey::generate();
    cfg.allowlist = vec![allow(&key, Tier::Lossless)];
    let h = start(cfg, dir).await;

    let client = direct_client(key.clone()).await;
    let conn = connect(&client, &h.addr).await;
    let mut control = Control::open(&conn).await;
    control.hello().await;

    let started = Instant::now();
    let (header, body) = fetch(&conn, json!({ "track_id": "hires", "byte_start": 0, "byte_end": null })).await.expect("lossless fetch");
    let secs = started.elapsed().as_secs_f64();
    assert_eq!(header.codec, codec::FLAC);
    assert_eq!(header.total_len, source.len() as u64);
    assert_eq!(body.len(), source.len());
    assert_eq!(sha256(&body), sha256(&source), "streamed bytes differ from the file");
    println!(
        "bit identity: {} bytes, sha256 {} equal, {:.1} Mbit/s over iroh",
        body.len(),
        &sha256(&body)[..16],
        body.len() as f64 * 8.0 / secs / 1e6
    );

    // A device capped at `saver` asking for lossless gets Opus 128k from the cache.
    assert!(h.server.command(Command::SetTierCap { id: key.public().to_string(), tier: Tier::Saver }));
    let (header, body) = fetch(&conn, json!({ "track_id": "hires", "byte_start": 0, "tier": "lossless" })).await.expect("clamped fetch");
    assert_eq!(header.tier, Tier::Saver.byte());
    assert_eq!(header.codec, codec::OPUS);
    assert_eq!(&body[..4], b"OggS");
    assert!(body.len() < source.len() / 5, "opus is much smaller than the 24/96 source");
    // Second request is served from the cache: same bytes.
    let (_, again) = fetch(&conn, json!({ "track_id": "hires", "byte_start": 0, "tier": "saver" })).await.expect("cached fetch");
    assert_eq!(sha256(&again), sha256(&body));
}

/// 3. Relay-only with an outage: both endpoints relay-only through a local relay (behind a TCP
/// proxy that can be stalled), the path is `relay`, and a 24/96 FLAC plays through a client-side
/// 20 s buffer model (target 20 s, low-water 5 s, real-time playback) across a 3 s relay stall
/// with zero underruns, arriving byte-identical.
#[tokio::test]
async fn relay_only_survives_a_three_second_outage() {
    init_tracing();
    const DURATION_MS: u64 = 30_000;
    const TARGET_MS: f64 = 20_000.0;
    const LOW_WATER_MS: f64 = 5_000.0;
    // Stall the relay 1.5 s before the buffer reaches low-water, so the refill request is issued
    // *during* the outage and the buffer drains to ~3.5 s before the relay comes back.
    const OUTAGE_AT_AHEAD_MS: f64 = LOW_WATER_MS + 1_500.0;
    const OUTAGE: Duration = Duration::from_secs(3);

    let dir = tempfile::tempdir().unwrap();
    let Some(flac) = hires_flac(dir.path(), (DURATION_MS / 1000) as u32).await else { return };
    let source = Arc::new(std::fs::read(&flac).unwrap());
    let total = source.len() as u64;

    let (_relay_map, relay_url, _relay) = iroh::test_utils::run_relay_server_with(false).await.expect("local relay");
    let relay_addr = format!("{}:{}", relay_url.host_str().unwrap(), relay_url.port().unwrap()).parse().unwrap();
    let stall = Arc::new(AtomicBool::new(false));
    let proxy = stallable_proxy(relay_addr, stall.clone()).await;
    let proxy_url: iroh::RelayUrl = format!("https://127.0.0.1:{}", proxy.port()).parse().unwrap();

    let key = SecretKey::generate();
    let mut cfg = base_config(dir.path());
    make_library(&cfg.library_db, &[("hires", &flac, DURATION_MS)]);
    cfg.allowlist = vec![allow(&key, Tier::Lossless)];
    cfg.relay_mode = RelayModeConfig::Custom;
    cfg.relay_urls = vec![proxy_url.to_string()];
    cfg.insecure_relay_tls = true;
    cfg.apply_env(|k| (k == "AWSP_RELAY_ONLY").then(|| "1".to_string()));
    assert!(cfg.relay_only);
    let mut h = start(cfg, dir).await;

    let client = relay_only_client(key, proxy_url).await;
    let conn = connect(&client, &h.addr).await;
    let mut control = Control::open(&conn).await;
    assert_eq!(control.hello().await.payload["connection"], "relay");
    for p in conn.paths().iter() {
        assert!(p.is_relay(), "relay-only connection has a non-relay path: {:?}", p.remote_addr());
    }
    let Event::Connection { kind, .. } = h.event(|e| matches!(e, Event::Connection { .. })).await else { unreachable!() };
    assert_eq!(kind, "relay", "server reports the path type");

    let bytes_per_ms = total as f64 / DURATION_MS as f64;
    let chunk = (bytes_per_ms * 1000.0) as u64; // one second of audio per request
    let received = Arc::new(AtomicU64::new(0));
    let played = Arc::new(AtomicU64::new(0));
    let got = Arc::new(Mutex::new(Vec::with_capacity(source.len())));
    let retries = Arc::new(AtomicU64::new(0));

    // The fetch loop: fill to the 20 s target, pause, resume below the 5 s low-water mark; each
    // request re-issued from the last contiguous byte if it fails.
    let fetcher = {
        let (conn, received, played, got, retries) = (conn.clone(), received.clone(), played.clone(), got.clone(), retries.clone());
        tokio::spawn(async move {
            let mut paused = false;
            while received.load(Ordering::SeqCst) < total {
                let have = received.load(Ordering::SeqCst);
                let ahead_ms = (have - played.load(Ordering::SeqCst).min(have)) as f64 / bytes_per_ms;
                if paused && ahead_ms > LOW_WATER_MS {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    continue;
                }
                paused = false;
                if ahead_ms >= TARGET_MS {
                    paused = true;
                    continue;
                }
                let end = (have + chunk).min(total) - 1;
                match fetch(&conn, json!({ "track_id": "hires", "byte_start": have, "byte_end": end })).await {
                    Ok((header, body)) => {
                        assert_eq!(header.total_len, total);
                        got.lock().await.extend_from_slice(&body);
                        received.fetch_add(body.len() as u64, Ordering::SeqCst);
                    }
                    Err(code) => {
                        retries.fetch_add(1, Ordering::SeqCst);
                        eprintln!("fetch at {have} failed ({code:#x}); retrying from the last contiguous byte");
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }
            }
        })
    };

    // Prebuffer to the target, then play in real time.
    let target_bytes = ((TARGET_MS * bytes_per_ms) as u64).min(total);
    let t0 = Instant::now();
    while received.load(Ordering::SeqCst) < target_bytes {
        assert!(t0.elapsed() < Duration::from_secs(30), "prebuffer did not fill");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    println!("prebuffered 20 s ({target_bytes} bytes) in {} ms over the relay", t0.elapsed().as_millis());

    let mut underruns = 0u32;
    let mut in_underrun = false;
    let mut min_ahead_ms = f64::MAX;
    let mut outage: Option<Instant> = None;
    let mut outage_done = false;
    let mut position_ms: f64 = 0.0;
    let mut last = Instant::now();
    while position_ms < DURATION_MS as f64 {
        tokio::time::sleep(Duration::from_millis(10)).await;
        let now = Instant::now();
        let dt = now.duration_since(last).as_secs_f64() * 1000.0;
        last = now;
        let have = received.load(Ordering::SeqCst);
        let want = ((position_ms + dt) * bytes_per_ms).min(total as f64) as u64;
        if want > have {
            // Underrun: the playhead would pass the last received byte. Hold it there.
            if !in_underrun {
                underruns += 1;
                in_underrun = true;
                eprintln!("UNDERRUN at {:.0} ms (have {have}, need {want})", position_ms);
            }
            continue;
        }
        in_underrun = false;
        position_ms += dt;
        played.store(want, Ordering::SeqCst);
        if have < total {
            min_ahead_ms = min_ahead_ms.min((have - want) as f64 / bytes_per_ms);
        }
        let ahead_ms = (have - want) as f64 / bytes_per_ms;
        if !outage_done && outage.is_none() && position_ms > 1_000.0 && ahead_ms <= OUTAGE_AT_AHEAD_MS {
            println!("relay stalled at {position_ms:.0} ms with {ahead_ms:.0} ms buffered");
            stall.store(true, Ordering::SeqCst);
            outage = Some(now);
        }
        if let Some(at) = outage
            && now.duration_since(at) >= OUTAGE {
                stall.store(false, Ordering::SeqCst);
                outage = None;
                outage_done = true;
                println!("relay resumed at {position_ms:.0} ms with {ahead_ms:.0} ms buffered");
            }
    }
    tokio::time::timeout(T, fetcher).await.expect("fetcher finished").unwrap();
    let got = got.lock().await;
    println!(
        "outage test: underruns={underruns} min_buffer={min_ahead_ms:.0} ms retries={} bytes={}",
        retries.load(Ordering::SeqCst),
        got.len()
    );
    assert!(outage_done, "the outage happened");
    assert!(min_ahead_ms < LOW_WATER_MS, "the outage overlapped a refill (buffer went below low-water)");
    assert_eq!(underruns, 0, "the 20 s buffer rode out the 3 s outage");
    assert_eq!(got.len(), source.len());
    assert_eq!(sha256(&got), sha256(&source), "relay-carried bytes are bit-identical");
}

/// 4. The allowlist: an unknown endpoint is refused with 0x1; pairing with the live code adds it;
/// five wrong codes void the code; revoking closes the live connection.
#[tokio::test]
async fn allowlist_and_pairing() {
    init_tracing();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.mp3");
    std::fs::write(&file, b"ID3 not really an mp3 but bytes are bytes").unwrap();
    let cfg = base_config(dir.path());
    make_library(&cfg.library_db, &[("t1", &file, 1000)]);
    let mut h = start(cfg, dir).await;

    // Unknown endpoint: hello is refused, and so is an audio fetch as its first stream.
    let stranger = direct_client(SecretKey::generate()).await;
    let conn = connect(&stranger, &h.addr).await;
    let mut control = Control::open(&conn).await;
    control.send("hello", json!({ "device_name": "x", "client_kind": "pwa", "protocol_version": 1 })).await;
    let err = tokio::time::timeout(T, conn.closed()).await.unwrap();
    assert!(closed_with(&err, codes::UNKNOWN_DEVICE), "unknown endpoint closed with 0x1, got {err:?}");
    let conn = connect(&stranger, &h.addr).await;
    assert!(fetch(&conn, json!({ "track_id": "t1", "byte_start": 0 })).await.is_err());
    let err = tokio::time::timeout(T, conn.closed()).await.unwrap();
    assert!(closed_with(&err, codes::UNKNOWN_DEVICE));

    // Pair with the live code.
    assert!(h.server.command(Command::NewPairingCode));
    let Event::PairingCode { code, expires_at } = h.event(|e| matches!(e, Event::PairingCode { .. })).await else { unreachable!() };
    assert_eq!(code.len(), 6);
    assert!(expires_at.ends_with('Z'));
    let phone_key = SecretKey::generate();
    let phone = direct_client(phone_key.clone()).await;
    let conn = connect(&phone, &h.addr).await;
    let mut control = Control::open(&conn).await;
    control.send("pair", json!({ "code": code, "device_name": "Pixel", "client_kind": "android" })).await;
    assert_eq!(control.expect("paired").await.payload["server_name"], "Test Companion");
    let paired = h.event(|e| matches!(e, Event::Paired { .. })).await;
    assert_eq!(paired, Event::Paired { id: phone_key.public().to_string(), name: "Pixel".into(), client_kind: "android".into() });
    control.hello().await;
    let (header, body) = fetch(&conn, json!({ "track_id": "t1", "byte_start": 0 })).await.expect("paired device can fetch");
    assert_eq!(header.codec, codec::MP3);
    assert_eq!(body, std::fs::read(&file).unwrap());
    // The code was single-use.
    let other = direct_client(SecretKey::generate()).await;
    let c = connect(&other, &h.addr).await;
    let mut ctl = Control::open(&c).await;
    ctl.send("pair", json!({ "code": code, "device_name": "Again", "client_kind": "pwa" })).await;
    assert_eq!(ctl.expect("error").await.payload["code"], "pair-no-code");

    // Five wrong codes void a fresh code: the right one is refused afterwards.
    assert!(h.server.command(Command::NewPairingCode));
    let Event::PairingCode { code, .. } = h.event(|e| matches!(e, Event::PairingCode { .. })).await else { unreachable!() };
    let wrong = if code == "000000" { "999999" } else { "000000" };
    let guesser_key = SecretKey::generate();
    let guesser = direct_client(guesser_key.clone()).await;
    for attempt in 1..=5 {
        let c = connect(&guesser, &h.addr).await;
        let mut ctl = Control::open(&c).await;
        ctl.send("pair", json!({ "code": wrong, "device_name": "Guess", "client_kind": "pwa" })).await;
        assert_eq!(ctl.expect("error").await.payload["code"], "pair-rejected", "attempt {attempt}");
        let err = tokio::time::timeout(T, c.closed()).await.unwrap();
        assert!(closed_with(&err, codes::UNKNOWN_DEVICE));
    }
    let c = connect(&guesser, &h.addr).await;
    let mut ctl = Control::open(&c).await;
    ctl.send("pair", json!({ "code": code, "device_name": "Guess", "client_kind": "pwa" })).await;
    assert_eq!(ctl.expect("error").await.payload["code"], "pair-no-code", "the code is void after five wrong tries");
    let err = tokio::time::timeout(T, c.closed()).await.unwrap();
    assert!(closed_with(&err, codes::UNKNOWN_DEVICE));

    // Revoking the paired phone closes its live connection with 0x1.
    assert!(h.server.command(Command::Revoke { id: phone_key.public().to_string() }));
    let err = tokio::time::timeout(T, conn.closed()).await.unwrap();
    assert!(closed_with(&err, codes::UNKNOWN_DEVICE), "revoked connection closed with 0x1, got {err:?}");
    let c = connect(&phone, &h.addr).await;
    let mut ctl = Control::open(&c).await;
    ctl.send("hello", json!({ "device_name": "Pixel", "client_kind": "android", "protocol_version": 1 })).await;
    let err = tokio::time::timeout(T, c.closed()).await.unwrap();
    assert!(closed_with(&err, codes::UNKNOWN_DEVICE), "revoked device is unknown again");
}
