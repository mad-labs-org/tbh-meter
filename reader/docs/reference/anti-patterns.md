---
type: reference
description: "Grep-able checklist of anti-patterns (smells) for sweeping a reader DIFF during review — each line points to the invariant note the smell violates. The drift-test validates the docs; THIS is what catches the wrong code in a diff."
code_anchors:
  - config/offsets.py
  - metrics/gold.py
  - meter_windows.py
  - shared/memory.py
---

# Anti-patterns (diff review checklist)

This is a **smell index**, not a re-explanation: each line is a pattern that, if it shows up
in a reader diff, is probably a bug — linked to the note that explains why. Sweep the diff
against this list before opening the PR. (The truth and the detail live in the linked notes; here it's just
the "this smells bad" trigger.)

| smell in the diff | why it's wrong | note |
|---|---|---|
| `find_class_by_name("xx")` / `next(iter(classes["xx"]))` with a 2-letter name | obfuscated name DRIFTS per build → wrong class | [[invariants/gold-singleton-resolution]] |
| index/RVA used without the round-trip gate (`class_name == name`) | poisoned index serves the wrong class | [[invariants/rva-index-resolution]] |
| loose offset literal in the logic (`reader.ri32(addr + LITERAL)`) | offset outside the bible → invisible drift | [[invariants/offsets-single-source]] |
| business rule (which subkey means what) inside `offsets.py` | offsets.py is structure only; the rule lives in the module | [[invariants/offsets-single-source]] |
| `DictFloat.STRIDE` on an aggregate dict (or `Dict8B` on the 64 stats) | swapped stride → SILENT corruption (gold 1.97T) | [[invariants/dict-strides]] |
| `gold = wallet_end - wallet_start` | the wallet includes selling/idle → over-counts | [[invariants/metric-fallback-chains]] |
| `xp = heroes_end[k] - heroes_start[k]` (raw delta from the save) | the save lags → 0 or 2x on autosave | [[invariants/metric-fallback-chains]] |
| `return gain or 0` after `run_gain()` | conflates None (read failure) with 0 (valid zero gain) | [[invariants/metric-fallback-chains]] |
| `if gold == 0: mark_partial` | hides COMPLETE runs when the live read fails | [[invariants/run-lifecycle]] |
| `partial = total_damage == 0` (instead of `<= 0`) | reopens #163 (x-10 recorded with all-zeros) | [[invariants/run-lifecycle]] |
| skip by `EStageType.ACTBOSS` instead of `stage != 10` (StageNo) | different signals → discards a legit x-10 | [[invariants/run-lifecycle]] |
| new run field set only in `close_run` (not in `new_run`) | leaks the previous run's value | [[invariants/run-lifecycle]] |
| reading the Unit's 12 core stats at runtime (`CORE_STATS_OBSCURED`) | ObscuredFloat (XOR) → garbage; use FLAT `FINAL_STATS` | [[invariants/obscured-data-offlimits]] |
| `EHeroType` for hero class identity | orphan enum; use `EEquipClassType` | [[invariants/obscured-data-offlimits]] |
| `ELogType` read as a field of the log entry | it was stripped from IL2CPP; detect by klass-pointer | [[invariants/log-event-detection]] |
| inline memory read in `meter_windows.py` (outside the scaffolding) | the orchestrator has to stay thin | [[invariants/orchestration-purity]] |
| `WriteProcessMemory` / any write to the game's memory | the reader is READ-ONLY (anti-cheat) | [[invariants/memory-safety]] |
| pointer deref without a null-guard / arithmetic on a `ri32` that can be None | crash on a corrupted read | [[invariants/memory-safety]] |
| a `raw/<id>.json` field changed SHAPE without bumping `RAW_SCHEMA_VERSION` + dispatch in the converter (an additive one the converter ignores does NOT bump; `SCHEMA_VERSION`=11 is FROZEN legacy — never bump it) | converter blind to the field / migration milestone broken | [[invariants/schema-versioning]] |
| bumping `CACHE_FMT` without re-capturing `config/calib_seed.json` | RC won't build (selftest) + cold scan at runtime | [[invariants/cache-management]] |
| raising a new value "because it looks right", with no oracle | that's how gold 0 and 1.97T shipped | [[process/value-mapping-method]] |
| `cands[:N]` / fixed cap when sweeping instances (`pick_live_sm`) | the instance count grows per build → misses the carrier (1.00.11: 1162 > 600) | [[invariants/party-live-resolution]] |
| `pick_live_sm` accepting an instance on a WEAKER check than `read_live_party` (only `heroKey`, no `level/exp`) | picks a 'ghost' StageManager (torn-down/template: hk ok, lvl=0) before the carrier → `read_live_party` reads {} → party off for the whole session (1.00.13: "StageManager ok — 0 heroes deployed"). pick and read MUST agree | [[invariants/party-live-resolution]] |
| party/heroes = roster from the save when the live one fails (no `live_keys`/`hero_in_run` filter) | shows unplayed heroes (+0xp); the save is roster, not party | [[invariants/party-live-resolution]] |
| validating only the field you fixed after an update | the obfuscated ones (party/xp/gold) pass through broken; run `validate_live.py` | [[process/live-validation-gate]] |

## Related
- [[invariants/offsets-single-source]] · [[invariants/dict-strides]] · [[invariants/metric-fallback-chains]] · [[invariants/run-lifecycle]] — the most-triggered in a diff review
