---
type: invariant
description: "O app lê os structured já convertidos de logs/ (loadStructured — parse + coerção defensiva, SEM re-derivar) e dedupa por id + session-scoped; coerções firstNum/numOrNull/str, campo novo opcional (field?: T) anexado ANTES do return — nunca crasha num registro antigo, nunca grava default errado. normalizeRecord sobrevive só como helper do caminho de MIGRAÇÃO (convertLegacy)."
symptoms:
  - "normalizar campo"
  - "normalize field"
  - "campo undefined no app"
  - "field undefined in app"
  - "campo não aparece no app"
  - "runs-source"
  - "app lê logs"
  - "loadStructured"
  - "dedup"
  - "dedup de runs"
  - "dedup session-scoped"
  - "app crasha em run antiga"
  - "run antiga sem campo"
code_anchors:
  - app/src/main/sources/runs-source.ts
  - app/src/main/converter/convert.ts
  - app/src/shared/run-types.ts
---

# Normalização de campos no app

Desde o redesign reader↔app o app **lê de `logs/`** (um `logs/<id>.json` por run, **já convertido
uma vez** pelo conversor — ver [[invariants/schema-versioning]] e o `convert.ts`). O caminho de
leitura é `loadStructured` em `runs-source.ts`: ele **só faz parse + coerção defensiva**, **NÃO
re-deriva** nada — o conversor já desembrulhou o envelope `{ok,value}`, derivou `dps`/taxas e selou
o veredito de qualidade. Cada run lida é da **mesma era** (a saída uniforme do conversor), não mais
o `runs.jsonl` de eras misturadas.

A regra de coerção continua valendo (o structured ainda é um JSON em disco que pode estar velho ou
corrompido): **cada campo é coagido defensivamente** — um log antigo (ex.: um espelho pré-redesign,
sem `quality`/`issues`) a quem falte um campo vira `undefined`/`null`/default-vazio, **nunca um crash
e nunca um default errado**. Um arquivo que não parseia, ou que não tem `id` (`loadStructured` →
`null`), é **pulado**, não derruba o watcher.

> O `runs.jsonl` **legado** (append-only, schema misto) ainda existe, mas **não é mais o caminho de
> leitura** — ele só é consumido **uma vez** na **migração** (`converter/legacy.ts`, via
> `normalizeRecord`), que adota cada linha antiga em `logs/` preservando o `external_id`.

## As coerções (a fonte é `runs-source.ts`)

Os helpers em `runs-source.ts` codificam a intenção de cada tipo de campo — escolha o certo:

- `firstNum(...vals)` — primeiro número finito, **`0`** se nenhum. Para campos numéricos com
  default zero e/ou múltiplas chaves de era (ex.: `total_damage` v6 / `dano_total` v5).
- `firstDefinedNum(...vals)` — igual, mas **`undefined`** (não `0`) quando não há candidato.
  Para um campo **genuinamente opcional** onde `0` ≠ "ausente" (ex.: `expStart`, `deaths`).
- `numOrNull(v)` — número finito ou **`null`**. Para campos anuláveis no DTO (`act`, `stageNo`…).
- `str(v, fallback="")` — string ou fallback. `normalizeStatus` mapeia as strings PT (≤v5) e
  EN (v6) para a union interna.

**Escolher `firstNum` (default `0`) onde o campo é opcional mente** — vira `0` num registro que
nunca teve o dado, e o agent não distingue "zero real" de "não rastreado". Por isso `deaths`/
`revives`/`expStart` usam `firstDefinedNum`: presente = rastreado (0 é significativo), ausente =
era anterior. Espelhe essa escolha no tipo: o campo TEM que ser **opcional** (`field?: T`) em
`run-types.ts` — anuláveis explícitos são `T | null`, opcionais são `field?: T`.

## Arrays e campos opcionais — o padrão exato

- **Array tolerante**: `Array.isArray(raw.x) ? raw.x.map(...).filter((e): e is T => e !== null) : []`.
  Cada elemento é normalizado para `T | null` e os `null` caem fora — um item malformado some,
  o array sobrevive (ver `skills`, `drops`, `killed_by`, `items.mods` em `runs-source.ts`).
- **Campo opcional**: construa o objeto base (literal com os campos sempre-presentes) e **anexe
  o opcional condicionalmente DEPOIS do literal mas ANTES do `return`** (`if (x !== undefined)
  obj.x = x`). **NUNCA anexe um campo após um `return`** — código morto, o campo nunca chega ao
  DTO. Em `normalizeRecord`/`normalizeHero` os opcionais (`drops`, `deaths`, `revives`,
  `skillLevels`, `expStart`…) seguem exatamente esse formato.

## Dedup na leitura (session-scoped, nunca esconde farm)

No carregamento de `logs/`, o `reload` de `runs-source.ts` ordena newest-first e roda **dois**
colapsos, ambos por funções puras testáveis no mesmo módulo:

1. `dedupeById` — colapsa logs que compartilham o **`id`** (a identidade única da run): dois
   arquivos com o mesmo id são a MESMA run gravada 2× (uma re-finalização sob outro `ts` → outro
   nome de arquivo). Mantém o primeiro (= o mais novo, pós-ordenação). Sempre seguro (mesmo id =
   mesma run).
2. `dedupeSessionScoped` — colapsa o **phantom de dois readers**: conteúdo idêntico **só entre
   `sessionId` DIFERENTES** (ver [[invariants/schema-versioning]] e o design "Dedup"). A assinatura
   (`contentSig`) usa só campos **brutos e estáveis** — nunca os derivados `dps`/`duration` nem o
   `ts`, que driftam entre duas finalizações. Um **farm** (runs distintas na MESMA session, mesmo
   que pareçam idênticas) **nunca** colapsa → zero false-hide do grind.

**Partial/skip NÃO é mais um descarte na leitura.** Quem julga contabilidade é o **conversor**: ele
sela `quality` (`counted`/`skipped`/`partial`/`degraded`) no structured (`classifyQuality` em
`converter/helpers.ts`); o app **mostra toda run** e **esconde** as não-`counted` por um **filtro de
UI** (toggle "mostrar ignoradas"), não apagando nada (skip ≠ sumir). O upload checa o mesmo veredito
(só `counted` sobe — `auto-upload.ts`).

`normalizeRecord` (ainda em `runs-source.ts`) **NÃO** está no caminho de leitura — sobrevive como
helper **só de migração** (`converter/legacy.ts`, via `convertLegacy`), que adota cada linha antiga
em `logs/` e **sela o veredito** (`quality`/`partial`) por `classifyQuality` (`converter/helpers.ts`),
o MESMO veredito da conversão de um raw novo. A supressão de `partial`/`degraded`/`skipped` de
`success` é do **gate de upload** (`eligible()` em `auto-upload.ts`) **+ o filtro de UI** — **não**
mais um descarte na leitura (e nunca por `goldGained === 0`, que escondia runs COMPLETAS com leitura
de gold falha).

> O número de gold em si (o "2x", depois "0") é problema do **reader**, resolvido lá por liveness
> (`metrics/gold.py`). O app **confia** no gold do reader e nunca tenta adivinhar o valor.

## Related
- [[invariants/schema-versioning]]
Veja também: [[guides/add-runs-field]] (a receita ponta-a-ponta: bump → close_run → normalizador → tipo)
