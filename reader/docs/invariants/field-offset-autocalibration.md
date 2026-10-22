---
type: invariant
description: "The four FRAGILE field offsets (Monster.STAGE_KEY, UnitHealthController.HP_MAX, StageManager.HERO_LIST, Unit.CACHE) are AUTO-CALIBRATED live at attach by semantic signature, because the fields are obfuscated (random names per build) and shift on almost every recompile. The static values in config/offsets.py are the FALLBACK, kept when a signature can't be found live. This is why those offsets no longer need a hand-patch every game update."
symptoms:
  - "stageKey unread post-update"
  - "stage unresolved after a new version"
  - "party live off / StageManager unresolved after update"
  - "dps 0 / hp_max 0 after update"
  - "offset shifted on recompile"
  - "hand-patch offsets every version"
  - "1.3.0 / 1.2.8 / 1.00.27 recalibration"
code_anchors:
  - game/field_calib.py::calibrate
  - game/field_calib.py::discover_stage_key
  - game/field_calib.py::discover_hp_max
  - game/field_calib.py::discover_hero_list_and_cache
  - meter_windows.py::_autocalibrate_fields
  - config/offsets.py::Monster.STAGE_KEY
  - config/offsets.py::Unit.CACHE
guarded_by:
  - tests/test_field_calib.py::test_discover_stage_key_by_catalog
  - tests/test_field_calib.py::test_discover_hp_max_ge_current
  - tests/test_field_calib.py::test_discover_hero_list_and_cache
  - tests/test_field_calib.py::test_calibrate_keeps_static_on_no_signal
---

# Field-offset auto-calibration (the four fragile offsets)

## The problem

IL2CPP **class resolution** is already name-based and scan-based, so it survives a game update on
its own (gold/save/catalogs keep resolving on an unknown build). But four **field offsets** are read
at fixed positions and shift on almost every recompile, because the fields are **obfuscated** —
their IL2CPP names are randomized per build (`ud.tl`-style), so they can't be found by name in the
metadata. This is the documented blind spot. Historically each update needed a human to live-probe
them and hand-patch `config/offsets.py` (1.00.14, 1.00.27, 1.2.8, 1.3.0…), each time the same ritual.

The four:

| Field | What it drives | Symptom when wrong |
|---|---|---|
| `Monster.STAGE_KEY` | live stage key → act/stage/difficulty/total_mobs | "stageKey unread", stage "?" |
| `UnitHealthController.HP_MAX` | DPS (Σ HP drops) | dps 0 |
| `StageManager.HERO_LIST` | the live deployed party | "party live off (StageManager unresolved)" |
| `Unit.CACHE` | HeroRuntime → party identity + live level/xp | empty party, no live xp |

## The rule

`game/field_calib.py` **discovers these four at attach time by SEMANTIC SIGNATURE** — what the field
*contains*, not where it sits — and applies them in-memory over the static offsets. It runs in
`meter_windows._autocalibrate_fields` after BOTH resolve paths (fast and scan), so the offsets are
correct before any reading. It piggybacks on structures the resolver already produced
(`msm`, `sm_list`, `stage_info`, `hero_cat`) → **no extra scan**.

Signatures:

- **STAGE_KEY** — the int32 on a live monster whose value is a key in `stage_info`, confirmed on ≥ half
  of a few sampled monsters.
- **HP_MAX** — the float in the HealthController that is `> 0` and `≥ HP_CURRENT(0x40)`, confirmed across
  monsters (smallest qualifying offset wins).
- **HERO_LIST + CACHE** (discovered together) — a `StageManager` array of 1..12 ptrs whose elements, at
  some cache offset, resolve `HeroRuntime.INFO → HeroInfoData.HERO_KEY` in `hero_cat`; requires every
  element to match AND ≥ 2 distinct hero keys (defeats the "same key repeated" false positive).

## Invariants (do not break these)

1. **Static offsets stay as the FALLBACK.** A signature not found live (e.g. the game is not in combat)
   keeps the static value — auto-calibration NEVER makes a working build worse. `config/offsets.py`
   remains the single source of truth for the baseline and must still be hand-updated when a live
   recalibration is done (it seeds the scan windows and the fallback).
2. **Read-only.** Discovery writes nothing to the game and nothing to disk; it only mutates the offset
   classes in memory for the running process.
3. **Scan windows are generous on purpose.** Each `_*_WIN` range spans several recompiles' worth of
   drift around the current value. If a future build shifts a field OUTSIDE its window, widen the
   window (and update the static fallback) — that is the only maintenance left.
4. **Any reader of these offsets must read them dynamically**, not bake a fixed position into a struct
   read. `game/models.live_monsters` spans `HP_CURRENT..HP_MAX` computed from the live offsets, so a
   shifted `HP_MAX` is followed automatically.

## Why this doesn't eliminate the static offsets

The discovery needs a starting window and a safe fallback; the obfuscated fields have no name to
resolve from. So this reduces the per-update work from "investigate + hand-patch 4 offsets + reseed"
to, in the common case, **nothing** — and, when a field leaves its window, a one-line window widen.
It does not make the game self-describing.
