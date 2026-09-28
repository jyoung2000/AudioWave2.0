#!/usr/bin/env bash
# §3.5 isolated acceptance, take 3.
# PATH method: the real user PATH minus the two directories that provide ffmpeg
# (Hermes tools dir AND the WinGet Links shim dir) -- the first two attempts leaked
# because ffmpeg was on PATH twice. /usr/bin is deliberately KEPT: pnpm's own shell shim
# needs sed/dirname/uname, and stripping it killed the harness (not the product).
# Fresh APPDATA: the owner's real companion profile and tools are never touched.
cd /c/Users/jalon/AudioWave2.0-pass2 || exit 90
EV=.agents/evidence/pass2
SANDBOX=/c/Users/jalon/np-sanitized
PROFILE="$SANDBOX/appdata"
mkdir -p "$SANDBOX"

ORIG="$PATH"
CLEAN=$(echo "$ORIG" | tr ':' '\n' | grep -v 'hermes/tools/ffmpeg' | grep -v 'Microsoft/WinGet/Links' | paste -sd: -)
echo "$CLEAN" > "$EV/sanitized-path.txt"

echo "=== PRE: sanitization method (this harness edits PATH; the product must not) ==="
echo "removed: every PATH entry containing 'hermes/tools/ffmpeg' or 'Microsoft/WinGet/Links'"
echo
echo "=== PRE: toolchain intact (else the harness breaks, not the product) ==="
for t in node pnpm git sed dirname uname; do
  printf '  %-8s %s\n' "$t" "$(PATH="$CLEAN" command -v $t 2>/dev/null || echo MISSING)"
done
echo
echo "=== PRE: the three tools must be unresolvable ==="
LEAK=0
for t in ffmpeg ffprobe yt-dlp spotdl; do
  r=$(PATH="$CLEAN" command -v $t 2>/dev/null)
  if [ -n "$r" ]; then echo "  $t LEAK: $r"; LEAK=1; else echo "  $t not resolvable (good)"; fi
done
echo "LEAK_FLAG=$LEAK"
echo
echo "=== PRE: owner's real tools dir (snapshot, must be untouched) ==="
ls -la "/c/Users/jalon/AppData/Roaming/@now-playing/windows-companion/helper/tools" 2>&1 | tail -4

echo
echo "=== LAUNCH: fresh APPDATA + sanitized PATH ==="
rm -rf "$PROFILE"; mkdir -p "$PROFILE"
S=$(date +%s)
env APPDATA="C:\\Users\\jalon\\np-sanitized\\appdata" \
    LOCALAPPDATA="C:\\Users\\jalon\\np-sanitized\\appdata" \
    PATH="$CLEAN" \
  pnpm dev:windows > "$EV/sanitized3-companion.log" 2>&1 &
echo "COMPANION_PID=$!"

TD="$PROFILE/@now-playing/windows-companion/helper/tools"
echo "=== watch the SANDBOX tools dir (never the owner's) ==="
for i in $(seq 1 100); do
  if grep -qiE 'set up spotdl|set up ffmpeg|set up yt-dlp' "$EV/sanitized3-companion.log" 2>/dev/null; then
    echo "  setup activity at ~$((i*10))s"; break
  fi
  sleep 10
done
E=$(date +%s); echo "ELAPSED=$((E-S))s"

echo
echo "=== RESULT: sandbox tools dir ==="
ls -la "$TD" 2>&1
echo
echo "=== setup-state.json (installer record) ==="
cat "$TD/setup-state.json" 2>&1
echo
echo "=== companion log: order, versions, errors ==="
grep -iE 'setting up|set up|helper listening|error|fail|retry' "$EV/sanitized3-companion.log" | head -30
echo
echo "=== health: origin + state per tool (ffmpeg must be 'installed', not 'path') ==="
curl -sS -m 10 http://127.0.0.1:17342/helper/v1/health 2>&1 | head -c 1500
echo; echo
echo "=== SHA-256 of each installed tool (sandbox) ==="
for f in "$TD"/yt-dlp.exe "$TD"/ffmpeg.exe "$TD"/spotdl.exe; do
  [ -f "$f" ] && echo "$(sha256sum "$f" | cut -d' ' -f1)  $(stat -c %s "$f")  $(basename "$f")"
done
echo "=== SANITIZED RUN DONE ==="
