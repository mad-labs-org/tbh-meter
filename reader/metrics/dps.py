"""DPS medido pela QUEDA DE HP dos monstros — o número-mãe do meter.

Ideia: a cada tick, leio o HP de cada monstro vivo. O quanto o HP caiu desde o
tick anterior É o dano causado. Somo isso numa janela deslizante -> DPS.

Casos tratados:
  - monstro novo (não visto antes): registra, não conta dano.
  - HP subiu (cura, ou endereço reaproveitado do pool por um monstro novo):
    ignora, não conta como dano.
  - monstro sumiu da lista (morreu): conta o HP que restava como o golpe final.
"""

from shared.utils import RollingWindow, now


class DpsTracker:
    def __init__(self, window_seconds: float = 5.0):
        self._window = RollingWindow(window_seconds)
        self._last_hp: dict[int, float] = {}   # addr do monstro -> último HP visto
        self.total_damage: float = 0.0         # acumulado da run
        self.peak_dps: float = 0.0
        self.alive: int = 0                     # mobs vivos no último tick (p/ contagem de kills)

    def update(self, monsters, timestamp: float | None = None) -> None:
        """`monsters` = iterável das tuplas (addr, hp_atual, hp_max) dos mobs vivos
        (ver game.models.live_monsters). Só (addr, hp) importam aqui; hp_max é ignorado."""
        ts = now() if timestamp is None else timestamp

        current: dict[int, float] = {}
        damage = 0.0

        for addr, hp, *_ in monsters:
            if hp is None or hp <= 0:
                continue
            current[addr] = hp
            prev = self._last_hp.get(addr)
            if prev is not None and hp < prev:
                damage += (prev - hp)   # tomou dano

        # monstros que sumiram desde o tick anterior = morreram -> golpe final
        for addr, prev_hp in self._last_hp.items():
            if addr not in current and prev_hp > 0:
                damage += prev_hp

        self._last_hp = current
        self.alive = len(current)
        if damage > 0:
            self._window.add(damage, ts)
            self.total_damage += damage

        dps = self.dps(ts)
        if dps > self.peak_dps:
            self.peak_dps = dps

    def dps(self, timestamp: float | None = None) -> float:
        """DPS suavizado (dano na janela / tamanho da janela)."""
        return self._window.rate_per_second(timestamp)

    def reset(self) -> None:
        """Zera (ex.: ao trocar de stage / separar por run). O meter prefere instanciar
        um DpsTracker novo por run, mas isto cobre o reuso in-place."""
        self._window.reset()
        self._last_hp.clear()
        self.total_damage = 0.0
        self.peak_dps = 0.0
        self.alive = 0
