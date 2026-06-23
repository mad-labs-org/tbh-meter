"""Tests for the resolve_all GATE (deliverable 05/01) — fast path (calib/RVA) vs slow path
(scan) + calibration. These are orchestration functions: the real memory reads live in
typeinfo/resolver/gold (covered by their own tests + live probes), so here we monkeypatch the
delegates to exercise ONLY the gate decision. They run on mac.

Covers:
  - fast path OK → 14-tuple from calib, ZERO scan;
  - fast path sanity-fail (_resolve_fast None) → falls back to scan;
  - no ga_base/fp → skips straight to scan;
  - slow path → scan + calibrate (only on a complete scan);
  - calibration fails (anchor/idx None) → EMITS an observable log, NEVER crashes;
  - _resolve_fast builds the right tuple (14-shape, PSD/CSD/SM from the targeted backref, MSM/LM from rv).
"""

import meter_windows as mw

FP = "1.00.07-0x6a203f51-0x62ea000"
CALIB = {"anchor_rva": 0x5B070E0,
         "indices": {"StageClearLog": 2838, "StageManager": 2592},
         "idx_ut": 2744,
         "stage_info": {1001: (1, 1, 50, 0)},
         "item_cat": {30001: (3, 2, 5)},
         "hero_cat": {601: 1}}

# sentinel 14-tuple (cache shape) — what the scan/fast path return
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
        assert called["scan"] is False         # fast path does NOT run scan
        assert len(out) == 14

    def test_fast_sanity_fail_falls_back_to_scan(self, monkeypatch, tmp_path):
        _patch_ga(monkeypatch)
        monkeypatch.setattr(mw, "load_calib", lambda path, fp: CALIB)
        monkeypatch.setattr(mw, "_resolve_fast", lambda reader, ga, calib: None)  # sanity-fail
        monkeypatch.setattr(mw, "_resolve_scan", lambda reader: (SCAN_TUP, {}))
        monkeypatch.setattr(mw, "_calibrate", lambda *a, **k: None)
        out = mw.resolve_all(None, 123, FP, str(tmp_path / "c.json"))
        assert out == SCAN_TUP                 # degraded to scan, did NOT use bad calib

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
        assert seen["load_calib"] is False     # no ga_base → doesn't even try calib

    def test_no_calib_goes_to_scan(self, monkeypatch, tmp_path):
        _patch_ga(monkeypatch)
        monkeypatch.setattr(mw, "load_calib", lambda path, fp: None)  # new build
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
        # incomplete scan: msm=None (a manager is missing) → does NOT calibrate (persist-gate)
        bad = (None, "sf", None, "lm", [], [], {}, {}, {}, [], None, None, None, None)
        monkeypatch.setattr(mw, "_resolve_scan", lambda reader: (bad, {}))
        calibrated = {"hit": False}
        monkeypatch.setattr(mw, "_calibrate",
                            lambda *a, **k: calibrated.__setitem__("hit", True))
        out = mw.resolve_all(None, 123, FP, str(tmp_path / "c.json"))
        assert out == bad
        assert calibrated["hit"] is False


class TestCalibrateObservability:
    """The obligation carried over from validation 01: a build that NEVER goes fast must be
    observable via log (stdout → meter.log + relay). _calibrate never raises."""

    def test_discover_failure_emits_log(self, monkeypatch, capsys):
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (0x7ff800000000, 0x62ea000))
        monkeypatch.setattr(mw, "regions", lambda reader: [])
        monkeypatch.setattr(mw.typeinfo, "discover_anchor",
                            lambda r, b, s, k, regs: None)  # doesn't converge
        mw._calibrate(None, 1, FP, "c.json", {"StageClearLog": {0x1}}, {1: (1,)}, {2: (1,)}, {3: 1}, 0xC0FFEE)
        out = capsys.readouterr().out
        assert "FAILED to discover anchor" in out

    def test_idx_failure_emits_log(self, monkeypatch, capsys):
        # BOTH idx_ut paths fail: value-scan (gold_index_of_klass) AND the structural walk
        # (gold_index_by_structure). Only then does calibration give up and emit the log.
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (0x7ff800000000, 0x62ea000))
        monkeypatch.setattr(mw, "regions", lambda reader: [])
        monkeypatch.setattr(mw.typeinfo, "discover_anchor",
                            lambda r, b, s, k, regs: (0x5B070E0, 0xdead, {"StageManager": 2592}))
        monkeypatch.setattr(mw, "gold_index_of_klass", lambda r, t, k: None)       # value-scan finds nothing
        monkeypatch.setattr(mw, "gold_index_by_structure", lambda r, t: None)      # structural finds nothing too
        saved = {"hit": False}
        monkeypatch.setattr(mw, "save_calib", lambda *a, **k: saved.__setitem__("hit", True))
        mw._calibrate(None, 1, FP, "c.json", {"StageClearLog": {0x1}}, {1: (1,)}, {2: (1,)}, {3: 1}, 0xC0FFEE)
        out = capsys.readouterr().out
        assert "FAILED to locate gold idx in table" in out
        assert saved["hit"] is False          # idx None → does NOT persist calib

    def test_idx_via_structure_when_value_scan_none(self, monkeypatch):
        # value-scan returned gold_klass=None (bug 1.00.11) → calibration does NOT fail: it derives
        # idx_ut via the structural walk (name-free) and persists. gold_index_of_klass isn't even called.
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
        assert called["value_scan"] is False   # gold_klass None → shortcut skipped, went structural

    def test_module_read_failure_emits_log(self, monkeypatch, capsys):
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (None, None))
        mw._calibrate(None, 1, FP, "c.json", {"StageClearLog": {0x1}}, {1: (1,)}, {2: (1,)}, {3: 1}, 0xC0FFEE)
        assert "FAILED to read GameAssembly.dll" in capsys.readouterr().out

    def test_no_fp_is_silent_noop(self, monkeypatch, capsys):
        # no fp → can't calibrate (fp is the key) → bails out WITHOUT any log noise
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
    """_resolve_fast builds the 14-tuple from the calib + the resolver's rv. Monkeypatches the
    delegates (typeinfo.table_base, resolve_via_rva, gold by-index) — their logic is tested
    in test_typeinfo/test_resolver_rva/test_gold."""

    def _rv(self):
        classes = {n: {hash(n) & 0xffff} for n in mw.TARGETS}
        instances = {n: [] for n in mw.TARGETS}
        instances["MonsterSpawnManager"] = [0xAAA]
        instances["LogManager"] = [0xBBB]
        instances["StageManager"] = [0xCCC]
        return classes, instances

    def test_builds_14_tuple_psd_csd_sm_from_backref(self, monkeypatch):
        """PSD/CSD/StageManager come from the targeted backref (instances_of); MSM/LM from rv.
        The 3 backref needles are the class K's (classes[name]), NOT the rv instances."""
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
        assert msm == 0xAAA and lm == 0xBBB           # MSM/LM still from rv (bbwf size-validated)
        # PSD/CSD/SM from the backref (NOT from the rv instances, which for these are [])
        assert psd == [0x111] and csd == [0x222] and sm_list == [0x333]
        # the backref uses the CLASS K's of the 3, not the singletons
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


