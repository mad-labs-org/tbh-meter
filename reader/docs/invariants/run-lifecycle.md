---
type: invariant
description: "Ciclo de vida da run: o reader INFERE start/fim da memória (LOG_LIST do LogManager cresce; fecha por StageClearLog/StageFailedLog casados por KLASS-POINTER) — boundary detection é DELE — e emite TODA run em raw/<id>.json. Os predicados skip (<30s exc. stage 10) e partial (success c/ captura <80% OU dano<=0) viraram a SPEC de contabilidade aplicada pelo CONVERSOR (app); o reader não descarta mais (skip ≠ sumir). SUCCESS adia só a ESCRITA por PENDING_CLOSE_GRACE (pending-close) pra absorver o boss box que o jogo loga ~0.6s APÓS o clear — senão o baú caía na run SEGUINTE."
symptoms:
  - "run não conta"
  - "run não fecha"
  - "run não aparece"
  - "run curta"
  - "run skipped"
  - "x-10"
  - "stage 10 boss"
  - "captura parcial"
  - "partial dropped"
  - "run does not count"
  - "short run"
  - "baú na run errada"
  - "baú na run seguinte"
  - "blue chest na run abandonada"
  - "boss box wrong run"
  - "chest credited to next run"
  - "drop depois do clear"
code_anchors:
  - meter_windows.py::new_run
  - meter_windows.py::close_run
  - meter_windows.py::_should_skip_run
  - meter_windows.py::_is_partial
  - meter_windows.py::PENDING_CLOSE_GRACE
  - meter_windows.py::TRAILING_BOX_TIERS
  - meter_windows.py::_new_pending
  - meter_windows.py::flush_pending
  - meter_windows.py::_box_belongs_to_pending
  - meter_windows.py::_absorb_drop
  - meter_windows.py::_drop_counts
  - config/offsets.py::LogManager.LOG_LIST
asserts:
  - meter_windows.PENDING_CLOSE_GRACE == 3.0
guarded_by:
  - tests/test_run_lifecycle_predicates.py::TestShouldSkipRun::test_stage_x10_under_30s_is_kept
  - tests/test_run_lifecycle_predicates.py::TestIsPartial::test_zero_damage_success_is_always_partial
  - tests/test_run_lifecycle_predicates.py::TestBoxBelongsToPending::test_boss_box_with_pending_goes_to_pending
  - tests/test_meter_windows.py::TestNewPending::test_deadline_is_now_plus_grace
  - tests/test_meter_windows.py::TestFlushPendingRec::test_flushed_json_contains_absorbed_boxes
  - tests/test_raw_record.py::test_absorbed_boss_box_lands_inside_drops_envelope_without_shape_change
---

# Ciclo de vida da run

Uma **run** é uma tentativa de stage. O reader não recebe evento de "começou/acabou": ele
**infere o ciclo de vida pela memória**, vigiando a lista de logs do jogo a cada tick.

## Boundary: a LOG_LIST do LogManager cresce

A cada tick o loop lê o `size` da lista em `LogManager.LOG_LIST` (a "bíblia" `offsets.py`
marca esse offset como o *boundary de run*). Quando o `size` **cresce**, o reader varre só as
entries NOVAS (`[last_size, size)`) e olha o **klass-pointer** de cada uma (o primeiro qword da
entry = ponteiro pra classe). É esse crescimento que carrega os eventos terminais — não há
sinal de "start" separado: a run seguinte simplesmente começa quando a anterior fecha.

## Fim: StageClearLog (sucesso) / StageFailedLog (falha) por klass-pointer

O fechamento é decidido comparando o klass-pointer da entry nova com `sc_class` /
`sf_class` (resolvidos uma vez para `StageClearLog` e `StageFailedLog`):

- klass == `sc_class` → `close_run("success", ...)` — lê `CLEAR_TIME` do log.
- klass == `sf_class` → `close_run("fail", ...)` — lê wave atual/total do log.

