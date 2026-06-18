---
type: process
description: "O contrato id-based do raw/<id>.json: o reader emite IDs estáveis (itemKey, statId, heroKey, stageKey, uniqueId, box_key, monsterKey) e o front resolve display-names via web/src/data/*.json. Nenhum nome de display é a IDENTIDADE; labels que ainda saem são redundância transitória. A identidade da RUN é o horário de fim (raw v2; sem session_id/run — Redesign 2)."
code_anchors:
  - meter_windows.py::close_run
  - meter_windows.py::run
  - game/build.py::read_build
  - game/build.py::read_stats_dict
  - meter_windows.py::_read_catalogs
  - app/src/shared/run-types.ts
asserts:
  - meter_windows.SCHEMA_VERSION == 11
---

# Contrato de dados id-based (raw/<id>.json)

O output do reader — hoje **`raw/<id>.json`** (1 arquivo por run; antes `runs.jsonl`, agora legado) —
é **id-based**: a identidade de cada coisa é um **int estável do jogo** — `itemKey`, `statId`,
`heroKey`, `stageKey`, `classId`, `gradeId`, `slotId`, `recipeId`, `uniqueId` (chave natural
por-instância do item, emitida como STRING lossless), `box_key`/`monster_type` (drops), `monsterKey`
(quem matou um herói). A IDENTIDADE da run é o horário de fim dela (raw v2; ver invariantes abaixo). O **front** (`web/src/data/*.json` — `items.json`,
`heroes.json`, `stages.json`, etc., resolvidos por `web/src/lib/data.ts`) é quem traduz id →
display-name. Origem do contrato: `docs/refactor-roadmap.md`, seção "DATA CONTRACT" ("server NEVER
stores/returns display names; front resolves names from catalogs").

**Por que id, não nome.** Nomes de display são labels do front (enums localizáveis, renomeáveis a
cada patch); o id é a chave de junção/agregação no DB e o que sobrevive a um rename do jogo. Guardar
o nome no record (a) duplica dado mutável, (b) quebra o join quando o front re-localiza, (c) infla o
JSON. O DB ingere os ids e projeta — agregação por `stage_key`/`class_id`/`hero_key`, catálogos
(`catalog_*`) à parte. Os 64 stats foram o caso-piloto: passaram a sair **só** como `{statId:
valor}` (id-only), o que de quebra fechou o gap do label `STATN` que parava em 59 (stats 60-63 viravam
`stat60..63` genéricos).

## O estado REAL é HÍBRIDO (leia antes de "limpar")

A regra é id-based, mas o output de HOJE ainda **emite alguns labels ao lado do id** — não confunda
"o contrato" com "o que o reader já parou de mandar":

- **id-only de verdade:** `stats` (`{statId: valor}`, em `read_stats_dict`).
- **id + label redundante:** o item carrega `slotId`+`slot`, `gradeId`+`grade`; o mod carrega
  `recipeId`+`recipe`, `statId`+`stat`; o herói carrega `classId`+`class` (montados em `read_build`).

O docstring de `game/build.py` é explícito: esses labels seguem preenchidos para a saída **bater
byte-a-byte com o monólito no cutover**, e **dropá-los é um schema-bump futuro**. Ou seja: o id é a
identidade (sempre presente, sempre a chave); o label é vestígio transitório. Um agent que **adicione**
campo deve emitir o **id** como verdade — não inventar um novo campo de nome-de-display. Quem **remover**
os labels existentes está fazendo uma mudança de contrato → bump `SCHEMA_VERSION` + coordenar o front.

## Invariantes deste contrato (o que NÃO pode quebrar)

- **O record nunca é a fonte do nome.** Campo novo = id (ou número). Resolução de nome mora no front.
- **`uniqueId` é a identidade por-instância do item** (chave natural do DB); `itemKey` é o tipo. Não
  troque um pelo outro.
- **A IDENTIDADE da run é o HORÁRIO de fim dela (raw v2: `id = str(ts_ms)`).** Sequencial por máquina →
  nunca colide, sem session nem contador. (ANTES: `session_id:run` cunhado pelo reader — reciclava no
  restart e sumia a run; removido no Redesign 2.) **Session NÃO é mais do reader** — o app a DERIVA das
  runs (gap 6h + cortes). Upload: `external_id = device:ts` (único global). Ver `progress.md` "Redesign 2".
- **Ids têm faixa de sanidade** na fonte (`heroKey`/`itemKey` em `0 < k < 10_000_000`, ver
  `_read_catalogs`/`read_live_stats_by_hero`) — lixo de memória não vira id.
- **Casing**: o JSON usa as chaves originais (`heroKey`, `stageKey`); a normalização snake_case
  (`heroKey→hero_key`) é no boundary de ingest do DB, não no reader. No app, o mapeamento
  snake_case→camelCase é parte da normalização defensiva.

## Como agir sob este contrato

- **Adicionou um datum que tem id no jogo?** Emita o id (e, se útil hoje, o label ao lado como os
  outros — mas o id é obrigatório). Siga a receita de [[guides/add-runs-field]] e o bump de
  [[invariants/schema-versioning]]; tipe/normalize defensivo no app ([[invariants/app-normalization]]).
- **Vai exibir o nome?** Resolva no front via `web/src/data/*.json`; não peça ao reader pra mandar o
  nome. O reader, no máximo, exporta os **catálogos** (id→atributos) — é o `--dump-catalogs` planejado,
  cuja matéria-prima já existe em `meter_windows.py` (`_read_catalogs`, que deriva stage_info/item_cat/hero_cat)
  e nos enums de `config/offsets.py`.

## Related
- [[invariants/schema-versioning]]
- [[invariants/app-normalization]]
Veja também: [[guides/add-runs-field]] (a receita ponta-a-ponta) · [[reference/run-data-map]] (o mapa id→leitor)
