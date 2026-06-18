---
type: reference
description: "Inventário do que o reader LÊ da memória do jogo, classificado por FONTE: VIVO (tempo real, preferido) vs SAVE (snapshot defasado, só fallback) vs TODO (a mapear). Cada valor aponta o módulo/símbolo que o lê — onde mexer e o que NÃO confundir."
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

# Inventário de valores que o reader lê

Catálogo do que o meter extrai da memória, classificado pela **FONTE** — porque a fonte decide
se o número é confiável por run. Espelha `docs/value-mapping-plan.md` §3 (o "inventário"), mas
re-derivado do código: cada linha aponta o módulo/símbolo que lê o valor. **A verdade é o
código** (os módulos em `metrics/` + `game/`); esta nota é o índice.

Três camadas, em ordem de preferência:

- **VIVO** — lido da instância viva a cada tick. Tempo real, exato, lag-zero. **Fonte primária.**
- **SAVE** — lido do `PlayerSaveData`/`CommonSaveData` (plaintext, snapshot). Atualiza em
  **saltos** (só no save-write, ~a cada 100s). Bom pra identidade/ficha; **lixo pra delta por
  run** → só **fallback**.
- **TODO** — ainda não mapeado; achar com a metodologia da seção 2 do value-mapping-plan.

## Vivos (tempo real — fonte preferida)

| Valor | Módulo / leitor | Como chega |
|---|---|---|
| **Gold de COMBATE por run** | `metrics/gold.py::combat_gold_live` | AggregateManager (singleton, resolvido por estrutura) → `AGGREGATES[GoldEarn][COMBAT_SUBKEY]`. Cumulativo; o delta da run = `run_gain(start, end)`. |
| **XP viva / herói** | `game/build.py::read_live_party` · `metrics/xp.py::PartyXpAccumulator` | HeroRuntime do herói deployado (`EXP_FAKE`, dentro-do-nível), ACUMULADO tick-a-tick por heroKey (1º avistamento semeia o baseline); a curva (`metrics/xp.py::curve`) preenche o level-up. |
| **Nível vivo / herói** | `game/build.py::read_live_party` | HeroRuntime `LEVEL_FAKE`. |
| **XP de quem MORREU / entrou tarde** | `metrics/xp.py::PartyXpAccumulator` | o acumulado fica **banked** quando o herói some do HeroList (morto soma 0 enquanto morto); deploy tardio é creditado do 1º avistamento. (Substituiu o re-read do `uf` capturado no início.) |
| **Dano / DPS** | `metrics/dps.py::DpsTracker` | Σ queda de HP dos monstros por tick + golpe final de quem sumiu da lista. É TEAM total (não há por-herói — ver [[reference/damage-model]]). |
| **64 stats FINAIS / herói** | `game/build.py::read_live_stats_by_hero` | HeroRuntime → StatsHolder `FINAL_STATS` (DictFloat). id-only `{statId: valor}`. |
| **Mobs vivos / mortos** | `metrics/progress.py::ProgressTracker` | MonsterSpawnManager `MONSTER_LIST` / `DEAD_MONSTER_LIST` (kills/min; reseta no reload de stage). |
| **Contagem de eventos** | `metrics/events.py::EventFeed` | delta da `LOG_LIST` do LogManager (só CONTA entradas novas hoje — o tipo de cada evento é TODO; ver tabela abaixo). |

> Nota sobre o gold vivo: `combat_gold_live` lê o **`COMBAT_SUBKEY`** (de combate) — NÃO o
> `TOTAL_SUBKEY` (rollup que inclui venda/idle). Confundir os dois conta a venda no gold da run.
> O leitor ainda guarda contra valor implausível (rejeita `0` e valores absurdos da casa do
> petabyte — a origem dos bugs históricos gold-0 e 1.97T). Detalhe e a cadeia LIVE→SAVE em
> [[invariants/metric-fallback-chains]]; como o singleton ofuscado é achado em
> [[invariants/gold-singleton-resolution]].

## Save (snapshot defasado — só fallback)

