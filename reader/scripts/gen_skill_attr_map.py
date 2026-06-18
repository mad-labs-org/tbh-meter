#!/usr/bin/env python3
"""gen_skill_attr_map.py — generates config/skill_attr_map.json + config/passive_skill_keys.json
from the datamine.

The save stores a skill's level in the attribute TREE (AttributeSaveData{Key,Level}), indexed by
the node's `attributeKey`. There are TWO bridges (active vs passive):

  • ACTIVE: the EQUIPPED skill (HeroSaveData.equippedSKillKey) is a `skillKey` that is NOT the
    attributeKey. skill_attr_map.json = {skillKey(refKey): attributeKey} of the ACTIVESKILL nodes
    (each has refKey == skillKey and its own attributeKey). The reader goes equipped->level via map.

  • PASSIVE: not equipped (don't appear in equippedSKillKey); they exist only in the tree. For a
    PASSIVESKILL node, refKey == attributeKey (confirmed: 0/96 differ) → the attr key itself IS the
    skill's identity. passive_skill_keys.json = GLOBAL list of the PASSIVESKILL attributeKeys; the
    reader includes the ones the hero invested in (intersection with attr_levels).

Source: web/src/data/heroes.json (datamine; same source the app syncs from). Re-run when the game
data changes:  python reader/scripts/gen_skill_attr_map.py

Guarantees checked here (fails if broken): (1) each active refKey maps to EXACTLY one attributeKey
(unambiguous global map); (2) no passive attributeKey collides with an active skill's attributeKey
(otherwise the intersection would count the active one as passive too)."""

import json
import os
import sys


def repo_root(start):
    """Walk up the tree until web/src/data/heroes.json is found. None if not found."""
    d = os.path.abspath(start)
    while True:
        if os.path.isfile(os.path.join(d, "web", "src", "data", "heroes.json")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def build_active_map(heroes):
    """{skillKey(refKey): attributeKey} of the ACTIVESKILL nodes. Raises on ambiguity."""
    out = {}
    for h in heroes:
        for n in h.get("skillTree", []):
            if n.get("type") != "ACTIVESKILL":
                continue
            rk, ak = n.get("refKey"), n.get("attributeKey")
            if rk is None or ak is None:
                continue
            if rk in out and out[rk] != ak:
                raise SystemExit(
                    f"ambiguous: skillKey {rk} maps to both {out[rk]} and {ak} "
                    f"(hero {h.get('key')}). Global map unsafe — needs per-hero keying."
                )
            out[rk] = ak
    return out


def passive_keys(heroes):
    """GLOBAL set of the attributeKeys (== refKey for passives) of ALL PASSIVESKILL nodes."""
    out = set()
    for h in heroes:
        for n in h.get("skillTree", []):
            if n.get("type") == "PASSIVESKILL" and n.get("attributeKey") is not None:
                out.add(n["attributeKey"])
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = repo_root(here)
    if not root:
        raise SystemExit("could not locate web/src/data/heroes.json from " + here)
    with open(os.path.join(root, "web", "src", "data", "heroes.json"), encoding="utf-8") as f:
        heroes = json.load(f)

    active = build_active_map(heroes)
    passive = passive_keys(heroes)
    # Passives enter the reader by intersection (attr_levels ∩ passive). If a passive attributeKey
    # equals an ACTIVE skill's attributeKey, the active one would show up 2× (as a passive too).
    # Confirmed today: 0 collisions — but fails loud if some game build introduces one.
    clash = set(active.values()) & passive
    if clash:
        raise SystemExit(f"active/passive attributeKey clash: {sorted(clash)[:10]} — "
                         "intersection would double-count. Needs disambiguation.")

    cfg = os.path.join(os.path.dirname(here), "config")
    with open(os.path.join(cfg, "skill_attr_map.json"), "w", encoding="utf-8") as f:
        json.dump({str(k): active[k] for k in sorted(active)}, f,
                  ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    with open(os.path.join(cfg, "passive_skill_keys.json"), "w", encoding="utf-8") as f:
        json.dump(sorted(passive), f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"wrote skill_attr_map.json ({len(active)} active skills) + "
          f"passive_skill_keys.json ({len(passive)} passive skills)", file=sys.stderr)


if __name__ == "__main__":
    main()
