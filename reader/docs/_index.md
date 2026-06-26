# Index — reader knowledge base

Touching `tbh-meter/reader`? **Read this first.** Find the note by **symptom/task**
(block below) or by topic (catalog by type). Every note points at the code (the truth).
How it works and how to maintain it: [README](README.md).

> Kept in sync by `tests/test_docs_consistency.py` (every note must be listed
> here; every link from here must resolve, and it validates each note against the code).

## 🔎 By symptom / task

- runs don't close / don't show up / dead list / not closing → [[invariants/instance-selection]]
- add a field to the run record (raw/logs) / schema not bumped → [[invariants/schema-versioning]] · recipe: [[guides/add-runs-field]]
- map a new live value from memory → [[guides/map-new-value]] · method: [[process/value-mapping-method]]
- gold doubled / gold 0 / 1.97T / sale counted / wallet delta / wrong xp per run / hero at the cap (101) gains xp → [[invariants/metric-fallback-chains]]
- wrong stride / corrupted gold-stat / `Dict` / 0x10 vs 0x18 → [[invariants/dict-strides]]
- obfuscated singleton / 2-letter name / `AggregateManager` / name drifted (ut→uu) → [[invariants/gold-singleton-resolution]]
- resolve a new class / fast path / calib / index / `TARGETS` → [[invariants/rva-index-resolution]]
- cold scan every time / stale cache / `calib_seed` out of date / bumped `CACHE_FMT` / persistent "?" mode on every run (poisoned catalog) / stage vanished from the catalog ("?" on a single stage — hole) → [[invariants/cache-management]]
- game updated / new version / gold 0 + stage "?" post-update / re-seed → [[guides/game-update]]
- wrong party / extra heroes / +0xp / roster instead of party / playing solo shows 6 / StageManager NOT found → [[invariants/party-live-resolution]]
- validate everything live post-update / partial validation let a bug slip through / don't ship broken → [[process/live-validation-gate]]
- new log event / `ELogType` / klass pointer / `GetBoxLog` → [[guides/add-log-event]] · rule: [[invariants/log-event-detection]]
- ObscuredFloat / per-hero runtime stats / `EHeroType` / wrong hero class → [[invariants/obscured-data-offlimits]]
- run <30s doesn't count / x-10 / partial capture → [[invariants/run-lifecycle]]
- chest/blue chest on the wrong or next run / drop after the clear / boss box on an abandoned run → [[invariants/run-lifecycle]]
- normalize a field in the app / `undefined` field in the app / dedup → [[invariants/app-normalization]]
- where the offset lives / constant in the wrong file / two sources of truth → [[invariants/offsets-single-source]]
- where to put a new metric / inline read in the orchestrator → [[invariants/orchestration-purity]]
- crash on read / null pointer / `WriteProcessMemory` → [[invariants/memory-safety]]
- what the reader reads / live value vs save / value to map (TODO) → [[reference/value-inventory]]
- review a diff / before the PR / "is this an anti-pattern?" → [[reference/anti-patterns]]

## Invariants
<!-- hard rules: break one = wrong data/crash -->

- [[invariants/instance-selection]] — structural pick of the singleton (managers); avoids dead-list → runs that never close · `meter_windows.py`
- [[invariants/schema-versioning]] — bump `RAW_SCHEMA_VERSION` (raw/<id>.json) + normalize app-side when adding a field; `SCHEMA_VERSION` is the frozen marker (11) of the legacy runs.jsonl · `meter_windows.py`
- [[invariants/run-lifecycle]] — start via `LOG_LIST`; end by `StageClearLog`/`StageFailedLog`; skip <30s except `stage != 10`; partial = success + (<95% clear OR damage ≤ 0); boss box post-clear → pending-close · `meter_windows.py`
- [[invariants/orchestration-purity]] — `meter_windows.py` is a thin orchestrator (zero inline reads outside the scaffolding); new metric/capture → `metrics/` or `game/` · `meter_windows.py`
- [[invariants/offsets-single-source]] — offset/enum/stride → `config/offsets.py`; business rule (e.g. `COMBAT_SUBKEY`) → the logic module; `SCHEMA_VERSION` → `meter_windows.py` · `config/offsets.py`
- [[invariants/rva-index-resolution]] — PRIMARY class resolution by `TypeDefIndex`+calib, gated by a name round-trip; the scan is FALLBACK; new class → `TARGETS` · `il2cpp/resolver.py`
- [[invariants/gold-singleton-resolution]] — obfuscated singleton (`AggregateManager`, 2-letter name drifts ut→uu) resolves by STRUCTURE (2-value signature + backrefs + bbwf round-trip), never by name · `metrics/gold.py`
- [[invariants/dict-strides]] — `DictFloat` (0x10/@0xC, 64 stats) vs `Dict8B` (0x18/@0x10, gold/aggregates); mixing them corrupts silently · `config/offsets.py`
- [[invariants/metric-fallback-chains]] — chain LIVE→SAVE→never wallet/total; `run_gain` None when non-monotonic; source tag preserves the degradation · `metrics/gold.py`
- [[invariants/cache-management]] — `CACHE_FMT` bumps when the calib shape changes; a bump requires re-capturing `config/calib_seed.json` or it falls into the cold scan · `meter_windows.py`
- [[invariants/log-event-detection]] — event by KLASS-POINTER, never the `ELogType` field (stripped from IL2CPP); new event → `TARGETS` + klass in the cache · `meter_windows.py`
- [[invariants/memory-safety]] — read-only (`PROCESS_VM_READ`); null-guard every deref; `ri32`/`ri64` → None on a bad read; cap on iteration; never inject · `shared/memory.py`
- [[invariants/obscured-data-offlimits]] — never read Obscured (XOR = garbage): core stats `@CORE_STATS_OBSCURED`, `@CACHE_OBSCURED`; hero class = `EEquipClassType`, never `EHeroType` (orphan) · `config/offsets.py`
- [[invariants/app-normalization]] — app normalizes defensively (`firstNum`/`numOrNull`), optional field in `run-types.ts`, arrays via `.filter`; never a field after `return` · `app/src/...`
- [[invariants/party-live-resolution]] — run party = LIVE (`StageManager.HeroList`, `pick_live_sm` with NO cap), not the roster; with no live party it degrades honestly (`hero_in_run`, xp>0, `party_source`), never the roster · `game/save.py`

