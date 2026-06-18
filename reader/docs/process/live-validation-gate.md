---
type: process
description: "Pós-update, o diff estático só cobre classes NOMEADAS; as OFUSCADAS (gold/AggregateManager, party+xp/HeroRuntime, StatsHolder) só se validam AO VIVO. O gate validate_live.py resolve pelo seed e exige PASS em gold+party+xp+stage+catálogos antes do ship — validação parcial (só o campo consertado) é o que deixou dois bugs passarem no 1.00.11."
code_anchors:
  - scripts/validate_live.py
  - scripts/diff_offsets_vs_dump.py
---

# Gate de validação ao vivo (pós-update)

Um update do jogo pode mexer em QUALQUER offset. O tripwire estático
(`scripts/diff_offsets_vs_dump.py`, ver [[invariants/rva-index-resolution]]) confere as classes
**NOMEADAS** contra o dump — mas as **OFUSCADAS**, cujo nome drifta por build (gold/`AggregateManager`,
party+xp/`HeroRuntime`, `StatsHolder`), ele marca "não-verificável, valide ao vivo" e segue. Esse é o
ponto cego do diff.

Cravado no 1.00.11: DOIS bugs passaram para um build porque a validação foi PARCIAL — confirmou-se só
o campo recém-consertado (o gold) e a party (que vem do `HeroRuntime` ofuscado, via
[[invariants/party-live-resolution]]) ficou quebrada e passou batida. **Validação parcial não é
validação.**

## A regra

`scripts/validate_live.py` é o portão OBRIGATÓRIO da [[guides/game-update]]: resolve pelo **seed
embarcado** (mesmo caminho do 1º launch do RC/stable) e exige **PASS em TODAS** as métricas-chave ao
vivo, não só na que mudou. Cada surface mutável-por-build que o record de run usa tem um check com
PASS/FAIL + detalhe: `calib/seed`, `gold`, `party-viva`, `hero-class` (EEquipClassType, não EHeroType),
`save-build` (pick_live_psd+read_gold+read_heroes — o caminho que quebrou no 1.00.12), `build-record`
(o `read_build` que a run SOBE: gear/skills via ATTRIBUTES/ITEMS/EQUIPPED_* + `read_account_snapshot`
runes/inventory/stash), `xp-viva`, `dps` (MonsterSpawnManager+HP), `stats` (StatsHolder.FINAL_STATS),
`stage`, `run-cycle` (LogManager.LOG_LIST legível — a boundary de fechamento de run) e `catálogos`. Exit
diferente de zero = NÃO shipar. Roda com o jogo EM COMBATE numa fase (quase todo check precisa da party
deployada). As OFUSCADAS/HP-only (gold, party/xp do `HeroRuntime`, `StatsHolder`, monstros) só se aferem
AQUI — o diff estático não as verifica.

## Imunidade é em camadas, não perfeição

Não dá pra ser imune a um binário fechado mudar bytes. Dá pra ser imune a MOSTRAR LIXO sem saber:
1. **Resolver por ESTRUTURA + gate de sanidade** — [[invariants/gold-singleton-resolution]] (gold por
   estrutura name-free) e [[invariants/rva-index-resolution]] (índice + round-trip) impedem LER lixo.
2. **Degradar honesto** — [[invariants/party-live-resolution]] impede MOSTRAR lixo (nunca o roster).
3. **Este gate** — transforma "bug silencioso descoberto jogando" em "FAIL visível antes do ship".

## Related
- [[guides/game-update]] — o playbook que invoca este gate como passo de validação obrigatório
- [[invariants/party-live-resolution]] — a degradação honesta que o gate confirma
- [[invariants/gold-singleton-resolution]] — o gold ofuscado que o gate confirma ao vivo
