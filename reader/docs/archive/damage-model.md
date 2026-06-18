---
type: archive
status: superseded
description: "SNAPSHOT histórico (RE cru ou plano entregue) — nomes/offsets/linhas podem estar obsoletos; a verdade atual está nas notas vivas (ver _index). Isento do drift-test de código."
---

# TBH — Modelo de dano (RE da estrutura, 2026-06-03)

Reverso do `re/dump/dump.cs`. **Limite honesto:** o dump do Il2CppDumper tem assinaturas +
RVAs mas **corpos vazios** — o MODELO abaixo é provado pela ESTRUTURA (enums/structs/campos);
a aritmética EXATA (bracketing) precisa de disassembly dos RVAs listados no fim.

## Sistema de modificadores (provado por nomes de enum — não é suposição)
- `MODTYPE` (dump.cs:336237): **FLAT=0, ADDITIVE=1, MULTIPLICATIVE=2**
- `MODSOURCE` (336246): BASE=0, ITEM=1, ATTRIBUTE=2, PASSIVE=3, AccountStatus=4, StatusEffect=5, BuffSkill=6, ENVIRONMENT=7
- `up` = **StatModifier** (336258): `{StatType@0x10, MODTYPE@0x14, float value@0x18, MODSOURCE@0x1C}`
- `uq` = **ModifierManager** (336368): `Dict<StatType, List<up>>` + `Dict<MODSOURCE, List<up>>` — cada stat é uma LISTA de modificadores.
- `xd` = stats holder (342026, via `uf.behg@0x10`): `betr@0x10` (uq) ; `bets@0x18` = **Dict<StatType,float> FINAL (os 64 stats que o meter lê)** ; `bett@0x20` 2º cache. Folders `gbm(List<up>,float)@RVA 0x936E20` e `kau@0x9389A0` dobram a lista de mods num float final.
- Formatter `pk` (340340) colore/formata cada stat POR MODTYPE → FLAT vs % vs MULTIPLICATIVE são first-class.

⇒ **FÓRMULA CONFIRMADA por disassembly do `gbm` @ file offset 0x935C20 (RVA 0x936E20)** — não é mais inferência:
**`stat_final = (base + Σflat) × (1 + Σaditivo%) × Π(multiplicativo)`**
Trace x64 (capstone): lê `MODTYPE` em `[rcx+0x14]` (= `up.behl`), ramifica em 3 — FLAT(0): `addss xmm7,[rcx+0x18]` (base += valor); ADITIVO(1): `addss xmm6,[rcx+0x18]` (bucket único += valor); MULTIPLICATIVO(2): `mulss xmm8,(valor−k)` (fator SEPARADO, Π). Fecho: `mulss xmm6,xmm7; addss xmm6,xmm7; mulss xmm6,xmm8` = `base × (1 + Σaditivo) × mult`.
⇒ **% ADITIVO do mesmo bucket = retorno decrescente (1+a+b+c); MULTIPLICATIVO não diminui entre si; base/flat multiplica tudo.**

## Atributos e tipos de dano
- `EDamageAttribute` (355638): **Physical=0**, Fire=1, Cold=2, Lightning=3, Chaos=4, AllElement=5, None=6
- `EDamageType` [Flags] (355651): None=0, **Melee=1, Projectile=2, AOE=4, Summon=8, DOT=16, Trap=32**
- `EEquipClassType` (354930): All=0, Knight=1, **Ranger=2**, Sorcerer=3, Priest=4, Hunter=5, Slayer=6
- `DamageInfo` (struct, 319209): `Attacker@0x0, OriginDamage@0x8, IsCritical@0xC, DamageAttribute@0x10, DamageType@0x14, HitEffects@0x20`. Entregue por `Unit.ebi(DamageInfo,bool)` (TakeDamage).
- Atributo/tipo são **por-skill** (`SkillInfoData.DamageAttribute@0x50 / DamageDeliveryType@0x54`, 355685; cache `un` 335893).
- Multiplicadores por-atributo vivem no `Unit`: `Dict<EDamageAttribute,float>` × 5 caches (@0x260/0x2A8/0x2B0/0x2B8/0x2C0), lidos por `Unit.gqp/gqq/gqr/gqs(EDamageAttribute)`. Multiplicadores por-TIPO via `xe.drx/kbc/lvr(Unit, EDamageType, float)` (342225) → Increase Projectile/Melee/AOE/Summon.

## Como os stats da pergunta entram (camadas)
- **AttackDamage (1)** = dano BASE global, **agnóstico de atributo** → entra em TODO hit, multiplica em todas as camadas. Nunca desperdiça.
- **PhysicalDamageAddition (42)** = FLAT, **gated a hits de atributo Physical**. (`DamageAddition` 41 = flat agnóstico.)
- **PhysicalDamagePercent (24)** = **% multiplicador, gated a Physical**, **aditivo dentro do bucket** → retorno decrescente ao empilhar.
- **IncreaseProjectileDamage (53)** = % multiplicador **gated por EDamageType.Projectile** (camada SEPARADA, independente do atributo).
- **ProjectileCount (22) / Multistrike (20)** = multiplicadores de CONTAGEM DE HITS (mais DamageInfo/ataque) → multiplicam ~linear, alavanca enorme de DPS.
- **CriticalChance (3)/CriticalDamage (4)** → fator esperado `1 + critChance×(critDmg−1)`.

## Ranger (classe 2, arco → Physical + Projectile)
AttackDamage(1), PhysicalDamage%(24), IncreaseProjectileDamage(53) e ProjectileCount/Multistrike
são **camadas DIFERENTES que multiplicam** → **invista na camada mais MAGRA** (não over-stacka um
bucket aditivo). Phys%(24) só vale porque o hit é físico; AttackDamage(1) vale sempre.

## Pra CRAVAR a aritmética exata (Ghidra/IDA via re/tools/Il2CppDumper) — em ordem
1. ✅ **FEITO** — `xd.gbm` @ RVA 0x936E20 já desmontado (capstone): fórmula = `(base+Σflat)×(1+Σaditivo)×Πmult` (ver seção do sistema de modificadores acima). `kau` @0x9389A0 = sibling (não precisou).
2. `ActiveSkill.AttackDamage()` base @ **RVA 0xAAB060** (+ overrides dos skills Archer).
3. `Unit.gqz()` @ **RVA 0xB432E0** + `Unit.gqp/gqq/gqr/gqs(EDamageAttribute)` @ 0xB42F80/0xB42FD0/0xB43020/0xB430E0.
4. `xe.drx(Unit,EDamageType,float)` @ **RVA 0x93ACA0** — confirma a camada de projétil.
Alternativa empírica: A/B com o meter (mede DPS real): equipa +AD, roda; troca +Phys%, roda; compara.
