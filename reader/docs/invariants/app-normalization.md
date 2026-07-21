---
type: invariant
description: "The app reads the already-converted structured records from logs/ (loadStructured — parse + defensive coercion, NO re-deriving) and dedupes by id + session-scoped; firstNum/numOrNull/str coercions, a new optional field (field?: T) appended BEFORE the return — never crashes on an old record, never writes a wrong default. normalizeRecord survives only as a helper of the MIGRATION path (convertLegacy)."
symptoms:
  - "normalize field"
  - "field undefined in app"
  - "field not showing in app"
  - "runs-source"
  - "app reads logs"
  - "loadStructured"
  - "dedup"
  - "dedup of runs"
  - "session-scoped dedup"
  - "app crashes on old run"
  - "old run missing field"
code_anchors:
  - app/src/main/sources/runs-source.ts
  - app/src/main/converter/convert.ts
  - app/src/shared/run-types.ts
---

# Field normalization in the app

Since the reader↔app redesign the app **reads from `logs/`** (one `logs/<id>.json` per run, **already
converted once** by the converter — see [[invariants/schema-versioning]] and `convert.ts`). The read
path is `loadStructured` in `runs-source.ts`: it **only does parse + defensive coercion**, it does
**NOT re-derive** anything — the converter already unwrapped the `{ok,value}` envelope, derived
`dps`/rates and sealed the quality verdict. Every run read is from the **same era** (the converter's
uniform output), no longer the mixed-era `runs.jsonl`.

The coercion rule still holds (the structured record is still a JSON on disk that may be old or
corrupt): **every field is coerced defensively** — an old log (e.g. a pre-redesign mirror, without
`quality`/`issues`) that's missing a field becomes `undefined`/`null`/empty-default, **never a crash
and never a wrong default**. A file that won't parse, or that has no `id` (`loadStructured` →
`null`), is **skipped**, it doesn't take down the watcher.

> The **legacy** `runs.jsonl` (append-only, mixed schema) still exists, but is **no longer the read
> path** — it's consumed **only once** during **migration** (`converter/legacy.ts`, via
> `normalizeRecord`), which adopts each old line into `logs/` preserving the `external_id`.

## The coercions (the source is `runs-source.ts`)

The helpers in `runs-source.ts` encode the intent of each field type — pick the right one:

- `firstNum(...vals)` — first finite number, **`0`** if none. For numeric fields with a zero
  default and/or multiple era keys (e.g. `total_damage` v6 / `dano_total` v5).
- `firstDefinedNum(...vals)` — same, but **`undefined`** (not `0`) when there's no candidate.
  For a **genuinely optional** field where `0` ≠ "absent" (e.g. `expStart`, `deaths`).
- `numOrNull(v)` — finite number or **`null`**. For nullable fields in the DTO (`act`, `stageNo`…).
- `str(v, fallback="")` — string or fallback. `normalizeStatus` maps the PT strings (≤v5) and
  EN strings (v6) to the internal union.

**Picking `firstNum` (default `0`) where the field is optional lies** — it becomes `0` on a record
that never had the data, and the agent can't tell "real zero" from "not tracked". That's why
`deaths`/`revives`/`expStart` use `firstDefinedNum`: present = tracked (0 is meaningful), absent =
an earlier era. Mirror that choice in the type: the field MUST be **optional** (`field?: T`) in
`run-types.ts` — explicit nullables are `T | null`, optionals are `field?: T`.

## Arrays and optional fields — the exact pattern

- **Tolerant array**: `Array.isArray(raw.x) ? raw.x.map(...).filter((e): e is T => e !== null) : []`.
  Each element is normalized to `T | null` and the `null`s drop out — a malformed item disappears,
  the array survives (see `skills`, `drops`, `killed_by`, `items.mods` in `runs-source.ts`).
- **Optional field**: build the base object (a literal with the always-present fields) and **append
  the optional conditionally AFTER the literal but BEFORE the `return`** (`if (x !== undefined)
  obj.x = x`). **NEVER append a field after a `return`** — dead code, the field never reaches the
  DTO. In `normalizeRecord`/`normalizeHero` the optionals (`drops`, `deaths`, `revives`,
  `skillLevels`, `expStart`…) follow exactly this form.

## Dedup on read (session-scoped, never hides farm)

When loading `logs/`, `runs-source.ts`'s `reload` sorts newest-first and runs **two** collapses,
both via pure, testable functions in the same module:

1. `dedupeById` — collapses logs that share the **`id`** (the run's unique identity): two files
   with the same id are the SAME run written 2× (a re-finalization under a different `ts` → a
   different file name). Keeps the first (= the newest, post-sort). Always safe (same id = same
   run).
2. `dedupeSessionScoped` — collapses the **two-reader phantom**: identical content **only across
   DIFFERENT `sessionId`s** (see [[invariants/schema-versioning]] and the "Dedup" design). The
   signature (`contentSig`) uses only **raw, stable** fields — never the derived `dps`/`duration`
   nor the `ts`, which drift between two finalizations. A **farm** (distinct runs in the SAME
   session, even if they look identical) **never** collapses → zero false-hide of the grind.

**Partial/skip is NO longer a discard on read.** What judges accounting is the **converter**: it
seals `quality` (`counted`/`skipped`/`partial`/`degraded`) on the structured record (`classifyQuality`
in `converter/helpers.ts`); the app **shows every run** and **hides** the non-`counted` ones via a
**UI filter** (a "show ignored" toggle), deleting nothing (skip ≠ vanish).

`normalizeRecord` (still in `runs-source.ts`) is **NOT** in the read path — it survives as a
**migration-only** helper (`converter/legacy.ts`, via `convertLegacy`), which adopts each old line
into `logs/` and **seals the verdict** (`quality`/`partial`) via `classifyQuality`
(`converter/helpers.ts`), the SAME verdict as the conversion of a fresh raw. Suppressing
`partial`/`degraded`/`skipped` from `success` is the job of the **UI filter** — **no** longer a
discard on read (and never by `goldGained === 0`, which used to hide COMPLETE runs with a failed
gold read).

> The gold number itself (the "2x", then "0") is the **reader**'s problem, fixed there via liveness
> (`metrics/gold.py`). The app **trusts** the reader's gold and never tries to guess the value.

## Related
- [[invariants/schema-versioning]]
See also: [[guides/add-runs-field]] (the end-to-end recipe: bump → close_run → normalizer → type)
