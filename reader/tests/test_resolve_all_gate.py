"""Testes do GATE de resolve_all (deliverable 05/01) — caminho rápido (calib/RVA) vs lento
(scan) + calibração. Funções de orquestração: a leitura de memória real mora em
typeinfo/resolver/gold (cobertos pelos próprios testes + probes ao vivo), então aqui
monkeypatchamos os delegates p/ exercitar SÓ a decisão do gate. Rodam no mac.

Cobre:
  - fast path OK → tupla de 14 do calib, ZERO scan;
  - fast path sanity-fail (_resolve_fast None) → cai pro scan;
  - sem ga_base/fp → pula direto pro scan;
  - slow path → scan + calibra (só com scan completo);
  - calibração falha (anchor/idx None) → EMITE log observável, NUNCA quebra;
  - _resolve_fast monta a tupla certa (shape de 14, PSD/CSD/SM do backref direcionado, MSM/LM do rv).
"""

import meter_windows as mw

FP = "1.00.07-0x6a203f51-0x62ea000"
CALIB = {"anchor_rva": 0x5B070E0,
         "indices": {"StageClearLog": 2838, "StageManager": 2592},
         "idx_ut": 2744,
         "stage_info": {1001: (1, 1, 50, 0)},
         "item_cat": {30001: (3, 2, 5)},
         "hero_cat": {601: 1}}

# tupla de 14 sentinela (shape do cache) — o que o scan/fast path devolvem
SCAN_TUP = ("sc", "sf", "msm", "lm", ["csd"], ["psd"], {1: (1, 1, 1, 0)},
            {2: (1, 1, 1)}, {3: 1}, ["sm"], "gold", "gb", "die", "res")
FAST_TUP = ("scF", "sfF", "msmF", "lmF", ["csdF"], ["psdF"], CALIB["stage_info"],
            CALIB["item_cat"], CALIB["hero_cat"], ["smF"], "goldF", "gbF", "dieF", "resF")


def _patch_ga(monkeypatch, base=0x7ff800000000):
    monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (base, 0x62ea000))


class TestFastPath:
    def test_calib_hit_returns_fast_tuple_no_scan(self, monkeypatch, tmp_path):
        _patch_ga(monkeypatch)
        monkeypatch.setattr(mw, "load_calib", lambda path, fp: CALIB)
        monkeypatch.setattr(mw, "_resolve_fast", lambda reader, ga, calib: FAST_TUP)
        called = {"scan": False}
        def _no_scan(reader):
            called["scan"] = True
            return SCAN_TUP, {}
        monkeypatch.setattr(mw, "_resolve_scan", _no_scan)
        out = mw.resolve_all(None, 123, FP, str(tmp_path / "c.json"))
        assert out == FAST_TUP
        assert called["scan"] is False         # fast path NÃO roda scan
        assert len(out) == 14

    def test_fast_sanity_fail_falls_back_to_scan(self, monkeypatch, tmp_path):
        _patch_ga(monkeypatch)
        monkeypatch.setattr(mw, "load_calib", lambda path, fp: CALIB)
        monkeypatch.setattr(mw, "_resolve_fast", lambda reader, ga, calib: None)  # sanity-fail
        monkeypatch.setattr(mw, "_resolve_scan", lambda reader: (SCAN_TUP, {}))
        monkeypatch.setattr(mw, "_calibrate", lambda *a, **k: None)
        out = mw.resolve_all(None, 123, FP, str(tmp_path / "c.json"))
        assert out == SCAN_TUP                 # degradou pro scan, NÃO usou calib ruim

    def test_no_ga_base_skips_fast_path(self, monkeypatch, tmp_path):
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (None, None))
        seen = {"load_calib": False}
        def _lc(path, fp):
            seen["load_calib"] = True
            return CALIB
        monkeypatch.setattr(mw, "load_calib", _lc)
        monkeypatch.setattr(mw, "_resolve_scan", lambda reader: (SCAN_TUP, {}))
        monkeypatch.setattr(mw, "_calibrate", lambda *a, **k: None)
        out = mw.resolve_all(None, 123, FP, str(tmp_path / "c.json"))
        assert out == SCAN_TUP
        assert seen["load_calib"] is False     # sem ga_base nem tenta o calib

    def test_no_calib_goes_to_scan(self, monkeypatch, tmp_path):
        _patch_ga(monkeypatch)
        monkeypatch.setattr(mw, "load_calib", lambda path, fp: None)  # build novo
        monkeypatch.setattr(mw, "_resolve_scan", lambda reader: (SCAN_TUP, {}))
        monkeypatch.setattr(mw, "_calibrate", lambda *a, **k: None)
        out = mw.resolve_all(None, 123, FP, str(tmp_path / "c.json"))
        assert out == SCAN_TUP