class TestIncompleteResolutionStatus:
    """run() bails when the scan/fast-path returns an INCOMPLETE tuple (a manager missing —
    typically a cold scan run OUTSIDE combat: nothing gets persisted, so the reader exits and
    the app supervisor re-spawns it, scanning AGAIN every launch). The OBSERVABILITY contract:
    on that bail the reader must emit a TERMINAL [[STATUS]] marker that reverts the splash to a
    deadline-protected phase (`searching`) — NOT leave it stranded on `scanning`/`resolving`
    forever (the "stuck on First time on this version" symptom). Every OTHER exit in run()
    either reaches `ready` or reverts to `searching` (game-not-open); the incomplete-resolution
    path was the one asymmetry that emitted no terminal marker.

    Monkeypatches all of run()'s heavy I/O delegates (find_pid/open_process/Reader/version/
    ga_module/fingerprint/resolve_all) so the test exercises ONLY the bring-up status sequence."""

    def _drive_run_to_incomplete(self, monkeypatch, tmp_path):
        # an INCOMPLETE 14-tuple: msm=None (a manager missing) → run()'s
        # `if not (msm and lm and sc_class and sf_class)` guard fires.
        incomplete = (None, "sf", None, "lm", [], [], {1: (1, 1, 1, 0)},
                      {2: (1, 1, 1)}, {3: 1}, [], None, None, None, None)
        monkeypatch.setattr(mw, "find_pid", lambda: 1234)
        monkeypatch.setattr(mw, "open_process", lambda pid: 0xDEAD)
        monkeypatch.setattr(mw, "Reader", lambda handle: object())
        monkeypatch.setattr(mw, "_detect_game_version", lambda handle: "1.00.19")
        monkeypatch.setattr(mw.typeinfo, "ga_module", lambda pid: (0x7ff800000000, 0x62ea000))
        monkeypatch.setattr(mw.typeinfo, "build_fingerprint", lambda r, b, version=None: FP)
        monkeypatch.setattr(mw, "resolve_all", lambda r, pid, fp, cache: incomplete)
        # load_calib is consulted again right after resolve_all (for tbase/idx_ut) → keep it a miss.
        monkeypatch.setattr(mw, "load_calib", lambda path, fp: None)
        mw.run(hz=10, output_dir=str(tmp_path), debug=False)

    def test_incomplete_resolution_reverts_splash_to_searching(self, monkeypatch, tmp_path, capsys):
        self._drive_run_to_incomplete(monkeypatch, tmp_path)
        markers = [ln.split("[[STATUS]]")[1].strip().split()[0]
                   for ln in capsys.readouterr().out.splitlines() if "[[STATUS]]" in ln]
        # never reaches ready (resolution failed) ...
        assert "ready" not in markers
        # ... and the LAST terminal marker is `searching`, so the splash leaves the
        # `resolving`/`scanning` phase the app can't time out and lands on the deadline-protected one.
        assert markers[-1] == "searching", (
            f"incomplete-resolution bail left the splash stranded on {markers[-1]!r} "
            f"(full sequence: {markers}) — must revert to `searching`")