(As mesmas entries também carregam `GetBoxLog`/`HeroDieLog`/`ResurrectionLog`, casados pelo
mesmo padrão de klass-pointer.) Há ainda um terceiro
desfecho — `close_run("abandoned", ...)` — quando o stage recarrega (DeadMonsterUnit cai) ou o
jogador troca de stage sem clarear/falhar, passada a janela de graça inicial.

## Pending-close: o boss box chega DEPOIS do clear (só a ESCRITA do success é adiada)

Provado ao vivo (1.00.11): o jogo loga o **baú de boss** (`GetBoxLog` com `MONSTER_TYPE` em
`TRAILING_BOX_TIERS` — StageBoss/ActBoss) **~0.6s DEPOIS do `StageClearLog`**, num crescimento
SEPARADO da `LOG_LIST`. Como o close já tinha resetado `R`, o baú caía na run **SEGUINTE** —
invisível grindando o mesmo stage, gritante quando a próxima era abandonada (blue chest numa
run "inválida" de 0s, e o clear real sem drop).

A regra: **o fechamento NÃO atrasa** — leituras, métricas, `ts_ms` (a identidade) e o
`new_run()` acontecem no close, como sempre (adiar o close vazaria os primeiros segundos da run
seguinte pro record no auto-replay, pior que o bug). O que muda é que um close `success` **não
escreve o arquivo na hora**: o record fica PENDENTE por até `PENDING_CLOSE_GRACE` e os
`GetBoxLog` de boss que chegarem nesse meio-tempo (até no MESMO batch de entries) são absorvidos
nele (`_box_belongs_to_pending` roteia; `_absorb_drop` muta o value DENTRO do envelope ok de
drops — `build_raw_record` não copia a lista, então é isso que sai no JSON). Gray (mob, tier
`Monster`) dropa DURANTE a stage → segue indo pra `R["drops"]` da run atual. Boss box **sem**
pendente (ex.: anexou logo após um clear) → run atual + WARN no meter.log; um baú real nunca é
descartado. `fail`/`abandoned` escrevem na hora (boss box só segue clear).

O estado pendente nasce em `_new_pending` (rec + path + deadline `now + PENDING_CLOSE_GRACE` +
lista fresca de absorvidos — o construtor é compartilhado com os testes pra forma não driftar).
`flush_pending` escreve o pendente (mesma escrita atômica) e roda em **todos** os pontos de
saída da janela: deadline vencida, checada APÓS a varredura da `LOG_LIST` do tick (um boss box
que aflora no MESMO tick da expiração ainda é absorvido — janela efetiva `PENDING_CLOSE_GRACE`
+ ≤1 tick); **topo do `close_run`** (qualquer status — ordem dos records preservada, nunca dois
pendentes); o caminho de game-closed/re-attach (o pendente é uma run COMPLETA — o jogo fechar
logo após o clear não pode sumir com ela); e o finally do `run()`. Trade-off ACEITO: um kill
duro (AV SIGKILL) dentro da janela perde esse record. **Live**: a contagem de baús do live.json soma run atual + ABSORVIDOS (`_drop_counts`)
— o boss box atrasado SOBE a contagem com o `stage_key` vivo ainda no stage clareado (o
rising-edge que o cooldown-tracker/drop-notifier do app detectam); pós-flush ela cai (baseline
no app, sem evento). Os drops completos do record pendente NÃO entram (os grays dele ficariam
pendurados no overlay).

## SKIP — `_should_skip_run(measured, clear_time, stage)` (hoje a SPEC do conversor)

Run curta **não CONTA** no leaderboard — mas **o reader NÃO a descarta mais**: ele emite TODA run
em `raw/<id>.json` (skip ≠ sumir; senão o user acha que o meter quebrou e o app não consegue marcá-la
como "ignorada"). Quem aplica a contabilidade é o **conversor** (app), sobre os campos crus do record.
`_should_skip_run` segue aqui como a **spec canônica drift-testada** (o conversor a porta pro TS) e
**não é mais chamada** no caminho de emissão. A regra real é:

