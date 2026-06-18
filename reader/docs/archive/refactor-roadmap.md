---
type: archive
status: superseded
description: "SNAPSHOT histórico (RE cru ou plano entregue) — nomes/offsets/linhas podem estar obsoletos; a verdade atual está nas notas vivas (ver _index). Isento do drift-test de código."
---

# TBH Meter — Refactor + Optimization Roadmap (2026-06-03)

Output of the multi-agent map (5 dimensions + code-review + thermo-nuclear). Goal: optimize +
refactor the meter toward a clean package, a **database + front-end + (maybe) API**, with
**id-based data, no readable item-name storage** (front resolves names from catalogs).

> **STATUS (2026-06-06): the refactor SHIPPED.** The cutover happened — `meter_windows.py` imports the package (`game.build`/`game.save`/`metrics.*`/`il2cpp.*`) and runs live; `game/ficha.py` became **`game/build.py`** (`read_build`); schema is now **v11** (not 5); the agent (`agent_windows.py`) and entry points live at the reader ROOT, not under `tools/`. Resolution gained an RVA + seed-calib fast path (see `startup-optimization-plan.md`). The DB/API design below is partly realized in the repo's `api/` + `packages/shared`. Treat the rest as the historical 2026-06-03 plan + rationale (kept for the design decisions, not as a live checklist).

## Progresso (faxina incremental — módulos escritos + unit-testados no Mac; cutover ao vivo no FIM, de uma vez)
- ✅ **S0** — `config/offsets.py` reconstruído + cross-validado (28 offsets vs monólito, 4 enums, curva 100). `LEVEL_CURVE` → `config/level_curve.json`. Morto removido.
- ✅ **S1** — `memory/{structs,process,reader,scanner}.py` (13 testes de decode; `Reader` com handle próprio; reads em lote; **pymem removido → zero-dep**).
- ✅ **S2** — `il2cpp/{resolver,finder}.py` (resolver 3-passadas + finder de 2-letras + mecanismo `nn<T>`; testado em memória de classe simulada).
- ✅ **S3** — `game/save.py` (read_gold/goldearn/heroes + pick_live_psd/sm/csd).
- ✅ **S4** — `metrics/gold.py` (Dict8B + resolve_ut_class) + `metrics/xp.py` (curva, diff-0) + `game/catalog.py` (stage/item/hero).
- ✅ **S5** — `game/build.py` (renomeado de `ficha.py`: itens/mods/skills+passivas + 64 stats id-only + xp/nível vivos).
- ✅ **S6** — `game/models.py` (monstros vivos pro DPS + stageKey runtime).
- ◐ **S7–S12** — cutover + entry points (`meter_windows.py`/`agent_windows.py` no ROOT) + agente: **SHIPPED**. O RunRecord tipado (S7) virou contrato do **app** (`run-types.ts`), não do reader; lifecycle/attach + helpers (S8/S9) ficaram inline no `meter_windows.py` (orquestrador), não extraídos; probes vivem em `tbh-meter-dev/`, não `tools/probes/`.
- ✅ **Cutover** — DONE (o meter importa o pacote e roda ao vivo; runs.jsonl conferido).
- ✅ Quick wins (id-only / session_id / schema_version / uniqueId; matou stage_debug) — ao vivo (schema agora **11**).

## Decision (evidence-driven): monolith is the source of truth; the package is REBUILT from it

The migration direction is **`tools/meter_windows.py` (monolith) → `tbh_meter/` package layout**,
NOT the reverse. The existing package is a **liability**, confirmed:
- `tbh_meter/memory/process.py` imports **`pymem`** → violates the zero-pip/ctypes-only rule.
- `config/offsets.py` `SINGLETON_CHAINS` is **100% `None`** (never Cheat-Engine-calibrated) → `main.py`
  exits `sys.exit(2)`; **the package has never run.**
- `config/offsets.py` carries **wrong/guessed offsets** (HP `0x38/0x3C` guess vs validated **`0x40/0x4C`**),
  truncated enums, no name-maps.
- Nothing imports `tbh_meter` except `main.py`.

So: adopt the package's **taxonomy/layout**, replace its **implementations** with the monolith's
validated ctypes reader + auto scan-resolver + correct offsets. `metrics/dps.py|progress.py|events.py`
+ `helpers/` are the only reusable assets (the DPS algorithm is already there, the monolith re-inlines it).

## SAFETY HARNESS (no Windows runtime / no tests here — correctness is live-only)
Migrate **one module at a time**; keep `meter_windows.py` IMPORTING the extracted module; run on
Windows; **diff `runs.jsonl` byte-for-byte against a frozen baseline**; delete the inline copy ONLY
after a run is byte-identical. This is the only guard against silently corrupting the validated artifact.

