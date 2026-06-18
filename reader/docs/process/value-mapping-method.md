---
type: process
description: "Metodologia pra mapear/validar QUALQUER valor que o reader lê da memória: cada valor mora em UM lugar (offset→offsets.py, regra-de-negócio→módulo, nome ofuscado→resolver estrutural), e o método do ORÁCULO (tenha o número real ANTES de procurar — sem isso o gold subiu errado 2x: 0 e 1.97T)."
code_anchors:
  - metrics/gold.py::resolve_combat_gold_klass
  - metrics/gold.py::COMBAT_SUBKEY
  - config/offsets.py::AggregateManager
asserts:
  - metrics.gold.COMBAT_SUBKEY == 1
  - metrics.gold.TOTAL_SUBKEY == 0
  - config.offsets.EAggregateType.GoldEarn == 2
---

# Como mapear e validar um valor da memória

Toda vez que o meter passa a ler um número novo da memória do jogo (um agregado, um stat, um
recurso), o caminho é o MESMO. Esta é a metodologia que cravou o gold de combate (2026-06-05) e
que todo valor novo deve seguir — sem ela, vira achismo que erra em silêncio. Resumo: tenha o
número real ANTES de procurar, ache o objeto por ESTRUTURA (nunca por nome ofuscado nem por valor
isolado), valide contra o oráculo em várias runs, e guarde cada peça no SEU lugar único.

## 1. Cada valor mora em UM lugar (single source of truth)

Reusa a constante, nunca repete o literal — mas *onde* ela mora depende da ESTABILIDADE do valor
entre builds do `GameAssembly.dll`:

| tipo de valor | muda entre builds? | onde mora | exemplo |
|---|---|---|---|
| **offset / id / enum** | não, estável | `config/offsets.py` (a bíblia) | `AggregateManager.AGGREGATES`, `GOLD_KEY`, `EAggregateType.GoldEarn` |
| **regra de negócio** (semântica do jogo) | não | no módulo de lógica, comentada | `COMBAT_SUBKEY=1` / `TOTAL_SUBKEY=0` em `metrics/gold.py` |
| **nome de classe ofuscado** | **sim, todo build** | **não se guarda** — resolve por estrutura | o singleton do `AggregateManager` (`ut`→`uu`→…) |

A diferença entre as duas primeiras linhas é fina e o agent erra: o `AGGREGATES` é um **offset**
(layout do struct, não muda) → `offsets.py`; mas "SubKey 1 = combate, SubKey 0 = total" é a
**semântica do jogo** (o que o número *significa*), não um offset — mora COMENTADA junto da lógica
que a usa (`metrics/gold.py`), e o `offsets.py` fica só com offset/enum/stride. Pôr regra-de-negócio
em `offsets.py` (ou um offset solto no módulo de lógica) fura o single-source. Detalhe do critério em
[[invariants/dict-strides]] (os strides são offset → bíblia) e no inventário [[invariants/metric-fallback-chains]].

## 2. O método do ORÁCULO (tenha o número real ANTES de procurar)

**A) Oráculo de resposta conhecida.** Anote o número REAL do jogo ANTES de varrer a memória — o
gold da carteira, o xp de uma run, o dano de um hit. Sem o oráculo você não tem como PROVAR que
achou a célula certa, só palpitar — e foi exatamente essa falta que deixou o gold subir errado
**duas vezes**: o chute "maior valor" pegou uma cópia congelada → **gold 0**; o chute "maior
crescimento" pegou lixo de heap → **1.97T**. O oráculo é o que separa "achei" de "chutei".

**B) Ache por ESTRUTURA, nunca por nome nem por valor isolado** (as três alavancas, do mais forte
ao mais fraco):
- **Assinatura de N valores conhecidos JUNTOS.** O inner-dict GoldEarn vivo é o único onde uma
  entry `KEY == COMBAT_SUBKEY` e uma irmã `KEY == TOTAL_SUBKEY` aparecem lado a lado com valores na
  casa do bilhão. Dois números grandes juntos não acontecem por acaso → assinatura quase sem
  falso-positivo (`metrics/gold.py::_inner_array_of`).