```
max(measured, clear_time or 0) < 30  AND  stage != 10
```

A exceção `stage != 10` mantém o **x-10** (luta só de boss, que pode durar segundos). **Cuidado:
`stage` aqui é o NÚMERO do stage (`StageNo`), NÃO o `EStageType.ACTBOSS`.** São sinais
DIFERENTES: o `EStageType` é um *tipo* de stage (valor 1) lido de outro offset; o predicado
compara o número `10` (o `si[1]` derivado do catálogo). Não troque um pelo outro — usar o tipo
em vez do número aqui faria runs x-10 normais serem descartadas.

**Floor no conversor = 15s** (constante TS, não-tunável). O `< 30` aqui é o valor histórico do
reader, que o port revisita pra **15s**; o que o port NÃO pode perder é a **exceção x-10**
(`stage != 10`) — esse é o invariante de verdade, não o número do floor.

## PARTIAL — `_is_partial(status, clear_time, measured, total_damage)`

Captura **PARCIAL** = o meter entrou numa run **já em andamento** (subcontou dano/gold/xp). Já
**não vai no record** (`partial` saiu do raw): o **conversor** a deriva dos campos crus emitidos
(`run_outcome`, `clear_time`, `duration`, `total_damage`) — mesma fórmula — e sela no `status`. O
reader ainda computa `partial` só pra anotar o summary/console. A regra real (que o conversor porta) é:

```
status == "success"  AND  (
    (clear_time >= 30 AND measured < clear_time * 0.8)   # entrou no meio
    OR total_damage <= 0                                  # success sem dano = captura perdida
)
```

Dois pontos que a skill drifou e que a VERDADE (o código + `tests/test_run_lifecycle_predicates.py`)
contradiz:

- a segunda cláusula é **`total_damage <= 0`**, NÃO `== 0`. Qualquer dano não-positivo num
  success é captura perdida (o jogo não limpa stage sem dano). Isso cobre o gap das x-10 com
  `clear_time < 30` que pulavam a 1ª cláusula e subiam 0-de-tudo pro leaderboard (#163).
- o trava `clear_time >= 30` na 1ª cláusula é de propósito: runs x-10 (boss, segundos) não
  podem ser mal-marcadas como parciais — por isso só `<= 0` as pega.

## new_run() inicializa TODO o estado por-run

`new_run()` é a fonte ÚNICA do estado de uma run e devolve o dict zerado: `dps` (DpsTracker
novo), `mobs`, `start`, as baselines de gold (`gold_start`/`gold_live_start`/`gold_save_start`),
`heroes_start`, party viva (`party_live_start`) + o acumulador vivo de xp (`xp_acc`, semeado
com a party do t=0 — ver [[invariants/metric-fallback-chains]]), `build`, `drops`,
`party_seen`, `deaths`/`revives`/`killers`, `stage_key` e `adopt_until`. **Regra de ouro: todo
campo que ACUMULA durante a run (delta de gold/xp, mortes, drops) tem que nascer aqui** — senão
o valor vaza da run anterior. Ao adicionar um campo de run novo, inicialize em `new_run` E
emita no `build_raw_record` (ver [[invariants/schema-versioning]] e [[guides/add-runs-field]]).

## Related
- [[invariants/instance-selection]] — o fim de run depende da LOG_LIST do LogManager VIVO; se o pick pegou a lista morta, `size` nunca cresce e NENHUMA run fecha.
- [[invariants/schema-versioning]] — campo de run novo: bump do `SCHEMA_VERSION` + init no `new_run` + serialize no `close_run`.
- [[invariants/log-event-detection]] — o casamento por klass-pointer das entries novas da `LOG_LIST` (o que dispara o fechamento).
- [[reference/run-data-map]] — o shape do record que `close_run` emite, campo a campo.
- [[guides/add-runs-field]] — a receita ponta-a-ponta de adicionar um campo à run.
