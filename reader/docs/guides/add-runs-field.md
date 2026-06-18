---
type: guide
description: "End-to-end recipe for adding a new field to the run record (raw/<id>.json → logs/<id>.json): decide the bump (RAW_SCHEMA_VERSION only if the SHAPE changed; additive doesn't bump; SCHEMA_VERSION=11 is frozen legacy) → initialize in new_run (if it accumulates) → serialize in build_raw_record → derive/coerce in the converter+app → optional type. Skipping a step = a field that leaks from the previous run, a blind converter, or one that vanishes in the app."
code_anchors:
  - meter_windows.py::close_run
  - meter_windows.py::new_run
  - meter_windows.py::RAW_SCHEMA_VERSION
  - meter_windows.py::build_raw_record
  - app/src/main/sources/runs-source.ts
  - app/src/shared/run-types.ts
---

# Guide: adding a field to the run record (raw → logs)

The reader emits **one `raw/<id>.json` per run** (raw, never rewritten); the app's **converter**
(`converter/convert.ts`) derives the structured `logs/<id>.json` the UI reads — and records from
**every era** coexist (the old `runs.jsonl` enters only via migration). Adding a field touches
**5 places in order** — skip one and the field leaks from the previous run, leaves the converter
blind, or never reaches the app. Do them in this sequence.

## First: is the field RUN-level or HERO-level?

There are two record levels with two distinct normalizers — decide first:

- **run-level** (applies to the whole run: `gold_gained`, `deaths`, `drops`): goes in the `rec`
  of `close_run` and is normalized by `normalizeRecord` in `runs-source.ts`.
- **hero-level** (per deployed hero: `xp_gained`, `killed_by`, per-hero `deaths`): goes in each
  item of `heroes_out` inside `close_run` and is normalized by `normalizeHero`.

The rest of the recipe is the same; only WHICH dict/normalizer you edit changes.

## 1. Decide the bump — [[invariants/schema-versioning]]

Two numbers live in **`meter_windows.py`**, with opposite roles:

- **Did the output SHAPE change** (a field the converter must dispatch/interpret differently)?
  → bump **`RAW_SCHEMA_VERSION`** (extend the history comment next to it) **+ the corresponding
  dispatch in the converter**.
- **Purely ADDITIVE field** the converter just passes through? → **bump nothing**; the field
  enters OPTIONAL in the TS contract (step 5).
- **`SCHEMA_VERSION` (=11) is the frozen LEGACY marker of `runs.jsonl`** — the reader no longer
  writes that file; bumping it breaks the migration marker and fails `test_asserts_hold`. NEVER.

