"""Tests for metrics/xp.py.

per_hero_gain — a hero's XP gain between two snapshots (handles level-up + cap).
xp_through_levelup — sums XP crossing one or more levels along the curve (clamps at cap).
level_capped — level with no curve entry = cap (no defined progression).
PartyXpAccumulator — LIVE per-hero accumulator (tick-by-tick), the run's primary LIVE source.
"""

import pytest

import metrics.xp as xp_mod
from metrics.xp import PartyXpAccumulator, level_capped, per_hero_gain, xp_through_levelup


# ---------------------------------------------------------------------------
# per_hero_gain — delta logic (with or without level-up)
# ---------------------------------------------------------------------------

class TestPerHeroGain:
    def test_same_level_positive_gain(self, fake_curve):
        gain, leveled = per_hero_gain(1, 10.0, 1, 20.0)
        assert gain == pytest.approx(10.0)
        assert leveled is False

    def test_same_level_zero_gain(self, fake_curve):
        gain, leveled = per_hero_gain(2, 50.0, 2, 50.0)
        assert gain == pytest.approx(0.0)
        assert leveled is False

    def test_none_exp_start_returns_none(self):
        gain, leveled = per_hero_gain(1, None, 1, 20.0)
        assert gain is None
        assert leveled is False

    def test_none_exp_end_returns_none(self):
        gain, leveled = per_hero_gain(1, 10.0, 1, None)
        assert gain is None
        assert leveled is False

    def test_both_levels_none_returns_delta_when_exp_present(self):
        """No level info but exp present → returns the delta (no level-up detected).
        per_hero_gain only returns None when the XP values are None."""
        gain, leveled = per_hero_gain(None, 10.0, None, 20.0)
        assert gain == pytest.approx(10.0)
        assert leveled is False

    def test_both_levels_and_exp_none_returns_none(self):
        """When the XP values are None → there's no way to compute the gain."""
        gain, leveled = per_hero_gain(None, None, None, None)
        assert gain is None
        assert leveled is False

    def test_level_up_detected(self, fake_curve):
        """Level 1→2: gained (30 - exp0) + exp1 = (30 - 10) + 5 = 25."""
        gain, leveled = per_hero_gain(1, 10.0, 2, 5.0)
        assert leveled is True
        assert gain == pytest.approx(25.0)

    def test_multi_level_up(self, fake_curve):
        """Level 1→3: (30-10) + 150 + 20 = 190."""
        gain, leveled = per_hero_gain(1, 10.0, 3, 20.0)
        assert leveled is True
        assert gain == pytest.approx(190.0)

    @pytest.mark.parametrize("lv0,exp0,lv1,exp1,expected", [
        (1, 0.0, 1, 30.0, 30.0),   # level 1, gained exactly the level's max
        (2, 100.0, 2, 100.0, 0.0),  # no gain
        (1, 29.0, 1, 0.0, -29.0),   # exp drop (unlikely but must not crash)
    ])
    def test_same_level_cases(self, fake_curve, lv0, exp0, lv1, exp1, expected):
        gain, _ = per_hero_gain(lv0, exp0, lv1, exp1)
        assert gain == pytest.approx(expected)

    def test_same_level_at_cap_returns_zero_not_none(self, real_curve):
        """Hero AT the cap (101): same-level returns 0.0 — a VALID zero gain, never None
        (None would mean couldn't-read and fall through to the save fallback, which has the
        SAME phantom hole). EXP_FAKE rises at the cap with no level-up to consume it = phantom delta."""
        gain, leveled = per_hero_gain(101, 3.0e9, 101, 3.0e9 + 41_000.0)
        assert gain == 0.0
        assert leveled is False


# ---------------------------------------------------------------------------
# level_capped — level with no curve entry = cap (no defined progression)
# ---------------------------------------------------------------------------

