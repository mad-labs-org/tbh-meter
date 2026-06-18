"""Regression for the ONE-COMMAND STATIC GATE (scripts/preflight_calib.py).

WHY IT EXISTS: the preflight is the gate that chains ruff + pytest + diff_offsets_vs_dump into a
single command and, at the end, PRINTS the LIVE-layer command (validate_live.py) the operator has to
run — closing the three historical breaks (gold 1.97T/0, party→roster, 1.00.12 fleet stopped), all
from PARTIAL verification. These tests prove the gate's orchestration LOGIC (not the real ruff/pytest
— those are skipped here so we don't recurse):
  1. CLEAN dump   → exit 0 AND prints the validate_live command (the missing live layer);
  2. MISSING dump → exit 1 (refuses to pass green without having diffed — the "no diff = no knowing"
     scenario of 1.00.12), with the command to generate the dump;
  3. dump with the bucket-box INSERTION (drift) → exit 1 (propagates the diff's FAIL).

Reuses the SYNTHETIC dump.cs builder from test_diff_offsets_vs_dump.py (doesn't depend on the real
dump.cs, which lives outside the repo). Completeness vs the real build is the job of the preflight
itself, run from the skill.
"""

import importlib.util
import io
import os
import sys
from contextlib import redirect_stdout

# Reuse the synthetic-dump helpers from the tripwire test (same folder).
_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_DIFF_TEST = _load(os.path.join(_HERE, "test_diff_offsets_vs_dump.py"), "diff_offsets_test_helpers")
_PRE = _load(os.path.normpath(os.path.join(_HERE, "..", "scripts", "preflight_calib.py")), "preflight_calib")


def _run_pre(tmp_path, psd_body=None, dump_path=None):
    """Run preflight.main() with ruff+pytest SKIPPED (the static orchestration is what we test).
    psd_body builds a synthetic dump; or pass dump_path directly (e.g. a non-existent path).

    Points --seed at a NON-EXISTENT path on purpose: the synthetic dump has no class with
    Dictionary<EAggregateType,…>, so a real seed would make the diff fail on the idx_ut gate (which
    test_diff_offsets_vs_dump.py already covers). With no seed, the diff checks offsets/enums (all
    match in _PSD_OK) — isolating the preflight's ORCHESTRATION from the seed gate. Otherwise the
    preflight would use its DEFAULT --seed (the committed config/calib_seed.json) and the test would
    become hostage to the real seed."""
    if dump_path is None:
        dump = tmp_path / "dump.cs"
        dump.write_text(_DIFF_TEST._synth_dump(psd_body), encoding="utf-8")
        dump_path = str(dump)
    argv = ["preflight_calib.py", "--dump", dump_path,
            "--seed", str(tmp_path / "no-seed.json"),  # non-existent on purpose (see docstring)
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
        # Clean static layer (no --seed → diff only checks offsets/enums, all match) → exit 0,
        # AND the MANDATORY next step (validate_live) has to show up printed.
        rc, out = _run_pre(tmp_path, psd_body=_DIFF_TEST._PSD_OK)
        assert rc == 0, out
        assert "validate_live.py" in out
        # Has to make it EXPLICIT that the live layer is still pending (never declare "ready to ship").
        assert "PENDING" in out
        assert "PASS" in out and "diff_offsets" in out

    def test_missing_dump_fails_with_dump_command(self, tmp_path):
        # A missing dump must NOT pass green (1.00.12 scenario: no diff = no knowing) → exit 1,
        # with the command to generate the dump.
        rc, out = _run_pre(tmp_path, dump_path=str(tmp_path / "nao-existe.cs"))
        assert rc == 1, out
        assert "Il2CppDumper" in out
        assert "FAIL" in out and "diff_offsets" in out

    def test_bucketbox_drift_fails(self, tmp_path):
        # The 1.00.12 regression: the diff detects the insertion (WRONG FIELD) → the preflight propagates FAIL.
        rc, out = _run_pre(tmp_path, psd_body=_DIFF_TEST._PSD_SHIFTED)
        assert rc == 1, out
        assert "FAIL" in out and "diff_offsets" in out
        # And the preflight has to tell you NOT to ship / fix the offset (not just fail silently).
        assert "NOT" in out and "GAME_VERSION" in out

    def test_skip_flags_short_circuit_static_layers(self, tmp_path):
        # --skip-ruff/--skip-pytest mark the layers as SKIPPED (not FAIL) — the gate still requires the
        # diff (not skipped here) and, clean, passes. Ensures the skips don't turn into a false FAIL.
        rc, out = _run_pre(tmp_path, psd_body=_DIFF_TEST._PSD_OK)
        assert rc == 0, out
        assert "SKIPPED" in out  # ruff/pytest reported as skipped, not as a failure
