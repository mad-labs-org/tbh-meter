---
type: invariant
description: "There are TWO IL2CPP Dictionary entry geometries — DictFloat (stride 0x10, float value @0xC) for the 64 stats vs Dict8B (stride 0x18, 8B value @0x10) for gold/aggregates. Mixing up the strides corrupts gold/xp/stats SILENTLY (no crash). Always the named constants, never a bare literal."
symptoms:
  - "doubled gold"
  - "wrong gold"
  - "wrong xp"
  - "wrong stats"
  - "garbage stats"
  - "corrupted values"
  - "dict stride"
  - "swapped stride"
  - "wrong stride"
  - "1.97T"
code_anchors:
  - config/offsets.py::DictFloat.STRIDE
  - config/offsets.py::Dict8B.STRIDE
  - shared/memory.py::dict8b_items
asserts:
  - config.offsets.DictFloat.STRIDE == 0x10
  - config.offsets.DictFloat.VALUE == 0xC
  - config.offsets.Dict8B.STRIDE == 0x18
  - config.offsets.Dict8B.VALUE == 0x10
guarded_by:
  - tests/test_offsets.py::TestDictStrides::test_strides_are_distinct
  - tests/test_offsets.py::TestDictStrides::test_dict_float_value_at_0xC
  - tests/test_offsets.py::TestDictStrides::test_dict_8b_value_at_0x10
---

# Dictionary geometries (DictFloat vs Dict8B)

The game stores two kinds of `Dictionary<K,V>` that the reader reads, and the **`Entry`
layout differs between them** because `V` has a different size. The two geometries are the
`DictFloat` class and the `Dict8B` class in offsets.py. They **share** the entry header
(`HASH` at the start, `NEXT`, and `KEY` as int32 — all in the same place), and diverge in
**exactly two fields**: the `STRIDE` (entry size) and the `VALUE` (where the value lives).
That partial sharing is the trap — the agent sees `KEY` at the same offset and assumes the
rest lines up too.

| geometry | `STRIDE` | `VALUE` | value type | used for |
|-----------|----------|---------|---------------|------------|
| `DictFloat` | `0x10` | `0xC` | `float32` (4B) | `Dict<StatType,float>` — the 64 final stats (via `StatsHolder.FINAL_STATS`) |
| `Dict8B` | `0x18` | `0x10` | `int64` OR pointer (8B) | the gold `Dict<int,long>`, and the aggregates `Dict<EAggregateType,Dict>` |

`DictFloat`'s 4-byte value fits in a `0x10` entry. `Dict8B`'s 8-byte value pushes the
`VALUE` to `0x10` (8-byte alignment) and the whole entry to `0x18`.

**The rule:** when iterating a dictionary's entries, pick the geometry by the **value type
the class declares in the dump**, and use the **named constants** (`DictFloat.STRIDE`/
`DictFloat.VALUE` or `Dict8B.STRIDE`/`Dict8B.VALUE`) — never a bare offset literal. Skipping
tombstones in both is `HASH < 0` (negative hash = removed entry). For any `Dict8B` there is a
single reusable reader, `dict8b_items` (in shared/memory.py): it already does `STRIDE 0x18`,
`KEY @0x8`, `VALUE @0x10` and the tombstone skip — its own docstring warns it is **NOT for
`DictFloat`**. Don't grow a second ad-hoc walker with literals: reuse `dict8b_items` for 8B
and respect `DictFloat` for the stats.

**Why it corrupts SILENTLY (no crash):** swapping the stride doesn't break the read — it just
misaligns it. Reading a `Dict8B` with `STRIDE 0x10` makes every entry from the second on land
in the middle of the previous entry → `KEY`/`VALUE` read from arbitrary bytes (this is how bad
value-scans reached phantom gold like `1.97T`). Reading the stats dictionary (`DictFloat`) with
`STRIDE 0x18` / `VALUE @0x10` skips 8 bytes per entry and reads the value outside the float cell →
64 stats full of garbage. In neither case is there an exception: the reader emits **wrong numbers**
that only surface when you check gold/xp/stats against the game. That's why
`test_offsets.py::TestDictStrides` locks the two strides as **distinct** and pins each `VALUE` —
it's the guard against the silent merge of the two geometries.

Gold is the slipperiest case because it chains **two** `Dict8B`: the outer
`Dict<EAggregateType,Dict>` (whose `VALUE @0x10` is the **pointer** to the inner dict) and the
inner `Dict<SubKey,long>` (whose `VALUE @0x10` is the accumulated **long**). Both are `Dict8B` —
the same geometry, read by the same `dict8b_items`. How to read/sum the right SubKeys is another
invariant (see gold).

## Related
- [[invariants/gold-singleton-resolution]] — reads the TWO chained `Dict8B` of `GoldEarn` (outer→pointer, inner→long).
- [[invariants/metric-fallback-chains]] — wrong gold/xp from a swapped stride triggers the fallback, which MASKS the bug silently.
