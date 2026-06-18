---
type: invariant
description: "A party de uma run é a VIVA (StageManager.HeroList via pick_live_sm, SEM cap de candidatos) — os heróis DEPLOYADOS, não o roster do save. Sem party viva, degrada honesto (`heroes: err` via hero_in_run, ⚠ no log) — NUNCA despeja o roster (mostrava heróis não-jogados com +0xp) NEM um proxy-chute por xp>0 (pegaria xp idle)."
symptoms:
  - "party errada"
  - "party com heróis a mais"
  - "heróis com +0xp"
  - "roster no lugar da party"
  - "StageManager NOT found"
  - "party do save"
  - "jogando solo mas mostra 6"
  - "live party off"
  - "StageManager ok mas 0 heroes deployed"
  - "party off com a run em combate"
  - "ghost StageManager"
  - "runs inválidas sem time"
  - "save-degraded"
  - "hero_in_run"
code_anchors:
  - game/save.py::pick_live_sm
  - game/build.py::read_live_party
  - game/build.py::hero_in_run
  - game/build.py::describe_sm_candidates
guarded_by:
  - tests/test_save.py::test_pick_live_sm_finds_carrier_beyond_600_candidates
  - tests/test_save.py::test_pick_live_sm_skips_ghost_and_picks_carrier
  - tests/test_save.py::test_describe_sm_candidates_classifies_carrier_vs_ghost
  - tests/test_save.py::TestHeroInRun::test_no_live_party_includes_nobody
  - tests/test_raw_record.py::test_party_off_makes_heroes_err
---

# Resolução da party de uma run (viva, não roster)

A party canônica de uma run são os heróis **DEPLOYADOS** — lidos AO VIVO do `StageManager.HeroList`
(`read_live_party`), na instância escolhida por `pick_live_sm`. O save lista o **roster** (todo herói
com nível > 1): jogando solo com a Ranger, o save lista os 6, mas só a Ranger está em campo. Confundir
roster com party é mostrar heróis não-jogados (o sintoma: vários com `+0xp`).

## `pick_live_sm`: SEM cap, e MESMA validação do `read_live_party`

`pick_live_sm` varre as instâncias de StageManager e devolve a primeira de onde `read_live_party`
extrai ≥1 herói DEPLOYADO válido — chama o **próprio** `read_live_party`, então pick e read usam a
MESMA validação. Tem que varrer **TODAS** as candidatas (como `pick_live_csd`), sem cap fixo: a
portadora pode estar em QUALQUER índice. Um cap fixo perdia a portadora quando o backref devolvia
mais que o limite — cravado no 1.00.11: **1162 instâncias** de StageManager (vs ~450 nos builds
antigos), a portadora além de 600 → `StageManager NOT found` MESMO em combate → a party caía no
roster.

**Por que pick e read TÊM que concordar (regressão 1.00.13).** Antes, o pick usava um check MAIS
FRACO (só `heroKey` válido) que o read (que exige TAMBÉM `nível`/`exp`). Entre as candidatas há
instâncias **ghost** — StageManager torn-down/template, com `heroKey` válido mas `lvl=0` — a MESMA
família de [[invariants/instance-selection]] (o scan acha a classe-K em dezenas de slots que não são
o objeto vivo). O check fraco aceitava um ghost, o meter o CONGELAVA (`if not sm` no loop) e o
`read_live_party` lia `{}` a sessão inteira → `StageManager ok — 0 heroes deployed`, toda run
`heroes:err`, runs inválidas sem time. Só batia em quem tivesse um ghost ANTES da carrier na ordem
de memória (por isso "funcionava na máquina do dev" e passava no `validate_live`). `describe_sm_candidates`
(no `reader-diag.log`) loga candidatas / carriers-vs-ghosts / escolhida — o dado que faltou no debug.
Sem candidata legível → `None` (degrada honesto, NUNCA um ghost que o read não consegue ler).

## Degradação honesta: party off vira `err`, NUNCA o roster

`hero_in_run(hero_key, live_keys)` é a regra única de inclusão: entra **só** quem está na party VIVA
(`live_keys` = HeroList ∪ party_seen). Quando a party viva não resolve a run INTEIRA (sm nulo),
**ninguém entra** — o reader emite `heroes: err("party live off")` no envelope do `raw/<id>.json`.
NUNCA o roster do save (o bug dos 5 heróis com +0xp) nem um proxy-chute por xp>0 (pegaria um herói que
só ganhou xp idle, re-introduzindo o bug): party desconhecida ≠ party adivinhada.

`heroes` é campo **CRÍTICO** no conversor ([[process/data-contract-id-based]]): `heroes: err` →
`issues["heroes"]` → a run é selada **`degraded`**. Pela régua do #262: **não sobe pro leaderboard**
(`auto-upload` pula degradadas) mas **aparece no app**, marcada e filtrável (`hideNonCounted`,
"Skip != sumir"). A linha do `meter.log` ainda leva `⚠` p/ o maintainer, e o gate `validate_live` pega
ao vivo — a degradação nunca é silenciosa.

## Related
- [[invariants/instance-selection]] — escolher a instância viva certa de uma classe (mesma família de bug)
- [[process/live-validation-gate]] — o gate ao vivo que pega party degradada (+ gold/xp/stage) antes do ship
- [[invariants/metric-fallback-chains]] — a tag de fonte (live/save) que preserva a degradação, igual a gold/xp
