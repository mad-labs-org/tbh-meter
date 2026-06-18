"""Testes para metrics/xp.py.

per_hero_gain — ganho de XP de um herói entre dois snapshots (trata level-up + cap).
xp_through_levelup — soma XP atravessando um ou mais níveis pela curva (clampa no cap).
level_capped — nível sem entrada na curva = cap (sem progressão definida).
PartyXpAccumulator — acumulador VIVO por-herói (tick-a-tick), o LIVE primário da run.
"""

import pytest

import metrics.xp as xp_mod
from metrics.xp import PartyXpAccumulator, level_capped, per_hero_gain, xp_through_levelup


# ---------------------------------------------------------------------------
# per_hero_gain — lógica de delta (sem ou com level-up)
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
        """Sem info de nível mas com exp presente → retorna o delta (nenhum level-up detectado).
        per_hero_gain só retorna None quando os valores de XP são None."""
        gain, leveled = per_hero_gain(None, 10.0, None, 20.0)
        assert gain == pytest.approx(10.0)
        assert leveled is False

    def test_both_levels_and_exp_none_returns_none(self):
        """Quando os valores de XP são None → não há como calcular o ganho."""
        gain, leveled = per_hero_gain(None, None, None, None)
        assert gain is None
        assert leveled is False

    def test_level_up_detected(self, fake_curve):
        """Level 1→2: ganhou (30 - exp0) + exp1 = (30 - 10) + 5 = 25."""
        gain, leveled = per_hero_gain(1, 10.0, 2, 5.0)
        assert leveled is True
        assert gain == pytest.approx(25.0)

    def test_multi_level_up(self, fake_curve):
        """Level 1→3: (30-10) + 150 + 20 = 190."""
        gain, leveled = per_hero_gain(1, 10.0, 3, 20.0)
        assert leveled is True
        assert gain == pytest.approx(190.0)

    @pytest.mark.parametrize("lv0,exp0,lv1,exp1,expected", [
        (1, 0.0, 1, 30.0, 30.0),   # nível 1, ganhou exatamente o máximo do nível
        (2, 100.0, 2, 100.0, 0.0),  # sem ganho
        (1, 29.0, 1, 0.0, -29.0),   # queda de exp (improvável mas não crashar)
    ])
    def test_same_level_cases(self, fake_curve, lv0, exp0, lv1, exp1, expected):
        gain, _ = per_hero_gain(lv0, exp0, lv1, exp1)
        assert gain == pytest.approx(expected)

    def test_same_level_at_cap_returns_zero_not_none(self, real_curve):
        """Herói NO cap (101): same-level devolve 0.0 — ganho zero VÁLIDO, nunca None
        (None significaria não-li e cairia no fallback do save, que tem o MESMO buraco
        fantasma). EXP_FAKE sobe no cap sem level-up pra consumir = delta fantasma."""
        gain, leveled = per_hero_gain(101, 3.0e9, 101, 3.0e9 + 41_000.0)
        assert gain == 0.0
        assert leveled is False


# ---------------------------------------------------------------------------
# level_capped — nível sem entrada na curva = cap (sem progressão definida)
# ---------------------------------------------------------------------------

class TestLevelCapped:
    def test_cap_101_true_with_real_curve(self, real_curve):
        """Curva real cobre 1..100 → 101 não tem progressão definida = cap."""
        assert 101 not in real_curve
        assert level_capped(101) is True

    def test_100_false_with_real_curve(self, real_curve):
        """100 tem entrada na curva (ainda sobe pra 101) → não é cap."""
        assert 100 in real_curve
        assert level_capped(100) is False

    def test_none_false(self):
        """Sem info de nível → False (mantém o delta cru; não consulta a curva)."""
        assert level_capped(None) is False

    def test_curve_unavailable_degrades_to_false(self, monkeypatch):
        """Curva indisponível (bundle quebrado): False = trata como não-capado (delta
        cru, comportamento pré-fix) em vez de matar o reader no close_run — o update()
        engoliria o erro todo tick (falha invisível) e a comprehension do xp_by_hero
        levantaria sem guarda. O CI --selftest gateia o bundle quebrado antes do ship."""
        def _boom():
            raise OSError("level_curve.json indisponível")
        monkeypatch.setattr(xp_mod, "curve", _boom)
        assert level_capped(101) is False
        gain, leveled = per_hero_gain(101, 1000.0, 101, 1500.0)   # same-level cai no delta cru
        assert gain == pytest.approx(500.0)
        assert leveled is False


