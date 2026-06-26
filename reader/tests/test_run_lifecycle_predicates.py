"""Pure run-lifecycle predicates (extracted from close_run so they're testable).
They guard docs/invariants/run-lifecycle. The rules here are the TRUTH; the note cites these
tests in `guarded_by` — if a rule changes, the test breaks in the right place."""
from meter_windows import _box_belongs_to_pending, _is_partial, _should_skip_run


class TestShouldSkipRun:
    def test_run_under_30s_is_skipped(self):
        assert _should_skip_run(measured=10, clear_time=0, stage=5) is True

    def test_run_over_30s_is_kept(self):
        assert _should_skip_run(measured=45, clear_time=40, stage=5) is False

    def test_stage_x10_under_30s_is_kept(self):
        # x-10 is a boss-only fight: can last seconds and still count. stage == 10 (StageNo).
        assert _should_skip_run(measured=8, clear_time=0, stage=10) is False

    def test_long_clear_time_keeps_short_measured(self):
        # max(measured, clear_time) >= 30 -> keep, even if we measured little.
        assert _should_skip_run(measured=5, clear_time=40, stage=5) is False

    def test_clear_time_none_treated_as_zero(self):
        assert _should_skip_run(measured=10, clear_time=None, stage=5) is True


class TestIsPartial:
    def test_failure_is_never_partial(self):
        assert _is_partial("failed", clear_time=100, measured=50, total_damage=5000) is False

    def test_full_clear_at_95pct_with_damage_is_not_partial(self):
        # measured == 95% of the official clear: NOT < 95% -> counts. Boundary case for PARTIAL_CAPTURE_MIN.
        assert _is_partial("success", clear_time=100, measured=95, total_damage=5000) is False

    def test_just_under_95pct_is_partial(self):
        # measured 94 of a 100s clear -> 94% < 95% -> partial. Boundary case for PARTIAL_CAPTURE_MIN.
        assert _is_partial("success", clear_time=100, measured=94, total_damage=5000) is True

    def test_entered_late_is_partial(self):
        # measured < 95% of the official clear (and clear >= 30) -> joined mid-run -> partial.
        assert _is_partial("success", clear_time=100, measured=50, total_damage=5000) is True

    def test_short_clear_with_damage_is_not_partial(self):
        # clear < 30 (x-10) disables the 1st clause; with damage > 0 it's not partial.
        assert _is_partial("success", clear_time=10, measured=3, total_damage=5000) is False

    def test_zero_damage_success_is_always_partial(self):
        # measured damage <= 0 on a success = capture lost, even with a short clear (#163).
        assert _is_partial("success", clear_time=10, measured=3, total_damage=0) is True


class TestBoxBelongsToPending:
    """GetBoxLog routing (the box-on-the-next-run bug, proven live in 1.00.11):
    the game emits the boss box (mt=1 StageBoss / mt=2 ActBoss) ~0.6s AFTER the StageClearLog,
    once close has already reset R — with a PENDING success, the box belongs to the run that closed.
    Gray (mt=0) drops from a mob in the MIDDLE of the stage → always the current run."""

    def test_boss_box_with_pending_goes_to_pending(self):
        assert _box_belongs_to_pending(1, has_pending=True) is True    # StageBoss (blue)
        assert _box_belongs_to_pending(2, has_pending=True) is True    # ActBoss

    def test_gray_box_never_goes_to_pending(self):
        # mob box drops during the stage: even with a pending success, it's the CURRENT run's.
        assert _box_belongs_to_pending(0, has_pending=True) is False

    def test_boss_box_without_pending_falls_back_to_current(self):
        # reader attached right after a clear (no pending): falls to the current run (+ WARN in the log),
        # never discards a real box.
        assert _box_belongs_to_pending(1, has_pending=False) is False
        assert _box_belongs_to_pending(2, has_pending=False) is False

    def test_unknown_or_unread_tier_goes_to_current(self):
        # mt outside the enum (garbage) or None (read failed) never routes to the pending one.
        assert _box_belongs_to_pending(3, has_pending=True) is False
        assert _box_belongs_to_pending(None, has_pending=True) is False
