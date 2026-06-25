"""meter_windows.py — PER-RUN METER (v4). RUNS ON WINDOWS. ZERO deps. Memory-read only.

Each RUN (one stage attempt) records:
  - status: SUCCESS (StageClearLog) or FAIL (StageFailedLog)
  - Stage A-B + mode (Normal/Nightmare/Hell/Torment), all from StageInfoData[currentStageKey]
  - total damage (HP drop) + DPS, mobs X/total (boss counts as +1, no problem)
  - gold/xp GAINED in the run (delta from save; the save is a snapshot -> only at close)
  - hero SHEET at the START of the run (class, level, equipped items w/ rarity and
    decorations/engravings/inscriptions) — frozen (ignores equip swaps mid-run)
If you switch stage mid-run without clearing/failing -> the partial run is ABANDONED and restarts.

Outputs in --output (default ~/tbh-meter): raw/<ts_ms>.json (1 RAW record per run; id = END timestamp
in ms, no session/counter — Redesign 2; the app's converter turns it into logs/<id>.json), live.json
(RAW snapshot of the current run, overwritten ~1x/s, the app cooks the overlay), meter.log (event log,
timestamped), resolve_cache.json. The reader is a DUMB SENSOR: it emits raw to both streams; the app
derives dps/label/format and the SESSION (no cooking here).
Run: python meter_windows.py [--output DIR] [--hz N] [--debug] (Ctrl+C exits).
"""

import argparse
import json
import os
import sys
import time
import traceback

# THIN orchestrator: ZERO inline memory reads. Builds a shared.memory.Reader and delegates
# everything to the isolated logic — shared.memory (attach/regions/scan), il2cpp.resolver (finds the
# classes), game.* (domain), metrics.* (metrics). Offsets come only from config.offsets.
from config.offsets import (List, Array, Class, MonsterSpawnManager, LogManager,
                            StageInfoData, StageClearLog, StageFailedLog, GetBoxLog,
                            HeroDieLog, ResurrectionLog, EMonsterLogType,
                            CommonSaveData, ItemInfoData, HeroInfoData, EStageDifficulty,
                            EStageType, name_map)
from shared.memory import Reader, regions, find_pid, open_process, close, process_image_path
from shared.utils import tee_stdio, resource_path, init_diag_log, diag
from shared.single_instance import acquire as acquire_single_instance
from shared.envelope import err, ok
from il2cpp.resolver import resolve, resolve_via_rva, instances_of, SINGLETONS
from il2cpp import typeinfo
from metrics.gold import (resolve_combat_gold_klass, combat_gold_klass_ok,
                          combat_gold_live, combat_gold_save, run_gain,
                          resolve_combat_gold_klass_by_index, gold_index_of_klass,
                          gold_index_by_structure)
from metrics import xp
from metrics.dps import DpsTracker
from game import build, save
from game.models import live_monsters as read_live_monsters, live_stage_key as read_live_stage_key

TARGETS = ["MonsterSpawnManager", "LogManager", "StageClearLog", "StageFailedLog",
           "GetBoxLog", "HeroDieLog", "ResurrectionLog",
           "CommonSaveData", "CurrencySaveData", "HeroSaveData", "StageInfoData",
           "PlayerSaveData", "ItemInfoData", "HeroInfoData", "StageManager"]


def _suffix_int(s):
    """'HeroName_601' -> 601, 'MonsterName_30102' -> 30102. None if there's no numeric suffix.
    The death/revive logs carry name-keys in this format (confirmed live)."""
    if not s:
        return None
    tail = s.rsplit("_", 1)[-1]
    return int(tail) if tail.isdigit() else None


# Session is NO LONGER the reader's job (Redesign 2): the APP derives the session from the runs (6h gap
# + app-side "New session" cuts, in session-cuts.json). The reader is a pure sensor — each run's id is
# its own end timestamp (build_raw_record), so identity never depends on session/counter. Removed from
# here: load_session/save_session/session_for/resume_session/consume_session_reset, SESSION_GAP_SECONDS
# and session.json/the session_reset flag. `run_num` below survives only as a LOCAL console/log counter
# (resets every launch, NOT an id and does not persist).


# GetBoxLog @0x40 is the chest TYPE as a string ("TreasureChest_Monster|StageBoss|ActBoss"),
# NOT an item key (confirmed live 2026-06-06: @0x40 = "TreasureChest_StageBoss" with
# monster_type=1). The authoritative tier is monster_type @0x50 (EMonsterLogType 0/1/2). The
# exact box variant isn't in the event, so map the tier -> the canonical box item key
# ("Box 1" of each tier), which resolves to name/sprite/loot and is enough for the app to pick 1 of 3 sprites.
BOX_KEY_BY_TIER = {0: 910011, 1: 920001, 2: 930101}  # Monster / Boss / ActBoss

# BOSS chests TRAIL the clear: the game emits the boss chest's GetBoxLog ~0.6s AFTER the
# StageClearLog, in a SEPARATE growth of the LOG_LIST (proven live, 1.00.11). Without the
# pending-close below, the close had already reset R and the chest fell into the NEXT run —
# invisible when grinding the same stage, glaring when the next one is abandoned (blue chest in a 0s run).
# mt=0 (mob) drops DURING the stage → routes to the current run, as always.
TRAILING_BOX_TIERS = (EMonsterLogType.Boss, EMonsterLogType.ActBoss)
# Pending-close window: a SUCCESS record stays PENDING (in memory) for up to this many
# seconds to absorb the trailing boss box(es) before flushing to disk.
# 3.0 = 5x the observed trail (~0.6s) and ≥2-3 live.json snapshots (the live count rises in
# time for the app's rising-edge, with the live stage_key still on the cleared stage). The CLOSE
# itself does NOT delay (reads/metrics/ts_ms/new_run happen at close, as always — delaying
# the close would leak the next run's first seconds into the record on auto-replay, worse than the
# bug); only the file WRITE is deferred. ACCEPTED trade-off: a hard kill (e.g. AV SIGKILL)
# inside the window loses that record. See docs/invariants/run-lifecycle.
PENDING_CLOSE_GRACE = 3.0

GAME_VERSION = "1.00.20"   # FALLBACK: the GameAssembly.dll build the reader was made against; the INSTALLED version comes from the game's Version.txt (_detect_game_version)
# raw/<id>.json: the LIVE format the reader emits (1 file per run). Bump ONLY when the SHAPE of the
# output changes — NOT per game build (re-seed/address doesn't count). The converter (app) dispatches
# on this value. Mirrors app/src/shared/raw-types.ts::RawRunV2. See [[invariants/schema-versioning]].
# v2 (Redesign 2): id = the run's END TIMESTAMP in MILLISECONDS (string), `ts` in ms, NO session_id
# and no run — the run's identity is the instant itself, not a session counter (kills the bug class of
# run_num-reset → colliding id → run vanished). Session is DERIVED by the app.
RAW_SCHEMA_VERSION = 2
# LEGACY (frozen): the last append-only runs.jsonl version the reader emitted BEFORE raw/. The
# reader NO LONGER writes runs.jsonl; the converter uses this marker to branch the migration (≤11 = legacy).
SCHEMA_VERSION = 11        # (6 = EN keys/status; 7 = skills [{key, lv}]; 8 = + skillLevels; 9 = skills includes PASSIVES; 10 = chest drops[]; 11 = per-hero deaths/revives/killed_by + run-total deaths/revives)
DIFF_NAMES = name_map(EStageDifficulty)   # {0: Normal, 1: Nightmare, 2: Hell, 3: Torment}

def _emit_status(state):
    """Lifecycle marker (machine-readable) for the Electron app's splash — read
    in reader-process.ts (statusFromLine). flush=True guarantees it reaches the stdout pipe
    RIGHT AWAY (otherwise it gets stuck in the block buffer and the splash lags). The human logs
    below stay the same. Phases: searching -> resolving -> ready."""
    print(f"[[STATUS]] {state}", flush=True)


def _detect_game_version(handle):
    """The game's INSTALLED version, read from the Version.txt next to the exe (path via the
    already-open read-only handle). None if it can't be read -> caller uses the GAME_VERSION fallback."""
    try:
        exe = process_image_path(handle)
        if not exe:
            return None
        with open(os.path.join(os.path.dirname(exe), "Version.txt"), encoding="utf-8-sig") as f:
            return f.read().strip()[:40] or None
    except Exception:
        return None


CACHE_FMT = 9   # bump when the cache shape changes. 9 = stage_info includes ACTBOSS stages (x-10) — old calibs lack those keys and the fast path reuses them forever, so force ONE re-scan. 8 = CALIB-ONLY: a calib{fp:...} block keyed by build fingerprint — relative anchor_rva (ASLR-stable) + indices{name:idx} + idx_ut + build-stable catalogs. The LEGACY absolute-address cache (sc_class/msm/lm/... + load_cache/save_cache/_managers_ok) WAS REMOVED: calib is build-keyed and the fast path revalidates by round-trip + instance size every launch (it stores no absolute address, so there's nothing to revalidate by address). History: 7 = +die_class/res_class; 6 = +gb_class; 5 = +gold_klass; 4 = +sm_list for live party.


def _seed_path():
    """Path to the BUNDLED calibration SEED (read-only in the bundle), via resource_path — matches
    `--add-data "config/calib_seed.json;config"` in the frozen build, resolves to reader/config/ in
    source. The seed is OPTIONAL: when absent → resource_path points at a nonexistent file, and
    _read_calib returns None fine (caller falls back to the scan)."""
    return resource_path("config/calib_seed.json")


def _stage_info_ok(stage_info):
    """Sanity check on the stage_info catalog: non-empty and EVERY row in shape (act, stage_no, horde,
    diff) — 4 ints, with plausible act/stage_no (1..200, mirrors the row gate in
    _read_catalogs; horde has NO range-check — boss x-10 legitimately has horde=0) and diff
    within EStageDifficulty (the DIFF_NAMES keys, exactly what close_run/overlay
    resolve via DIFF_NAMES.get). A row outside this = suspect catalog (scan misread or
    poisoned cache): serving/persisting it would mean PERMANENT mode "?".
    It's the gate on BOTH sides: on LOAD (_read_calib rejects → load_calib falls back to seed → scan,
    auto-healing a poisoned resolve_cache.json without the user deleting anything) and on PERSIST
    (save_calib doesn't write a bad catalog). Unlike anchor/indices, the catalogs have NO
    live round-trip revalidation in the fast path — their defense is this VALUE gate + the
    COMPLETENESS-vs-seed gate (_covers_seed_keys)."""
    if not stage_info:
        return False
    # bool is a subclass of int in Python: a `true` in a hand-edited cache would pass as
    # diff=1 — exclude it explicitly (real JSON from save_calib only produces ints).
    return all(isinstance(row, tuple) and len(row) == 4
               and all(isinstance(x, int) and not isinstance(x, bool) for x in row)
               and 1 <= row[0] <= 200 and 1 <= row[1] <= 200
               and row[3] in DIFF_NAMES
               for row in stage_info.values())


def _covers_seed_keys(seed_entry, stage_info, item_cat, hero_cat):
    """COMPLETENESS-vs-seed gate: do the candidate catalogs cover EVERY key the bundled
    seed has for the SAME fp? Catalogs are build CONSTANTS — for the same fingerprint,
    the shipped seed (validated live at capture) is ground truth for WHICH keys exist; a
    local catalog missing some seed key has a HOLE (a row dropped by misread in the
    _read_catalogs row gate) and is provably worse. With no seed for the fp (None) there's no
    reference → no constraint (True). PRESENCE of a key ONLY, NEVER a value comparison: an
    extra local key always passes, and the local value wins when present (protects against a
    hypothetically stale seed under the same fp)."""
    if seed_entry is None:
        return True
    return (set(seed_entry["stage_info"]) <= set(stage_info)
            and set(seed_entry["item_cat"]) <= set(item_cat)
            and set(seed_entry["hero_cat"]) <= set(hero_cat))


