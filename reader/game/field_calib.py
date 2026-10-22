"""Auto-calibration of the FRAGILE field offsets (game/field_calib.py).

WHY: il2cpp class RESOLUTION is already name-based + scan-based, so it survives a game update on its
own. But four FIELD offsets are read at hardcoded positions and shift on almost every recompile,
because the fields are OBFUSCATED (random names per build) so they can't be found by name in the
metadata — the documented blind spot. Historically each update required a human to live-probe them
and hand-patch config/offsets.py (1.00.14, 1.00.27, 1.2.8, 1.3.0...).

This module DISCOVERS those four offsets at attach time by SEMANTIC SIGNATURE — what the field
CONTAINS, not where it sits — then applies them in-memory over the static offsets, which remain the
fallback. It piggybacks on structures the resolver already produced (msm, sm_list, hero_cat,
stage_info), so it adds no scan. If a signature can't be found live (e.g. not in combat), the static
offset is kept and nothing is overwritten — so this NEVER makes a working build worse.

The four signatures:
  Monster.STAGE_KEY          — the int32 on a live monster whose value is a key in stage_info.
  UnitHealthController.HP_MAX— the float in the HealthController that is >= HP_CURRENT(0x40) and > 0.
  StageManager.HERO_LIST +   — the Il2CppArray of 1..12 ptrs on a StageManager whose elements, at some
  Unit.CACHE                   cache offset, resolve INFO->HeroKey in hero_cat (discovered together).

Results are cached per-fingerprint IN MEMORY for the session (CALIBRATED dict). Discovery is
read-only; it writes nothing to the game and nothing to disk.
"""
from config.offsets import (Array, List, Unit, Monster, UnitHealthController,
                            StageManager, MonsterSpawnManager, HeroRuntime, HeroInfoData)

# Scan windows (bytes), generous enough to absorb several future recompiles around each current value.
_STAGE_KEY_WIN = range(0x3C0, 0x460, 0x4)     # around Monster.STAGE_KEY (1.3.0: 0x410)
_HP_MAX_WIN = range(0x40, 0x60, 0x4)          # around UnitHealthController.HP_MAX (1.3.0: 0x50), >= HP_CURRENT
_HERO_LIST_WIN = range(0x10, 0xA8, 0x8)       # around StageManager.HERO_LIST (1.3.0: 0x68)
_CACHE_WIN = range(0x380, 0x430, 0x8)         # around Unit.CACHE (1.3.0: 0x3D8)


def _ri32(reader, a):
    try: return reader.ri32(a)
    except Exception: return None


def _rptr(reader, a):
    try: return reader.rptr(a)
    except Exception: return None


def _first_live_monster(reader, msm):
    if not msm:
        return None
    ml = _rptr(reader, msm + MonsterSpawnManager.MONSTER_LIST)
    mons = reader.list_ptrs(ml, cap=600) if ml else []
    return mons[0] if mons else None