class TestSlowPathCalibration:
    def test_complete_scan_triggers_calibrate(self, monkeypatch, tmp_path):
        _patch_ga(monkeypatch)
        monkeypatch.setattr(mw, "load_calib", lambda path, fp: None)
        monkeypatch.setattr(mw, "_resolve_scan", lambda reader: (SCAN_TUP, {"StageClearLog": {0x1}}))
        calibrated = {"hit": False}
        def _cal(reader, pid, fp, cache_path, classes, si, ic, hc, gk):
            calibrated["hit"] = True
        monkeypatch.setattr(mw, "_calibrate", _cal)
        mw.resolve_all(None, 123, FP, str(tmp_path / "c.json"))
        assert calibrated["hit"] is True

    def test_incomplete_scan_skips_calibrate(self, monkeypatch, tmp_path):
        _patch_ga(monkeypatch)
        monkeypatch.setattr(mw, "load_calib", lambda path, fp: None)
        # scan incompleto: msm=None (falta um manager) → NÃO calibra (persist-gate)
        bad = (None, "sf", None, "lm", [], [], {}, {}, {}, [], None, None, None, None)
        monkeypatch.setattr(mw, "_resolve_scan", lambda reader: (bad, {}))
        calibrated = {"hit": False}
        monkeypatch.setattr(mw, "_calibrate",
                            lambda *a, **k: calibrated.__setitem__("hit", True))
        out = mw.resolve_all(None, 123, FP, str(tmp_path / "c.json"))
        assert out == bad
        assert calibrated["hit"] is False


