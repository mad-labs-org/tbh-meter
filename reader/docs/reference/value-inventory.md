---
type: reference
description: "Inventory of what the reader READS from game memory, classified by SOURCE: LIVE (real-time, preferred) vs SAVE (stale snapshot, fallback only) vs TODO (to be mapped). Each value points to the module/symbol that reads it — where to touch and what NOT to confuse."
code_anchors:
  - metrics/gold.py
  - metrics/xp.py
  - game/build.py
  - metrics/dps.py
  - game/save.py
guarded_by:
  - tests/test_gold.py::TestCombatGoldSave::test_ignores_total_subkey_zero
  - tests/test_gold.py::TestRunGain::test_non_monotonic_returns_none
---

# Inventory of values the reader reads

Catalog of what the meter extracts from memory, classified by **SOURCE** — because the source
decides whether the number is trustworthy per run. Mirrors `docs/value-mapping-plan.md` §3 (the
"inventory"), but re-derived from the code: each row points to the module/symbol that reads the
value. **The truth is the code** (the modules in `metrics/` + `game/`); this note is the index.

Three layers, in order of preference:

- **LIVE** — read from the live instance every tick. Real-time, exact, zero-lag. **Primary source.**
- **SAVE** — read from `PlayerSaveData`/`CommonSaveData` (plaintext, snapshot). Updates in
  **jumps** (only on save-write, ~every 100s). Good for identity/profile; **junk for per-run
  delta** → fallback only.
- **TODO** — not yet mapped; find it with the methodology in section 2 of value-mapping-plan.

## Live (real-time — preferred source)

| Value | Module / reader | How it arrives |
|---|---|---|
| **COMBAT gold per run** | `metrics/gold.py::combat_gold_live` | AggregateManager (singleton, resolved by structure) → `AGGREGATES[GoldEarn][COMBAT_SUBKEY]`. Cumulative; the run delta = `run_gain(start, end)`. |
| **Live XP / hero** | `game/build.py::read_live_party` · `metrics/xp.py::PartyXpAccumulator` | HeroRuntime of the deployed hero (`EXP_FAKE`, within-level), ACCUMULATED tick-by-tick per heroKey (first sighting seeds the baseline); the curve (`metrics/xp.py::curve`) fills the level-up. |
| **Live level / hero** | `game/build.py::read_live_party` | HeroRuntime `LEVEL_FAKE`. |
| **XP of who DIED / joined late** | `metrics/xp.py::PartyXpAccumulator` | the accumulated total is **banked** when the hero disappears from the HeroList (dead adds 0 while dead); a late deploy is credited from first sighting. (Replaced the re-read of the `uf` captured at the start.) |
| **Damage / DPS** | `metrics/dps.py::DpsTracker` | Σ of monster HP drop per tick + the final blow of whoever vanished from the list. It is TEAM total (there is no per-hero — see [[reference/damage-model]]). |
| **64 FINAL stats / hero** | `game/build.py::read_live_stats_by_hero` | HeroRuntime → StatsHolder `FINAL_STATS` (DictFloat). id-only `{statId: value}`. |
| **Mobs alive / dead** | `metrics/progress.py::ProgressTracker` | MonsterSpawnManager `MONSTER_LIST` / `DEAD_MONSTER_LIST` (kills/min; resets on stage reload). |
| **Event count** | `metrics/events.py::EventFeed` | delta of the LogManager's `LOG_LIST` (today it only COUNTS new entries — the type of each event is TODO; see table below). |

> Note on live gold: `combat_gold_live` reads the **`COMBAT_SUBKEY`** (combat) — NOT the
> `TOTAL_SUBKEY` (rollup that includes sales/idle). Confusing the two counts sales into the run's
> gold. The reader also guards against an implausible value (rejects `0` and absurd petabyte-range
> values — the origin of the historical gold-0 and 1.97T bugs). Detail and the LIVE→SAVE chain in
> [[invariants/metric-fallback-chains]]; how the obfuscated singleton is found in
> [[invariants/gold-singleton-resolution]].