## QUICK WINS (small, high-value, do first — directly serve the front/DB)
1. **Id-only ficha + stats keyed by integer `statId`** (drop `slot/grade/class/recipe/stat` label strings).
   Fixes the `STATN`-stops-at-59 gap (stats 60-63 currently get generic `stat60..63` names), deletes
   ~25 label-dict lines + ~70 `.get()`/run, ~40-50% smaller `heroes[]` JSON. Zero RE risk (names were
   always front-side enum labels). — `read_ficha`/`read_mods`/`read_stats_dict`.
2. **Add `uniqueId` to the item record** — already read (`:689`) but dropped from the emitted dict; it's
   the only per-instance item identity / DB natural key. One line.
3. **Mint `session_id` + stamp `schema_version`(=4) + `game_version` into every record.** `run_num` resets
   to 1 every game restart → `(run, ts)` is NOT globally unique → the future DB would silently dup/overwrite.
   DB key becomes `(session_id, run_seq)`; ingest = `INSERT ... ON CONFLICT DO NOTHING`.
4. **Batch the hot-loop monster HP read** — one `read(hc+0x40, 0x10)` + `unpack_from` instead of 2
   syscalls/mob; read the List backing array once. #1 hot-loop cost (~30-50 mobs × ~10Hz). Pattern proven
   in `read_stats_dict`.
5. **Cache `ut_class` in `resolve_cache.json`** (bump `CACHE_FMT` 4→5). Today every cache-HIT startup still
   pays a full-memory `find_class_by_name` scan even though the game didn't restart. Validate on load
   (name=='ut' + live≥save).
6. **Delete the `stage_debug.txt` scaffold** — a ~150-line full-file SMB rewrite every second for an
   experiment that's already solved + in production. Pure dead I/O in the hot loop.
7. **Atomic file writes** (`_write` truncates in place) — write tmp + `os.replace` so the app never
   reads a half-written `meter_live.txt`. (`runs.txt` was dropped; `runs.jsonl` is append-only.)

## REFACTOR ROADMAP (ordered, bottom-up; each step = one safe-harness cycle)
- **S0** Rebuild `config/offsets.py` from `docs/run-data-map.md` + monolith constants (correct HP `0x40/0x4C`;
  add StageInfoData/PlayerSaveData/CommonSaveData/HeroSaveData/ItemSaveData/ItemInfoData/HeroInfoData/uf/xd/ut;
  IL2CPP class consts `CLASS_NAME 0x10/ELEMENT 0x40/CAST 0x48`, `STATIC_FIELDS 0xB8/PARENT 0x58/BBWF 0x0`;
  the **two distinct dict strides as NAMED constants** — `GE_STRIDE 0x18 val@0x10` (8-byte gold) vs
  `FLOAT_DICT stride 16 val@0xC` (64-stat) — never conflate; enums as IntEnums). Move `LEVEL_CURVE` →
  `config/level_curve.json`. DELETE `SINGLETON_CHAINS`/`CalibrationNeeded`/`HP_*_INDEX`/`FLOATS`.
- **S1** `tbh_meter/memory/{structs,reader,process,scanner}.py` — pure-ctypes Reader owning its OWN handle
  (not a module global) + batched `read_struct`/`read_array_ptrs`; module_base (Toolhelp). Delete pymem.
- **S2** `tbh_meter/il2cpp/{resolver,finder}.py` — 3-pass scan resolve + `find_class_by_name` (isolated
  `\0ut\0`, no 2-letter hang) + `bbwf_from_klass` (nn<T> singleton). Delete `SingletonResolver`.
- **S3** `tbh_meter/game/save.py` — read_gold/read_goldearn/read_heroes/pick_live_psd/csd/sm.
- **S4** `tbh_meter/game/catalog.py` (stage/item/hero catalogs) + `metrics/gold.py` (goldearn_from_ut +
  read_goldearn_best + resolve_ut_class — **pass `ut_class` explicitly, kill the `UT_CLASS` global**) +
  `metrics/xp.py` (xp_through_levelup + curve from json + per-hero live-xp delta).
- **S5** `tbh_meter/game/ficha.py` — read_ficha/read_mods/read_stats_dict/read_live_party — **apply quick
  wins #1/#2 here** (id-only, statId keys, uniqueId; resolve only equipped uids).
- **S6** `tbh_meter/game/models.py` — rebuild Unit/Hero/Monster/MonsterSpawn/LogManager/StageManager on
  the ctypes Reader (HP `0x40/0x4C`) + live_monsters/live_stage_key.
- **S7** `tbh_meter/persistence/{run_record,resolve_cache}.py` — `@dataclass RunRecord` +
  HeroSnapshot/ItemSnapshot/ModSnapshot (replaces the inline dict; typed contract = the DB contract) +
  atomic writers; cache with `ut_class`.
