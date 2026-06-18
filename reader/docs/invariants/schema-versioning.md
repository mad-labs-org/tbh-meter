---
type: invariant
description: "Versão é fonte única em meter_windows.py: RAW_SCHEMA_VERSION (formato VIVO de raw/<id>.json, bumpa quando a SAÍDA do reader muda) + SCHEMA_VERSION (=11, runs.jsonl LEGADO congelado, marco da migração). Mudou a FORMA de um campo do raw? bump RAW_SCHEMA_VERSION + dispatch no conversor. Campo NOVO aditivo que o conversor ignora NÃO bumpa — entra OPCIONAL no contrato TS. Nunca bumpar por build do jogo nem uma cópia morta."
symptoms:
  - "adicionar campo no runs.jsonl"
  - "novo campo na run"
  - "schema não bumpado"
  - "schema not bumped"
  - "app não normaliza"
  - "campo não aparece no app"
  - "bump schema version"
code_anchors:
  - meter_windows.py::RAW_SCHEMA_VERSION
  - meter_windows.py::SCHEMA_VERSION
  - meter_windows.py::build_raw_record
  - app/src/shared/raw-types.ts
  - app/src/shared/run-types.ts
asserts:
  - meter_windows.RAW_SCHEMA_VERSION == 2
  - meter_windows.SCHEMA_VERSION == 11
---

# Versionamento do output do reader

Hoje o reader emite **`raw/<id>.json` — 1 arquivo por run**, carimbado com **`RAW_SCHEMA_VERSION`**;
o conversor (app) faz *dispatch* por esse valor. **Mudou a FORMA da saída do reader** (campo novo,
campo que mudou de forma)? **bumpe `RAW_SCHEMA_VERSION`** — e **só** isso: NÃO bumpe por build do
jogo (re-seed/endereço não muda a forma). O `runs.jsonl` antigo (append-only, schema misto) é
**LEGADO**: o reader não escreve mais; `SCHEMA_VERSION` ficou **congelado em 11** como o marco que a
migração do conversor usa pra ramificar a leitura dos registros velhos (`≤11`).

**v2 (Redesign 2):** o raw v2 mudou a IDENTIDADE da run — `id` = o horário de FIM em **ms** como string
(`str(ts_ms)`), `ts` em ms, **sem `session_id` nem `run`** (a session é derivada pelo app). Mata a classe
de bug do `run_num`-reset (id reciclava no restart → run nova sumia). Ver `tbh-meter/progress.md` "Redesign 2".

**Exceção ADITIVA (estabelecida no snapshot de conta — `runes`/`inventory`/`stash`):** campo **NOVO**
que o conversor ainda **não consome** NÃO bumpa a versão — entra **opcional** no contrato TS
(raw antigo não o tem; o consumidor detecta pela PRESENÇA da chave, não pela versão) e o conversor
o ignora (lê por nome; chave desconhecida não muda o output). Bumpar sem dispatch novo no conversor
só carimbaria `issues.raw_schema_version = "unsupported …"` em toda run nova, sem ganho. **Bumpe**
quando a FORMA/significado de um campo EXISTENTE muda, um campo some/renomeia, ou o conversor
PRECISA ramificar por versão pra consumir a mudança.

**As duas versões são fonte ÚNICA em `meter_windows.py`** (`RAW_SCHEMA_VERSION` vivo, `SCHEMA_VERSION`
legado) — é lá que o record é carimbado. Havia uma cópia MORTA e defasada em `config/offsets.py`
(`=5` enquanto o runtime emitia 11): foi removida, e `test_docs_consistency::test_version_constants_unique`
falha se reaparecer. NÃO trate a "bíblia" (offsets.py) como fonte da versão — bumpar o lugar errado
deixa o record real parado e o conversor cego pro campo novo ("schema não bumpado").

**Receita pra adicionar/mudar um campo do raw:**
1. bump `RAW_SCHEMA_VERSION` **se a mudança não cai na exceção aditiva acima** (mudou forma/sumiu/
   precisa de dispatch → bump; campo novo ignorado pelo conversor → sem bump, opcional no contrato).
   Ao bumpar, atualize os comentários ao lado dele e do `SCHEMA_VERSION`;
2. emita o campo no `build_raw_record` — em **envelope ok/err** se for leitura que pode falhar — e **inicialize em `new_run`** se ele acumula durante a run;
3. **contrato**: reflita o campo em `app/src/shared/raw-types.ts` (`RawRunV2`), com a MESMA chave/casing do wire (ids, não nomes — [[process/data-contract-id-based]]);
4. **conversor (app, TS)**: trate-o no `convert()` ramificando por `raw_schema_version`; derivados (dps/taxas/nomes) NÃO voltam pro reader.

O drift-test assere `RAW_SCHEMA_VERSION == 2` e `SCHEMA_VERSION == 11`: ao bumpar no código,
atualize esta nota junto — é o que prova que a base não ficou pra trás do runtime.

## Related
Veja também: [[invariants/run-lifecycle]] (init de campo no new_run) · [[invariants/app-normalization]] · [[guides/add-runs-field]]
