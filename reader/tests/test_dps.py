"""Tests for metrics/dps.py — DpsTracker.

The tracker measures damage from the HP DROP of monsters. Cases covered:
  - a new monster registers no damage
  - an HP drop counts as damage
  - an HP increase (heal / reused addr) is ignored
  - a vanished monster = final blow (remaining HP)
  - the sliding window expires old samples
  - total_damage accumulates correctly
  - alive counts mobs alive in the tick
  - reset clears everything
"""

import pytest

from metrics.dps import DpsTracker

# Convenience helpers
def mob(addr, hp, hp_max=100.0):
    return (addr, hp, hp_max)


class TestDpsTrackerInitialState:
    def test_total_damage_starts_zero(self):
        t = DpsTracker()
        assert t.total_damage == 0.0

    def test_alive_starts_zero(self):
        t = DpsTracker()
        assert t.alive == 0

    def test_dps_starts_zero(self):
        t = DpsTracker()
        assert t.dps(0.0) == 0.0

    def test_peak_starts_zero(self):
        t = DpsTracker()
        assert t.peak_dps == 0.0


class TestDpsTrackerDamage:
    def test_new_monster_registers_no_damage(self):
        t = DpsTracker()
        t.update([mob(1, 100.0)], timestamp=0.0)
        assert t.total_damage == 0.0

    def test_hp_drop_counts_as_damage(self):
        t = DpsTracker()
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 60.0)], timestamp=0.1)
        assert t.total_damage == pytest.approx(40.0)

    def test_hp_increase_ignored(self):
        """A heal or reused address must not count as damage."""
        t = DpsTracker()
        t.update([mob(1, 50.0)], timestamp=0.0)
        t.update([mob(1, 80.0)], timestamp=0.1)  # HP went up — ignore
        assert t.total_damage == 0.0

    def test_monster_death_adds_remaining_hp(self):
        """Mob vanished from the list with 30 HP remaining → 30 damage (final blow)."""
        t = DpsTracker()
        t.update([mob(1, 30.0)], timestamp=0.0)
        t.update([], timestamp=0.1)              # mob died
        assert t.total_damage == pytest.approx(30.0)

    def test_multiple_monsters_sum_damage(self):
        t = DpsTracker()
        t.update([mob(1, 100.0), mob(2, 200.0)], timestamp=0.0)
        t.update([mob(1, 70.0), mob(2, 150.0)], timestamp=0.1)
        assert t.total_damage == pytest.approx(80.0)

    def test_zero_hp_monsters_ignored(self):
        """A monster with HP=0 is not tracked (already dead in the pool)."""
        t = DpsTracker()
        t.update([mob(1, 0.0)], timestamp=0.0)
        t.update([mob(1, 0.0)], timestamp=0.1)
        assert t.total_damage == 0.0
        assert t.alive == 0

    def test_none_hp_ignored(self):
        t = DpsTracker()
        t.update([mob(1, None)], timestamp=0.0)
        assert t.total_damage == 0.0

    def test_damage_accumulates_across_ticks(self):
        t = DpsTracker()
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 80.0)], timestamp=0.1)  # +20
        t.update([mob(1, 50.0)], timestamp=0.2)  # +30
        t.update([mob(1, 10.0)], timestamp=0.3)  # +40
        assert t.total_damage == pytest.approx(90.0)


class TestDpsTrackerAlive:
    def test_alive_reflects_current_monsters(self):
        t = DpsTracker()
        t.update([mob(1, 100.0), mob(2, 80.0)], timestamp=0.0)
        assert t.alive == 2

    def test_alive_decreases_when_monster_dies(self):
        t = DpsTracker()
        t.update([mob(1, 100.0), mob(2, 80.0)], timestamp=0.0)
        t.update([mob(1, 90.0)], timestamp=0.1)  # mob 2 died
        assert t.alive == 1

    def test_alive_zero_with_no_monsters(self):
        t = DpsTracker()
        t.update([], timestamp=0.0)
        assert t.alive == 0


class TestDpsTrackerWindow:
    def test_dps_reflects_damage_in_window(self):
        window = 5.0
        t = DpsTracker(window_seconds=window)
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 50.0)], timestamp=1.0)  # 50 damage
        # dps = 50 / 5 = 10/s
        assert t.dps(1.0) == pytest.approx(10.0)

    def test_old_damage_expires_from_window(self):
        window = 2.0
        t = DpsTracker(window_seconds=window)
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 50.0)], timestamp=0.5)  # 50 damage at t=0.5
        # At t=3.0 the sample has expired (0.5 < 3.0 - 2.0)
        assert t.dps(3.0) == pytest.approx(0.0)

    def test_total_damage_not_affected_by_window_expiry(self):
        """total_damage is cumulative for the run; it does not drop when the window expires."""
        t = DpsTracker(window_seconds=1.0)
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 50.0)], timestamp=0.5)   # 50 damage
        _ = t.dps(10.0)                             # window expired
        assert t.total_damage == pytest.approx(50.0)


class TestDpsTrackerReset:
    def test_reset_clears_damage(self):
        t = DpsTracker()
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 50.0)], timestamp=0.1)
        t.reset()
        assert t.total_damage == 0.0

    def test_reset_clears_alive(self):
        t = DpsTracker()
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.reset()
        # After reset, no monster is known; the next tick registers it as new
        t.update([mob(1, 100.0)], timestamp=0.1)
        assert t.total_damage == 0.0  # new monster, no damage

    def test_reset_clears_peak(self):
        t = DpsTracker()
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 0.0)], timestamp=0.1)
        assert t.peak_dps > 0.0
        t.reset()
        assert t.peak_dps == 0.0


class TestDpsTrackerPeak:
    def test_peak_not_overwritten_by_lower_dps(self):
        """Peak DPS must sit EXACTLY at the historical maximum.

        Flow: a spike of 100 damage (DPS=50/s), then a weaker round of 10 damage
        (DPS=5/s). The peak must stay at 50 — neither drop (reset) nor rise (wrong calc).
        Use == instead of >= to flag any deviation in either direction.
        """
        window = 2.0
        t = DpsTracker(window_seconds=window)
        # Round 1: mob spawn + immediate death → 100 damage, DPS = 100/2 = 50/s
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 0.0)], timestamp=0.0)   # hp=0 → skipped in current; prev_hp=100 → final blow
        peak_after_spike = t.peak_dps
        assert peak_after_spike == pytest.approx(50.0)   # sanity: spike recorded

        # Round 2: old window expired (t=5 > window=2), only 10 damage → DPS = 5/s
        t.update([mob(2, 10.0)], timestamp=5.0)
        t.update([mob(2, 0.0)], timestamp=5.0)
        # peak must not change: 5/s < 50/s
        assert t.peak_dps == pytest.approx(peak_after_spike)
