# tbh-meter — reader (Python · Windows)

Reads the game's memory **read-only** (pure ctypes, **no pip**) and produces the data for each run.
It is the **data source** for the app (`../app`). Runs on Windows, where the game is.

## Non-negotiable constraint

`ReadProcessMemory` only (ctypes, no pip). **Never inject** — that is what avoids the anti-cheat (ACTk)
and the ban risk. Every solution is READ-only.

## What it can read (validated live)

- **Team damage + DPS** — the game does not store per-hero damage, only the total, derived from Σ HP drop.
- Per run: stage, mode, mobs, time, **combat gold** (the live counter, SubKey 1), **XP**.
- Per hero: class, level, **64 stats**, **items + mods**, **skills (ids)**, **XP gained**.
- IDs for everything (`itemKey`, `statId`, `gradeId`, …) — the front end resolves the display names via
  the repo's `data/*.json`.

## Output

Writes to `--output` (default `~/tbh-meter`): one **`raw/<id>.json` per finished run** (`id` = the run's
end timestamp in ms), a `live.json` snapshot (~1/s), and `meter.log`. The reader is a **pure sensor** — it
does not own sessions or `runs.jsonl` (the app derives sessions; the legacy `runs.jsonl` path is
migration-only). How the data is read and maintained: **`docs/_index.md`** — read it before changing code.

## Structure

```
meter_windows.py   the reader that runs in production. A THIN ORCHESTRATOR: it builds a Reader and
                   calls the isolated modules (one per metric); only close_run still assembles the
                   final record inline.
agent_windows.py   memory-inspection agent (debug). Self-contained; driven by JSON commands.

config/   offsets.py (the offset bible) + level_curve.json + skill_attr_map.json
          + passive_skill_keys.json + calib_seed.json (calibration seed, build-keyed)
shared/   memory.py (process + scanner + Reader: reads the RAM) · envelope.py · single_instance.py
          · utils.py (formatting + time window + resource_path)
metrics/  one file per metric: gold.py · xp.py · dps.py · events.py · progress.py
il2cpp/   resolver.py (class scan — FALLBACK) · typeinfo.py (RVA + TypeInfoTable: the name-free
          fast path that kills the scan) · finder.py (short name + nn<T> singleton)
game/     save.py · models.py · build.py · enums.py (domain reads)
display/  console.py (rich terminal panel — legacy/orphan; the meter does NOT use it)
docs/     the drift-tested knowledge base (start at docs/_index.md)
```

## Run

The meter **imports the package**, so the deploy unit is the **whole `reader/` folder**, and it runs from
inside it:

```bash
python meter_windows.py        # on Windows, with the game open. Output in ~/tbh-meter.
```

> ⚠️ Deploying only `meter_windows.py` breaks — it imports `shared/`, `metrics/`, `il2cpp/`, `game/`,
> and `config/`.

## Design (thin orchestrator + single source of truth)

The meter is a **thin orchestrator**: it builds a `shared.memory.Reader` and calls isolated modules, one
per metric, so each piece of logic lives in **exactly one place**:

- **Gold** → `metrics/gold.py` (the live wallet gain, no double-count, no sale/idle noise).
- **XP** → `metrics/xp.py` (curve / level-up) + `game.build.read_live_party` (live exp) +
  `game.save.read_heroes` (fallback). The curve lives in `config/level_curve.json`.
- **Damage / DPS** → `metrics/dps.py` (`DpsTracker`); mobs read in batch via `game.models`.
- **Hero build** → `game/build.py` (items / mods / skills + passives + 64 id-only stats + live xp/level).
- **Class resolution** → `il2cpp/typeinfo.py` (RVA + TypeInfoTable, name-free fast path), with the scan in
  `il2cpp/resolver.py` as the fallback; `config/calib_seed.json` (build-keyed) skips the scan on a shipped
  build's first launch.

Reusables live in `shared/`; all offsets in `config/offsets.py`; business rules (e.g. "combat = SubKey 1")
live with the metric logic, never in offsets.
