#!/usr/bin/env bash
# D-1 acceptance, both ways. Bare output only; native exit codes captured.
cd /c/Users/jalon/AudioWave2.0-pass2/docker-container || exit 90
EV=../.agents/evidence/pass2

echo "=== D-1 VARIANT A: as-cloned (tracked data/.gitkeep present) ==="
echo "--- data dir BEFORE ---"
ls -la ./data 2>&1
echo "--- docker state BEFORE ---"
docker ps -a --format '{{.ID}} {{.Image}} {{.Names}} {{.Status}} {{.Ports}}'
docker volume ls --format '{{.Name}}'

S=$(date +%s)
docker compose up -d --build --wait > "$EV/d1-variantA-compose.log" 2>&1
echo "COMPOSE_NATIVE_EXIT=$?"
E=$(date +%s)
echo "ELAPSED=$((E-S))s"

echo "--- compose output (tail) ---"
tail -20 "$EV/d1-variantA-compose.log"
echo "--- container state ---"
docker ps -a --filter name=now-playing-hub --format '{{.ID}} {{.Status}} {{.Ports}}'
echo "--- healthz (bare curl) ---"
curl -sS -m 10 -w '\nHTTP_CODE=%{http_code}\n' http://127.0.0.1:4546/healthz 2>&1
echo "--- first 15 lines of hub log ---"
docker compose logs --no-color 2>&1 | head -15

echo
echo "=== D-1 VARIANT B: data dir REMOVED (Docker must create it or hub must fail loudly) ==="
docker compose down --remove-orphans > "$EV/d1-variantB-down.log" 2>&1
echo "DOWN_NATIVE_EXIT=$?"
rm -rf ./data
echo "--- data dir after rm ---"
ls -la ./data 2>&1

S=$(date +%s)
docker compose up -d --build --wait > "$EV/d1-variantB-compose.log" 2>&1
echo "COMPOSE_NATIVE_EXIT=$?"
E=$(date +%s)
echo "ELAPSED=$((E-S))s"

echo "--- compose output (tail) ---"
tail -20 "$EV/d1-variantB-compose.log"
echo "--- was data/ recreated? ---"
ls -la ./data 2>&1
echo "--- container state ---"
docker ps -a --filter name=now-playing-hub --format '{{.ID}} {{.Status}} {{.Ports}}'
echo "--- healthz (bare curl) ---"
curl -sS -m 10 -w '\nHTTP_CODE=%{http_code}\n' http://127.0.0.1:4546/healthz 2>&1
echo "--- first 20 lines of hub log (the failure line matters) ---"
docker compose logs --no-color 2>&1 | head -20

echo "=== D-1 DONE ==="
