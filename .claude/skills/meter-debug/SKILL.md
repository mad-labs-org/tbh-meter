---
name: meter-debug
description: Diagnose tbh-meter problems — reader not attaching, AV/blocked state, slow calibration, missing or rejected runs, upload failures, player error reports. Use when debugging meter behavior, reading meter.log / live.json / raw run records / logs records (or the legacy runs.jsonl), or triaging /meter-errors reports.
---

# Debugging tbh-meter

## Artifact locations

Stable build: `~/tbh-meter/` · RC build: `~/tbh-meter-rc/` (variant-aware via `app/src/main/settings.ts` `resolveOutputDir()`; user can override with reader `--output`).

| File | What it is |
|---|---|
| `meter.log` | Timestamped reader event log. Machine-readable phase markers: `[[STATUS]] searching\|resolving\|scanning\|ready`. Human lines: `[ok] attached`, `[ok] resolved`, `resolving classes/instances`, `managers reused`, `game is not open`. Truncates at ~10MB. |
| `reader-diag.log` | **Infra / decision-spine log** (separate from `meter.log`, always on; `shared/utils.diag`). One timestamped line per key decision: `[attach]`, `[resolve]` (path FAST/SCAN + sanity-fail/calib-miss + counts), `[manager-pick]` (MSM/LM cands+picked), `[save-pick]` (PSD/CSD + gold/heroes), `[party-pick]` (candidates / **carriers vs ghosts** / picked + ghost samples), `[gold]`, `[run-close]` (per-run `gold_ok`/`xp_ok`/**`party_degraded`**/heroes), `[reattach]` (fp change = game update), `[fatal]`. **First place to look** for resolution / instance-pick / party-off problems — the data `meter.log` lacked in past debugs. |
| `updater.log` | Auto-update flight recorder (`auto-update.ts`): one line per status TRANSITION (`checking`, `available x.y.z`, `downloading x.y.z`, `downloaded x.y.z`, `up-to-date`, `error: …`), plus `boot-gate stale pointer: …; converging` when the REST cross-check catches a stale "up to date", and `boot-gate updated\|proceed` anchoring each launch's gate conclusion. Rotates to `.old` at 64KB. Empty/absent on dev/macOS/RC (updater dormant). |
| `raw/<id>.json` | One RAW record per finished run, written by the reader (`id` = the run's end-timestamp in ms; `raw_schema_version` = `RAW_SCHEMA_VERSION` in `meter_windows.py`). Pure observation — no `dps`/`partial`/session fields (the app derives those). |
| `logs/<id>.json` | The structured record the UI reads: `converter/` (`convert.ts`) turns each `raw/<id>.json` into one (derives `dps`, `partial`, totals; carries `gold_source`/`xp_source` — `live` vs `save` fallback). Cleared by "clear run history" (`RunsSource.clearFile()`; `logs-archive.ts` is only the raw/legacy clear helpers — no age-based cleanup exists). |
| `live.json` | Current-run RAW snapshot, rewritten ~1×/s (Redesign 2 — replaced the old cooked `meter_live.txt`). Read by `live-source.ts` (cooks the overlay) and `reader-process.ts` engagement detection. |
| `resolve_cache.json` | Build-fingerprint-keyed calibration cache (`fmt` must equal `CACHE_FMT` in `meter_windows.py`). Delete it to force a recalibration. |
| `runs.jsonl` | **LEGACY, frozen at schema v11** — the reader stopped writing it in Redesign 2; the converter uses it only as the one-time migration source (≤11 = legado). Absent on fresh installs. |

## Reader lifecycle & failure classification

Decision logic is pure and testable: `app/src/main/reader-policy.ts`; supervisor: `reader-process.ts`.

- **`spawn-failed`** (spawn error, EPERM/ENOENT/EACCES): exe locked/quarantined/missing → almost always antivirus. Reported immediately.
- **`crashed`** (signal, or exit code ≠ 0): AV kill, OOM, game crash. Starts exponential backoff: `2^(streak-1) * 5s`, capped 60s.
- **`clean`** (code 0): normal "game not open" exit; re-poll after 5s.
- **`blocked`**: 5 consecutive failures (`READER_BLOCKED_THRESHOLD`). Supervisor auto-sends ONE error report with the 80-line activity ring, then waits for the user to hit retry (`retryReader()` IPC).
- Surviving 30s (`READER_HEALTHY_RUN_MS`) resets the failure streak.
- Reader is only spawned when `win32 && app.isPackaged && readerExePath()` — on macOS dev the file-watching sources still work against existing artifacts.

## Calibration / resolution flow

1. **Fast path**: fixed RVA → IL2CPP TypeInfoTable → TypeDefIndex (`reader/il2cpp/typeinfo.py`), gated by build fingerprint, validated by name round-trip.
2. **Seed-calib**: bundled `reader/config/calib_seed.json` (~8s first launch). Rejected if its `fmt` ≠ current `CACHE_FMT` → falls through to cold scan (this bit an RC build once, #199). Re-capture on every fmt bump: `scripts/seed_calib_capture.py`; CI `--selftest` fails on stale fmt.
3. **Cold scan** (`reader/il2cpp/resolver.py`): ~100s, dominated by the ~62s gold value-scan. Happens on uncalibrated/post-patch builds; self-calibrates into `resolve_cache.json` (survives game restarts).

Game patched → build fingerprint changes → cache misses → seed tried → likely cold scan once. This is expected, not a bug.

## Reader CLI (run standalone)

```bash
tbh-reader.exe --output DIR   # artifact dir (default ~/tbh-meter)
               --hz N         # poll rate, default 10
               --debug        # per-tick lines to stdout (meter.log stays event-level)
               --selftest     # validate bundled resources + calib_seed fmt; exit 0/1 (used in CI)
```

Clear orphans on Windows: `taskkill /f /im tbh-reader.exe`.

## Error relay (client side)

- `app/src/main/error-report.ts` POSTs error reports to the backend `/meter-errors` endpoint. The server-side relay (and where it forwards) lives in the API, not this repo — only the client path is debuggable here.
- Caps mirror the API's `@tbh/shared` `meterErrorReportSchema` (external package, not vendored here — keep `error-report.ts`'s `MAX_*` constants in sync): context 120, message 1k, stack 2k, logs 50k. Dedup per (context, message) per session; max 20/session.
- Payload includes `appVersion`, `os`, `packaged`, `extra` (e.g. `exitCode`, `failStreak`), and the meter.log tail + live.json snapshot.

## Run upload validation (backend rules — the server lives outside this repo)

These are the server-side checks an upload must pass; reach for them when a run uploads from the client (`share.ts`) but never lands on the leaderboard.

- **Rejected permanently** (bad_request → added to auto-upload failed set): `teamDps ≤ 0` or `totalDamage === 0` (old-meter artifact on short boss stages, #163).
- `endedAt` more than 5 min in the future → rejected; past is unbounded (late uploads OK).
- Dedup by externalId via unique index — v2 runs upload as `device:ts` (minted by the app in
  `share.ts`); legacy v1 records keep their original `session:run`. A duplicate upload returns the
  existing id, not an error.
- `partial: true` runs (capture < 80% of official clear time, or damage ≤ 0) are stored but filtered out of the leaderboard.

## Playbooks

**"Meter shows nothing"** → check `live.json` exists/updates → check last `[[STATUS]]` in `meter.log` (`searching` = game not found, `resolving/scanning` = wait, `ready` = reader fine, look at the app side) → if app side, check reader status IPC and the activity ring.

**"Calibration takes forever"** → one cold scan ~100s post-patch is normal. Repeating every launch = cache not persisting: check `resolve_cache.json` exists and its `fmt` matches `CACHE_FMT`.

**"Reader keeps dying"** → exit codes in app log / activity ring; `spawn-failed` or repeated `crashed` = AV → add exclusion, restore exe from quarantine, then `retryReader()`.

**"Run didn't reach the leaderboard"** → was `raw/<endTs>.json` written at all (reader side)? → does the converted `logs/<id>.json` exist (converter side)? → in the logs record check `partial` and `totalDamage`; then dedup (same `device:ts` externalId already in `uploads.json`?), then API validation above.

**"Gold/XP look wrong"** → check `gold_source`/`xp_source`: `save` fallback means the live manager wasn't resolved when the run started (e.g. attached mid-menu); usually fixes itself next run.

**"Runs invalid / no team (party off)"** → `reader-diag.log` `[party-pick]` line: `carriers=0 picked=0x.. party_read=0` + a `ghost … (hk, 0, 0.0)` = `pick_live_sm` grabbed a non-carrier StageManager (heroKey valid, `lvl=0`) over the live one → `read_live_party` reads `{}` → `heroes:err` → degraded (no team, no upload). `meter.log` fingerprint: `StageManager ok — 0 heroes deployed` (pick≠read). Fixed structurally in #413 (pick delegates to `read_live_party`); see `reader/docs/invariants/party-live-resolution.md`. `carriers≥1` but `party_read=0` = the pre-fix freeze on a ghost; `carriers=0` in combat = the carrier wasn't captured by the scan (rarer). **Methodology (the lesson that found it):** don't assume "it's the seed/calibration" — pull the player's CURRENT `reader-diag.log`/`meter.log` and let it REFUTE the prior theory (fast-path armed + party still off = NOT calibration, so the #408 reseed couldn't fix it). Then reproduce with a real-code `MockReader` test (TDD red→green) BEFORE asserting a fix — never theorize. A bug that "works on the dev machine" but not a player's is usually instance-ordering / state-dependent (see `instance-selection`), not the seed.

**"App didn't auto-update on launch"** → read `updater.log` around the boot: `up-to-date` then `boot-gate proceed` = both the public pointer AND the REST cross-check said "current" (or REST had no signal — 403/CGNAT/offline); a `boot-gate stale pointer … converging` line = the cross-check caught a stale answer and the gate re-checked until convergence (meter-3-ship's "Verify players can see it" step should make this rare); `error:` lines = check/download failed (transient network or AV — boot retries once, focus retries after 30s); `boot-gate proceed` right after `checking` = check slower than the 8s gate (update still downloads in background, installs on quit). Mid-session pickup is the 3min interval + focus/resume triggers.
