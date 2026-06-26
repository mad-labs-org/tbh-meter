"""obscured.py — decode ACTk (CodeStage.AntiCheat) Obscured values from their OWN struct.

The decode algorithms below were READ FROM THE 1.00.20 BINARY (disassembly of the op_Implicit
accessors), NOT guessed — an earlier plain-XOR guess produced garbage and was refuted live. ACTk keeps
the key IN THE SAME STRUCT (`currentCryptoKey @ +0x8`, next to `hiddenValue @ +0x4`), so a read-only
reader can decode without calling the game's (per-build-renamed) method.

ObscuredInt  (struct: hash@0x0 hidden@0x4 key@0x8 fake@0xC; GameAssembly.dll RVA 0x6E6CA0):
    value = ((hidden - key) & 0xFFFFFFFF) ^ key            # int32
    Disasm core: `mov edi,[hidden]; sub edi,[key]; xor edi,[key]`. CONFIRMED live: the hero LEVEL
    field decodes to 91/94/101 == the save levels (3/3 exact).

ObscuredFloat (struct: hash@0x0 hidden@0x4 key@0x8 fake@0xC (float) ...; RVA 0x6E4C00):
    value = reinterpret_f32( key ^ byteswap_1_2(hidden) )  # bytes [1] and [2] of `hidden` swapped
    Disasm core: load hidden -> swap bytes 1,2 (helper 0x1807117F0) -> `xor key` -> `movd xmm,...`.
    CONFIRMED live: the hero within-level XP decodes to the save XP (Knight ~1.44e9≈1.45e9,
    Ranger 256,967,868,416 == save 256.97e9 EXACT at the cap where it's frozen).

Why this is robust ("find it again, always"): the algorithm is ACTk's, reimplemented here, so it does
NOT change when the game's obfuscated method names drift; the key is read live each tick (handles ACTk
key-rotation — never cache it). What CAN move (the struct base offset on a recompile, or a cipher
swap) is caught LOUDLY by the oracle (decoded == real level/xp) in scripts/validate_live.py — never
silently wrong. See [[invariants/obscured-data-offlimits]].

PURE (no memory access): the caller reads `hidden`/`key` (ru32 -> None on a bad read) and passes them.
None propagates -> the caller degrades to SAVE, never a wrong 0 ([[invariants/metric-fallback-chains]]).
"""

import struct


def _byteswap_1_2(v):
    """Swap bytes [1] and [2] of a 32-bit little-endian word (ACTkByte4 shuffle the ObscuredFloat
    decode applies before the XOR). Its own inverse."""
    return (v & 0xFF) | ((v >> 16) & 0xFF) << 8 | ((v >> 8) & 0xFF) << 16 | (v & 0xFF000000)


def decode_obscured_int(hidden, key):
    """ACTk ObscuredInt -> the real int32 (signed). `hidden`/`key` are the raw u32 words at the
    struct's hiddenValue/currentCryptoKey offsets. None if either word was unreadable (-> caller
    degrades to SAVE, never emits a bogus 0)."""
    if hidden is None or key is None:
        return None
    raw = ((((hidden - key) & 0xFFFFFFFF) ^ key) & 0xFFFFFFFF)
    return struct.unpack("<i", struct.pack("<I", raw))[0]


def decode_obscured_float(hidden, key):
    """ACTk ObscuredFloat -> the real float32. Byte-swap [1]<->[2] of `hidden`, XOR the key,
    reinterpret as float32. None if either word was unreadable."""
    if hidden is None or key is None:
        return None
    bits = (key ^ _byteswap_1_2(hidden)) & 0xFFFFFFFF
    return struct.unpack("<f", struct.pack("<I", bits))[0]
