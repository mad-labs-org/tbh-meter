"""save.py — PlayerSaveData readers (plaintext, snapshot) + picking the LIVE instance.

Free functions taking (reader, ...). Faithfully ported from the monolith. The save is STALE
(a snapshot) — good for sheet/identity and as a fallback; live gold/xp live in metrics/."""

from config.offsets import (PlayerSaveData, CurrencySaveData, HeroSaveData,
                            CommonSaveData, GOLD_KEY)
from game.build import read_live_party


def read_gold(reader, psd):
    """Gold balance (CurrencySaveData Key==GOLD_KEY)."""
    if not psd:
        return 0
    for e in reader.list_iter(reader.rptr(psd + PlayerSaveData.CURRENCIES), cap=200):
        if reader.ri32(e + CurrencySaveData.KEY) == GOLD_KEY:
            return reader.ri64(e + CurrencySaveData.QUANTITY) or 0
    return 0


def read_heroes(reader, psd):
    """{heroKey: (level, exp)} of the played heroes (from the save; exp is stale)."""
    res = {}
    if not psd:
        return res
    for e in reader.list_iter(reader.rptr(psd + PlayerSaveData.HEROES), cap=200):
        k = reader.ri32(e + HeroSaveData.HERO_KEY)
        lvl = reader.ri32(e + HeroSaveData.LEVEL)
        exp = reader.rf32(e + HeroSaveData.EXP)
        if k is None or lvl is None or exp is None:
            continue
        if lvl > 1 or exp > 0:
            res[k] = (lvl, exp)
    return res


def pick_live_psd(reader, cands):
    """LIVE PlayerSaveData = the one with the MOST gold (older snapshots have less)."""
    best, bg = None, -1
    for a in (cands or [])[:200]:
        g = read_gold(reader, a)
        if g and g > bg:
            bg, best = g, a
    return best


def pick_live_sm(reader, cands):
    """LIVE StageManager = the 1st candidate from which `read_live_party` extracts a party (>=1
    valid DEPLOYED hero). Scans ALL, no cap (like `pick_live_csd`): the carrier can be at ANY
    index; a fixed cap (was `[:600]`) lost it when the backref returned more than that — NAILED in
    1.00.11 (1162 instances, carrier beyond 600 → `StageManager NOT found` in combat → party fell
    back to the roster). `read_live_party` scans ALL slots (a solo party outside slot 0 still
    resolves) and never raises.

    THE VALIDATION IS THE SAME as `read_live_party` (by construction: it calls it). Previously this
    pick used a WEAKER check (only `heroKey`) than `read_live_party` (which ALSO requires
    level/exp): a 'ghost' instance (a torn-down/template StageManager — valid heroKey but lvl=0)
    passed here, got picked and FROZEN (`if not sm` in the meter loop), and `read_live_party` read
    {} for the entire session → 1.00.13: `StageManager ok — 0 heroes deployed`, every run
    `heroes:err`. Same family as [[invariants/instance-selection]] (managers): pick the LIVE
    instance by structural validation, never the 1st-in-range. No readable candidate → None
    (degrades honestly; NEVER a ghost that `read_live_party` can't read)."""
    for a in (cands or []):
        if read_live_party(reader, a):
            return a
    return None


def pick_live_csd(reader, cands):
    """LIVE CommonSaveData = the one with the HIGHEST playTime (with a plausible stageKey). Reads
    the currentStageKey live. Mirrors the monolith (scans ALL candidates, no cap)."""
    best, best_pt = None, -1.0
    for a in (cands or []):
        key = reader.ri32(a + CommonSaveData.CURRENT_STAGE_KEY)
        pt = reader.rf32(a + CommonSaveData.PLAYTIME)
        if key is not None and 0 < key < 10_000_000 and pt is not None and pt > best_pt:
            best_pt, best = pt, a
    return best