class TestLevelCapped:
    def test_cap_101_true_with_real_curve(self, real_curve):
        """Real curve covers 1..100 → 101 has no defined progression = cap."""
        assert 101 not in real_curve
        assert level_capped(101) is True

    def test_100_false_with_real_curve(self, real_curve):
        """100 has a curve entry (still climbs to 101) → not a cap."""
        assert 100 in real_curve
        assert level_capped(100) is False

    def test_none_false(self):
        """No level info → False (keeps the raw delta; doesn't consult the curve)."""
        assert level_capped(None) is False

    def test_curve_unavailable_degrades_to_false(self, monkeypatch):
        """Curve unavailable (broken bundle): False = treat as un-capped (raw delta,
        pre-fix behavior) instead of killing the reader at close_run — update() would
        swallow the error every tick (invisible failure) and the xp_by_hero comprehension
        would raise unguarded. CI --selftest gates the broken bundle before ship."""
        def _boom():
            raise OSError("level_curve.json unavailable")
        monkeypatch.setattr(xp_mod, "curve", _boom)
        assert level_capped(101) is False
        gain, leveled = per_hero_gain(101, 1000.0, 101, 1500.0)   # same-level falls through to raw delta
        assert gain == pytest.approx(500.0)
        assert leveled is False


# ---------------------------------------------------------------------------
# xp_through_levelup — sums along the curve (requires fake_curve via fixture)
# ---------------------------------------------------------------------------

class TestXpThroughLevelup:
    def test_single_levelup(self, fake_curve):
        """Level 1→2: (curve[1] - exp0) + exp1 = (30 - 10) + 50 = 70."""
        result = xp_through_levelup(1, 10.0, 2, 50.0)
        assert result == pytest.approx(70.0)

    def test_levelup_from_zero(self, fake_curve):
        """Level 1→2 starting from zero: 30 + 80 = 110."""
        result = xp_through_levelup(1, 0.0, 2, 80.0)
        assert result == pytest.approx(110.0)

    def test_multi_level_span(self, fake_curve):
        """Level 1→4: (30-5) + 150 + 500 + 300 = 975."""
        result = xp_through_levelup(1, 5.0, 4, 300.0)
        assert result == pytest.approx(975.0)

    def test_two_level_span(self, fake_curve):
        """Level 2→4: (150-100) + 500 + 0 = 550."""
        result = xp_through_levelup(2, 100.0, 4, 0.0)
        assert result == pytest.approx(550.0)

    def test_missing_curve_level_returns_none(self, fake_curve):
        """Level outside the curve → None (don't guess)."""
        result = xp_through_levelup(99, 0.0, 100, 0.0)
        assert result is None

    def test_negative_result_returns_none(self, fake_curve):
        """exp0 > curve[lv0] (corrupted) → negative total → None."""
        result = xp_through_levelup(1, 9999.0, 2, 0.0)
        assert result is None

    def test_none_exp_returns_none(self, fake_curve):
        result = xp_through_levelup(1, None, 2, 0.0)
        assert result is None

    def test_crossing_into_cap_clamps_at_threshold(self, real_curve):
        """Crossing INTO the cap (lv1 with no curve entry) banks only up to the threshold:
        the post-cap exp1 is phantom and doesn't count — (curve[100]-exp0) + 0."""
        c = real_curve
        result = xp_through_levelup(100, float(c[100] - 50), 101, 20.0)
        assert result == pytest.approx(50.0)

    def test_real_curve_loads(self):
        """Integration: the real curve (level_curve.json) must load without error."""
        xp_mod._CURVE = None  # force reload
        c = xp_mod.curve()
        assert isinstance(c, dict)
        assert len(c) > 0
        assert all(isinstance(k, int) and isinstance(v, int) for k, v in c.items())


# ---------------------------------------------------------------------------
# PartyXpAccumulator — the primary LIVE source: integrates per-hero increments tick-by-tick
# (replaces the endpoint delta, which gave +0 to a hero outside the t=0 baseline)
# ---------------------------------------------------------------------------

