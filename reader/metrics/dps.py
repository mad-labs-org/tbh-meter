"""DPS measured from monsters' HP DROP — the meter's headline number.

Idea: each tick, read every live monster's HP. How much HP fell since the
previous tick IS the damage dealt. Sum that over a sliding window -> DPS.

Cases handled:
  - new monster (not seen before): record it, count no damage.
  - HP went up (heal, or address reused from the pool by a new monster):
    ignore, don't count as damage.
  - monster gone from the list (died): count its remaining HP as the killing blow.
"""

from shared.utils import RollingWindow, now


class DpsTracker:
    def __init__(self, window_seconds: float = 5.0):
        self._window = RollingWindow(window_seconds)
        self._last_hp: dict[int, float] = {}   # monster addr -> last HP seen
        self.total_damage: float = 0.0         # run accumulator
        self.peak_dps: float = 0.0
        self.alive: int = 0                     # mobs alive on the last tick (for kill counting)
        self.kills: int = 0                     # kill count this tick (monsters removed from dict)

    def update(self, monsters, timestamp: float | None = None) -> None:
        """`monsters` = iterable of (addr, current_hp, hp_max) tuples for the live mobs
        (see game.models.live_monsters). Only (addr, hp) matter here; hp_max is ignored."""
        ts = now() if timestamp is None else timestamp

        current: dict[int, float] = {}
        damage = 0.0

        for addr, hp, *_ in monsters:
            if hp is None or hp <= 0:
                continue
            current[addr] = hp
            prev = self._last_hp.get(addr)
            if prev is not None and hp < prev:
                damage += (prev - hp)   # took damage

        # monsters gone since the previous tick = died -> killing blow
        self.kills = 0
        for addr, prev_hp in self._last_hp.items():
            if addr not in current and prev_hp > 0:
                damage += prev_hp
                self.kills += 1

        self._last_hp = current
        self.alive = len(current)
        if damage > 0:
            self._window.add(damage, ts)
            self.total_damage += damage

        dps = self.dps(ts)
        if dps > self.peak_dps:
            self.peak_dps = dps

    def dps(self, timestamp: float | None = None) -> float:
        """Smoothed DPS (damage in the window / window size)."""
        return self._window.rate_per_second(timestamp)

    def reset(self) -> None:
        """Zero out (e.g. on stage change / splitting per run). The meter prefers to instantiate
        a fresh DpsTracker per run, but this covers in-place reuse."""
        self._window.reset()
        self._last_hp.clear()
        self.total_damage = 0.0
        self.peak_dps = 0.0
        self.alive = 0
        self.kills = 0