The source is SINGLE: do NOT create a copy in `config/offsets.py` — it was removed on purpose and
`test_version_constants_unique` fails if it reappears. Bumping the wrong place leaves the real
record stuck on the old number and the converter blind to the field (the classic "schema not
bumped" bug class).

## 2. Initialize in `new_run` IF the field ACCUMULATES — [[invariants/run-lifecycle]]

`new_run()` is the **single source of per-run state** and returns the zeroed dict. **Golden rule:
every field that ACCUMULATES during the run is born here** — otherwise the previous run's value
leaks into the next. Accumulators already present: `drops` (list), `deaths`/`revives`/`killers`
(heroKey-keyed dicts), `party_seen`. If your field is a delta/counter/list that grows tick by
tick, add the zeroed key (`[]`, `{}`, `0`) in `new_run` and update it in the loop or in the log
handlers. If the field is **derived only at close** (computed from other state inside
`close_run`), skip this step.

## 3. Serialize in the `rec` of `close_run`

In `close_run`, the record is born in **`build_raw_record`** — add the field there (run-level) or
to the corresponding hero item, before the `_write_atomic` that writes the `raw/<id>.json`. Use
snake_case for the JSON keys (the record's convention). For a **sparse** hero field (only
meaningful when non-empty, e.g. `deaths`, `killed_by`), follow the existing pattern: **only attach
the key if the value is truthy** — the app treats absence as "not tracked", which keeps the record
lean and the semantics honest.

## 4. Defensive normalization in the app — [[invariants/app-normalization]]

> **Post reader↔app redesign:** the app reads the **already-converted** structured records from
> `logs/` via `loadStructured` (`runs-source.ts`) — the one that **derives/seals** a new field
> from the raw is the **converter** (`converter/convert.ts`; quality verdict in
> `converter/helpers.ts`), and `loadStructured` only does **parse + coercion** (no re-deriving).
> `normalizeRecord`/`normalizeHero` below remain the normalizers of the legacy `runs.jsonl`, today
> used **only in migration** (`converter/legacy.ts`). The coercions apply to BOTH (same helpers,
> same "absent" semantics).

Coerce the field in the right normalizer. Pick the helper by the semantics of "absent":

- **genuinely optional numeric** (0 ≠ "absent", e.g. `deaths`/`revives`/`expStart`):
  `firstDefinedNum(...)` → `undefined` when missing. Do **not** use `firstNum` here: the default
  `0` lies, becoming a "real zero" in a record that never had the data.
- **numeric with default zero** (and/or multiple era keys): `firstNum(...)` → `0`.
- **nullable in the DTO** (`act`, `stageNo`): `numOrNull(v)` → `null`.
- **string**: `str(v, fallback)`.
- **tolerant array** (`drops`, `killed_by`): `Array.isArray(raw.x) ? raw.x.map(...).filter((e):
  e is T => e !== null) : []` — each item becomes `T | null`, the `null`s drop out; a malformed
  item disappears, the array survives.

**Optional-field pattern:** build the base object (literal with the always-present fields) and
**attach the optional one conditionally AFTER the literal but BEFORE the `return`** (`if (x !==
undefined) record.x = x`). **NEVER after the `return`** — dead code, the field never reaches the
DTO. An old record that lacks the field becomes `undefined`/empty, **never a crash, never a wrong
default**; a line that fails normalization is skipped, it doesn't bring down the watcher.

## 5. Type it as OPTIONAL in `run-types.ts`

Mirror the step-4 choice in the type. In `RunRecord` (run) or `RunHero` (hero): genuinely optional
field → `field?: T`; explicitly nullable → `field: T | null`. Arrays map the JSON's snake_case
keys → camelCase in TS (e.g. `killed_by` → `killedBy?: number[]`). A field that isn't optional
here but is missing from old records forces TS to assume it's always present — and the app starts
relying on something half the lines don't have.

## No need to touch here

- The read-time dedup (`dedupeById` + `dedupeSessionScoped` in `runs-source.ts`) uses only
  **raw, stable** fields that already exist (`contentSig`) — a new field doesn't enter the
  signature; don't touch it, unless the new field is itself a dedup criterion. The discard of
  `partial`/`skipped` is **not** in the read path — the converter seals the verdict (`convertLegacy`
  in migration, `convert` on the new raw) and `eligible()` suppresses it at upload; see
  [[invariants/app-normalization]].
- The "30s/x-10" rule (skip) and the `partial` flag belong to the lifecycle, not serialization —
  see [[invariants/run-lifecycle]] if the new field interacts with them.

## Update the doc alongside

When you bump `RAW_SCHEMA_VERSION` in the code, update the `assert` in
[[invariants/schema-versioning]] (`RAW_SCHEMA_VERSION == N`) — it's what proves the base didn't
fall behind the runtime. (The `SCHEMA_VERSION == 11` assert stays as is: it's the frozen marker.)

## Related
- [[invariants/schema-versioning]] — why the bump is mandatory and why the source is single.
- [[invariants/run-lifecycle]] — `new_run` initializes every accumulator; `close_run` is where the record is born.
- [[invariants/app-normalization]] — the detail of the coercions, the tolerant arrays, and "attach before the return".
See also: [[reference/run-data-map]] (the field-by-field map of the record `close_run` emits)
