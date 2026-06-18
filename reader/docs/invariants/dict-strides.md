---
type: invariant
description: "Há DUAS geometrias de entry de Dictionary IL2CPP — DictFloat (stride 0x10, valor float @0xC) para os 64 stats vs Dict8B (stride 0x18, valor 8B @0x10) para gold/agregados. Confundir os strides corrompe gold/xp/stats SILENCIOSAMENTE (sem crash). Sempre as constantes nomeadas, nunca um literal solto."
symptoms:
  - "gold dobrado"
  - "gold errado"
  - "xp errado"
  - "stats errados"
  - "garbage stats"
  - "valores corrompidos"
  - "dict stride"
  - "stride trocado"
  - "stride errado"
  - "wrong gold"
  - "doubled gold"
  - "1.97T"
code_anchors:
  - config/offsets.py::DictFloat.STRIDE
  - config/offsets.py::Dict8B.STRIDE
  - shared/memory.py::dict8b_items
asserts:
  - config.offsets.DictFloat.STRIDE == 0x10
  - config.offsets.DictFloat.VALUE == 0xC
  - config.offsets.Dict8B.STRIDE == 0x18
  - config.offsets.Dict8B.VALUE == 0x10
guarded_by:
  - tests/test_offsets.py::TestDictStrides::test_strides_are_distinct
  - tests/test_offsets.py::TestDictStrides::test_dict_float_value_at_0xC
  - tests/test_offsets.py::TestDictStrides::test_dict_8b_value_at_0x10
---

# Geometrias de Dictionary (DictFloat vs Dict8B)

O jogo guarda dois tipos de `Dictionary<K,V>` que o reader lê, e o **layout do `Entry`
é diferente em cada um** porque o `V` tem tamanho diferente. As duas geometrias são a
classe `DictFloat` e a classe `Dict8B` em offsets.py. Elas **compartilham** o cabeçalho
do entry (`HASH` no início, `NEXT`, e `KEY` como int32 — todos no mesmo lugar), e
divergem em **exatamente dois campos**: o `STRIDE` (tamanho do entry) e o `VALUE` (onde
o valor mora). Esse compartilhamento parcial é a armadilha — o agent vê o `KEY` no mesmo
offset e assume que o resto também coincide.

| geometria | `STRIDE` | `VALUE` | tipo do valor | usada para |
|-----------|----------|---------|---------------|------------|
| `DictFloat` | `0x10` | `0xC` | `float32` (4B) | `Dict<StatType,float>` — os 64 stats finais (via `StatsHolder.FINAL_STATS`) |
| `Dict8B` | `0x18` | `0x10` | `int64` OU ponteiro (8B) | `Dict<int,long>` do gold, e o `Dict<EAggregateType,Dict>` dos agregados |

O valor de 4 bytes do `DictFloat` cabe num entry de `0x10`. O valor de 8 bytes do
`Dict8B` empurra o `VALUE` para `0x10` (alinhamento de 8) e o entry inteiro para `0x18`.

**A regra:** ao iterar entries de um dicionário, escolha a geometria pelo **tipo do
valor que a classe declara no dump**, e use as **constantes nomeadas** (`DictFloat.STRIDE`/
`DictFloat.VALUE` ou `Dict8B.STRIDE`/`Dict8B.VALUE`) — nunca um literal de offset solto.
Pular tombstones em ambas é `HASH < 0` (hash negativo = entry removido). Para qualquer
`Dict8B` há um único leitor reutilizável, `dict8b_items` (em shared/memory.py): ele já
faz `STRIDE 0x18`, `KEY @0x8`, `VALUE @0x10` e o skip de tombstone — a própria docstring
dele avisa que **NÃO serve para `DictFloat`**. Não exista um segundo walker ad-hoc com
literais: reuse `dict8b_items` para 8B e respeite `DictFloat` para os stats.

**Por que corrompe em SILÊNCIO (sem crash):** trocar o stride não derruba a leitura — só
desalinha. Ler um `Dict8B` com `STRIDE 0x10` faz cada entry a partir do segundo cair no
meio do entry anterior → `KEY`/`VALUE` lidos de bytes arbitrários (foi assim que value-scans
ruins chegaram a gold fantasma tipo `1.97T`). Ler o dicionário de stats (`DictFloat`) com
`STRIDE 0x18` / `VALUE @0x10` pula 8 bytes por entry e lê o valor fora da célula float →
64 stats com lixo. Em nenhum dos casos há exceção: o reader emite **números errados** que
só aparecem ao conferir gold/xp/stats contra o jogo. Por isso `test_offsets.py::TestDictStrides`
trava os dois strides como **distintos** e fixa cada `VALUE` — é o guarda contra a fusão
silenciosa das duas geometrias.

O gold é o caso mais escorregadio porque encadeia **dois** `Dict8B`: o `Dict<EAggregateType,Dict>`
externo (cujo `VALUE @0x10` é o **ponteiro** do dict interno) e o `Dict<SubKey,long>` interno
(cujo `VALUE @0x10` é o **long** acumulado). Ambos são `Dict8B` — a mesma geometria, lida
pelo mesmo `dict8b_items`. Como ler/somar os SubKeys certos é outro invariante (ver gold).

## Related
- [[invariants/gold-singleton-resolution]] — lê os DOIS `Dict8B` encadeados do `GoldEarn` (externo→ponteiro, interno→long).
- [[invariants/metric-fallback-chains]] — gold/xp errado por stride trocado dispara o fallback, que MASCARA o bug em silêncio.
