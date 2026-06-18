"""Tests for shared/utils.py — RollingWindow, formatting, and utilities."""

import pytest

from shared.utils import (
    RollingWindow,
    format_duration,
    format_number,
    format_percent,
)


# ---------------------------------------------------------------------------
# RollingWindow
# ---------------------------------------------------------------------------

class TestRollingWindow:
    def test_empty_rate_is_zero(self):
        w = RollingWindow(5.0)
        assert w.rate_per_second(0.0) == 0.0

    def test_total_within_window(self):
        w = RollingWindow(5.0)
        w.add(100.0, timestamp=0.0)
        assert w.total(1.0) == pytest.approx(100.0)

    def test_sample_expires_after_window(self):
        w = RollingWindow(5.0)
        w.add(100.0, timestamp=0.0)
        # At t=6 the t=0 sample is outside the 5s window
        assert w.total(6.0) == pytest.approx(0.0)

    def test_rate_per_second(self):
        w = RollingWindow(10.0)
        w.add(200.0, timestamp=0.0)
        # At t=5 the sample is still in the window
        assert w.rate_per_second(5.0) == pytest.approx(20.0)  # 200/10

    def test_rate_per_minute(self):
        w = RollingWindow(60.0)
        w.add(120.0, timestamp=0.0)
        assert w.rate_per_minute(30.0) == pytest.approx(120.0)  # 120/60 * 60

    def test_multiple_samples(self):
        w = RollingWindow(10.0)
        w.add(50.0, timestamp=0.0)
        w.add(30.0, timestamp=2.0)
        assert w.total(5.0) == pytest.approx(80.0)

    def test_partial_expiry(self):
        """Only the oldest sample expires; the most recent one stays."""
        w = RollingWindow(5.0)
        w.add(100.0, timestamp=0.0)  # expires at t=5
        w.add(40.0, timestamp=3.0)   # expires at t=8
        assert w.total(6.0) == pytest.approx(40.0)

    def test_reset_clears_all(self):
        w = RollingWindow(5.0)
        w.add(100.0, timestamp=0.0)
        w.reset()
        assert w.total(1.0) == 0.0
        assert w.rate_per_second(1.0) == 0.0

    def test_zero_window_rate_is_zero(self):
        w = RollingWindow(0.0)
        w.add(100.0, timestamp=0.0)
        assert w.rate_per_second(0.0) == 0.0


# ---------------------------------------------------------------------------
# format_number
# ---------------------------------------------------------------------------

class TestFormatNumber:
    @pytest.mark.parametrize("value,expected", [
        (0, "0"),
        (1, "1"),
        (999, "999"),
        (1_000, "1.00K"),
        (1_500, "1.50K"),
        (1_000_000, "1.00M"),
        (1_234_567, "1.23M"),
        (1_000_000_000, "1.00B"),
        (1_500_000_000, "1.50B"),
    ])
    def test_standard_values(self, value, expected):
        assert format_number(value) == expected

    def test_negative_value(self):
        result = format_number(-5_000)
        assert result.startswith("-")
        assert "5" in result

    def test_none_returns_dash(self):
        assert format_number(None) == "-"

    def test_float_small(self):
        assert format_number(3.5) == "3.5"

    def test_integer_no_decimal(self):
        assert format_number(500) == "500"


# ---------------------------------------------------------------------------
# format_duration
# ---------------------------------------------------------------------------

class TestFormatDuration:
    @pytest.mark.parametrize("seconds,expected", [
        (0, "0s"),
        (1, "1s"),
        (59, "59s"),
        (60, "1m 00s"),
        (90, "1m 30s"),
        (3600, "1h 00m 00s"),
        (3661, "1h 01m 01s"),
        (3725, "1h 02m 05s"),
    ])
    def test_durations(self, seconds, expected):
        assert format_duration(seconds) == expected

    def test_negative_treated_as_zero(self):
        assert format_duration(-10) == "0s"


# ---------------------------------------------------------------------------
# format_percent
# ---------------------------------------------------------------------------

class TestFormatPercent:
    def test_full_hp(self):
        assert format_percent(100.0, 100.0) == "100%"

    def test_half_hp(self):
        assert format_percent(50.0, 100.0) == "50%"

    def test_zero_hp(self):
        assert format_percent(0.0, 100.0) == "0%"

    def test_zero_max_returns_zero_percent(self):
        assert format_percent(50.0, 0.0) == "0%"

    def test_over_max_clamps_to_100(self):
        assert format_percent(150.0, 100.0) == "100%"

    def test_negative_clamps_to_zero(self):
        assert format_percent(-10.0, 100.0) == "0%"


# ---------------------------------------------------------------------------
# init_diag_log / diag — infra log (reader-diag.log), separate from meter.log
# ---------------------------------------------------------------------------
class TestDiagLog:
    def test_writes_when_initialized(self, tmp_path):
        import shared.utils as u
        p = tmp_path / "reader-diag.log"
        u.init_diag_log(str(p))
        try:
            u.diag("[party-pick] candidates=453 carriers=0 picked=0x1234")
            content = p.read_text(encoding="utf-8")
            assert "reader start" in content                          # init banner
            assert "[party-pick] candidates=453 carriers=0" in content
        finally:
            u._DIAG = None                                            # don't leak into other tests

    def test_noop_when_uninitialized(self):
        import shared.utils as u
        u._DIAG = None
        u.diag("does not write or raise")                            # silent no-op (e.g. selftest)

    def test_never_raises_on_broken_sink(self, tmp_path):
        # Contract: diag must NEVER take down the reader. Closed sink -> best-effort, swallow the error.
        import shared.utils as u
        u.init_diag_log(str(tmp_path / "d.log"))
        try:
            u._DIAG.close()
            u.diag("writing to a closed file must not crash")         # does not raise
        finally:
            u._DIAG = None