def load_calib(path, fp):
    """Reads the BUILD-STABLE calibration block `calib[fp]`. Tries the USER cache (`path`,
    ~/tbh-meter/resolve_cache.json) FIRST; if it doesn't cover `fp`, falls back to the bundled SEED
    (config/calib_seed.json). Returns {anchor_rva, indices{name:idx}, idx_ut, stage_info,
    item_cat, hero_cat} or None (old fmt / fp absent in both / corrupt JSON → scan).

    SEED FALLBACK (seed-calib strategy): lets the FIRST launch on a SHIPPED build skip the ~70s
    scan (turns into ~ms of load). The seed is just ONE MORE calib[fp] hypothesis — ZERO new trust: the
    fast path (_resolve_fast) revalidates live every launch (name round-trip + instance size
    + gold round-trip) and degrades to the guaranteed scan on ANY mismatch; an old seed / one from
    another build is simply a MISS by fp (falls back to the scan), never poisons. The user cache
    has priority — a locally LEARNED calib (save_calib) overrides the seed on the next launch.
    Proven in tbh-meter-dev/seed_calib_probe.py (20/20, seed-path 7.8s vs scan 73s, ~9x; negatives
    corrupt anchor/idx → _resolve_fast None).

    Amendment R3 (completeness-vs-seed): the user cache's priority is CONDITIONED on
    covering the seed's keys for the SAME fp (_covers_seed_keys). A cache whose catalogs
    lost keys the seed has is a catalog with a HOLE (rows dropped by misread in the
    _read_catalogs row gate): it passes the value gates, but serving it would shadow the
    good seed FOREVER (nothing re-triggers a scan) → same symptom as the poisoned cache (mode
    "?" on the hole's stage), again only curable by deleting the cache by hand. In that case serve the
    SEED (with an observability log). Cost: the seed is parsed ONCE per load, even on a
    cache-hit (~ms, acceptable). Semantics preserved otherwise: good cache → cache; cache
    None → seed; both None → None."""
    seed = _read_calib(_seed_path(), fp)
    entry = _read_calib(path, fp)
    if entry is not None:
        if _covers_seed_keys(seed, entry["stage_info"], entry["item_cat"], entry["hero_cat"]):
            return entry
        # Name EACH holed catalog (not just the total): triage is remote, via
        # meter.log — "stage_info=2" vs "item_cat=40" point to very different misreads.
        holes = {c: len(set(seed[c]) - set(entry[c]))
                 for c in ("stage_info", "item_cat", "hero_cat")}
        detail = " ".join(f"{c}={n}" for c, n in holes.items() if n)
        print(f"[calib] user cache for fp {fp} missing seed keys: {detail} — serving seed")
        return seed
    return seed


def _read_calib(path, fp):
    """Reads the `calib[fp]` block of ONE file (fmt==CACHE_FMT). None if old fmt / fp absent /
    corrupt JSON or unexpected shape (e.g. non-dict top-level) / nonexistent file.
    TOTAL by construction — NEVER raises: every shape access lives inside try. Matters
    because save_calib's completeness-vs-seed gate calls this OUTSIDE save_calib's try,
    and _calibrate promises "NEVER breaks the flow" (a malformed file can't crash the
    post-scan).

    Does NOT validate absolute addresses: the calib block has none — `anchor_rva` is RELATIVE to
    ga_base (re-read live every launch) and the indices are build CONSTANTS. Anchor/indices
    are "raw data, VALIDATED BY THE CALLER": the resolver revalidates 1 name via round-trip + instance
    size every start; a bad anchor/index degrades to the scan, NEVER poisons. Catalogs
    reconstructed with int(k)/tuple(v) as in the legacy load_cache.

    EXCEPTION — stage_info is validated HERE (_stage_info_ok): the catalog has no live round-trip in the
    fast path, so a poisoned cache (e.g. rows with diff -1 written before the diff gate
    in _read_catalogs) would be served forever → mode "?" on every run. Rejecting the block here
    makes load_calib fall back to the bundled seed (and that, if it too fails/misses, to the scan, which
    re-calibrates and OVERWRITES the poisoned calib[fp]) — auto-healing, no deleting the cache by hand."""
    try:
        c = json.load(open(path, encoding="utf-8"))
        if c.get("fmt") != CACHE_FMT:
            return None
        entry = c.get("calib", {}).get(fp)
    except Exception:
        return None
    if not entry:
        return None
    try:
        indices = {k: int(v) for k, v in entry.get("indices", {}).items()}
        si = {int(k): tuple(v) for k, v in entry.get("stage_info", {}).items()}
        if not _stage_info_ok(si):
            return None
        item_cat = {int(k): tuple(v) for k, v in entry.get("item_cat", {}).items()}
        hero_cat = {int(k): (v if v is not None else None)
                    for k, v in entry.get("hero_cat", {}).items()}
        return {"anchor_rva": entry.get("anchor_rva"), "indices": indices,
                "idx_ut": entry.get("idx_ut"), "stage_info": si,
                "item_cat": item_cat, "hero_cat": hero_cat}
    except Exception:
        return None


def save_calib(path, fp, anchor_rva, indices, idx_ut, stage_info, item_cat, hero_cat):
    """Persists ONE build's (`fp`) calibration into the cache's calib block. MERGE: re-reads the
    existing JSON, sets calib[fp]={...}, preserves the other fps and the legacy address block.

    COMPLETENESS PERSIST-GATE (amendment R1): only persists if the catalogs are SOUND
    (len>0 on all three), mirroring run()'s `if msm and lm and sc_class and sf_class:` guard.
    Otherwise a scan run OUTSIDE a stage would write an empty catalog → the fast-path would serve a
    degraded catalog FOREVER for that fp, with no re-resolve trigger. DON'T persist an incomplete calib.
    Amendment R2: stage_info goes through _stage_info_ok (every row with a valid EStageDifficulty
    diff) — mirrors _read_calib's load-gate; a misread never becomes a persisted calibration.
    Amendment R3: completeness-vs-seed (_covers_seed_keys) — when the bundled seed covers the fp,
    a scan whose catalogs DON'T have every seed key (rows dropped by misread in the _read_catalogs
    row gate) does NOT persist: the holed catalog would shadow the good seed
    forever for that fp (mirrors load_calib's load-gate; the seed keeps serving on subsequent
    launches). With no seed covering the fp, persists exactly as before.

    ATOMIC WRITE: json.dump into path+".tmp", flush()+os.fsync(), os.replace(tmp, path). Same
    volume (local `~/tbh-meter`) → os.replace is OS-atomic → a kill mid-write NEVER leaves the
    cache truncated/poisoned. (Fixes the legacy save_cache's non-atomic write hygiene.)"""
    if not (_stage_info_ok(stage_info) and len(item_cat) > 0 and len(hero_cat) > 0):
        return
    if not _covers_seed_keys(_read_calib(_seed_path(), fp), stage_info, item_cat, hero_cat):
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            doc = json.load(open(path, encoding="utf-8"))
            if not isinstance(doc, dict) or doc.get("fmt") != CACHE_FMT:
                doc = {"fmt": CACHE_FMT}
        except Exception:
            doc = {"fmt": CACHE_FMT}
        calib = doc.get("calib")
        if not isinstance(calib, dict):
            calib = {}
        calib[fp] = {
            "anchor_rva": anchor_rva,
            "indices": {k: int(v) for k, v in indices.items()},
            "idx_ut": idx_ut,
            "stage_info": {str(k): list(v) for k, v in stage_info.items()},
            "item_cat": {str(k): list(v) for k, v in item_cat.items()},
            "hero_cat": {str(k): v for k, v in hero_cat.items()},
        }
        doc["calib"] = calib
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        pass


def fmt(n):
    n = float(n or 0)
    for u in ("", "K", "M", "B", "T"):
        if abs(n) < 1000:
            return (f"{n:.0f}{u}" if u == "" else f"{n:.2f}{u}")
        n /= 1000.0
    return f"{n:.2f}P"


def _append(path, line):
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _write_atomic(path, text):
    """Writes `text` to `path` ATOMICALLY: writes to a `.tmp` and renames (os.replace is atomic on the
    same filesystem). The app may be reading the raw/ folder at any moment -> it must never see a
    half-written file. Best-effort: on failure, cleans up the .tmp and leaves no junk."""
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass


def build_raw_record(*, ts_ms, run_outcome, game_version, duration,
                     stage_key, act, stage_no, difficulty, total_mobs,
                     mobs, total_damage, clear_time,
                     gold, gold_ok, gold_source, xp_gained, xp_ok, xp_source,
                     drops, heroes, heroes_ok, runes, inventory, stash):
    """Builds the RAW v2 record (raw/<id>.json) from ALREADY-read values — RAW observation, NO
    deriving (dps/rates/labels/partial/skip/status are the CONVERTER's job, app). Each DATA field goes
    in an ok/err envelope (shared.envelope) so the converter can distinguish "didn't-read" from "read zero"
    (the gold:0 bug). The structural meta (id/ts/...) goes RAW. PURE and testable: touches no memory or
    clock (`ts_ms` comes in as a parameter). Mirrors app/src/shared/raw-types.ts::RawRunV2 (keys 1:1).

    - `id` = the END TIMESTAMP in MILLISECONDS as a string (= `str(ts_ms)`). It's the run's IDENTITY —
      NO session, NO counter: two plays on one machine are sequential, never share a ms. The upload
      external_id is `device:id` (glued app-side). The FILE is raw/<id>.json. (v1 used
      `session_id:run`, which recycled on a reader restart → colliding id → the new run vanished.)
    - `*_ok=False` -> the field becomes err (not 0/None): this is what fixed gold:0 (didn't-read != zero).
    - stage fields (stageKey/act/stageNo/difficulty/total_mobs) = err when they didn't resolve.
      stageKey=None is a FAILED READ (the ranking key), not "no stage" — becomes err so the converter
      degrades the run (the abandoned path only closes with a non-None stage_key, see close_run)."""
    def _stage(v):
        return ok(v) if v is not None else err("stage unresolved")
    return {
        "raw_schema_version": RAW_SCHEMA_VERSION,
        "id": str(int(ts_ms)),
        "ts": int(ts_ms),
        "run_outcome": run_outcome,
        "game_version": game_version,
        "duration": int(duration),
        "stageKey": ok(stage_key) if stage_key is not None else err("stageKey unread"),
        "act": _stage(act),
        "stageNo": _stage(stage_no),
        "difficulty": _stage(difficulty),
        "total_mobs": _stage(total_mobs),
        "mobs": ok(mobs),
        "total_damage": ok(round(total_damage, 2)),
        "clear_time": ok(clear_time),
        "gold_gained": ok(int(gold)) if gold_ok else err("gold unread (live+save failed)"),
        "gold_source": gold_source,
        "xp_gained": ok(round(xp_gained, 2)) if xp_ok else err("xp unread (live+save failed)"),
        "xp_source": xp_source,
        "drops": ok(drops),
        "heroes": ok(heroes) if heroes_ok else err("party live off (StageManager unresolved)"),
        # Account snapshot at close (SAVE source): runes + inventory + stash, RAW, written on
        # EVERY run. In an ok/err ENVELOPE like the other data fields: None (DIDN'T-READ) -> err, list -> ok
        # (incl. [] = GENUINELY empty). Never ok([]) on a read failure — that would be the gold:0 bug
        # back again. Additive WITHOUT bumping RAW_SCHEMA_VERSION: the converter reads by name and ignores
        # an unknown key (convert.ts), app intact; the wiki derives later (real drop-rate / wave correction).
        "runes": ok(runes) if runes is not None else err("runes unread (save/list unreadable)"),
        "inventory": ok(inventory) if inventory is not None else err("inventory unread (save/list unreadable)"),
        "stash": ok(stash) if stash is not None else err("stash unread (save/list unreadable)"),
    }


