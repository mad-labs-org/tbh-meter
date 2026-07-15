---
type: process
description: "The id-based contract of raw/<id>.json: the reader emits stable IDs (itemKey, statId, heroKey, stageKey, uniqueId, box_key, monsterKey) and the front resolves display-names via web/src/data/*.json. No display name is the IDENTITY; labels that still ship are transitional redundancy. The RUN identity is its end timestamp (raw v2; no session_id/run — Redesign 2)."
code_anchors:
  - meter_windows.py::close_run
  - meter_windows.py::run
  - game/build.py::read_build
  - game/build.py::read_stats_dict
  - meter_windows.py::_read_catalogs
  - app/src/shared/run-types.ts
asserts:
  - meter_windows.SCHEMA_VERSION == 11
---

# id-based data contract (raw/<id>.json)

The reader output — today **`raw/<id>.json`** (1 file per run; formerly `runs.jsonl`, now legacy) —
is **id-based**: the identity of each thing is a **stable game int** — `itemKey`, `statId`,
`heroKey`, `stageKey`, `classId`, `gradeId`, `slotId`, `recipeId`, `uniqueId` (the item's natural
per-instance key, emitted as a lossless STRING), `box_key`/`monster_type` (drops), `monsterKey`
(who killed a hero). The run IDENTITY is its end timestamp (raw v2; see invariants below). The **front** (`web/src/data/*.json` — `items.json`,
`heroes.json`, `stages.json`, etc., resolved by `web/src/lib/data.ts`) is what translates id →
display-name. Contract origin: `docs/refactor-roadmap.md`, "DATA CONTRACT" section ("server NEVER
stores/returns display names; front resolves names from catalogs").

**Why id, not name.** Display names are front labels (localizable enums, renameable every
patch); the id is the join/aggregation key in the DB and what survives a game rename. Storing
the name in the record (a) duplicates mutable data, (b) breaks the join when the front re-localizes, (c) bloats the
JSON. The DB ingests the ids and projects — aggregation by `stage_key`/`class_id`/`hero_key`, catalogs
(`catalog_*`) on the side. The 64 stats were the pilot case: they now ship **only** as `{statId:
value}` (id-only), which incidentally closed the `STATN` label gap that stopped at 59 (stats 60-63 turned into
generic `stat60..63`).

## The REAL state is HYBRID (read before you "clean up")

The rule is id-based, but TODAY's output still **emits some labels alongside the id** — don't confuse
"the contract" with "what the reader has already stopped sending":

- **truly id-only:** `stats` (`{statId: value}`, in `read_stats_dict`).
- **id + redundant label:** the item carries `slotId`+`slot`, `gradeId`+`grade`; the mod carries
  `recipeId`+`recipe`, `statId`+`stat`; the hero carries `classId`+`class` (assembled in `read_build`).

The `game/build.py` docstring is explicit: these labels stay populated so the output **matches the
monolith byte-for-byte at cutover**, and **dropping them is a future schema-bump**. In other words: the id is the
identity (always present, always the key); the label is a transitional remnant. An agent that **adds** a
field must emit the **id** as the truth — don't invent a new display-name field. Whoever **removes**
the existing labels is making a contract change → bump `SCHEMA_VERSION` + coordinate with the front.

## Invariants of this contract (what must NOT break)

- **The record is never the source of the name.** New field = id (or number). Name resolution lives in the front.
- **`uniqueId` is the item's per-instance identity** (the DB's natural key); `itemKey` is the type. Don't
  swap one for the other.
- **The run IDENTITY is its end TIMESTAMP (raw v2: `id = str(ts_ms)`).** Sequential per machine →
  never collides, no session, no counter. (BEFORE: `session_id:run` minted by the reader — it recycled on
  restart and made runs vanish; removed in Redesign 2.) **Session is NO longer the reader's** — the app DERIVES it from the
  runs (6h gap + cuts).
- **Ids have a sanity range** at the source (`heroKey`/`itemKey` in `0 < k < 10_000_000`, see
  `_read_catalogs`/`read_live_stats_by_hero`) — memory garbage doesn't become an id.
- **Casing**: the JSON uses the original keys (`heroKey`, `stageKey`); the snake_case normalization
  (`heroKey→hero_key`) happens at the DB ingest boundary, not in the reader. In the app, the
  snake_case→camelCase mapping is part of the defensive normalization.

## How to act under this contract

- **Added a datum that has an id in the game?** Emit the id (and, if useful today, the label alongside like the
  others — but the id is mandatory). Follow the recipe in [[guides/add-runs-field]] and the bump in
  [[invariants/schema-versioning]]; type/normalize defensively in the app ([[invariants/app-normalization]]).
- **Going to display the name?** Resolve it in the front via `web/src/data/*.json`; don't ask the reader to send the
  name. The reader, at most, exports the **catalogs** (id→attributes) — that's the planned `--dump-catalogs`,
  whose raw material already exists in `meter_windows.py` (`_read_catalogs`, which derives stage_info/item_cat/hero_cat)
  and in the enums of `config/offsets.py`.

## Related
- [[invariants/schema-versioning]]
- [[invariants/app-normalization]]
See also: [[guides/add-runs-field]] (the end-to-end recipe) · [[reference/run-data-map]] (the id→reader map)
