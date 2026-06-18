"""Testes para metrics/dps.py — DpsTracker.

O tracker mede dano pela QUEDA DE HP dos monstros. Casos cobertos:
  - monstro novo não conta dano
  - queda de HP conta dano
  - subida de HP (cura / addr reaproveitado) é ignorada
  - monstro sumido = golpe final (HP restante)
  - janela deslizante expira samples antigos
  - total_damage acumula corretamente
  - alive conta mobs vivos no tick
  - reset limpa tudo
"""

import pytest

from metrics.dps import DpsTracker

# Helpers de conveniência
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
        """Cura ou endereço reaproveitado não deve contar como dano."""
        t = DpsTracker()
        t.update([mob(1, 50.0)], timestamp=0.0)
        t.update([mob(1, 80.0)], timestamp=0.1)  # HP subiu — ignorar
        assert t.total_damage == 0.0

    def test_monster_death_adds_remaining_hp(self):
        """Mob sumiu da lista com 30 HP restante → 30 de dano (golpe final)."""
        t = DpsTracker()
        t.update([mob(1, 30.0)], timestamp=0.0)
        t.update([], timestamp=0.1)              # mob morreu
        assert t.total_damage == pytest.approx(30.0)

    def test_multiple_monsters_sum_damage(self):
        t = DpsTracker()
        t.update([mob(1, 100.0), mob(2, 200.0)], timestamp=0.0)
        t.update([mob(1, 70.0), mob(2, 150.0)], timestamp=0.1)
        assert t.total_damage == pytest.approx(80.0)

    def test_zero_hp_monsters_ignored(self):
        """Monstro com HP=0 não entra no tracking (já está morto no pool)."""
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
        t.update([mob(1, 90.0)], timestamp=0.1)  # mob 2 morreu
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
        t.update([mob(1, 50.0)], timestamp=1.0)  # 50 de dano
        # dps = 50 / 5 = 10/s
        assert t.dps(1.0) == pytest.approx(10.0)

    def test_old_damage_expires_from_window(self):
        window = 2.0
        t = DpsTracker(window_seconds=window)
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 50.0)], timestamp=0.5)  # 50 dano em t=0.5
        # Em t=3.0 a amostra expirou (0.5 < 3.0 - 2.0)
        assert t.dps(3.0) == pytest.approx(0.0)

    def test_total_damage_not_affected_by_window_expiry(self):
        """total_damage é cumulativo da run; não cai quando a janela expira."""
        t = DpsTracker(window_seconds=1.0)
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 50.0)], timestamp=0.5)   # 50 dano
        _ = t.dps(10.0)                             # janela expirou
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
        # Após reset, nenhum monstro é conhecido; próximo tick registra como novo
        t.update([mob(1, 100.0)], timestamp=0.1)
        assert t.total_damage == 0.0  # novo monstro, sem dano

    def test_reset_clears_peak(self):
        t = DpsTracker()
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 0.0)], timestamp=0.1)
        assert t.peak_dps > 0.0
        t.reset()
        assert t.peak_dps == 0.0


class TestDpsTrackerPeak:
    def test_peak_not_overwritten_by_lower_dps(self):
        """Peak DPS deve ficar EXATAMENTE no máximo histórico.

        Fluxo: spike de 100 dano (DPS=50/s), depois round mais fraco de 10 dano
        (DPS=5/s). O peak deve ficar em 50 — nem cair (reset), nem subir (cálculo errado).
        Usar == em vez de >= para flagrar qualquer desvio nos dois sentidos.
        """
        window = 2.0
        t = DpsTracker(window_seconds=window)
        # Round 1: mob spawn + morte imediata → 100 dano, DPS = 100/2 = 50/s
        t.update([mob(1, 100.0)], timestamp=0.0)
        t.update([mob(1, 0.0)], timestamp=0.0)   # hp=0 → skipped in current; prev_hp=100 → golpe final
        peak_after_spike = t.peak_dps
        assert peak_after_spike == pytest.approx(50.0)   # sanidade: spike registrado

        # Round 2: janela antiga expirada (t=5 > window=2), só 10 dano → DPS = 5/s
        t.update([mob(2, 10.0)], timestamp=5.0)
        t.update([mob(2, 0.0)], timestamp=5.0)
        # peak não deve mudar: 5/s < 50/s
        assert t.peak_dps == pytest.approx(peak_after_spike)
