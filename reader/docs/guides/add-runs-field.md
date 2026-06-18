---
type: guide
description: "Receita ponta-a-ponta pra adicionar um campo novo ao record de run (raw/<id>.json → logs/<id>.json): decidir o bump (RAW_SCHEMA_VERSION só se a FORMA mudou; aditivo não bumpa; SCHEMA_VERSION=11 é legado congelado) → inicializar em new_run (se acumula) → serializar no build_raw_record → derivar/coagir no conversor+app → tipo opcional. Pular um passo = campo que vaza da run anterior, conversor cego, ou some no app."
code_anchors:
  - meter_windows.py::close_run
  - meter_windows.py::new_run
  - meter_windows.py::RAW_SCHEMA_VERSION
  - meter_windows.py::build_raw_record
  - app/src/main/sources/runs-source.ts
  - app/src/shared/run-types.ts
---

# Guia: adicionar um campo ao record de run (raw → logs)

O reader emite **um `raw/<id>.json` por run** (cru, nunca reescrito); o **conversor** do app
(`converter/convert.ts`) deriva o `logs/<id>.json` estruturado que a UI lê — e registros de
**todas as eras** convivem (o `runs.jsonl` antigo entra só pela migração). Adicionar um campo
toca **5 lugares em ordem** — pule um e o campo vaza da run anterior, deixa o conversor cego,
ou nunca chega ao app. Faça nesta sequência.

## Antes: o campo é de RUN ou de HERÓI?

São dois níveis de record com dois normalizadores distintos — decida primeiro:

- **de run** (vale pra run inteira: `gold_gained`, `deaths`, `drops`): vai no `rec` de
  `close_run` e é normalizado por `normalizeRecord` em `runs-source.ts`.
- **de herói** (por herói deployado: `xp_gained`, `killed_by`, `deaths` por herói): vai em cada
  item de `heroes_out` dentro de `close_run` e é normalizado por `normalizeHero`.

O resto da receita é o mesmo; só muda QUAL dict/normalizador você edita.

## 1. Decida o bump — [[invariants/schema-versioning]]

Dois números moram em **`meter_windows.py`**, com papéis opostos:

- **Mudou a FORMA da saída** (campo que o conversor precisa despachar/interpretar diferente)?
  → bump **`RAW_SCHEMA_VERSION`** (estenda o comentário de histórico ao lado) **+ o dispatch
  correspondente no conversor**.
- **Campo puramente ADITIVO** que o conversor só repassa? → **não bumpa nada**; o campo entra
  OPCIONAL no contrato TS (passo 5).
- **`SCHEMA_VERSION` (=11) é o marco LEGADO congelado do `runs.jsonl`** — o reader não escreve
  mais esse arquivo; bumpá-lo quebra o marco da migração e falha `test_asserts_hold`. NUNCA.

A fonte é ÚNICA: NÃO crie cópia em `config/offsets.py` — ela foi removida de propósito e
`test_version_constants_unique` falha se reaparecer. Bumpar o lugar errado deixa o record real
parado no número velho e o conversor cego pro campo (a clássica bug-class "schema não bumpado").

## 2. Inicialize em `new_run` SE o campo ACUMULA — [[invariants/run-lifecycle]]

`new_run()` é a **fonte única do estado por-run** e devolve o dict zerado. **Regra de ouro:
todo campo que ACUMULA durante a run nasce aqui** — caso contrário o valor da run anterior vaza
pra próxima. Acumuladores já presentes: `drops` (lista), `deaths`/`revives`/`killers` (dicts
heroKey-keyed), `party_seen`. Se o seu campo é um delta/contador/lista que cresce tick-a-tick,
adicione a chave zerada (`[]`, `{}`, `0`) em `new_run` e atualize-a no loop ou nos handlers de
log. Se o campo é **derivado só no fechamento** (calculado de outro estado dentro de
`close_run`), pule este passo.

## 3. Serialize no `rec` de `close_run`

Em `close_run`, o record nasce em **`build_raw_record`** — adicione o campo lá (de run) ou ao
item de herói correspondente, antes do `_write_atomic` que grava o `raw/<id>.json`. Use
snake_case nas chaves do JSON (convenção do record). Para um campo de herói **esparso** (só faz sentido quando não-vazio, ex.: `deaths`,
`killed_by`), siga o padrão existente: **só anexe a chave se o valor for truthy** — o app trata a
ausência como "não rastreado", o que mantém o record enxuto e a semântica honesta.

