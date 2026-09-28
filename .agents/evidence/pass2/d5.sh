#!/usr/bin/env bash
# D-5 acceptance: disposable journey hub on 4550 must pass and leave nothing behind,
# without touching the hub on 4546. Bare output; native exit codes.
cd /c/Users/jalon/AudioWave2.0-pass2 || exit 90
EV=.agents/evidence/pass2

echo "=== BEFORE: containers (4546 must be the only hub) ==="
docker ps -a --format '{{.ID}} {{.Image}} {{.Names}} {{.Status}} {{.Ports}}' | tee "$EV/d5-docker-ps-BEFORE.log"
echo "=== BEFORE: volumes ==="
docker volume ls --format '{{.Name}}' | tee "$EV/d5-docker-vol-BEFORE.log"
echo "=== BEFORE: 4546 healthz + container id ==="
docker ps --filter name=now-playing-hub --format '{{.ID}} {{.Status}}' | tee "$EV/d5-4546-BEFORE.log"
curl -sS -m 10 -w '\nHTTP_CODE=%{http_code}\n' http://127.0.0.1:4546/healthz

echo
echo "=== RUN: pnpm test:journey:container ==="
S=$(date +%s)
pnpm test:journey:container > "$EV/d5-journey-container.log" 2>&1
echo "JOURNEY_CONTAINER_NATIVE_EXIT=$?"
E=$(date +%s)
echo "ELAPSED=$((E-S))s"
echo "--- journey output (tail 30) ---"
tail -30 "$EV/d5-journey-container.log"
echo "--- passed/failed lines ---"
grep -E 'passed|failed|Error' "$EV/d5-journey-container.log" | tail -8

echo
echo "=== AFTER: containers (4550 gone, 4546 unchanged) ==="
docker ps -a --format '{{.ID}} {{.Image}} {{.Names}} {{.Status}} {{.Ports}}' | tee "$EV/d5-docker-ps-AFTER.log"
echo "=== AFTER: volumes (diff vs before) ==="
docker volume ls --format '{{.Name}}' | tee "$EV/d5-docker-vol-AFTER.log"
echo "--- volume diff (empty = no residue) ---"
diff "$EV/d5-docker-vol-BEFORE.log" "$EV/d5-docker-vol-AFTER.log" && echo "NO_VOLUME_RESIDUE"
echo "--- container diff (only 4546 identity should persist) ---"
diff "$EV/d5-docker-ps-BEFORE.log" "$EV/d5-docker-ps-AFTER.log" && echo "NO_CONTAINER_RESIDUE"
echo "=== AFTER: 4546 healthz (must still answer) ==="
curl -sS -m 10 -w '\nHTTP_CODE=%{http_code}\n' http://127.0.0.1:4546/healthz
echo "=== D-5 DONE ==="
