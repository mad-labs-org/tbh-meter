---
type: reference
description: "What the reader READS per run today (during the tick + at close): each datum mapped to the SYMBOL in config/offsets.py and the module that reads it. The un-read RE (debuffs, drop tables, missing catalogs) lives in the old docs/run-data-map.md snapshot, not here."
symptoms:
  - "what the reader reads per run"
  - "where gold/xp/dps comes from"
  - "which runs.jsonl field"
  - "where the reader reads the heroes"
  - "which offset feeds the overlay"
code_anchors:
  - config/offsets.py
  - meter_windows.py::close_run
  - game/models.py::live_monsters
  - game/save.py::read_gold
  - game/build.py::read_build
  - game/build.py::read_account_snapshot
  - metrics/dps.py::DpsTracker
  - metrics/progress.py::ProgressTracker
  - metrics/gold.py::combat_gold_live
  - metrics/xp.py::per_hero_gain
asserts:
  - meter_windows.SCHEMA_VERSION == 11
  - metrics.gold.COMBAT_SUBKEY == 1
  - config.offsets.EAggregateType.GoldEarn == 2
---

# Run data map (what the reader READS today)

This is the **READ subset** of the raw RE map: only the data the reader extracts per run today —
during the tick (10Hz / 1Hz) and at close (`close_run`). Each row cites the **symbol in
`config/offsets.py`** (the bible; never the raw literal) and the **module that does the read**. The
truth is the code: if a number here looks wrong, the offset lives in `offsets.py` and the read in
the cited module.

The **un-read** RE (the unit's state/attackState, elemental buffs/debuffs, per-element damage,
the 12 Obscured core stats, drop tables, unused monster/stage catalogs, raw wallets) **does not
belong here**. It lives in the raw snapshot — the old `docs/run-data-map.md` (the full 9-agent table
over the dump), bound for `archive/`. That one is "what CAN be read"; this is "what the reader
reads" — the full index of what can and can't be read is [[reference/value-inventory]].

---

## DURING the run (read in the loop)

