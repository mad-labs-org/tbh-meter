#!/usr/bin/env python3
"""seed_calib_capture.py — ONE-SHOT, ZERO-ARG: scans the LIVE game and writes a FRESH calib_seed.json
at the CURRENT CACHE_FMT. Run ONCE on the build you're about to ship, with the game OPEN and IN COMBAT
(any normal stage — you do NOT need an act-boss).

WHY: the seed's fmt is COPIED from the resolve_cache it was extracted from. A seed extracted on an OLD
reader build goes fmt-stale after a CACHE_FMT bump -> ignored at runtime (_read_calib rejects
fmt!=CACHE_FMT -> falls into the cold scan anyway) AND fails the CI --selftest. This script captures the
calib straight from THIS live process, at the current CACHE_FMT, so the seed never falls behind the
build again. Fuses "run the reader 1x + scripts/dump_calib_seed.py" into a single zero-arg step.

ACT-BOSS (x-10): StageInfoData is the COMPLETE STATIC stage catalog (all acts/stages/difficulties),
loaded independently of your progress. fmt 9 stopped FILTERING the x-10 rows (ACTBOSS), so a scan on
ANY normal stage already captures them. You do NOT need to reach/beat a boss. The script PRINTS how many
ACTBOSS it captured so you can confirm.

Reuses the reader's TESTED resolution (_resolve_scan -> _calibrate -> save_calib); zero RVA logic here.
Atomic write; promotes to the seed only after validating with the SAME checks as --selftest.
"""
import json
import os
import sys
import time

# --- bootstrap: put the reader root on sys.path. Works from the ROOT of the tbh-meter-dev share (which
# has reader/ as a subfolder), from inside reader/, or from reader/scripts/ — finds whoever has meter_windows.py.
_here = os.path.dirname(os.path.abspath(__file__))
_reader_root = next(
    (c for c in (os.path.join(_here, "reader"), _here, os.path.dirname(_here),
                 os.path.dirname(os.path.dirname(_here)))
     if os.path.isfile(os.path.join(c, "meter_windows.py"))),
    None,
)
if _reader_root is None:
    sys.exit("[x] meter_windows.py not found. Run from the root of the tbh-meter-dev share (has reader/) "
             "or from inside reader/.")
sys.path.insert(0, _reader_root)

import meter_windows as mw                                   # noqa: E402
from shared.memory import Reader, find_pid, open_process     # noqa: E402
from il2cpp import typeinfo                                  # noqa: E402


def main():
    pid = find_pid()
    if not pid:
        print("[x] game is not open. Open the game, ENTER A STAGE (combat) and run again.")
        return 1
    handle = open_process(pid)
    if not handle:
        print("[x] OpenProcess failed — open the terminal as ADMINISTRATOR and run again.")
        return 1
    reader = Reader(handle)
    print(f"[ok] attached (pid {pid}).")

    # Same fingerprint sequence as run(): installed version (handle) + module ga_base.
    gv = mw._detect_game_version(handle)
    game_version = gv or mw.GAME_VERSION
    ga_base0, _ = typeinfo.ga_module(pid)
    fp = typeinfo.build_fingerprint(reader, ga_base0, gv) if ga_base0 else None
    if not fp:
        print("[x] couldn't read GameAssembly.dll for the build fingerprint — can't seed.")
        return 1
    print(f"[ok] build {game_version} | fp {fp} | CACHE_FMT {mw.CACHE_FMT}")

    # FORCE the slow path (full scan) -> catalogs at the CURRENT fmt, without reusing an old calib/seed.
    print("[..] FULL scan (~1-3min) — forced, to capture catalogs at the current fmt...")
    t0 = time.time()
    tup, classes = mw._resolve_scan(reader)
    (sc, sf, msm, lm, _csd, _psd, stage_info, item_cat, hero_cat,
     _sm, gold_klass, _gb, _die, _res) = tup
    print(f"[ok] scan in {time.time() - t0:.0f}s.")

    # Resolution GATE (mirrors run()): essential managers/logs resolved.
    if not (msm and lm and sc and sf):
        print("[x] incomplete resolution (managers/logs missing). ENTER A STAGE and run again.")
        return 1
    # Catalog GATE (mirrors save_calib's persist-gate): empty = scan ran outside a stage.
    if not (stage_info and item_cat and hero_cat):
        print(f"[x] empty catalogs (stages={len(stage_info)} items={len(item_cat)} "
              f"heroes={len(hero_cat)}). ENTER A STAGE (combat) — won't seed degraded.")
        return 1

    actboss = sum(1 for v in stage_info.values() if v[2] == 0)   # mobs==0 <=> ACTBOSS (x-10)
    print(f"[ok] catalogs: stages={len(stage_info)} (ACTBOSS x-10={actboss}) "
          f"items={len(item_cat)} heroes={len(hero_cat)}")
    if actboss == 0:
        print("[!] WARNING: 0 ACTBOSS stages captured. The seed STILL works (current fmt -> skips the scan),"
              " but x-10 would show '?' on the fast path. Ideally run with a combat stage loaded.")

    # CALIBRATE into a TEMP (discover_anchor + idx_ut + atomic write via save_calib). Validating the TEMP —
    # not the seed that already exists — avoids a false-OK if calibration fails and the old seed stays put.
    seed_path = mw._seed_path()
    tmp_cache = os.path.join(os.path.dirname(seed_path), ".calib_seed_capture.tmp.json")
    try:
        os.remove(tmp_cache)
    except OSError:
        pass
    mw._calibrate(reader, pid, fp, tmp_cache, classes, stage_info, item_cat, hero_cat, gold_klass)

    if not os.path.isfile(tmp_cache):
        print("[x] calibration wrote nothing — discover_anchor/idx_ut failed (see [calib] FAILED above).")
        return 1
    try:
        doc = json.load(open(tmp_cache, encoding="utf-8"))
    finally:
        try:
            os.remove(tmp_cache)
        except OSError:
            pass
    # SAME checks as --selftest (meter_windows --selftest): fmt matches + non-empty calib block for fp.
    if doc.get("fmt") != mw.CACHE_FMT or not (doc.get("calib") or {}).get(fp):
        print(f"[x] invalid calib (fmt={doc.get('fmt')}, fp present="
              f"{bool((doc.get('calib') or {}).get(fp))}). Likely a degraded catalog — run in combat.")
        return 1

    # PROMOTE to the real seed: 1 fp (the current build), indent=2 like the committed file. Atomic.
    entry = doc["calib"][fp]
    seed_doc = {"fmt": mw.CACHE_FMT, "calib": {fp: entry}}
    os.makedirs(os.path.dirname(seed_path), exist_ok=True)
    tmp_out = seed_path + ".tmp"
    with open(tmp_out, "w", encoding="utf-8") as f:
        json.dump(seed_doc, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_out, seed_path)

    print("")
    print(f"[OK] SEED written: {seed_path}")
    print(f"     fmt={seed_doc['fmt']}  fp={fp}")
    print(f"     anchor_rva={hex(entry['anchor_rva'])} idx_ut={entry['idx_ut']} "
          f"indices={len(entry['indices'])} stages={len(entry['stage_info'])} "
          f"(ACTBOSS={actboss}) items={len(entry['item_cat'])} heroes={len(entry['hero_cat'])}")
    print("")
    print("     -> copy it into the repo at tbh-meter/reader/config/calib_seed.json, commit and run the release.")
    print("     -> the CI --selftest passes (fmt matches, calib non-empty).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
