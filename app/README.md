# tbh-meter — app (Electron overlay)

The Electron overlay for Task Bar Hero — an always-on-top frameless window that draws the live stats
overlay and the runs history, and derives sessions. Fully local: runs live as files in the meter
folder and never leave the machine. It is the user-facing half of the meter; the
[`reader`](../reader) is its data source.

## Requirements

- Node >= 22
- pnpm 10

This is its **own** pnpm workspace (separate lockfile) — run every `pnpm` command from this directory.

## Development

```bash
pnpm install
pnpm dev      # launch the overlay (hot-reload via electron-vite)
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
| `reader-process.ts` | Spawns `tbh-reader.exe` (only `win32 && app.isPackaged`), parses `[[STATUS]]` markers. |
| `ipc.ts` | All IpcMain handlers; broadcasts settings changes to every window. |
| `settings.ts` | AppSettings JSON in userData; `resolveOutputDir()` → `~/tbh-meter` or `~/tbh-meter-rc` (variant-aware). |
| `sources/` | File watchers: `runs-source.ts` (reads the converted `logs/<id>.json`, derives sessions from run ts), `live-source.ts` (reads `live.json`, cooks the overlay), `parse.ts` (humanize helpers). Work on macOS dev too. |
| `crash-recovery.ts` | Reloads a renderer that died mid-session (`render-process-gone`) so the overlay/splash comes back instead of sitting blank — the Electron-42 transparent-overlay GPU crash cascade. Loop-guarded (≤3 reloads per window per 60s) against a reload storm. Pure `shouldReloadCrashedRenderer` unit-tested here. |
| `auto-update.ts` | electron-updater (packaged win32 only): boot gate (check+retry before the reader, 8s budget) cross-checked against GitHub's REST origin, so a provably stale "up to date" converges instead of being trusted; 3min interval; focus/resume triggers (10min cooldown; 30s after an error); `updater.log` flight recorder in the meter folder. **Disabled entirely for the RC variant.** |
| `runs-store.ts` / `converter/` / `sessions.ts` / `session-stats.ts` / `tray.ts` | Run listing; `converter/` (`convert.ts` pure + `ingest.ts` I/O) turns each `raw/<id>.json` → `logs/<id>.json` (the read source); `sessions.ts deriveSessions` (6h gap + manual cuts); session links + the "New session" cut (`session-cuts.json`); tray. (`logs-archive.ts` is the clear helper now.) |

### Data flow

```
reader raw/<id>.json → converter/ → logs/<id>.json → runs-source.ts watcher
  → runs list / detail / sessions (all local files in the meter folder)
```

Everything stays on the machine. The only network traffic in the app is the auto-update check
against GitHub Releases (`auto-update.ts`).

### Notes

- electron-updater is CJS: `const { autoUpdater } = electronUpdater` (not a named ESM import); it is
  bundled into main on purpose (missing transitive deps on installed machines).
- The packaged reader exe lives at `process.resourcesPath/reader/tbh-reader.exe` (electron-builder
  extraResources).
- `src/shared/data/` and `src/renderer/public/{sprites,heroes}/` are **generated** by
  `scripts/sync-data.mjs` (hook-enforced) — never hand-edit them; change the `data/` snapshot and let the
  sync regenerate them.
