# tbh-meter — app (Electron overlay)

The Electron overlay for Task Bar Hero — an always-on-top frameless window that draws the live stats
overlay and the runs history, derives sessions, and (when signed in) uploads runs to the leaderboard.
It is the user-facing half of the meter; the [`reader`](../reader) is its data source.

## Requirements

- Node >= 22
- pnpm 10

This is its **own** pnpm workspace (separate lockfile) — run every `pnpm` command from this directory.

## Development

```bash
pnpm install
pnpm dev      # launch the overlay (hot-reload via electron-vite)
pnpm dev:mock # same, but against a mocked API with NO backend (MSW) — auth/upload/error-relay all
              # complete locally; see src/mocks/
pnpm check    # eslint + tsc (tsconfig.node.json + tsconfig.web.json)
pnpm test     # vitest (pretest runs sync-data)
```

On macOS, `pnpm dev` renders the UI only — the reader never spawns. Feed artifacts into your
`~/tbh-meter/` folder (`raw/<id>.json` + `live.json`, with advancing mtime) to exercise the watchers.

## Build for Windows

```bash
pnpm dist:win # NSIS installer (tbh-meter-Setup-<version>.exe). Requires Windows, or Wine on macOS.
pnpm dist:dir # unpacked dir for a local smoke-test (no Wine needed on macOS)
```

Output lands in `dist/`.

## Architecture

Main-process code is in `src/main/`; three renderer windows live in `src/renderer/`: **LiveApp** (the
overlay, content-pinned height), **ListApp** (runs table + detail), and **SplashApp** (startup phases via
`onReaderStatus()`). State flows from the main process to the renderer:

```
reader-policy.ts (pure decisions) → reader-process.ts (supervisor) → ipc.ts → renderer (MeterApi preload)
```

The IPC contract lives in `src/shared/ipc-types.ts`. The renderer never imports Electron; it talks only
through the `MeterApi` preload.

### `src/main` module map

| Module | Responsibility |
|---|---|
| `reader-policy.ts` | Pure state machine: classify spawn/exit → respawn delay (exp backoff, 5s base, 60s cap), `blocked` after 5 fails, healthy after 30s. No Electron imports — unit-test here first. |
| `reader-process.ts` | Spawns `tbh-reader.exe` (only `win32 && app.isPackaged`), parses `[[STATUS]]` markers, keeps an 80-line activity ring for error reports. |
| `ipc.ts` | All IpcMain handlers; broadcasts settings/auth/share changes to every window. |
| `settings.ts` | AppSettings JSON in userData; `resolveOutputDir()` → `~/tbh-meter` or `~/tbh-meter-rc` (variant-aware). |
| `auth.ts` | Discord OAuth; token in userData; broadcasts auth changes. |
| `share.ts` / `auto-upload.ts` | Manual share + background uploader (5 min tick, 30s first). Distinguishes permanent `bad_request` (never retried) from transient errors. Dedup via `uploads.json`. |
| `ingest-map.ts` | Translates the meter run format → the API `POST /runs` body (skill/item key remapping). |
| `sources/` | File watchers: `runs-source.ts` (reads the converted `logs/<id>.json`, derives sessions from run ts), `live-source.ts` (reads `live.json`, cooks the overlay), `parse.ts` (humanize helpers). Work on macOS dev too. |
| `error-report.ts` | Crash/blocked relay to `POST /meter-errors`. Caps mirror the API's `@tbh/shared` `meterErrorReportSchema` (external package, not vendored) — keep the `MAX_*` constants in sync. |
| `crash-recovery.ts` | Reloads a renderer that died mid-session (`render-process-gone`) so the overlay/splash comes back instead of sitting blank — the Electron-42 transparent-overlay GPU crash cascade. Loop-guarded (≤3 reloads per window per 60s) against a reload storm. Pure `shouldReloadCrashedRenderer` unit-tested here; kept separate from `error-report.ts` because recovery changes crash semantics (which reporting must not). |
| `auto-update.ts` | electron-updater (packaged win32 only): boot gate (check+retry before the reader, 8s budget) cross-checked against GitHub's REST origin, so a provably stale "up to date" converges instead of being trusted; 3min interval; focus/resume triggers (10min cooldown; 30s after an error); `updater.log` flight recorder in the meter folder. **Disabled entirely for the RC variant.** |
| `runs-store.ts` / `converter/` / `sessions.ts` / `session-stats.ts` / `tray.ts` | Run listing; `converter/` (`convert.ts` pure + `ingest.ts` I/O) turns each `raw/<id>.json` → `logs/<id>.json` (the read source); `sessions.ts deriveSessions` (6h gap + manual cuts); session links + the "New session" cut (`session-cuts.json`); tray. (`logs-archive.ts` is the clear helper now.) |

### Upload flow

```
reader raw/<id>.json → converter/ → logs/<id>.json → runs-source.ts watcher
  → manual shareRun() or auto-upload → ingest-map.ts → POST /runs (with the app-derived session field)
  → API dedups by externalId (device:ts for v2; legacy session:run preserved)
  → app records the URL in uploads.json → onShareUpdated() broadcast
```

Upload **requires sign-in**: every `POST /runs` carries the Discord Bearer token (so it is attributed and
ranks on the leaderboard) plus an Ed25519 request signature (`request-signer.ts`, verified by the API's
`middleware/signature.ts`). Signed out is a clean "sign in to sync" state — runs stay local and the
auto-uploader drains the backlog on the next sign-in; there is no anonymous upload path. The per-install
device id (`device-id.ts`) survives only to claim legacy anonymous runs: on sign-in the app fires
`POST /runs/claim` (`claimDeviceRuns()` in `share.ts`) and the API re-attributes them by device-hash.

### Notes

- electron-updater is CJS: `const { autoUpdater } = electronUpdater` (not a named ESM import); it is
  bundled into main on purpose (missing transitive deps on installed machines).
- The packaged reader exe lives at `process.resourcesPath/reader/tbh-reader.exe` (electron-builder
  extraResources).
- `src/shared/data/` and `src/renderer/public/{sprites,heroes}/` are **generated** by
  `scripts/sync-data.mjs` (hook-enforced) — never hand-edit them; change the `data/` snapshot and let the
  sync regenerate them.
- Features that show data should deep-link to the web (pageviews / AdSense) rather than re-implement
  views in the app.
