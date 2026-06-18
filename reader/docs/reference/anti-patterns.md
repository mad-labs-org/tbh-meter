---
type: reference
description: "Checklist grep-ável de anti-padrões (smells) pra varrer um DIFF do reader durante review — cada linha aponta a nota-invariant que o smell viola. O drift-test valida os docs; ISTO é o que pega o código errado num diff."
code_anchors:
  - config/offsets.py
  - metrics/gold.py
  - meter_windows.py
  - shared/memory.py
---

# Anti-padrões (checklist de review do diff)

Isto é um **índice de smells**, não uma re-explicação: cada linha é um padrão que, se aparecer
num diff do reader, provavelmente é um bug — com link pra nota que explica o porquê. Varra o diff
contra esta lista antes de abrir o PR. (A verdade e o detalhe moram nas notas linkadas; aqui é só
o gatilho de "isso cheira mal".)

| smell no diff | por que é errado | nota |
|---|---|---|
| `find_class_by_name("xx")` / `next(iter(classes["xx"]))` com nome de 2 letras | nome ofuscado DRIFTA por build → classe errada | [[invariants/gold-singleton-resolution]] |
| índice/RVA usado sem o gate round-trip (`class_name == nome`) | índice envenenado serve classe errada | [[invariants/rva-index-resolution]] |
| literal de offset solto na lógica (`reader.ri32(addr + LITERAL)`) | offset fora da bíblia → drift invisível | [[invariants/offsets-single-source]] |
| regra de negócio (qual subkey significa o quê) dentro de `offsets.py` | offsets.py é só estrutura; regra mora no módulo | [[invariants/offsets-single-source]] |
| `DictFloat.STRIDE` num dict de agregado (ou `Dict8B` nos 64 stats) | stride trocado → corrupção SILENCIOSA (gold 1.97T) | [[invariants/dict-strides]] |
| `gold = wallet_end - wallet_start` | carteira inclui venda/idle → super-conta | [[invariants/metric-fallback-chains]] |
| `xp = heroes_end[k] - heroes_start[k]` (delta cru do save) | save é defasado → 0 ou 2x no autosave | [[invariants/metric-fallback-chains]] |
| `return gain or 0` depois de `run_gain()` | conflaciona None (falha de leitura) com 0 (ganho zero válido) | [[invariants/metric-fallback-chains]] |
| `if gold == 0: mark_partial` | esconde runs COMPLETAS quando a leitura viva falha | [[invariants/run-lifecycle]] |
| `partial = total_damage == 0` (em vez de `<= 0`) | reabre o #163 (x-10 com 0-de-tudo no leaderboard) | [[invariants/run-lifecycle]] |
| skip por `EStageType.ACTBOSS` em vez de `stage != 10` (StageNo) | sinais diferentes → descarta x-10 legítima | [[invariants/run-lifecycle]] |
| campo de run novo setado só no `close_run` (sem `new_run`) | vaza o valor da run anterior | [[invariants/run-lifecycle]] |
| ler os 12 core stats da Unit em runtime (`CORE_STATS_OBSCURED`) | ObscuredFloat (XOR) → lixo; use `FINAL_STATS` PLANO | [[invariants/obscured-data-offlimits]] |
| `EHeroType` pra identidade de classe de herói | enum órfão; use `EEquipClassType` | [[invariants/obscured-data-offlimits]] |
| `ELogType` lido como campo da entry de log | foi stripado do IL2CPP; detecte por klass-pointer | [[invariants/log-event-detection]] |
| leitura inline de memória no `meter_windows.py` (fora do scaffolding) | orquestrador tem que ficar fino | [[invariants/orchestration-purity]] |
| `WriteProcessMemory` / qualquer escrita na memória do jogo | reader é READ-ONLY (anti-cheat) | [[invariants/memory-safety]] |
| deref de ponteiro sem null-guard / aritmética sobre `ri32` que pode ser None | crash no read corrompido | [[invariants/memory-safety]] |
| campo do `raw/<id>.json` mudou de FORMA sem bump de `RAW_SCHEMA_VERSION` + dispatch no conversor (aditivo que o conversor ignora NÃO bumpa; `SCHEMA_VERSION`=11 é legado CONGELADO — nunca bumpe) | conversor cego pro campo / marco da migração quebrado | [[invariants/schema-versioning]] |
| bump de `CACHE_FMT` sem recapturar `config/calib_seed.json` | RC não builda (selftest) + cold scan em runtime | [[invariants/cache-management]] |
| subir um valor novo "porque parece certo", sem oráculo | foi como subiu gold 0 e 1.97T | [[process/value-mapping-method]] |
| `cands[:N]` / cap fixo ao varrer instâncias (`pick_live_sm`) | nº de instâncias cresce por build → perde a portadora (1.00.11: 1162 > 600) | [[invariants/party-live-resolution]] |
| `pick_live_sm` aceitar instância por check MAIS FRACO que o `read_live_party` (só `heroKey`, sem `nível/exp`) | pega um StageManager 'ghost' (torn-down/template: hk ok, lvl=0) antes da carrier → `read_live_party` lê {} → party off a sessão inteira (1.00.13: "StageManager ok — 0 heroes deployed"). pick e read TÊM que concordar | [[invariants/party-live-resolution]] |
| party/heróis = roster do save quando a viva falha (sem filtro `live_keys`/`hero_in_run`) | mostra heróis não-jogados (+0xp); o save é roster, não party | [[invariants/party-live-resolution]] |
| validar só o campo que se consertou após um update | as ofuscadas (party/xp/gold) passam quebradas; rode `validate_live.py` | [[process/live-validation-gate]] |

## Related
- [[invariants/offsets-single-source]] · [[invariants/dict-strides]] · [[invariants/metric-fallback-chains]] · [[invariants/run-lifecycle]] — os mais acionados num review de diff
