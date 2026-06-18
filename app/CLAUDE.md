# app/ — Electron overlay

Standalone pnpm workspace (its own lockfile — run `pnpm` from THIS directory only). Main-process code
in `src/main/`; three renderer windows: **LiveApp** (the overlay), **ListApp** (runs table + detail),
**SplashApp** (startup phases). State flows `reader-policy.ts` (pure decisions) → `reader-process.ts`
(supervisor) → `ipc.ts` → renderer via the `MeterApi` preload (contract in `src/shared/ipc-types.ts`).

Architecture, the `src/main` module map, and the upload flow live in **`README.md`**.

## Gotchas that bite

- **electron-updater is CJS**: `const { autoUpdater } = electronUpdater` (not a named ESM import); it's
  bundled into main on purpose (missing transitive deps on installed machines). Disabled for the RC variant.
- **macOS `pnpm dev` renders UI only** — the reader never spawns. Feed artifacts into `~/tbh-meter/`
  (`raw/<id>.json` + `live.json`, mtime advancing) to exercise the watchers.
- **`src/shared/data/` and `src/renderer/public/{sprites,heroes}/` are generated** by
  `scripts/sync-data.mjs` (hook-enforced) — never hand-edit; extend the sync script instead.
- **`error-report.ts` caps mirror the API's `@tbh/shared` `meterErrorReportSchema`** (external package,
  not vendored here) — keep the `MAX_*` constants in sync.
- Packaged reader exe path: `process.resourcesPath/reader/tbh-reader.exe` (electron-builder extraResources).

## Verify before finishing

```bash
pnpm dev      # electron-vite dev (macOS: UI only — see gotchas)
pnpm check    # eslint + tsc (tsconfig.node.json + tsconfig.web.json)
pnpm test     # vitest — pretest syncs data
pnpm dist:win # Windows NSIS installer (needs Windows or cross-compile)
```

**Renderer changes must be verified on real pixels, not just unit tests.** Run the overlay/list on
**seeded** `~/tbh-meter/` artifacts (`pnpm dev -- --remote-debugging-port=9222`; write `raw/<id>.json`
+ `live.json` with advancing mtime), confirm it looks right, and attach the approved frame(s) to the PR.
