---
type: process
description: "Methodology to map/validate ANY value the reader reads from memory: each value lives in ONE place (offset→offsets.py, business-rule→module, obfuscated name→structural resolver), plus the ORACLE method (have the real number BEFORE searching — without it gold shipped wrong 2x: 0 and 1.97T)."
code_anchors:
  - metrics/gold.py::resolve_combat_gold_klass
  - metrics/gold.py::COMBAT_SUBKEY
  - config/offsets.py::AggregateManager
asserts:
  - metrics.gold.COMBAT_SUBKEY == 1
  - metrics.gold.TOTAL_SUBKEY == 0
  - config.offsets.EAggregateType.GoldEarn == 2
---

# How to map and validate a value from memory

Every time the meter starts reading a new number from the game's memory (an aggregate, a stat, a
resource), the path is the SAME. This is the methodology that nailed combat gold (2026-06-05) and
that every new value must follow — without it, it becomes guesswork that fails silently. In short:
have the real number BEFORE searching, find the object by STRUCTURE (never by obfuscated name nor by
an isolated value), validate against the oracle across several runs, and keep each piece in ITS one
place.

## 1. Each value lives in ONE place (single source of truth)

Reuse the constant, never repeat the literal — but *where* it lives depends on the STABILITY of the
value across `GameAssembly.dll` builds:

| value type | changes across builds? | where it lives | example |
|---|---|---|---|
| **offset / id / enum** | no, stable | `config/offsets.py` (the bible) | `AggregateManager.AGGREGATES`, `GOLD_KEY`, `EAggregateType.GoldEarn` |
| **business rule** (game semantics) | no | in the logic module, commented | `COMBAT_SUBKEY=1` / `TOTAL_SUBKEY=0` in `metrics/gold.py` |
| **obfuscated class name** | **yes, every build** | **not stored** — resolve by structure | the `AggregateManager` singleton (`ut`→`uu`→…) |

The difference between the first two rows is subtle and the agent gets it wrong: `AGGREGATES` is an
**offset** (struct layout, doesn't change) → `offsets.py`; but "SubKey 1 = combat, SubKey 0 = total"
is **game semantics** (what the number *means*), not an offset — it lives COMMENTED next to the logic
that uses it (`metrics/gold.py`), and `offsets.py` keeps only offset/enum/stride. Putting a business
rule in `offsets.py` (or a loose offset in the logic module) breaks the single-source. Criterion
detail in [[invariants/dict-strides]] (strides are offset → bible) and in the inventory
[[invariants/metric-fallback-chains]].

## 2. The ORACLE method (have the real number BEFORE searching)

**A) Known-answer oracle.** Write down the REAL number from the game BEFORE scanning memory — the
wallet gold, a run's xp, a hit's damage. Without the oracle you have no way to PROVE you found the
right cell, only to guess — and that exact gap is what let gold ship wrong **twice**: the "largest
value" guess grabbed a frozen copy → **gold 0**; the "largest growth" guess grabbed heap garbage →
**1.97T**. The oracle is what separates "found it" from "guessed".

**B) Find by STRUCTURE, never by name nor by an isolated value** (the three levers, strongest to
weakest):
- **Signature of N known values TOGETHER.** The live GoldEarn inner-dict is the only one where an
  entry `KEY == COMBAT_SUBKEY` and a sibling `KEY == TOTAL_SUBKEY` appear side by side with values in
  the billions. Two big numbers together don't happen by accident → a near-zero-false-positive
  signature (`metrics/gold.py::_inner_array_of`).
- **Liveness (growth).** The live cell GROWS while the action happens; frozen copies (autosave/GC
  leftovers) don't. Distinguishes the live one without depending on the exact value.
- **Walk pointers up to the ROOT.** From a cell, find who points to it (backrefs) until you reach a
  ROOTED object — a singleton confirmed by the static field's round-trip. This is **OWNERSHIP**, not
  a guess: a frozen copy is not rooted (`metrics/gold.py::_resolve_aggregate_singleton`).

**C) Validate with the oracle, across SEVERAL runs, including edge cases.** Gold: 3 runs with the
delta matching to the unit + 1 run **selling** an item, to prove that combat (`SubKey1`) EXCLUDES the
sale — sold 186,480, `live_total − live_combat` gave exactly 186,480. Without matching all of them,
**it doesn't ship**.

**D) Read-only tools** live outside the app, in `tbh-meter-dev/` (faithful copies of the reader's
primitives): probes that find the cell by growth or by a 2-value signature, a monitor that logs the
variables run by run to cross-check against the oracle, and a test with SYNTHETIC memory (live vs
frozen copy). **Every new value must get one of these synthetic tests** — it's what pins the
invariant against regression without needing the game open.

## 3. The obfuscated-name trap (ut/uu drifts)

The dump (`re/dump/dump.cs`) names internal classes with 2 letters (`ut`, `uf`, `xd`, …). These names
are **shuffled on EVERY build**: what was `ut` (the `AggregateManager` singleton) became `uu`, and
`ut` went on to name ANOTHER class. Hard consequence:

- **Never** resolve an internal class by literal name in production — `find_class_by_name("ut")` grabs
  the WRONG class in the next build, the singleton doesn't resolve, and the value comes out 0 or
  garbage.
- Where it's a singleton with identifiable content (the `AggregateManager` one has the GoldEarn dict),
  resolve by STRUCTURE (`resolve_combat_gold_klass`) or by TypeDefIndex (RVA) — both name-free; the
  name only VALIDATES in a round-trip, never CHOOSES. That's the invariant in
  [[invariants/gold-singleton-resolution]].
- The `# ut : nn<ut>` comments in `offsets.py` are **dump history**, not runtime truth — they only
  serve to trace the origin, never to resolve.
- Classes reached by OFFSET from an already-resolved object (`HeroRuntime`, `StatsHolder`) don't depend
  on the name — OK. Audit whether anything resolves by short name directly and migrate it to structure.

## 4. Workflow for a NEW value (the sequence)

1. **Oracle**: write down the real number (start/end, or an exact value).
2. **Find** it with the probes (signature / growth / dump).
3. **Walk up to the root** if you want a stable LIVE source (singleton/owner); otherwise the save
   serves as fallback.
4. **Validate**: delta == oracle across N runs + 1 edge case. Without matching, it does NOT ship.
5. **Persist in the single-source** (§1): offset → `config/offsets.py`; business rule → module
   (`metrics/…`, commented); obfuscated name → STRUCTURAL resolver, never hardcode.
6. **Synthetic test** (live vs frozen memory) against the real module.
7. **Isolate**: the logic lives in the domain module (`metrics/…` or `game/…`); the orchestrator only
   CALLS, never reads memory inline. Every per-run metric follows the LIVE→SAVE→never-wallet chain from
   [[invariants/metric-fallback-chains]].

## Related
- [[invariants/gold-singleton-resolution]] — the model case: resolve the obfuscated singleton by structure, not by name.
- [[invariants/dict-strides]] — why stride/offset are "stable → bible" (and how a swapped stride corrupts silently).
- [[invariants/metric-fallback-chains]] — the LIVE→SAVE→never-wallet chain that every new metric inherits.
See also: [[guides/map-new-value]] (the short operational recipe of this method) · [[process/data-contract-id-based]]
