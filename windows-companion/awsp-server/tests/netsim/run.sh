#!/usr/bin/env bash
# NAT-simulated AWSP run (docs/AWSP.md §8). Linux, root. Called by .github/workflows/awsp-netsim.yml.
#
#   pub  (10.0.0.0/24)   the relay, reachable by both sides
#   nat1 (192.168.1/24)  the server, behind a masquerading router r1
#   nat2 (192.168.2/24)  the client, behind a masquerading router r2
#
# Mid-stream the server's uplink is blackholed for 3 s (tc netem loss 100%) — the outage the
# client must ride out on its buffer. Not run on the Windows machine this was written on.
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN=target/release/awsp-server
RELAY=$(command -v iroh-relay)
WORK=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; for n in pub r1 r2 nat1 nat2; do ip netns del $n 2>/dev/null || true; done; rm -rf "$WORK"' EXIT

for n in pub r1 r2 nat1 nat2; do ip netns add $n; ip -n $n link set lo up; done
link() { ip link add "$1" type veth peer name "$3"; ip link set "$1" netns "$2"; ip link set "$3" netns "$4"; ip -n "$2" addr add "$5" dev "$1"; ip -n "$4" addr add "$6" dev "$3"; ip -n "$2" link set "$1" up; ip -n "$4" link set "$3" up; }
link r1pub r1 pubr1 pub 10.0.0.11/24 10.0.0.1/24
link r2pub r2 pubr2 pub 10.0.0.12/24 10.0.0.2/24
link r1in  r1 n1out nat1 192.168.1.1/24 192.168.1.2/24
link r2in  r2 n2out nat2 192.168.2.1/24 192.168.2.2/24
ip -n pub link add br0 type bridge; ip -n pub link set br0 up
ip -n pub link set pubr1 master br0; ip -n pub link set pubr2 master br0
ip -n pub addr add 10.0.0.100/24 dev br0
for r in r1 r2; do ip netns exec $r sysctl -qw net.ipv4.ip_forward=1; ip netns exec $r iptables -t nat -A POSTROUTING -o ${r}pub -j MASQUERADE; done
ip -n nat1 route add default via 192.168.1.1
ip -n nat2 route add default via 192.168.2.1

# the relay on the public side
ip netns exec pub "$RELAY" --dev > "$WORK/relay.log" 2>&1 &
sleep 2
RELAY_URL=http://10.0.0.100:3340

# the fixture and the library
ffmpeg -loglevel error -f lavfi -i "sine=f=440:r=96000:d=40" -ac 2 -sample_fmt s32 -c:a flac "$WORK/hires.flac"
SHA=$(sha256sum "$WORK/hires.flac" | cut -d' ' -f1)
BYTES=$(stat -c %s "$WORK/hires.flac")
python3 - "$WORK" <<'PY'
import sqlite3, sys, os
w = sys.argv[1]
db = sqlite3.connect(os.path.join(w, "companion.sqlite"))
db.executescript("""
CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, watch INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL DEFAULT 'music', track_count INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0, last_scan_at TEXT, last_scan_error TEXT, created_at TEXT NOT NULL);
CREATE TABLE tracks (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, relative_path TEXT NOT NULL, track TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, content_hash TEXT, updated_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(folder_id, relative_path));
""")
db.execute("INSERT INTO folders (id, path, display_name, created_at) VALUES ('f1', ?, 'netsim', '2026-09-22T00:00:00Z')", (w,))
db.execute("INSERT INTO tracks (id, folder_id, relative_path, track, size_bytes, mtime_ms, updated_at) VALUES ('t1', 'f1', 'hires.flac', '{\"title\":\"Netsim\"}', ?, 0, '2026-09-22T00:00:00Z')", (os.path.getsize(os.path.join(w, "hires.flac")),))
db.commit()
PY

# keys: the server's, and a client already on its allowlist
SERVER_KEY=$(openssl rand -hex 32)
CLIENT_KEY=$(openssl rand -hex 32)
CLIENT_ID=$(cargo run --release --quiet --example public_key -- "$CLIENT_KEY" 2>/dev/null || true)
if [ -z "$CLIENT_ID" ]; then echo "needs examples/public_key.rs to derive the client's id"; exit 1; fi

mkfifo "$WORK/in"
ip netns exec nat1 env AWSP_LOG=info "$BIN" < "$WORK/in" > "$WORK/server.out" 2> "$WORK/server.log" &
exec 3> "$WORK/in"
echo "{\"secret_key_hex\":\"$SERVER_KEY\",\"library_db\":\"$WORK/companion.sqlite\",\"cache_dir\":\"$WORK/cache\",\"server_name\":\"netsim\",\"allowlist\":[{\"id\":\"$CLIENT_ID\",\"name\":\"netsim client\",\"tier_cap\":\"lossless\",\"paired_at\":\"2026-09-22T00:00:00Z\"}],\"relay_mode\":\"custom\",\"relay_urls\":[\"$RELAY_URL\"],\"relay_only\":false,\"bind_port\":null,\"insecure_relay_tls\":false}" >&3
for _ in $(seq 1 100); do grep -q '"event":"ready"' "$WORK/server.out" && break; sleep 0.2; done
TICKET=$(grep '"event":"ready"' "$WORK/server.out" | head -1 | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["ticket"])')

# the outage: 6 s into the run, the server's uplink drops everything for 3 s
( sleep 6; ip netns exec r1 tc qdisc add dev r1pub root netem loss 100%; sleep 3; ip netns exec r1 tc qdisc del dev r1pub root ) &

ip netns exec nat2 env AWSP_NETSIM_TICKET="$TICKET" AWSP_NETSIM_CLIENT_KEY="$CLIENT_KEY" AWSP_NETSIM_TRACK=t1 \
  AWSP_NETSIM_SHA256="$SHA" AWSP_NETSIM_BYTES="$BYTES" \
  cargo test --release --test netsim -- --ignored --nocapture
echo '{"cmd":"shutdown"}' >&3
grep -E "awsp connection" "$WORK/server.log" || true
