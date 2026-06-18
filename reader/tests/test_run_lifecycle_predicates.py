"""Predicados puros do ciclo de vida da run (extraídos de close_run p/ serem testáveis).
Guardam docs/invariants/run-lifecycle. As regras aqui são a VERDADE; a nota cita estes
testes em `guarded_by` — se a regra mudar, o teste quebra no lugar certo."""
from meter_windows import _box_belongs_to_pending, _is_partial, _should_skip_run


class TestShouldSkipRun:
    def test_run_under_30s_is_skipped(self):
        assert _should_skip_run(measured=10, clear_time=0, stage=5) is True

    def test_run_over_30s_is_kept(self):
        assert _should_skip_run(measured=45, clear_time=40, stage=5) is False

    def test_stage_x10_under_30s_is_kept(self):
        # x-10 é luta só de boss: pode durar segundos e ainda contar. stage == 10 (StageNo).
        assert _should_skip_run(measured=8, clear_time=0, stage=10) is False

    def test_long_clear_time_keeps_short_measured(self):
        # max(measured, clear_time) >= 30 -> mantém, mesmo medindo pouco.
        assert _should_skip_run(measured=5, clear_time=40, stage=5) is False

    def test_clear_time_none_treated_as_zero(self):
        assert _should_skip_run(measured=10, clear_time=None, stage=5) is True


class TestIsPartial:
    def test_failure_is_never_partial(self):
        assert _is_partial("failed", clear_time=100, measured=50, total_damage=5000) is False

    def test_full_clear_with_damage_is_not_partial(self):
        assert _is_partial("success", clear_time=100, measured=95, total_damage=5000) is False

    def test_entered_late_is_partial(self):
        # measured < 80% do clear oficial (e clear >= 30) -> entrou no meio -> parcial.
        assert _is_partial("success", clear_time=100, measured=50, total_damage=5000) is True

    def test_short_clear_with_damage_is_not_partial(self):
        # clear < 30 (x-10) desliga a 1ª cláusula; com dano > 0 não é parcial.
        assert _is_partial("success", clear_time=10, measured=3, total_damage=5000) is False

    def test_zero_damage_success_is_always_partial(self):
        # dano medido <= 0 num success = captura perdida, mesmo com clear curto (#163).
        assert _is_partial("success", clear_time=10, measured=3, total_damage=0) is True


class TestBoxBelongsToPending:
    """Roteamento do GetBoxLog (o bug do baú-na-run-seguinte, provado ao vivo no 1.00.11):
    o jogo emite o boss box (mt=1 StageBoss / mt=2 ActBoss) ~0.6s DEPOIS do StageClearLog,
    quando o close já resetou R — com um success PENDENTE, o baú pertence à run que fechou.
    Gray (mt=0) dropa de mob no MEIO da stage → sempre run atual."""

    def test_boss_box_with_pending_goes_to_pending(self):
        assert _box_belongs_to_pending(1, has_pending=True) is True    # StageBoss (blue)
        assert _box_belongs_to_pending(2, has_pending=True) is True    # ActBoss

    def test_gray_box_never_goes_to_pending(self):
        # mob box dropa durante a stage: mesmo com um success pendente, é da run ATUAL.
        assert _box_belongs_to_pending(0, has_pending=True) is False

    def test_boss_box_without_pending_falls_back_to_current(self):
        # reader anexou logo após um clear (sem pendente): cai na run atual (+ WARN no log),
        # nunca descarta um baú real.
        assert _box_belongs_to_pending(1, has_pending=False) is False
        assert _box_belongs_to_pending(2, has_pending=False) is False

    def test_unknown_or_unread_tier_goes_to_current(self):
        # mt fora do enum (lixo) ou None (leitura falhou) nunca roteia pro pendente.
        assert _box_belongs_to_pending(3, has_pending=True) is False
        assert _box_belongs_to_pending(None, has_pending=True) is False
