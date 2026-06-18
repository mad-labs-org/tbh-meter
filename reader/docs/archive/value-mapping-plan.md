---
type: archive
status: superseded
description: "Historical SNAPSHOT (raw RE or shipped plan) — names/offsets/lines may be stale; current truth lives in the live notes (see _index). Exempt from the code drift-test."
---

# TBH value-mapping plan

How we map, validate, and store **every** value the meter reads from game memory — in a way
that survives rebuilds and never turns into guesswork. Written after the combat-gold case
(2026-06-05), which is the model.

---

## 1. Principle: every value lives in ONE place (single source of truth)

Reuse the variable, never repeat the literal. But "where it lives" depends on the **stability**
of the value across game builds:

| Value type | Changes across builds? | Where it lives | Examples |
|---|---|---|---|
| **Offset / ID / enum** | ❌ stable | `config/offsets.py` (the bible) | `AggregateManager.AGGREGATES=0x20`, `GOLD_KEY=100001`, `EAggregateType.GoldEarn=2` |
| **Business rule** | ❌ (game semantics) | in the logic module, commented | `COMBAT_SUBKEY=1` in `metrics/gold.py` |
| **Obfuscated class name** | ✅ **every build** | **NOT stored** — resolve by structure | `ut`→`uu`→`ux`… of AggregateManager |

**Golden rule:** if a value is an *offset* or *id* (doesn't change), it goes into `offsets.py`
and everyone imports it from there. If it's an *obfuscated name* (changes), **no variable can
save you** — you'd have to re-hunt the name on every build. The fix is to not depend on the
name: find the object **by structure** (by what it contains), the way `gold.py` does with the
`AggregateManager`.

---

## 2. Methodology to map/validate ANY value (the one that nailed gold)

Four steps, in order. No "guessing from an isolated value".

**A) Known-answer oracle.** Have the REAL number before you go looking (game gold, a run's xp,
a hit's damage). Without it you can't prove anything — that's what was missing and let gold≈0
and then 1.97T slip through.

**B) Find by STRUCTURE, not by name nor by a single value:**
- **Signature of N known values together.** E.g.: the live GoldEarn inner-dict is the only
  Dict8B with `SubKey1≈combat_save` AND `SubKey0≈total_save` side by side. Two billion-range
  numbers together don't happen by accident.
- **Liveness (growth).** The live cell GROWS while the action happens; frozen copies (autosave/GC
  leftovers) don't. Tells the live one apart without depending on the exact value.
- **Walk pointers up to the ROOT.** From a cell, find what points to it (backrefs) until you
  reach a rooted object — a `nn<T>` singleton confirms via the round-trip of the static field
  `bbwf`. That's **ownership**, not a guess: a frozen copy isn't rooted.

**C) Validate against the oracle, across MULTIPLE runs, including edges.** E.g. gold: 3 runs,
delta == wallet to the unit; +1 run selling an item, to prove combat (`SubKey1`) **excludes**
the sale (`live_total − live_combat` = exact sale value).

**D) Ready-made tools** (in `tbh-meter-dev/`, outside the app, read-only):
- `tbh_mem.py` — faithful copies of the reader's primitives (Reader, scan, resolver, singleton).
- `gold_diag.py` / `gold_diag2.py` — find cell by growth / by 2-value signature + structure dump + walk up to the singleton.
- `gold_monitor.py` — keeps listening run by run and logs the per-run variables to a txt (cross-check against the oracle).
- `test_gold_real.py` (in /tmp on dev) — unit test with SYNTHETIC memory (live vs frozen copy) against the real module. **Every new value should get one of these tests.**

---

## 3. Value inventory

Status: ✅ validated live · 🟡 mapped, revalidate · ⚪ TODO/future.

### Live (real-time — preferred source)
| Value | Path | Status | Notes |
|---|---|---|---|
| COMBAT gold / run | `AggregateManager`(singleton, structure) → `AGGREGATES[GoldEarn][SubKey1]` | ✅ | exact, excludes sale; `metrics/gold.py` |
| TOTAL gold / run | same dict → `[GoldEarn][SubKey0]` | 🟡 | combat+sale+idle; `live_total−live_combat` = sale |
| Live XP / hero | `StageManager→HeroList→Hero→HeroRuntime.EXP_FAKE` | ✅ | `metrics/xp.py`; curve for level-up |
| Live level / hero | `HeroRuntime.LEVEL_FAKE` | ✅ | |
| Damage / DPS | `MonsterSpawnManager` → `UnitHealthController.HP_CURRENT` (Σ drops) | ✅ | `metrics/dps.py` |
| Final stats (64) / hero | `HeroRuntime→StatsHolder.FINAL_STATS` (DictFloat) | ✅ | `game/build.py` |
| Live / dead mobs | `MonsterSpawnManager.MONSTER_LIST / DEAD_MONSTER_LIST` | ✅ | kills + stage reload |
| Live StageKey | `Monster.STAGE_KEY` | ✅ | the save's freezes on switch |
| Run boundary | `LogManager.LOG_LIST` + `StageClearLog`/`StageFailedLog` | ✅ | clear time / wave |

