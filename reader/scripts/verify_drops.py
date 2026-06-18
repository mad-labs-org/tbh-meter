#!/usr/bin/env python3
"""Validate that the chest box_key values the reader writes to runs.jsonl resolve to
the app's 3 chest sprites.

The app maps box_key -> sprite via items.json (STAGEBOX iconPath), keyed by the ITEM
key, collapsing every tier variant onto one icon:
  910xxx -> Item_910011  (common monster box,  EMonsterLogType.Monster=0)
  920xxx -> Item_920011  (stage boss box,      EMonsterLogType.Boss=1)
  930xxx -> Item_930011  (act boss box,         EMonsterLogType.ActBoss=2)

This confirms LIVE box_key values actually match that assumption (vs. the 7-digit
dropKey, an encrypted value, etc.) so the Drops column won't silently fall back to the
generic glyph.

Usage:  python verify_drops.py [path-to-runs.jsonl]
"""
import json
import os
import sys
from collections import Counter

DEFAULT_PATHS = [
    "runs.jsonl",  # cwd (e.g. run from tbh-meter-dev with --output .)
    os.path.expanduser("~/tbh-meter/runs.jsonl"),
    os.path.expanduser("~/tbh-meter-rc/runs.jsonl"),
]

# box_key prefix -> (expected sprite basename, EMonsterLogType, human label)
TIERS = {
    "91": ("Item_910011", 0, "common monster box"),
    "92": ("Item_920011", 1, "stage boss box"),
    "93": ("Item_930011", 2, "act boss box"),
}


def tier(box_key):
    return TIERS.get(str(box_key)[:2])


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else next(
        (p for p in DEFAULT_PATHS if os.path.exists(p)), None
    )
    if not path or not os.path.exists(path):
        print("runs.jsonl not found. Pass the path explicitly:")
        print("  python verify_drops.py C:\\Users\\mario\\tbh-meter\\runs.jsonl")
        print(f"  (tried: {DEFAULT_PATHS})")
        return

    print(f"reading {path}\n")
    total = with_drops = total_chests = 0
    by_key = Counter()              # box_key -> count
    mt_by_key = {}                  # box_key -> set(monster_type)
    unmapped = Counter()            # box_key with no tier match
    mismatch = []                   # (box_key, monster_type, expected) prefix vs monster_type

    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            total += 1
            drops = rec.get("drops") or []
            if drops:
                with_drops += 1
            for d in drops:
                if not isinstance(d, dict):
                    continue
                bk, mt = d.get("box_key"), d.get("monster_type")
                if bk is None:
                    continue
                total_chests += 1
                by_key[bk] += 1
                mt_by_key.setdefault(bk, set()).add(mt)
                t = tier(bk)
                if t is None:
                    unmapped[bk] += 1
                elif mt is not None and mt != t[1]:
                    mismatch.append((bk, mt, t[1]))

    print(f"records: {total} | with drops: {with_drops} | total chests: {total_chests}\n")
    if not total_chests:
        print("No drops captured yet — play a full run on the post-#172 reader so")
        print("GetBoxLog fires, then re-run this.")
        return

    print("distinct box_key -> sprite the app will render:")
    for bk, n in sorted(by_key.items()):
        t = tier(bk)
        mts = sorted(m for m in mt_by_key[bk] if m is not None)
        if t:
            print(f"  {bk:<8} x{n:<5} -> {t[0]}.png   ({t[2]}, monster_type={mts})")
        else:
            print(f"  {bk:<8} x{n:<5} -> UNMAPPED (fallback glyph!)  monster_type={mts}")

    print()
    if unmapped:
        print(f"FAIL: {sum(unmapped.values())} chest(s) have a box_key with no sprite "
              f"mapping: {dict(unmapped)}")
        print("      -> these render the generic Package glyph. Tell Claude these keys.")
    else:
        print("PASS: every captured box_key resolves to one of the 3 chest sprites.")
    if mismatch:
        print(f"NOTE: {len(mismatch)} drop(s) where box_key tier != monster_type "
              f"(e.g. {mismatch[0]}). Resolving by box_key (the app's choice) stays correct.")


if __name__ == "__main__":
    main()