## Save (stale snapshot — fallback only)

| Value | Module / reader | Why it is fallback only |
|---|---|---|
| **Combat gold (fallback)** | `metrics/gold.py::combat_gold_save` | same number as live, but from `PlayerSaveData` (AggregateSaveData Type=GoldEarn, `COMBAT_SUBKEY`). Updates in jumps → per-run delta unreliable (0 if the run lands between writes; ~2× if one write captures two runs). |
| **Wallet (balance)** | `game/save.py::read_gold` | CurrencySaveData `Key==GOLD_KEY`. Also from the save (stale). **Never** use the wallet delta for the run's gold — it includes sales/idle (the regression that `run_gain==None` prevents). |
| **Hero build** | `game/build.py::read_build` | class/level/exp + equipped items (rarity/level/mods/enchants) + invested skills/passives. Identity/profile — slow to change, the save serves. |
| **Account snapshot (runes / inventory / stash)** | `game/build.py::read_account_snapshot` | ACCOUNT-WIDE state at close — profile, not metric: here there is no per-run delta for the save's lag to corrupt (no "live" mirror was mapped, nor was one missed). Runes (`PlayerSaveData.RUNES`) + inventory/stash items (`INVENTORY_SLOTS`/`STASH` → join on `ITEMS`). Goes to the raw in an ok/err envelope: NOT-READ → `None` → `err`, never a silent `ok([])`. |
| **playTime / current stage** | `game/save.py::pick_live_csd` | CommonSaveData — picks the REAL save among the type scan's candidates (incl. false positives): requires a sane playTime, prefers an in-catalog `currentStageKey`, then highest playTime. The snapshot `currentStageKey` is a STALE fallback seed; the live stage is `Monster.STAGE_KEY` (`game/models.py::live_stage_key`). |

## ⚪ TODO / future (find with the methodology in section 2 of value-mapping-plan)

| Value | Expected path |
|---|---|
| **Other live `EAggregateType`** (MonsterKill, BoxObtain, ItemObtain, PlayTime, StageClear, StageFail) | same AggregateManager (singleton ALREADY resolved), another outer key — just read another `EAggregateType`. |
| **Gold by SOURCE** (sale / idle / quest) | `GoldEarn[SubKey2/3]` (split from combat; today only `COMBAT_SUBKEY`/`TOTAL_SUBKEY` mapped). |
| **Drops per run** (items / boxes obtained) | via the LogManager's `LOG_LIST` (label the event type). |
| **Non-gold resources** (gems etc.) | other `CurrencySaveData.Key` (map the Keys beyond `GOLD_KEY`). |

## How to read this table when touching it

- **Adding a new LIVE value** → follow the value-mapping-plan §2/§4 methodology (oracle →
  structure → validate over N runs → persist → synthetic test) and the [[guides/map-new-value]] guide.
  The offset symbol lives in `config/offsets.py`, the business rule (which SubKey/key means what)
  lives in the logic module — never duplicate the literal (see [[invariants/offsets-single-source]]).
- **Where the source degrades** (live unavailable → save): the order is fixed and the save is the
  LAST resort; wallet/total NEVER enter. See [[invariants/metric-fallback-chains]].
- The orchestrator (`meter_windows.py`) only **calls** these readers; it does not read memory inline.
  A new value enters the run record via [[guides/add-runs-field]] (+ schema bump,
  [[invariants/schema-versioning]]).

## Related
- [[invariants/metric-fallback-chains]] — the LIVE→SAVE→never-wallet order and `run_gain==None` on non-monotonic
- [[invariants/gold-singleton-resolution]] — how the AggregateManager (live gold) is found without depending on the obfuscated name
- [[reference/run-data-map]] — the field-by-field map of the run record that consumes these values
- [[reference/damage-model]] — why damage is TEAM total and not per-hero
- [[reference/extraction-viability]] — what can and what CANNOT be extracted (why several TODOs stay TODO)
- [[guides/map-new-value]] — the step-by-step to promote a TODO to LIVE
