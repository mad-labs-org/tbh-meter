---
type: invariant
description: "Obscured (XOR) data is PERMANENTLY off-limits to read — yields garbage: Unit core stats (ObscuredFloat) and Monster.cache. Use the PLAIN fields. And hero class identity is EEquipClassType, NEVER the orphan enum EHeroType (different mapping → labels Knight as Ranger)."
symptoms:
  - "ObscuredFloat"
  - "ObscuredInt"
  - "per-hero stats runtime"
  - "reading 0x104"
  - "garbage core stats"
  - "EHeroType"
  - "wrong hero class"
  - "Knight turned into Ranger"
  - "Monster cache"
code_anchors:
  - config/offsets.py::Unit.CORE_STATS_OBSCURED
  - config/offsets.py::Monster.CACHE_OBSCURED
  - config/offsets.py::EEquipClassType
  - config/offsets.py::StatsHolder.FINAL_STATS
  - game/obscured.py::decode_obscured_float
asserts:
  - config.offsets.Unit.CORE_STATS_OBSCURED == 0x104
  - config.offsets.Monster.CACHE_OBSCURED == 0x3B8
  - config.offsets.EEquipClassType.Knight == 1
  - config.offsets.EEquipClassType.Ranger == 2
guarded_by:
  - tests/test_obscured_markers.py::test_no_reader_module_reads_obscured_offsets
  - tests/test_obscured_markers.py::test_obscured_markers_exist
  - tests/test_offsets.py::TestEEquipClassType::test_knight_is_1
---

# Obscured data: what to NEVER read (+ orphan enums)

Part of the game's memory is XOR-ciphered (`ACTk` Obscured: `ObscuredInt`/`ObscuredFloat`/
`ObscuredULong`). **Reading at those offsets yields garbage** — `hidden ^ key` is not the value; the
real value would be the PLAIN `fakeValue` in another field, but the per-index mapping is lost, so the
Obscured field is simply **off-limits to read**. It's a real class of bug (someone sees the offset, reads
it, and emits a meaningless number). The hard rule: read the **PLAIN** equivalent, never the Obscured one.

## Off-limits and the PLAIN substitute

