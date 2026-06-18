---
type: guide
description: "Sequenced checklist for mapping a NEW value out of the game's memory — with a hard ORACLE GATE (nothing ships without a noted oracle + delta == oracle across >=3 runs + 1 edge case + synthetic test). Pulls together the methodology, name-free resolution (structure or index), the right stride, the fallback chain, and what to re-capture if the value enters calib."
code_anchors:
  - metrics/gold.py
asserts:
  - metrics.gold.COMBAT_SUBKEY == 1
  - meter_windows.CACHE_FMT == 9
guarded_by:
  - tests/test_gold.py::TestCombatGoldSave::test_ignores_total_subkey_zero
---

# Guide — mapping a NEW value out of memory

You want to read a NEW datum from the game (another `EAggregateType`, per-run drops, a non-gold
resource, damage per attribute…). The model case is **combat gold** — read the header of
`metrics/gold.py` (the whole story: why the obfuscated name, why the save is fallback-only, how
the structure was pinned down) and the methodology in [[process/value-mapping-method]] **before**
writing any read. This guide is the sequenced checklist; each step points to its co-required
invariant.

> **Before you start — does this already exist?** Before "mapping", check the inventory in
> [[reference/value-inventory]]: many future values (other `EAggregateType`s, gold by source)
> reuse an **already-resolved** singleton — then there's nothing to "find", you just read another key.

## ORACLE GATE (non-negotiable)

**Do NOT ship a new value without ALL four:**

1. **Noted oracle** — the REAL number from the game (balance, xp, damage of one hit), written down
   BEFORE searching. Without an oracle you prove nothing — its absence is what let gold≈0 and then
   gold=1.97T ship (a guess off an isolated value, with no known answer to check against).
2. **`delta == oracle` across `>= 3` runs** — the per-run value has to match to the unit in at
   least three distinct runs, not just one.
3. **`+1` EDGE case** — a run that stresses the semantics. For gold it was a run **selling** an
   item: it proved that combat (`COMBAT_SUBKEY`) **excludes** the sale (`live_total − live_combat`
   gave the exact sale value). Find the analogous edge for YOUR value (idle, level-up, death, stage
   reload).
4. **Synthetic test** — a unit test with FAKE memory (live cell vs frozen copy) against the real
   module, modeled on `test_gold.py`. **Every new value gets one** — it's what locks the rule
   against silent regression when the game rebuilds.

Fail any one → **it doesn't ship**. "Matched on one run" is not proof.

## Checklist (in order)

1. **Note the oracle** (gate §1). Start/end, or an exact value from the game.
2. **Find by STRUCTURE, never by name nor by a single value** (gate §2 of the methodology in
   [[process/value-mapping-method]]): a signature of N known values together, *liveness*
   (the live cell GROWS; a frozen copy doesn't), and walking backrefs up to the root. Run the
   read-only `tbh-meter-dev` probes (outside the app) to locate the cell.
3. **Walk up to the ROOT if you want a stable LIVE source.** If the source is an **obfuscated-name
   singleton** (a 2-letter identifier that DRIFTS per build — `ut`→`uu`), resolve it by structure +
   a static-field round-trip, NEVER via `find_class_by_name` — see
   [[invariants/gold-singleton-resolution]]. If there's a path via **TypeDefIndex (RVA)** — today's
   primary, faster than the scan — resolve by index, also name-free by construction, with the
   anti-poison revalidation gate — see [[invariants/rva-index-resolution]]. (Without a stable live
   source, the save snapshot serves as fallback.)
4. **Use the right STRIDE when walking the dictionary.** There are TWO IL2CPP `Dictionary`
   geometries — `DictFloat` (4B float value) vs `Dict8B` (8B value: long or pointer). Picking wrong
   corrupts the value **silently, without a crash**. Reuse `dict8b_items` for 8B dicts and the named
   constants, never an offset literal — see [[invariants/dict-strides]].
5. **Slot into the FALLBACK chain.** The canonical shape is `LIVE` (exact) → `SAVE` (lagging,
   fallback) → **NEVER** wallet/total (reintroduces sale/idle → over-count). The delta comes from a
   `run_gain`-style function that returns `None` on the non-monotonic case (and **zero is valid**,
   not a failure), and preserves a `*_source` tag so the app can signal a degraded read — see
   [[invariants/metric-fallback-chains]].
6. **Validate against the oracle** (gate §2 + §3): `delta == oracle` across `>= 3` runs + the 1 edge.
7. **Persist in the right place (single source).** New offset/id/enum → `config/offsets.py` (with a
   comment and dump ref). BUSINESS rule (which subkey means what, e.g.:
   `COMBAT_SUBKEY = 1`) → in the logic module (`metrics/…`), commented — **not** in `offsets.py`,
   which is offsets/enums only. Obfuscated name → **structural resolver**, never hardcoded.
8. **Write the synthetic test** (gate §4), modeled on `test_gold.py`.
9. **Isolate the logic.** The read lives in the domain module (`metrics/…` or `game/…`);
   `meter_windows.py` only **calls**, never reads memory inline.
10. **If the value enters `runs.jsonl`** — bump `SCHEMA_VERSION` and normalize in the app (its own
    guide: [[guides/add-runs-field]]).
11. **If the value's resolution enters CALIB** (index/anchor/catalog learned in the scan and reused
    by the fast path) — you changed the SHAPE of the calib block: **bump `CACHE_FMT` AND re-capture
    `config/calib_seed.json`** in the new format. Bumping `CACHE_FMT` alone breaks the seed (the
    RC's `--selftest` fails and the runtime rejects the seed by `fmt` → cold scan on every first
    launch) — see [[invariants/cache-management]].

## Related
- [[process/value-mapping-method]]
- [[invariants/gold-singleton-resolution]]
- [[invariants/rva-index-resolution]]
- [[invariants/dict-strides]]
- [[invariants/metric-fallback-chains]]
- [[invariants/cache-management]]
See also: [[guides/add-runs-field]] (step 10) · [[reference/value-inventory]] (already mapped)