def build_live_record(*, run, stage_key, act, stage_no, difficulty,
                       mobs, total_mobs, damage_now, elapsed, gold_now, xp_now, party, drops,
                       party_stats=None, party_progress=None):
    """Builds the RAW LIVE snapshot (live.json, overwritten ~1x/s) from ALREADY-read values —
    RAW observation, NO cooking. The reader STOPPED deriving dps/label/format here: it emits only the
    live numbers/ids and the APP cooks (computeDps/resolveStage/modeName) with the SAME helpers as the
    record (live-source.ts + converter/helpers.ts) → one formula, no Python↔TS drift. Pure and
    testable: touches no memory or clock (`elapsed`/reads come in as parameters). Mirrors
    app/src/shared/live-types.ts::RawLive (keys 1:1).

    - No `run_outcome`: the live is ALWAYS the in-progress run (the outcome only exists at close → goes in
      raw/<id>.json, not here). No envelope: the live is best-effort and ephemeral (overwritten every tick;
      nothing persists). A field that didn't resolve becomes `null` (live gold/xp) or disappears in the app —
      unlike the per-run raw/<id>.json, which IS audited (there the envelope distinguishes "didn't-read" from
      "read zero"). The live never writes permanent junk, so it doesn't need ok/err.
    - `stageKey`/`act`/`stageNo`/`difficulty` go RAW (the app formats "3-9" and the mode name at render).
    - `goldNow`/`xpNow` = live gain accumulated in the run (live→save chain, see metric-fallback-chains);
      `None` when neither live nor save resolved (the overlay simply doesn't show the line).
    - `party_stats` = {heroKey: {statId: value}} of the 64 live FINAL stats per hero (same source as the
      raw, read_live_stats_by_hero). ADDITIVE (no bump, schema-versioning exception): an old reader doesn't
      emit it → the app detects by presence and the overlay degrades (no tooltip). Empty = no live party.
    - `party_progress` = {heroKey: {level, exp, gain}} — the per-hero LIVE leveling snapshot (level +
      within-level exp + run-accumulated xp, built by metrics/xp.party_progress) that powers the overlay's
      time-to-level. ADDITIVE too (same schema-versioning exception as party_stats): an old reader omits it
      → no ETA shown. Empty = no live party."""
    return {
        "raw_schema_version": RAW_SCHEMA_VERSION,
        "run": run,
        "stageKey": stage_key,
        "act": act,
        "stageNo": stage_no,
        "difficulty": difficulty,
        "mobs": mobs,
        "total_mobs": total_mobs,
        "damage_now": round(damage_now, 2),
        "elapsed": int(elapsed),
        "gold_now": None if gold_now is None else int(gold_now),
        "xp_now": None if xp_now is None else round(xp_now, 2),
        "party": party,
        "drops": drops,
        "party_stats": party_stats or {},
        "party_progress": party_progress or {},
    }


def _valid_list_size(reader, inst, list_off, cap):
    """size of the List<T> at inst+list_off IF it's a STRUCTURALLY valid List, else None.
    The pointer scan finds class-K in DOZENS of slots that are NOT the real object (vtables,
    copies, metadata): the true singleton is the only one whose list_off is a real List<T> —
    readable items, capacity >= size, and entries that are objects (readable class). Before, it only
    checked 0<=size<cap: a junk slot with the qword at +SIZE landing in range (e.g. 0 from zeroed
    memory) passed, the "list" never grew, and NO run closed (a non-deterministic per-launch bug)."""
    ll = reader.rptr(inst + list_off)
    if not ll or ll < 0x10000:
        return None
    size = reader.ri32(ll + List.SIZE)
    items = reader.rptr(ll + List.ITEMS)
    if size is None or not (0 <= size < cap) or not items or items < 0x10000:
        return None
    maxlen = reader.ri32(items + Array.MAX_LENGTH)
    if maxlen is None or not (size <= maxlen < 1_000_000):
        return None
    for idx in ({0, size - 1} if size else ()):       # are entries objects with a readable class?
        e = reader.rptr(items + Array.DATA + idx * 8)
        if not e or not reader.read_cstr(reader.rptr((reader.rptr(e) or 0) + Class.NAME)):
            return None
    return size


def _pick_list_singleton(reader, cands, list_off, cap):
    """The REAL singleton among the scan's false-positives: the candidate with the structurally
    valid List of LARGEST size (the live log/monster-list has entries; junk doesn't). Falls back to the
    old pick (1st in range) so a good resolve NEVER regresses to None in a degenerate state."""
    best, best_sz = None, -1
    for a in cands:
        s = _valid_list_size(reader, a, list_off, cap)
        if s is not None and s > best_sz:
            best, best_sz = a, s
    if best is not None:
        return best
    return next((a for a in cands
                 if (lambda s: s is not None and 0 <= s < cap)(
                     reader.ri32((reader.rptr(a + list_off) or 0) + List.SIZE))), None)


def _should_skip_run(measured, clear_time, stage):
    """A run under 30s does NOT count (discarded) — EXCEPT stage x-10 (boss-only fight, can
    last seconds), which always counts. `stage` is the stage NUMBER (StageNo), NOT an
    EStageType.ACTBOSS — they're different signals (see docs/invariants/run-lifecycle)."""
    return max(measured, clear_time or 0) < 30 and stage != 10


def _is_partial(status, clear_time, measured, total_damage):
    """PARTIAL capture: the meter joined a run already in progress (<80% of the official clear) ->
    undercount. Gated on clear_time>=30 so x-10 runs (boss, seconds) aren't mis-flagged.
    EXCEPTION: a success with measured damage <=0 is always a missed capture (covers x-10 with clear<30s
    that skipped the check and pushed all-zeros to the leaderboard, #163)."""
    return bool(status == "success" and (
        (clear_time >= 30 and measured < clear_time * 0.8) or total_damage <= 0))


def _box_belongs_to_pending(mt, has_pending):
    """GetBoxLog routing: a BOSS chest (mt in TRAILING_BOX_TIERS) with a PENDING success
    belongs to the run that JUST closed — the game emits that log ~0.6s AFTER the
    StageClearLog, when the close has already opened the next run. Any other case (mob mt=0,
    which drops during the stage; unknown mt; NO pending — e.g. the reader attached right
    after someone else's clear) → current run. Pure/testable (see run-lifecycle)."""
    return mt in TRAILING_BOX_TIERS and has_pending


def _absorb_drop(rec, drop):
    """Appends `drop` INSIDE the pending record's drops ok-envelope. build_raw_record does NOT
    copy the list (shared.envelope.ok references it), so mutating the value here is exactly
    what comes out in the flush JSON; the new run doesn't see it (new_run creates a fresh drops=[]). True if
    it appended; a record out of the expected shape (never happens: drops is always ok(list)) → False
    and the caller keeps the chest on the current run — a real chest is NEVER discarded. never-raises."""
    env = rec.get("drops") if isinstance(rec, dict) else None
    if isinstance(env, dict) and env.get("ok") is True and isinstance(env.get("value"), list):
        env["value"].append(drop)
        return True
    return False


def _drop_counts(drops, absorbed=None):
    """Chest count per tier [Monster, Boss, ActBoss] for live.json: the CURRENT run's drops
    + those ABSORBED by the pending-close. The trailing boss box must RAISE the live count
    while the live stage_key is still the cleared one — it's that rising-edge that the app's
    cooldown-tracker/drop-notifier detect (a drop only lowers their baseline, no event; post-flush
    the count drops back, harmless). Does NOT sum the pending record's full list: its
    grays would stay hanging in the overlay until the flush. Pure/testable."""
    dc = [0] * len(EMonsterLogType)
    for d in list(drops or ()) + list(absorbed or ()):
        mt = d.get("monster_type")
        if mt in (EMonsterLogType.Monster, EMonsterLogType.Boss, EMonsterLogType.ActBoss):
            dc[mt] += 1
    return dc


def _new_pending(rec, path, now):
    """Builds the pending-close state that a SUCCESS creates: the COMPLETE record + where
    to write it + the flush deadline (now + PENDING_CLOSE_GRACE) + the FRESH list of post-close
    absorbed chests (only those go into the live count; inheriting a prior close's list
    would re-attribute a chest — the very bug). SINGLE SOURCE of the shape: close_run AND the tests
    use this constructor (a hand-mirrored shape in the tests would let it drift silently).
    Pure/testable (now comes in as a parameter)."""
    return {"rec": rec, "path": path,
            "deadline": now + PENDING_CLOSE_GRACE, "absorbed": []}


def _flush_pending_rec(pending):
    """Writes the pending-close record to disk (the SAME atomic write as the immediate close).
    never-raises (runs in the tick loop, post-LOG_LIST-scan / inside the close): _write_atomic
    is already best-effort; a serialization failure — never seen, the record is all primitives — becomes
    a line in meter.log, not a crash that kills the session. The caller clears the pending state."""
    if not pending:
        return
    try:
        _write_atomic(pending["path"], json.dumps(pending["rec"], ensure_ascii=False))
    except Exception:
        print(f"\n[pending] WARN flush failed — run record "
              f"{(pending.get('rec') or {}).get('id', '?')} lost")


def _read_catalogs(reader, inst):
    """Derives the build-stable catalogs (stage_info/item_cat/hero_cat) from the resolved
    *Data instances. Used by the scan (slow path); the fast path reuses calib's."""
    stage_info = {}
    for a in inst.get("StageInfoData", []):
        sk = reader.ri32(a + StageInfoData.STAGE_KEY)
        st = reader.ri32(a + StageInfoData.STAGE_TYPE)
        wa = reader.ri32(a + StageInfoData.WAVE_AMOUNT)
        wm = reader.ri32(a + StageInfoData.WAVE_MOB_AMOUNT)
        act = reader.ri32(a + StageInfoData.ACT)
        sno = reader.ri32(a + StageInfoData.STAGE_NO)
        diff = reader.ri32(a + StageInfoData.DIFFICULTY)
        # DIFF, ACT and STAGE_NO are required and plausible on EVERY row (horde AND boss):
        # diff within EStageDifficulty (the DIFF_NAMES keys — exactly what
        # close_run/overlay resolve), act/sno in 1..200. A horde row with an
        # unreadable/out-of-enum diff was cataloged with -1 → mode "?" on EVERY run of that stage,
        # FOREVER (the catalog persists in calib). A suspect row does NOT enter (§6: degrade,
        # never serve/persist bad data) — but dropping it opens a HOLE with the SAME blast
        # radius as x-10 below (mode "?" at close/overlay and blind stage adoption/switch
        # in the loop), and the hole would persist in calib[fp] for the build's lifetime, not "just
        # this run". What cures the recurrence is the completeness-vs-seed gate
        # (_covers_seed_keys, in save_calib AND load_calib): with a seed covering the fp, a
        # holed catalog never persists nor shadows the sound seed.
        diff_ok = diff in DIFF_NAMES
        actsno_ok = (act is not None and sno is not None
                     and 1 <= act <= 200 and 1 <= sno <= 200)
        waves_ok = bool(wa and wm and 1 <= wa <= 200 and 1 <= wm <= 200) and diff_ok and actsno_ok
        # x-10 (ACTBOSS) has no horde waves (wa/wm out of range) -> the row fell into the
        # filter above and the stage stayed OUT of the catalog: mode "?" at close/overlay
        # and blind stage adoption/switch in the loop. Validate by STAGE_TYPE + plausible
        # fields; horde = 0 (the consumers' "+1 = the boss" already covers the total).
        boss_ok = st == EStageType.ACTBOSS and diff_ok and actsno_ok
        if sk is not None and (waves_ok or boss_ok):
            stage_info[sk] = (act, sno, wa * wm if waves_ok else 0, diff)
    item_cat = {}
    for a in inst.get("ItemInfoData", []):
        ik = reader.ri32(a + ItemInfoData.ITEM_KEY)
        if ik is not None and 0 < ik < 10_000_000 and ik not in item_cat:
            item_cat[ik] = (reader.ri32(a + ItemInfoData.GRADE), reader.ri32(a + ItemInfoData.PARTS),
                            reader.ri32(a + ItemInfoData.LEVEL))
    hero_cat = {}
    for a in inst.get("HeroInfoData", []):
        hk = reader.ri32(a + HeroInfoData.HERO_KEY)
        if hk is not None and 0 < hk < 10_000_000 and hk not in hero_cat:
            hero_cat[hk] = reader.ri32(a + HeroInfoData.CLASS_TYPE)
    return stage_info, item_cat, hero_cat