class TestPartyXpAccumulator:
    def test_unseen_hero_record_and_gain_are_none(self):
        """Never seen -> None (not 0): the caller decides the fallback (save), never a silent +0."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        assert acc.record(999) is None
        assert acc.gain(999) is None

    def test_total_none_when_nobody_ever_seen(self):
        """Live source OFF the whole run -> total() None -> xp_source degrades to the save.
        A read-None never becomes a gain-0 (the gold:0 rule)."""
        acc = PartyXpAccumulator()
        acc.update({})
        acc.update(None)
        assert acc.total() is None

    def test_first_sight_seeds_baseline_with_zero_gain(self):
        """1st sighting = baseline (acc=0, exp_start=exp). Zero is a VALID gain != None."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        assert acc.record(601) == {"gain": 0.0, "levelup": False,
                                   "exp_start": 100.0, "exp_end": 100.0}
        assert acc.total() == pytest.approx(0.0)

    def test_accumulates_rising_ticks(self):
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        acc.update({601: (10, 250.0)})
        acc.update({601: (10, 600.0)})
        assert acc.gain(601) == pytest.approx(500.0)
        assert acc.record(601)["exp_end"] == pytest.approx(600.0)

    def test_late_join_credited_from_first_sight(self):
        """The +0 FIX: a hero outside the t=0 baseline (late deploy / dead from the previous run
        who revives mid-run) is credited from the 1st sighting onward (before: gain=None -> +0)."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})                       # t=0: only 601
        acc.update({601: (10, 200.0), 702: (33, 1000.0)})    # 702 joins on tick 2
        acc.update({601: (10, 300.0), 702: (33, 5000.0)})
        assert acc.gain(702) == pytest.approx(4000.0)
        assert acc.record(702)["exp_start"] == pytest.approx(1000.0)
        assert acc.total() == pytest.approx(200.0 + 4000.0)

    def test_levelup_bridged_by_curve_across_tick(self, fake_curve):
        """1→2 between two ticks: (curve[1]-exp0)+exp1 = (30-10)+5 = 25; levelup STICKY."""
        acc = PartyXpAccumulator()
        acc.update({601: (1, 10.0)})
        acc.update({601: (2, 5.0)})
        assert acc.gain(601) == pytest.approx(25.0)
        acc.update({601: (2, 7.0)})                          # next tick with no level-up
        rec = acc.record(601)
        assert rec["levelup"] is True                        # sticky, doesn't vanish on the next tick
        assert rec["gain"] == pytest.approx(27.0)

    def test_multi_levelup_bridged_in_one_tick(self, fake_curve):
        """1→3 in a single tick: (30-10) + 150 + 20 = 190 (intermediate levels full)."""
        acc = PartyXpAccumulator()
        acc.update({601: (1, 10.0)})
        acc.update({601: (3, 20.0)})
        assert acc.gain(601) == pytest.approx(190.0)

    def test_cap_edge_100_to_101_uses_real_curve(self, real_curve):
        """Cap edge: 100→101 uses curve[100] (exists) and CLAMPS at the threshold — the
        post-cap exp1 (20) is phantom and doesn't count; levelup stays True. The next tick
        ALREADY at the cap with exp rising → gain stops moving."""
        c = real_curve                                       # REAL curve (1..100); restored in teardown
        assert 100 in c and 101 not in c
        acc = PartyXpAccumulator()
        acc.update({601: (100, float(c[100] - 50))})
        acc.update({601: (101, 20.0)})
        assert acc.gain(601) == pytest.approx(50.0)          # only up to the threshold; the 20 post-cap don't count
        assert acc.record(601)["levelup"] is True
        acc.update({601: (101, 90_000.0)})                   # at the cap: exp rises = phantom
        assert acc.gain(601) == pytest.approx(50.0)

    def test_hero_at_cap_101_banks_zero(self, real_curve):
        """Hero ALREADY at the cap (101, no curve key = no defined progression) with
        EXP_FAKE rising: the game keeps incrementing with no level-up to consume it → the delta
        is PHANTOM XP. Banks 0.0 (a VALID zero gain, non-None record) and the baseline
        advances: exp_start/exp_end follow the RAW observation — only the gain is suppressed."""
        acc = PartyXpAccumulator()
        acc.update({601: (101, 1000.0)})
        acc.update({601: (101, 1500.0)})
        acc.update({601: (101, 2500.0)})
        assert acc.gain(601) == pytest.approx(0.0)
        rec = acc.record(601)
        assert rec is not None
        assert rec["gain"] == pytest.approx(0.0)
        assert rec["levelup"] is False
        assert rec["exp_start"] == pytest.approx(1000.0)
        assert rec["exp_end"] == pytest.approx(2500.0)       # raw observation keeps moving

    def test_solo_capped_hero_total_zero_not_none(self, real_curve):
        """REGRESSION (production, meter v0.31.0 / game v1.00.11, player denny8126): SOLO
        runs with just one Ranger lv101 (cap) racked up ~39M xpGained EACH (e.g. run
        76271dba, 3-9 Torment, 177s) — a hero at the cap playing alone MUST gain 0.
        total() == 0.0 (seen the whole run → LIVE source, xp_source 'live'), NEVER None
        (None would fall silently to the save fallback, which has the same phantom delta)."""
        acc = PartyXpAccumulator()
        e0, total, ticks = 3.0e9, 39_354_368.0, 177          # raw EXP_FAKE accumulated at the cap
        for t in range(ticks + 1):
            acc.update({201: (101, e0 + total * t / ticks)})
        rec = acc.record(201)
        assert rec is not None
        assert rec["gain"] == pytest.approx(0.0)
        assert acc.total() is not None                       # live source ON: no save fallback
        assert acc.total() == pytest.approx(0.0)

    def test_party_with_capped_hero_counts_only_uncapped(self, real_curve):
        """REGRESSION (production, run 1dff787d, 3-2 Torment, 223s): party Knight 81 /
        Ranger 101 (cap) / Sorcerer 83 racked up meta.xpGained=45,405,600, crediting 9.16M
        (20%) to the capped Ranger. Only the un-capped ones count: 18.76M + 17.48M = 36.24M."""
        acc = PartyXpAccumulator()
        gains = {301: 18_760_000.0, 101: 17_480_000.0, 201: 9_165_600.0}
        start = {301: 1.2e9, 101: 0.9e9, 201: 3.0e9}
        levels = {301: 83, 101: 81, 201: 101}
        ticks = 223
        for t in range(ticks + 1):
            acc.update({hk: (levels[hk], start[hk] + gains[hk] * t / ticks)
                        for hk in gains})
        assert acc.record(301)["gain"] == pytest.approx(18_760_000.0)   # Sorcerer 83
        assert acc.record(101)["gain"] == pytest.approx(17_480_000.0)   # Knight 81
        assert acc.record(201)["gain"] == pytest.approx(0.0)            # Ranger 101 (cap)
        assert acc.total() == pytest.approx(36_240_000.0)               # sum of the un-capped only

    def test_dead_time_banks_gain_and_adds_zero_while_absent(self):
        """Dead leaves the HeroList -> absent ticks neither add NOR lose the banked value; on revive
        exp resumes where it left off (no rise while dead) and continues with no double-count."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        acc.update({601: (10, 500.0)})                       # alive: +400
        acc.update({})                                       # dead (absent from the snapshot)
        acc.update({})
        assert acc.gain(601) == pytest.approx(400.0)         # banked, not lost
        acc.update({601: (10, 500.0)})                       # revived: exp unchanged = +0
        assert acc.gain(601) == pytest.approx(400.0)         # no double-count
        acc.update({601: (10, 650.0)})
        assert acc.gain(601) == pytest.approx(550.0)

    def test_exp_pause_adds_zero(self):
        """Exp unchanged (present but no rise, e.g. idle at the boss) -> +0 per tick, no noise."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        for _ in range(3):
            acc.update({601: (10, 100.0)})
        acc.update({601: (10, 130.0)})
        assert acc.gain(601) == pytest.approx(30.0)

    def test_dropout_keeps_accumulated_value(self):
        """Hero seen then gone from the remaining ticks (incl. the last): keeps the
        accumulated value — record never degrades to None/0."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0), 702: (20, 0.0)})
        acc.update({601: (10, 900.0), 702: (20, 50.0)})
        acc.update({702: (20, 80.0)})                        # 601 vanished and doesn't return
        rec = acc.record(601)
        assert rec is not None
        assert rec["gain"] == pytest.approx(800.0)
        assert rec["exp_end"] == pytest.approx(900.0)
        assert acc.total() == pytest.approx(800.0 + 80.0)

    def test_same_level_dip_skipped_and_recovery_not_double_counted(self):
        """Same-level dip (dirty read; the real within-level is monotonic): doesn't add, doesn't
        advance the baseline — recovery telescopes (105-100=5), never 65 nor negative."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        acc.update({601: (10, 40.0)})                        # dip (garbage)
        assert acc.gain(601) == pytest.approx(0.0)
        acc.update({601: (10, 105.0)})                       # recovers
        assert acc.gain(601) == pytest.approx(5.0)

    def test_level_regression_skipped_no_phantom_gain(self):
        """Level NEVER drops mid-run: a read with a lower lv (dirty slot) is SKIPPED — it neither adds
        phantom gain nor poisons the baseline; recovery at the right level telescopes."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 1000.0)})
        acc.update({601: (3, 50.0)})                         # level regression (garbage)
        assert acc.gain(601) == pytest.approx(0.0)           # no phantom gain
        acc.update({601: (10, 1200.0)})                      # back to the real level
        assert acc.gain(601) == pytest.approx(200.0)         # baseline preserved (1200-1000)

    def test_garbage_entries_ignored_never_raises(self):
        """A garbage entry is ignored without exception (read_live_party's never-raise contract)."""
        acc = PartyXpAccumulator()
        acc.update(None)
        acc.update({601: None, 702: (None, 50.0), 803: (10, None),
                    904: "x", 905: (1, 2, 3)})
        assert acc.total() is None                           # nothing valid seen yet
        acc.update({601: (10, 100.0)})
        assert acc.total() == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# party_progress — per-hero live leveling snapshot for the overlay (level+exp+gain)
