---
type: invariant
description: "meter_windows.py é um ORQUESTRADOR fino: não lê memória inline fora do scaffolding (loop de log-event, validação de manager, re-attach); métrica/captura nova mora em metrics/ ou game/, offset só em config.offsets. agent_windows.py é o entry-point IRMÃO de debug, self-contained."
symptoms:
  - "onde colocar nova métrica"
  - "onde adicionar captura nova"
  - "where to add a new metric"
  - "leitura inline no orquestrador"
  - "inline memory read in orchestrator"
  - "reader.ri32 no meter_windows"
  - "rptr/ri64/read_string solto no meter_windows"
  - "magic number no meter_windows"
  - "qual é o entry-point de produção"
  - "meter_windows vs agent_windows"
code_anchors:
  - meter_windows.py
  - meter_windows.py::run
  - meter_windows.py::_pick_list_singleton
  - agent_windows.py
  - agent_windows.py::op_dump
guarded_by:
  - tests/test_run_lifecycle_predicates.py::TestIsPartial::test_zero_damage_success_is_always_partial
---

# Pureza do orquestrador (meter_windows.py é fino)

O reader tem **dois entry-points na raiz**, e eles têm papéis OPOSTOS — não confunda:

- **`meter_windows.py` — PRODUÇÃO.** É o que o CI congela em `tbh-reader.exe` e o app Electron
  spawna como sidecar. Escreve `raw/<id>.json` (record CRU por run → o conversor do app vira
  `logs/<id>.json`) + `live.json` (snapshot CRU da run atual, sobrescrito ~1x/s → o app cozinha o
  overlay) + `meter.log`. Emite **CRU pros dois fluxos**; toda derivação (dps/label/format) é do app
  ([[invariants/metric-fallback-chains]] + progress.md "Live-meter"). **É um orquestrador FINO** (o
  próprio docstring do módulo: *"Orquestrador FINO: ZERO leitura de memória inline"*).
- **`agent_windows.py` — DEBUG/inspeção, self-contained.** Você roda UMA vez à mão, com o jogo
  aberto, e ele fica escutando `output/agent_cmd.json` → executa um `op_*` → responde em
  `output/agent_resp.json`. É um inspetor de memória (caçar offset, decodificar ObscuredX, achar
  carteira). NÃO entra em build nenhum. Mexer aqui não muda o produto.

**A regra (vale só pro produção, `meter_windows.py`):** o orquestrador monta UM `shared.memory.Reader`
e **delega** tudo às lógicas isoladas — `shared.memory` (anexar/regiões/scan), `il2cpp` (resolver
classes), `game.*` (domínio: save/build/models), `metrics.*` (gold/xp/dps/events). Os offsets vêm
**só** de `config.offsets` (a "bíblia"). Logo: **métrica ou captura NOVA mora em `metrics/` ou
`game/`, NUNCA inline no `run()`.** E **nenhum offset literal** (`0x…`) no `meter_windows.py` — ele
importa o símbolo de `config.offsets`.

## O que é "scaffolding" (a exceção legítima)

Leitura inline de memória (`reader.rptr`/`ri32`/`ri64`/`read_string`) NO `meter_windows.py` só é
aceitável no **andaime do ciclo de vida da run**, que é responsabilidade do orquestrador e de
ninguém mais:

- **Loop de detecção de log-event** (no `run()`): varre o `LogManager.LOG_LIST` novo a cada tick e
  classifica cada entry pela classe-K (`StageClearLog`/`StageFailedLog`/`GetBoxLog`/`HeroDieLog`/
  `ResurrectionLog`) p/ disparar `close_run`/drops/mortes/revives. Isso É orquestração de ciclo de
  vida — ver [[invariants/run-lifecycle]] (e a detecção de log-event).
- **Validação estrutural de manager** (`_pick_list_singleton`/`_valid_list_size`): escolher a
  instância viva do `LogManager`/`MonsterSpawnManager` entre os falsos-positivos do scan — ver
  [[invariants/instance-selection]].
- **Detecção de re-attach / reload de stage**: ler o `LOG_LIST`/`DeadMonsterUnit` p/ saber que o
  jogo fechou (reads falhando) ou que o stage recarregou.

Repare que mesmo esse andaime **NÃO inventa offset**: usa `List.SIZE`/`List.ITEMS`/`Array.DATA` etc.
de `config.offsets` ([[invariants/offsets-single-source]]).

## Por que isto é um invariante (não só estilo)

Sintoma do anti-padrão: você precisa de um valor novo (ex.: um novo agregado, um novo stat por
herói) e **coloca a leitura inline no `run()`** — ou cravando um `@0x` literal, ou misturando o
parse com o loop. Resultado: a lógica fica **não-testável** (presa num `while True` que toca a
memória do jogo, que não roda no Mac), o offset **dessincroniza** de `config.offsets`, e o
orquestrador incha até o ponto em que ninguém mais entende o ciclo de vida.

A prova de que a fronteira funciona: **as decisões puras que o orquestrador legitimamente possui
são extraídas como funções puras e testadas em isolamento** — `_should_skip_run`, `_is_partial`,
`_pick_list_singleton`, `_read_catalogs` (sem tocar processo nenhum, rodam no Mac via `MockReader`).
Foi exatamente assim que o drift do `_is_partial` (a skill dizia `== 0`, o código é
`total_damage <= 0`) ficou **coberto por teste** em vez de virar bug silencioso. Se uma "métrica"
sua não dá pra testar assim, ela está no lugar errado — vai pra `metrics/` ou `game/`.

**Onde colocar a coisa nova:**
- nova métrica derivada (dano/dps/xp/gold/progress) → `metrics/` (ela recebe o `reader` e lê lá).
- novo dado de domínio (save/party/build/monstros/stage-key) → `game/`.
- nova classe/instância a resolver → `il2cpp/resolver` (e o `TARGETS`/fast-path do orquestrador).
- novo offset → **só** `config.offsets`; o `meter_windows.py` importa o símbolo.
- o `meter_windows.py` então **chama** a função nova e costura o resultado no `rec`/overlay.

## Related
- [[invariants/offsets-single-source]] — o orquestrador importa offset, nunca crava `0x…`.
- [[invariants/instance-selection]] — a validação de manager é o scaffolding legítimo.
- [[invariants/run-lifecycle]] — o loop de log-event é orquestração de ciclo de vida.
Veja também: [[invariants/log-event-detection]] (como o loop classifica cada entry por classe-K) · [[invariants/metric-fallback-chains]] (a métrica nova entra com sua cadeia de fallback) · [[invariants/memory-safety]] (o reader nunca-raises que o andaime assume) · [[guides/map-new-value]]/[[guides/add-runs-field]] (a receita ponta-a-ponta de "valor novo") · [[invariants/obscured-data-offlimits]] (o agent_windows op_obs é o único lugar que decodifica ObscuredX)
