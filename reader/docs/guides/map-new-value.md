---
type: guide
description: "Checklist sequenciado pra mapear um valor NOVO da memória do jogo — com um GATE de ORÁCULO duro (não sobe sem oráculo anotado + delta == oráculo em >=3 runs + 1 borda + teste sintético). Reúne a metodologia, a resolução name-free (estrutura ou índice), o stride certo, a cadeia de fallback e o que recapturar se o valor entra no calib."
code_anchors:
  - metrics/gold.py
asserts:
  - metrics.gold.COMBAT_SUBKEY == 1
  - meter_windows.CACHE_FMT == 9
guarded_by:
  - tests/test_gold.py::TestCombatGoldSave::test_ignores_total_subkey_zero
---

# Guia — mapear um valor NOVO da memória

Você quer ler um datum NOVO do jogo (outro `EAggregateType`, drops por run, um recurso
não-gold, dano por atributo…). O caso-modelo é o **gold de combate** — leia o cabeçalho de
`metrics/gold.py` (a história inteira: por que o nome ofuscado, por que o save é só fallback,
como a estrutura foi cravada) e a metodologia em [[process/value-mapping-method]] **antes** de
escrever qualquer leitura. Este guia é o checklist sequenciado; cada passo aponta o invariante
co-obrigatório.

> **Antes de começar — isto já existe?** Antes de "mapear", veja o inventário em
> [[reference/value-inventory]]: muitos valores futuros (outros `EAggregateType`, gold por fonte)
> reusam um singleton **já resolvido** — aí não há nada a "achar", é só ler outra chave.

## GATE de ORÁCULO (não-negociável)

**NÃO suba um valor novo sem TODOS os quatro:**

1. **Oráculo anotado** — o número REAL do jogo (saldo, xp, dano de um hit), escrito ANTES de
   procurar. Sem oráculo você não prova nada — foi a falta dele que deixou subir gold≈0 e depois
   gold=1.97T (chute por valor isolado, sem resposta conhecida pra conferir).
2. **`delta == oráculo` em `>= 3` runs** — o valor por-run tem que bater na unidade em pelo menos
   três runs distintas, não numa só.
3. **`+1` caso de BORDA** — uma run que estressa a semântica. No gold foi uma run **vendendo** um
   item: provou que o combate (`COMBAT_SUBKEY`) **exclui** a venda (`live_total − live_combat` deu
   o valor exato da venda). Ache a borda análoga do SEU valor (idle, level-up, morte, reload de
   stage).
4. **Teste sintético** — um unit-test com memória FALSA (célula viva vs cópia congelada) contra o
   módulo real, modelo `test_gold.py`. **Todo valor novo ganha um desses** — é o que trava a
   regra contra regressão silenciosa quando o jogo rebuilda.

Falhou qualquer um → **não sobe**. "Bateu numa run" não é prova.

## Checklist (na ordem)

1. **Anote o oráculo** (gate §1). Início/fim, ou um valor exato do jogo.
2. **Ache por ESTRUTURA, nunca por nome nem por valor único** (gate §2 da metodologia em
   [[process/value-mapping-method]]): assinatura de N valores conhecidos juntos, *liveness*
   (a célula viva CRESCE; cópia congelada não), e subida de backrefs até a raiz. Rode os probes
   read-only do `tbh-meter-dev` (fora do app) pra localizar a célula.
3. **Suba à RAIZ se quiser fonte VIVA estável.** Se a fonte é um **singleton de nome ofuscado**
   (identificador de 2 letras que DRIFTA por build — `ut`→`uu`), resolva-o por estrutura +
   round-trip do campo estático, NUNCA por `find_class_by_name` — ver
   [[invariants/gold-singleton-resolution]]. Se há um caminho por **TypeDefIndex (RVA)** — o
   primário hoje, mais rápido que o scan — resolva por índice, também name-free por construção,
   com o gate de revalidação anti-veneno — ver [[invariants/rva-index-resolution]]. (Sem fonte
   viva estável, o snapshot do save serve de fallback.)
4. **Use o STRIDE certo ao andar o dicionário.** Há DUAS geometrias de `Dictionary` IL2CPP —
   `DictFloat` (valor float de 4B) vs `Dict8B` (valor 8B: long ou ponteiro). Escolher errado
   corrompe o valor **em silêncio, sem crash**. Reuse `dict8b_items` pros dicts 8B e as constantes
   nomeadas, nunca um literal de offset — ver [[invariants/dict-strides]].
5. **Encaixe na cadeia de FALLBACK.** A forma canônica é `LIVE` (exato) → `SAVE` (defasado,
   fallback) → **NUNCA** carteira/total (reintroduz venda/idle → over-count). O delta vem de uma
   função tipo `run_gain` que devolve `None` no não-monotônico (e **zero é válido**, não é falha),
   e preserva um `*_source` tag pra o app sinalizar leitura degradada — ver
   [[invariants/metric-fallback-chains]].
6. **Valide com o oráculo** (gate §2 + §3): `delta == oráculo` em `>= 3` runs + a 1 borda.
7. **Persista no lugar certo (single source).** Offset/id/enum novo → `config/offsets.py` (com
   comentário e ref do dump). Regra de NEGÓCIO (qual sub-chave significa o quê, ex.:
   `COMBAT_SUBKEY = 1`) → no módulo da lógica (`metrics/…`), comentada — **não** em `offsets.py`,
   que é só offsets/enums. Nome ofuscado → **resolver estrutural**, jamais hardcode.
8. **Escreva o teste sintético** (gate §4), modelo `test_gold.py`.
9. **Isole a lógica.** A leitura mora no módulo de domínio (`metrics/…` ou `game/…`); o
   `meter_windows.py` só **chama**, nunca lê memória inline.
10. **Se o valor entra no `runs.jsonl`** — bumpe `SCHEMA_VERSION` e normalize no app (guia próprio:
    [[guides/add-runs-field]]).
11. **Se a resolução do valor entra no CALIB** (índice/anchor/catálogo aprendido no scan e reusado
    pelo fast path) — você mudou a FORMA do bloco calib: **bumpe `CACHE_FMT` E recapture
    `config/calib_seed.json`** no novo formato. Bumpar o `CACHE_FMT` sozinho quebra o seed (o
    `--selftest` da RC falha e o runtime rejeita o seed por `fmt` → cold scan em toda primeira
    inicialização) — ver [[invariants/cache-management]].

## Related
- [[process/value-mapping-method]]
- [[invariants/gold-singleton-resolution]]
- [[invariants/rva-index-resolution]]
- [[invariants/dict-strides]]
- [[invariants/metric-fallback-chains]]
- [[invariants/cache-management]]
Veja também: [[guides/add-runs-field]] (passo 10) · [[reference/value-inventory]] (já mapeados)