class TestCalibrateObservability:
    """A obrigação carregada da validação 01: um build que NUNCA acelera tem que ser
    observável via log (stdout → meter.log + relay). _calibrate nunca levanta exceção."""

    def test_discover_failure_emits_log(self, monkeypatch, capsys):
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (0x7ff800000000, 0x62ea000))
        monkeypatch.setattr(mw, "regions", lambda reader: [])
        monkeypatch.setattr(mw.typeinfo, "discover_anchor",
                            lambda r, b, s, k, regs: None)  # não converge
        mw._calibrate(None, 1, FP, "c.json", {"StageClearLog": {0x1}}, {1: (1,)}, {2: (1,)}, {3: 1}, 0xC0FFEE)
        out = capsys.readouterr().out
        assert "FAILED to discover anchor" in out

    def test_idx_failure_emits_log(self, monkeypatch, capsys):
        # AMBOS os caminhos do idx_ut falham: value-scan (gold_index_of_klass) E o walk estrutural
        # (gold_index_by_structure). Só então a calibração desiste e emite o log.
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (0x7ff800000000, 0x62ea000))
        monkeypatch.setattr(mw, "regions", lambda reader: [])
        monkeypatch.setattr(mw.typeinfo, "discover_anchor",
                            lambda r, b, s, k, regs: (0x5B070E0, 0xdead, {"StageManager": 2592}))
        monkeypatch.setattr(mw, "gold_index_of_klass", lambda r, t, k: None)       # value-scan não acha
        monkeypatch.setattr(mw, "gold_index_by_structure", lambda r, t: None)      # estrutural tb não acha
        saved = {"hit": False}
        monkeypatch.setattr(mw, "save_calib", lambda *a, **k: saved.__setitem__("hit", True))
        mw._calibrate(None, 1, FP, "c.json", {"StageClearLog": {0x1}}, {1: (1,)}, {2: (1,)}, {3: 1}, 0xC0FFEE)
        out = capsys.readouterr().out
        assert "FAILED to locate gold idx in table" in out
        assert saved["hit"] is False          # idx None → NÃO persiste calib

    def test_idx_via_structure_when_value_scan_none(self, monkeypatch):
        # value-scan devolveu gold_klass=None (bug 1.00.11) → a calibração NÃO falha: deriva o
        # idx_ut pelo walk estrutural (name-free) e persiste. gold_index_of_klass nem é chamado.
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (0x7ff800000000, 0x62ea000))
        monkeypatch.setattr(mw, "regions", lambda reader: [])
        monkeypatch.setattr(mw.typeinfo, "discover_anchor",
                            lambda r, b, s, k, regs: (0x5B03410, 0xdead, {"StageManager": 2592}))
        called = {"value_scan": False}
        monkeypatch.setattr(mw, "gold_index_of_klass",
                            lambda r, t, k: called.__setitem__("value_scan", True))
        monkeypatch.setattr(mw, "gold_index_by_structure", lambda r, t: 2744)
        captured = {}
        monkeypatch.setattr(mw, "save_calib",
                            lambda path, fp, anchor, indices, idx_ut, si, ic, hc:
                            captured.update(idx_ut=idx_ut, anchor=anchor))
        mw._calibrate(None, 1, FP, "c.json", {"StageManager": {0x9}}, {1: (1,)}, {2: (1,)}, {3: 1}, None)
        assert captured.get("idx_ut") == 2744
        assert captured.get("anchor") == 0x5B03410
        assert called["value_scan"] is False   # gold_klass None → atalho pulado, foi pro estrutural

    def test_module_read_failure_emits_log(self, monkeypatch, capsys):
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (None, None))
        mw._calibrate(None, 1, FP, "c.json", {"StageClearLog": {0x1}}, {1: (1,)}, {2: (1,)}, {3: 1}, 0xC0FFEE)
        assert "FAILED to read GameAssembly.dll" in capsys.readouterr().out

    def test_no_fp_is_silent_noop(self, monkeypatch, capsys):
        # sem fp não dá pra calibrar (fp é a chave) → cai fora SEM ruído de log
        called = {"ga": False}
        monkeypatch.setattr(mw.typeinfo, "ga_module",
                            lambda pid: (called.__setitem__("ga", True), (1, 1))[1])
        mw._calibrate(None, 1, None, "c.json", {}, {}, {}, {}, 0xC0FFEE)
        assert called["ga"] is False
        assert capsys.readouterr().out == ""

    def test_success_persists_calib(self, monkeypatch, capsys):
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (0x7ff800000000, 0x62ea000))
        monkeypatch.setattr(mw, "regions", lambda reader: [])
        monkeypatch.setattr(mw.typeinfo, "discover_anchor",
                            lambda r, b, s, k, regs: (0x5B070E0, 0xdead, {"StageManager": 2592}))
        monkeypatch.setattr(mw, "gold_index_of_klass", lambda r, t, k: 2744)
        captured = {}
        def _save(path, fp, anchor, indices, idx_ut, si, ic, hc):
            captured.update(anchor=anchor, idx_ut=idx_ut, indices=indices)
        monkeypatch.setattr(mw, "save_calib", _save)
        mw._calibrate(None, 1, FP, "c.json", {"StageManager": {0x9}}, {1: (1,)}, {2: (1,)}, {3: 1}, 0xC0FFEE)
        assert captured == {"anchor": 0x5B070E0, "idx_ut": 2744, "indices": {"StageManager": 2592}}
        assert "fast path armed" in capsys.readouterr().out


