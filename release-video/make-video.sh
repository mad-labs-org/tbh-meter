#!/usr/bin/env bash
# Make the release video. Accepts a GitHub release LINK (preferred), a tag, or nothing.
#   make-video.sh https://github.com/mad-labs-org/tbh-meter/releases/tag/tbh-meter-v0.29.0
#   make-video.sh tbh-meter-v0.29.0
#   make-video.sh                         # latest published release of $REPO
#   RELEASE_REPO=owner/repo make-video.sh
# Names the output after the release tag (out/<tag>.mp4) and stamps the version on the intro.
set -euo pipefail
cd "$(dirname "$0")"
# default soundtrack = the project's own track (Suno-generated), at the approved level.
# Override with MUSIC=<file>; unset MUSIC + no project track → gen-music.py synth bed.
if [ -z "${MUSIC:-}" ] && [ -f music/pixel-crown.mp3 ]; then
  export MUSIC="$(pwd)/music/pixel-crown.mp3"
  export MUSIC_VOL="${MUSIC_VOL:-0.5}"
fi
REPO="${RELEASE_REPO:-mad-labs-org/tbh-meter}"
ARG="${1:-}"
NAME=""
if [[ "$ARG" == http*github.com/* ]]; then
  REPO="$(printf '%s' "$ARG" | sed -E 's#https?://github.com/([^/]+/[^/]+)/.*#\1#')"
  NAME="$(printf '%s' "$ARG" | sed -E 's#.*/releases/tag/##; s#[/?#].*##')"
elif [ -n "$ARG" ]; then
  NAME="$ARG"
fi
[ -z "$NAME" ] && NAME="$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || true)"
[ -z "$NAME" ] && { echo "no release found — pass a link or tag, e.g. make-video.sh tbh-meter-v0.29.0"; exit 1; }

# fetch + show the release notes (the features this video should cover)
echo "── release notes ($REPO @ $NAME) ──"
gh release view "$NAME" --repo "$REPO" --json name,body -q '.name + "\n" + .body' 2>/dev/null | head -40 || echo "(could not fetch notes — proceeding by tag)"
echo "────────────────────────────────────"

VER="$(printf '%s' "$NAME" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.]+)?' | head -1 || true)"
[ -z "$VER" ] && VER="$NAME"
SAFE="$(printf '%s' "$NAME" | tr ' /' '__' | tr -cd 'A-Za-z0-9._-')"
mkdir -p out
OUT="out/${SAFE}.mp4"
echo "▶ release '$NAME' → $OUT  (intro version: $VER)"

# Renders the per-release FEATURE composition (Release): intro + ONLY this release's surfaces + outro.
# Whoosh ms = start of each scene transition for the 4-scene Release (Intro 92 / TimeToLevel 200 /
# Planner 250 / Outro 116 @ TR2=16, fps 30 → 610f ≈ 20.3s). Recompute if you add/resize a release
# scene: scene i starts at sum(dur[0..i-1]) - 16*i frames ÷30×1000.
npx remotion render src/index.ts Release out/.render.mp4 --props="{\"version\":\"$VER\"}" --concurrency=4
bash build-audio.sh out/.render.mp4 "$OUT" 21 2533 8667 16467
rm -f out/.render.mp4
echo "✓ $OUT"
open "$OUT" 2>/dev/null || true
