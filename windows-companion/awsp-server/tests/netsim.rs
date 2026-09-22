//! The NAT-simulated test (docs/AWSP.md §8). **CI-only, Linux**: `.github/workflows/awsp-netsim.yml`
//! puts the real server behind one NAT and this client behind another (network namespaces with
//! masquerading), with a relay on the "public" side, and blackholes the server's uplink for 3 s
//! mid-stream. It is `#[ignore]`d so a normal `cargo test` never runs it, and it has **not been run
//! on the Windows machine this was written on** — the namespaces need Linux and root.
//!
//! The client streams the 24-bit/96 kHz fixture in ranges, resuming from its last contiguous byte
//! after any failure, and asserts the bytes are identical to the source and that no gap between
//! chunks was longer than the 20 s buffer the clients keep.

mod common;

use std::str::FromStr;
use std::time::{Duration, Instant};

use common::*;
use iroh::SecretKey;
use serde_json::json;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set by tests/netsim/run.sh"))
}

#[tokio::test]
#[ignore = "CI-only: needs Linux network namespaces (see .github/workflows/awsp-netsim.yml)"]
async fn streams_across_two_nats_and_survives_a_three_second_outage() {
    init_tracing();
    let ticket = iroh_tickets::endpoint::EndpointTicket::from_str(&env("AWSP_NETSIM_TICKET")).expect("ticket");
    let key = SecretKey::from_str(&env("AWSP_NETSIM_CLIENT_KEY")).expect("client key");
    let track = env("AWSP_NETSIM_TRACK");
    let want_sha = env("AWSP_NETSIM_SHA256");
    let total: u64 = env("AWSP_NETSIM_BYTES").parse().expect("byte count");

    let client = direct_client(key).await;
    let conn = connect(&client, &ticket.endpoint_addr()).await;
    let mut control = Control::open(&conn).await;
    control.hello().await;

    const CHUNK: u64 = 256 * 1024;
    let mut got: Vec<u8> = Vec::with_capacity(total as usize);
    let mut longest_gap = Duration::ZERO;
    let mut last = Instant::now();
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut conn = conn;
    while (got.len() as u64) < total {
        assert!(Instant::now() < deadline, "did not finish in time; held {} of {total} bytes", got.len());
        let start = got.len() as u64;
        let end = (start + CHUNK - 1).min(total - 1);
        match fetch(&conn, json!({ "track_id": track, "byte_start": start, "byte_end": end, "tier": "lossless" })).await {
            Ok((_, bytes)) => {
                got.extend_from_slice(&bytes);
                longest_gap = longest_gap.max(last.elapsed());
                last = Instant::now();
            }
            Err(_) => {
                // The path went away: reconnect and carry on from the last contiguous byte.
                tokio::time::sleep(Duration::from_millis(250)).await;
                if let Ok(c) = tokio::time::timeout(T, client.connect(ticket.endpoint_addr().clone(), b"awsp/1")).await {
                    if let Ok(c) = c {
                        conn = c;
                        let mut control = Control::open(&conn).await;
                        control.hello().await;
                    }
                }
            }
        }
    }
    assert_eq!(sha256(&got), want_sha, "the bytes that arrived are the source's bytes");
    assert!(longest_gap < Duration::from_secs(20), "no gap outlasted the 20 s buffer (longest {longest_gap:?})");
    eprintln!("netsim: {} bytes, longest gap {:?}", got.len(), longest_gap);
}
