"""Tests for game/obscured.py — the ACTk Obscured decoders (algorithm read from the 1.00.20 binary).

The CORRECTNESS PROOF is `TestDecodeAgainstLiveGame`: raw (hiddenValue, currentCryptoKey) words
CAPTURED FROM THE RUNNING 1.00.20 GAME, decoded and checked against INDEPENDENT ground truth — the
hero LEVEL read from the save by a separate path (91/94/101, 3/3 exact) and the within-level XP (the
Ranger is at the cap so its XP is frozen → live == save EXACTLY; Knight/Sorcerer match the save
magnitude). These are NOT round-trips of our own code — real input, independently-known output.

`TestDecodeInvertsActkEncode` is a supplementary PROPERTY check (the decode inverts the
ACTk-faithful encode across the value/key range, incl. bit-31-set words) — breadth the golden points
can't cover. It is anchored by, never a substitute for, the golden vectors.
"""

import struct

import pytest

from game.obscured import decode_obscured_float, decode_obscured_int


class TestDecodeAgainstLiveGame:
    """Real cipher words from the running game (build fp 1.00.20-0x6a3a1c51-0x6977000) -> the real
    level/xp. Ground truth is the SAVE (read by a different code path) — not our encode."""

    def test_level_decodes_to_save_level(self):
        # ObscuredInt level @ HeroRuntime+0xCC (hidden +0xD0, key +0xD4). == the save level.
        assert decode_obscured_int(0x8C767E63, 0x463B3F0D) == 91     # Knight   (save Lv 91)
        assert decode_obscured_int(0xD5E7E15E, 0x6AF3F0CA) == 94     # Sorcerer (save Lv 94)
        assert decode_obscured_int(0xCFB0DF75, 0x67D86FCD) == 101    # Ranger   (save Lv 101, cap)

    def test_within_level_xp_matches_save(self):
        # ObscuredFloat xp @ HeroRuntime+0x10C (hidden +0x110, key +0x114).
        # Ranger at the cap → xp FROZEN → live decode == save value EXACTLY (5+ sig figs).
        assert decode_obscured_float(0x14CE4686, 0x46299F6C) == pytest.approx(256_967_868_416.0, abs=1.0)
        # Knight/Sorcerer mid-level → right magnitude vs the (older) save snapshot.
        assert decode_obscured_float(0x38984737, 0x76EC4E86) == pytest.approx(1_441_486_976.0, abs=1.0)  # save ~1.4536e9
        assert decode_obscured_float(0x0088434D, 0x4D487400) == pytest.approx(146_785_488.0, abs=1.0)    # save ~1.5628e8

    def test_within_level_xp_below_curve(self):
        # an honest sanity tie-in: a non-capped hero's within-level xp must sit below its level's
        # ExpForLevelUp. curve[91]≈1.67e9 / curve[94]≈1.774e9 (config/level_curve.json).
        assert 0 < decode_obscured_float(0x38984737, 0x76EC4E86) < 1.67e9   # Knight Lv91
        assert 0 < decode_obscured_float(0x0088434D, 0x4D487400) < 1.774e9  # Sorcerer Lv94


class TestDecodeInvertsActkEncode:
    """Property: the decode inverts the ACTk-faithful ENCODE for every value/key, including
    bit-31-set words (where a signed `ri32` + `struct.pack('<I')` raises — the latent bug we avoid
    by reading `ru32` + masking). Covers the bit-pattern range the 6 golden points can't."""

    @staticmethod
    def _enc_int(value, key):                  # inverse of ((h-k)^k): h = (value ^ key) + key
        return (((value & 0xFFFFFFFF) ^ (key & 0xFFFFFFFF)) + key) & 0xFFFFFFFF

    @staticmethod
    def _enc_float(value, key):                # inverse of float(key ^ byteswap12(h))
        bits = struct.unpack("<I", struct.pack("<f", value))[0] ^ (key & 0xFFFFFFFF)
        return (bits & 0xFF) | ((bits >> 16) & 0xFF) << 8 | ((bits >> 8) & 0xFF) << 16 | (bits & 0xFF000000)

    # keys incl. bit-31 set (0x80000000, 0xFFFFFFFF) and hidden words that go negative as int32
    KEYS = (0, 1, 0x463B3F0D, 0x76EC4E86, 0x80000000, 0xDEADBEEF, 0xFFFFFFFF)

    def test_int_round_trip(self):
        for value in (0, 1, 91, 94, 101, 500, 123456, 2_000_000_000):
            for key in self.KEYS:
                assert decode_obscured_int(self._enc_int(value, key), key) == value, (value, hex(key))

    def test_float_round_trip(self):
        def f32(v):
            return struct.unpack("<f", struct.pack("<f", v))[0]
        for value in (f32(x) for x in (0.0, 1.0, 156_280_000.0, 1_453_570_000.0, 256_970_000_000.0)):
            for key in self.KEYS:
                assert decode_obscured_float(self._enc_float(value, key), key) == value, (value, hex(key))

    def test_none_propagates_never_zero(self):
        # a bad read (ru32 -> None) yields None so the caller degrades to SAVE, NEVER a bogus 0.
        assert decode_obscured_int(None, 5) is None
        assert decode_obscured_int(5, None) is None
        assert decode_obscured_float(None, 5) is None
        assert decode_obscured_float(5, None) is None
