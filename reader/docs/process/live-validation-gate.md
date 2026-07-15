---
type: process
description: "Post-update, the static diff only covers NAMED classes; the OBFUSCATED ones (gold/AggregateManager, party+xp/HeroRuntime, StatsHolder) can only be validated LIVE. The validate_live.py gate resolves via the seed and requires PASS on gold+party+xp+stage+catalogs before ship — partial validation (only the fixed field) is what let two bugs slip through in 1.00.11."
code_anchors:
  - scripts/validate_live.py
  - scripts/diff_offsets_vs_dump.py
---

# Live validation gate (post-update)

A game update can touch ANY offset. The static tripwire
(`scripts/diff_offsets_vs_dump.py`, see [[invariants/rva-index-resolution]]) checks the **NAMED**
classes against the dump — but the **OBFUSCATED** ones, whose names drift per build (gold/`AggregateManager`,
party+xp/`HeroRuntime`, `StatsHolder`), it flags as "unverifiable, validate live" and moves on. That's the
diff's blind spot.

Burned in 1.00.11: TWO bugs reached a build because validation was PARTIAL — only the just-fixed
field (gold) was confirmed, and the party (which comes from the obfuscated `HeroRuntime`, via
[[invariants/party-live-resolution]]) was broken and slipped through unnoticed. **Partial validation is not
validation.**

## The rule

`scripts/validate_live.py` is the MANDATORY gate in [[guides/game-update]]: it resolves via the **bundled
seed** (the same path as the RC/stable's 1st launch) and requires **PASS on ALL** key metrics live,
not just the one that changed. Every mutable-per-build surface that the run record uses has a check with
PASS/FAIL + detail: `calib/seed`, `gold`, `party-live`, `hero-class` (EEquipClassType, not EHeroType),
`save-build` (pick_live_psd+read_gold+read_heroes — the path that broke in 1.00.12), `build-record`
(the `read_build` that the run RECORDS: gear/skills via ATTRIBUTES/ITEMS/EQUIPPED_* + `read_account_snapshot`
runes/inventory/stash), `xp-live`, `party-slots` (read_party_slots == the raw HeroList indices — the
formation position 0/1/2 the run record emits), `dps` (MonsterSpawnManager+HP), `stats` (StatsHolder.FINAL_STATS),
`stage`, `run-cycle` (LogManager.LOG_LIST readable — the run-close boundary) and `catalogs`. A non-zero
exit = DO NOT ship. Run it with the game IN COMBAT on a stage (almost every check needs the party
deployed). The OBFUSCATED/HP-only surfaces (gold, party/xp from `HeroRuntime`, `StatsHolder`, monsters) can only be measured
HERE — the static diff doesn't verify them.

## Immunity is in layers, not perfection

You can't be immune to a closed binary changing bytes. You can be immune to SHOWING GARBAGE unknowingly:
1. **Resolve by STRUCTURE + sanity gate** — [[invariants/gold-singleton-resolution]] (gold by
   name-free structure) and [[invariants/rva-index-resolution]] (index + round-trip) prevent READING garbage.
2. **Degrade honestly** — [[invariants/party-live-resolution]] prevents SHOWING garbage (never the roster).
3. **This gate** — turns "silent bug discovered while playing" into "visible FAIL before ship".

## Related
- [[guides/game-update]] — the playbook that invokes this gate as a mandatory validation step
- [[invariants/party-live-resolution]] — the honest degradation that the gate confirms
- [[invariants/gold-singleton-resolution]] — the obfuscated gold that the gate confirms live