- **S8** `tbh_meter/lifecycle/attach.py` — one `connect()`/`reattach()` bring-up path (today the re-attach
  block is a near-verbatim copy of startup = latent bug surface).
- **S9** Keep `metrics/dps.py|progress.py|events.py` + `helpers/{timing,formatting}` (reusable). Collapse
  the monolith's `fmt()` into `helpers/formatting.format_number`.
- **S10** Entry points: `tbh_meter/run_meter.py` (thin per-run loop, ~60 lines) + root shim so Mario keeps
  one command (PRIMARY). Rewire `main.py` painel onto the ctypes Reader (SECONDARY; drop pymem/--calibrate).
- **S11** `tools/agent_windows.py` imports the shared core; keep only the cmd/resp loop + op handlers.
  DELETE dead RVA/module_base code + `op_obs`/`op_obs_stable` (hidden^key = garbage this build). ~738→~250 lines.
- **S12** Move the 12 one-off `*_probe_windows.py` to `tools/probes/`.

## DATA CONTRACT (id-based; server NEVER stores/returns display names)
runs.jsonl = append-only event log; DB ingest = idempotent projection. Windows meter stays no-pip; all
DB/upload/API code is Mac/server-side.

**Postgres — HYBRID** (normalize query/aggregate/join dims; JSONB the sparse leaf detail). Full
normalization = ~375 rows/run for data never sliced in SQL (front holds the enums) → JSONB keeps ~4
rows/run and additive RE growth needs zero migration.
```
game_session(session_id PK, started_at, hostname, game_version, meter_schema_version)
run(run_id PK, session_id FK, run_seq, ts, status, stage_key, act, stage_no, mode_id,
    mobs, total_mobs, damage_total, dps, clear_time, duration, gold_ganho, gold_source,
    xp_delta_live, xp_source, xp_per_sec, gold_per_sec, schema_version, raw jsonb,
    UNIQUE(session_id, run_seq))
run_hero(run_hero_id PK, run_id FK, hero_key, class_id, level, xp_gain_live,
    exp_live_start, exp_live_end, levelup,
    items jsonb,   -- [{itemKey,uniqueId,slotId,gradeId,level,itemTypeId,mods:[{recipeId,statId,value,tier}]}]
    skills int[], stats jsonb)   -- stats keyed by INTEGER statId
catalog_enums(game_version, kind, id, name)   -- stat/grade/slot/recipe/class/difficulty
catalog_item(game_version, item_key, grade_id, slot_id, item_type_id, level)
catalog_hero(game_version, hero_key, class_id)
catalog_stage(game_version, stage_key, act, stage_no, total_mobs, difficulty_id)
ingest_raw(line jsonb, ingested_at)   -- replayable audit; re-derive after schema change
```
Indexes: run(stage_key, mode_id, status), run(ts), run_hero(hero_key, class_id).

**API** (thin projection; returns IDs only):
- `GET /runs?stage_key&mode_id&status&from&to&limit&cursor` → run-summary rows
- `GET /runs/{run_id}` → run + heroes (run_hero JSONB verbatim)
- `GET /stats/aggregate?group_by=stage_key|mode_id|class_id&metric=dps|gold_per_sec|xp_per_sec` → rollups
- `GET /catalogs/{enums|items|heroes|stages}?game_version` → exported catalog files

Casing normalized to snake_case at the INGEST boundary (heroKey→hero_key) for columns; JSONB blob keeps
original keys. **Catalog export**: add a meter `--dump-catalogs` flag (data already built in `resolve_all`
+ the `config.offsets` IntEnums).

## RISKS / DO-NOT-BREAK
- No tests + live-only validation → migrate one module at a time with byte-diff parity (above).
- Module-global `HANDLE` → instance-bound Reader handle is the biggest behavioral risk; validate the
  re-attach (game restart) path explicitly.
- The **two dict strides** (GE_STRIDE 0x18/val@0x10 vs float-dict 16/val@0xC) must NEVER be conflated.
- Hoist validated business constants to NAMED constants WITHOUT changing values: `+1` boss in total_mobs,
  the `<30s` run filter with the `stage==10` boss exception, the 5.0s DPS window, `dead_reads>=hz*5`
  re-attach trigger, heroKey range `0<hk<10_000_000`.
- **Keep the save-side GOLD fallback** (degraded-mode safety net). Only the save-side XP path + per-hero
  `exp` field are vestigial.
- Add error logging to the two traceback-swallowing `except` blocks (re-attach resolve_all; close_run
  live-xp) before degrading — a real regression (offset drift after a game update) could corrupt runs
  overnight undetected.
- Dropping name labels is a contract change → coordinate with the `schema_version` bump + the front catalog.
