---
type: reference
description: "Matriz de viabilidade read-only por domínio (composição/modo/gold/xp/stats/equip/skills/agregados): o que é VIÁVEL/PARCIAL/INVIÁVEL e por quê — PLAIN (lê direto) vs Obscured (ACTk, dá lixo). O que o reader extrai HOJE, não o que o spec planejou."
symptoms:
  - "dá pra extrair X?"
  - "can we extract"
  - "por que não tem per-hero DPS"
  - "no per-hero damage"
  - "dano por herói"
  - "stat obscured lixo"
  - "ObscuredFloat XOR"
  - "runes pets no runs.jsonl"
  - "nível de skill"
  - "nome do herói i18n"
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

# Matriz de viabilidade da extração (read-only)

O que o reader **consegue ler** da memória do jogo, por domínio, e **por quê**. A linha
divisória é uma só:

- **PLAIN** — campo em texto puro; lê direto (`ri32`/`ri64`/`rf32` ou um Dict normal). É a
  base de quase tudo que o reader extrai.
- **Obscured (ACTk)** — o valor real NÃO é o campo: `hidden ^ key` na build atual dá **lixo**
  (o real é um `fakeValue` PLAIN num offset vizinho, quando existe). Ler o campo Obscured cru é
  uma classe de bug — ver [[invariants/obscured-data-offlimits]]. Por isso todo número que o
  reader emite vem de uma fonte PLAIN, nunca de um XOR.

> Esta nota é o MAPA (o que dá / o que não dá). O **mapa de campos do `runs.jsonl`** (forma
> exata de cada chave) é outra nota; o **modelo de dano** (por que DPS é só HP-delta de time)
> é outra. Aqui é só viabilidade + a razão PLAIN/Obscured.

## A matriz

| Domínio | Viável? | Fonte que o reader usa | PLAIN/Obsc |
|---|---|---|---|
| **Composição** (party + classe) | ✅ viável | `StageManager.HERO_LIST` (Hero[]) vivo → `Unit.CACHE`(uf) → `HeroRuntime.INFO` → `HeroInfoData.HERO_KEY`/`CLASS_TYPE` | PLAIN |
| **Modo / dificuldade** | ✅ viável | catálogo `StageInfoData.DIFFICULTY` (e `STAGE_TYPE`), casado pelo stageKey vivo | PLAIN |
| **XP** (nível + exp vivos) | ✅ viável | `HeroRuntime.LEVEL_FAKE`/`EXP_FAKE` (= ACTk **fakeValue**, é PLAIN) | PLAIN |
| **Stats por herói** (64 finais) | ✅ viável | `HeroRuntime.STATS_HOLDER`(xd) → `StatsHolder.FINAL_STATS` = `Dict<StatType,float>` (DictFloat) | PLAIN |
| **Agregados/stage** (GoldEarn total, waves) | ✅ viável | `AggregateManager.AGGREGATES` (Dict8B) + `StageInfoData` waves | PLAIN |
| **Gold por run** | 🟡 parcial | combate vivo = `AggregateManager.AGGREGATES`[GoldEarn][SubKey1]; SAVE = fallback | PLAIN¹ |
| **Equipamentos** | 🟡 parcial | ficha (slot/raridade/nível-base/uniqueId/enchants persistidos) via `ItemSaveData` + catálogo `ItemInfoData` | PLAIN² |
| **Skills** (equipadas + passivas + nível) | 🟡 parcial | `HeroSaveData.EQUIPPED_SKILLS` + `AttributeSaveData` (árvore investida) | PLAIN³ |
| **DPS por herói** | ❌ inviável | — (o jogo não guarda dano por unidade; só HP-delta do TIME) | n/a |
| **Dano/stat por atributo** | ❌ inviável | — (não está em memória; ver modelo de dano) | n/a |
| **Snapshot da conta** (runas + inventário + stash) | ✅ viável | `PlayerSaveData.RUNES` (`RuneSaveData.KEY`/`LEVEL`) + `PlayerSaveData.INVENTORY_SLOTS`/`STASH` (`UNIQUE_ID` → join em `PlayerSaveData.ITEMS`), lido 1x no fechamento por `game/build.py::read_account_snapshot` | PLAIN |
| **Pets** | ❌ não-extraído | — (account-wide, não muda por run; **sem símbolo no código atual**) | — |
| **Nome legível** (herói/skill/item) | ❌ inviável | — (memória só tem chave de i18n; string-table é outro subsistema) | n/a |