| Valor | Módulo / leitor | Por que é só fallback |
|---|---|---|
| **Gold combate (fallback)** | `metrics/gold.py::combat_gold_save` | mesmo número do vivo, mas do `PlayerSaveData` (AggregateSaveData Type=GoldEarn, `COMBAT_SUBKEY`). Atualiza em saltos → delta por run não-confiável (0 se a run cai entre writes; ~2× se um write pega duas runs). |
| **Carteira (saldo)** | `game/save.py::read_gold` | CurrencySaveData `Key==GOLD_KEY`. Também é do save (defasado). **Nunca** use o delta da carteira pro gold da run — inclui venda/idle (é a regressão que `run_gain==None` evita). |
| **Build do herói** | `game/build.py::read_build` | classe/nível/exp + itens equipados (raridade/nível/mods/enchants) + skills/passivas investidas. Identidade/ficha — lenta de mudar, save serve. |
| **Snapshot da conta (runas / inventário / stash)** | `game/build.py::read_account_snapshot` | estado ACCOUNT-WIDE no fechamento — ficha, não métrica: aqui não há delta por run pro atraso do save corromper (nenhum espelho "vivo" foi mapeado, nem fez falta). Runas (`PlayerSaveData.RUNES`) + itens de inventário/stash (`INVENTORY_SLOTS`/`STASH` → join em `ITEMS`). Vai pro raw em envelope ok/err: NÃO-LI → `None` → `err`, nunca `ok([])` silencioso. |
| **playTime / stage atual** | `game/save.py::pick_live_csd` | CommonSaveData (escolhe o de maior playTime; lê o currentStageKey vivo). |

## ⚪ TODO / futuro (achar com a metodologia da seção 2 do value-mapping-plan)

| Valor | Caminho previsto |
|---|---|
| **Outros `EAggregateType` vivos** (MonsterKill, BoxObtain, ItemObtain, PlayTime, StageClear, StageFail) | mesmo AggregateManager (singleton JÁ resolvido), outra chave externa — só ler outra `EAggregateType`. |
| **Gold por FONTE** (venda / idle / quest) | `GoldEarn[SubKey2/3]` (separar de combate; hoje só `COMBAT_SUBKEY`/`TOTAL_SUBKEY` mapeados). |
| **Drops por run** (itens / caixas obtidos) | via a `LOG_LIST` do LogManager (rotular o tipo de evento). |
| **Recursos não-gold** (gemas etc.) | outras `CurrencySaveData.Key` (mapear os Keys além de `GOLD_KEY`). |

## Como ler esta tabela ao mexer

- **Adicionar um valor VIVO novo** → siga a metodologia do value-mapping-plan §2/§4 (oráculo →
  estrutura → validar em N runs → persistir → teste sintético) e o guia [[guides/map-new-value]].
  O símbolo do offset mora em `config/offsets.py`, a regra de negócio (qual SubKey/chave significa o
  quê) mora no módulo de lógica — nunca duplique o literal (ver [[invariants/offsets-single-source]]).
- **Onde a fonte degrada** (vivo indisponível → save): a ordem é fixa e o save é o ÚLTIMO recurso;
  carteira/total NUNCA entram. Ver [[invariants/metric-fallback-chains]].
- O orquestrador (`meter_windows.py`) só **chama** estes leitores; ele não lê memória inline. Um valor
  novo entra no record da run via [[guides/add-runs-field]] (+ bump de schema, [[invariants/schema-versioning]]).

## Related
- [[invariants/metric-fallback-chains]] — a ordem LIVE→SAVE→nunca-carteira e o `run_gain==None` no não-monotônico
- [[invariants/gold-singleton-resolution]] — como o AggregateManager (gold vivo) é achado sem depender do nome ofuscado
- [[reference/run-data-map]] — o mapa campo-a-campo do record da run que consome estes valores
- [[reference/damage-model]] — por que o dano é TEAM total e não por-herói
- [[reference/extraction-viability]] — o que dá e o que NÃO dá pra extrair (por que vários TODO seguem TODO)
- [[guides/map-new-value]] — o passo-a-passo pra promover um TODO a VIVO
