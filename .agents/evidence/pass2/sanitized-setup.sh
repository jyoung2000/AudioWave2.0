#!/usr/bin/env bash
# §3.5 isolated acceptance run: automatic tool setup from NOTHING.
# Fresh APPDATA (so the owner's real companion profile and tools are untouched),
# and a sanitized PATH that excludes every directory providing ffmpeg/yt-dlp/spotDL.
# The product must not edit PATH; only this harness sanitizes the child env.
cd /c/Users/jalon/AudioWave2.0-pass2 || exit 90
EV=.agents/evidence/pass2
SANDBOX=/c/Users/jalon/np-sanitized
PROFILE="$SANDBOX/appdata"
mkdir -p "$SANDBOX"

# Keep the toolchain (node, pnpm) but exclude every directory that provides ffmpeg/yt-dlp/spotDL.
# Verified preflight below: the three tools must be unresolvable in this PATH.
NODE_DIR="/c/Users/jalon/AppData/Local/hermes/tools/node-26.7.0-win32-x64"
PNPM_DIR="/c/Users/jalon/AppData/Local/hermes/node"
CLEAN_PATH="$NODE_DIR:$PNPM_DIR:/c/Windows/system32:/c/Windows"

echo "=== PRE: prove the sanitized child CANNOT resolve any of the three ==="
echo "sanitized PATH will be: $CLEAN_PATH"
for t in ffmpeg ffprobe yt-dlp spotdl; do
  printf '  %-8s resolvable? ' "$t"
  PATH="$CLEAN_PATH" command -v "$t" >/dev/null 2>&1 && echo "YES (BAD - harness not clean)" || echo "no (good)"
done
echo "  node resolvable? $(PATH="$CLEAN_PATH" command -v node 2>&1)"

echo
echo "=== PRE: owner's real companion tools are left alone ==="
ls -la "/c/Users/jalon/AppData/Roaming/@now-playing/windows-companion/helper/tools" 2>&1 | tail -4

echo
echo "=== LAUNCH companion with fresh profile + sanitized PATH ==="
rm -rf "$PROFILE"
mkdir -p "$PROFILE"
S=$(date +%s)
env -u APPDATA -u LOCALAPPDATA \
    APPDATA="C:\\Users\\jalon\\np-sanitized\\appdata" \
    LOCALAPPDATA="C:\\Users\\jalon\\np-sanitized\\appdata" \
    PATH="$CLEAN_PATH" \
  pnpm dev:windows > "$EV/sanitized-companion.log" 2>&1 &
COMPANION_PID=$!
echo "COMPANION_PID=$COMPANION_PID"

echo "=== watch the tools dir fill (poll the SANDBOX, not the owner's) ==="
TD="$PROFILE/@now-playing/windows-companion/helper/tools"
for i in $(seq 1 60); do
  if [ -d "$TD" ]; then
    N=$(ls "$TD" 2>/dev/null | grep -viE 'setup-state' | wc -l)
    if [ "$N" -ge 3 ]; then echo "  3 tools present after ~$((i*10))s"; break; fi
  fi
  sleep 10
done
E=$(date +%s)
echo "ELAPSED=$((E-S))s"

echo
echo "=== RESULT: what the installer put in the SANDBOX ==="
ls -la "$TD" 2>&1
echo
echo "=== setup-state.json (installer record) ==="
cat "$TD/setup-state.json" 2>&1
echo
echo "=== log lines (order + versions) ==="
grep -iE 'setting up|set up|helper listening|ready|error|fail' "$EV/sanitized-companion.log" | head -25
echo
echo "=== helper health: ffmpeg origin should be 'installed', not 'path' ==="
curl -sS -m 10 http://127.0.0.1:17342/helper/v1/health 2>&1 | head -c 1200
echo
echo "=== SHA-256 of each installed tool (sandbox only) ==="
for f in "$TD"/yt-dlp.exe "$TD"/ffmpeg.exe "$TD"/spotdl.exe; do
  [ -f "$f" ] && echo "$(sha256sum "$f" | cut -d' ' -f1)  $(stat -c %s "$f")  $(basename "$f")"
done
echo "=== SANITIZED RUN DONE ==="
