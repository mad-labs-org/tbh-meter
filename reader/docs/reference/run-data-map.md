---
type: reference
description: "O que o reader LÊ por run hoje (durante o tick + no fechamento): cada datum mapeado ao SÍMBOLO de config/offsets.py e ao módulo que o lê. O RE não-lido (debuffs, drop tables, catálogos ausentes) vive no snapshot docs/run-data-map.md antigo, não aqui."
symptoms:
  - "o que o reader lê por run"
  - "what the reader reads per run"
  - "de onde vem o gold/xp/dps"
  - "qual campo do runs.jsonl"
  - "onde o reader lê os heróis"
  - "que offset alimenta o overlay"
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

# Mapa de dados por run (o que o reader LÊ hoje)

Este é o **subconjunto LIDO** do mapa cru de RE: só os data que o reader extrai por run hoje —
durante o tick (10Hz / 1Hz) e no fechamento (`close_run`). Cada linha cita o **símbolo de
`config/offsets.py`** (a bíblia; nunca o literal cru) e o **módulo que faz a leitura**. A
verdade é o código: se um número aqui parecer errado, o offset mora em `offsets.py` e a leitura
no módulo citado.

O RE **não-lido** (state/attackState da unidade, buffs/debuffs elementais, dano-por-elemento,
12 core stats Obscured, drop tables, catálogos de monstro/stage não usados, wallets crus) **não
entra aqui**. Ele vive no snapshot bruto — o `docs/run-data-map.md` antigo (a tabela completa de
9 agentes sobre o dump), destinado a `archive/`. Aquilo é "o que DÁ pra ler"; isto é "o que o
reader lê" — o índice completo do que dá e do que não dá pra ler é a [[reference/value-inventory]].

---

## DURANTE a run (lido no loop)

| Datum | Símbolo (offsets.py) | Módulo que lê | Obs |
|---|---|---|---|
| HP atual/max de cada mob vivo + invocado | `UnitHealthController.HP_CURRENT` / `HP_MAX`, via `Unit.HEALTH_CONTROLLER` e `MonsterSpawnManager.MONSTER_LIST` / `SUMMONED_LIST` | `game/models.py::live_monsters` | float PURO. Núcleo do meter: dano = Σ queda de HP entre ticks |
| DPS / dano total / dano final do mob | (deriva do HP acima) | `metrics/dps.py::DpsTracker` | janela de 5s; mob que some da lista = golpe final pelo HP que restava. `total_damage` + `dps` vão pro record |
| Nº de mobs mortos (p/ kills) | `MonsterSpawnManager.DEAD_MONSTER_LIST` → `List.SIZE` | `metrics/progress.py::ProgressTracker`, e o loop p/ `R["mobs"]` | delta cumulativo = kills; cai no reload do MESMO stage (sinal de run abandonada) |
| stageKey VIVO | `Monster.STAGE_KEY` (moda das primeiras leituras) | `game/models.py::live_stage_key` | preferido sobre `CommonSaveData.CURRENT_STAGE_KEY` (o do save congela na troca) |
| Gold de COMBATE cumulativo VIVO | `AggregateManager.AGGREGATES` → `EAggregateType.GoldEarn` → SubKey 1 (geometria `Dict8B`) | `metrics/gold.py::combat_gold_live` | PRIMÁRIO. Baseline no `new_run`, delta no close. `COMBAT_SUBKEY=1` é regra de negócio (mora em gold.py, não em offsets) |
| XP VIVA dentro-do-nível por herói + nível | `HeroRuntime.EXP_FAKE` / `LEVEL_FAKE` (fakeValue PLANO), via `StageManager.HERO_LIST` → `Unit.CACHE` | `game/build.py::read_live_party` → `metrics/xp.py::PartyXpAccumulator` | ACTk fakeValue (PLANO, não o XOR). ACUMULADO tick-a-tick por heroKey (1º avistamento semeia o baseline; level-up pela curva); morte/dropout mantêm o banked |
| Identidade do herói deployado (heroKey) | `HeroInfoData.HERO_KEY`, via `HeroRuntime.INFO` | `game/build.py::read_live_party` | `party_seen` acumula quem foi visto em campo (cobre `sm` que resolve tarde) |
| Eventos novos do tick (qual log) | `LogManager.LOG_LIST` → `List.SIZE`/`List.ITEMS`; tipo via `Obj.KLASS` da entry | loop de `meter_windows.py` | classifica por ponteiro-de-classe (ELogType não é campo legível) |
| StageClear: act / stage / clear_time | `StageClearLog.ACT` / `STAGE` / `CLEAR_TIME` | `meter_windows.py::close_run` | dispara fechamento "success"; `CLEAR_TIME` = duração oficial em segundos |
| StageFailed: act / stage / wave atual / total | `StageFailedLog.ACT` / `STAGE` / `NOW_WAVE` / `TOTAL_WAVE` | `meter_windows.py::close_run` | dispara fechamento "fail"; revela até onde a run chegou |
| Drop de baú (tier) | `GetBoxLog.MONSTER_TYPE` (`EMonsterLogType`) → `BOX_KEY_BY_TIER` | loop de `meter_windows.py` | `GetBoxLog.BOX_KEY` é o TIPO ("TreasureChest_…"), NÃO item key; o tier autoritativo é o `MONSTER_TYPE`. Gray (mob) acumula em `R["drops"]`; boss box (logado ~0.6s APÓS o clear) é absorvido no record do success PENDENTE — ver [[invariants/run-lifecycle]] |
| Morte de herói: vítima + quem matou | `HeroDieLog.VICTIM_HERO` / `KILLER_MONSTER` (strings "Nome_<key>") | loop de `meter_windows.py` | LIVE-CRACKED: vítima e matador estavam TROCADOS no RE antigo. Conta `deaths`/`killers` por heroKey |
| Revive de herói | `ResurrectionLog.HERO` (string "Nome_<key>") | loop de `meter_windows.py` | conta `revives` por heroKey |