- **Liveness (crescimento).** A célula viva CRESCE enquanto a ação acontece; cópias congeladas
  (sobra de autosave/GC) não. Distingue a viva sem depender do valor exato.
- **Subir ponteiros até a RAIZ.** De uma célula, ache quem aponta pra ela (backrefs) até chegar num
  objeto ENRAIZADO — um singleton confirmado pelo round-trip do campo estático. Isso é **POSSE**, não
  palpite: cópia congelada não é enraizada (`metrics/gold.py::_resolve_aggregate_singleton`).

**C) Valide com o oráculo, em VÁRIAS runs, incluindo bordas.** O gold: 3 runs com o delta batendo na
unidade + 1 run **vendendo** um item, pra provar que o combate (`SubKey1`) EXCLUI a venda — vendeu
186.480, `live_total − live_combat` deu 186.480 exato. Sem bater em todas, **não sobe**.

**D) Ferramentas read-only** ficam fora do app, em `tbh-meter-dev/` (cópias fiéis dos primitivos do
reader): probes que acham a célula por crescimento ou por assinatura de 2 valores, monitor que loga
as variáveis run a run pra cruzar com o oráculo, e um teste com memória SINTÉTICA (viva vs cópia
congelada). **Todo valor novo deve ganhar um teste sintético desses** — é o que prende o invariante
contra regressão sem precisar do jogo aberto.

## 3. A armadilha do nome ofuscado (ut/uu drifta)

O dump (`re/dump/dump.cs`) nomeia classes internas com 2 letras (`ut`, `uf`, `xd`, …). Esses nomes
são **embaralhados a CADA build**: o que era `ut` (o singleton do `AggregateManager`) virou `uu`, e
`ut` passou a nomear OUTRA classe. Consequência dura:

- **Nunca** resolva classe interna por nome literal em produção — `find_class_by_name("ut")` pega a
  classe ERRADA no build seguinte, o singleton não resolve, e o valor sai 0 ou lixo.
- Onde for singleton de conteúdo identificável (o do `AggregateManager` tem o dict GoldEarn), resolva
  por ESTRUTURA (`resolve_combat_gold_klass`) ou por TypeDefIndex (RVA) — ambos name-free; o nome só
  VALIDA num round-trip, nunca ESCOLHE. Esse é o invariante de [[invariants/gold-singleton-resolution]].
- Os comentários `# ut : nn<ut>` no `offsets.py` são **histórico do dump**, não verdade do runtime —
  servem só pra rastrear a origem, jamais pra resolver.
- Classes que chegam por OFFSET a partir de um objeto já resolvido (`HeroRuntime`, `StatsHolder`) não
  dependem do nome — OK. Audite se algo resolve por nome curto direto e migre pra estrutura.

## 4. Workflow pra um valor NOVO (a sequência)

1. **Oráculo**: anote o número real (início/fim, ou um valor exato).
2. **Ache** com os probes (assinatura / crescimento / dump).
3. **Suba à raiz** se quiser fonte VIVA estável (singleton/owner); senão o save serve de fallback.
4. **Valide**: delta == oráculo em N runs + 1 borda. Sem bater, NÃO sobe.
5. **Persista no single-source** (§1): offset → `config/offsets.py`; regra de negócio → módulo
   (`metrics/…`, comentada); nome ofuscado → resolver ESTRUTURAL, nunca hardcode.
6. **Teste sintético** (memória viva vs congelada) contra o módulo real.
7. **Isole**: a lógica mora no módulo de domínio (`metrics/…` ou `game/…`); o orquestrador só
   CHAMA, nunca lê memória inline. Toda métrica por-run segue a cadeia LIVE→SAVE→nunca-carteira de
   [[invariants/metric-fallback-chains]].

## Related
- [[invariants/gold-singleton-resolution]] — o caso-modelo: resolver o singleton ofuscado por estrutura, não por nome.
- [[invariants/dict-strides]] — por que stride/offset são "estáveis → bíblia" (e como o stride trocado corrompe em silêncio).
- [[invariants/metric-fallback-chains]] — a cadeia LIVE→SAVE→nunca-carteira que toda métrica nova herda.
Veja também: [[guides/map-new-value]] (a receita operacional curta deste método) · [[process/data-contract-id-based]]
