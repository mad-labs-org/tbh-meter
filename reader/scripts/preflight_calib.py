#!/usr/bin/env python3
"""preflight_calib.py — the ONE-COMMAND STATIC GATE before re-seeding/shipping the reader.

WHY IT EXISTS: the reader has broken THREE times shipping a wrong seed/calibration, always
SILENTLY (the reader reads garbage/empty WITHOUT erroring), always because the check was PARTIAL:
  (1) gold (1.97T / 0): the AggregateManager singleton (idx_ut) resolved via a value-scan that
      didn't converge — only a live run would catch it;
  (2) party (+0xp, roster instead of the party): the pick_live_sm cap overran the live StageManager
      and fell back to the save's roster — only a live run with the party deployed would catch it;
  (3) 1.00.12 (whole fleet stopped recording): the bucket-box inserted fields into PlayerSaveData
      and shifted ALL of the save's lists by +0x10; offsets.py pointed at the old offset → read_gold/
      read_heroes read the WRONG list → pick_live_psd None → run with heroes=[] → the app didn't
      record (eligible requires heroes>0) → empty sessions. It passed GREEN because the static
      tripwire only checked the PRESENCE of an offset (another field landed at the old offset) and
      the live gate only exercised the LIVE path (StageManager/AggregateManager), never the SAVE
      path that the run record uses.

The lesson of all three: NO single gate is enough, and validating only what you touched is the
anti-pattern. Immunity comes in LAYERS (see docs/process/live-validation-gate.md):
  1. ruff + pytest          — unit regression (pinned offsets, tripwire logic, envelopes);
  2. diff_offsets_vs_dump   — code↔GAME tripwire against a FRESH dump.cs (field offsets +
                              names + enums + the seed's TypeDefIndex/idx_ut): catches INSERTION/reorder;
  3. validate_live          — the LIVE gate (gold/party/xp/stage/dps/stats/save-build/build-record/
                              run-cycle/catalogs) covering the OBFUSCATED classes the diff can't see.

This script runs LAYERS 1 and 2 (everything runnable WITHOUT the game) in a single command and, at
the end, PRINTS the exact layer-3 command the operator MUST run live (this script CANNOT run the
game — it needs Windows with TBH open and IN COMBAT). Exit 0 = the static layers PASSED; layer 3
(validate_live) is still PENDING before bumping GAME_VERSION / shipping.

USAGE (from the worktree root, from reader/, or from reader/scripts/):
    python3 scripts/preflight_calib.py --dump ~/tbh-dump/out/dump.cs --seed config/calib_seed.json
Without --dump it uses the default Il2CppDumper output path from the meter-game-update skill
(~/tbh-dump/out/dump.cs); if the dump doesn't exist, it FAILS with the dump command (never passes
green without having diffed against the new build). --seed default = config/calib_seed.json (the
committed seed). Skip static layer 1/2 only with --skip-ruff/--skip-pytest/--skip-diff (NOT
recommended outside debugging — it removes the safety net each historical break proved necessary).

THIS IS A STATIC GATE. It can NEVER declare "ready to ship" — only "the static layers passed". The
live layer (validate_live.py) is mandatory and runs on the maintainer's machine.
"""
import argparse
import os
import shutil
import subprocess
import sys

# bootstrap identical to the other scripts: find the reader root (the one with meter_windows.py)
# from the tbh-meter-dev share root (has reader/ as a subfolder), from reader/, or from reader/scripts/.
_here = os.path.dirname(os.path.abspath(__file__))
_reader_root = next(
    (c for c in (os.path.join(_here, "reader"), _here, os.path.dirname(_here),
                 os.path.dirname(os.path.dirname(_here)))
     if os.path.isfile(os.path.join(c, "meter_windows.py"))),
    None,
)
if _reader_root is None:
    sys.exit("[x] meter_windows.py not found. Run from the tbh-meter-dev share root (has reader/) "
             "or from inside reader/.")

