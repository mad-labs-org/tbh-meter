---
type: reference
description: "Enums e structs do sistema de dano que VIVEM em config/offsets.py — modificadores (MODTYPE/MODSOURCE/StatModifier), atributo/tipo de hit (EDamageAttribute/EDamageType/DamageInfo) e classe (EEquipClassType). É catálogo de ESTRUTURA, não cálculo: o reader não roda a fórmula."
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

# Modelo de dano — enums e structs (em `offsets.py`)

Esta nota é a parte **testável** do modelo de dano: os enums e structs que existem como
SÍMBOLO em `config/offsets.py` (a bíblia). É **catálogo de estrutura**, não de aritmética —
o reader **não calcula dano**. A maioria destes símbolos (`MODTYPE`, `MODSOURCE`,
`StatModifier`, `DamageInfo`, `EDamageType`) **não tem consumidor vivo** no reader hoje: são
fatos de RE que documentam COMO o jogo combina stats, úteis pra quem for mapear um valor de
dano ou explicar a build no front. `EDamageAttribute`, `EEquipClassType` e `StatType` esses
sim são reexportados/lidos (`game/enums.py`, `game/build.py`).

> A **fórmula exata** (bracketing/fold) e os **RVAs + disassembly** que a provaram NÃO entram
> aqui: não são testáveis contra `offsets.py` (rotam por build, são RE bruto). Vivem no
> snapshot `archive/damage-model`.
> <!-- criar quando migrar o RE cru: archive/damage-model (fórmula + RVAs gbm@…, capstone) -->

## Sistema de modificadores

Cada stat final é o fold de uma LISTA de modificadores. A geometria do modificador é o struct
`StatModifier` (`up` no dump): campos `STAT_TYPE`, `MOD_TYPE`, `VALUE` (float), `MOD_SOURCE`.

- **`MODTYPE`** classifica como o modificador entra no fold: `FLAT` (0), `ADDITIVE` (1),
  `MULTIPLICATIVE` (2). A ORDEM dos valores é load-bearing — o fold ramifica por este enum
  (flat soma na base; aditivos somam num bucket único → **retorno decrescente** ao empilhar;
  multiplicativos são um produto separado, **não diminuem entre si**).
- **`MODSOURCE`** diz de ONDE veio (`BASE`, `ITEM`, `ATTRIBUTE`, `PASSIVE`, `AccountStatus`,
  `StatusEffect`, `BuffSkill`, `ENVIRONMENT`) — é metadado de proveniência, não muda a conta.

O stat FINAL já folded NÃO se reconstrói a partir desta lista no reader: lê-se pronto do
`StatsHolder.FINAL_STATS` (`Dict<StatType,float>`; ver [[invariants/obscured-data-offlimits]] —
os stats core em `Unit.CORE_STATS_OBSCURED` são XOR-lixo, NÃO leia). `StatsHolder.MODIFIER_MGR`
é a lista crua de mods (raramente necessária).

## Atributo e tipo do hit

- **`EDamageAttribute`** (elemento do dano): `Physical` (0), `Fire`, `Cold`, `Lightning`,
  `Chaos`, `AllElement`, `NONE` (6). Atenção: o membro "nenhum" chama-se **`NONE`** (maiúsculo)
  — `None` é palavra reservada do Python.
- **`EDamageType`** é um **`IntFlag`** (combinável por OR): `NONE` (0), `Melee` (1),
  `Projectile` (2), `AOE` (4), `Summon` (8), `DOT` (16), `Trap` (32). Por ser flags, valores são
  potências de 2 — um hit pode ser `Melee|AOE`.
- **`DamageInfo`** é o struct transiente do hit (campos `ATTACKER`, `ORIGIN_DAMAGE`,
  `IS_CRITICAL`, `DAMAGE_ATTRIBUTE` = `EDamageAttribute`, `DAMAGE_TYPE` = `EDamageType`,
  `HIT_EFFECTS`). É efêmero — entregue por hit e descartado; o reader não o persiste.

Atributo e tipo são **camadas independentes**: `PhysicalDamagePercent` (`StatType` 24) é gated
ao atributo Physical e é **aditivo** dentro do bucket (empilhar dá retorno decrescente);
`IncreaseProjectileDamage` (`StatType` 53) é gated ao FLAG `Projectile` — camada SEPARADA, que
multiplica por cima. `AttackDamage` (`StatType` 1) é base global, agnóstica de atributo (vale em
todo hit). Investir na camada mais magra rende mais que sobre-empilhar um bucket aditivo.

## Classe do herói

**`EEquipClassType`** (a classe que gate os equipamentos/skills): `All` (0), `Knight`,
`Ranger` (2), `Sorcerer`, `Priest`, `Hunter`, `Slayer` (6). Lida ao vivo via
`HeroInfoData.CLASS_TYPE` e exportada como catálogo em `game/build.py`. Ex.: Ranger (arco) gera
hits `Physical` + `Projectile`, então `PhysicalDamagePercent` E `IncreaseProjectileDamage`
ambos aplicam — em camadas que se multiplicam.

## Related

- [[invariants/obscured-data-offlimits]] — por que os stats core do `Unit` são ilegíveis (XOR) e o dano sai do `FINAL_STATS`, não da lista de mods
- [[reference/run-data-map]] — onde cada campo da run (incl. `classId`) é lido
Veja também: [[reference/extraction-viability]] (dano per-hero/per-atributo NÃO está em memória) · [[archive/damage-model]] (fórmula exata + RVAs)
