"""Kills/min e estado do stage.

Kills: a lista de mortos (MonsterSpawnManager.dead_count) só cresce; a diferença
entre ticks é quantos morreram. Acumulo numa janela de 60s -> kills no último min.
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
            if delta > 0:                 # mortes novas
                self._kills_window.add(delta, ts)
                self.total_kills += delta
            # delta < 0 = lista resetou (troca de stage); ignora o salto
        self._last_dead = dead_count

    def kills_per_minute(self, timestamp: float | None = None) -> float:
        # janela de 60s: o total na janela já É "kills no último minuto"
        return self._kills_window.total(timestamp)
