#!/usr/bin/env bash
# Build the soundtrack and mux it onto a rendered video (forcing the track — Remotion exports a
# SILENT aac stream, so a naive mux yields dead audio; we always -map 1:a:0).
# Usage: build-audio.sh <in.mp4> <out.mp4> <durationSec> <whooshMs...>
#   default bed = synthesized upbeat track (gen-music.py).
#   MUSIC=<file> build-audio.sh ...  -> use the first <durationSec>s of that track as the bed
#                                       (whooshes/impact still layered on top).
set -euo pipefail
cd "$(dirname "$0")"
IN="$1"; OUT="$2"; DUR="$3"; shift 3
WHOOSHES=("$@")
A=assets/audio; mkdir -p "$A" out; SR=44100
MUSIC="${MUSIC:-}"

if [ -n "$MUSIC" ]; then
  # bed = external track, first DUR seconds, gently faded
  FO=$(echo "$DUR - 2.5" | bc)
  ffmpeg -y -loglevel error -ss 0 -t "$DUR" -i "$MUSIC" -af "volume=${MUSIC_VOL:-0.65},afade=in:st=0:d=0.5,afade=out:st=$FO:d=2.5,aresample=$SR" -ac 2 "$A/bed.wav"
  # transition whoosh + outro impact (ffmpeg; subtle so they sit under the music)
  ffmpeg -y -loglevel error -f lavfi -i "anoisesrc=d=0.6:c=pink:a=0.6" -af "highpass=f=280,lowpass=f=7000,afade=in:st=0:d=0.14,afade=out:st=0.30:d=0.30,volume=0.55" "$A/whoosh.wav"
  ffmpeg -y -loglevel error -f lavfi -i "aevalsrc=sin(2*PI*46*t)*exp(-t*4):s=$SR:d=0.9" -af "volume=0.55" "$A/impact.wav"
  inputs=(-i "$A/bed.wav"); fc=""; labels="[0]"; idx=1
  for ms in "${WHOOSHES[@]}"; do inputs+=(-i "$A/whoosh.wav"); fc+="[$idx]adelay=${ms}|${ms}[w$idx];"; labels+="[w$idx]"; idx=$((idx+1)); done
  last="${WHOOSHES[${#WHOOSHES[@]}-1]}"; inputs+=(-i "$A/impact.wav"); fc+="[$idx]adelay=${last}|${last}[imp];"; labels+="[imp]"; n=$((idx+1))
  fc+="${labels}amix=inputs=${n}:normalize=0,alimiter=limit=0.97[out]"
  ffmpeg -y -loglevel error "${inputs[@]}" -filter_complex "$fc" -map "[out]" "$A/soundtrack.wav"
else
  python3 gen-music.py "$A/soundtrack.wav" "$DUR" "${WHOOSHES[@]}"
fi

ffmpeg -y -loglevel error -i "$IN" -i "$A/soundtrack.wav" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -ac 2 -shortest "$OUT"
echo "built $OUT"
ffmpeg -i "$OUT" -af volumedetect -f null - 2>&1 | grep mean_volume