def _resolve_fast(reader, ga_base, calib):
    """FAST PATH (name-free, ~ms): resolves the SAME 14-tuple as the scan from the build-stable
    `calib` block (no scan at all). All memory reading/validation lives in
    typeinfo/resolver/gold — here we only orchestrate: re-read the live table_base via anchor_rva (the
    ga_base changes per ASLR every launch, the anchor_rva is build-stable), resolve classes/singletons
    by index + round-trip + size (resolver), the gold by index (gold) and assemble the tuple. The
    catalogs come from calib (build-stable). Returns the 14-tuple or None on ANY sanity-fail
    (§6: degrades to the scan, NEVER serves bad data).

    PSD/CSD/StageManager are NOT useful singletons here: PlayerSaveData/CommonSaveData aren't
    singletons (bbwf→None) and `pick_live_sm` needs the PARTY-CARRYING instance (the StageManager's
    bbwf gives SOME instance, not necessarily the live one). All THREE come from ONE targeted
    backref (resolver.instances_of) over the READABLE regions — K is already obtained by index, all
    that's left is finding who points to it. Single-sweep (#110): 3 needles ≈ 1, ~8s on Mario's machine. This
    leaves psd_list/csd_list/sm_list POPULATED before `ready` → the startup's new_run() (which reads PSD
    for build/heroes/baselines) has a live PSD. `pick_live_sm` operates as it does today over the backref's list."""
    tbase = typeinfo.table_base(reader, ga_base, calib["anchor_rva"])
    if not tbase:
        return None
    rv = resolve_via_rva(reader, tbase, calib["indices"], TARGETS, SINGLETONS)
    gold_klass = resolve_combat_gold_klass_by_index(reader, tbase, calib["idx_ut"])
    if rv is None or not gold_klass:
        return None
    classes, instances = rv
    sc_class = next(iter(classes["StageClearLog"]))
    sf_class = next(iter(classes["StageFailedLog"]))
    gb_class = next(iter(classes["GetBoxLog"]))
    die_class = next(iter(classes["HeroDieLog"]))
    res_class = next(iter(classes["ResurrectionLog"]))
    # Managers MSM/LM: the resolver already validated the instance by size (§ resolver._manager_inst_ok).
    msm = next(iter(instances["MonsterSpawnManager"]), None)
    lm = next(iter(instances["LogManager"]), None)
    # PSD/CSD/StageManager via targeted backref (ONE scan, ~8s). PSD/CSD non-singletons; the
    # StageManager comes from here (not bbwf) so pick_live_sm picks the instance with party,
    # exactly as in the slow path. An empty PSD (e.g. not logged in) does NOT fail the fast path — it's the
    # same degradation the scan would have (pick_live_psd→None → empty build for that run only, §6).
    _tb = time.time()
    insts = instances_of(reader, regions(reader),
                         {name: next(iter(classes[name])) for name in
                          ("PlayerSaveData", "CommonSaveData", "StageManager")})
    print(f"[calib] fast path PSD/CSD/StageManager backref in {time.time() - _tb:.1f}s "
          f"(PSD={len(insts['PlayerSaveData'])} CSD={len(insts['CommonSaveData'])} "
          f"SM={len(insts['StageManager'])})")
    psd_list = insts["PlayerSaveData"]
    csd_list = insts["CommonSaveData"]
    sm_list = insts["StageManager"]
    return (sc_class, sf_class, msm, lm, csd_list, psd_list,
            calib["stage_info"], calib["item_cat"], calib["hero_cat"],
            sm_list, gold_klass, gb_class, die_class, res_class)


def _resolve_scan(reader):
    """SLOW PATH (scan ~190s + gold value-scan ~90s): resolves from scratch via il2cpp.resolver
    and derives all managers/catalogs. GUARANTEED fallback (§6) — always works, any
    build. Returns (14-tuple, classes) — `classes` feeds the calibration in resolve_all."""
    regs = regions(reader)
    classes, inst = resolve(reader, regs, TARGETS)
    sc_class = next(iter(classes["StageClearLog"]), None)
    sf_class = next(iter(classes["StageFailedLog"]), None)
    gb_class = next(iter(classes.get("GetBoxLog", [])), None)
    die_class = next(iter(classes.get("HeroDieLog", [])), None)
    res_class = next(iter(classes.get("ResurrectionLog", [])), None)
    # Pick the managers by STRUCTURAL VALIDATION (not 1st-in-range): the scan returns dozens of
    # false-positives; a junk slot with size=0 at a lower address shadowed the real LogManager
    # → the list never grew → NO run closed. Canonical caps: MSM=2000, LM=100000 (LOG_LIST
    # grows the whole session). See _pick_list_singleton/_valid_list_size.
    msm = _pick_list_singleton(reader, inst["MonsterSpawnManager"], MonsterSpawnManager.MONSTER_LIST, 2000)
    lm = _pick_list_singleton(reader, inst["LogManager"], LogManager.LOG_LIST, 100000)
    # infra-log: structural pick of the managers (instance-selection). A badly-picked LM (dead list)
    # = NO run closes (historical "runs don't close" bug). Logging cands/picked makes this visible.
    diag(f"[manager-pick] MSM cands={len(inst['MonsterSpawnManager'])} picked={hex(msm) if msm else None}; "
         f"LM cands={len(inst['LogManager'])} picked={hex(lm) if lm else None}")
    csd_list = list(inst.get("CommonSaveData", []))
    psd_list = list(inst.get("PlayerSaveData", []))
    sm_list = list(inst.get("StageManager", []))
    stage_info, item_cat, hero_cat = _read_catalogs(reader, inst)
    # Live gold: resolves the AggregateManager klass by STRUCTURE (name-free; see metrics.gold).
    # All gold logic lives in gold.py — here (and in the rest of the meter) we ONLY call.
    _tg = time.time()
    gold_klass = resolve_combat_gold_klass(reader, psd_list)
    print(f"[resolve] gold singleton (writable value-scan) in {time.time() - _tg:.1f}s")
    tup = (sc_class, sf_class, msm, lm, csd_list, psd_list, stage_info,
           item_cat, hero_cat, sm_list, gold_klass, gb_class, die_class, res_class)
    return tup, classes


def _calibrate(reader, pid, fp, cache_path, classes, stage_info, item_cat, hero_cat, gold_klass):
    """CALIBRATES after a full scan: discovers the anchor_rva + indices + idx_ut and persists them in
    calib[fp] (deliverable 02). All discovery logic lives in typeinfo/gold — here we only
    orchestrate + persist. NEVER breaks the flow (failing = just no speedup next time).

    The idx_ut comes from a cheap table WALK: by value==gold_klass (gold_index_of_klass) when the
    scan already bootstrapped `gold_klass`, OR — when the value-scan does NOT converge (gold_klass None: the
    save lagged the live value, seen in 1.00.11) — by STRUCTURE (gold_index_by_structure: the index whose
    table[idx] passes combat_gold_klass_ok, the SAME gate as the fast path). Both name-free and without re-running
    the ~40s value-scan. (History: find_gold_index(reader, tbase, []) with an empty psd made the
    value-scan fail → idx_ut None → calib NEVER saved → the fast path never activated. Bug.)

    CARRIED OBLIGATION (validation 01): if discovery fails (anchor OR idx_ut None), EMIT
    a clear log-event — a build that "never speeds up" must be OBSERVABLE (stdout goes to
    meter.log + the app's relay). Without fp/ga_base there's no way to calibrate (bows out quietly)."""
    if not fp:
        return
    ga_base, ga_size = typeinfo.ga_module(pid)
    if not ga_base or not ga_size:
        print("[calib] FAILED to read GameAssembly.dll module — build will keep scanning")
        return
    regs = regions(reader)
    known_K = {name: next(iter(classes[name])) for name in classes if classes[name]}
    disc = typeinfo.discover_anchor(reader, ga_base, ga_size, known_K, regs)
    if disc is None:
        print("[calib] FAILED to discover anchor — build will keep scanning")
        return
    anchor_rva, tbase2, indices = disc
    # idx_ut: reuse the scan's klass as a shortcut (gold_index_of_klass) when it exists; otherwise — value-scan
    # didn't converge (gold_klass None) — derive by STRUCTURE (gold_index_by_structure), name-free and
    # save-independent. Both walk the same table; both avoid re-running the value-scan.
    idx_ut = gold_index_of_klass(reader, tbase2, gold_klass) if gold_klass else None
    if idx_ut is None:
        idx_ut = gold_index_by_structure(reader, tbase2)
    if idx_ut is None:
        print("[calib] FAILED to locate gold idx in table — build will keep scanning")
        return
    save_calib(cache_path, fp, anchor_rva, indices, idx_ut, stage_info, item_cat, hero_cat)
    print(f"[calib] anchor_rva={hex(anchor_rva)} idx_ut={idx_ut} indices={len(indices)} — "
          "fast path armed for this build")


def resolve_all(reader, pid, fp, cache_path):
    """Orchestrates resolution GATED by build fingerprint (§1: thin — all RVA logic lives
    in typeinfo/resolver/gold). Fallback chain (§6): calib[fp] (build-stable) → scan+calibrate.
    Reusable at startup AND re-attach. 14-tuple in cache order (the shape NEVER changes).

    `pid` is needed to read the GameAssembly.dll module (typeinfo.ga_module); `fp` is the
    build fingerprint (computed in run() via _detect_game_version, the calib key);
    `cache_path` is the resolve_cache.json (respects --output)."""
    ga_base, _ga_size = typeinfo.ga_module(pid)
    # FAST PATH: known build → resolve by index/bbwf (~ms), no scan.
    if fp and ga_base:
        calib = load_calib(cache_path, fp)
        if calib:
            tup = _resolve_fast(reader, ga_base, calib)
            if tup is not None:
                print(f"[calib] fast path (fp {fp}) — resolved via RVA, no scan")
                diag(f"[resolve] path=FAST fp={fp} (calib hit, RVA, no scan)")
                return tup
            print("[calib] fast path sanity-fail (RVA/idx/size) — falling back to scan")
            diag(f"[resolve] fast-path SANITY-FAIL (RVA/idx/size) → cold scan fp={fp}")
        else:
            diag(f"[resolve] calib MISS (seed+cache don't cover fp) → cold scan fp={fp}")
    else:
        diag(f"[resolve] no fp/ga_base (fp={fp} ga_base={hex(ga_base) if ga_base else None}) → cold scan")
    # SLOW PATH: guaranteed scan + calibrate at the end (persist-gate in save_calib).
    _emit_status("scanning")   # app: splash shows "first time on this version, mapping (~1 min)"
    print("resolving classes/instances (~1-2min)...")
    tup, classes = _resolve_scan(reader)
    (sc_class, sf_class, msm, lm, _csd, _psd, stage_info,
     item_cat, hero_cat, _sm, gold_klass, *_rest) = tup
    if msm and lm and sc_class and sf_class:
        _calibrate(reader, pid, fp, cache_path, classes, stage_info, item_cat, hero_cat, gold_klass)
        diag(f"[resolve] path=SCAN fp={fp} → calibrated (persisted)")
    else:
        diag(f"[resolve] path=SCAN fp={fp} → NOT calibrated (incomplete: "
             f"msm={bool(msm)} lm={bool(lm)} sc={bool(sc_class)} sf={bool(sf_class)})")
    return tup


