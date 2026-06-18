---
type: invariant
description: "Version lives as a single source in meter_windows.py: RAW_SCHEMA_VERSION (the LIVE format of raw/<id>.json, bump it when the reader's OUTPUT changes) + SCHEMA_VERSION (=11, the frozen LEGACY runs.jsonl, the migration marker). Changed the SHAPE of a raw field? bump RAW_SCHEMA_VERSION + dispatch in the converter. A NEW additive field the converter ignores does NOT bump — it goes in OPTIONAL in the TS contract. Never bump for a game build or a dead copy."
symptoms:
  - "add field to runs.jsonl"
  - "new field on the run"
  - "schema not bumped"
  - "app does not normalize"
  - "field does not appear in app"
  - "bump schema version"
code_anchors:
  - meter_windows.py::RAW_SCHEMA_VERSION
  - meter_windows.py::SCHEMA_VERSION
  - meter_windows.py::build_raw_record
  - app/src/shared/raw-types.ts
  - app/src/shared/run-types.ts
asserts:
  - meter_windows.RAW_SCHEMA_VERSION == 2
  - meter_windows.SCHEMA_VERSION == 11
---

# Versioning the reader's output

Today the reader emits **`raw/<id>.json` — 1 file per run**, stamped with **`RAW_SCHEMA_VERSION`**;
the converter (app) *dispatches* on that value. **Changed the SHAPE of the reader's output** (new field,
field whose shape changed)? **bump `RAW_SCHEMA_VERSION`** — and **only** that: do NOT bump for a game
build (a re-seed/address change does not change the shape). The old `runs.jsonl` (append-only, mixed
schema) is **LEGACY**: the reader no longer writes it; `SCHEMA_VERSION` is **frozen at 11** as the
marker the converter's migration uses to branch when reading the old records (`≤11`).

**v2 (Redesign 2):** raw v2 changed the run's IDENTITY — `id` = the END timestamp in **ms** as a string
(`str(ts_ms)`), `ts` in ms, **no `session_id` and no `run`** (the session is derived by the app). It kills
the `run_num`-reset class of bug (id recycled on restart → the new run vanished).

**ADDITIVE exception (established by the account snapshot — `runes`/`inventory`/`stash`):** a **NEW**
field the converter does **not yet consume** does NOT bump the version — it goes in **optional** in the TS
contract (old raw lacks it; the consumer detects it by the PRESENCE of the key, not by the version) and
the converter ignores it (it reads by name; an unknown key does not change the output). Bumping without a
new dispatch in the converter would only stamp `issues.raw_schema_version = "unsupported …"` on every new
run, for no gain. **Bump** when the SHAPE/meaning of an EXISTING field changes, a field disappears/is
renamed, or the converter NEEDS to branch by version to consume the change.

**Both versions are a SINGLE source in `meter_windows.py`** (`RAW_SCHEMA_VERSION` live, `SCHEMA_VERSION`
legacy) — that is where the record is stamped. There was a DEAD, lagging copy in `config/offsets.py`
(`=5` while the runtime emitted 11): it was removed, and `test_docs_consistency::test_version_constants_unique`
fails if it reappears. Do NOT treat the "bible" (offsets.py) as the source of the version — bumping the wrong
place leaves the real record stuck and the converter blind to the new field ("schema not bumped").

**Recipe to add/change a raw field:**
1. bump `RAW_SCHEMA_VERSION` **if the change does not fall under the additive exception above** (shape
   changed/field gone/needs dispatch → bump; new field ignored by the converter → no bump, optional in the
   contract). When bumping, update the comments next to it and to `SCHEMA_VERSION`;
2. emit the field in `build_raw_record` — in an **ok/err envelope** if it is a read that can fail — and **initialize it in `new_run`** if it accumulates during the run;
3. **contract**: reflect the field in `app/src/shared/raw-types.ts` (`RawRunV2`), with the SAME key/casing as the wire (ids, not names — [[process/data-contract-id-based]]);
4. **converter (app, TS)**: handle it in `convert()`, branching by `raw_schema_version`; derived values (dps/rates/names) do NOT go back to the reader.

The drift-test asserts `RAW_SCHEMA_VERSION == 2` and `SCHEMA_VERSION == 11`: when you bump in the code,
update this note along with it — that is what proves the base did not fall behind the runtime.

## Related
See also: [[invariants/run-lifecycle]] (field init in new_run) · [[invariants/app-normalization]] · [[guides/add-runs-field]]
