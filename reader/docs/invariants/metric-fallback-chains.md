---
type: invariant
description: "Every live metric has the chain LIVE (exact) → SAVE (lagged, fallback) → NEVER wallet/total. run_gain returns None on a non-monotonic read (never emits negative), and the source tag (gold_source/xp_source) preserves the degradation — the fallback never silently becomes primary."
symptoms:
  - "gold doubled"
  - "gold 2x"
  - "sale counted in gold"
  - "wallet delta"
  - "wallet in gold"
  - "1.97T"
  - "gold 0"
  - "gold zeroed"
  - "wrong xp per run"
  - "phantom xp at cap"
  - "capped hero gains xp"
  - "xp at max level"
  - "gold_source save"
code_anchors:
  - metrics/gold.py::run_gain
  - metrics/gold.py::combat_gold_live
  - metrics/gold.py::combat_gold_save
  - metrics/xp.py::PartyXpAccumulator
  - metrics/xp.py::per_hero_gain
  - metrics/xp.py::level_capped
asserts:
  - metrics.gold.COMBAT_SUBKEY == 1
  - metrics.gold.TOTAL_SUBKEY == 0
  - config.offsets.EAggregateType.GoldEarn == 2
guarded_by:
  - tests/test_gold.py::TestRunGain::test_non_monotonic_returns_none
  - tests/test_gold.py::TestCombatGoldSave::test_ignores_total_subkey_zero
  - tests/test_xp.py::TestPartyXpAccumulator::test_late_join_credited_from_first_sight
  - tests/test_xp.py::TestPartyXpAccumulator::test_total_none_when_nobody_ever_seen
  - tests/test_xp.py::TestPartyXpAccumulator::test_solo_capped_hero_total_zero_not_none
  - tests/test_xp.py::TestPartyXpAccumulator::test_party_with_capped_hero_counts_only_uncapped
---

# Metric fallback chains

Every per-run metric (gold, xp) is a **delta of a cumulative** read from TWO sources of the SAME
number, on a fixed priority chain. The shape is canonical — gold is the prototype and xp follows the
same pattern:

```
1. LIVE  (exact, zero-lag, excludes sale/idle)  → PRIMARY
2. SAVE  (lagged, in jumps at autosave)         → fallback
3. NEVER wallet/total (includes sale + idle)    → reintroduces the bug
```

**Gold.** LIVE = `AggregateManager.AGGREGATES[GoldEarn][SubKey1]` (pure combat) in
`combat_gold_live`; SAVE = `PlayerSaveData.AGGREGATES` with `Type==GoldEarn` AND `SubKey==1` in
`combat_gold_save`. `COMBAT_SUBKEY` (=1) is the gold-per-run; `TOTAL_SUBKEY` (=0) is the rollup
(combat + sale + idle + quest) — **never** the source. The forbidden 3rd line is the wallet-balance
delta (`CurrencySaveData.QUANTITY`): it includes sale and idle, so `gold_end − gold_start`
**counts sale** → per-run over-count. The old value-scans that GUESSED the cell gave the historical
symptoms: frozen cell → **gold 0**; heap garbage → **1.97T**.

**XP.** LIVE = the **per-hero ACCUMULATOR** (`PartyXpAccumulator` in `metrics/xp.py`): it integrates
the within-level increments (the live exp decoded from the ACTk ObscuredFloat, `game/obscured.py` —
since 1.00.20 the `EXP_FAKE` decoy is dead) **tick-by-tick** (snapshot ~1s + a final tick
at close), keyed by IDENTITY (heroKey) — the 1st sighting seeds the baseline, the level-up bridges
across the curve (`per_hero_gain`), and late-deploy/death/dropout **do not lose the accumulated
total** (banked; a dead hero accumulates 0 while dead — real game behavior, preserved). It replaced
the endpoint delta (baseline t=0 → read at close), which gave **+0** to a hero OUTSIDE the baseline
(late deploy, or dead from the PREVIOUS run still reviving: `gain=None` → +0 — confirmed live:
30–45% of runs with a death zeroed a hero). SAVE = per-hero `HeroExp` delta (lagged, and resets at
level-up). The choice lives in the orchestrator (`close_run` in `meter_windows.py`):
`total()`/`record()` return `None` when the live source never saw the hero/anyone → falls back to
SAVE, never to a silent 0.

**XP at cap.** The curve DEFINES the cap: a level with no entry has no progression (`level_capped`) —
but the game keeps incrementing the within-level exp (and the save's `HeroExp`) on a hero AT cap, with
no level-up to consume/reset → the same-level delta is **PHANTOM XP**. A hero at cap gains **0** (a VALID
zero gain in `per_hero_gain`, never `None` — `None` would silently degrade to SAVE, which has the SAME
hole, so `close_run` also zeroes the save-side delta of a capped hero); crossing INTO the cap banks
only up to the threshold (`xp_through_levelup` counts `exp1` only if the final level is on the curve);
`exp_start`/`exp_end` follow the RAW observation (the baseline advances on a 0 gain — only the gain is
suppressed). Save-side asymmetry: a hero crossing INTO the cap MID-run has its entire save delta
zeroed (the live side banks up to the threshold) — consistent with the already-documented limitation
of the save underestimating a hero who levels up. Confirmed in production: SOLO runs of a lv101 Ranger
each gained ~39M xpGained, and a party with a capped hero credited 20% of the total to someone who
can gain nothing.

## The rule (3 parts, all required)

1. **Delta only via `run_gain(start, end)`.** Returns `None` if a read is missing (`start`/`end`
   `None`) OR if the cumulative **dropped** (`end < start`, corrupted read / GC moved the object).
   **Never emits negative.** Watch out for skill drift: a **zero gain is valid** (`run_gain(100,100)==0`,
   a run with no gold is still a run) — the guard is against **non-monotonic**, not against zero. Live
   xp has the same discipline: the accumulator only sums increments `g > 0` from `per_hero_gain`, and
   on a same-level dip (dirty read) it **does not advance the baseline** — the recovery telescopes with
   no double-count and no negative.
2. **The fallback never silently becomes primary.** In `close_run` gold tries LIVE first; it falls
   back to SAVE only if `run_gain(live)` is `None`. The `gold_source` (`"live"`/`"save"`) and the
   `xp_source` are **serialized into the record** so the app can flag a degraded read. If LIVE and
   SAVE both fail, it emits **`0`** with source `"save"` — **never silently drops nor lets `None`
   become a wrong default**.
3. **Source `save` on a success with damage > 0 triggers self-heal**, it is not accepted as normal: the
   orchestrator re-resolves the `AggregateManager` klass (RVA index first, value-scan fallback — see
   [[invariants/gold-singleton-resolution]]) so the next run returns to LIVE.

**Why SAVE is only a fallback:** it updates in JUMPS (only on the save-write, ~100s), so the
per-run delta is unreliable — **0** if the run falls between two writes, **~2x (gold doubled)** if
one write catches two runs. Confirmed live: the save was off by +25k on one run and +1.18M on another
while the live side matched to the unit.

## When adding a new metric

Follow the SAME chain: find the exact LIVE source (structure, not name — see
[[invariants/gold-singleton-resolution]]), have a SAVE as fallback, use `run_gain` (or an equivalent
that returns `None` on non-monotonic), preserve a `*_source` tag, and **never** derive it from a
wallet/total balance. Reading the cumulative dict uses the correct strides
([[invariants/dict-strides]]); the live klass is cached and revalidated ([[invariants/cache-management]]).

## Related
- [[invariants/gold-singleton-resolution]]
- [[invariants/dict-strides]]
- [[invariants/cache-management]]
