"""Integration: live-XP recovery through the REAL read path — `read_live_party` decodes the ACTk
cipher in `HeroRuntime`, feeding the REAL `PartyXpAccumulator`.

Two distinct things are tested (kept apart on purpose):
  - DECODE + WIRING against GROUND TRUTH: real (hidden, key) words captured from the running 1.00.20
    game laid into the StageManager.HeroList layout -> `read_live_party` returns the real levels
    (91/94/101 == save) and the real within-level XP (Ranger exact at the cap). This is NOT a
    round-trip of our own code — real input, independently-known output (decode correctness itself is
    further pinned in tests/test_obscured.py against the save).
  - PIPELINE BEHAVIOR (death banks the gain, revive resumes, max-level = 0, unreadable -> save): the
    accumulator integration. These use constructed inputs (you can't make the game die on command),
    so they assert the ACCUMULATOR's real behavior — the gain — not decode correctness.
"""

import struct

import pytest

from config.offsets import Array, HeroInfoData, HeroRuntime, StageManager, Unit
from game.build import read_live_party
from metrics.xp import PartyXpAccumulator
from tests.conftest import MockReader

SM = 0x1000
HERO_CAT = {101: 1, 201: 2, 301: 3, 401: 4, 501: 5, 601: 6}


def _f32(v):
    return struct.unpack("<f", struct.pack("<f", v))[0]


def _enc_int(value, key):                      # inverse of ((h-k)^k)
    return (((value & 0xFFFFFFFF) ^ (key & 0xFFFFFFFF)) + key) & 0xFFFFFFFF


def _enc_float(value, key):                    # inverse of float(key ^ byteswap12(h))
    bits = struct.unpack("<I", struct.pack("<f", value))[0] ^ (key & 0xFFFFFFFF)
    return (bits & 0xFF) | ((bits >> 16) & 0xFF) << 8 | ((bits >> 8) & 0xFF) << 16 | (bits & 0xFF000000)


def _reader(heroes):
    """MockReader laying out StageManager.HeroList -> HeroRuntime with the level/xp ciphers.
    `heroes`: list of (hk, lvl_hidden, lvl_key, xp_hidden, xp_key) — RAW cipher words at the offsets."""
    hl = 0x10000
    mem = {SM + StageManager.HERO_LIST: hl, hl + Array.MAX_LENGTH: len(heroes)}
    for i, (hk, lh, lk, xh, xk) in enumerate(heroes):
        base = 0x100000 * (i + 1)
        uf, hi = base + 0x1000, base + 0x2000
        mem[hl + Array.DATA + i * 8] = base
        mem[base + Unit.CACHE] = uf
        mem[uf + HeroRuntime.INFO] = hi
        mem[hi + HeroInfoData.HERO_KEY] = hk
        mem[uf + HeroRuntime.LEVEL_HIDDEN] = lh
        mem[uf + HeroRuntime.LEVEL_KEY] = lk
        mem[uf + HeroRuntime.EXP_HIDDEN] = xh
        mem[uf + HeroRuntime.EXP_KEY] = xk
    return MockReader(mem=mem)


def _synth(hk, level, exp, lkey, xkey):
    """A hero whose level/exp are ENCODED from desired values (for behavior scenarios)."""
    return (hk, _enc_int(level, lkey), lkey, _enc_float(exp, xkey), xkey)


class TestDecodeWiringAgainstLiveGame:
    """Real captured cipher words flow through read_live_party to the real level/xp (ground truth)."""

    # heroKey -> (level cipher (hidden,key), xp cipher (hidden,key)) captured live on 1.00.20.
    REAL = [
        (101, 0x8C767E63, 0x463B3F0D, 0x38984737, 0x76EC4E86),   # Knight   Lv 91
        (301, 0xD5E7E15E, 0x6AF3F0CA, 0x0088434D, 0x4D487400),   # Sorcerer Lv 94
        (201, 0xCFB0DF75, 0x67D86FCD, 0x14CE4686, 0x46299F6C),   # Ranger   Lv 101 (cap)
    ]

    def test_read_live_party_returns_real_levels(self):
        party = read_live_party(_reader(self.REAL), SM, HERO_CAT)
        assert party[101][0] == 91
        assert party[301][0] == 94
        assert party[201][0] == 101

    def test_read_live_party_returns_real_within_level_xp(self):
        party = read_live_party(_reader(self.REAL), SM, HERO_CAT)
        assert party[201][1] == pytest.approx(256_967_868_416.0, abs=1.0)   # Ranger == save (cap, frozen)
        assert party[101][1] == pytest.approx(1_441_486_976.0, abs=1.0)     # Knight within-level xp
        assert party[301][1] == pytest.approx(146_785_488.0, abs=1.0)       # Sorcerer within-level xp


