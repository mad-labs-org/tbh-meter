# Area review — correctness & invariants, per touched area

Reach here only after the red-flag sweep (SKILL.md §2, `references/red-flags.md`) — this is the
"is it correct?" pass. Read only the sections for the areas the PR actually touches (from the §0
`files` list). Each check is tied to a real invariant in this repo; the point is to catch the changes
that *silently corrupt data or break a shipped build*, which a stranger has no way to know about.

---

## `reader/` — the highest-risk area, and the one a newcomer is least equipped to touch safely

The reader reads another process's memory and is frozen into `tbh-reader.exe`. Its rules are
non-obvious and their violation ships bad data or malware to every user. **Before reviewing a reader
diff, open `reader/docs/_index.md`** (the knowledge base, indexed by symptom) **and sweep the diff
against `reader/docs/reference/anti-patterns.md`** — that file is the maintainers' own grep-able list
of known smells, each linked to the invariant it violates. Then confirm:

- **Read-only / memory-safety** (`invariants/memory-safety`, `shared/memory.py`): the reader opens the
  process with `PROCESS_VM_READ` only, null-guards every dereference, caps iteration, and **never
  writes or injects**. Any `WriteProcessMemory`, `CreateRemoteThread`, `VirtualAllocEx`, or `OpenProcess`
  with write/operation access is a hard reject (also caught in red-flags §C). This is both a safety
  invariant and the project's promise in SECURITY.md.
- **Zero runtime dependencies**: pure `ctypes` + stdlib. A new import of a third-party package — or of a
  network/subprocess stdlib module — doesn't belong here (red-flags §B/§C).
- **Never read Obscured data** (`invariants/obscured-data-offlimits`): Obscured (XOR-masked) fields read
  as garbage; core stats live behind `@CORE_STATS_OBSCURED`/`@CACHE_OBSCURED` and must not be read
  directly. Hero class is `EEquipClassType`, **never** `EHeroType` (an orphan enum). A diff that reads
  an Obscured offset or switches to `EHeroType` is wrong even if tests pass.
- **Offsets live in one place** (`invariants/offsets-single-source`, `config/offsets.py`): every
  offset/enum/stride belongs in `config/offsets.py`; a business rule belongs in its logic module. A
  magic offset inlined into a metric or the orchestrator is a defect (and `orchestration-purity`:
  `meter_windows.py` is a thin orchestrator with no inline reads).
- **Dict strides** (`invariants/dict-strides`): `DictFloat` (0x10/@0xC) vs `Dict8B` (0x18/@0x10) — mixing
  them corrupts silently. Any new dict walk must use the right stride for the structure.
- **Name-free resolution** (`invariants/rva-index-resolution`, `gold-singleton-resolution`,
  `log-event-detection`): obfuscated singletons resolve by *structure*, events by *klass-pointer* —
  never by the (stripped/drifting) name or the `ELogType` field. A resolver that keys on a literal name
  will break on the next game recompile.
- **Metric fallback chains** (`invariants/metric-fallback-chains`): LIVE → SAVE → never wallet/total;
  `run_gain` is `None` when non-monotonic; the source tag must preserve any degradation honestly.
- **Run lifecycle** (`invariants/run-lifecycle`): start via `LOG_LIST`; end on
  `StageClearLog`/`StageFailedLog`; the <30s and boss-box-post-clear rules. Party is LIVE
  (`StageManager.HeroList`), never the roster (`invariants/party-live-resolution`).
- **Schema & cache versioning** (`invariants/schema-versioning`, `cache-management`): adding a run field
  that changes the record shape bumps `RAW_SCHEMA_VERSION` *and* is normalized app-side; a `CACHE_FMT`
  change requires re-capturing `config/calib_seed.json` or it falls back to a cold scan.
- **The combat law**: the party is *always* fighting; there is no "not in combat" state. A `validate_live.py`
  FAIL is a real regression, never "wasn't in combat" — so a PR that "fixes" a failure by assuming an
  idle state is misdiagnosing a real bug.