class TestResolveFast:
    """_resolve_fast monta a tupla de 14 a partir do calib + rv do resolver. Monkeypatcha os
    delegates (typeinfo.table_base, resolve_via_rva, gold by-index) — a lógica deles é testada
    em test_typeinfo/test_resolver_rva/test_gold."""

    def _rv(self):
        classes = {n: {hash(n) & 0xffff} for n in mw.TARGETS}
        instances = {n: [] for n in mw.TARGETS}
        instances["MonsterSpawnManager"] = [0xAAA]
        instances["LogManager"] = [0xBBB]
        instances["StageManager"] = [0xCCC]
        return classes, instances

    def test_builds_14_tuple_psd_csd_sm_from_backref(self, monkeypatch):
        """PSD/CSD/StageManager vêm do backref direcionado (instances_of); MSM/LM do rv.
        Os 3 needles do backref são os K's de classe (classes[name]), NÃO as instâncias do rv."""
        monkeypatch.setattr(mw.typeinfo, "table_base", lambda r, ga, anchor: 0x9000)
        rv = self._rv()
        monkeypatch.setattr(mw, "resolve_via_rva", lambda r, tb, idx, tg, sg: rv)
        monkeypatch.setattr(mw, "resolve_combat_gold_klass_by_index", lambda r, tb, idx: 0x6010)
        monkeypatch.setattr(mw, "regions", lambda r: [(0x1000, 0x100)])
        seen = {}
        def _io(reader, regs, k_by_name):
            seen["k_by_name"] = k_by_name
            return {"PlayerSaveData": [0x111], "CommonSaveData": [0x222], "StageManager": [0x333]}
        monkeypatch.setattr(mw, "instances_of", _io)
        out = mw._resolve_fast(None, 0x7ff800000000, CALIB)
        assert out is not None and len(out) == 14
        (sc, sf, msm, lm, csd, psd, si, ic, hc, sm_list, gold, gb, die, res) = out
        assert sc == next(iter(rv[0]["StageClearLog"]))
        assert msm == 0xAAA and lm == 0xBBB           # MSM/LM ainda do rv (bbwf size-validado)
        # PSD/CSD/SM do backref (NÃO das instâncias do rv, que p/ esses são [])
        assert psd == [0x111] and csd == [0x222] and sm_list == [0x333]
        # o backref usa os K's de CLASSE dos 3, não os singletons
        assert seen["k_by_name"] == {n: next(iter(rv[0][n])) for n in
                                     ("PlayerSaveData", "CommonSaveData", "StageManager")}
        assert (si, ic, hc) == (CALIB["stage_info"], CALIB["item_cat"], CALIB["hero_cat"])
        assert gold == 0x6010

    def test_null_table_base_returns_none(self, monkeypatch):
        monkeypatch.setattr(mw.typeinfo, "table_base", lambda r, ga, anchor: None)
        assert mw._resolve_fast(None, 0x7ff800000000, CALIB) is None

    def test_rv_none_returns_none(self, monkeypatch):
        monkeypatch.setattr(mw.typeinfo, "table_base", lambda r, ga, anchor: 0x9000)
        monkeypatch.setattr(mw, "resolve_via_rva", lambda r, tb, idx, tg, sg: None)  # sanity-fail
        monkeypatch.setattr(mw, "resolve_combat_gold_klass_by_index", lambda r, tb, idx: 0x6010)
        assert mw._resolve_fast(None, 0x7ff800000000, CALIB) is None

    def test_gold_none_returns_none(self, monkeypatch):
        monkeypatch.setattr(mw.typeinfo, "table_base", lambda r, ga, anchor: 0x9000)
        monkeypatch.setattr(mw, "resolve_via_rva", lambda r, tb, idx, tg, sg: self._rv())
        monkeypatch.setattr(mw, "resolve_combat_gold_klass_by_index", lambda r, tb, idx: None)  # gold fail
        assert mw._resolve_fast(None, 0x7ff800000000, CALIB) is None