## 4. Normalize defensivo no app — [[invariants/app-normalization]]

> **Pós-redesign reader↔app:** o app lê os structured **já convertidos** de `logs/` via
> `loadStructured` (`runs-source.ts`) — quem **deriva/sela** um campo novo a partir do raw é o
> **conversor** (`converter/convert.ts`; veredito de qualidade em `converter/helpers.ts`), e o
> `loadStructured` só faz **parse + coerção** (sem re-derivar). `normalizeRecord`/`normalizeHero`
> abaixo seguem sendo os normalizadores do `runs.jsonl` legado, hoje usados **só na migração**
> (`converter/legacy.ts`). As coerções valem para os DOIS (mesmos helpers, mesma semântica de
> "ausente").

Coaja o campo no normalizador certo. Escolha o helper pela semântica do "ausente":

- **numérico genuinamente opcional** (0 ≠ "ausente", ex.: `deaths`/`revives`/`expStart`):
  `firstDefinedNum(...)` → `undefined` quando falta. **Não** use `firstNum` aqui: o default `0`
  mente, vira "zero real" num registro que nunca teve o dado.
- **numérico com default zero** (e/ou múltiplas chaves de era): `firstNum(...)` → `0`.
- **anulável no DTO** (`act`, `stageNo`): `numOrNull(v)` → `null`.
- **string**: `str(v, fallback)`.
- **array tolerante** (`drops`, `killed_by`): `Array.isArray(raw.x) ? raw.x.map(...).filter((e):
  e is T => e !== null) : []` — cada item vira `T | null`, os `null` caem fora; um item
  malformado some, o array sobrevive.

**Padrão do campo opcional:** construa o objeto base (literal com os sempre-presentes) e **anexe o
opcional condicionalmente DEPOIS do literal mas ANTES do `return`** (`if (x !== undefined)
record.x = x`). **NUNCA depois do `return`** — código morto, o campo nunca chega ao DTO. Um
registro antigo que não tem o campo vira `undefined`/vazio, **nunca crash, nunca default errado**;
uma linha que falha na normalização é pulada, não derruba o watcher.

## 5. Tipe como OPCIONAL em `run-types.ts`

Espelhe a escolha do passo 4 no tipo. Em `RunRecord` (run) ou `RunHero` (herói): campo
genuinamente opcional → `field?: T`; anulável explícito → `field: T | null`. Arrays mapeiam as
chaves snake_case do JSON → camelCase no TS (ex.: `killed_by` → `killedBy?: number[]`). Um campo
que não é opcional aqui, mas falta nos registros antigos, força o TS a achar que está sempre
presente — e o app passa a contar com algo que metade das linhas não tem.

## Não precisa mexer aqui

- O dedup na leitura (`dedupeById` + `dedupeSessionScoped` em `runs-source.ts`) usa só campos
  **brutos e estáveis** já existentes (`contentSig`) — um campo novo não entra na assinatura; não
  toque, salvo se o campo novo for ele próprio um critério de dedup. O descarte de `partial`/`skipped`
  **não** está na leitura — quem sela o veredito é o conversor (`convertLegacy` na migração,
  `convert` no raw novo) e quem suprime no upload é o `eligible()`; ver [[invariants/app-normalization]].
- A regra de "30s/x-10" (skip) e a flag `partial` são do ciclo de vida, não da serialização —
  veja [[invariants/run-lifecycle]] se o campo novo interagir com elas.

## Atualize a doc junto

Ao bumpar `RAW_SCHEMA_VERSION` no código, atualize o `assert` em
[[invariants/schema-versioning]] (`RAW_SCHEMA_VERSION == N`) — é o que prova que a base não
ficou pra trás do runtime. (O assert `SCHEMA_VERSION == 11` fica como está: é o marco congelado.)

## Related
- [[invariants/schema-versioning]] — por que o bump é obrigatório e por que a fonte é uma só.
- [[invariants/run-lifecycle]] — `new_run` inicializa todo acumulador; `close_run` é onde o record nasce.
- [[invariants/app-normalization]] — o detalhe das coerções, dos arrays tolerantes e do "anexe antes do return".
Veja também: [[reference/run-data-map]] (o mapa campo-a-campo do record que close_run emite)