# ---------------------------------------------------------------------------

class TestPartyProgress:
    def test_combines_snapshot_level_exp_with_accumulated_gain(self):
        acc = PartyXpAccumulator()
        acc.update({101: (91, 1000.0)})
        acc.update({101: (91, 1500.0)})                      # +500 gain
        prog = xp_mod.party_progress(acc, {101: (91, 1500.0)})
        assert prog == {101: {"level": 91, "exp": 1500.0, "gain": 500.0}}

    def test_seen_no_gain_yet_is_zero_not_none(self):
        """1st sighting -> gain 0.0 (VALID), never None: the entry is always renderable."""
        acc = PartyXpAccumulator()
        acc.update({101: (91, 1000.0)})
        assert xp_mod.party_progress(acc, {101: (91, 1000.0)})[101]["gain"] == 0.0

    def test_capped_hero_gain_zero(self, real_curve):
        """Hero at the cap (101): accumulated gain is phantom-suppressed to 0.0; level/exp still raw."""
        acc = PartyXpAccumulator()
        acc.update({201: (101, 3.0e9)})
        acc.update({201: (101, 3.0e9 + 50_000.0)})
        e = xp_mod.party_progress(acc, {201: (101, 3.0e9 + 50_000.0)})[201]
        assert e["level"] == 101
        assert e["gain"] == 0.0
        assert e["exp"] == pytest.approx(3.0e9 + 50_000.0)

    def test_keyed_by_current_snapshot_absent_hero_omitted(self):
        """A hero in the accumulator but ABSENT from the current snapshot (dead/dropped) gets no
        entry — there's no live rate to project for someone not gaining right now."""
        acc = PartyXpAccumulator()
        acc.update({101: (91, 100.0), 301: (93, 200.0)})
        acc.update({101: (91, 300.0), 301: (93, 400.0)})
        prog = xp_mod.party_progress(acc, {101: (91, 300.0)})   # only 101 deployed now
        assert set(prog) == {101}

    def test_empty_and_garbage_never_raise(self):
        acc = PartyXpAccumulator()
        assert xp_mod.party_progress(acc, {}) == {}
        assert xp_mod.party_progress(acc, None) == {}
        assert xp_mod.party_progress(acc, {101: None, 301: (None, 5.0), 401: "x"}) == {}

    def test_none_accumulator_degrades_to_zero_gain(self):
        """No accumulator (defensive) -> still emits level/exp with gain 0.0 (never raises)."""
        assert xp_mod.party_progress(None, {101: (91, 1000.0)}) == {
            101: {"level": 91, "exp": 1000.0, "gain": 0.0}}
