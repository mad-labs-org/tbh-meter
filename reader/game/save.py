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


def pick_live_sm(reader, cands, hero_cat=None):
    """LIVE StageManager = the 1st candidate from which `read_live_party` extracts a party (>=1
    valid DEPLOYED hero). Scans ALL, no cap (like `pick_live_csd`): the carrier can be at ANY
    index; a fixed cap (was `[:600]`) lost it when the backref returned more than that — NAILED in
    1.00.11 (1162 instances, carrier beyond 600 → `StageManager NOT found` in combat → party fell
    back to the roster). `read_live_party` scans ALL slots (a solo party outside slot 0 still
    resolves) and never raises.

    THE VALIDATION IS THE SAME as `read_live_party` (by construction: it calls it) — so pick<->read
    can never disagree on which slot is a carrier (the root of the 1.00.13 bug, when pick used a
    weaker check than read). The discriminator that separates the live carrier from a 'ghost'
    (torn-down/template StageManager — same family as [[invariants/instance-selection]]) is the
    DEPLOYED heroKey resolving a real class in `hero_cat`: pass it through so the pick applies it.
    Through 1.00.19 the discriminator was a valid heroKey with `lvl>0`; 1.00.20 killed the live level
    decoy (ACTk fakeValue → 0), so a `lvl>0` gate would reject EVERY real hero — the heroKey/catalog
    check replaces it (see read_live_party). No readable candidate → None (degrades honestly; NEVER a
    ghost that `read_live_party` can't read)."""
    for a in (cands or []):
        if read_live_party(reader, a, hero_cat):
            return a
    return None


# A real CommonSaveData's playTime is bounded seconds of active play (the live save reads ~1.76e6 =
# ~488h). The CommonSaveData type scan also matches FALSE-POSITIVE instances whose PLAYTIME slot is a
# random bit pattern — a denormal (~1e-38), 0, inf/nan, or huge (1.00.17: 3.77e19). 1e9 s (~31 yr) is
# comfortably above any real save and below that garbage, so it rejects the false matches.
_MAX_PLAYTIME_S = 1e9


def pick_live_csd(reader, cands, stage_info=None):
    """LIVE CommonSaveData = the REAL save among the candidates. The type scan also returns
    FALSE-POSITIVE instances (garbage memory matching the type) — guard against them: require a SANE
    playTime AND a plausible currentStageKey. When stage_info is given, a candidate whose key is an
    ACTUAL catalog stage outranks any whose key merely falls under the numeric bound — that uniquely
    fingerprints the real save (1.00.17: a garbage instance with pt=3.77e19, key=6775040 beat the
    real save pt=1.76e6, key=4309 under the old highest-playTime-only rule). Within a tier the
    highest playTime wins. Scans ALL candidates, no cap (mirrors the monolith); no readable
    candidate -> None (degrades honestly, like pick_live_sm)."""
    best, best_rank = None, (False, -1.0)
    for a in (cands or []):
        key = reader.ri32(a + CommonSaveData.CURRENT_STAGE_KEY)
        pt = reader.rf32(a + CommonSaveData.PLAYTIME)
        if key is None or not (0 < key < 10_000_000):
            continue
        if pt is None or not (0.0 < pt < _MAX_PLAYTIME_S):
            continue
        rank = (bool(stage_info) and key in stage_info, pt)  # in-catalog tier first, then playTime
        if rank > best_rank:
            best_rank, best = rank, a
    return best
