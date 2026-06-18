---
type: invariant
description: "Every structural offset/enum/stride lives in config/offsets.py (single source); a BUSINESS-RULE constant lives in the logic module (e.g. COMBAT_SUBKEY in metrics/gold.py); SCHEMA_VERSION/GAME_VERSION live in meter_windows.py — never duplicate."
symptoms:
  - "wrong offset"
  - "where does the offset live"
  - "gold corrupted"
  - "wrong stats"
  - "constant in the wrong file"
  - "magic number scattered"
  - "two sources of truth"
  - "schema bumped in the wrong place"
  - "version defined in two modules"
  - "test_version_constants_unique failed"
code_anchors:
  - config/offsets.py
  - metrics/gold.py::COMBAT_SUBKEY
  - meter_windows.py::SCHEMA_VERSION
asserts:
  - config.offsets.Dict8B.STRIDE == 0x18
  - config.offsets.DictFloat.STRIDE == 0x10
  - config.offsets.GOLD_KEY == 100001
  - metrics.gold.COMBAT_SUBKEY == 1
guarded_by:
  - tests/test_docs_consistency.py::test_version_constants_unique
---

# Single source for offsets (and where NOT to put a constant)

`config/offsets.py` is **the offset bible**: the one place where every field offset, enum and
structural **stride** of the game lives (all derived from the IL2CPP dump and validated live). An
agent reading a new field **reads the symbol from here**, never hard-codes a `@0x` literal in the
middle of the logic — a loose number silently desyncs when the build changes, and nobody finds the
second copy to update. Adding a field = add the class/attribute here and reference the symbol
(`UnitHealthController.HP_CURRENT`, `Dict8B.VALUE`), not the raw offset.

**What does NOT live here — and why.** The header of `offsets.py` itself warns: *"business-rule
constants (curve, filters) do NOT live here — only offsets/enums"*. Two categories have a
different owner:

- **Business rule** (what a given SubKey/curve/filter means) lives in the **logic module**, next
  to whoever uses it. Concrete example: `COMBAT_SUBKEY = 1` and `TOTAL_SUBKEY = 0` live in
  `metrics/gold.py`, NOT in `offsets.py` — `SubKey 1 = combat gold`, `SubKey 0 = total (rollup,
  includes sales)` is gold semantics, not struct geometry. The offset that WALKS there
  (`AggregateManager.AGGREGATES`) is structural → that one does live in `offsets.py`. The line is:
  **address/shape → `offsets.py`; meaning → the metric's module.**

- **Version** (`SCHEMA_VERSION`, `GAME_VERSION`) lives **only in `meter_windows.py`** — it's the
  value serialized in the `runs.jsonl` record, so the single source is the record's emitter. There
  was a DEAD, stale copy of `SCHEMA_VERSION` in `offsets.py` (`=5` while the runtime was already
  emitting 11): it was **removed**. Bumping the wrong copy leaves the real record stuck → the app
  goes blind to the new field (the "schema not bumped" class of bug). `test_version_constants_unique`
  now **fails** if `SCHEMA_VERSION` or `GAME_VERSION` reappears in more than one module — it's the
  gate that proves the second source hasn't come back.

**The two Dictionary geometries.** The costliest warning in `offsets.py` is not to confuse
`DictFloat` (4-byte value, `STRIDE` 0x10) with `Dict8B` (8-byte value — long OR pointer, `STRIDE`
0x18). Swapping one for the other corrupts gold/stats with no error. The detail of WHEN to use each
is its own invariant (see Related); here the point is that **both strides live in `offsets.py`** —
you don't reinvent a local stride.

Rule of thumb when adding a constant: **is it an address/shape of the binary?** → `offsets.py`, as a
symbol. **Is it a product/semantics decision?** → the module that decides, commented with the oracle
that pinned it down. Never both things in the same place, never the same thing in two places.

## Related
- [[invariants/schema-versioning]] — the single source of `SCHEMA_VERSION` (in `meter_windows.py`) and the bump recipe
See also: [[invariants/dict-strides]] (DictFloat 0x10 vs Dict8B 0x18 — when to use each) · [[invariants/gold-singleton-resolution]] (where COMBAT_SUBKEY + AggregateManager.AGGREGATES work together) · [[invariants/obscured-data-offlimits]] (Obscured fields flagged in offsets.py that are NOT read)