class TestDecodeRobustness:
    """The bug class PR #75 ships: bit-31-set hidden/key. Our ru32 path decodes them; a signed
    ri32 + struct.pack('<I') would raise -> None -> silent save fallback."""

    def test_bit31_keys_decode_not_none(self):
        for lkey, xkey in [(0x80000000, 0xFFFFFFFF), (0xDEADBEEF, 0xC0FFEE99), (0xFFFFFFFF, 0x80000001)]:
            party = read_live_party(_reader([_synth(301, 94, _f32(156_000_000.0), lkey, xkey)]), SM, HERO_CAT)
            assert party[301][0] == 94                                   # not None / not garbage
            assert party[301][1] == pytest.approx(_f32(156_000_000.0))


class TestPipelineBehavior:
    """read_live_party -> PartyXpAccumulator: the per-run gain across death / revive / cap. Inputs are
    constructed (can't die on command); the ASSERTION is the accumulator's real gain."""

    def _feed(self, acc, heroes):
        acc.update(read_live_party(_reader(heroes), SM, HERO_CAT))

    def test_gain_banked_when_hero_dies(self):
        acc = PartyXpAccumulator()
        self._feed(acc, [_synth(301, 94, _f32(100_000_000.0), 0x1, 0x2)])
        self._feed(acc, [_synth(301, 94, _f32(100_500_000.0), 0x1, 0x3)])   # +0.5M before death
        self._feed(acc, [])                                                 # DEAD: gone from HeroList
        self._feed(acc, [])                                                 # still dead -> banked
        assert acc.gain(301) == pytest.approx(_f32(100_500_000.0) - _f32(100_000_000.0))

    def test_gain_resumes_after_revive(self):
        acc = PartyXpAccumulator()
        self._feed(acc, [_synth(301, 94, _f32(100_000_000.0), 0x1, 0x2)])
        self._feed(acc, [_synth(301, 94, _f32(100_500_000.0), 0x1, 0x3)])   # +0.5M before death
        self._feed(acc, [])                                                 # dead
        self._feed(acc, [_synth(301, 94, _f32(100_500_000.0), 0x1, 0x4)])   # revived (gained 0 dead)
        self._feed(acc, [_synth(301, 94, _f32(101_000_000.0), 0x1, 0x5)])   # +0.5M after revive
        assert acc.gain(301) == pytest.approx(_f32(101_000_000.0) - _f32(100_000_000.0))

    def test_capped_hero_gains_zero(self, real_curve):
        acc = PartyXpAccumulator()
        for exp, xkey in zip([_f32(1e9), _f32(1.5e9), _f32(2e9)], [0x11, 0x80000000, 0xFFFFFFFF], strict=True):
            self._feed(acc, [_synth(201, 101, exp, 0x7, xkey)])             # live level 101 = cap
        assert acc.gain(201) == pytest.approx(0.0)                          # phantom xp suppressed


class TestUnreadableCipherFallsBack:
    def test_exp_none_and_level_from_save(self):
        """Cipher offsets unmapped -> ru32 None -> exp None (honest save fallback downstream); level
        falls back to the save snapshot (never a bogus 0)."""
        hl = 0x10000
        mem = {SM + StageManager.HERO_LIST: hl, hl + Array.MAX_LENGTH: 1,
               hl + Array.DATA: 0x100000, 0x100000 + Unit.CACHE: 0x101000,
               0x101000 + HeroRuntime.INFO: 0x102000, 0x102000 + HeroInfoData.HERO_KEY: 301}
        party = read_live_party(MockReader(mem=mem), SM, HERO_CAT, save_heroes={301: (88, 5.0)})
        assert party[301][0] == 88        # level from the save fallback
        assert party[301][1] is None      # exp None -> accumulator skips -> close_run tags "save"