- **Unit core stats `@Unit.CORE_STATS_OBSCURED`** — the 12 core stats are **`ObscuredFloat`** (NOT
  `ObscuredInt`, as the old skill claimed — the comment in `config/offsets.py` is the truth). Use
  **`StatsHolder.FINAL_STATS`** (`xd.FINAL_STATS`), a **PLAIN** `Dict<StatType,float>` with the 64
  final stats. (It's a `DictFloat` — [[invariants/dict-strides]] dictates the geometry.)
- **`Monster.CACHE_OBSCURED`** (`ud.tl`) — Obscured. Use the **`Monster` PLAIN fields** (e.g.
  `Monster.STAGE_KEY` for the live stageKey). Never dereference the ciphered cache.

The two offsets exist in `config/offsets.py` ONLY as **named markers** ("DO NOT READ"), so this note can
anchor on them and the test can guard them. They **must not be referenced by any read module**
(`metrics/`, `game/`) — if a module cites `CORE_STATS_OBSCURED`/`CACHE_OBSCURED`, it's because someone is
about to read there, and `guarded_by` fails on purpose.

## The dead `fakeValue` decoy is recovered by decoding the cipher (1.00.20+)

ACTk keeps each Obscured value as `hash / hiddenValue / currentCryptoKey / fakeValue` (the cipher fields +
a PLAIN `fakeValue` decoy at base+`ACTK_FAKE`). Through 1.00.19 the decoy was kept in sync with the real
value, so reading it was legal — that is how the live hero level/exp were read. **1.00.20 zeroed the decoy
build-wide** (it reads 0). Degrading to the PLAIN substitute (the save) is *visibly* wrong for xp — the
per-run save delta jumps ~2× ([[invariants/metric-fallback-chains]]), the bug players reported. So for the
hero level/exp we now RECOVER the live value by decoding the cipher in place. The value is NOT gone: ACTk
keeps the key (`currentCryptoKey @ +0x8`) right next to `hiddenValue @ +0x4`, so a reader with both words
can invert it.

**The decode was READ FROM THE BINARY, not guessed.** A first guess (`hidden ^ key`) was REFUTED live
(garbage that jittered ±5M). Disassembling the `op_Implicit` accessors in `GameAssembly.dll` gave the real
algorithms, reimplemented in `game/obscured.py`:
- **ObscuredInt** (RVA 0x6E6CA0): `value = (hidden - key) ^ key`.
- **ObscuredFloat** (RVA 0x6E4C00): `value = float32(key ^ byteswap_1_2(hidden))` (bytes [1],[2] of
  `hidden` swapped — the ACTkByte4 shuffle — before the XOR).

Why this is recoverable WITHOUT the fragility the old guidance feared:
- **Build-independent algorithm.** We reimplement it in Python; we never resolve/call the game's decrypt
  method (its IL2CPP name is obfuscated and drifts per build — the math does not).
- **Key rotation is handled.** The caller reads `currentCryptoKey` live every tick next to `hiddenValue`;
  the key is never cached.
- **Never a silent wrong number.** the decoders return `None` if either word was unreadable (mirrors
  `ru32`→None), so the caller degrades to SAVE rather than emitting garbage (None-vs-0 discipline,
  [[invariants/metric-fallback-chains]]).

LIVE now: `game/build.read_live_party` decodes the hero LEVEL (`HeroRuntime.LEVEL_HIDDEN`/`_KEY`) and the
within-level XP (`EXP_HIDDEN`/`_KEY`); the dead `fakeValue` offsets stay only as `_raw_hero_list` history.

**What stays guarded.** The algorithm is build-INDEPENDENT, but the struct BASE can move on a recompile
(like every offset in 1.00.14) and the dev could swap the cipher. Both are caught LOUDLY by the oracle
(decoded == real level/xp) — `tests/test_obscured.py` pins the math + GOLDEN LIVE VECTORS (level 91/94/101
== save; Ranger xp exact at the cap), and `scripts/validate_live.py` should re-check it per build. That
tripwire is the "find it again, always" guarantee: a cipher change fails the gate loudly, never silently
wrong. The `Unit.CORE_STATS_OBSCURED` / `Monster.CACHE_OBSCURED` markers below remain DO-NOT-READ: those
are different Obscured fields with no validated decode and a PLAIN substitute that is already correct —
decode is only worth it where the PLAIN/SAVE substitute is visibly wrong (xp), not a blanket license.

## Orphan enum: hero class identity

A hero's class (Knight/Ranger/…) comes from **`EEquipClassType`**
(`All=0, Knight=1, Ranger=2, Sorcerer=3, Priest=4, Hunter=5, Slayer=6`) — it's the enum that
`HeroInfoData.CLASS_TYPE` indexes and that `game/build.py` maps. **NEVER** use `EHeroType`: it's an
**orphan** enum with a **different mapping**; the reader doesn't even define it in `offsets.py`. Swapping
one for the other **labels Knight as Ranger** (wrong class in the app) with no error at all — the value
"resolves", it's just semantically wrong. It's the same kind of trap as Obscured: the number you read is
plausible but meaningless.

## Related
- [[invariants/offsets-single-source]] — why the markers and the right enum live in `config/offsets.py` (and the business rule does not)
- [[invariants/memory-safety]] — the general read discipline (read-only, guarded deref); reading Obscured is the "read it, but it's garbage" case
- [[invariants/dict-strides]] — `FINAL_STATS` is a `DictFloat`; using the wrong geometry would corrupt the very stats you came to fetch in place of the Obscured ones
- [[reference/extraction-viability]] — Obscured shows up as the "not extractable" column of the viability matrix
- [[reference/run-data-map]] — the canonical PLAIN fields the reader reads per run (the right substitutes)
