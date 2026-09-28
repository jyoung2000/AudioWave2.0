#!/usr/bin/env bash
# §3.5 isolated acceptance run, take 2.
# The first attempt died because the sanitized PATH had no coreutils, so pnpm's own
# shell shim (`sed`, `dirname`, `uname`) could not run. This run keeps the standard
# Windows system directories and Node, and REMOVES only the directories that provide
# ffmpeg/yt-dlp/spotDL. The product still never edits PATH - only this harness does.
cd /c/Users/jalon/AudioWave2.0-pass2 || exit 90
EV=.agents/evidence/pass2
SANDBOX=/c/Users/jalon/np-sanitized
PROFILE="$SANDBOX/appdata"
mkdir -p "$SANDBOX"

# Keep: Windows system32 (cmd/sed equivalents live here for the shim), mingw64 (coreutils),
# node, pnpm, git. Remove: the Hermes ffmpeg tool directory and any other tool dir.
KEEP="/c/Windows/system32:/c/Windows:/c/Windows/System32/Wbem:/mingw64/bin"
NODE_DIR="/c/Users/jalon/AppData/Local/hermes/tools/node-26.7.0-win32-x64"
PNPM_DIR="/c/Users/jalon/AppData/Local/hermes/node"
GIT_DIR="/mingw64/bin"
CLEAN_PATH="$KEEP:$NODE_DIR:$PNPM_DIR:$GIT_DIR"

echo "=== PRE: harness can still run the toolchain under this PATH ==="
for t in node pnpm git sed dirname uname; do
  printf '  %-8s ' "$t"
  PATH="$CLEAN_PATH" command -v "$t" >/dev/null 2>&1 && echo "resolvable (ok)" || echo "MISSING (harness would break)"
done

echo
echo "=== PRE: the three tools must NOT be resolvable under this PATH ==="
LEAK=0
for t in ffmpeg ffprobe yt-dlp spotdl; do
  printf '  %-8s ' "$t"
  if PATH="$CLEAN_PATH" command -v "$t" >/dev/null 2>&1; then echo "RESOLVABLE (harness NOT clean)"; LEAK=1; else echo "not resolvable (good)"; fi
done
echo "LEAK_FLAG=$LEAK"

echo
echo "=== PRE: full PATH (what a normal user launch sees) ==="
for t in ffmpeg ffprobe yt-dlp spotdl; do
  printf '  %-8s %s\n' "$t" "$(command -v $t 2>/dev/null || echo not-on-PATH)"
done

echo
echo "=== PRE: owner's real tools dir is recorded, not touched ==="
ls -la "/c/Users/jalon/AppData/Roaming/@now-playing/windows-companion/helper/tools" 2>&1 | tail -4

echo
echo "=== LAUNCH: fresh APPDATA + sanitized PATH ==="
rm -rf "$PROFILE"
mkdir -p "$PROFILE"
S=$(date +%s)
env APPDATA="C:\\Users\\jalon\\np-sanitized\\appdata" \
    LOCALAPPDATA="C:\\Users\\jalon\\np-sanitized\\appdata" \
    PATH="$CLEAN_PATH" \
  pnpm dev:windows > "$EV/sanitized-companion.log" 2>&1 &
COMPANION_PID=$!
echo "COMPANION_PID=$COMPANION_PID"

TD="$PROFILE/@now-playing/windows-companion/helper/tools"
echo "=== watch SANDBOX tools dir (not the owner's) ==="
for i in $(seq 1 90); do
  if [ -f "$EV/sanitized-companion.log" ]; then
    if grep -qiE 'set up spotdl|set up ffmpeg|all three|done' "$EV/sanitized-companion.log" 2>/dev/null; then
      echo "  (setup activity seen at ~$((i*10))s)"; break
    fi
  fi
  sleep 10
done
E=$(date +%s)
echo "ELAPSED=$((E-S))s"

echo
echo "=== RESULT: sandbox tools dir ==="
ls -la "$TD" 2>&1
echo
echo "=== setup-state.json ==="
cat "$TD/setup-state.json" 2>&1
echo
echo "=== companion log: setup order + versions + errors ==="
grep -iE 'setting up|set up|helper listening|error|fail|retry' "$EV/sanitized-companion.log" | head -30
echo
echo "=== health: every tool's origin + state ==="
curl -sS -m 10 http://127.0.0.1:17342/helper/v1/health 2>&1 | head -c 1400
echo
echo
echo "=== SHA-256 of each installed tool (sandbox only) ==="
for f in "$TD"/yt-dlp.exe "$TD"/ffmpeg.exe "$TD"/spotdl.exe; do
  [ -f "$f" ] && echo "$(sha256sum "$f" | cut -d' ' -f1)  $(stat -c %s "$f")  $(basename "$f")"
done
echo "=== SANITIZED RUN DONE ==="
