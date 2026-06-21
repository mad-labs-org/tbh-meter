"""xp.py — LIVE per-hero XP: tick-by-tick ACCUMULATOR (PartyXpAccumulator) + level-up
bridging via the curve.

Live xp (HeroRuntime.EXP_FAKE) is within-level and resets on level-up; the curve
(config/level_curve.json = ExpForLevelUp per level) fills the wrap. Validated live:
across 3 level-ups the sum matched with diff 0. Within-level is MONOTONIC outside level-up
(the dip detector ran many runs with a death and never fired) — death only PAUSES the gain.

CAP: a level with no curve entry has no defined progression (level_capped) — the game keeps
incrementing EXP_FAKE at the cap with no level-up to consume it, so the same-level delta is
PHANTOM XP: a hero at the cap gains 0; crossing INTO the cap banks only up to the threshold."""

import json
import os

from shared.utils import resource_path

_CURVE = None


def curve():
    """{level: ExpForLevelUp} loaded once from config/level_curve.json.
    Via resource_path -> works in source AND frozen (PyInstaller sys._MEIPASS)."""
    global _CURVE
    if _CURVE is None:
        path = resource_path(os.path.join("config", "level_curve.json"))
        with open(path, encoding="utf-8") as f:
            _CURVE = {int(k): int(v) for k, v in json.load(f).items()}
    return _CURVE


def level_capped(lv):
    """A level with no curve entry = no defined progression = CAP (the real curve covers
    1..100 → cap 101). Also neutralizes garbage levels OUTSIDE the curve's range (0/negative
    or above the cap — 0 beats phantom xp). level_capped(None) is False — with no level info,
    keep the raw delta. Curve unavailable (broken bundle) → False: treat as not-capped (raw
    delta, pre-fix behavior) — the reader stays alive (this is the 1st touch of the curve on
    the close_run path); CI --selftest gates the broken bundle."""
    if lv is None:
        return False
    try:
        return lv not in curve()
    except Exception:
        return False


def xp_through_levelup(lv0, exp0, lv1, exp1):
    """Total XP gained crossing one (or more) level-up: (curve[lv0]-exp0) + full
    intermediate levels + exp1. Crossing INTO the cap (lv1 with no curve entry) banks
    only up to the threshold — the post-cap exp1 is phantom, doesn't count. None if the
    curve doesn't cover lv0/intermediate levels or it goes negative."""
    c = curve()
    try:
        total = (c[lv0] - exp0) + (exp1 if lv1 in c else 0.0)
        for L in range(lv0 + 1, lv1):
            total += c[L]
        return total if total >= 0 else None
    except (KeyError, TypeError):
        return None


def per_hero_gain(lv0, exp0, lv1, exp1):
    """XP gain of ONE hero between two live snapshots. Handles level-up via the curve.
    A hero AT the cap (level_capped) gains 0.0 same-level — EXP_FAKE keeps rising at the cap
    with no level-up to consume it, so the delta is phantom. 0.0 is a VALID zero gain
    (≠ None = not-read). Returns (gain|None, leveled: bool)."""
    leveled = (lv1 is not None and lv0 is not None and lv1 > lv0)
    if leveled:
        return xp_through_levelup(lv0, exp0, lv1, exp1), True
    if exp0 is None or exp1 is None:
        return None, False
    if level_capped(lv1):
        return 0.0, False
    return (exp1 - exp0), False