def discover_stage_key(reader, msm, stage_info):
    """The int32 on a live monster whose value is a key in the stage catalog. Confirm the SAME offset
    on a few monsters (so a coincidental catalog-valued field in one mob doesn't win)."""
    if not msm or not stage_info:
        return None
    ml = _rptr(reader, msm + MonsterSpawnManager.MONSTER_LIST)
    mons = reader.list_ptrs(ml, cap=600) if ml else []
    if not mons:
        return None
    keys = set(stage_info.keys())
    # tally catalog-hit offset across up to 8 monsters; require the winner on >= half of them
    tally = {}
    sampled = 0
    for u in mons[:8]:
        sampled += 1
        for off in _STAGE_KEY_WIN:
            v = _ri32(reader, u + off)
            if v is not None and v in keys:
                tally[off] = tally.get(off, 0) + 1
    if not tally:
        return None
    off, hits = max(tally.items(), key=lambda kv: kv[1])
    return off if hits >= max(1, sampled // 2) else None


def discover_hp_max(reader, msm):
    """The float in the HealthController that is >0 and >= HP_CURRENT(0x40). Confirm across monsters."""
    if not msm:
        return None
    ml = _rptr(reader, msm + MonsterSpawnManager.MONSTER_LIST)
    mons = reader.list_ptrs(ml, cap=600) if ml else []
    if not mons:
        return None
    tally = {}
    sampled = 0
    import struct
    for u in mons[:8]:
        hc = _rptr(reader, u + Unit.HEALTH_CONTROLLER)
        if not hc:
            continue
        cur = reader.read_struct(hc + UnitHealthController.HP_CURRENT, "<f")
        cur = cur[0] if cur else None
        if cur is None or not (cur > 0):
            continue
        sampled += 1
        for off in _HP_MAX_WIN:
            if off == UnitHealthController.HP_CURRENT:
                continue
            v = reader.read_struct(hc + off, "<f")
            v = v[0] if v else None
            if v is not None and v > 0 and v == v and cur <= v * 1.01 and v < 1e9:
                tally[off] = tally.get(off, 0) + 1
    if not tally or sampled == 0:
        return None
    # prefer the SMALLEST qualifying offset consistent across most monsters (max is the field closest
    # after current); require it on >= half the sampled monsters.
    good = {o: c for o, c in tally.items() if c >= max(1, sampled // 2)}
    return min(good) if good else None


def discover_hero_list_and_cache(reader, sm_list, hero_cat):
    """Discover StageManager.HERO_LIST and Unit.CACHE TOGETHER: an array of 1..12 ptrs whose elements,
    at some cache offset, resolve HeroRuntime.INFO -> HeroInfoData.HERO_KEY in hero_cat. Returns
    (hero_list_off, cache_off) or (None, None)."""
    if not sm_list or not hero_cat:
        return None, None
    hero_keys = set(hero_cat.keys())
    best = None  # (matched, n, hero_list_off, cache_off)
    for sm in sm_list:
        for hl_off in _HERO_LIST_WIN:
            hl = _rptr(reader, sm + hl_off)
            if not hl or hl < 0x10000:
                continue
            n = _ri32(reader, hl + Array.MAX_LENGTH)
            if n is None or not (0 < n <= 12):
                continue
            els = [p for p in reader.read_array_ptrs(hl, n) if p and p > 0x10000]
            if not els:
                continue
            for cache_off in _CACHE_WIN:
                matched = 0
                seen = set()
                for e in els:
                    uf = _rptr(reader, e + cache_off)
                    if not uf or uf < 0x10000:
                        continue
                    info = _rptr(reader, uf + HeroRuntime.INFO)
                    if not info or info < 0x10000:
                        continue
                    hk = _ri32(reader, info + HeroInfoData.HERO_KEY)
                    if hk in hero_keys:
                        matched += 1
                        seen.add(hk)
                # require ALL elements matched AND at least 2 DISTINCT hero keys (defeats the
                # "same key repeated" false positive, e.g. [2,2,2]).
                if matched == len(els) and len(seen) >= min(2, len(els)):
                    cand = (matched, len(els), hl_off, cache_off)
                    if best is None or cand[0] > best[0]:
                        best = cand
    if best:
        return best[2], best[3]
    return None, None


def calibrate(reader, msm, sm_list, stage_info, hero_cat, log=lambda *a: None):
    """Run all discoveries and APPLY the found offsets in-memory over the static offset classes.
    Only overwrites a field when its signature was found; otherwise the static fallback stays.
    Returns a dict of {field_name: (old, new, 'found'|'fallback')} for logging/diagnostics."""
    report = {}

    sk = discover_stage_key(reader, msm, stage_info)
    report["Monster.STAGE_KEY"] = (Monster.STAGE_KEY, sk, "found" if sk else "fallback")
    if sk:
        Monster.STAGE_KEY = sk

    hpm = discover_hp_max(reader, msm)
    report["UnitHealthController.HP_MAX"] = (UnitHealthController.HP_MAX, hpm, "found" if hpm else "fallback")
    if hpm:
        UnitHealthController.HP_MAX = hpm

    hl, cache = discover_hero_list_and_cache(reader, sm_list, hero_cat)
    report["StageManager.HERO_LIST"] = (StageManager.HERO_LIST, hl, "found" if hl else "fallback")
    report["Unit.CACHE"] = (Unit.CACHE, cache, "found" if cache else "fallback")
    if hl:
        StageManager.HERO_LIST = hl
    if cache:
        Unit.CACHE = cache

    for name, (old, new, status) in report.items():
        if status == "found" and new != old:
            log(f"[field-calib] {name}: 0x{old:X} -> 0x{new:X} (auto-discovered)")
        elif status == "fallback":
            log(f"[field-calib] {name}: kept static 0x{old:X} (signature not found live)")
    return report