_DIFF = os.path.join(_here, "diff_offsets_vs_dump.py")
_VALIDATE = os.path.join(_here, "validate_live.py")
# Default Il2CppDumper output path in the meter-game-update skill (step 2: `dotnet ... out`).
_DEFAULT_DUMP = os.path.expanduser("~/tbh-dump/out/dump.cs")
_DEFAULT_SEED = os.path.join(_reader_root, "config", "calib_seed.json")


def _hdr(title):
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)


def _run(cmd, cwd):
    """Run a subprocess inheriting stdout/stderr (the tool's output shows directly). Returns the
    returncode, or 127 if the executable doesn't exist (FileNotFoundError)."""
    print(f"$ {' '.join(cmd)}  (cwd={cwd})")
    try:
        return subprocess.run(cmd, cwd=cwd).returncode
    except FileNotFoundError:
        return 127


def _ruff_cmd():
    """`ruff check .` if ruff is on PATH; otherwise `uvx ruff check .` (ruff.toml documents uvx as
    the way to run it without installing — `uv` is already in the maintainer's environment). None if
    neither exists (then the layer can't run — the operator installs ruff)."""
    if shutil.which("ruff"):
        return ["ruff", "check", "."]
    if shutil.which("uvx"):
        return ["uvx", "ruff", "check", "."]
    return None