- **Gates**: `ruff check .` and `python -m pytest` (the latter includes `test_docs_consistency.py`, the
  docs↔code drift-test — a reader change that makes a note lie about the code reddens it). **Live
  behavior can only be validated on Windows against the running game.** If the change could affect live
  capture (offsets, resolution, lifecycle, metrics), route it to Mario for the `validate_live.py` gate —
  Linux/mac tests passing is necessary, not sufficient.

## `app/` main process (`src/main/`) — the privilege boundary

Main-process code has Node/OS privileges the renderer must never get. State flows
`reader-policy.ts` → `reader-process.ts` → `ipc.ts` → renderer via the `MeterApi` preload
(contract in `src/shared/ipc-types.ts`).

- **Window security**: in `BrowserWindow` `webPreferences`, `contextIsolation` stays **on**,
  `nodeIntegration` **off**, `sandbox` not disabled, and the preload stays the only bridge. A diff that
  flips any of these hands a compromised renderer full Node access.
- **IPC surface**: a new `ipcMain.handle`/`ipcMain.on` handler must validate its arguments and must not
  turn renderer-supplied input into filesystem/shell/exec/network actions. `shell.openExternal` with a
  URL derived from untrusted data is a hole.
- **The sensitive modules**: `auto-update.ts` (feed URL + signature verification — electron-updater is
  CJS and bundled on purpose; disabled for the RC variant), `request-signer.ts` (Ed25519 signing of
  `POST /runs`), `error-report.ts` + `share.ts` (what data is uploaded and where — `API_URL`). Changes
  here are red-flags §C and escalate.
- `error-report.ts` size caps mirror the API's `@tbh/shared meterErrorReportSchema` (an external package,
  not vendored) — a change that desyncs the `MAX_*` constants breaks reports.
- **Gates**: `pnpm check` (eslint + tsc over both tsconfigs) and `pnpm test` (vitest; `pretest` syncs data).

## `app/` renderer (`src/renderer/`) — overlay / list / splash

- **XSS**: untrusted run/leaderboard data rendered via `dangerouslySetInnerHTML`, or a URL/HTML string
  built from server or run data, is an injection path. React escapes by default — a diff that opts out
  needs a hard reason.
- **The i18n every-key guard**: adding a UI string means the en-us key must be added to **all** locale
  dicts or `pnpm test` (`i18n.test.ts`) goes red — runtime falls back to English but the *test* does not.
  The convention is to translate en-us + pt-br and English-placeholder the rest; never machine-translate,
  and the repo is English-only outside the locale dicts.
- **IDs, not names** (`process/data-contract-id-based`): the reader emits IDs (`itemKey`/`statId`/
  `heroKey`/…); the front end resolves display names via `data/*.json`. A renderer change that expects
  names from the reader breaks the contract.
- **Real-pixel verification**: overlay/list changes must be verified on a seeded `~/tbh-meter/` run and a
  frame attached — unit tests don't prove the overlay looks right (app/CLAUDE.md).

## `data/` and generated dirs

- `app/src/shared/data/` and `app/src/renderer/public/{sprites,heroes}/` are **generated** — see
  red-flags §E. Reject hand-edits; the source is the `data/` snapshot via `scripts/refresh-game-data.mjs`.
- A `data/` change should look like a coherent datamine output, not arbitrary edits; verify sprite/asset
  provenance rather than trusting the file.

## `.github/` / workflows

Any change here is red-flags §A → escalate. Correctness-wise, `actionlint` runs in CI; but the security
review dominates — a workflow diff is judged on what it could do with secrets after merge, not on whether
it's syntactically valid.

## Docs / chore / other

- **Conventional Commits are load-bearing**: the release version and changelog are computed from commit
  subjects (`feat` → minor, `fix` → patch, breaking → major; `pr-title.yml` lints the PR title). A
  mislabeled `feat` that's actually breaking, or a non-conventional subject, corrupts the release. Flag it.
- **Docs-only / `.github`-only PRs** hit the path-filter trap (SKILL.md §3): required app/reader/CodeQL
  checks never report on a diff that doesn't touch their paths, so the PR looks permanently "blocked."
  That's expected — an owner bypass-merges after review; don't mistake it for a failing PR.
- Even a docs PR gets the §2 sweep: a link to an attacker-controlled host, or a "docs" diff that quietly
  touches code/config, is the oldest trick in the catalog (§G).
