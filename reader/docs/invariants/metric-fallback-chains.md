---
type: invariant
description: "Toda métrica viva tem cadeia LIVE (exato) → SAVE (defasado, fallback) → NUNCA carteira/total. run_gain devolve None em leitura não-monotônica (não emite negativo), e o source tag (gold_source/xp_source) preserva a degradação — o fallback nunca vira primário em silêncio."
symptoms:
  - "gold dobrado"
  - "gold 2x"
  - "gold doubled"
  - "venda contada no gold"
  - "wallet delta"
  - "carteira no gold"
  - "1.97T"
  - "gold 0"
  - "gold zerado"
  - "xp errado por run"
  - "xp fantasma no cap"
  - "herói no cap ganha xp"
  - "xp no nível máximo"
  - "gold_source save"
code_anchors:
  - metrics/gold.py::run_gain
  - metrics/gold.py::combat_gold_live
  - metrics/gold.py::combat_gold_save
  - metrics/xp.py::PartyXpAccumulator
  - metrics/xp.py::per_hero_gain
  - metrics/xp.py::level_capped
asserts:
  - metrics.gold.COMBAT_SUBKEY == 1
  - metrics.gold.TOTAL_SUBKEY == 0
  - config.offsets.EAggregateType.GoldEarn == 2
guarded_by:
  - tests/test_gold.py::TestRunGain::test_non_monotonic_returns_none
  - tests/test_gold.py::TestCombatGoldSave::test_ignores_total_subkey_zero
  - tests/test_xp.py::TestPartyXpAccumulator::test_late_join_credited_from_first_sight
  - tests/test_xp.py::TestPartyXpAccumulator::test_total_none_when_nobody_ever_seen
  - tests/test_xp.py::TestPartyXpAccumulator::test_solo_capped_hero_total_zero_not_none
  - tests/test_xp.py::TestPartyXpAccumulator::test_party_with_capped_hero_counts_only_uncapped
---

# Cadeias de fallback de métrica

Toda métrica por-run (gold, xp) é um **delta de um cumulativo** lido de DUAS fontes do MESMO
número, numa cadeia de prioridade fixa. A forma é canônica — o gold é o protótipo e xp segue o
mesmo padrão:

```
1. LIVE  (exato, lag-zero, exclui venda/idle)  → PRIMÁRIO
2. SAVE  (defasado, em saltos no autosave)     → fallback
3. NUNCA carteira/total (inclui venda + idle)  → reintroduz o bug
```

**Gold.** LIVE = `AggregateManager.AGGREGATES[GoldEarn][SubKey1]` (combate puro) em
`combat_gold_live`; SAVE = `PlayerSaveData.AGGREGATES` com `Type==GoldEarn` E `SubKey==1` em
`combat_gold_save`. `COMBAT_SUBKEY` (=1) é o gold-por-run; `TOTAL_SUBKEY` (=0) é o rollup
(combate + venda + idle + quest) — **nunca** é a fonte. A 3ª linha proibida é o delta do saldo
da carteira (`CurrencySaveData.QUANTITY`): inclui venda e idle, então `gold_end − gold_start`
**conta venda** → over-count por-run. Os value-scans antigos que CHUTAVAM a célula deram os
sintomas históricos: célula congelada → **gold 0**; lixo de heap → **1.97T**.

**XP.** LIVE = o **ACUMULADOR por-herói** (`PartyXpAccumulator` em `metrics/xp.py`): integra os
incrementos do within-level (`HeroRuntime.EXP_FAKE`) **tick-a-tick** (snapshot ~1s + um tick
final no close), keyed por IDENTIDADE (heroKey) — o 1º avistamento semeia o baseline, o level-up
faz a ponte pela curva (`per_hero_gain`), e deploy-tardio/morte/dropout **não perdem o
acumulado** (banked; morto acumula 0 enquanto morto — comportamento real do jogo, preservado).
Substituiu o delta de endpoints (baseline t=0 → leitura no close), que dava **+0** a herói FORA
do baseline (deploy tardio, ou morto da run ANTERIOR ainda em revive: `gain=None` → +0 — cravado
ao vivo: 30–45% das runs com morte zeravam um herói). SAVE = delta do `HeroExp` por-herói
(defasado, e zera no level-up). A escolha mora no orquestrador (`close_run` em
`meter_windows.py`): `total()`/`record()` devolvem `None` quando a fonte viva nunca viu o
herói/ninguém → cai pro SAVE, nunca pra um 0 mudo.

