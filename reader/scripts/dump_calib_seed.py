#!/usr/bin/env python3
"""dump_calib_seed.py — capture the build-stable calibration SEED to bundle into the reader.

seed-calib strategy: the FIRST launch on a SHIPPED build skips the ~70s scan IF the reader already
ships with the `calib[fp]` for that build. This script extracts that block from the resolve_cache.json
that the reader LEARNED (after 1 combat run on the build being shipped) and writes it to
reader/config/calib_seed.json — ready to commit. This is the RELEASE step (on the maintainer's
machine), done ONCE per game build.

Does NOT touch game memory, does NOT calibrate — only reads/filters/writes JSON. Mirrors save_calib's
persist-gate (non-empty catalogs) to NEVER seed a degraded calib. Atomic write.

The seed is zero-regression by construction: the fast path (_resolve_fast) revalidates every live
calib[fp] on each launch and degrades to the scan on any mismatch; a seed from another build is just
a MISS per fp.

USAGE:
    # extract from the default cache (~/tbh-meter/resolve_cache.json); if there's 1 fp, use it
    python scripts/dump_calib_seed.py
    # the RC's cache, or a specific fp, or a custom output:
    python scripts/dump_calib_seed.py --cache ~/tbh-meter-rc/resolve_cache.json --fp 1.00.09-0x6a203f51-0x62ea000
    # keep fps already in the seed (multi-build) instead of replacing:
    python scripts/dump_calib_seed.py --keep
"""
import argparse
import json
import os
import sys


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    reader_root = os.path.dirname(here)            # scripts/ -> reader/
    default_cache = os.path.join(os.path.expanduser("~"), "tbh-meter", "resolve_cache.json")
    default_out = os.path.join(reader_root, "config", "calib_seed.json")

    ap = argparse.ArgumentParser(
        description="capture calib[fp] from resolve_cache.json -> config/calib_seed.json (seed-calib)")
    ap.add_argument("--cache", default=default_cache,
                    help=f"source resolve_cache.json (default: {default_cache})")
    ap.add_argument("--fp", default=None,
                    help="fingerprint to extract (default: the only one in the cache; errors if there are several)")
    ap.add_argument("--out", default=default_out, help=f"output file (default: {default_out})")
    ap.add_argument("--keep", action="store_true",
                    help="MERGE: keep the fps already present in the output seed (default: replace)")
    args = ap.parse_args()

    try:
        doc = json.load(open(args.cache, encoding="utf-8"))
    except Exception as e:
        print(f"[x] could not read the cache {args.cache}: {e}")
        return 1
    fmt = doc.get("fmt")
    calib = doc.get("calib") or {}
    if not calib:
        print(f"[x] cache has no calib block (fmt={fmt}). Run the reader 1x IN COMBAT on this build first.")
        return 1

    fps = list(calib.keys())
    if args.fp:
        if args.fp not in calib:
            print(f"[x] fp {args.fp} is not in the cache. available: {fps}")
            return 1
        chosen = [args.fp]
    elif len(fps) == 1:
        chosen = fps
    else:
        print(f"[x] the cache has several fps — pick one with --fp. available: {fps}")
        return 1

    # persist-gate (mirrors save_calib in meter_windows.py): only seed calib with non-empty catalogs.
    for fp in chosen:
        e = calib[fp]
        if not (e.get("stage_info") and e.get("item_cat") and e.get("hero_cat")):
            print(f"[x] fp {fp}: empty catalogs (scan ran outside a stage?) — NOT seeding a degraded calib.")
            return 1

    out_calib = {}
    if args.keep and os.path.isfile(args.out):
        try:
            prev = json.load(open(args.out, encoding="utf-8"))
            if prev.get("fmt") == fmt:
                out_calib.update(prev.get("calib") or {})
        except Exception:
            pass
    for fp in chosen:
        out_calib[fp] = calib[fp]

    out_doc = {"fmt": fmt, "calib": out_calib}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out_doc, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, args.out)

    print(f"[ok] seed written: {args.out}")
    print(f"     fmt={fmt}  fps={list(out_calib.keys())}")
    for fp in chosen:
        e = calib[fp]
        print(f"     {fp}: anchor_rva={hex(e['anchor_rva'])} idx_ut={e['idx_ut']} "
              f"indices={len(e.get('indices', {}))} stages={len(e.get('stage_info', {}))} "
              f"items={len(e.get('item_cat', {}))} heroes={len(e.get('hero_cat', {}))}")
    print("     -> commit config/calib_seed.json and cut a new release.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
