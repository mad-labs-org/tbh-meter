---
name: release-video
description: Generate a polished release video for a tbh-meter release in the Claude-Code motion style (recreated animated UI + real game sprites + synth soundtrack), to post with a launch. Primary input is a GitHub release LINK — the skill turns it into a video named after that release, covering ONLY the features that shipped in that release, version stamped on the intro. Use when asked to make/update a release video, showcase clip, feature trailer, or promo video for a meter release, or "make the video for <release link>".
---

# Release video generator (tbh-meter)

Produces a 1920×1080 MP4 in the style of the videos Claude Code/Anthropic drop per feature: clean
dark motion-graphics, real product UI shown **alive**, synced soundtrack. It makes the launch video
for a **tbh-meter** release — one video per shipped feature set. Built on **Remotion 4** (React 18);
the pipeline is a standalone `release-video/` project (isolated from the app's pnpm workspace, like `app/`).

> ⚠ **The `release-video/` Remotion pipeline is not in THIS repo yet.** It currently lives in the
> tbh-wiki repo and did NOT come over in the meter-source import (only `app/`, `reader/`, `data/`,
> `scripts/` did). Until it's migrated here — or you run it from the wiki against the meter release
> tag — the `make-video.sh`/`remotion` commands below have nothing to execute. Bringing `release-video/`
> into tbh-meter is the prerequisite for this skill to run standalone.

## LAW 0 — the video covers ONLY this release's features (do NOT regress)

**A release video showcases exactly the changes that shipped in THAT release. Nothing else.** Never
fall back to a full product tour. A video for a single-feature release is a single-feature video.
This was a hard correction (Mario, 2026-06-12 — the v0.33.0 video wrongly showed surfaces that were
not in that release). The full multi-scene `ShowcasePunchy` is a scene **LIBRARY**, not a deliverable —
`make-video.sh` renders the per-release `Release` composition.

You discover what shipped from the release's **commits → PRs → each PR's `release-highlights` block
+ the screenshots attached to it** (produced by the `tbh-commit` skill). Do this FIRST.

## Step 1 — determine the release scope (commits → PRs → highlights → screenshots)

```bash
TAG=tbh-meter-v0.33.0                       # from the release link
git fetch --tags origin
# previous shipped tag (clean X.Y.Z, never an -rc):
PREV=$(git -c versionsort.suffix=-rc tag --sort=-v:refname 'tbh-meter-v[0-9]*' \
        | grep -v -- '-rc' | grep -A1 -x "$TAG" | tail -1)
# the commits/PRs THIS release contains:
git log "$PREV..$TAG" --oneline
```

Each commit subject ends with `(#NNN)`. For every PR, pull its machine-readable
**`release-highlights`** block (the SSOT of what shipped — title, summary, area, and the PR
screenshots in `media`):

```bash
gh pr view <N> --repo mad-labs-org/tbh-meter --json body --jq '.body' \
  | sed -n '/release-highlights:start/,/release-highlights:end/p'
```

The `media` URLs look like `https://github.com/mad-labs-org/tbh-meter/raw/<sha>/<dir>/<file>.png`. The
repo is **public**, so download them directly (no gh-api cookie workaround needed):

```bash
curl -sL "https://github.com/mad-labs-org/tbh-meter/raw/<sha>/<dir>/<file>.png" -o /tmp/<file>.png
```

`Read` each screenshot — these are your **fidelity reference** for the recreation (Law 1): the exact
surfaces, layout, copy, and states the release changed. The highlight `title`/`summary` guide the
scene caption.

## Step 2 — build ONE scene per shipped surface, then render `Release`

`src/Release.tsx` is the per-release composition: `Intro` (version-stamped) → one scene per shipped
surface → `SceneOutro`, wrapped in the punchy look (particles + bloom + `FlashDissolve`). Edit its
`RELEASE_SCENES` array:

- **Reuse** a scene from the library (`Showcase.tsx`) when the release touched a surface it recreates.
- **Add** a new recreated scene for a surface with no scene yet — recreate it from the PR screenshot +
  the shipped source, animated.
- **Remove** every scene whose surface this release did NOT touch.

Verify each scene with a still BEFORE the full render (cheap, and the UI rule requires eyeballing):

```bash
npx remotion still src/index.ts Release out/_check.png --frame=<f> --props='{"version":"v0.33.0"}'
```

Then render + soundtrack via `make-video.sh` (parses repo+tag from the link, renders `Release`
version-stamped, muxes audio, writes `out/<tag>.mp4`):

```bash
cd release-video && npm install     # first time only
bash make-video.sh https://github.com/mad-labs-org/tbh-meter/releases/tag/tbh-meter-v0.33.0
# real soundtrack instead of the synth bed (first <dur>s of the track, whooshes on top):
MUSIC="/path/Track.mp3" MUSIC_VOL=0.5 bash make-video.sh <release-link>
# also accepts a bare tag, or nothing (= latest published release)
```

**Default soundtrack** = the project's own `release-video/music/pixel-crown.mp3` (committed) at
`MUSIC_VOL=0.5`; `MUSIC=<file>` overrides; with no project track it falls back to `gen-music.py`.
Releases repo defaults to `mad-labs-org/tbh-meter` (releases live in the same repo now).

## The four style laws (hard-won — do NOT regress)

1. **Recreated, animated UI — never the screenshot itself.** Every scene is a live re-render of the
   product surface (numbers rolling via `CountUp`, bars filling, countdowns ticking, stagger
   entrances, glows). A static screenshot with a Ken-Burns zoom was explicitly rejected ("matou a
   vida"). The PR screenshots are the **reference you recreate from**, never frames you paste in.
2. **Real game sprites + real numbers.** Sprites come from the meter's generated
   `app/src/renderer/public/{sprites,heroes}/` (synced from `data/`): heroes `Hero_101..601`, items
   `Item_11xxxx`. Numbers must be real — derive them from `data/*.json` / the shipped code, never invent.
3. **Zoom on ONE scene only.** A directed zoom is reserved for a single highlight. Everywhere else:
   animation + transitions, no zoom.
4. **Upbeat synth soundtrack + transition whooshes.** A sustained minor-key pad reads as "sad organ"
   — rejected. Use the major-key arpeggio bed (`gen-music.py`) or the committed `pixel-crown.mp3`.

## Files (inside the `release-video/` pipeline)

- `src/kit.tsx` — theme tokens, fonts (Inter + JetBrains Mono), helpers (`CountUp`, `Cursor`,
  `useTyped`, `Bg`, `Wordmark`, `Caption`, `AppWindow`, `SoftDissolve`).
- `src/Release.tsx` — **the per-release deliverable.** `RELEASE_SCENES` = intro + this release's
  surfaces + outro. Imports reusable scenes/primitives from `Showcase.tsx`/`Showcase2.tsx`. Edit per release.
- `src/Showcase.tsx` — the scene **library** (was the full multi-scene tour): exports `Intro`,
  `SceneOutro`, reusable scenes/primitives. Add broadly-reusable recreated scenes here.
- `src/Showcase2.tsx` — the **punchy** look: `Particles`, `Bloom`, `FlashDissolve`, `tr2`, `TR2`.
- `gen-music.py` (numpy) — synthesizes the soundtrack sample-accurately. `build-audio.sh` calls it then
  muxes. (Do music in Python, NOT ffmpeg `aevalsrc` — commas in `eq()/mod()` break lavfi.)

## Capturing real references (only if a PR has no screenshot)

Prefer the PR screenshots from Step 1. If a shipped meter surface has none, capture the overlay:

- `cd app && pnpm dev -- --remote-debugging-port=9222` (see the `dev` skill), seed `~/tbh-meter/`
  with REAL stageKeys from `data/stages.json` (encoding `(difficulty+1)(act)(stageNo)`, e.g. 3-9
  Torment=4309) and an advancing `live.json` so the overlay goes ONLINE, then capture over CDP.

## Gotchas

- **Silent-audio mux bug:** Remotion exports the MP4 with a SILENT aac stream. Muxing without `-map`
  picks it → dead audio. Always `-map 0:v:0 -map 1:a:0` (build-audio.sh already does).
- Verify audio actually landed: `ffmpeg -i out.mp4 -af volumedetect -f null - 2>&1 | grep mean_volume`
  (want roughly −16 to −23 dB, not −91).
- I can't hear audio in-tool — always have a human confirm the soundtrack.
- Caption copy: no em-dash, no hype, real numbers only; recreated in-app strings stay verbatim.
