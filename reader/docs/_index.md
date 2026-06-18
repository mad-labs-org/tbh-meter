# Índice — base de conhecimento do reader

Vai mexer no `tbh-meter/reader`? **Leia isto primeiro.** Ache a nota pelo **sintoma/tarefa**
(bloco abaixo) ou pelo tópico (catálogo por tipo). Cada nota aponta o código (a verdade).
Como funciona e como manter: [README](README.md).

> Mantido em sincronia pelo `tests/test_docs_consistency.py` (toda nota tem que estar listada
> aqui; todo link daqui tem que resolver, e ele valida cada nota contra o código).

## 🔎 Por sintoma / tarefa

- runs não fecham / não aparecem / lista morta / not closing → [[invariants/instance-selection]]
- adicionar campo ao record de run (raw/logs) / schema não bumpado → [[invariants/schema-versioning]] · receita: [[guides/add-runs-field]]
- mapear um valor vivo novo da memória → [[guides/map-new-value]] · método: [[process/value-mapping-method]]
- gold dobrado / gold 0 / 1.97T / venda contada / wallet delta / xp errado por run / herói no cap (101) ganha xp → [[invariants/metric-fallback-chains]]
- stride errado / gold-stat corrompido / `Dict` / 0x10 vs 0x18 → [[invariants/dict-strides]]
- singleton ofuscado / nome de 2 letras / `AggregateManager` / nome driftou (ut→uu) → [[invariants/gold-singleton-resolution]]
- resolver classe nova / fast path / calib / índice / `TARGETS` → [[invariants/rva-index-resolution]]
- cold scan toda vez / cache stale / `calib_seed` defasado / bumpei `CACHE_FMT` / modo "?" persistente em toda run (catálogo envenenado) / stage sumiu do catálogo ("?" só num stage — buraco) → [[invariants/cache-management]]
- jogo atualizou / nova versão / gold 0 + stage "?" pós-update / re-seed → [[guides/game-update]]
- party errada / heróis a mais / +0xp / roster no lugar da party / jogando solo mostra 6 / StageManager NOT found → [[invariants/party-live-resolution]]
- validar tudo ao vivo pós-update / validação parcial deixou bug passar / não shipar quebrado → [[process/live-validation-gate]]
- novo evento de log / `ELogType` / klass pointer / `GetBoxLog` → [[guides/add-log-event]] · regra: [[invariants/log-event-detection]]
- ObscuredFloat / stats por herói runtime / `EHeroType` / classe de herói errada → [[invariants/obscured-data-offlimits]]
- run <30s não conta / x-10 / captura parcial → [[invariants/run-lifecycle]]
- baú/blue chest na run errada ou seguinte / drop depois do clear / boss box em run abandonada → [[invariants/run-lifecycle]]
- normalizar campo no app / campo `undefined` no app / dedup → [[invariants/app-normalization]]
- onde fica o offset / constante no arquivo errado / duas fontes de verdade → [[invariants/offsets-single-source]]
- onde colocar nova métrica / leitura inline no orquestrador → [[invariants/orchestration-purity]]
- crash no read / null pointer / `WriteProcessMemory` → [[invariants/memory-safety]]
- o que o reader lê / valor vivo vs save / valor a mapear (TODO) → [[reference/value-inventory]]
- revisar um diff / antes do PR / "isso é anti-padrão?" → [[reference/anti-patterns]]

## Invariants
<!-- regras duras: quebrou = dado errado/crash -->

- [[invariants/instance-selection]] — pick estrutural do singleton (managers); evita lista-morta → runs que nunca fecham · `meter_windows.py`
- [[invariants/schema-versioning]] — bump `SCHEMA_VERSION` (fonte única) + normalizar app-side ao adicionar campo no runs.jsonl · `meter_windows.py`
- [[invariants/run-lifecycle]] — início via `LOG_LIST`; fim por `StageClearLog`/`StageFailedLog`; skip <30s exceto `stage != 10`; partial = success + (<80% clear OU dano ≤ 0); boss box pós-clear → pending-close · `meter_windows.py`
- [[invariants/orchestration-purity]] — `meter_windows.py` é orquestrador fino (zero leitura inline fora do scaffolding); métrica/captura nova → `metrics/` ou `game/` · `meter_windows.py`
- [[invariants/offsets-single-source]] — offset/enum/stride → `config/offsets.py`; regra de negócio (ex.: `COMBAT_SUBKEY`) → módulo da lógica; `SCHEMA_VERSION` → `meter_windows.py` · `config/offsets.py`
- [[invariants/rva-index-resolution]] — resolução PRIMÁRIA de classe por `TypeDefIndex`+calib, gated por round-trip de nome; o scan é FALLBACK; classe nova → `TARGETS` · `il2cpp/resolver.py`
- [[invariants/gold-singleton-resolution]] — singleton ofuscado (`AggregateManager`, nome de 2 letras drifta ut→uu) resolve por ESTRUTURA (assinatura 2-valores + backrefs + round-trip bbwf), nunca por nome · `metrics/gold.py`
- [[invariants/dict-strides]] — `DictFloat` (0x10/@0xC, 64 stats) vs `Dict8B` (0x18/@0x10, gold/agregados); confundir corrompe silenciosamente · `config/offsets.py`
- [[invariants/metric-fallback-chains]] — cadeia LIVE→SAVE→nunca carteira/total; `run_gain` None no não-monotônico; source tag preserva degradação · `metrics/gold.py`
- [[invariants/cache-management]] — `CACHE_FMT` bumpa quando a forma do calib muda; bump exige recapturar `config/calib_seed.json` ou cai no cold scan · `meter_windows.py`
- [[invariants/log-event-detection]] — evento por KLASS-POINTER, nunca campo `ELogType` (stripado do IL2CPP); evento novo → `TARGETS` + klass no cache · `meter_windows.py`
- [[invariants/memory-safety]] — read-only (`PROCESS_VM_READ`); null-guard toda deref; `ri32`/`ri64` → None em leitura ruim; cap na iteração; nunca injetar · `shared/memory.py`
- [[invariants/obscured-data-offlimits]] — nunca ler Obscured (XOR = lixo): core stats `@CORE_STATS_OBSCURED`, `@CACHE_OBSCURED`; classe de herói = `EEquipClassType`, nunca `EHeroType` (órfão) · `config/offsets.py`
- [[invariants/app-normalization]] — app normaliza defensivo (`firstNum`/`numOrNull`), campo opcional em `run-types.ts`, arrays via `.filter`; nunca campo após `return` · `app/src/...`
- [[invariants/party-live-resolution]] — party da run = VIVA (`StageManager.HeroList`, `pick_live_sm` SEM cap), não o roster; sem viva degrada honesto (`hero_in_run`, xp>0, `party_source`), nunca o roster · `game/save.py`