## Reference
<!-- facts: offsets, per-run field map, damage model -->

- [[reference/anti-patterns]] — grep-able checklist of smells to sweep a diff in review → the invariant note each one violates · `config/offsets.py`
- [[reference/run-data-map]] — what the reader READS per run (during + at close): each datum → `offsets.py` symbol + module that reads it · `config/offsets.py`
- [[reference/damage-model]] — damage enums/structs (`MODTYPE`/`MODSOURCE`/`StatModifier`/`EDamageAttribute`/`EEquipClassType`); structure, not the calculation · `config/offsets.py`
- [[reference/extraction-viability]] — read-only matrix per domain (viable/partial/unviable) and why: PLAIN vs Obscured · `game/save.py`
- [[reference/value-inventory]] — what the reader READS, by source: LIVE (real-time) vs SAVE (fallback) vs TODO; points at the reader for each value · `metrics/gold.py`

## Guides
<!-- how to make recurring changes -->

- [[guides/add-runs-field]] — add a field to the run record end-to-end: decide the bump (`RAW_SCHEMA_VERSION` if the shape changed; additive doesn't bump) → init in `new_run` → serialize in `build_raw_record` → converter/app · `meter_windows.py`
- [[guides/map-new-value]] — map a NEW value from memory; oracle GATE (delta == oracle across ≥3 runs + 1 edge case + synthetic test) + name-free + stride + fallback + calib re-capture · `metrics/gold.py`
- [[guides/add-log-event]] — capture a new log event: `TARGETS` → detect by klass-pointer → read fields via `offsets.py` with exception-safety · `meter_windows.py`
- [[guides/game-update]] — the game updated: diagnose by fingerprint (content vs recompile), check offsets via dump+diff, re-seed, bump `GAME_VERSION`, validate live · `scripts/seed_calib_capture.py`

## Process
<!-- methodology / conventions -->

- [[process/value-mapping-method]] — methodology for mapping/validating a value: each value in one place + the oracle method (real number BEFORE searching; without it gold came up wrong twice: 0 and 1.97T) · `metrics/gold.py`
- [[process/data-contract-id-based]] — runs.jsonl emits IDs (itemKey/statId/heroKey/…), never display names; the front end resolves them via `data/*.json`
- [[process/live-validation-gate]] — live post-update gate (`validate_live.py`): PASS on gold+party+xp+stage+catalogs before the ship; the diff only covers named classes, the OBFUSCATED ones validate live · `scripts/validate_live.py`

## Archive
<!-- historical snapshots: delivered plans + raw RE. Names/offsets/lines may be stale; current truth is in the live notes above. Exempt from the code drift-test. -->

- [[archive/run-data-map]] — full raw RE table (366 `@0x`, 9 agents over the dump). Live: [[reference/run-data-map]]
- [[archive/damage-model]] — damage formula + RVAs (disassembly, not testable). Live (enums): [[reference/damage-model]]
- [[archive/extraction-spec]] — original extraction spec (10 domains). Live: [[reference/extraction-viability]]
- [[archive/value-mapping-plan]] — original mapping plan. Live: [[process/value-mapping-method]] + [[reference/value-inventory]]
- [[archive/extraction-findings]] — raw RE findings (524 lines, 9 domains)
- [[archive/refactor-roadmap]] — S0–S12 refactor roadmap (delivered)
- [[archive/startup-optimization-plan]] — cold-start plan (RVA + seed-calib, implemented)