**XP no cap.** A curva DEFINE o cap: nível sem entrada não tem progressão (`level_capped`) — mas
o jogo segue incrementando `EXP_FAKE` (e o `HeroExp` do save) num herói NO cap, sem level-up pra
consumir/zerar → o delta same-level é **XP FANTASMA**. Herói no cap ganha **0** (ganho zero
VÁLIDO em `per_hero_gain`, nunca `None` — `None` degradaria em silêncio pro SAVE, que tem o MESMO
buraco e por isso o `close_run` também zera o delta save-side de herói capado); cruzar PRA DENTRO
do cap banka só até o limiar (`xp_through_levelup` só conta `exp1` se o nível final está na
curva); `exp_start`/`exp_end` seguem a observação CRUA (o baseline avança no ganho 0 — só o ganho
é suprimido). Assimetria save-side: quem cruza PRA DENTRO do cap NO MEIO da run tem o delta do
save TODO zerado (o vivo banka até o limiar) — consistente com a limitação já documentada do save
subestimar quem sobe de nível. Cravado em produção: runs SOLO de uma Ranger lv101 subiam ~39M de
xpGained cada, e uma party com herói capado creditava 20% do total a quem não pode ganhar nada.

## A regra (3 partes, todas necessárias)

1. **Delta só por `run_gain(start, end)`.** Devolve `None` se faltar leitura (`start`/`end`
   `None`) OU se o cumulativo **caiu** (`end < start`, leitura corrompida / GC moveu o objeto).
   **Nunca emite negativo.** Cuidado com o drift da skill: ganho **zero é válido** (`run_gain(100,100)==0`,
   uma run sem gold ainda é uma run) — a guarda é contra **não-monotônico**, não contra zero. A
   xp viva tem a mesma disciplina: o acumulador só soma incrementos `g > 0` de `per_hero_gain`, e
   num dip same-level (leitura suja) **não avança o baseline** — a recuperação telescopa sem
   double-count nem negativo.
2. **Fallback nunca vira primário em silêncio.** Em `close_run` o gold tenta o LIVE primeiro;
   só cai pro SAVE se `run_gain(live)` for `None`. O `gold_source` (`"live"`/`"save"`) e o
   `xp_source` são **serializados no record** pro app sinalizar leitura degradada. Se LIVE e
   SAVE falharem, emite **`0`** com source `"save"` — **nunca dropa em silêncio nem deixa `None`
   virar default errado**.
3. **Source `save` num success com dano > 0 dispara self-heal**, não é aceito como normal: o
   orquestrador re-resolve o klass do `AggregateManager` (índice RVA primeiro, value-scan
   fallback — ver [[invariants/gold-singleton-resolution]]) pra próxima run voltar ao LIVE.

**Por que o SAVE é só fallback:** ele atualiza em SALTOS (só no save-write, ~100s), então o
delta por-run é não-confiável — **0** se a run cai entre dois writes, **~2x (gold dobrado)** se
um write pega duas runs. Cravado ao vivo: o save errou +25k numa run e +1.18M em outra enquanto
o vivo bateu na unidade.

## Ao adicionar uma métrica nova

Siga a MESMA cadeia: ache a fonte VIVA exata (estrutura, não nome — ver
[[invariants/gold-singleton-resolution]]), tenha um SAVE como fallback, use `run_gain` (ou
equivalente que devolva `None` no não-monotônico), preserve um `*_source` tag, e **jamais**
derive de saldo de carteira/total. A leitura do dict cumulativo usa os strides corretos
([[invariants/dict-strides]]); o klass vivo é cacheado e revalidado ([[invariants/cache-management]]).

## Related
- [[invariants/gold-singleton-resolution]]
- [[invariants/dict-strides]]
- [[invariants/cache-management]]