## Reference
<!-- fatos: offsets, mapa de campos por run, modelo de dano -->

- [[reference/anti-patterns]] — checklist grep-ável de smells pra varrer um diff no review → a nota-invariant que cada um viola · `config/offsets.py`
- [[reference/run-data-map]] — o que o reader LÊ por run (durante + no fechamento): cada datum → símbolo de `offsets.py` + módulo que lê · `config/offsets.py`
- [[reference/damage-model]] — enums/structs do dano (`MODTYPE`/`MODSOURCE`/`StatModifier`/`EDamageAttribute`/`EEquipClassType`); estrutura, não o cálculo · `config/offsets.py`
- [[reference/extraction-viability]] — matriz read-only por domínio (viável/parcial/inviável) e por quê: PLAIN vs Obscured · `game/save.py`
- [[reference/value-inventory]] — o que o reader LÊ, por fonte: VIVO (tempo real) vs SAVE (fallback) vs TODO; aponta o leitor de cada valor · `metrics/gold.py`

## Guides
<!-- como fazer mudanças recorrentes -->

- [[guides/add-runs-field]] — adicionar campo ao record de run ponta-a-ponta: decidir o bump (`RAW_SCHEMA_VERSION` se a forma mudou; aditivo não bumpa) → init em `new_run` → serialize no `build_raw_record` → conversor/app · `meter_windows.py`
- [[guides/map-new-value]] — mapear um valor NOVO da memória; GATE de oráculo (delta == oráculo em ≥3 runs + 1 borda + teste sintético) + name-free + stride + fallback + recaptura de calib · `metrics/gold.py`
- [[guides/add-log-event]] — capturar um evento de log novo: `TARGETS` → detectar por klass-pointer → ler campos via `offsets.py` com exception-safety · `meter_windows.py`
- [[guides/game-update]] — o jogo atualizou: diagnostica pelo fingerprint (conteúdo vs recompile), confere offsets via dump+diff, re-seeda, bumpa `GAME_VERSION`, valida ao vivo · `scripts/seed_calib_capture.py`

## Process
<!-- metodologia / convenções -->

- [[process/value-mapping-method]] — metodologia de mapear/validar um valor: cada valor num lugar + o método do oráculo (número real ANTES de procurar; sem ele o gold subiu errado 2x: 0 e 1.97T) · `metrics/gold.py`
- [[process/data-contract-id-based]] — runs.jsonl emite IDs (itemKey/statId/heroKey/…), nunca nomes de display; o front resolve via `data/*.json`
- [[process/live-validation-gate]] — gate ao vivo pós-update (`validate_live.py`): PASS em gold+party+xp+stage+catálogos antes do ship; o diff só cobre nomeadas, as OFUSCADAS validam-se ao vivo · `scripts/validate_live.py`

## Archive
<!-- snapshots históricos: planos entregues + RE cru. Nomes/offsets/linhas podem estar obsoletos; verdade atual nas notas vivas acima. Isentos do drift-test de código. -->

- [[archive/run-data-map]] — tabela RE crua completa (366 `@0x`, 9 agentes sobre o dump). Viva: [[reference/run-data-map]]
- [[archive/damage-model]] — fórmula de dano + RVAs (disassembly, não testável). Vivo (enums): [[reference/damage-model]]
- [[archive/extraction-spec]] — spec de extração original (10 domínios). Viva: [[reference/extraction-viability]]
- [[archive/value-mapping-plan]] — plano de mapeamento original. Vivos: [[process/value-mapping-method]] + [[reference/value-inventory]]
- [[archive/extraction-findings]] — findings de RE crus (524 linhas, 9 domínios)
- [[archive/refactor-roadmap]] — roadmap S0–S12 do refactor (entregue)
- [[archive/startup-optimization-plan]] — plano de cold-start (RVA + seed-calib, implementados)
