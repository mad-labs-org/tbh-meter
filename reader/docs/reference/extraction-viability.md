---
type: reference
description: "Read-only viability matrix by domain (composition/mode/gold/xp/stats/equip/skills/aggregates): what is VIABLE/PARTIAL/UNVIABLE and why — PLAIN (reads direct) vs Obscured (ACTk, gives garbage). What the reader extracts TODAY, not what the spec planned."
symptoms:
  - "can we extract X?"
  - "can we extract"
  - "why no per-hero DPS"
  - "no per-hero damage"
  - "per-hero damage"
  - "stat obscured garbage"
  - "ObscuredFloat XOR"
  - "runes pets in runs.jsonl"
  - "skill level"
  - "hero name i18n"
code_anchors:
  - game/save.py::read_gold
  - game/build.py::read_build
  - game/build.py::read_account_snapshot
  - game/models.py::live_monsters
  - config/offsets.py::Unit.CORE_STATS_OBSCURED
asserts:
  - config.offsets.GOLD_KEY == 100001
  - config.offsets.DictFloat.STRIDE == 0x10
  - config.offsets.Unit.CORE_STATS_OBSCURED == 0x104
---

# Extraction viability matrix (read-only)

What the reader **can read** from the game's memory, by domain, and **why**. There's a single
dividing line:

- **PLAIN** — plain-text field; reads direct (`ri32`/`ri64`/`rf32` or a normal Dict). It's the
  basis of nearly everything the reader extracts.
- **Obscured (ACTk)** — the real value is NOT the field: `hidden ^ key` on the current build gives
  **garbage** (the real one is a PLAIN `fakeValue` at a neighboring offset, when it exists). Reading
  the raw Obscured field is a class of bug — see [[invariants/obscured-data-offlimits]]. That's why
  every number the reader emits comes from a PLAIN source, never from a XOR.

> This note is the MAP (what works / what doesn't). The **`runs.jsonl` field map** (exact shape of
> each key) is another note; the **damage model** (why DPS is only team HP-delta) is another. Here
> it's just viability + the PLAIN/Obscured reason.

## The matrix