def run(hz, output_dir, debug=False):
    _emit_status("searching")   # app: splash shows "looking for the game"
    cache_path = os.path.join(output_dir, "resolve_cache.json")
    pid = find_pid()
    if not pid:
        print("[error] game is not open."); diag("[attach] game NOT open (find_pid None)"); return
    handle = open_process(pid)
    if not handle:
        print("[error] OpenProcess failed (run as admin?).")
        diag(f"[attach] OpenProcess FAILED pid={pid} (admin/AV?)"); return
    # The meter builds the Reader (the stove); EVERY memory read goes through it. Isolated modules (the
    # chef): shared.memory/il2cpp (attach/resolve), game.save/build, metrics.gold/xp/dps.
    reader = Reader(handle)
    print(f"[ok] attached (pid {pid}).")
    _emit_status("resolving")   # app: splash shows "reading the game's memory"
    gv = _detect_game_version(handle)
    game_version = gv or GAME_VERSION
    print(f"[ok] game version {game_version}" + ("" if gv else " (fallback — Version.txt unreadable)") + ".")
    t0 = time.time()
    # run_num = a LOCAL console/log counter only (resets every launch). NOT the run's identity
    # (that's the timestamp, in build_raw_record) nor the session (the app derives it). No session.json.
    run_num = 1
    # Build fingerprint = the calib key (build-stable). Computed ONCE here (needs the
    # module's ga_base + the installed version read via the handle); passed to resolve_all to gate.
    ga_base0, _ = typeinfo.ga_module(pid)
    fp = typeinfo.build_fingerprint(reader, ga_base0, gv) if ga_base0 else None
    diag(f"[attach] pid={pid} version={game_version} fp={fp} "
         f"ga_base={hex(ga_base0) if ga_base0 else None}")
    # Single chain (calib-only, no legacy address cache): calib[fp] (build-stable,
    # revalidated by round-trip + size every launch) → scan+calibrate. resolve_all gates.
    (sc_class, sf_class, msm, lm, csd_list, psd_list, stage_info, item_cat,
     hero_cat, sm_list, gold_klass, gb_class, die_class, res_class) = resolve_all(reader, pid, fp, cache_path)
    # tbase/idx_ut: GOLD fast-path handles for the mid-session re-resolves (startup re-resolve,
    # post-run self-heal, re-attach). resolve_all does NOT return these (the 14-tuple has a fixed
    # shape — the re-attach unpacks it), so we recompute them here from the build-stable calib:
    # idx_ut is a build constant; tbase = the live TypeInfoTable pointer via anchor_rva (re-read by
    # ga_base, which changes per ASLR every launch — we reuse the ga_base0 already computed for the fp). Without calib
    # (new build, still scanning) → both None → the call sites fall back to the value-scan, as today (§6).
    # NEW-2: tbase/idx_ut are run()-LOCALS, REassigned in place (here and at re-attach); close_run
    # reads them as free-vars (no nonlocal for reading). At re-attach the ga_base CHANGES → tbase recomputed.
    _calib0 = load_calib(cache_path, fp) if fp else None
    if _calib0 and ga_base0:
        tbase = typeinfo.table_base(reader, ga_base0, _calib0["anchor_rva"])
        idx_ut = _calib0["idx_ut"]
    else:
        tbase = idx_ut = None
    print(f"[ok] resolved in {time.time()-t0:.0f}s. stages={len(stage_info)} "
          f"items-catalog={len(item_cat)} heroes-catalog={len(hero_cat)} "
          f"PSD={len(psd_list)} CSD={len(csd_list)}.\n")
    # infra-log: meter.log does NOT log the StageManager candidate count nor the gold — and it was the SM
    # count (453) that mattered in the 1.00.13 party-off (see shared/utils.diag).
    diag(f"[resolve] fp={fp} SM={len(sm_list)} PSD={len(psd_list)} CSD={len(csd_list)} "
         f"gold={'ok' if gold_klass else 'None'} stages={len(stage_info)} "
         f"items={len(item_cat)} heroes={len(hero_cat)}")

    if not (msm and lm and sc_class and sf_class):
        print("\n[error] incomplete resolution. Try again with the game in combat.")
        diag(f"[resolve] INCOMPLETE → abort (msm={bool(msm)} lm={bool(lm)} "
             f"sc={bool(sc_class)} sf={bool(sf_class)})")
        # Revert the splash to a DEADLINE-PROTECTED phase before exiting. The last marker emitted
        # was `scanning`/`resolving`, which the app's splash has NO dismiss timeout for (only
        # `searching` does) — and this path PERSISTS NOTHING (resolve_all skips calibrate on an
        # incomplete scan), so the supervisor re-spawns and cold-scans AGAIN every launch. Without
        # this the splash hangs forever on "First time on this version — mapping memory" (the
        # cold-scan-every-launch symptom: a scan run outside combat never completes the managers).
        # `searching` is the honest state (reader not ready, will retry) AND the one the app can
        # time out. Re-uses the existing marker vocabulary → no app-side change required.
        _emit_status("searching")
        return

    csd = save.pick_live_csd(reader, csd_list, stage_info)
    # The live party IDENTITY (heroKeys) gates on hero_cat (the ghost discriminator since 1.00.20 — see
    # build.read_live_party); level/exp are decoded live there. pick_live_sm gets hero_cat so pick<->read
    # agree on the carrier.
    sm = save.pick_live_sm(reader, sm_list, hero_cat)
    print(f"[live party] StageManager {'ok' if sm else 'NOT found (no live party/xp)'}"
          f" — {len(build.read_live_party(reader, sm, hero_cat))} heroes deployed.")
    # infra-log: the pick decision in detail — candidates, REAL carriers vs ghosts (heroKey ok but not a
    # catalog hero), which one was picked + a sample of ghosts. THIS was missing in the 1.00.13 debug:
    # "carriers=0 picked=0x.. party_read=0" would have pointed at the cause on the spot.
    _smd = build.describe_sm_candidates(reader, sm_list, sm, hero_cat)
    diag(f"[party-pick] startup candidates={_smd['total']} hk-accept={_smd['hk_accept']} "
         f"carriers={_smd['carriers']} picked={hex(_smd['picked']) if _smd['picked'] else None} "
         f"party_read={len(build.read_live_party(reader, sm, hero_cat))}")
    for _ga, _gh in _smd["ghosts"]:
        diag(f"[party-pick]   ghost {hex(_ga)} heroes(hk,lvl,exp)={_gh}")
    # infra-log: the SAVE pick — PSD (the build's gold/heroes source) and CSD (current stage). PSD None was
    # the 1.00.12 bug (save offsets shifted → read_gold=0 → pick_live_psd None → run with no
    # heroes/gold → upload stalled). Logging psd/gold/heroes here makes that failure mode visible.
    _psd = save.pick_live_psd(reader, psd_list)
    diag(f"[save-pick] psd_cands={len(psd_list)} psd={hex(_psd) if _psd else None} "
         f"gold={save.read_gold(reader, _psd) if _psd else None} "
         f"heroes={len(save.read_heroes(reader, _psd)) if _psd else 0}; "
         f"csd_cands={len(csd_list)} csd={hex(csd) if csd else None}")
    # Live gold: reads GoldEarn[SubKey1] from the LIVE AggregateManager, resolved by STRUCTURE (name-free,
    # immune to the obfuscated name changing between builds; see metrics.gold). Reuses the cached klass if still
    # valid (cheap); otherwise resolves. All the logic lives in gold.py — here we just call.
    if not (gold_klass and combat_gold_klass_ok(reader, gold_klass)):
        # §6 fallback: primary index (~ms, calibrated build) → value-scan fallback (~90s, no calib
        # or index failed). resolve_combat_gold_klass_by_index already has the anti-poison gate (round-trip),
        # so None = bad index/no calib → falls back to the value-scan, NEVER serves a wrong klass.
        gold_klass = None
        if tbase and idx_ut is not None:
            gold_klass = resolve_combat_gold_klass_by_index(reader, tbase, idx_ut)
        if not gold_klass:
            gold_klass = resolve_combat_gold_klass(reader, psd_list)
    if gold_klass:
        print(f"[live gold] AggregateManager klass {hex(gold_klass)} — GoldEarn[SubKey1] live "
              f"(exact per-run, lag-free, excludes selling; immune to name drift)")
    else:
        print("[live gold] NOT resolved — combat gold from save (stale, fallback)")
    # infra-log: resolved gold + live value (combat). klass=None or an absurd live (0 / 1.97T) =
    # the gold source broke — historical gold bugs (value-scan catching frozen=0 or junk).
    diag(f"[gold] klass={hex(gold_klass) if gold_klass else None} "
         f"live={combat_gold_live(reader, gold_klass) if gold_klass else None}")
    print("Measuring per run (success/fail) — Ctrl+C to exit.\n")
    _emit_status("ready")   # app: reader attached + resolved -> splash closes

    snap_dir = output_dir
    try:
        os.makedirs(snap_dir, exist_ok=True)
    except Exception:
        pass
    # RAW live snapshot (~1x/s), overwritten: the reader emits live numbers/ids and the APP cooks the
    # overlay (computeDps/resolveStage/modeName) — presentation-dumb reader.
    # Replaced the cooked meter_live.txt (dps/label/format in the reader). Transport =
    # overwritten file (not a channel); the app polls by mtime-advance (LiveSource, SMB-skew immune).
    live_path = os.path.join(snap_dir, "live.json")
    raw_dir = os.path.join(snap_dir, "raw")   # 1 file per run: raw/<ts_ms>.json (raw; id = timestamp)
    os.makedirs(raw_dir, exist_ok=True)

    interval = 1.0 / hz

    def new_run():
        nonlocal sm
        # pick_live_sm returns None if no party is in the field (attached in town/menu): retries
        # every run to grab the PARTY-CARRYING instance as soon as a party is deployed. Without
        # this, sm stays None the whole session if startup was out of combat → live party/XP off.
        if not sm:
            sm = save.pick_live_sm(reader, sm_list, hero_cat)
        p = save.pick_live_psd(reader, psd_list)
        # LIVE party identity (heroKeys, gated on hero_cat); level + within-level exp decoded live in
        # read_live_party (save_heroes = the snapshot passed for the level fallback on a bad decode).
        _sh = save.read_heroes(reader, p)
        pl0 = build.read_live_party(reader, sm, hero_cat, _sh)
        # LIVE per-hero xp accumulator (metrics.xp.PartyXpAccumulator) — the primary LIVE of the
        # xp chain. Run state is born HERE (never only at close — that would leak the previous run) and is
        # SEEDED with the t=0 party. Whoever enters LATER (late deploy / a dead hero from the previous run who
        # revives mid-run) seeds on their 1st sighting in the 1s snapshot — the fix for the +0xp that the
        # endpoint delta (exp_start only at t=0) gave a hero outside the baseline.
        xpacc = xp.PartyXpAccumulator()
        xpacc.update(pl0)
        return {"dps": DpsTracker(), "mobs": 0, "start": time.time(),
                "gold_start": save.read_gold(reader, p) or 0,
                # LIVE combat-gold baseline at the START (delta at close = the run's gold).
                # + the save baseline as fallback (if the live one doesn't resolve). All via gold.py.
                "gold_live_start": combat_gold_live(reader, gold_klass),
                "gold_save_start": combat_gold_save(reader, p),
                "heroes_start": {k: v[1] for k, v in _sh.items()},
                "party_live_start": pl0,
                "xp_acc": xpacc,
                "build": build.read_build(reader, p, item_cat, hero_cat),
                "drops": [],
                # heroKeys seen deployed during the run (accumulated from the 1s snapshot) — covers the
                # sm that resolves LATE: pl_start empty, but the party appears seconds later.
                "party_seen": {},
                # The run's deaths/revives/who-killed (heroKey-keyed; from the HeroDie/Resurrection logs).
                "deaths": {}, "revives": {}, "killers": {},
                "stage_key": None, "adopt_until": time.time() + 3.0}

    R = new_run()
    # run_num is NOT reset here — it's resumed from resume_session (above) so as not to recycle an id.
    _ll0 = reader.rptr(lm + LogManager.LOG_LIST)
    last_size = (reader.ri32(_ll0 + List.SIZE) or 0) if _ll0 else 0
    last_alive = 0
    prev_dead = None    # previous DeadMonsterUnit size (to detect a stage reload)
    dead_reads = 0      # consecutive failing reads = game closed/restarted (re-attach)
    last_snap = 0.0
    last_refresh = 0.0
    REFRESH = 1.0
    # "live" variables read in the loop (also used at close)
    cur_key = reader.ri32(csd + CommonSaveData.CURRENT_STAGE_KEY) if csd else None
    total_mobs = None
    stage_lbl = "?"
    mode_txt = "?"

    # PENDING-CLOSE (trailing boss box): a SUCCESS record doesn't go to disk right away —
    # it stays pending for up to PENDING_CLOSE_GRACE to absorb the GetBoxLog mt=1/2 the game
    # emits ~0.6s AFTER the StageClearLog (otherwise the boss chest fell into the NEXT run).
    # fail/abandoned write immediately (a boss box only trails a clear). State: rec (mutated via
    # _absorb_drop) + path + deadline + absorbed (only the post-close chests, for the live count).
    pending = None

    def flush_pending():
        # Write the pending one (if any) and clear it. Called from ALL exit points of the
        # window: on the tick with an expired deadline, AFTER the LOG_LIST scan (a boss box
        # surfacing on the SAME tick as the expiry still gets absorbed — effective window GRACE + ≤1
        # tick); the TOP of close_run (any status — preserves record order on disk
        # and guarantees AT MOST one pending); the game-closed/re-attach path (the pending one is
        # a COMPLETE run already closed; losing it because the game closed 2s after the clear would be
        # a regression — today it would already be on disk); and run()'s finally (Ctrl+C/exception).
        # never-raises (_flush_pending_rec).
        nonlocal pending
        _flush_pending_rec(pending)
        pending = None

    def close_run(status, stage_key, e=None):
        # Close the current run with a status (success/fail/abandoned), record it and restart.
        # stage_key = the stage that WAS being played (in the abandoned case, the old one).
        nonlocal R, run_num, gold_klass, pending
        # Flush the pending one BEFORE assembling the new record: two closes within the window
        # (e.g. clear → abandon at the grace expiry) come out in ORDER on disk and there are never
        # two pending. In the common case (no pending) it's a no-op.
        flush_pending()
        si = stage_info.get(stage_key)
        act = si[0] if si else None
        stage = si[1] if si else None
        total = (si[2] + 1) if si else None
        mode = DIFF_NAMES.get(si[3], "?") if si else "?"
        clear_time = 0
        wave_now = wave_tot = None
        if status in ("success", "fail") and e is not None:
            la, ls = reader.ri32(e + StageClearLog.ACT), reader.ri32(e + StageClearLog.STAGE)
            act = la if la is not None else act
            stage = ls if ls is not None else stage
            if status == "success":
                clear_time = reader.ri32(e + StageClearLog.CLEAR_TIME) or 0
            else:
                wave_now = reader.ri32(e + StageFailedLog.NOW_WAVE)
                wave_tot = reader.ri32(e + StageFailedLog.TOTAL_WAVE)
        measured = time.time() - R["start"]
        # The reader emits EVERY run — short/partial included ("skip ≠ vanish", otherwise the user thinks the
        # meter broke). What decides what COUNTS (15s floor exc. x-10) is the CONVERTER (app), applying
        # _should_skip_run over this record's RAW fields — that's why the reader NO LONGER calls it here
        # (it stays the drift-tested canonical spec, ported to TS in the converter). `partial` below is
        # only a summary/console annotation; it also does NOT enter the record (the converter derives it).
        fp = save.pick_live_psd(reader, psd_list)
        heroes_end = save.read_heroes(reader, fp)
        # Gold per run = delta of the LIVE combat cumulative (GoldEarn[SubKey1] of the AggregateManager;
        # exact, real-time, excludes selling/idle). Only falls back to the SAVE delta if the live one doesn't
        # resolve/read (the save lags and jumps -> can give 0 or ~2x; that's why it's only a fallback). All in gold.py.
        live_gain = run_gain(R.get("gold_live_start"), combat_gold_live(reader, gold_klass))
        if live_gain is not None:
            gold_gain, ge_src, gold_ok = live_gain, "live", True
        else:
            save_delta = run_gain(R.get("gold_save_start"), combat_gold_save(reader, fp))
            # Live AND save both failed -> do NOT write 0 (this was the gold:0 bug, indistinguishable from a zero gain):
            # gold_ok=False -> the envelope marks err and the converter degrades the run, honestly.
            gold_ok = save_delta is not None
            gold_gain, ge_src = (save_delta if gold_ok else 0), "save"
        # PARTIAL capture: the meter joined a run already in progress (saw < 80% of the official clear) ->
        # damage/gold/xp undercounted. An EXPLICIT flag so the app discards by the flag, instead of inferring
        # "partial" from gold==0 (which silently hid COMPLETE runs whenever the live gold read
        # failed). Only on a clear (clear_time = official duration); gated on >=30s so x-10 runs
        # (boss, seconds) are never mis-flagged. EXCEPTION to the exception: a success with ZERO measured
        # damage is always a missed capture (the game doesn't clear a stage with no damage) — covers the gap of x-10s
        # with clear <30s, which skipped the check and pushed all-zeros to the leaderboard (#163).
        partial = _is_partial(status, clear_time, measured, R["dps"].total_damage)
        # save-side xp (fallback only): per-hero HeroExp delta (already includes runes/items/bonuses).
        # HeroExp zeroes on level-up -> the gain of whoever levels up is underestimated (rare for a high-level
        # hero). At the CAP HeroExp also NEVER resets (no level-up to consume it) -> the save delta
        # is PHANTOM XP: a hero at the cap (xp.level_capped) is worth 0, same as the live one. xp_gain = sum of
        # the per-hero deltas (the live one, without these problems, is the normal path).
        xp_by_hero = {k: 0.0 if xp.level_capped(v[0]) else max(0.0, v[1] - R["heroes_start"].get(k, 0.0))
                      for k, v in heroes_end.items()}
        xp_gain = sum(xp_by_hero.values())
        # LIVE XP = the per-hero ACCUMULATOR (metrics.xp.PartyXpAccumulator), which integrated the
        # within-level exp tick-by-tick the WHOLE run (seeded in new_run, fed by the 1s snapshot). Here
        # only: 1 FINAL tick (banks the last ≤1s) + reading the finished records. Replaces the endpoint
        # delta (t=0 baseline → read at close), which gave +0 to a hero OUTSIDE the baseline (late deploy
        # / a dead hero from the previous run revived: gain=None → +0 in the app) — the accumulator banks
        # the gain of whoever died (a dead hero accumulates 0 while dead, real game behavior, preserved).
        # 1.00.20: the live within-level exp is decoded from the ACTk cipher in read_live_party and feeds
        # the accumulator → xp_source="live". If a decode fails (exp None → accumulator saw nobody →
        # xp_live_ok=False), xp falls back to xp_gain (the per-hero SAVE delta) tagged xp_source="save".
        xpacc = R["xp_acc"]
        # LIVE party identity (gated on hero_cat); level/exp decoded live in read_live_party (heroes_end
        # is the save snapshot, passed for the level fallback on a bad decode). never-raises -> {}.
        pl_end = build.read_live_party(reader, sm, hero_cat, heroes_end)
        xpacc.update(pl_end)
        R["party_seen"].update(dict.fromkeys(pl_end))  # live at close = seen (live_keys ⊇ acc)
        # XP per-run = the LIVE one (real-time, exact). The save is a lagging snapshot (useless delta: 0 or a
        # ~10M jump depending on where the save-write falls in the run = jitter) -> NO longer recorded; only a silent
        # fallback if the live one didn't happen (the accumulator never saw anyone = sm off the whole run), so as to never
        # zero xp in a degraded case. total() returns None in that case — NEVER conflate with 0 (a valid gain).
        xp_total_live = xpacc.total()
        xp_live_ok = xp_total_live is not None
        xp_best = round(xp_total_live, 2) if xp_live_ok else xp_gain
        xp_src = "live" if xp_live_ok else "save"
        # xp was read if the live one happened (the accumulator saw someone) OR there was save data (heroes_end). Neither ->
        # err in the envelope (same logic as gold: didn't-read != gained-zero).
        xp_ok = xp_live_ok or bool(heroes_end)
        # The artifact = only the heroes ACTUALLY deployed in this run (live party = StageManager.HeroList).
        # The save lists the arranged party/roster (playing solo with the Ranger the save lists all 6) -> filter
        # by live_keys: pl_start ∪ party_seen (an sm that resolves LATE enters via the 1s snapshot).
        # HONEST DEGRADATION (live party off the WHOLE run, sm null => live_keys empty): NOBODY enters
        # (hero_in_run), heroes becomes `err` and the run gets a ⚠ in the log — NEVER dump the save's roster (this was
        # the BUG — 5 heroes with +0xp playing solo) nor proxy-guess by xp>0 (it would catch idle xp). See
        # [[invariants/party-live-resolution]].
        live_stats = build.read_live_stats_by_hero(reader, sm)  # T3: 64 live FINAL stats per heroKey
        pl_start = R.get("party_live_start", {})
        live_keys = set(pl_start) | set(R.get("party_seen") or ())
        party_degraded = not live_keys
        heroes_out = []
        for h in R["build"]:
            hk = h["heroKey"]
            # Inclusion (pure/testable rule in build.hero_in_run): ONLY the LIVE party's heroes
            # (live_keys). With NO live party, NOBODY enters -> heroes becomes `err` (heroes_ok=False below),
            # never the roster nor a guess. This was the bug of 5 heroes with +0xp playing solo.
            if not build.hero_in_run(hk, live_keys):
                continue
            hh = dict(h)
            hh["stats"] = live_stats.get(hk, {})
            xrec = xpacc.record(hk)
            if xrec is not None:
                # Normal path: the run's LIVE accumulated total (0.0 = a VALID zero gain, not a failure).
                hh["xp_gained"] = xrec["gain"]
                hh["exp_start"] = xrec["exp_start"]
                hh["exp_end"] = xrec["exp_end"]
                if xrec["levelup"]:
                    hh["levelup"] = True
                if hk not in pl_end:
                    hh["died"] = True   # absent from the HeroList at close (dead with no revive)
            else:
                # No live accumulator record for this hero -> per-hero SAVE fallback (xp_by_hero),
                # NEVER None/+0 (the boundary-death bug) nor the roster.
                # Two cases:
                #  - the live xp source saw NOBODY (xp_live_ok=False: every hero's cipher decode failed,
                #    or sm was off the whole run) -> the run already degraded to xp_source="save", so this
                #    is the EXPECTED honest fallback, NOT an anomaly -> no ⚠.
                #  - The acc saw SOMEONE but missed THIS hero (xp_live_ok=True): a real regression (the acc
                #    eats the SAME reads that feed pl_start/party_seen) -> ⚠ makes it OBSERVABLE: if it
                #    fires, sum(heroes.xp) exceeds the run total (acc excludes this save-sourced hero).
                hh["xp_gained"] = round(xp_by_hero.get(hk, 0.0), 2)
                if xp_live_ok:
                    print(f"⚠ xp acc-miss hero={hk} (in live_keys with no acc record) "
                          f"-> save fallback +{hh['xp_gained']}")
            # Per-hero survival (from the HeroDie/Resurrection logs): deaths, revives, who killed.
            deaths_h = R["deaths"].get(hk, 0)
            if deaths_h:
                hh["deaths"] = deaths_h
            revives_h = R["revives"].get(hk, 0)
            if revives_h:
                hh["revives"] = revives_h
            killed_by = R["killers"].get(hk)
            if killed_by:
                hh["killed_by"] = killed_by                            # monsterKeys that killed this hero
            heroes_out.append(hh)
        ref = clear_time if clear_time else max(measured, 1)
        total_damage = R["dps"].total_damage
        dps = total_damage / ref
        def _hxp(h):
            return fmt(h.get("xp_gained", 0.0)) + ("⇧lvl" if h.get("levelup") else "")
        party = ", ".join(f"{h['heroKey']}/{h['class']}/{h['level']}(+{_hxp(h)}xp)"
                          for h in heroes_out) or "?"
        mark = {"success": "✔", "fail": "✗", "abandoned": "↩"}.get(status, "•")
        if status == "success":
            head = f"official {clear_time}s (measured {measured:.0f}s)"
            if clear_time and abs(measured - clear_time) > 0.2 * clear_time:
                head += " ⚠ measured≠official"
            if partial:
                head += " ⚠partial"
        elif status == "fail":
            head = f"measured {measured:.0f}s  wave {wave_now}/{wave_tot}"
        else:
            head = f"measured {measured:.0f}s  (partial)"
        n_deaths = sum(R["deaths"].values())
        # degraded party (live off the WHOLE run): heroes becomes `err` in the raw -> the converter seals the run
        # `degraded` (doesn't go to the leaderboard; shows in the app, flagged). The line gets a ⚠ in meter.log
        # -> observable (and validate_live.py catches it live). Never slips through.
        party_warn = " ⚠party unavailable(live off)" if party_degraded else ""
        summary = (f"{mark} run #{run_num} [{status.upper()}]  Stage {act}-{stage} [{mode}]  "
                   f"{head}  DPS {fmt(dps)}/s  damage {fmt(total_damage)}  deaths {n_deaths}  "
                   f"mobs {R['mobs']}/{total or '?'}  "
                   f"gold +{fmt(gold_gain)}[{ge_src}]  xp +{fmt(xp_best)}[{xp_src}]  "
                   f"party{party_warn} [{party}]")
        print("\n" + summary)   # goes to meter.log (event log) — not the app's source
        # infra-log (reader-diag.log): WHY the run is good/degraded, in structured fields (the
        # meter.log mixes everything into one text line). gold_ok/xp_ok/party_degraded point to WHICH
        # field dropped (party_degraded=True → heroes:err → degraded run); src=live/save = the fallback.
        diag(f"[run-close] #{run_num} {status} stage={act}-{stage}[{mode}] measured={measured:.0f}s "
             f"clear={clear_time}s partial={partial} gold_ok={gold_ok}/{ge_src} "
             f"xp_ok={xp_ok}/{xp_src} party_degraded={party_degraded} "
             f"heroes_out={len(heroes_out)} live_keys={len(live_keys)}")
        # Account snapshot at close (SAVE source): RAW runes + inventory + stash. Reuses `fp`
        # (the live psd already picked above) and `item_cat` (run()'s free-var). never-raises; DIDN'T-READ ->
        # None (becomes err in the record below), never a silent [].
        runes, inventory, stash = build.read_account_snapshot(reader, fp, item_cat)
        # RAW v2 record (raw/<id>.json), 1 file per run, atomic write. ONLY observation — no
        # dps/rates/partial/mode/stage-string/totals (the converter derives them). Read fields go
        # in an ok/err envelope. The `dps`/`partial` above are only for the summary/live; they do NOT enter here.
        ts_ms = int(time.time() * 1000)   # id = END timestamp in ms (the run's identity; no session/counter)
        rec = build_raw_record(
            ts_ms=ts_ms, run_outcome=status,
            game_version=game_version, duration=measured,
            stage_key=stage_key, act=act, stage_no=stage,
            difficulty=(si[3] if si else None), total_mobs=total,
            mobs=R["mobs"], total_damage=total_damage, clear_time=clear_time,
            gold=gold_gain, gold_ok=gold_ok, gold_source=ge_src,
            xp_gained=xp_best, xp_ok=xp_ok, xp_source=xp_src,
            drops=R["drops"], heroes=heroes_out, heroes_ok=(not party_degraded),
            runes=runes, inventory=inventory, stash=stash)
        rec_path = os.path.join(raw_dir, f"{rec['id']}.json")   # raw/<ts_ms>.json (id = ts in ms)
        if status == "success":
            # SUCCESS pends instead of writing NOW: the clear's boss box (GetBoxLog mt=1/2)
            # arrives ~0.6s later, in another LOG_LIST growth — the loop absorbs it into the pending
            # rec (_absorb_drop) and the flush goes out on the deadline/next close/re-attach/exit.
            # The record is COMPLETE (id = ts_ms of now); only the write is deferred.
            pending = _new_pending(rec, rec_path, time.time())
        else:
            # fail/abandoned: a boss box only trails a clear → write immediately, as always.
            _write_atomic(rec_path, json.dumps(rec, ensure_ascii=False))
        # Self-heal: SUCCESS with damage but the gold came from the SAVE (the live one didn't read) = the klass went
        # stale (e.g. the game switched save/instance) -> re-resolve the AggregateManager for next time.
        # SAME trigger as always (success + ge_src=="save" + total_damage>0); only the HOW changes: §6
        # primary index (~ms — on a calibrated build it no longer stalls the loop ~90s) → value-scan fallback.
        # tbase/idx_ut read as free-vars (run()-locals; at re-attach the tbase is reassigned to the new
        # ga_base, so a self-heal after a re-attach uses the live table, not the dead one — NEW-2).
        if status == "success" and ge_src == "save" and total_damage > 0:
            gk = None
            if tbase and idx_ut is not None:
                gk = resolve_combat_gold_klass_by_index(reader, tbase, idx_ut)
            gold_klass = gk or resolve_combat_gold_klass(reader, psd_list)
        run_num += 1   # local console/log counter (doesn't persist; the run's identity is the timestamp)
        R = new_run()

    try:
        while True:
            now = time.time()
            # GAME closed/restarted? Reading the dead process fails (rptr -> None). Sustained
            # for ~5s => discard the interrupted run, wait for the game to come back, re-attach and re-resolve.
            if reader.rptr(lm + LogManager.LOG_LIST) is None:
                dead_reads += 1
            else:
                dead_reads = 0
            if dead_reads >= int(hz * 5):
                print("\n[game closed/restarted] reads failing — discarding run, re-attaching...")
                # The pending one is a COMPLETE run (success already closed) — flush BEFORE discarding
                # the interrupted run: the game closing 2s after a clear can't vanish the record
                # (without the pending-close it would already be on disk). Normally the deadline (3s) already
                # flushed before these 5s of dead reads; this is the belt-and-suspenders.
                flush_pending()
                close(handle)
                while True:
                    npid = find_pid()
                    if npid:
                        handle = open_process(npid)
                        if handle:
                            reader = Reader(handle)
                            print(f"[re-attaching] game came back (pid {npid}), re-resolving (~1-2min)...")
                            # The restart may have been a game update -> re-read version + recompute
                            # the fp BEFORE resolving (the restart changes the ga_base per ASLR — the calib's
                            # anchor_rva is build-stable and re-read live; the fp only changes if the build changed).
                            gv = _detect_game_version(handle)
                            game_version = gv or GAME_VERSION
                            ga_base_r, _ = typeinfo.ga_module(npid)
                            fp = typeinfo.build_fingerprint(reader, ga_base_r, gv) if ga_base_r else None
                            # infra-log: a game UPDATE shows up here as an fp DIFFERENT from startup's
                            # → seed-miss → cold scan (the resolve_all below logs the path). Visible on the spot.
                            diag(f"[reattach] pid={npid} version={game_version} fp={fp} "
                                 f"ga_base={hex(ga_base_r) if ga_base_r else None}")
                            try:
                                # calib is fp-keyed and already persisted by the initial scan → do NOT re-save
                                # here (no legacy save_cache: the gate handles the persist in the slow path).
                                rr = resolve_all(reader, npid, fp, cache_path)
                            except Exception:
                                rr = None
                            if rr and rr[0] and rr[1] and rr[2] and rr[3]:
                                (sc_class, sf_class, msm, lm, csd_list, psd_list,
                                 stage_info, item_cat, hero_cat, sm_list, gold_klass, gb_class,
                                 die_class, res_class) = rr
                                csd = save.pick_live_csd(reader, csd_list, stage_info)
                                sm = save.pick_live_sm(reader, sm_list, hero_cat)
                                _smd = build.describe_sm_candidates(reader, sm_list, sm, hero_cat)
                                diag(f"[party-pick] re-attach candidates={_smd['total']} "
                                     f"hk-accept={_smd['hk_accept']} carriers={_smd['carriers']} "
                                     f"picked={hex(_smd['picked']) if _smd['picked'] else None}")
                                # gold_klass already came from resolve_all (rr) above
                                # NEW-2: the re-attach changed the ga_base (ASLR) → the old tbase is DEAD.
                                # Recompute the run()-local tbase via anchor_rva (build-stable) over the
                                # NEW ga_base_r, so the subsequent self-heals read the live
                                # TypeInfoTable (otherwise the gold would fall back to the value-scan ~90s every run). idx_ut is
                                # a build constant (same fp) → unchanged at re-attach.
                                _cr = load_calib(cache_path, fp) if fp else None
                                if _cr and ga_base_r:
                                    tbase = typeinfo.table_base(reader, ga_base_r, _cr["anchor_rva"])
                                    idx_ut = _cr["idx_ut"]
                                else:
                                    tbase = idx_ut = None
                                R = new_run()
                                _ll = reader.rptr(lm + LogManager.LOG_LIST)
                                last_size = (reader.ri32(_ll + List.SIZE) or 0) if _ll else 0
                                last_alive = 0
                                prev_dead = None
                                cur_key = reader.ri32(csd + CommonSaveData.CURRENT_STAGE_KEY) if csd else None
                                dead_reads = 0
                                print(f"[ok] re-attached (game version {game_version}"
                                      + ("" if gv else " (fallback — Version.txt unreadable)") + "). "
                                      "Interrupted run discarded; measuring again.\n")
                                break
                            close(handle)
                    time.sleep(3)
                continue
            # Orchestrated DPS: reads the mobs in a BATCH (game.models.live_monsters via Reader) and
            # delegates to metrics.dps.DpsTracker — damage = Σ HP drop + finishing blow, the 5s window
            # and total live in the tracker (reset per run via new_run). Here only what's the
            # meter's: kill count (drop in the live count) and the smoothed DPS for the screen.
            dps_t = R["dps"]
            dps_t.update(read_live_monsters(reader, msm), now)
            alive = dps_t.alive
            if alive < last_alive:
                R["mobs"] += (last_alive - alive)
            last_alive = alive
            dps_live = dps_t.dps(now)

            if now - last_refresh >= REFRESH:
                c = save.pick_live_csd(reader, csd_list, stage_info)
                if c:
                    csd = c
                last_refresh = now

            # LIVE stageKey: prefers the MONSTER's (bceo) — the save's freezes on a switch.
            # With no monsters (between stages/waves), keep the last known one.
            live_sk = read_live_stage_key(reader, msm)
            if live_sk:
                cur_key = live_sk
            elif cur_key is None and csd:
                cur_key = reader.ri32(csd + CommonSaveData.CURRENT_STAGE_KEY)
            _si = stage_info.get(cur_key)
            # +1 = the boss (StageInfoData counts only the horde mobs; we also kill the boss)
            total_mobs = (_si[2] + 1) if _si else None
            stage_lbl = f"{_si[0]}-{_si[1]}" if _si else "?"
            mode_txt = DIFF_NAMES.get(_si[3], "?") if _si else "?"

            # Manual RESTART of the SAME stage: DeadMonsterUnit is cumulative and DROPS when the
            # stage reloads on a manual restart. Clear/auto-replay do NOT zero it (they log separately).
            dead_now = reader.ri32((reader.rptr(msm + MonsterSpawnManager.DEAD_MONSTER_LIST) or 0) + List.SIZE)
            reloaded = (prev_dead is not None and dead_now is not None and dead_now < prev_dead - 2)
            if dead_now is not None:
                prev_dead = dead_now

            # close by LOG: StageClearLog (success) or StageFailedLog (fail)
            closed = False
            loglist = reader.rptr(lm + LogManager.LOG_LIST)
            size = reader.ri32(loglist + List.SIZE) if loglist else None
            if size is not None and size != last_size:
                if size > last_size:
                    items = reader.rptr(loglist + List.ITEMS)
                    for i in range(last_size, min(size, last_size + 300)):
                        e = reader.rptr(items + Array.DATA + i * 8) if items else None
                        if not e:
                            continue
                        kl = reader.rptr(e)
                        if kl == sc_class:
                            close_run("success", cur_key, e); closed = True
                        elif kl == sf_class:
                            close_run("fail", cur_key, e); closed = True
                        elif gb_class and kl == gb_class:
                            # GetBoxLog @0x40 is the TYPE ("TreasureChest_<Type>"), NOT an item key
                            # (confirmed live). The authoritative tier is monster_type @0x50; the
                            # exact box variant isn't in the event → map the tier -> the canonical
                            # box key (BOX_KEY_BY_TIER). The old int(bk_str) swallowed EVERY drop.
                            # ROUTING: a BOSS chest (mt 1/2) arrives ~0.6s AFTER the clear (even
                            # in the SAME batch of entries: the close above already swapped R) → belongs
                            # to the PENDING success, not the new run. Mob (mt=0) → current run. With no
                            # pending (attached right after a clear) → current run + WARN; a real
                            # chest is never discarded. See docs/invariants/run-lifecycle.
                            mt = reader.ri32(e + GetBoxLog.MONSTER_TYPE)
                            box_key = BOX_KEY_BY_TIER.get(mt)
                            if box_key is not None:
                                drop = {"box_key": box_key, "monster_type": mt}
                                if (_box_belongs_to_pending(mt, pending is not None)
                                        and _absorb_drop(pending["rec"], drop)):
                                    pending["absorbed"].append(drop)
                                    print(f"\n[box] boss box (mt={mt}) absorbed into closed "
                                          f"run {pending['rec'].get('id')}")
                                else:
                                    if mt in TRAILING_BOX_TIERS:
                                        # Two DISTINCT reasons in the log (the meter.log triage
                                        # can't lie): no pending (e.g. attached right after
                                        # a clear) vs absorb refused (pending rec out of
                                        # shape — unreachable by construction today).
                                        why = ("absorb refused (malformed pending rec)"
                                               if pending is not None else "no pending close")
                                        print(f"\n[box] WARN boss box (mt={mt}) — {why}; "
                                              "credited to current run")
                                    R["drops"].append(drop)
                        elif die_class and kl == die_class:
                            # HeroDie: @0x48 = the dead hero, @0x40 = the monster that killed (LIVE-CRACKED).
                            victim = _suffix_int(reader.read_string(reader.rptr(e + HeroDieLog.VICTIM_HERO)))
                            killer = _suffix_int(reader.read_string(reader.rptr(e + HeroDieLog.KILLER_MONSTER)))
                            if victim is not None:
                                R["deaths"][victim] = R["deaths"].get(victim, 0) + 1
                                if killer is not None:
                                    R["killers"].setdefault(victim, []).append(killer)
                        elif res_class and kl == res_class:
                            # Resurrection: @0x40 = the revived hero. Auto-revive (~115s) or the Priest's skill.
                            rev = _suffix_int(reader.read_string(reader.rptr(e + ResurrectionLog.HERO)))
                            if rev is not None:
                                R["revives"][rev] = R["revives"].get(rev, 0) + 1
                last_size = size

            # Pending-close expired (GRACE elapsed with no more boss box) → flush and clear. AFTER
            # the LOG_LIST scan on purpose: a boss box surfacing on the SAME tick the
            # deadline expires still gets absorbed (effective window = GRACE + ≤1 tick,
            # harmless); at the top of the tick it would fall into the fallback with a WARN. The order on disk
            # doesn't change (close_run keeps auto-flushing at the top). The live count drops
            # back on the next snapshot (baseline in the app, no event).
            if pending is not None and now >= pending["deadline"]:
                flush_pending()

            # adopt the stage during the initial grace (handles auto-replay/advance post-clear)
            if cur_key is not None and cur_key in stage_info and (
                    R["stage_key"] is None or now < R["adopt_until"]):
                R["stage_key"] = cur_key
            # END by RESTART/switch without clear/fail: dead dropped (reload of the same stage) OR
            # bceo changed (stage switch). Once the grace is past, abandon the partial and restart.
            if not closed and now >= R["adopt_until"] and R["stage_key"] is not None:
                switched = (cur_key is not None and cur_key in stage_info
                            and cur_key != R["stage_key"])
                if reloaded or switched:
                    close_run("abandoned", R["stage_key"])

            elapsed = int(now - R["start"])
            mtxt = f"{R['mobs']}/{total_mobs}" if total_mobs else str(R["mobs"])
            # Per-tick live line (~hz/s). The app's overlay reads live.json (written
            # just below), NOT this stdout stream, and the reader runs hidden — so by
            # default this would only bloat meter.log. Emit it ONLY under --debug; that
            # keeps meter.log an event-level log (attach / resolve / run-close / errors).
            if debug:
                sys.stdout.write(
                    f"\rrun #{run_num}  Stage {stage_lbl} [{mode_txt}]  mobs {mtxt}  "
                    f"DAMAGE {fmt(dps_t.total_damage)}  DPS {fmt(dps_live)}/s  [{elapsed}s]   ")
                sys.stdout.flush()
            if now - last_snap >= 1.0:
                # "New session" is app-side now (Redesign 2): the app writes a cut in session-cuts.json
                # and DERIVES the session from the runs — the reader rotates nothing (this was consume_session_reset).
                # LIVE per-run gold/XP/party (1x/s): the app shows it in the overlay. An omitted line
                # (None/empty) -> disappears in the app (degrades cleanly on a reader without this). The live party
                # is read ONCE here and reused for xp + frame. The build stays only at close.
                if not sm:  # found lazily when the player enters a stage
                    sm = save.pick_live_sm(reader, sm_list, hero_cat)
                # Live save (for the level fallback + the gold/xp save fallback). Picked BEFORE the party.
                psd = save.pick_live_psd(reader, psd_list)
                heroes_now = save.read_heroes(reader, psd) if psd else {}
                # LIVE party identity (heroKeys, gated on hero_cat); level + within-level exp decoded live
                # in read_live_party (heroes_now is the save snapshot, for the level fallback on a bad decode).
                pl_end = build.read_live_party(reader, sm, hero_cat, heroes_now)
                R["party_seen"].update(dict.fromkeys(pl_end))
                # LIVE xp accumulator (the SAME object that closes the run in close_run): integrates the
                # per-hero tick — the 1st sighting seeds the baseline; then sums increments > 0 (level-up by
                # the curve). Fed the live decoded exp → drives the overlay's live xp/ETA; the SAVE fallback
                # below only kicks in if the decode fails (total() None).
                R["xp_acc"].update(pl_end)
                # 64 live FINAL stats per hero (same read as the close). Additive in live.json:
                # feeds the per-hero effective-resistance tooltip in the overlay. never-raises -> {}.
                live_stats = build.read_live_stats_by_hero(reader, sm)
                # The EXACT same source as the close (gold.py): live cumulative - the start baseline.
                g_gain = run_gain(R.get("gold_live_start"), combat_gold_live(reader, gold_klass))
                if g_gain is None:
                    try:
                        g_gain = run_gain(R.get("gold_save_start"), combat_gold_save(reader, psd))
                    except Exception:
                        g_gain = None
                # the overlay's live xp = the accumulator's total (includes the banked of whoever died and the
                # of whoever entered late — the overlay doesn't "lose" xp when a hero dies). None =
                # no hero seen alive yet -> falls back to the SAVE below (never conflate with 0).
                x_gain = R["xp_acc"].total()
                if x_gain is None:
                    try:
                        # Hero at the CAP: the save delta is phantom (HeroExp never resets) -> 0.0,
                        # the SAME rule as close_run's xp_by_hero (overlay/record parity). heroes_now
                        # was already read above (reused — same snapshot that fed the party's level).
                        x_gain = (sum(0.0 if xp.level_capped(v[0])
                                      else max(0.0, v[1] - R["heroes_start"].get(k, 0.0))
                                      for k, v in heroes_now.items()) if heroes_now else None)
                    except Exception:
                        x_gain = None
                # Party keys: whoever ENTERED the run (start) + whoever was SEEN deployed later
                # (party_seen; a dead hero doesn't drop from the frame) — NEVER the save's roster (it would show
                # non-deployed heroes). Empty -> line omitted -> frame disappears in the app.
                pl0 = R.get("party_live_start") or {}
                party_keys = list(pl0) + [k for k in R["party_seen"] if k not in pl0]
                # Live loot: chest count per EMonsterLogType (index = the enum value) —
                # CURRENT run + those absorbed by the pending-close (the trailing boss box RAISES the
                # count while the live stage_key is still the cleared one; it's that rising-edge that
                # the app's cooldown-tracker/drop-notifier detect — see _drop_counts).
                dc = _drop_counts(R["drops"], pending["absorbed"] if pending else None)
                # RAW snapshot (no cooking): act/stageNo/difficulty go raw (the app formats "3-9" and
                # the mode name), damage_now/elapsed raw (the app derives the dps with the SAME computeDps as the
                # record). gold/xp/party/drops as already read; None disappears in the overlay. ATOMIC write
                # (tmp+rename): the app may read live.json at any moment → never a half-file.
                _si_live = stage_info.get(cur_key)
                # Per-hero live leveling snapshot (level+exp+accumulated gain) for the overlay's
                # time-to-level — assembled from the SAME pl_end + xp accumulator already in hand
                # (metrics/xp keeps this orchestrator read-free). Additive in live.json (like party_stats).
                live_progress = xp.party_progress(R["xp_acc"], pl_end)
                live_rec = build_live_record(
                    run=run_num,
                    stage_key=cur_key,
                    act=_si_live[0] if _si_live else None,
                    stage_no=_si_live[1] if _si_live else None,
                    difficulty=_si_live[3] if _si_live else None,
                    mobs=R["mobs"], total_mobs=total_mobs,
                    damage_now=dps_t.total_damage, elapsed=elapsed,
                    gold_now=g_gain, xp_now=x_gain,
                    party=party_keys, drops=[dc[0], dc[1], dc[2]],
                    party_stats=live_stats,
                    party_progress=live_progress)
                _write_atomic(live_path, json.dumps(live_rec))
                last_snap = now
            time.sleep(interval)
    except KeyboardInterrupt:
        print(f"\n\n[done] runs in {raw_dir}. cheers!")
    finally:
        # A clear in the last GRACE seconds before Ctrl+C/exception can't vanish: the
        # pending one is a complete run — flush before releasing the handle.
        flush_pending()
        close(handle)


