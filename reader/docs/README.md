# docs/ — base de conhecimento do reader (como usar e manter)

Esta pasta é um **skill-graph**: um índice → notas pequenas interligadas → o código.
O objetivo é que qualquer agent que vá mexer no reader ache **o invariante certo, na
hora certa**, e não repita os bugs que já nos pegaram (dict stride trocado, nome
ofuscado, schema não bumpado, runs que não fecham, ObscuredInt, cache stale).

## Como um agent acha o que precisa (progressive disclosure)

Três níveis — você carrega só o que precisa, nunca a base inteira:

1. **Índice** (`_index.md`) — lido primeiro. Catálogo por tipo **+ um bloco "Por
   sintoma/tarefa"** no topo. A recuperação é **lexical** (o `grep`/`Read` do agent —
   igual à busca do Obsidian, sem embeddings), então o índice e cada nota carregam o
   **vocabulário do sintoma** (`runs não fecham`, `gold dobrado`, `1.97T`), não só o nome
   do domínio. `grep -ri "<sintoma ou símbolo>" docs/` cai direto na nota.
2. **Nota** — uma por invariante/fato. Lê só a do que vai tocar; segue `## Related`
   pra vizinhança co-obrigatória (ex.: mexer no gold puxa stride + fallback + cache).
3. **Código** — a nota aponta `code_anchors` (arquivo::símbolo). **A verdade mora no
   código** (`config/offsets.py` + os `tests/`). A nota é um ponteiro, nunca a fonte.

## Tipos de nota (`type` no frontmatter)

| tipo | papel | obrigatórios | drift-tested? |
|------|-------|--------------|---------------|
| `invariant` | regra dura (quebrou = dado errado/crash) | `description`, `code_anchors`, `symptoms` | ✅ |
| `reference` | fatos: offsets, mapa de campos, modelo de dano | `description`, `code_anchors` | ✅ |
| `guide` | como fazer uma mudança recorrente | `description` | ✅ |
| `process` | metodologia (mapear/validar um valor) | `description` | parcial |
| `archive` | histórico: planos entregues, RE cru | `description`, `status` | ❌ (snapshot) |

## Frontmatter

```yaml
---
type: invariant
description: "Uma linha rica — o que é + por que importa (>= 20 chars)."
symptoms: ["runs não fecham", "not closing", "gold dobrado"]   # PT+EN, o que o agent grepa
code_anchors:                       # arquivo::símbolo — resolvido por AST contra o código
  - meter_windows.py::_pick_list_singleton
  - config.offsets::Dict8B.STRIDE   # ::Classe.ATTR também resolve
asserts:                            # valores load-bearing checados contra o código real
  - meter_windows.SCHEMA_VERSION == 11
  - config.offsets.DictFloat.STRIDE == 0x10
guarded_by:                         # teste de comportamento que prova a regra (tem que existir)
  - tests/test_meter_windows.py::TestPickListSingleton::test_picks_largest_valid
related: ["[[invariants/dict-strides]]", "[[invariants/metric-fallback-chains]]"]
---
```

## Regras (impostas por `tests/test_docs_consistency.py`)

- **A verdade é o código.** `code_anchors` resolvem por **AST** (não substring →
  comentário não dá falso-verde). `asserts` comparam o **valor** com o literal real.
  Regra comportamental → aponte um teste em `guarded_by`.
- **Nunca copie a skill nem outra nota** ao migrar: a skill já drifou
  (`partial` era `== 0`, o código é `<= 0`; "X-10" era flag, o código é `stage != 10`).
  Re-verifique cada regra **contra o código**.
- **Sem número-de-linha no corpo** (`arquivo.py:NN` rota) — use `code_anchors`.
- **`reference` cita o SÍMBOLO de `offsets.py`, nunca o literal `@0x`** (dessincroniza).
- **`invariant` só existe com `code_anchors` que resolvem a símbolo presente** — senão
  é `process`/`archive`, não invariant.
- **Cross-repo (app):** anchors `app/...` (TS) são checados só como "arquivo existe",
  tolerantes a checkout só-do-reader.
- **`archive/`:** SNAPSHOT — nomes podem estar obsoletos; isento dos checks de código.
  Use um header avisando e remeta à nota viva equivalente.

> A skill `/tbh-meter-review` é o **portão**: ela manda ler `docs/_index.md` + a(s)
> nota(s) do que vai mudar, e rodar os testes de código + este `test_docs_consistency`.
> O detalhe dos invariantes mora aqui (fonte única), não duplicado na skill.