¹ **Gold vivo é PLAIN** — o reader NÃO lê o `ObscuredLong` de gold-runtime. Ele lê o agregado
cumulativo `GoldEarn[SubKey1]` (combate), que é um `long` plano. O difícil aqui nunca foi
cripto: foi **achar o singleton** (`AggregateManager`, nome ofuscado que drifta) sem o nome —
ver ¶ Gold abaixo. "Parcial" = depende da fonte (live exato vs save em saltos), não de XOR.

² **Equip é parcial por causa do que NÃO se lê**: raridade, slot, tipo, nível-base e os enchants
**persistidos** (`ItemEnchant` struct: stat/recipe/value/tier) são **100% PLAIN** e o reader
emite todos. O que fica de fora é a **instância viva** do item (nível-vivo + mods rolados), cujos
campos são `ObscuredInt` na classe de gear runtime → ler dá lixo → o reader **não toca** neles.

³ **Skill é parcial pela LACUNA de nível na fonte óbvia**: a skill equipada (`EQUIPPED_SKILLS`,
int[]) e a info estática são PLAIN, mas o **nível** não vive em `HeroSaveData` — vem da árvore
investida (`AttributeSaveData.LEVEL`, account-wide), ligada por um mapa skillKey→attributeKey
gerado offline. O cache runtime da skill é Obscured → o reader entra pela árvore PLAIN, não por ele.

## Por que os três ❌ são duros (não é "ninguém tentou")

- **DPS / dano por herói** — o jogo **não persiste dano por unidade** em lugar nenhum legível. O
  número do tooltip (`m_DPS`) é uma **string de UI** (TextMeshPro), não um campo numérico. A única
  saída read-only é o meter próprio: Σ das quedas de HP dos monstros (HP é float PURO em
  `UnitHealthController.HP_CURRENT`/`HP_MAX`) — isso dá **DPS de TIME**, sem decompor por herói.
  Ver [[reference/damage-model]].
- **Nome legível** — herói/skill/item carregam só `NameKey` (chave de i18n). Resolver pra texto
  exige a string-table do jogo, que é outro subsistema fora do mapa de offsets. O reader emite o
  **id** e deixa o front resolver o nome.
- **Stats "core" individuais** de `Unit` (os 12 `ObscuredFloat` em `Unit.CORE_STATS_OBSCURED`) — o
  mapeamento índice→StatType não é recuperável só do dump E os campos são Obscured. Não precisa:
  `FINAL_STATS` já entrega os 64 por `StatType` em PLAIN.

## Gold: o "parcial" não é cripto, é resolução de singleton

Gold por run sai do agregado cumulativo de **combate** (`GoldEarn[SubKey1]`), que é PLAIN. Os
SubKeys NÃO são fontes paralelas: SubKey 1 = combate (o que a run quer), SubKey 0 = TOTAL (rollup
que inclui **venda** → não usar), 2/3 = ruído. O obstáculo é que o dono desse Dict é um singleton
de **nome ofuscado que muda entre builds** — então ele é resolvido por ÍNDICE (TypeDefIndex/RVA, o
primário hoje) com fallback estrutural por scan, **nunca por nome**. Detalhe e fallback em
[[invariants/gold-singleton-resolution]] e [[invariants/metric-fallback-chains]].

## Como ler esta matriz na prática

- Vai **mapear um valor novo**? Comece perguntando "é PLAIN?". Se a fonte óbvia for Obscured,
  procure o `fakeValue`/uma fonte PLAIN equivalente — não tente XOR (a build não usa hidden^key).
- "✅ viável" aqui significa **o reader já extrai** (há função em `game/` ou `metrics/`). "🟡
  parcial" = extrai um SUBCONJUNTO (a coluna explica qual fica de fora e por quê).
- O save (`PlayerSaveData`) é **snapshot defasado**: ótimo pra ficha/identidade e como fallback,
  ruim pra número ao vivo (gold/xp vivos vêm do mundo runtime, não do save).

## Related
- [[invariants/obscured-data-offlimits]]
- [[invariants/gold-singleton-resolution]]
- [[invariants/metric-fallback-chains]]
Veja também: [[reference/run-data-map]] (forma exata de cada campo do runs.jsonl) · [[reference/damage-model]] (DPS = HP-delta de time, sem per-hero) · [[process/value-mapping-method]] (como achar uma fonte PLAIN) · [[guides/map-new-value]]