DEFAULT_OUTPUT = os.path.join(os.path.expanduser("~"), "tbh-meter")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hz", type=float, default=10.0)
    # Output folder for EVERYTHING (raw/<ts_ms>.json, live.json, meter.log,
    # resolve_cache.json). Default = ~/tbh-meter (the folder the app already reads).
    ap.add_argument("--output", default=DEFAULT_OUTPUT,
                    help="output directory (default: ~/tbh-meter)")
    ap.add_argument("--selftest", action="store_true",
                    help="load bundled resources (config/level_curve.json, skill_attr_map.json) "
                         "and exit; CI uses this to catch a broken PyInstaller --add-data/_MEIPASS")
    ap.add_argument("--debug", action="store_true",
                    help="print the per-tick live meter line to stdout (legacy terminal "
                         "view). Off by default: the app reads live.json and the "
                         "reader runs hidden, so this is only useful when you run the "
                         "reader in a terminal yourself to debug.")
    args = ap.parse_args()
    if args.selftest:
        # Force the frozen-resource path: xp.curve()/build.skill_attr_map() load their
        # bundled config JSON via shared.utils.resource_path. A broken --add-data /
        # sys._MEIPASS fails HERE (nonzero exit, at CI build time) instead of silently
        # at runtime (a level-up / a run close).
        try:
            levels = len(xp.curve())
            skills = len(build.skill_attr_map())
        except Exception as e:
            print(f"selftest FAILED: {e}")
            raise SystemExit(1) from e
        if not skills:
            print("selftest FAILED: skill_attr_map loaded 0 entries (missing/empty bundle)")
            raise SystemExit(1)
        # Calibration SEED (seed-calib): OPTIONAL. If BUNDLED, validate the shape (fmt + non-empty
        # calib block) so a corrupt/truncated seed FAILS here in CI, not at runtime. If
        # ABSENT, pass with a log — "no seed yet" is a valid, releasable state (a new build before
        # capture via scripts/dump_calib_seed.py). The --add-data + the committed file guarantee that,
        # when it should exist, it does (PyInstaller fails the build if --add-data points at a missing file).
        seed_fps = None
        try:
            _sd = json.load(open(_seed_path(), encoding="utf-8"))
            if _sd.get("fmt") != CACHE_FMT or not _sd.get("calib"):
                print(f"selftest FAILED: calib_seed.json bundled but malformed "
                      f"(fmt={_sd.get('fmt')}, calib empty?)")
                raise SystemExit(1)
            seed_fps = list(_sd["calib"].keys())
            # Each seed fp must pass the SAME runtime load gate (_read_calib,
            # incl. _stage_info_ok): a seed the runtime would silently reject
            # (→ cold scan on every 1st launch) fails HERE, in CI.
            _bad = [f for f in seed_fps if _read_calib(_seed_path(), f) is None]
            if _bad:
                print(f"selftest FAILED: calib_seed.json fp(s) rejected by load "
                      f"validation: {_bad}")
                raise SystemExit(1)
        except FileNotFoundError:
            pass
        except SystemExit:
            raise
        except Exception as e:
            print(f"selftest FAILED: calib_seed.json unreadable: {e}")
            raise SystemExit(1) from e
        seed_msg = f", calib_seed [{', '.join(seed_fps)}]" if seed_fps else ", calib_seed (none — ok)"
        print(f"selftest OK: level_curve ({levels} levels), skill_attr_map ({skills} skills){seed_msg}")
        return
    output_dir = args.output
    try:
        os.makedirs(output_dir, exist_ok=True)
    except Exception:
        pass
    # Single instance: only ONE reader can run. Two processes attach to the same game and
    # duplicate the raw/<id>.json records (duplicate run + 2× gold from the save fallback under
    # contention). The mutex is released by the OS at process exit — no stale-lock. See single_instance.py.
    if not acquire_single_instance():
        print("[exit] another tbh-reader is already running — not starting a second one.")
        return
    # mirror stdout/stderr to <output>/meter.log (for Claude to monitor from outside, e.g. the share)
    tee_stdio(os.path.join(output_dir, "meter.log"))
    # SEPARATE infra log (reader-diag.log): resolution internals + instance selection — the
    # data that was missing in debugs like the 1.00.13 party-off (see shared/utils.diag).
    init_diag_log(os.path.join(output_dir, "reader-diag.log"))
    try:
        run(args.hz, output_dir, args.debug)
    except Exception as e:
        traceback.print_exc()
        diag(f"[fatal] run() raised: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