# ---------------------------------------------------------------------------
# xp_through_levelup — soma pela curva (requer fake_curve via fixture)
# ---------------------------------------------------------------------------

class TestXpThroughLevelup:
    def test_single_levelup(self, fake_curve):
        """Level 1→2: (curva[1] - exp0) + exp1 = (30 - 10) + 50 = 70."""
        result = xp_through_levelup(1, 10.0, 2, 50.0)
        assert result == pytest.approx(70.0)

    def test_levelup_from_zero(self, fake_curve):
        """Level 1→2 saindo do zero: 30 + 80 = 110."""
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
        """Nível fora da curva → None (não chutar)."""
        result = xp_through_levelup(99, 0.0, 100, 0.0)
        assert result is None

    def test_negative_result_returns_none(self, fake_curve):
        """exp0 > curva[lv0] (corrompido) → total negativo → None."""
        result = xp_through_levelup(1, 9999.0, 2, 0.0)
        assert result is None

    def test_none_exp_returns_none(self, fake_curve):
        result = xp_through_levelup(1, None, 2, 0.0)
        assert result is None

    def test_crossing_into_cap_clamps_at_threshold(self, real_curve):
        """Cruzar PRA DENTRO do cap (lv1 sem entrada na curva) banka só até o limiar:
        o exp1 pós-cap é fantasma e não conta — (curva[100]-exp0) + 0."""
        c = real_curve
        result = xp_through_levelup(100, float(c[100] - 50), 101, 20.0)
        assert result == pytest.approx(50.0)

    def test_real_curve_loads(self):
        """Integração: a curva real (level_curve.json) deve carregar sem erro."""
        xp_mod._CURVE = None  # força reload
        c = xp_mod.curve()
        assert isinstance(c, dict)
        assert len(c) > 0
        assert all(isinstance(k, int) and isinstance(v, int) for k, v in c.items())


# ---------------------------------------------------------------------------
# PartyXpAccumulator — o LIVE primário: integra incrementos por-herói tick-a-tick
# (substitui o delta de endpoints, que dava +0 a herói fora do baseline t=0)
# ---------------------------------------------------------------------------