| Datum | Symbol (offsets.py) | Module that reads it | Notes |
|---|---|---|---|
| Current/max HP of each live mob + summoned | `UnitHealthController.HP_CURRENT` / `HP_MAX`, via `Unit.HEALTH_CONTROLLER` and `MonsterSpawnManager.MONSTER_LIST` / `SUMMONED_LIST` | `game/models.py::live_monsters` | PURE float. Heart of the meter: damage = Σ HP drop between ticks |
| DPS / total damage / final blow on the mob | (derived from HP above) | `metrics/dps.py::DpsTracker` | 5s window; a mob that vanishes from the list = final blow for the HP it had left. `total_damage` + `dps` go into the record |
| Number of mobs killed (for kills) | `MonsterSpawnManager.DEAD_MONSTER_LIST` → `List.SIZE` | `metrics/progress.py::ProgressTracker`, and the loop for `R["mobs"]` | cumulative delta = kills; drops on a reload of the SAME stage (signal of an abandoned run) |
| LIVE stageKey | `Monster.STAGE_KEY` (mode of the first reads) | `game/models.py::live_stage_key` | preferred over `CommonSaveData.CURRENT_STAGE_KEY` (the save's freezes on the swap) |
| LIVE cumulative COMBAT gold | `AggregateManager.AGGREGATES` → `EAggregateType.GoldEarn` → SubKey 1 (`Dict8B` geometry) | `metrics/gold.py::combat_gold_live` | PRIMARY. Baseline at `new_run`, delta at close. `COMBAT_SUBKEY=1` is a business rule (lives in gold.py, not in offsets) |
| LIVE within-level XP per hero + level | `HeroRuntime.EXP_FAKE` / `LEVEL_FAKE` (FLAT fakeValue), via `StageManager.HERO_LIST` → `Unit.CACHE` | `game/build.py::read_live_party` → `metrics/xp.py::PartyXpAccumulator` | ACTk fakeValue (FLAT, not the XOR). ACCUMULATED tick-by-tick per heroKey (first sighting seeds the baseline; level-up via the curve); death/dropout keep the banked value |
| Identity of the deployed hero (heroKey) | `HeroInfoData.HERO_KEY`, via `HeroRuntime.INFO` | `game/build.py::read_live_party` | `party_seen` accumulates who was seen in the field (covers `sm` that resolves late) |
| New events this tick (which log) | `LogManager.LOG_LIST` → `List.SIZE`/`List.ITEMS`; type via the entry's `Obj.KLASS` | the `meter_windows.py` loop | classifies by class-pointer (ELogType is not a readable field) |
| StageClear: act / stage / clear_time | `StageClearLog.ACT` / `STAGE` / `CLEAR_TIME` | `meter_windows.py::close_run` | triggers a "success" close; `CLEAR_TIME` = official duration in seconds |
| StageFailed: act / stage / current wave / total | `StageFailedLog.ACT` / `STAGE` / `NOW_WAVE` / `TOTAL_WAVE` | `meter_windows.py::close_run` | triggers a "fail" close; reveals how far the run got |
| Chest drop (tier) | `GetBoxLog.MONSTER_TYPE` (`EMonsterLogType`) → `BOX_KEY_BY_TIER` | the `meter_windows.py` loop | `GetBoxLog.BOX_KEY` is the TYPE ("TreasureChest_…"), NOT an item key; the authoritative tier is `MONSTER_TYPE`. Gray (mob) accumulates in `R["drops"]`; the boss box (logged ~0.6s AFTER the clear) is absorbed into the PENDING success record — see [[invariants/run-lifecycle]] |
| Hero death: victim + killer | `HeroDieLog.VICTIM_HERO` / `KILLER_MONSTER` (strings "Name_<key>") | the `meter_windows.py` loop | LIVE-CRACKED: victim and killer were SWAPPED in the old RE. Counts `deaths`/`killers` per heroKey |
| Hero revive | `ResurrectionLog.HERO` (string "Name_<key>") | the `meter_windows.py` loop | counts `revives` per heroKey |

---

## AT CLOSE (close_run) — save snapshot sources

Read once in `close_run` (and baselined at `new_run`), via the LIVE `PlayerSaveData` instance
chosen by HIGHEST gold (`game/save.py::pick_live_psd`):

| Datum | Symbol (offsets.py) | Module that reads it | Notes |
|---|---|---|---|
| Gold balance (fallback for gold-per-run) | `CurrencySaveData.KEY` (== `GOLD_KEY`) / `QUANTITY`, via `PlayerSaveData.CURRENCIES` | `game/save.py::read_gold` | baseline + fallback only. The real gold-per-run is the LIVE delta above |
| Cumulative combat gold from the SAVE (fallback) | `PlayerSaveData.AGGREGATES` → `AggregateSaveData.TYPE`==`GoldEarn` & `SUB_KEY`==1 → `VALUE` | `metrics/gold.py::combat_gold_save` | on-disk mirror of the live one; updates in JUMPS → fallback only when the live one doesn't resolve |
| XP/level per hero from the save (fallback) | `HeroSaveData.HERO_KEY` / `LEVEL` / `EXP`, via `PlayerSaveData.HEROES` | `game/save.py::read_heroes` | `EXP` resets on level-up (lagging); used only if the live XP didn't run |
| Per-run XP (live accumulator, curve-handled) | (derived from the live/save XP above) | `metrics/xp.py::PartyXpAccumulator` (level-up bridge via `per_hero_gain`) | level-up "wraps around" via the curve (`config/level_curve.json`); dead/late-deploy keep the accumulated banked value (no re-read of `uf`) |
| Per-hero build: class / level / exp | `HeroSaveData.LEVEL`/`EXP` + `HeroInfoData.CLASS_TYPE` (catalog `hero_cat`) | `game/build.py::read_build` | only the heroes REALLY deployed (filtered by `live_keys`) |
| Equipped items + rarity/slot/level | `HeroSaveData.EQUIPPED_ITEMS` → `ItemSaveData.ITEM_KEY`/`UNIQUE_ID` → `ItemInfoData.GRADE`/`PARTS`/`LEVEL` | `game/build.py::read_build` | catalog `item_cat` keyed by itemKey; matched by `UNIQUE_ID`. A handle absent from `itemSaveDatas` (unresolvable) is surfaced as `itemKey == UNKNOWN_ITEM_KEY` (-1), slot from the array position — NOT dropped (NOT-READ != READ-ZERO); the front shows it as "unknown" |
| Rolled item mods (enchants/decoration/…) | `ItemSaveData.ENCHANT_DATA` → `ItemEnchant.STAT_TYPE`/`VALUE`/`TIER`/`RECIPE` (PLAIN struct, `STRIDE`) | `game/build.py::read_mods` | the SAVE version is PLAIN; the runtime mirror (`te`) is Obscured → prefer the save |
| Equipped skills + levels (actives + passives) | `HeroSaveData.EQUIPPED_SKILLS` + `PlayerSaveData.ATTRIBUTES` → `AttributeSaveData.KEY`/`LEVEL` | `game/build.py::read_build` / `read_attribute_levels` | the skill level comes from the tree node (`attributeKey`); passives live only in the tree |
| Account snapshot: runes + inventory + stash | `PlayerSaveData.RUNES` → `RuneSaveData.KEY`/`LEVEL`; `PlayerSaveData.INVENTORY_SLOTS`/`STASH` → `InventorySaveData.UNIQUE_ID`/`StashSaveData.UNIQUE_ID` → join on `PlayerSaveData.ITEMS` | `game/build.py::read_account_snapshot` | account-wide, once at close; goes into the raw in an ok/err envelope (UN-READ → `err`; `[]` = genuinely empty). Items id-only; the wiki derives real drop-rate / wave correction |
| 64 LIVE FINAL stats per hero | `StatsHolder.FINAL_STATS` (`Dict<StatType,float>`, `DictFloat` geometry), via `HeroRuntime.STATS_HOLDER` | `game/build.py::read_live_stats_by_hero` | id-only (statId→value); the front resolves the name. The 12 Obscured core stats are NOT read |

The final record assembled by `close_run` is the **`raw/<id>.json`** (stamped with `RAW_SCHEMA_VERSION`;
data field in an ok/err envelope, raw meta, `id` = end time in ms) — `status`/`stage`/`mode`/
`dps`/`partial` are DERIVED by the app's converter, they don't come out of the reader. The shape and the
bump recipe are a separate invariant (see Related).

---

**Notes.**
- `EAggregateType.GoldEarn == 2` and `COMBAT_SUBKEY == 1` are the key to gold-per-run; swapping the
  `Dict8B` geometry (8B value) for `DictFloat` (4B value) when walking AGGREGATES corrupts the gold
  silently (see Related).
- Per-hit DAMAGE/CRIT/ELEMENT are NOT read (transient / Obscured); the meter derives them only as
  HP drop. The modeling of what can/can't be read is in the Related references.

## Related
- [[invariants/dict-strides]] — `DictFloat` (4B, stats gold) vs `Dict8B` (8B, cumulative gold): which to use for each Dict in this map
- [[invariants/gold-singleton-resolution]] — how `AggregateManager.AGGREGATES` is reached (obfuscated singleton resolved by structure)
- [[invariants/metric-fallback-chains]] — the LIVE→SAVE gold/xp chain these rows feed
- [[invariants/schema-versioning]] — the shape of the record `close_run` serializes, and how to bump it
- [[invariants/log-event-detection]] — how the `*Log` (StageClear/Fail/GetBox/HeroDie/Resurrection) become close/drop/death
See also: [[reference/damage-model]] (the stats fold / why damage isn't read) · [[reference/extraction-viability]] + [[reference/value-inventory]] (the un-read raw RE, destination of the old run-data-map) · [[invariants/obscured-data-offlimits]] (Obscured core stats / te / wallets that are NOT read)
