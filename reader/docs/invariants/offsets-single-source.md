---
type: invariant
description: "Todo offset/enum/stride estrutural mora em config/offsets.py (fonte única); constante de REGRA DE NEGÓCIO mora no módulo da lógica (ex.: COMBAT_SUBKEY em metrics/gold.py); SCHEMA_VERSION/GAME_VERSION moram em meter_windows.py — nunca duplicar."
symptoms:
  - "offset errado"
  - "wrong offset"
  - "onde fica o offset"
  - "gold corrompido"
  - "stats errados"
  - "constante no arquivo errado"
  - "magic number espalhado"
  - "duas fontes de verdade"
  - "two sources of truth"
  - "schema bumpado no lugar errado"
  - "version definido em dois módulos"
  - "test_version_constants_unique falhou"
code_anchors:
  - config/offsets.py
  - metrics/gold.py::COMBAT_SUBKEY
  - meter_windows.py::SCHEMA_VERSION
asserts:
  - config.offsets.Dict8B.STRIDE == 0x18
  - config.offsets.DictFloat.STRIDE == 0x10
  - config.offsets.GOLD_KEY == 100001
  - metrics.gold.COMBAT_SUBKEY == 1
guarded_by:
  - tests/test_docs_consistency.py::test_version_constants_unique
---

# Fonte única de offsets (e onde NÃO botar uma constante)

`config/offsets.py` é **a bíblia de offsets**: o único lugar onde mora cada offset de campo,
enum e **stride** estrutural do jogo (todos derivados do dump IL2CPP e validados ao vivo). Um
agent que vá ler um campo novo **lê o símbolo daqui**, nunca crava um literal `@0x` no meio da
lógica — um número solto desincroniza em silêncio quando o build muda, e ninguém acha a segunda
cópia pra atualizar. Adicionar um campo = adicionar a classe/atributo aqui e referenciar o
símbolo (`UnitHealthController.HP_CURRENT`, `Dict8B.VALUE`), não o offset cru.

**O que NÃO mora aqui — e por quê.** O próprio cabeçalho de `offsets.py` avisa: *"as constantes
de regra de negócio (curva, filtros) NÃO moram aqui — só offsets/enums"*. Duas categorias têm
dono diferente:

- **Regra de negócio** (que SubKey/curva/filtro significa o quê) mora no **módulo da lógica**,
  ao lado de quem a usa. Exemplo cravado: `COMBAT_SUBKEY = 1` e `TOTAL_SUBKEY = 0` moram em
  `metrics/gold.py`, NÃO em `offsets.py` — `SubKey 1 = gold de combate`, `SubKey 0 = total
  (rollup, inclui venda)` é semântica do gold, não geometria de struct. O offset que ANDA até
  lá (`AggregateManager.AGGREGATES`) é estrutural → esse sim mora em `offsets.py`. A linha é:
  **endereço/forma → `offsets.py`; significado → o módulo da métrica.**

- **Versão** (`SCHEMA_VERSION`, `GAME_VERSION`) mora **só em `meter_windows.py`** — é o valor
  serializado no record do `runs.jsonl`, então a fonte única é o emissor do record. Havia uma
  cópia MORTA e defasada de `SCHEMA_VERSION` em `offsets.py` (`=5` enquanto o runtime já emitia
  11): foi **removida**. Bumpar a cópia errada deixa o record real parado → o app fica cego pro
  campo novo (a classe de bug "schema não bumpado"). `test_version_constants_unique` agora
  **falha** se `SCHEMA_VERSION` ou `GAME_VERSION` reaparecer em mais de um módulo — é o portão
  que prova que não voltou a segunda fonte.

**As duas geometrias de Dictionary.** O alerta mais caro do `offsets.py` é não confundir
`DictFloat` (valor de 4 bytes, `STRIDE` 0x10) com `Dict8B` (valor de 8 bytes — long OU ponteiro,
`STRIDE` 0x18). Trocar uma pela outra corrompe gold/stats sem erro. O detalhe de QUANDO usar
cada uma é invariante próprio (ver Related); aqui o ponto é que **ambos os strides moram em
`offsets.py`** — não se reinventa um stride local.

Regra de bolso ao adicionar uma constante: **é um endereço/forma do binário?** → `offsets.py`,
como símbolo. **É uma decisão de produto/semântica?** → o módulo que decide, comentado com o
oráculo que a cravou. Nunca as duas coisas no mesmo lugar, nunca a mesma coisa em dois lugares.

## Related
- [[invariants/schema-versioning]] — a fonte única de `SCHEMA_VERSION` (em `meter_windows.py`) e a receita de bump
Veja também: [[invariants/dict-strides]] (DictFloat 0x10 vs Dict8B 0x18 — quando usar cada) · [[invariants/gold-singleton-resolution]] (onde COMBAT_SUBKEY + AggregateManager.AGGREGATES atuam juntos) · [[invariants/obscured-data-offlimits]] (campos Obscured marcados em offsets.py que NÃO se lê)
