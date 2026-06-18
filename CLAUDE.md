# tbh-meter — rules for the meter (app + reader)

This repo **is** the meter: a live stats overlay + run tracker for Task Bar Hero, shipping as **two
pieces**. It is standalone and open source (MIT). Human-facing docs: `README.md` / `.github/CONTRIBUTING.md`.

- **`app/`** — the Electron overlay UI. It is its OWN pnpm workspace (`app/pnpm-workspace.yaml`
  stops pnpm's upward search — **never delete it**, the release CI breaks). Run all `pnpm` commands
  from `app/`. Rules: `app/CLAUDE.md`.
- **`reader/`** — Python sidecar that reads the game's process memory; frozen by CI into
  `tbh-reader.exe` (PyInstaller `--onefile`). Rules: `reader/CLAUDE.md` → knowledge base index
  `reader/docs/_index.md` (**read it before touching reader code**).
- **`data/`** — the committed game-data snapshot the app bundles (see below).
- **`scripts/`** — maintainer tooling (`refresh-game-data.mjs`).

## Reader in 6 lines (orientation — the KB is the truth)

`meter_windows.py` attaches via `ReadProcessMemory`, resolves IL2CPP classes, and emits to
`~/tbh-meter/` (or `--output`): one **`raw/<id>.json` per finished run** (`id` = run end-timestamp
ms — run identity since Redesign 2), `live.json` (~1/s) and `meter.log`. It is a **pure sensor** —
no session/`runs.jsonl` ownership (the app derives sessions; legacy `runs.jsonl` is migration-only).
Resolution ladder: name-free fixed RVA → `TypeInfoTable` → `TypeDefIndex` (`il2cpp/typeinfo.py`),
gated by build fingerprint → bundled seed `config/calib_seed.json` (~8s first launch) → full memory
scan (`il2cpp/resolver.py`, ~100s, permanent fallback) → self-calibrates into `resolve_cache.json`
(survives game restarts). **A `CACHE_FMT` bump requires re-capturing the seed**
(`scripts/seed_calib_capture.py`) — a stale-fmt seed fails CI `--selftest` AND is rejected at
runtime → cold scan.

## Game data (`data/` snapshot → app)

The app bundles a small committed snapshot under `data/{json,sprites,heroes}` — the source of truth.
`app/scripts/sync-data.mjs` copies it into `app/src/shared/data/` + the renderer's public assets
(both git-ignored, regenerated); it runs automatically before `dev`/`build`/`test`, so the app
builds **offline**. **Never hand-edit the synced runtime dirs.** To update bundled data after a game
patch, regenerate the snapshot from a tbh-wiki checkout (the datamine pipeline lives there):

```bash
node scripts/refresh-game-data.mjs --wiki /path/to/tbh-wiki   # rewrites data/, then commit it
```

This is the only tie to the wiki, and only maintainers run it. The reader also derives
`reader/config/skill_attr_map.json` from `data/json/heroes.json` via
`reader/scripts/gen_skill_attr_map.py`.

## Release pipeline (3 numbered workflows + 1 internal, build only on demand)

Operational runbook: `.github/CONTRIBUTING.md` → "How releases work". The Actions sidebar reads as the
pipeline:

1. **`meter-1-stage.yml` · "TBH Meter / 1. Create version tag (auto)"** — you never click this. On push
   to `main` touching `app/**` / `reader/**` / `data/**`: NO build — computes the next RC and pushes a
   marker tag `tbh-meter-v<ver>-rc.<N>` at the commit. **Refuses (green no-op) when nothing under
   `app/`, `reader/`, `data/` changed** (the P1 guard, enforced in `compute-version.mjs`). Also, on
   **any PR close**, deletes that PR's throwaway test-build draft (`tbh-meter-pr-<N>`).
2. **`meter-2-build.yml` · "TBH Meter / 2. Build test version to download"** — manual. Builds the **RC
   variant** and publishes a **DRAFT** on the public `mad-labs-org/tbh-meter` repo
   (invisible to anonymous users + electron-updater). Blank = newest staged RC; `candidate=<ver>` = a
   specific RC; `pr=<N>` = a throwaway pre-merge build of that PR's head (version
   `0.0.0-pr.<N>.<run>`, link posted as a PR comment). One mutable draft slot per target.
3. **`meter-3-ship.yml` · "TBH Meter / 3. Release to players"** — manual. Re-builds the **stable variant**
   from the chosen RC's exact commit (frozen lockfile → "ship == tested commit"), publishes it
   **draft-first then flips to Latest**, pushes the clean `tbh-meter-v<ver>` tag here at the **built
   commit** (advances the base; plain push, never forced), sweeps stale RC drafts, and announces on
   Discord. `direct_from_main=true` = ship main's current code straight to players, no RC. Guards
   refuse a downgrade (≤ current Latest) and a duplicate tag at a different sha.
4. **`meter-build-core.yml`** — internal `workflow_call` only; the single Windows build definition
   (reader exe + `--selftest` + electron-builder) shared by Meter 2 and Meter 3.

Also: **`ci.yml`** runs the app + reader gates on every PR and push (free public-repo runners), and
**`secret-scan.yml`** runs gitleaks.

**Versioning** (`app/scripts/compute-version.mjs`): base = highest clean `X.Y.Z` `tbh-meter-v*`
tag; `-rc.N` and `0.0.0-pr.*` never become the base. `--prerelease rc` appends the next `-rc.N`;
`--set <v>` stamps an exact version; `--json` emits `{version,base,commitCount,signal,refused}`.
**Zero meter commits (`app`/`reader`/`data`) since base → exit 2 (refuse)** unless `--allow-empty`.
A 1.0.0 graduation is a normal commit (bump the `package.json` "version" floor). `package.json`
version is only written for the build, never committed.

**RC variant (side-by-side):** Meter 2 (and PR builds) set `TBH_BUILD_VARIANT=rc` (baked into
`__TBH_VARIANT__` by `electron.vite.config.ts`) plus electron-builder `-c.appId/productName=…rc`
overrides, so the RC installs as `tbh-meter-rc` in its own folder, stores data in `~/tbh-meter-rc`,
and has auto-update **disabled** — it never clobbers the real install. Source, pipeline, and
release artifacts all live in this one repo, so the default `GITHUB_TOKEN` publishes the releases
**and** pushes the version tags here (no cross-repo PAT).

## Verify before finishing

```bash
cd app    && pnpm check && pnpm test   # eslint + tsc (both tsconfigs) + vitest
cd reader && ruff check . && python3 -m pytest
```

CI (`ci.yml`) runs these same gates on every PR, so don't rely on a local pre-commit hook — green CI
is the contract.
