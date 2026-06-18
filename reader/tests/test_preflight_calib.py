"""Regressão do GATE ESTÁTICO de um comando (scripts/preflight_calib.py).

POR QUÊ existe: o preflight é o gate que encadeia ruff + pytest + diff_offsets_vs_dump num único
comando e, no fim, IMPRIME o comando da camada AO VIVO (validate_live.py) que o operador tem que
rodar — fechando os três breaks históricos (gold 1.97T/0, party→roster, 1.00.12 frota parada),
todos por verificação PARCIAL. Estes testes provam a LÓGICA de orquestração do gate (não o ruff/
pytest reais — esses são pulados aqui pra não recursar):
  1. dump LIMPO  → exit 0 E imprime o comando do validate_live (a camada ao vivo que falta);
  2. dump AUSENTE → exit 1 (recusa passar verde sem ter diffado — o cenário "não diffar = não saber"
     do 1.00.12), com o comando de gerar o dump;
  3. dump com a INSERÇÃO do bucket-box (drift) → exit 1 (propaga o FAIL do diff).

Reusa o builder de dump.cs SINTÉTICO de test_diff_offsets_vs_dump.py (não depende do dump.cs real,
que vive fora do repo). A completude vs. o build real é trabalho do próprio preflight rodado na skill.
"""

import importlib.util
import io
import os
import sys
from contextlib import redirect_stdout

# Reusa os helpers de dump sintético do teste do tripwire (mesma pasta).
_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_DIFF_TEST = _load(os.path.join(_HERE, "test_diff_offsets_vs_dump.py"), "diff_offsets_test_helpers")
_PRE = _load(os.path.normpath(os.path.join(_HERE, "..", "scripts", "preflight_calib.py")), "preflight_calib")


def _run_pre(tmp_path, psd_body=None, dump_path=None):
    """Roda preflight.main() com ruff+pytest PULADOS (a orquestração estática é o que testamos).
    psd_body monta um dump sintético; ou passe dump_path direto (ex.: um caminho inexistente).

    Aponta --seed p/ um caminho INEXISTENTE de propósito: o dump sintético não tem nenhuma classe
    com Dictionary<EAggregateType,…>, então um seed real faria o diff falhar pelo gate de idx_ut
    (que test_diff_offsets_vs_dump.py já cobre). Sem seed, o diff confere offsets/enums (todos batem
    no _PSD_OK) — isolando a ORQUESTRAÇÃO do preflight do gate de seed. Senão o preflight usaria seu
    --seed DEFAULT (o config/calib_seed.json commitado) e o teste viraria refém do seed real."""
    if dump_path is None:
        dump = tmp_path / "dump.cs"
        dump.write_text(_DIFF_TEST._synth_dump(psd_body), encoding="utf-8")
        dump_path = str(dump)
    argv = ["preflight_calib.py", "--dump", dump_path,
            "--seed", str(tmp_path / "no-seed.json"),  # inexistente de propósito (ver docstring)
            "--skip-ruff", "--skip-pytest"]
    old = sys.argv
    sys.argv = argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = _PRE.main()
    finally:
        sys.argv = old
    return rc, buf.getvalue()


class TestPreflightOrchestration:
    def test_clean_dump_passes_and_prints_live_gate(self, tmp_path):
        # Camada estática limpa (sem --seed → diff só confere offsets/enums, todos batem) → exit 0,
        # E o passo seguinte OBRIGATÓRIO (validate_live) tem que aparecer impresso.
        rc, out = _run_pre(tmp_path, psd_body=_DIFF_TEST._PSD_OK)
        assert rc == 0, out
        assert "validate_live.py" in out
        # Tem que deixar EXPLÍCITO que ainda falta a camada ao vivo (nunca declarar "pronto pra shipar").
        assert "AO VIVO" in out
        assert "PASS" in out and "diff_offsets" in out

    def test_missing_dump_fails_with_dump_command(self, tmp_path):
        # Dump ausente NÃO pode passar verde (cenário 1.00.12: não diffar = não saber) → exit 1,
        # com o comando de gerar o dump.
        rc, out = _run_pre(tmp_path, dump_path=str(tmp_path / "nao-existe.cs"))
        assert rc == 1, out
        assert "Il2CppDumper" in out
        assert "FAIL" in out and "diff_offsets" in out

    def test_bucketbox_drift_fails(self, tmp_path):
        # A regressão do 1.00.12: o diff detecta a inserção (CAMPO ERRADO) → o preflight propaga FAIL.
        rc, out = _run_pre(tmp_path, psd_body=_DIFF_TEST._PSD_SHIFTED)
        assert rc == 1, out
        assert "FAIL" in out and "diff_offsets" in out
        # E o preflight tem que mandar NÃO shipar / consertar o offset (não só falhar mudo).
        assert "NÃO" in out and "GAME_VERSION" in out

    def test_skip_flags_short_circuit_static_layers(self, tmp_path):
        # --skip-ruff/--skip-pytest marcam as camadas como PULADAS (não FAIL) — o gate ainda exige o
        # diff (não pulado aqui) e, limpo, passa. Garante que os skips não viram um falso-FAIL.
        rc, out = _run_pre(tmp_path, psd_body=_DIFF_TEST._PSD_OK)
        assert rc == 0, out
        assert "PULADO" in out  # ruff/pytest reportados como pulados, não como falha