def main():
    ap = argparse.ArgumentParser(
        description="ONE-command STATIC gate before re-seeding/shipping the reader "
                    "(ruff + pytest + diff_offsets_vs_dump). Prints the LIVE-layer command at the end.")
    ap.add_argument("--dump", default=_DEFAULT_DUMP,
                    help=f"FRESH dump.cs from Il2CppDumper of the new build (default: {_DEFAULT_DUMP})")
    ap.add_argument("--seed", default=_DEFAULT_SEED,
                    help="config/calib_seed.json to check (TypeDefIndex + idx_ut). Default: the committed one")
    ap.add_argument("--skip-ruff", action="store_true", help="skip ruff (debug — not recommended)")
    ap.add_argument("--skip-pytest", action="store_true", help="skip pytest (debug — not recommended)")
    ap.add_argument("--skip-diff", action="store_true",
                    help="skip the code↔dump diff (debug — only if you do NOT yet have dump.cs)")
    args = ap.parse_args()

    results = []  # (layer_name, ok, detail)

    # --- LAYER 1a: ruff (lint — catches dead/undefined names that refactors most risk) ------------
    _hdr("LAYER 1a — ruff check (static lint)")
    if args.skip_ruff:
        print("[skip] --skip-ruff")
        results.append(("ruff", True, "SKIPPED (--skip-ruff)"))
    else:
        rc = _ruff_cmd()
        if rc is None:
            print("[x] ruff not found on PATH and uvx unavailable. Install: brew install ruff "
                  "(or run in an environment with uv). See ruff.toml.")
            results.append(("ruff", False, "ruff/uvx missing"))
        else:
            code = _run(rc, _reader_root)
            results.append(("ruff", code == 0, f"exit {code}"))

    # --- LAYER 1b: pytest (regression: pinned offsets, tripwire logic, envelopes, etc.) -----------
    _hdr("LAYER 1b — pytest (unit regression, includes the docs↔code drift-test)")
    if args.skip_pytest:
        print("[skip] --skip-pytest")
        results.append(("pytest", True, "SKIPPED (--skip-pytest)"))
    else:
        code = _run([sys.executable, "-m", "pytest", "-q"], _reader_root)
        results.append(("pytest", code == 0, f"exit {code}"))

    # --- LAYER 2: code↔GAME diff (the tripwire that should have caught 1.00.12 BEFORE shipping) ---
    _hdr("LAYER 2 — diff_offsets_vs_dump (code↔GAME tripwire vs fresh dump.cs)")
    if args.skip_diff:
        print("[skip] --skip-diff (you do NOT yet have the new build's dump.cs? generate it — see the skill)")
        results.append(("diff_offsets", True, "SKIPPED (--skip-diff)"))
    elif not os.path.isfile(args.dump):
        # A missing dump must NOT pass green — that's exactly the 1.00.12 scenario (no diff = no knowing).
        print(f"[x] dump.cs not found at: {args.dump}")
        print("    Generate the NEW build's dump (static, doesn't need the game running):")
        print("      cd ~/tbh-dump && cp /Volumes/TaskbarHero/GameAssembly.dll . && \\")
        print("        cp /Volumes/TaskbarHero/TaskBarHero_Data/il2cpp_data/Metadata/global-metadata.dat .")
        print("      DOTNET_ROLL_FORWARD=Major dotnet tool/Il2CppDumper.dll GameAssembly.dll "
              "global-metadata.dat out < /dev/null")
        print("    Then run again with --dump ~/tbh-dump/out/dump.cs (or point --dump at yours).")
        results.append(("diff_offsets", False, f"dump missing: {args.dump}"))
    else:
        cmd = [sys.executable, _DIFF, "--dump", args.dump]
        if args.seed and os.path.isfile(args.seed):
            cmd += ["--seed", args.seed]
        else:
            print(f"[!] seed not found at {args.seed} — diffing offsets/enums without checking the "
                  f"seed's TypeDefIndex/idx_ut (passing --seed config/calib_seed.json is recommended).")
        code = _run(cmd, _reader_root)
        # diff: exit 0 = no drift; 1 = DRIFT (offsets.py/seed need updating); 2 = unreadable dump.
        results.append(("diff_offsets", code == 0,
                        "no drift" if code == 0 else f"DRIFT/error (exit {code})"))

    # --- SUMMARY of the static layers -------------------------------------------------------------
    _hdr("SUMMARY — STATIC layers (1 + 2)")
    for name, ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:14s} — {detail}")
    all_static_pass = all(ok for _, ok, _ in results)

    if not all_static_pass:
        fails = [n for n, ok, _ in results if not ok]
        print(f"\n[x] ❌ static layer FAILED on: {', '.join(fails)}.")
        print("    Do NOT re-seed / do NOT bump GAME_VERSION / do NOT ship. Fix it and run again.")
        print("    (DRIFT in the diff = update the symbol in config/offsets.py from the dump — single")
        print("     source; see docs/invariants/offsets-single-source.md and the meter-game-update skill.)")
        return 1

    # --- static layer OK → PRINT the LIVE-layer command (which this script does NOT run) ----------
    _hdr("✅ STATIC LAYERS PASSED — the LIVE layer is still PENDING (mandatory)")
    print("Layers 1+2 (ruff + pytest + code↔game diff) passed: nothing the reader tracks shifted")
    print("in NAME/OFFSET/ENUM/index in this dump. But the OBFUSCATED classes (gold via")
    print("AggregateManager, party+xp via HeroRuntime, StatsHolder) and the SAVE/record paths the")
    print("run RECORDS through (save-build/build-record/dps/stats/run-cycle) only validate LIVE — it's")
    print("the blind spot where BOTH 1.00.11 bugs and the 1.00.12 fleet stoppage slipped through.")
    print("")
    print("THIS GATE IS STATIC AND CANNOT RUN THE GAME. Before bumping GAME_VERSION / shipping, run")
    print("LAYER 3 on the maintainer's machine, with TBH OPEN and IN COMBAT on a stage:")
    print("")
    print("    # Windows, terminal as ADMINISTRATOR, party deployed on a stage:")
    print("    cd C:\\Users\\mario\\tbh-meter-dev")
    print("    python reader\\scripts\\validate_live.py")
    print("")
    print(f"  (live-gate code: {os.path.relpath(_VALIDATE, _reader_root)} — resolves via the embedded")
    print("   SEED, just like the RC's 1st launch, and requires PASS on ALL: calib/seed, gold,")
    print("   live-party, hero-class, save-build, build-record, live-xp, dps, stats, stage,")
    print("   run-cycle, catalogs. Exit != 0 = do NOT ship. Reads back validate_live_out.txt.)")
    print("")
    print("⚠  NEVER ship on this preflight green alone. Validating partially is EXACTLY how all three")
    print("   breaks slipped through. Only AFTER validate_live PASSes on everything: bump GAME_VERSION")
    print("   and ship. Full playbook: docs/guides/game-update.md + the meter-game-update skill.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
