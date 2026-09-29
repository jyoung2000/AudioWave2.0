#!/usr/bin/env bash
# Final pass §2: the five preview.spec.ts repetitions, SEQUENTIALLY, never overlapping.
# One unique log per run (pass 3's fatal flaw was two sweeps writing the same paths).
# Nothing else may use 4173 while this runs: no companion, no other suite.
cd /c/Users/jalon/AudioWave2.0-final/music-player || exit 90
S=/c/Users/jalon/AppData/Local/hermes/cache/scratch
R="$S/final-preview-runs"
rm -rf "$R"; mkdir -p "$R"

for i in 1 2 3 4 5; do
  LOG="$R/run-$i.log"
  START=$(date +%s)
  pnpm exec playwright test --config tests/e2e/playwright.config.ts np/preview.spec.ts > "$LOG" 2>&1
  E=$?
  ELAPSED=$(( $(date +%s) - START ))
  RESULT=$(grep -aoE '[0-9]+ (passed|failed|skipped)' "$LOG" | tr '\n' ' ')
  DIAG=$(grep -ac 'no search rows' "$LOG")
  REFUSED=$(grep -ac 'ERR_CONNECTION_REFUSED' "$LOG")
  {
    echo "RUN_$i native_exit=$E elapsed=${ELAPSED}s result=[$RESULT] searchDiag=$DIAG connRefused=$REFUSED"
  } >> "$R/summary.txt"
  # The decisive diagnostic, verbatim, if the run failed.
  if [ "$E" -ne 0 ]; then
    {
      echo "--- RUN_$i VERBATIM searchFor DIAGNOSTIC ---"
      grep -a 'no search rows for' "$LOG" | head -2
    } >> "$R/summary.txt"
  fi
  # Do not start run N+1 until this run's webServer has exited.
  for _ in $(seq 1 30); do
    netstat -ano 2>/dev/null | grep -qE ':4173\s+.*LISTENING' || break
    sleep 2
  done
done
echo "SWEEP_DONE" >> "$R/summary.txt"
