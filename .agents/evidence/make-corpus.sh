#!/usr/bin/env bash
# Build a deterministic test music corpus for the Hermes triage.
#
# Every tempo-bearing file is a click train generated at an EXACT known BPM, so a
# "measured" tempo reported by the companion can be judged for plausibility rather
# than merely checked for presence. Half the files carry a BPM tag (truth value kept
# in the tag); half are written with -map_metadata -1 so they provably have no tag
# (verified with ffprobe afterwards).
#
# Usage: bash .agents/evidence/make-corpus.sh [destDir]
set -euo pipefail

DEST="${1:-C:/Music/NowPlayingTest}"
FF="${FFMPEG:-ffmpeg}"
FP="${FFPROBE:-ffprobe}"

command -v "$FF" >/dev/null 2>&1 || { echo "FATAL: ffmpeg not on PATH"; exit 1; }

mkdir -p "$DEST"
echo "corpus -> $DEST"

# click <bpm> -> the beat period in seconds (60/bpm).
click() {
  awk -v b="$1" 'BEGIN { printf "%.6f", 60.0 / b }'
}

# One track: name, bpm, seconds, encoder(flac|mp3), tagged(yes|no), style
mk() {
  local name="$1" bpm="$2" secs="$3" enc="$4" tagged="$5" style="${6:-click}"
  local dest="$DEST/$name"
  mkdir -p "$(dirname "$dest")"
  local period; period="$(click "$bpm")"
  local src
  case "$style" in
    click)   # decaying 1.2 kHz tick train: unambiguous onsets for tempo detection
      src="aevalsrc=0.85*exp(-22*mod(t\,$period))*sin(2*PI*1200*mod(t\,$period)):s=44100:d=$secs" ;;
    tone)    # pure musical tone with no transients: a tempo detector SHOULD fail
      src="sine=frequency=220:sample_rate=44100:duration=$secs" ;;
    mel)     # simple chord with a beat: mild real-music shape
      src="aevalsrc=0.5*(sin(2*PI*220*t)+0.5*sin(2*PI*330*t))*(0.6+0.4*exp(-14*mod(t\,$period))):s=44100:d=$secs" ;;
    *) echo "unknown style $style" >&2; exit 1 ;;
  esac

  if [ "$enc" = flac ]; then codec=(-c:a flac -compression_level 5); ext=flac
  else                      codec=(-c:a libmp3lame -b:a 192k); ext=mp3; fi

  if [ "$tagged" = yes ]; then
    "$FF" -hide_banner -loglevel error -y -f lavfi -i "$src" \
      "${codec[@]}" -metadata "title=Known ${bpm}BPM" -metadata "artist=Hermes Test Corpus" \
      -metadata "album=Triage Corpus" -metadata "BPM=${bpm}" "$dest.$ext"
  else
    # -map_metadata -1 drops every tag INCLUDING any BPM, then we assert it with ffprobe.
    "$FF" -hide_banner -loglevel error -y -f lavfi -i "$src" \
      "${codec[@]}" -map_metadata -1 -metadata "title=Untagged ${bpm}BPM" \
      -metadata "artist=Hermes Test Corpus" -metadata "album=Triage Corpus" "$dest.$ext"
  fi
  printf '  %-46s %-4s bpm=%-3s tagged=%-3s\n' "$name.$ext" "$enc" "$bpm" "$tagged"
}

echo "-- album: Tagged Truth (values must stay plain, never rewritten) --"
mk "Tagged/01_kick_120bpm"        120 30 flac yes click
mk "Tagged/02_kick_90bpm"          90 30 flac yes click
mk "Tagged/03_kick_140bpm_mp3"    140 25 mp3  yes click
mk "Tagged/04_kick_128bpm_mp3"    128 30 mp3  yes click

echo "-- album: Untagged (the companion must MEASURE these, shown with approx mark) --"
mk "Untagged/01_kick_100bpm"      100 30 flac no click
mk "Untagged/02_kick_120bpm"      120 30 flac no click
mk "Untagged/03_kick_132bpm_mp3"  132 25 mp3  no click
mk "Untagged/04_kick_110bpm_mp3"  110 25 mp3  no mel
mk "Untagged/05_pure_tone_120bpm" 120 20 flac no tone

echo
echo "== ffprobe truth: BPM tag present? =="
printf '%-46s %-8s %s\n' FILE "TAG" DURATION
find "$DEST" -type f \( -name '*.flac' -o -name '*.mp3' \) | sort | while read -r f; do
  bpm="$("$FP" -v error -select_streams a:0 -show_entries format_tags=BPM -of csv=p=0 "$f" 2>/dev/null | tr -d '\r')"
  dur="$("$FP" -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null | cut -d. -f1)"
  printf '%-46s %-8s %ss\n' "$(basename "$f")" "${bpm:-NONE}" "${dur:-?}"
done
echo
echo "Total: $(find "$DEST" -type f \( -name '*.flac' -o -name '*.mp3' \) | wc -l) files"
