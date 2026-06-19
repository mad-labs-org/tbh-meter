"""test_seed_committed.py — guards the COMMITTED config/calib_seed.json (the artifact a reseed ships)
against the mistakes the 2-file reseed (new seed + GAME_VERSION bump) is prone to.

Distinct from the neighbours, and runs in PLAIN CI with no dump — it is the only standard-pytest
check on the shipped seed itself:
  • test_calib.py ISOLATES every test from the embedded seed (it points _seed_path at a missing
    file) to exercise pure cache logic, so it never looks at the real artifact;
  • test_calib_safety.py is adversarial-vs-the-real-dump and SKIPS without the maintainer's dump
    (i.e. on CI / contributors);
  • meter_windows --selftest validates the bundle at BUILD time, but only the fmt + that each fp
    LOADS (stage_info via _stage_info_ok) — it does NOT tie the seed to GAME_VERSION, nor catch an
    empty item_cat/hero_cat.

What this catches that nothing else does:
  • SEED ↔ GAME_VERSION desync — the reseed bumps GAME_VERSION and swaps the seed in two separate
    edits. If they drift (a bumped fallback with a stale seed, or vice-versa) the live fingerprint
    (read from the real DLL) won't match the seed's fp → EVERY first launch cold-scans (the
    "gold 0 / stage ?" symptom the seed exists to prevent). Today nothing asserts the link.
  • a DEGENERATE catalog committed — an empty item_cat/hero_cat slips past --selftest (which only
    gates stage_info), shipping build records that resolve every item/hero to None.
  • a multi-fp / wrong-fmt seed.
"""
import json
import os

import pytest

from meter_windows import CACHE_FMT, GAME_VERSION, _read_calib

_SEED = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "config", "calib_seed.json"))


@pytest.fixture
def seed():
    with open(_SEED, encoding="utf-8") as f:
        return json.load(f)


class TestCommittedSeed:
    def test_fmt_matches_cache_fmt(self, seed):
        # a seed at an old fmt is rejected at runtime (→ cold scan forever) and must never be committed.
        assert seed.get("fmt") == CACHE_FMT

    def test_exactly_one_build(self, seed):
        # the capture promotes EXACTLY one fp (the build being shipped); >1 means a stale entry lingered.
        assert len(seed["calib"]) == 1, list(seed["calib"])

    def test_build_matches_game_version(self, seed):
        # THE desync guard: the fp's version prefix must equal GAME_VERSION. A bump without a fresh
        # seed (or the reverse) ships a seed the live build won't match → cold scan on every 1st launch.
        fp = next(iter(seed["calib"]))
        assert fp.split("-")[0] == GAME_VERSION, f"seed fp {fp!r} vs GAME_VERSION {GAME_VERSION!r}"

    def test_catalogs_not_degenerate(self, seed):
        # a capture run OUTSIDE combat degrades the catalogs; empty item_cat/hero_cat slips past
        # --selftest. Floors sit far below the real counts (~120 stages, ~5900 items, 6 heroes) so a
        # content patch never trips them, but a degraded capture does.
        entry = next(iter(seed["calib"].values()))
        assert len(entry["stage_info"]) >= 100
        assert len(entry["item_cat"]) >= 1000
        assert len(entry["hero_cat"]) >= 6

    def test_loads_via_runtime_gate(self, seed):
        # the SAME gate the reader uses at launch (_read_calib → _stage_info_ok): a seed the runtime
        # would silently reject must fail HERE, not on a player's first launch.
        fp = next(iter(seed["calib"]))
        assert _read_calib(_SEED, fp) is not None