---

## NO FECHAMENTO (close_run) — fontes-snapshot do save

Lido uma vez em `close_run` (e baselines no `new_run`), via a instância VIVA do `PlayerSaveData`
escolhida por MAIOR ouro (`game/save.py::pick_live_psd`):

| Datum | Símbolo (offsets.py) | Módulo que lê | Obs |
|---|---|---|---|
| Saldo de ouro (fallback do gold-por-run) | `CurrencySaveData.KEY` (== `GOLD_KEY`) / `QUANTITY`, via `PlayerSaveData.CURRENCIES` | `game/save.py::read_gold` | só baseline + fallback. O gold-por-run real é o delta VIVO acima |
| Gold de combate cumulativo do SAVE (fallback) | `PlayerSaveData.AGGREGATES` → `AggregateSaveData.TYPE`==`GoldEarn` & `SUB_KEY`==1 → `VALUE` | `metrics/gold.py::combat_gold_save` | espelho em disco do vivo; atualiza em SALTOS → só fallback quando o vivo não resolve |
| XP/nível por herói do save (fallback) | `HeroSaveData.HERO_KEY` / `LEVEL` / `EXP`, via `PlayerSaveData.HEROES` | `game/save.py::read_heroes` | `EXP` zera no level-up (defasado); usado só se a XP viva não rolou |
| XP por-run (acumulador vivo, tratado por curva) | (deriva da XP viva/save acima) | `metrics/xp.py::PartyXpAccumulator` (ponte de level-up via `per_hero_gain`) | level-up "dá a volta" pela curva (`config/level_curve.json`); morto/deploy-tardio mantêm o acumulado banked (sem re-read de `uf`) |
| Build por herói: classe / nível / exp | `HeroSaveData.LEVEL`/`EXP` + `HeroInfoData.CLASS_TYPE` (catálogo `hero_cat`) | `game/build.py::read_build` | só os heróis REALMENTE deployados (filtro por `live_keys`) |
| Itens equipados + raridade/slot/nível | `HeroSaveData.EQUIPPED_ITEMS` → `ItemSaveData.ITEM_KEY`/`UNIQUE_ID` → `ItemInfoData.GRADE`/`PARTS`/`LEVEL` | `game/build.py::read_build` | catálogo `item_cat` keyed por itemKey; casa por `UNIQUE_ID` |
| Mods rolados do item (enchants/decoration/…) | `ItemSaveData.ENCHANT_DATA` → `ItemEnchant.STAT_TYPE`/`VALUE`/`TIER`/`RECIPE` (struct PLAIN, `STRIDE`) | `game/build.py::read_mods` | a versão-SAVE é PLAIN; o espelho runtime (`te`) é Obscured → preferir o save |
| Skills equipadas + níveis (ativas + passivas) | `HeroSaveData.EQUIPPED_SKILLS` + `PlayerSaveData.ATTRIBUTES` → `AttributeSaveData.KEY`/`LEVEL` | `game/build.py::read_build` / `read_attribute_levels` | nível da skill vem do nó da árvore (`attributeKey`); passivas só moram na árvore |
| Snapshot da conta: runas + inventário + stash | `PlayerSaveData.RUNES` → `RuneSaveData.KEY`/`LEVEL`; `PlayerSaveData.INVENTORY_SLOTS`/`STASH` → `InventorySaveData.UNIQUE_ID`/`StashSaveData.UNIQUE_ID` → join em `PlayerSaveData.ITEMS` | `game/build.py::read_account_snapshot` | account-wide, 1x no close; entra no raw em envelope ok/err (NÃO-LI → `err`; `[]` = vazio genuíno). Itens id-only; o wiki deriva drop-rate real / correção de wave |
| 64 stats FINAIS vivos por herói | `StatsHolder.FINAL_STATS` (`Dict<StatType,float>`, geometria `DictFloat`), via `HeroRuntime.STATS_HOLDER` | `game/build.py::read_live_stats_by_hero` | id-only (statId→valor); o front resolve o nome. Os 12 core stats Obscured NÃO se leem |

