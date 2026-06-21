"""Canonical TBH EXP model (Python) — keep-fraction penalty + per-clear EXP + level curve.

Pure functions, no game/memory deps. Mirrors app/src/shared/exp-model.ts and the wiki's
stage-math.ts. Used by gen_stage_exp.py and the live in-game probe (tbh-meter-dev/exp_penalty_probe.py).
Model + evidence: docs/exp-leveling-model.md. Run `python exp_model.py` for the self-test.
"""
import json
import math
import os


# Over-level keep — MEASURED in-game (experiment E2, game 1.00.17, heroes lv90-93) as a (gap, keep)
# table; gap = heroLevel - stageLevel. Piecewise-linear between anchors -> any gap, and reproduces the
# real data EXACTLY (validated to +/-0.0% on the Knight gap-0 and Sorc gap-2 runs). A clean closed-form
# 1/(1+(gap/8.1)^2.75) approximates it within ~2pp for gap>=3 but runs ~3.5pp optimistic at +1/+2
# (predicts keep(+2)=0.979 vs measured 0.944), so we use the table for fidelity. See docs/exp-experiments.md.
_OVERLEVEL_KEEP = [(0, 1.0), (2, 0.944), (3, 0.934), (4, 0.854), (5, 0.809), (6, 0.705), (7, 0.628),
                   (8, 0.506), (9, 0.400), (11, 0.293), (12, 0.259), (14, 0.192), (15, 0.169),
                   (16, 0.150), (18, 0.112), (19, 0.099), (20, 0.089), (22, 0.068), (24, 0.052),
                   (25, 0.047), (27, 0.036)]


def keep(hero_level: int, stage_level: int) -> float:
    """Fraction of EXP a hero keeps on a stage (hidden over/under-level penalty).
    gap = heroLevel - stageLevel.
    - gap > 0 (over-level): MEASURED curve (E2), piecewise-linear over _OVERLEVEL_KEEP (any gap).
    - gap <= 0 (under-level): NOT measurable with our roster — taskbarherowiki formula, UNVALIDATED."""
    gap = hero_level - stage_level
    if gap > 0:
        if gap >= _OVERLEVEL_KEEP[-1][0]:
            return _OVERLEVEL_KEEP[-1][1]
        for i in range(1, len(_OVERLEVEL_KEEP)):
            g1, k1 = _OVERLEVEL_KEEP[i]
            if gap <= g1:
                g0, k0 = _OVERLEVEL_KEEP[i - 1]
                return k0 + (gap - g0) / (g1 - g0) * (k1 - k0)
        return _OVERLEVEL_KEEP[-1][1]
    e = hero_level
    c = -gap
    a = 0.4
    s = math.log(e + 1) / 10 + 1
    n = math.trunc(s * 5)
    r = math.trunc(s * 6)
    if c <= n:
        return 1.0
    if c <= n + r:
        u = (c - n) / r
        return max(1.0 - (1.0 - a) * u * u, 0.01)
    return max((0.01 / a) ** ((c - n - r) / max(e / 3.0, 1.0)) * a, 0.01)


def load_curve(path: str) -> dict:
    """{level: ExpForLevelUp} from reader/config/level_curve.json (== game LevelInfoData)."""
    with open(path, encoding="utf-8") as f:
        return {int(k): int(v) for k, v in json.load(f).items()}


def _permille(v) -> float:
    return (1000.0 if v is None else float(v)) / 1000.0


def stage_clear_exp(stage: dict, monsters_by_key: dict) -> float:
    """Base EXP for one full clear of a stage (game base x stage-level scaling), BEFORE the
    over/under-level penalty and any bonus. Port of stage-math.ts:stageClearRewards."""
    exp_mult = _permille((stage.get("levelScaling") or {}).get("exp"))
    mons = stage.get("monsters") or []
    tw = sum((m.get("weight") or 0) for m in mons)
    avg = 0.0
    if tw > 0:
        for m in mons:
            mon = monsters_by_key.get(int(m["monster"]))
            if not mon:
                continue
            avg += (mon.get("rewardExp", 0) * exp_mult) * ((m.get("weight") or 0) / tw)
    kills = (stage.get("waveAmount") or 0) * (stage.get("waveMonsterAmount") or 1)
    total = avg * kills
    bk = stage.get("bossMonsterKey")
    if bk is not None:
        boss = monsters_by_key.get(int(bk))
        if boss:
            total += boss.get("rewardExp", 0) * exp_mult * _permille((stage.get("bossMultipliers") or {}).get("exp"))
    return total


def by_key(lst: list, kfield: str = "key") -> dict:
    return {int(x[kfield]): x for x in lst}


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    data = os.path.join(here, "..", "..", "data", "json")
    stages = json.load(open(os.path.join(data, "stages.json"), encoding="utf-8"))
    monsters = json.load(open(os.path.join(data, "monsters.json"), encoding="utf-8"))
    mbk = by_key(monsters)
    sbn = {s["name"] + "|" + s.get("difficulty", "NORMAL"): s for s in stages}

    print("KEEP — MEASURED over-level curve reproduces its anchors exactly:")
    meas = {2: 0.944, 4: 0.854, 6: 0.705, 8: 0.506, 9: 0.400, 12: 0.259, 14: 0.192, 18: 0.112, 22: 0.068}
    for g, m in meas.items():
        k = keep(91, 91 - g)
        print(f"   gap+{g:<2} keep {k * 100:5.1f}%")
        assert abs(k - m) < 1e-9, (g, k, m)
    assert keep(91, 91) == 1.0 and keep(91, 92) == 1.0, "gap<=0 must be 100%"
    # REAL-DATA validation: Sorc run3 (gap +2, +8.7% accessory) vs the same-run Knight (gap 0) = 17,057,822
    sorc = 17_057_822 * keep(93, 91) * 1.087
    print(f"   Sorc run3 fit: 17,057,822 x keep(+2) x 1.087 = {sorc:,.0f}  vs real 17,497,600 "
          f"({(sorc/17_497_600 - 1) * 100:+.2f}%)")
    assert abs(sorc / 17_497_600 - 1) < 0.005, sorc

    print("stage_clear_exp vs wiki reference (within 3%):")
    for nm, ref in [("Pasture", 16), ("Cursed Land", 6000), ("Sacred Tomb", 31000)]:
        v = stage_clear_exp(sbn[nm + "|NORMAL"], mbk)
        ok = abs(v - ref) <= max(1, ref * 0.03)
        print(f"    {nm:14} got {v:9.1f}  ref {ref}  {'OK' if ok else 'MISMATCH'}")
        assert ok, (nm, v, ref)
    print("self-test OK")
