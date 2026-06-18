# tbh-meter

A live DPS / Gold / EXP overlay + run tracker for Task Bar Hero. Standalone, open source (MIT). It
ships as **two pieces** that talk over the filesystem:

- **`app/`** — the Electron overlay UI (TypeScript/React). It is its OWN pnpm workspace, so run every
  `pnpm` command from `app/`. Area rules: `app/CLAUDE.md`.
- **`reader/`** — a pure-Python, read-only sensor that reads the game's memory and is frozen into
  `tbh-reader.exe`. It is the highest-risk part of the repo: **read `reader/docs/_index.md` before
  changing anything under `reader/`.** Area rules: `reader/CLAUDE.md`.
- **`data/`** — the committed game-data snapshot the app bundles. Maintainers regenerate it with
  `scripts/refresh-game-data.mjs`; never hand-edit the copies the build syncs into
  `app/src/shared/data/`.
- **`scripts/`** — maintainer tooling.

What the meter does and how the pieces fit together: **`README.md`**. Local setup, the PR gates, and
the full release runbook: **`.github/CONTRIBUTING.md`**.

## Gotchas that bite

- **Never delete `app/pnpm-workspace.yaml`.** It stops pnpm's upward workspace search; without it the
  release build breaks.
- **Merging to `main` ships nothing.** Releases are decoupled from merging — they are driven by
  `tbh-meter-v*` git tags through the `.github/workflows/meter-*.yml` pipeline (CONTRIBUTING.md →
  "How releases work"; versioning logic in `app/scripts/compute-version.mjs`).
- **`app/src/shared/data/` and the renderer's `public/{sprites,heroes}/` are generated**, not source.
  Change `data/` and let the sync regenerate them — never edit the copies (hook-enforced).

## Verify before finishing

```bash
cd app    && pnpm check && pnpm test   # eslint + tsc (both tsconfigs) + vitest
cd reader && ruff check . && python3 -m pytest
```

CI runs these same gates on every PR — green CI is the contract, not a local hook.