class PartyXpAccumulator:
    """LIVE per-hero xp accumulator — the primary LIVE of the xp chain, for the WHOLE run.

    Integrates the within-level increments (HeroRuntime.EXP_FAKE, build.read_live_party
    shape) tick-by-tick, keyed by heroKey, instead of subtracting two endpoints
    (baseline t=0 → read at close). The endpoint delta gave +0 to a hero OUTSIDE the
    baseline (late deploy, or a death from the PREVIOUS run still reviving ~115s:
    no exp_start → gain None → +0 in the app) — pinned live on 2 users: runs with a death
    zeroed a hero in 30–45% of cases; without a death, 0%.

    Update rules (1 snapshot {heroKey: (lv, exp)} per call):
      - 1st sighting → seeds the baseline (acc=0, exp_start=exp): credit from THIS point
        onward (the +0 fix); doesn't invent past.
      - next tick → adds per_hero_gain(prev, cur) ONLY when > 0; level-up bridges via the
        curve and sets `levelup` STICKY.
      - hero AT THE CAP (level_capped: a level with no curve entry) → gain 0 (per_hero_gain
        returns 0.0, not None); crossing INTO the cap banks only up to the threshold. The
        baseline ADVANCES on g == 0 → exp_start/exp_end follow the RAW (honest) observation;
        only the gain is suppressed (EXP_FAKE rises at the cap with no level-up = phantom).
      - same-level dip (g < 0 = dirty read; the real within-level is monotonic outside
        level-up) → doesn't add AND DOESN'T advance the baseline: the recovery telescopes
        (cur − last_good) without double-count.
      - hero ABSENT from the snapshot (dead/dropout) → nothing moves: the accumulated value
        stays banked (a dead hero accumulates 0 while dead — real game behavior, preserved).
      - garbage entry (lv/exp None, wrong shape) → ignored; NEVER raises (mirrors the
        never-raise contract of read_live_party).

    Reads: gain/record return None if the hero was NEVER seen (≠ 0.0 = VALID zero gain);
    total() returns None if NOBODY was seen (live source OFF → the caller falls back to
    SAVE — never conflate None-from-read with 0-from-gain)."""

    def __init__(self):
        self._heroes = {}   # heroKey -> {acc, lv, exp, exp_start, levelup}

    def update(self, party):
        """Integrates a live snapshot {heroKey: (lv, exp)}. Never-raises; {}/None = no-op."""
        try:
            items = party.items() if party else ()
            for hk, cur in items:
                try:
                    lv, exp = cur
                except (TypeError, ValueError):
                    continue
                if lv is None or exp is None:
                    continue
                st = self._heroes.get(hk)
                if st is None:
                    self._heroes[hk] = {"acc": 0.0, "lv": lv, "exp": exp,
                                        "exp_start": exp, "levelup": False}
                    continue
                if lv < st["lv"]:
                    # Level NEVER drops mid-run: dirty read (a pending HeroList slot that still
                    # returns a valid heroKey) → doesn't add AND doesn't advance the baseline
                    # (symmetric to the same-level dip). Tick-by-tick multiplies the exposure to
                    # dirty reads ~600x vs the 2-endpoint delta, so the regression guard matters here.
                    continue
                g, leveled = per_hero_gain(st["lv"], st["exp"], lv, exp)
                if leveled:
                    st["levelup"] = True
                if g is not None and g > 0:
                    st["acc"] += g
                if g is None or g >= 0:
                    # Advance the baseline (g=None = a level-up the curve didn't cover: skips the
                    # bridge but keeps accumulating from there). On the same-level dip (g<0) DOESN'T advance.
                    st["lv"], st["exp"] = lv, exp
        except Exception:
            return

    def gain(self, hk):
        """The hero's RAW accumulated value, or None if never seen (≠ 0.0, valid zero gain)."""
        st = self._heroes.get(hk)
        return st["acc"] if st is not None else None

    def record(self, hk):
        """{gain, levelup, exp_start, exp_end} ready for the run record (rounded),
        or None if the hero was never seen live."""
        st = self._heroes.get(hk)
        if st is None:
            return None
        return {"gain": round(st["acc"], 2), "levelup": st["levelup"],
                "exp_start": round(st["exp_start"], 2), "exp_end": round(st["exp"], 2)}

    def total(self):
        """RAW sum of the accumulated values, or None if NO hero was seen (live source off)."""
        if not self._heroes:
            return None
        return sum(st["acc"] for st in self._heroes.values())


def party_progress(acc, party):
    """Per-hero LIVE leveling snapshot for the overlay's time-to-level: {heroKey: {level, exp, gain}}.

    Assembles ALREADY-read values (no memory, no clock):
      - `level`/`exp`: within-level live values from read_live_party (HeroRuntime LEVEL_FAKE/EXP_FAKE).
        `exp` resets on level-up, so the app's "remaining to next level" is curve[level] - exp.
      - `gain`: the run's accumulated XP for that hero (PartyXpAccumulator.gain, level-up-bridged), from
        which the app derives the live rate (delta gain / delta t) and the ETA. 0.0 = seen with no gain
        yet (just-deployed, or AT the cap where gain is phantom-suppressed) -> the app shows "-"/"MAX";
        never None here (the hero is in `party`, so the accumulator saw it this very tick).

    Keyed by the CURRENT snapshot (`party` == read_live_party): the heroes deployed RIGHT NOW. A hero in
    the accumulator but absent from `party` (dead/dropped) gets no entry (no live rate to project).
    ADDITIVE for live.json (mirrors party_stats): an old reader omits it -> the app degrades (no ETA).
    Never raises -> {} (the read_live_party / accumulator never-raise contract)."""
    out = {}
    try:
        items = party.items() if party else ()
        for hk, cur in items:
            try:
                lv, exp = cur
            except (TypeError, ValueError):
                continue
            if lv is None or exp is None:
                continue
            g = acc.gain(hk) if acc is not None else None
            out[hk] = {"level": lv, "exp": exp, "gain": g if g is not None else 0.0}
    except Exception:
        return {}
    return out
