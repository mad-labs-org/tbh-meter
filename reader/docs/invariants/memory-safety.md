---
type: invariant
description: "The reader is READ-ONLY (handle PROCESS_QUERY_INFORMATION|PROCESS_VM_READ, ZERO WriteProcessMemory/inject) and DEFENSIVE: read/ri32/ri64/rptr return None on a bad read and the caller handles None before arithmetic; every deref checks null; dict8b_items/list_ptrs have a cap so a corrupt struct can't loop forever."
symptoms:
  - "crash reading memory"
  - "null pointer"
  - "WriteProcessMemory"
  - "write to game memory"
  - "inject"
  - "anti-cheat"
  - "ACTk"
  - "iteration cap"
  - "infinite read loop"
  - "TypeError NoneType arithmetic"
  - "unhandled None"
code_anchors:
  - shared/memory.py::open_process
  - shared/memory.py::Reader.read
  - shared/memory.py::Reader.ri32
  - shared/memory.py::Reader.ri64
  - shared/memory.py::Reader.rptr
  - shared/memory.py::Reader.read_string
  - shared/memory.py::Reader.dict8b_items
  - shared/memory.py::Reader.list_ptrs
asserts:
  - config.offsets.Dict8B.STRIDE == 0x18
---

# Memory safety (read-only + defensive reads)

Every interaction with the game goes through `shared.memory` — the only module that touches the process.
It holds TWO invariants that, if broken, either crash the reader or trip the anti-cheat.

## 1. READ-ONLY, no exceptions

The ONLY attach point is `open_process`, and it opens the handle with
`PROCESS_QUERY_INFORMATION | PROCESS_VM_READ` — **no write flag whatsoever** (no
`PROCESS_VM_WRITE`/`PROCESS_VM_OPERATION`). There is no `WriteProcessMemory`, `VirtualProtectEx`,
nor injection anywhere in the reader (grep-verifiable: zero hits). `_kernel32()` only registers
`ReadProcessMemory` + the enumeration APIs (Toolhelp/`VirtualQueryEx`/`QueryFullProcessImageNameW`).

**Why this is inviolable:** the game runs **ACTk** (anti-cheat). The reader is an unsigned
sidecar that already flirts with AV false-positives (see [[invariants/cache-management]] on the
`blocked` state). Any write or injection turns "passive reader" into "detectable cheat" —
player ban and death of the project. Resolving a class/instance is a **read scan**
(`scan`/`scan_i64_range` unpack qwords; never write), and the live singleton is found by
STRUCTURE, not by patching (see [[invariants/rva-index-resolution]]). **Never** add a write
"just to test".

## 2. Defensive reads: None at the source, handled in the caller

The address you hold now may have been freed by the next tick (object dies in the fight,
GC moves it, game closes). So the core `Reader.read` is defensive by construction: it returns `None` if
the address is falsy, if `size <= 0`, or if `ReadProcessMemory` fails — **it never raises**. On top
of that, the typed primitives (`ri32`/`ri64`/`ru32`/`ru64`/`rptr`/`rf32`) only unpack when the
bytes came back at the exact size, otherwise they return `None`. `read_string`/`read_cstr` check for a
null address and a sentinel size (`String.LENGTH` outside `[0, 4096]` → `None`) before decoding.

**The rule for the caller:** `None` means "bad read", not "value zero". The caller **must
handle `None` BEFORE any arithmetic/comparison** — otherwise it's `TypeError: unsupported
operand … NoneType` in the middle of the capture loop. The pattern is the early-return:

```python
p = reader.rptr(addr)
if not p:        # None OR 0 — both "no object", deref aborts here
    return None
```

This is the contract the orchestrator and the metrics ASSUME: the lifecycle scaffold
([[invariants/run-lifecycle]]) uses "read failing = game closed" as a legitimate signal, and the
fallback chains ([[invariants/metric-fallback-chains]]) treat `None` as "this source didn't deliver, try
the next". The structural manager validation ([[invariants/instance-selection]]) can only
tell a live list from garbage because a read on an invalid slot returns `None`/garbage instead of
blowing up. Don't swap the early-return for a masked default value — a `0` in place of `None`
becomes silent bad data.

## 3. Cap on every container iterator

A corrupt struct (or a scan false-positive) can declare a giant `count`/`size` and
make the reader iterate "forever" over garbage. That's why **every container iterator has a ceiling**:
`list_ptrs`/`list_iter` abort (empty list) if `size` is negative or exceeds the `cap`;
`dict8b_items` gives up if the `count` exceeds the `cap` AND also caps the number of slots scanned
(`limit = count + 64`) so it doesn't run past the real entries while skipping tombstones (`hash < 0`).
The `cap` is a KWARG with a per-caller default — don't hardcode the number in the body; `dict8b_items` uses the
`Dict8B.STRIDE` stride (never `DictFloat`'s, see [[invariants/dict-strides]]).

## Related
- [[invariants/run-lifecycle]] — the scaffold treats "read failing" as "game closed"; assumes the reader never-raises.
- [[invariants/metric-fallback-chains]] — `None`-on-bad-read is the signal "this source failed, go to the next".
- [[invariants/instance-selection]] — you can only validate a live List<T> vs. garbage because the read returns None/garbage, not a crash.
- [[invariants/dict-strides]] — the `dict8b_items` cap goes hand in hand with the correct stride.
- [[invariants/rva-index-resolution]] — the resolver is read/scan only; never patches.
- [[invariants/cache-management]] — AV/ACTk can block the unsigned reader (`blocked` state).
See also: [[invariants/obscured-data-offlimits]] (read the PLAIN fakeValue via Reader, never the hidden^key)