O record final montado por `close_run` é o **`raw/<id>.json`** (carimbado com `RAW_SCHEMA_VERSION`;
campo de dado em envelope ok/err, meta crua, `id` = horário de fim em ms) — `status`/`stage`/`mode`/
`dps`/`partial` são DERIVADOS pelo conversor do app, não saem do reader. O shape e a receita de
bump são invariante à parte (ver Related).

---

**Notas.**
- `EAggregateType.GoldEarn == 2` e o `COMBAT_SUBKEY == 1` são a chave do gold-por-run; trocar a
  geometria `Dict8B` (valor de 8B) por `DictFloat` (valor de 4B) ao andar o AGGREGATES corrompe
  o gold sem erro (ver Related).
- DANO/CRIT/ELEMENTO por hit NÃO são lidos (transientes / Obscured); o meter os deriva só como
  queda de HP. A modelagem do que dá/não dá ler está nas references de Related.

## Related
- [[invariants/dict-strides]] — `DictFloat` (4B, gold de stats) vs `Dict8B` (8B, gold cumulativo): qual usar em cada Dict deste mapa
- [[invariants/gold-singleton-resolution]] — como `AggregateManager.AGGREGATES` é alcançado (singleton ofuscado resolvido por estrutura)
- [[invariants/metric-fallback-chains]] — a cadeia LIVE→SAVE de gold/xp que estas linhas alimentam
- [[invariants/schema-versioning]] — o shape do record que `close_run` serializa, e como bumpar
- [[invariants/log-event-detection]] — como os `*Log` (StageClear/Fail/GetBox/HeroDie/Resurrection) viram fechamento/drop/morte
Veja também: [[reference/damage-model]] (o fold dos stats / por que dano não é lido) · [[reference/extraction-viability]] + [[reference/value-inventory]] (o RE cru não-lido, destino do run-data-map antigo) · [[invariants/obscured-data-offlimits]] (core stats / te / wallets Obscured que NÃO se leem)
