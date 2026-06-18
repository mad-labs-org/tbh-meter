---
type: invariant
description: "O AggregateManager (gold vivo) é um singleton de NOME OFUSCADO de 2 letras que DRIFTA por build (ut→uu) — resolva-o por ESTRUTURA (assinatura de 2 valores + backrefs + round-trip bbwf), NUNCA por nome. Achar por nome pega a classe errada e o gold sai 0 ou lixo (1.97T)."
symptoms:
  - "gold"
  - "gold por run"
  - "gold dobrado"
  - "gold 0"
  - "1.97T"
  - "1.97 trilhão"
  - "singleton ofuscado"
  - "obfuscated singleton"
  - "nome de 2 letras"
  - "2-letter name"
  - "nome driftou"
  - "name drift"
  - "AggregateManager"
  - "find_class_by_name"
code_anchors:
  - metrics/gold.py::resolve_combat_gold_klass
  - metrics/gold.py::_resolve_aggregate_singleton
  - metrics/gold.py::gold_index_by_structure
  - config/offsets.py::AggregateManager
  - il2cpp/finder.py::bbwf_from_klass
asserts:
  - metrics.gold.COMBAT_SUBKEY == 1
  - metrics.gold.TOTAL_SUBKEY == 0
  - config.offsets.EAggregateType.GoldEarn == 2
  - config.offsets.Dict8B.STRIDE == 0x18
  - config.offsets.Dict8B.VALUE == 0x10
guarded_by:
  - tests/test_gold.py::TestResolveCombatGoldKlassByIndex::test_returns_none_when_gate_rejects_klass
  - tests/test_gold.py::TestFindGoldIndex::test_returns_none_when_value_scan_fails
  - tests/test_gold.py::TestGoldIndexByStructure::test_finds_index_passing_gate
---

# Resolução do singleton de gold (nome ofuscado)

O gold-por-run vivo mora em `AggregateManager.AGGREGATES[GoldEarn][SubKey1]` (combate puro, exclui
venda). O **offset** sempre esteve certo — o difícil é achar o **objeto vivo**. A classe é um
singleton `X : nn<X>` cujo nome é um identificador OFUSCADO de **2 letras**, e esse nome **DRIFTA
entre builds** (cravado: era `ut`, virou `uu`, e `ut` passou a ser outra classe). Está documentado no
próprio `AggregateManager` em `offsets.py`.

**A regra:** singleton de nome ofuscado **NÃO se resolve por nome**. `find_class_by_name("ut")` (ou
qualquer nome de 2 letras) pega a classe ERRADA no build seguinte → o singleton não resolve. As
versões antigas então caíam num scan-por-valor que CHUTAVA a célula, e o chute errava sempre: maior
valor pegava a cópia congelada (gold **0**); maior crescimento pegava lixo de heap (gold **1.97T**).
A resolução tem que ser por **ESTRUTURA** (name-free), padrão cravado em
`resolve_combat_gold_klass` → `_resolve_aggregate_singleton`:

1. **Assinatura de 2 valores.** Acha o inner-dict GoldEarn vivo pela co-ocorrência de uma entry
   `KEY == COMBAT_SUBKEY` (=1) com valor na faixa estreita do save E uma entry irmã
   `KEY == TOTAL_SUBKEY` (=0) com valor `>=` ela. Dois números na casa do bilhão, juntos, não
   acontecem por acaso → assinatura determinística, ~zero falso-positivo.
2. **Sobe os backrefs.** inner-dict → outer-dict que o referencia na chave `GoldEarn` → o objeto que
   possui o outer-dict.
3. **Round-trip do singleton.** Confirma que esse objeto é o singleton ENRAIZADO: o campo estático
   `bbwf` da classe aponta de volta pra ele (`bbwf_from_klass(reader, klass) == inst`). Cópia
   congelada (sobra de autosave/GC) não é enraizada → não passa. É POSSE, não chute.

Cacheia-se o **KLASS** (estável na sessão; classes não movem). A cada leitura re-deref pelo `bbwf`
(robusto ao GC mover a instância) e anda o dict — e toda a caminhada usa a geometria `Dict8B`
(`STRIDE`/`KEY`/`VALUE`), nunca a do `DictFloat`; trocar isso corromperia o valor (ver
[[invariants/dict-strides]]).

**Este é o caminho OFUSCADO (fallback hoje).** O caminho PRIMÁRIO é por ÍNDICE
(`resolve_combat_gold_klass_by_index`, TypeDefIndex via RVA), também name-free por construção — ver
[[invariants/rva-index-resolution]]. O `combat_gold_klass_ok` é o GATE comum: confirma que um klass
(do cache, do índice ou do scan) resolve um AggregateManager vivo com GoldEarn (= o round-trip). Klass
errado → gate falha → cai pra esta resolução estrutural.

**Descobrir o `idx_ut` na CALIBRAÇÃO — também por estrutura, não pelo value-scan.** O índice do gold
é aprendido 1×/build e persistido no seed. Antes saía só do value-scan
(`gold_index_of_klass(gold_klass)`), mas o value-scan é FRÁGIL: bootstrapa o klass por VALOR numa
faixa estreita em torno do `combat_gold_save`, e se o save defasou do vivo (farm entre save-writes)
devolve `gold_klass=None` → a calibração morria em `[calib] FAILED to locate gold idx` (cravado no
1.00.11). O caminho robusto é **`gold_index_by_structure`**: varre a `s_TypeInfoTable` já descoberta e
devolve o MENOR índice cujo `table[idx]` passa o MESMO `combat_gold_klass_ok` — o gate aplicado sobre
os índices em vez de confiar no valor. Name-free, sem value-scan, <1s (prova ao vivo no 1.00.11: hit
único idx=2744). `_calibrate` usa o atalho `gold_index_of_klass` quando o scan já tem o `gold_klass`,
e cai pra este walk estrutural quando não tem.

**Aplica-se a QUALQUER singleton ofuscado de 2 letras** (`ut`, `uu`, `yp`, …), não só ao gold: se um
novo métrico precisar de um, resolva-o por estrutura como aqui — nunca por nome. (Distinto de
[[invariants/instance-selection]]: lá o NOME é estável — `LogManager` —, o problema é escolher a
instância viva entre falsos-positivos do scan da MESMA classe.)

## Related
- [[invariants/rva-index-resolution]]
- [[invariants/dict-strides]]
- [[invariants/metric-fallback-chains]]
