---
type: archive
status: superseded
description: "Historical SNAPSHOT (raw RE or delivered plan) — names/offsets/lines may be stale; current truth lives in the living notes (see _index). Exempt from the code drift-test."
---

# TBH — Damage model (structure RE, 2026-06-03)

Reverse of `re/dump/dump.cs`. **Honest limit:** the Il2CppDumper dump has signatures +
RVAs but **empty bodies** — the MODEL below is proven by the STRUCTURE (enums/structs/fields);
the EXACT arithmetic (bracketing) needs disassembly of the RVAs listed at the end.

## Modifier system (proven by enum names — not a guess)
- `MODTYPE` (dump.cs:336237): **FLAT=0, ADDITIVE=1, MULTIPLICATIVE=2**
- `MODSOURCE` (336246): BASE=0, ITEM=1, ATTRIBUTE=2, PASSIVE=3, AccountStatus=4, StatusEffect=5, BuffSkill=6, ENVIRONMENT=7
- `up` = **StatModifier** (336258): `{StatType@0x10, MODTYPE@0x14, float value@0x18, MODSOURCE@0x1C}`
- `uq` = **ModifierManager** (336368): `Dict<StatType, List<up>>` + `Dict<MODSOURCE, List<up>>` — each stat is a LIST of modifiers.
- `xd` = stats holder (342026, via `uf.behg@0x10`): `betr@0x10` (uq) ; `bets@0x18` = **Dict<StatType,float> FINAL (the 64 stats the meter reads)** ; `bett@0x20` 2nd cache. Folders `gbm(List<up>,float)@RVA 0x936E20` and `kau@0x9389A0` fold the mod list into a final float.
- Formatter `pk` (340340) colors/formats each stat BY MODTYPE → FLAT vs % vs MULTIPLICATIVE are first-class.

⇒ **FORMULA CONFIRMED by disassembly of `gbm` @ file offset 0x935C20 (RVA 0x936E20)** — no longer inference:
**`stat_final = (base + Σflat) × (1 + Σadditive%) × Π(multiplicative)`**
x64 trace (capstone): reads `MODTYPE` at `[rcx+0x14]` (= `up.behl`), branches 3 ways — FLAT(0): `addss xmm7,[rcx+0x18]` (base += value); ADDITIVE(1): `addss xmm6,[rcx+0x18]` (single bucket += value); MULTIPLICATIVE(2): `mulss xmm8,(value−k)` (SEPARATE factor, Π). Close: `mulss xmm6,xmm7; addss xmm6,xmm7; mulss xmm6,xmm8` = `base × (1 + Σadditive) × mult`.
⇒ **ADDITIVE % in the same bucket = diminishing return (1+a+b+c); MULTIPLICATIVE doesn't diminish against each other; base/flat multiplies everything.**

## Damage attributes and types
- `EDamageAttribute` (355638): **Physical=0**, Fire=1, Cold=2, Lightning=3, Chaos=4, AllElement=5, None=6
- `EDamageType` [Flags] (355651): None=0, **Melee=1, Projectile=2, AOE=4, Summon=8, DOT=16, Trap=32**
- `EEquipClassType` (354930): All=0, Knight=1, **Ranger=2**, Sorcerer=3, Priest=4, Hunter=5, Slayer=6
- `DamageInfo` (struct, 319209): `Attacker@0x0, OriginDamage@0x8, IsCritical@0xC, DamageAttribute@0x10, DamageType@0x14, HitEffects@0x20`. Delivered by `Unit.ebi(DamageInfo,bool)` (TakeDamage).
- Attribute/type are **per-skill** (`SkillInfoData.DamageAttribute@0x50 / DamageDeliveryType@0x54`, 355685; cache `un` 335893).
- Per-attribute multipliers live on the `Unit`: `Dict<EDamageAttribute,float>` × 5 caches (@0x260/0x2A8/0x2B0/0x2B8/0x2C0), read by `Unit.gqp/gqq/gqr/gqs(EDamageAttribute)`. Per-TYPE multipliers via `xe.drx/kbc/lvr(Unit, EDamageType, float)` (342225) → Increase Projectile/Melee/AOE/Summon.

## How the stats in question feed in (layers)
- **AttackDamage (1)** = global BASE damage, **attribute-agnostic** → enters EVERY hit, multiplies across all layers. Never wasted.
- **PhysicalDamageAddition (42)** = FLAT, **gated to Physical-attribute hits**. (`DamageAddition` 41 = agnostic flat.)
- **PhysicalDamagePercent (24)** = **% multiplier, gated to Physical**, **additive within the bucket** → diminishing return when stacked.
- **IncreaseProjectileDamage (53)** = % multiplier **gated by EDamageType.Projectile** (SEPARATE layer, independent of attribute).
- **ProjectileCount (22) / Multistrike (20)** = HIT-COUNT multipliers (more DamageInfo/attack) → multiply ~linearly, huge DPS lever.
- **CriticalChance (3)/CriticalDamage (4)** → expected factor `1 + critChance×(critDmg−1)`.

## Ranger (class 2, bow → Physical + Projectile)
AttackDamage(1), PhysicalDamage%(24), IncreaseProjectileDamage(53) and ProjectileCount/Multistrike
are **DIFFERENT layers that multiply** → **invest in the LEANEST layer** (don't over-stack one
additive bucket). Phys%(24) only counts because the hit is physical; AttackDamage(1) always counts.

## To NAIL the exact arithmetic (Ghidra/IDA via re/tools/Il2CppDumper) — in order
1. ✅ **DONE** — `xd.gbm` @ RVA 0x936E20 already disassembled (capstone): formula = `(base+Σflat)×(1+Σadditive)×Πmult` (see the modifier-system section above). `kau` @0x9389A0 = sibling (not needed).
2. `ActiveSkill.AttackDamage()` base @ **RVA 0xAAB060** (+ overrides from the Archer skills).
3. `Unit.gqz()` @ **RVA 0xB432E0** + `Unit.gqp/gqq/gqr/gqs(EDamageAttribute)` @ 0xB42F80/0xB42FD0/0xB43020/0xB430E0.
4. `xe.drx(Unit,EDamageType,float)` @ **RVA 0x93ACA0** — confirms the projectile layer.
Empirical alternative: A/B with the meter (measures real DPS): equip +AD, run; swap +Phys%, run; compare.
