"""obscured.py — decode ACTk (CodeStage.AntiCheat) Obscured values from their OWN struct.

The decode algorithms below were READ FROM THE BINARY (disassembly of the op_Implicit accessors: int/
float from 1.00.20, ObscuredDouble from the 1.00.27 recompile), NOT guessed — an earlier plain-XOR
guess produced garbage and was refuted live. Each Obscured type has a DIFFERENT algorithm (do NOT
extrapolate one from another): int is arithmetic, float/double are a per-type byte shuffle + XOR. ACTk
keeps the key IN THE SAME STRUCT (`currentCryptoKey` next to `hiddenValue`), so a read-only reader can
decode without calling the game's (per-build-renamed) method.

ObscuredInt  (struct: hash@0x0 hidden@0x4 key@0x8 fake@0xC; GameAssembly.dll RVA 0x6E6CA0):
    value = ((hidden - key) & 0xFFFFFFFF) ^ key            # int32
    Disasm core: `mov edi,[hidden]; sub edi,[key]; xor edi,[key]`. CONFIRMED live: the hero LEVEL
    field decodes to 91/94/101 == the save levels (3/3 exact).

ObscuredFloat (struct: hash@0x0 hidden@0x4 key@0x8 fake@0xC (float) ...; RVA 0x6E4C00):
    value = reinterpret_f32( key ^ byteswap_1_2(hidden) )  # bytes [1] and [2] of `hidden` swapped
    Disasm core: load hidden -> swap bytes 1,2 (helper 0x1807117F0) -> `xor key` -> `movd xmm,...`.
    CONFIRMED live: the hero within-level XP decodes to the save XP (Knight ~1.44e9≈1.45e9,
    Ranger 256,967,868,416 == save 256.97e9 EXACT at the cap where it's frozen).

ObscuredDouble (struct: hash@0x0 hidden@0x8 (LONG) key@0x10 (LONG) fake@0x18 (double) b8@0x20;
                1.00.27 build: op_Implicit(ObscuredDouble)->double RVA 0x6E39D0 -> getter `xry`
                RVA 0x6E40F0; standalone decrypt DoubleLongBytesUnion.xrc RVA 0x6D5EF0):
    value = reinterpret_f64( key ^ byteswap8(hidden) )     # 64-bit analog of the float path
    where byteswap8 = ACTkByte8 shuffle `yub` (RVA 0x7133A0), the 8-byte permutation applied before
    the XOR: out[0]=in[1] out[1]=in[0] out[2]=in[2] out[3]=in[3] out[4]=in[7] out[5]=in[4]
    out[6]=in[6] out[7]=in[5] (bytes 2,3,6 fixed; 0<->1 swap; 3-cycle 4<-7<-5<-4). Disasm core of
    `xry`: `mov rax,[hidden@+0x8]; <yub in place>; mov rbx,[key@+0x10]; xor rbx,[shuffled];
    movq xmm,rbx`. Same SHAPE as ObscuredFloat but 8-byte reads (hidden/key are `long`, read via
    ru64). CROSS-CHECK: the same tooling re-disassembled the 1.00.27 ObscuredFloat decrypt and
    recovered the already-live-confirmed float algorithm byte-for-byte, so the double read is trusted;
    the live oracle (validate_live.py [xp-live]) is the final arbiter. NEW in 1.00.27: the HeroRuntime
    within-level XP field widened ObscuredFloat->ObscuredDouble (config/offsets.py::HeroRuntime), the
    same float->double widening seen in HeroSaveData.HeroExp.

Why this is robust ("find it again, always"): the algorithm is ACTk's, reimplemented here, so it does
NOT change when the game's obfuscated method names drift; the key is read live each tick (handles ACTk
key-rotation — never cache it). What CAN move (the struct base offset on a recompile, or a cipher
swap) is caught LOUDLY by the oracle (decoded == real level/xp) in scripts/validate_live.py — never
silently wrong. See [[invariants/obscured-data-offlimits]].

PURE (no memory access): the caller reads `hidden`/`key` (ru32/ru64 -> None on a bad read) and passes
them. None propagates -> the caller degrades to SAVE, never a wrong 0
([[invariants/metric-fallback-chains]]).
"""

import struct


def _byteswap_1_2(v):
    """Swap bytes [1] and [2] of a 32-bit little-endian word (ACTkByte4 shuffle the ObscuredFloat
    decode applies before the XOR). Its own inverse."""
    return (v & 0xFF) | ((v >> 16) & 0xFF) << 8 | ((v >> 8) & 0xFF) << 16 | (v & 0xFF000000)


# ACTkByte8 `yub` permutation (RVA 0x7133A0), read from the 1.00.27 binary — the 8-byte analog of the
# ObscuredFloat byteswap_1_2. out[i] = in[_BYTE8_PERM[i]]. NOT its own inverse (the 4/5/7 3-cycle);
# `yua` (RVA 0x713370) is the encode inverse — only the decode `yub` matters here.
_BYTE8_PERM = (1, 0, 2, 3, 7, 4, 6, 5)


def _byteswap8(v):
    """Apply the ACTkByte8 `yub` shuffle to a 64-bit little-endian word (the permutation the
    ObscuredDouble decode applies before the XOR)."""
    b = [(v >> (8 * i)) & 0xFF for i in range(8)]
    r = 0
    for i, src in enumerate(_BYTE8_PERM):
        r |= b[src] << (8 * i)
    return r


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


def decode_obscured_double(hidden, key):
    """ACTk ObscuredDouble -> the real float64. `hidden`/`key` are the raw u64 words at the struct's
    hiddenValue/currentCryptoKey offsets (read via ru64 — they are 8-byte `long`s, NOT the 32-bit
    words the int/float ciphers use). Apply the ACTkByte8 `yub` shuffle to `hidden`, XOR the key,
    reinterpret the 64 bits as float64. None if either word was unreadable (-> the caller degrades to
    the SAVE delta, never emits a bogus 0). See the module docstring for the disassembly."""
    if hidden is None or key is None:
        return None
    bits = (key ^ _byteswap8(hidden)) & 0xFFFFFFFFFFFFFFFF
    return struct.unpack("<d", struct.pack("<Q", bits))[0]