| Domain | Viable? | Source the reader uses | PLAIN/Obsc |
|---|---|---|---|
| **Composition** (party + class) | ✅ viable | live `StageManager.HERO_LIST` (Hero[]) → `Unit.CACHE`(uf) → `HeroRuntime.INFO` → `HeroInfoData.HERO_KEY`/`CLASS_TYPE` | PLAIN |
| **Mode / difficulty** | ✅ viable | `StageInfoData.DIFFICULTY` catalog (and `STAGE_TYPE`), matched by the live stageKey | PLAIN |
| **XP** (live level + exp) | ✅ viable | `HeroRuntime.LEVEL_FAKE`/`EXP_FAKE` (= ACTk **fakeValue**, is PLAIN) | PLAIN |
| **Per-hero stats** (64 final) | ✅ viable | `HeroRuntime.STATS_HOLDER`(xd) → `StatsHolder.FINAL_STATS` = `Dict<StatType,float>` (DictFloat) | PLAIN |
| **Aggregates/stage** (total GoldEarn, waves) | ✅ viable | `AggregateManager.AGGREGATES` (Dict8B) + `StageInfoData` waves | PLAIN |
| **Gold per run** | 🟡 partial | live combat = `AggregateManager.AGGREGATES`[GoldEarn][SubKey1]; SAVE = fallback | PLAIN¹ |
| **Equipment** | 🟡 partial | record (slot/rarity/base-level/uniqueId/persisted enchants) via `ItemSaveData` + `ItemInfoData` catalog | PLAIN² |
| **Skills** (equipped + passive + level) | 🟡 partial | `HeroSaveData.EQUIPPED_SKILLS` + `AttributeSaveData` (invested tree) | PLAIN³ |
| **Per-hero DPS** | ❌ unviable | — (the game doesn't store per-unit damage; only TEAM HP-delta) | n/a |
| **Damage/stat per attribute** | ❌ unviable | — (not in memory; see damage model) | n/a |
| **Account snapshot** (runes + inventory + stash) | ✅ viable | `PlayerSaveData.RUNES` (`RuneSaveData.KEY`/`LEVEL`) + `PlayerSaveData.INVENTORY_SLOTS`/`STASH` (`UNIQUE_ID` → join on `PlayerSaveData.ITEMS`), read once at close by `game/build.py::read_account_snapshot` | PLAIN |
| **Pets** | ❌ not-extracted | — (account-wide, doesn't change per run; **no symbol in the current code**) | — |
| **Readable name** (hero/skill/item) | ❌ unviable | — (memory only has the i18n key; the string-table is another subsystem) | n/a |

¹ **Live gold is PLAIN** — the reader does NOT read the gold-runtime `ObscuredLong`. It reads the
cumulative aggregate `GoldEarn[SubKey1]` (combat), which is a flat `long`. The hard part here was
never crypto: it was **finding the singleton** (`AggregateManager`, obfuscated name that drifts)
without the name — see the Gold section below. "Partial" = depends on the source (exact live vs save
in jumps), not on XOR.

² **Equip is partial because of what is NOT read**: rarity, slot, type, base-level and the
**persisted** enchants (`ItemEnchant` struct: stat/recipe/value/tier) are **100% PLAIN** and the
reader emits them all. What's left out is the item's **live instance** (live-level + rolled mods),
whose fields are `ObscuredInt` on the gear-runtime class → reading gives garbage → the reader
**doesn't touch** them.

³ **Skill is partial due to the level GAP in the obvious source**: the equipped skill
(`EQUIPPED_SKILLS`, int[]) and the static info are PLAIN, but the **level** doesn't live in
`HeroSaveData` — it comes from the invested tree (`AttributeSaveData.LEVEL`, account-wide), linked
by a skillKey→attributeKey map generated offline. The skill's runtime cache is Obscured → the reader
enters via the PLAIN tree, not via it.

## Why the three ❌ are hard (it's not "nobody tried")

- **DPS / per-hero damage** — the game **does not persist per-unit damage** anywhere readable. The
  tooltip number (`m_DPS`) is a **UI string** (TextMeshPro), not a numeric field. The only read-only
  way out is the meter itself: Σ of the monsters' HP drops (HP is a PURE float in
  `UnitHealthController.HP_CURRENT`/`HP_MAX`) — that gives **TEAM DPS**, without decomposing per
  hero. See [[reference/damage-model]].
- **Readable name** — hero/skill/item carry only `NameKey` (i18n key). Resolving to text requires the
  game's string-table, which is another subsystem outside the offset map. The reader emits the **id**
  and lets the front-end resolve the name.
- **Individual "core" stats** of `Unit` (the 12 `ObscuredFloat` in `Unit.CORE_STATS_OBSCURED`) — the
  index→StatType mapping isn't recoverable from the dump alone AND the fields are Obscured. Not
  needed: `FINAL_STATS` already delivers all 64 by `StatType` in PLAIN.

## Gold: the "partial" isn't crypto, it's singleton resolution

Gold per run comes from the cumulative **combat** aggregate (`GoldEarn[SubKey1]`), which is PLAIN.
The SubKeys are NOT parallel sources: SubKey 1 = combat (what the run wants), SubKey 0 = TOTAL
(rollup that includes **selling** → don't use), 2/3 = noise. The obstacle is that the owner of that
Dict is a singleton with an **obfuscated name that changes between builds** — so it's resolved by
INDEX (TypeDefIndex/RVA, the primary today) with a structural scan fallback, **never by name**.
Detail and fallback in [[invariants/gold-singleton-resolution]] and
[[invariants/metric-fallback-chains]].

## How to read this matrix in practice

- About to **map a new value**? Start by asking "is it PLAIN?". If the obvious source is Obscured,
  look for the `fakeValue`/an equivalent PLAIN source — don't try XOR (the build doesn't use
  hidden^key).
- "✅ viable" here means **the reader already extracts it** (there's a function in `game/` or
  `metrics/`). "🟡 partial" = extracts a SUBSET (the column explains which part is left out and why).
- The save (`PlayerSaveData`) is a **stale snapshot**: great for record/identity and as a fallback,
  bad for the live number (live gold/xp come from the runtime world, not the save).

## Related
- [[invariants/obscured-data-offlimits]]
- [[invariants/gold-singleton-resolution]]
- [[invariants/metric-fallback-chains]]
See also: [[reference/run-data-map]] (exact shape of each runs.jsonl field) · [[reference/damage-model]] (DPS = team HP-delta, no per-hero) · [[process/value-mapping-method]] (how to find a PLAIN source) · [[guides/map-new-value]]
