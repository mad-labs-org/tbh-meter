"""Kills/min and stage state.

Kills: the dead list (MonsterSpawnManager.dead_count) only grows; the diff
between ticks is how many died. Accumulate over a 60s window -> kills in the last min.
"""

from shared.utils import RollingWindow, now


class ProgressTracker:
    def __init__(self):
        self._kills_window = RollingWindow(window_seconds=60.0)
        self._last_dead: int | None = None
        self.total_kills: int = 0

    def update(self, dead_count: int, timestamp: float | None = None) -> None:
        ts = now() if timestamp is None else timestamp
        if dead_count is None:
            return
        if self._last_dead is not None:
            delta = dead_count - self._last_dead
            if delta > 0:                 # new kills
                self._kills_window.add(delta, ts)
                self.total_kills += delta
            # delta < 0 = list reset (stage change); ignore the jump
        self._last_dead = dead_count

    def kills_per_minute(self, timestamp: float | None = None) -> float:
        # 60s window: the window total IS "kills in the last minute"
        return self._kills_window.total(timestamp)