### Save (lagging — snapshot, fallback only)
| Value | Path | Status | Notes |
|---|---|---|---|
| Combat/total gold (fallback) | `PlayerSaveData.AGGREGATES` (`AggregateSaveData` Type=GoldEarn) | ✅ | updates in JUMPS → delta/run unreliable |
| Wallet | `PlayerSaveData.CURRENCIES` (`CurrencySaveData` Key=GOLD_KEY) | ✅ | also from the save (lagging) |
| Equipped items + enchants | `PlayerSaveData.ITEMS` / `ItemSaveData.ENCHANT_DATA` | ✅ | `game/build.py` |
| Party identity | `PlayerSaveData.HEROES` | ✅ | |
| playTime / current stage | `CommonSaveData` | ✅ | |

### ⚪ TODO / future (find with the section 2 methodology)
- **Other live `EAggregateType`s**: `MonsterKill(0)`, `BoxObtain(3)`, `ItemObtain(4)`,
  `PlayTime(15)`, `StageClear(13)`, `StageFail(14)` — same structure as gold (same
  `AggregateManager`, different outer key); singleton already resolved, just read another key.
- **Gold by SOURCE** (sale/idle/quest): `GoldEarn[SubKey2/3]` — to separate from combat.
- **Drops per run** (items/boxes obtained) — via `LogManager.LOG_BY_TYPE`.
- **Non-gold resources** (gems, etc.): other `CurrencySaveData.Key` (map the Keys).

---

## 4. Workflow to map a NEW value (step by step)

1. **Oracle**: write down the real number (from the game) — start/end, or an exact value.
2. **Find**: run the `tbh-meter-dev` probes (value signature / growth / dump).
3. **Walk to the root** if you want a stable LIVE source (singleton/owner) — otherwise the save serves as fallback.
4. **Validate**: delta == oracle across N runs + 1 edge case. If it doesn't match, **don't** ship.
5. **Persist** (single source):
   - new offset → `config/offsets.py` (with a comment + `dump.cs` ref if there is one);
   - business rule → in the logic module (`metrics/…`), commented;
   - obfuscated name → **structural resolver**, never hardcode.
6. **Unit test** with synthetic memory (model: `test_gold_real.py`).
7. **Isolate**: logic in the domain module (`metrics/…` or `game/…`); `meter_windows.py`
   only **calls**, never reads memory inline.

---

## 5. Note on obfuscated names (the `ut`/`uu` trap)

The dump (`re/dump/dump.cs`) gives 2-letter names to internal classes (`ut`, `uf`, `xd`,
`up`…). These names are **scrambled on every build** of `GameAssembly.dll`: what was `ut`
(AggregateManager) became `uu`, and `ut` now names ANOTHER class. So:

- **Never** resolve an internal class by literal name in production.
- Where it's a singleton with identifiable content (e.g.: AggregateManager has the GoldEarn dict) →
  **resolve by structure** (`metrics/gold.py::resolve_combat_gold_klass`).
- Where a name is still used today (`HeroRuntime`/`uf`, `StatsHolder`/`xd` arrive via offset
  from already-resolved objects, so they don't depend on the name — OK). Audit whether any of
  them resolve by short name directly and migrate to structure if the build breaks.
- The `# ut : nn<ut>` comments in `offsets.py` are **dump history**, not runtime truth — they
  only serve to trace the origin.

---

## 6. RVA-based RESOLUTION strategy (build-keyed) — SHIPPED (#190 + seed-calib)

> This adds NO new run-data value — it resolves the SAME classes (managers, save, logs,
> catalogs, gold singleton) via a different path. It lives here because it's the parent rule for
> "how to find the class without depending on the obfuscated name" (the `ut`/`uu` trap from
> section 5), now without the ~2.6GB scan on every launch.

**Chain:** `module_base(GameAssembly.dll) + anchor_rva → s_TypeInfoTable (heap) → table[TypeDefIndex] → Il2CppClass*`. The `anchor_rva` is a FIXED offset in the module (the runtime rewrites the table pointer on every launch); the `TypeDefIndex` is a build constant. Class addresses stay dynamic (ASLR/GC) — only the anchor and the indices are build-stable.

**Auto-calibration keyed by build fingerprint** (`resolve_cache.json`, `CACHE_FMT 9`, calib-only): on the 1st cold start of a new build the scan runs 1× and learns `{anchor_rva, indices{name:idx}, idx_ut, catalogs}` (`typeinfo.discover_anchor` + `gold.gold_index_of_klass`, reusing the klass from the scan — no redundant value-scan); every following launch resolves by index (~ms), no scan. A SHIPPED build avoids even that 1st scan via the embedded **seed-calib** (`config/calib_seed.json`, bundled by `--add-data`; `load_calib` tries the user cache → falls back to the seed). A game patch changes the fingerprint (PE TimeDateStamp/SizeOfImage + Version.txt) → it recalibrates itself 1×. Atomic write (`os.replace`) + full-catalog persist-gate → never poisons.

**Name-free remains:** the obfuscated gold (`ut`→`uu`) is resolved by `idx_ut`, NEVER by name; `class_name` only VALIDATES (round-trip), it doesn't choose. Any sanity-fail (name round-trip, instance size, gold round-trip) → falls back to the guaranteed scan (§ `metrics/gold.py`, `il2cpp/typeinfo.py`, `il2cpp/resolver.py::resolve_via_rva`). Proven reference (v1.00.07): `ANCHOR_RVA=0x5b070e0`, `idx_ut=2744`. Full detail + numbers in `docs/startup-optimization-plan.md` ("RVA resolution — IMPLEMENTED"). End-to-end live verification: `tbh-meter-dev/rva_integration_probe.py`.
