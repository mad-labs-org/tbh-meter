---
type: reference
description: "Damage-system enums and structs that LIVE in config/offsets.py — modifiers (MODTYPE/MODSOURCE/StatModifier), hit attribute/type (EDamageAttribute/EDamageType/DamageInfo) and class (EEquipClassType). A STRUCTURE catalog, not the math: the reader doesn't run the formula."
code_anchors:
  - config/offsets.py::MODTYPE
  - config/offsets.py::MODSOURCE
  - config/offsets.py::StatModifier
  - config/offsets.py::EDamageAttribute
  - config/offsets.py::EDamageType
  - config/offsets.py::DamageInfo
  - config/offsets.py::EEquipClassType
  - config/offsets.py::StatType
  - config/offsets.py::StatsHolder
asserts:
  - config.offsets.MODTYPE.FLAT == 0
  - config.offsets.MODTYPE.MULTIPLICATIVE == 2
  - config.offsets.EDamageAttribute.Physical == 0
  - config.offsets.EDamageType.Projectile == 2
  - config.offsets.EEquipClassType.Ranger == 2
  - config.offsets.StatType.IncreaseProjectileDamage == 53
guarded_by:
  - tests/test_offsets.py::TestEEquipClassType::test_ranger_is_2
---

# Damage model — enums and structs (in `offsets.py`)

This note is the **testable** part of the damage model: the enums and structs that exist as a
SYMBOL in `config/offsets.py` (the bible). It's a **structure catalog**, not arithmetic —
the reader **does not compute damage**. Most of these symbols (`MODTYPE`, `MODSOURCE`,
`StatModifier`, `DamageInfo`, `EDamageType`) have **no live consumer** in the reader today: they're
RE facts documenting HOW the game combines stats, useful to anyone mapping a damage value
or explaining a build on the front end. `EDamageAttribute`, `EEquipClassType` and `StatType` are
the ones actually re-exported/read (`game/enums.py`, `game/build.py`).

> The **exact formula** (bracketing/fold) and the **RVAs + disassembly** that proved it do NOT go
> here: they aren't testable against `offsets.py` (they rotate per build, they're raw RE). They live in
> the `archive/damage-model` snapshot.
> <!-- create when migrating the raw RE: archive/damage-model (formula + RVAs gbm@…, capstone) -->

## Modifier system

Each final stat is the fold of a LIST of modifiers. The modifier's geometry is the
`StatModifier` struct (`up` in the dump): fields `STAT_TYPE`, `MOD_TYPE`, `VALUE` (float), `MOD_SOURCE`.

- **`MODTYPE`** classifies how the modifier enters the fold: `FLAT` (0), `ADDITIVE` (1),
  `MULTIPLICATIVE` (2). The ORDER of the values is load-bearing — the fold branches on this enum
  (flat adds to the base; additives sum into a single bucket → **diminishing returns** when stacked;
  multiplicatives are a separate product, **they don't diminish each other**).
- **`MODSOURCE`** says WHERE it came from (`BASE`, `ITEM`, `ATTRIBUTE`, `PASSIVE`, `AccountStatus`,
  `StatusEffect`, `BuffSkill`, `ENVIRONMENT`) — it's provenance metadata, it doesn't change the math.

The already-folded FINAL stat is NOT reconstructed from this list in the reader: it's read ready-made from
`StatsHolder.FINAL_STATS` (`Dict<StatType,float>`; see [[invariants/obscured-data-offlimits]] —
the core stats in `Unit.CORE_STATS_OBSCURED` are XOR garbage, do NOT read them). `StatsHolder.MODIFIER_MGR`
is the raw mod list (rarely needed).

## Hit attribute and type

- **`EDamageAttribute`** (the damage's element): `Physical` (0), `Fire`, `Cold`, `Lightning`,
  `Chaos`, `AllElement`, `NONE` (6). Note: the "none" member is called **`NONE`** (uppercase)
  — `None` is a reserved word in Python.
- **`EDamageType`** is an **`IntFlag`** (OR-combinable): `NONE` (0), `Melee` (1),
  `Projectile` (2), `AOE` (4), `Summon` (8), `DOT` (16), `Trap` (32). Being flags, the values are
  powers of 2 — a hit can be `Melee|AOE`.
- **`DamageInfo`** is the hit's transient struct (fields `ATTACKER`, `ORIGIN_DAMAGE`,
  `IS_CRITICAL`, `DAMAGE_ATTRIBUTE` = `EDamageAttribute`, `DAMAGE_TYPE` = `EDamageType`,
  `HIT_EFFECTS`). It's ephemeral — delivered per hit and discarded; the reader does not persist it.

Attribute and type are **independent layers**: `PhysicalDamagePercent` (`StatType` 24) is gated
to the Physical attribute and is **additive** within the bucket (stacking gives diminishing returns);
`IncreaseProjectileDamage` (`StatType` 53) is gated to the `Projectile` FLAG — a SEPARATE layer that
multiplies on top. `AttackDamage` (`StatType` 1) is a global base, attribute-agnostic (it applies on
every hit). Investing in the thinner layer pays off more than over-stacking an additive bucket.

## Hero class

**`EEquipClassType`** (the class that gates equipment/skills): `All` (0), `Knight`,
`Ranger` (2), `Sorcerer`, `Priest`, `Hunter`, `Slayer` (6). Read live via
`HeroInfoData.CLASS_TYPE` and exported as a catalog in `game/build.py`. E.g.: Ranger (bow) produces
`Physical` + `Projectile` hits, so `PhysicalDamagePercent` AND `IncreaseProjectileDamage`
both apply — in layers that multiply.

## Related

- [[invariants/obscured-data-offlimits]] — why `Unit`'s core stats are unreadable (XOR) and damage comes from `FINAL_STATS`, not the mod list
- [[reference/run-data-map]] — where each run field (incl. `classId`) is read
See also: [[reference/extraction-viability]] (per-hero/per-attribute damage is NOT in memory) · [[archive/damage-model]] (exact formula + RVAs)
