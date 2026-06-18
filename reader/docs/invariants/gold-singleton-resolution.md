---
type: invariant
description: "The AggregateManager (live gold) is a 2-letter OBFUSCATED-NAME singleton that DRIFTS across builds (ut→uu) — resolve it by STRUCTURE (2-value signature + backrefs + bbwf round-trip), NEVER by name. Finding by name grabs the wrong class and gold comes out 0 or garbage (1.97T)."
symptoms:
  - "gold"
  - "gold per run"
  - "doubled gold"
  - "gold 0"
  - "1.97T"
  - "1.97 trillion"
  - "obfuscated singleton"
  - "2-letter name"
  - "name drift"
  - "AggregateManager"
  - "find_class_by_name"
code_anchors:
  - metrics/gold.py::resolve_combat_gold_klass
  - metrics/gold.py::_resolve_aggregate_singleton
  - metrics/gold.py::gold_index_by_structure
  - config/offsets.py::AggregateManager
  - il2cpp/finder.py::bbwf_from_klass
asserts:
  - metrics.gold.COMBAT_SUBKEY == 1
  - metrics.gold.TOTAL_SUBKEY == 0
  - config.offsets.EAggregateType.GoldEarn == 2
  - config.offsets.Dict8B.STRIDE == 0x18
  - config.offsets.Dict8B.VALUE == 0x10
guarded_by:
  - tests/test_gold.py::TestResolveCombatGoldKlassByIndex::test_returns_none_when_gate_rejects_klass
  - tests/test_gold.py::TestFindGoldIndex::test_returns_none_when_value_scan_fails
  - tests/test_gold.py::TestGoldIndexByStructure::test_finds_index_passing_gate
---

# Gold singleton resolution (obfuscated name)

The live gold-per-run lives in `AggregateManager.AGGREGATES[GoldEarn][SubKey1]` (pure combat, excludes
selling). The **offset** was always right — the hard part is finding the **live object**. The class is a
singleton `X : nn<X>` whose name is a 2-letter OBFUSCATED identifier, and that name **DRIFTS across
builds** (confirmed: it was `ut`, became `uu`, and `ut` turned into a different class). It's documented
in `AggregateManager` itself in `offsets.py`.

**The rule:** an obfuscated-name singleton **is NOT resolved by name**. `find_class_by_name("ut")` (or
any 2-letter name) grabs the WRONG class in the next build → the singleton doesn't resolve. The old
versions then fell back to a value-scan that GUESSED the cell, and the guess always missed: largest
value grabbed the frozen copy (gold **0**); largest growth grabbed heap garbage (gold **1.97T**).
Resolution has to be by **STRUCTURE** (name-free), the pattern locked into
`resolve_combat_gold_klass` → `_resolve_aggregate_singleton`:

1. **2-value signature.** Find the live GoldEarn inner-dict by the co-occurrence of an entry
   `KEY == COMBAT_SUBKEY` (=1) with a value in the save's narrow band AND a sibling entry
   `KEY == TOTAL_SUBKEY` (=0) with a value `>=` it. Two billion-scale numbers, side by side, don't
   happen by chance → deterministic signature, ~zero false positives.
2. **Climb the backrefs.** inner-dict → outer-dict that references it under the `GoldEarn` key → the
   object that owns the outer-dict.
3. **Singleton round-trip.** Confirm that object is the ROOTED singleton: the class's static field
   `bbwf` points back to it (`bbwf_from_klass(reader, klass) == inst`). A frozen copy (autosave/GC
   leftover) isn't rooted → doesn't pass. It's OWNERSHIP, not a guess.

We cache the **KLASS** (stable within a session; classes don't move). On each read we re-deref via
`bbwf` (robust to the GC moving the instance) and walk the dict — and the entire walk uses the `Dict8B`
geometry (`STRIDE`/`KEY`/`VALUE`), never the `DictFloat` one; swapping that would corrupt the value (see
[[invariants/dict-strides]]).

**This is the OBFUSCATED path (today's fallback).** The PRIMARY path is by INDEX
(`resolve_combat_gold_klass_by_index`, TypeDefIndex via RVA), also name-free by construction — see
[[invariants/rva-index-resolution]]. `combat_gold_klass_ok` is the common GATE: it confirms a klass
(from the cache, the index, or the scan) resolves a live AggregateManager with GoldEarn (= the
round-trip). Wrong klass → gate fails → falls back to this structural resolution.

**Discovering `idx_ut` during CALIBRATION — also by structure, not by value-scan.** The gold index
is learned once per build and persisted in the seed. It used to come only from the value-scan
(`gold_index_of_klass(gold_klass)`), but the value-scan is FRAGILE: it bootstraps the klass by VALUE in
a narrow band around `combat_gold_save`, and if the save lagged behind the live value (farming between
save-writes) it returns `gold_klass=None` → calibration died with `[calib] FAILED to locate gold idx`
(confirmed in 1.00.11). The robust path is **`gold_index_by_structure`**: it scans the already-discovered
`s_TypeInfoTable` and returns the SMALLEST index whose `table[idx]` passes the SAME `combat_gold_klass_ok`
— the gate applied over the indices instead of trusting the value. Name-free, no value-scan, <1s (proven
live in 1.00.11: single hit idx=2744). `_calibrate` uses the `gold_index_of_klass` shortcut when the scan
already has the `gold_klass`, and falls back to this structural walk when it doesn't.

**Applies to ANY 2-letter obfuscated singleton** (`ut`, `uu`, `yp`, …), not just gold: if a new metric
needs one, resolve it by structure like here — never by name. (Distinct from
[[invariants/instance-selection]]: there the NAME is stable — `LogManager` — and the problem is picking
the live instance among false positives from the scan of the SAME class.)

## Related
- [[invariants/rva-index-resolution]]
- [[invariants/dict-strides]]
- [[invariants/metric-fallback-chains]]