class TestPartyXpAccumulator:
    def test_unseen_hero_record_and_gain_are_none(self):
        """Nunca visto -> None (não 0): o caller decide o fallback (save), nunca +0 mudo."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        assert acc.record(999) is None
        assert acc.gain(999) is None

    def test_total_none_when_nobody_ever_seen(self):
        """Fonte viva OFF a run inteira -> total() None -> xp_source degrada pro save.
        None-de-leitura nunca vira 0-de-ganho (a regra do gold:0)."""
        acc = PartyXpAccumulator()
        acc.update({})
        acc.update(None)
        assert acc.total() is None

    def test_first_sight_seeds_baseline_with_zero_gain(self):
        """1º avistamento = baseline (acc=0, exp_start=exp). Zero é ganho VÁLIDO != None."""
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
        """O FIX do +0: herói fora do baseline t=0 (deploy tardio / morto da run anterior
        que revive no meio) é creditado do 1º avistamento em diante (antes: gain=None -> +0)."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})                       # t=0: só o 601
        acc.update({601: (10, 200.0), 702: (33, 1000.0)})    # 702 entra no tick 2
        acc.update({601: (10, 300.0), 702: (33, 5000.0)})
        assert acc.gain(702) == pytest.approx(4000.0)
        assert acc.record(702)["exp_start"] == pytest.approx(1000.0)
        assert acc.total() == pytest.approx(200.0 + 4000.0)

    def test_levelup_bridged_by_curve_across_tick(self, fake_curve):
        """1→2 entre dois ticks: (curva[1]-exp0)+exp1 = (30-10)+5 = 25; levelup STICKY."""
        acc = PartyXpAccumulator()
        acc.update({601: (1, 10.0)})
        acc.update({601: (2, 5.0)})
        assert acc.gain(601) == pytest.approx(25.0)
        acc.update({601: (2, 7.0)})                          # tick seguinte sem level-up
        rec = acc.record(601)
        assert rec["levelup"] is True                        # sticky, não some no tick seguinte
        assert rec["gain"] == pytest.approx(27.0)

    def test_multi_levelup_bridged_in_one_tick(self, fake_curve):
        """1→3 num tick só: (30-10) + 150 + 20 = 190 (níveis intermediários cheios)."""
        acc = PartyXpAccumulator()
        acc.update({601: (1, 10.0)})
        acc.update({601: (3, 20.0)})
        assert acc.gain(601) == pytest.approx(190.0)

    def test_cap_edge_100_to_101_uses_real_curve(self, real_curve):
        """Borda do cap: 100→101 usa curve[100] (existe) e CLAMPA no limiar — o exp1
        pós-cap (20) é fantasma e não conta; levelup continua True. Tick seguinte JÁ no
        cap com exp subindo → ganho não anda mais."""
        c = real_curve                                       # curva REAL (1..100); restaurada no teardown
        assert 100 in c and 101 not in c
        acc = PartyXpAccumulator()
        acc.update({601: (100, float(c[100] - 50))})
        acc.update({601: (101, 20.0)})
        assert acc.gain(601) == pytest.approx(50.0)          # só até o limiar; os 20 pós-cap não
        assert acc.record(601)["levelup"] is True
        acc.update({601: (101, 90_000.0)})                   # no cap: exp sobe = fantasma
        assert acc.gain(601) == pytest.approx(50.0)

    def test_hero_at_cap_101_banks_zero(self, real_curve):
        """Herói JÁ no cap (101, sem chave na curva = sem progressão definida) com
        EXP_FAKE subindo: o jogo segue incrementando sem level-up pra consumir → delta
        é XP FANTASMA. Banka 0.0 (ganho zero VÁLIDO, record não-None) e o baseline
        avança: exp_start/exp_end seguem a observação CRUA — só o ganho é suprimido."""
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
        assert rec["exp_end"] == pytest.approx(2500.0)       # observação crua continua andando

    def test_solo_capped_hero_total_zero_not_none(self, real_curve):
        """REGRESSÃO (produção, meter v0.31.0 / game v1.00.11, player denny8126): runs
        SOLO com só uma Ranger lv101 (cap) subiram ~39M de xpGained CADA (ex.: run
        76271dba, 3-9 Torment, 177s) — herói no cap jogando sozinho TEM que ganhar 0.
        total() == 0.0 (visto a run inteira → fonte VIVA, xp_source 'live'), NUNCA None
        (None cairia em silêncio no fallback do save, que tem o mesmo delta fantasma)."""
        acc = PartyXpAccumulator()
        e0, total, ticks = 3.0e9, 39_354_368.0, 177          # EXP_FAKE cru acumulado no cap
        for t in range(ticks + 1):
            acc.update({201: (101, e0 + total * t / ticks)})
        rec = acc.record(201)
        assert rec is not None
        assert rec["gain"] == pytest.approx(0.0)
        assert acc.total() is not None                       # fonte viva ON: nada de save fallback
        assert acc.total() == pytest.approx(0.0)

    def test_party_with_capped_hero_counts_only_uncapped(self, real_curve):
        """REGRESSÃO (produção, run 1dff787d, 3-2 Torment, 223s): party Knight 81 /
        Ranger 101 (cap) / Sorcerer 83 subiu meta.xpGained=45,405,600 creditando 9.16M
        (20%) à Ranger capada. Só os não-capados contam: 18.76M + 17.48M = 36.24M."""
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
        assert acc.total() == pytest.approx(36_240_000.0)               # soma só dos não-capados

    def test_dead_time_banks_gain_and_adds_zero_while_absent(self):
        """Morto sai do HeroList -> ticks ausentes não somam NEM perdem o banked; no revive
        a exp retoma de onde parou (sem rise enquanto morto) e segue sem double-count."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        acc.update({601: (10, 500.0)})                       # vivo: +400
        acc.update({})                                       # morto (ausente do snapshot)
        acc.update({})
        assert acc.gain(601) == pytest.approx(400.0)         # banked, não perdeu
        acc.update({601: (10, 500.0)})                       # reviveu: exp parada = +0
        assert acc.gain(601) == pytest.approx(400.0)         # sem double-count
        acc.update({601: (10, 650.0)})
        assert acc.gain(601) == pytest.approx(550.0)

    def test_exp_pause_adds_zero(self):
        """Exp parada (presente mas sem rise, ex.: idle no boss) -> +0 por tick, sem ruído."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        for _ in range(3):
            acc.update({601: (10, 100.0)})
        acc.update({601: (10, 130.0)})
        assert acc.gain(601) == pytest.approx(30.0)

    def test_dropout_keeps_accumulated_value(self):
        """Herói visto e depois sumido dos ticks restantes (incl. o final): mantém o
        acumulado — record nunca degrada pra None/0."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0), 702: (20, 0.0)})
        acc.update({601: (10, 900.0), 702: (20, 50.0)})
        acc.update({702: (20, 80.0)})                        # 601 sumiu e não volta
        rec = acc.record(601)
        assert rec is not None
        assert rec["gain"] == pytest.approx(800.0)
        assert rec["exp_end"] == pytest.approx(900.0)
        assert acc.total() == pytest.approx(800.0 + 80.0)

    def test_same_level_dip_skipped_and_recovery_not_double_counted(self):
        """Dip same-level (leitura suja; o within-level real é monotônico): não soma, não
        avança o baseline — a recuperação telescopa (105-100=5), nunca 65 nem negativo."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 100.0)})
        acc.update({601: (10, 40.0)})                        # dip (lixo)
        assert acc.gain(601) == pytest.approx(0.0)
        acc.update({601: (10, 105.0)})                       # recupera
        assert acc.gain(601) == pytest.approx(5.0)

    def test_level_regression_skipped_no_phantom_gain(self):
        """Nível NUNCA cai mid-run: uma leitura com lv menor (slot sujo) é PULADA — não soma
        ganho fantasma nem envenena o baseline; a recuperação no nível certo telescopa."""
        acc = PartyXpAccumulator()
        acc.update({601: (10, 1000.0)})
        acc.update({601: (3, 50.0)})                         # regressão de nível (lixo)
        assert acc.gain(601) == pytest.approx(0.0)           # sem ganho fantasma
        acc.update({601: (10, 1200.0)})                      # volta ao nível real
        assert acc.gain(601) == pytest.approx(200.0)         # baseline preservado (1200-1000)

    def test_garbage_entries_ignored_never_raises(self):
        """Entrada lixo é ignorada sem exceção (contrato never-raise do read_live_party)."""
        acc = PartyXpAccumulator()
        acc.update(None)
        acc.update({601: None, 702: (None, 50.0), 803: (10, None),
                    904: "x", 905: (1, 2, 3)})
        assert acc.total() is None                           # nada válido visto ainda
        acc.update({601: (10, 100.0)})
        assert acc.total() == pytest.approx(0.0)
