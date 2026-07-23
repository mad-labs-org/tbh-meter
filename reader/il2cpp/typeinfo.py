"""typeinfo.py — IL2CPP resolution via FIXED RVA + TypeInfoTable (read-only, name-free).

Kills the cold-start scan: instead of sweeping ~2.6 GB looking for the class strings, it reads the
IL2CPP runtime's TypeInfoTable via a FIXED-RVA ANCHOR inside GameAssembly.dll and indexes classes
by TypeDefIndex (a build constant). The Il2CppClass objects live on the heap (ASLR), BUT the table
pointer lives at a fixed module RVA, rewritten by the runtime on each launch — reading
`[ga_base + ANCHOR_RVA]` live gives the current base. Indices are build constants.

PROVEN CHAIN (build v1.00.07; see tasks/meter-rva-startup/README.md):
    ga_base + ANCHOR_RVA → s_TypeInfoTable (heap pointer)
    table_base + TypeDefIndex*8 → Il2CppClass*

These are JUST the pure primitives — NO wiring into resolve_all/meter_windows (that comes in the
following deliverables). Mirrors the proven logic in the probes tbh-meter-dev/rva_probe{3,6,7}.py.

INVARIANTS (tbh-meter-review):
  §3 NAME-FREE — classes come by INDEX/STRUCTURE. `class_name` ONLY validates, NEVER picks a class.
  §10 MEMORY SAFETY — read-only; every rptr/ri32 checks None before use; walks are capped.
  §2 OFFSETS — uses Class.* from config/offsets.py. PE-FORMAT offsets and IL2CPP-runtime struct
     offsets are NOT game offsets (dump.cs) — they're OS/runtime layout, so they live here as
     documented module constants (don't duplicate them in offsets.py).
  Importable on mac — kernel32 is lazy (reuses shared.memory._kernel32), doesn't fire WinDLL on import.
"""

import ctypes
import struct
from ctypes import wintypes

from config.offsets import Class
from shared import memory
from shared.memory import MODULEENTRY32

# --------------------------------------------------------------------------- #
# PE-FORMAT constants (Windows DLL) — NOT game offsets (dump.cs); they're the
# PE/COFF header layout, fixed by the OS. That's why they live here, not in offsets.py.
# Ref: PE/COFF spec (DOS header e_lfanew @0x3C; "PE\0\0" sig; COFF + Optional Header).
# --------------------------------------------------------------------------- #
PE_LFANEW = 0x3C            # DOS header: offset (DWORD) to the PE signature
PE_SIG = b"PE\x00\x00"      # signature right at [base + e_lfanew]
PE_TIMEDATESTAMP = 0x8      # COFF FileHeader: TimeDateStamp (DWORD), relative to the PE sig
PE_SIZEOFIMAGE = 0x18 + 0x38  # Optional Header (after the COFF's 0x18) + offset 0x38 = SizeOfImage

# Toolhelp module-snapshot flags (same as shared.memory; replicated for local readability).
TH32CS_SNAPMODULE = memory.TH32CS_SNAPMODULE
TH32CS_SNAPMODULE32 = memory.TH32CS_SNAPMODULE32

# Walk caps (§10): max number of entries to walk in the TypeInfoTable and the block size read
# per syscall. The proven build's table has a few thousand slots; 40k is ample slack.
_TABLE_BLOCK = 8192         # ptrs read per syscall in the walk (1 read instead of N)
_MAX_TABLE_ENTRIES = 40000  # hard walk cap (§10 — don't walk forever on a corrupt table)

# Plausible bounds for an Il2CppClass* on x64 (same criterion as the probes / is_class).
_K_MIN = 0x10000
_K_MAX = 0x7FFFFFFFFFFF


def ga_module(pid):
    """Load base and size of process `pid`'s GameAssembly.dll, via a Toolhelp module
    snapshot. (base:int|None, size:int|None) — (None, None) if not found/on failure.

    Reuses shared.memory's lazy kernel32 BUT sets the Module32First/Next argtypes here:
    shared's _kernel32() sets them too, but the probes required setting them explicitly so as
    not to TRUNCATE the 64-bit handle (ctypes assumes 32-bit int without argtypes). Defensive and cheap."""
    if memory._IS_LINUX:
        return memory.module_span(pid, "GameAssembly.dll")
    k = memory._kernel32()
    k.Module32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
    k.Module32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
    snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if not snap or snap == memory.INVALID_HANDLE:
        return None, None
    try:
        e = MODULEENTRY32()
        e.dwSize = ctypes.sizeof(MODULEENTRY32)
        ok = k.Module32First(snap, ctypes.byref(e))
        while ok:
            if e.szModule.lower() == b"gameassembly.dll":
                return int(e.modBaseAddr), int(e.modBaseSize)
            ok = k.Module32Next(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    return None, None


def build_fingerprint(reader, base, version=None):
    """GameAssembly.dll build identity = key of the calibration cache. None if the PE header
    can't be read (caller falls back to the scan).

    fp = f"{version}-{TimeDateStamp:#x}-{SizeOfImage:#x}".

    AMENDMENT R1: TimeDateStamp can be 0 (deterministic/reproducible builds) and SizeOfImage can
    collide across rebuilds → reinforce with the installed VERSION (Version.txt, via
    _detect_game_version in the caller). If TimeDateStamp==0, do NOT use it as an identity
    component (it becomes "0x0" but version + SizeOfImage carry the identity; the caller logs it
    and may fall back to the scan if suspicious). Build v1.00.07 = TimeDateStamp 0x6a203f51,
    SizeOfImage 0x62ea000."""
    if not base:
        return None
    e_lfanew = reader.ri32(base + PE_LFANEW)
    if not e_lfanew:
        return None
    pe = base + e_lfanew
    if reader.read(pe, 4) != PE_SIG:
        return None
    tds = reader.ri32(pe + PE_TIMEDATESTAMP)
    soi = reader.ri32(pe + PE_SIZEOFIMAGE)
    if tds is None or soi is None:
        return None
    tds &= 0xFFFFFFFF
    soi &= 0xFFFFFFFF
    ver = version if version else "?"
    return f"{ver}-{tds:#x}-{soi:#x}"


def table_base(reader, ga_base, anchor_rva):
    """Current base of s_TypeInfoTable = the live pointer at [ga_base + anchor_rva]. None if null
    (wrong anchor / module not yet initialized)."""
    if not ga_base or anchor_rva is None:
        return None
    return reader.rptr(ga_base + anchor_rva)


def class_by_index(reader, tbase, idx):
    """Il2CppClass* at TypeDefIndex `idx` = [tbase + idx*8]. None if null. Does NOT validate that
    it's a class (use class_name to validate) — it's just the raw table deref."""
    if not tbase or idx is None or idx < 0:
        return None
    return reader.rptr(tbase + idx * 8)


def class_name(reader, K):
    """VALIDATES that K is an Il2CppClass and returns its name, or None. ONLY for VALIDATION (§3) —
    NEVER for picking a class (that's by index). Criterion (identical to the probes):
      • bounds: _K_MIN <= K <= _K_MAX and 8-aligned;
      • nm = read_cstr([K + Class.NAME]) non-empty;
      • class round-trip: [K + Class.ELEMENT_CLASS]==K OR [K + Class.CAST_CLASS]==K
        (a normal-type Il2CppClass points element/cast at itself)."""
    if not K or K < _K_MIN or K > _K_MAX or (K & 0x7):
        return None
    nm = reader.read_cstr(reader.rptr(K + Class.NAME))
    if not nm:
        return None
    if reader.rptr(K + Class.ELEMENT_CLASS) == K or reader.rptr(K + Class.CAST_CLASS) == K:
        return nm
    return None


def walk_table_names(reader, tbase, wanted, maxn=_MAX_TABLE_ENTRIES):
    """Walks the TypeInfoTable reading names and collects {name: K} for those in `wanted`.
    SCAN-FREE calibration (~0.1s in the proof): reads in blocks of _TABLE_BLOCK ptrs per syscall,
    validates each non-null ptr with class_name, early-exits once it finds ALL. `maxn` is the hard
    cap (§10). `wanted` = set/iterable of STABLE (non-obfuscated) names; name-free still holds
    because the OUTPUT is index→class, and the names only identify which slots matter."""
    want = set(wanted)
    out = {}
    if not tbase or not want:
        return out
    i0 = 0
    while i0 < maxn and len(out) < len(want):
        n = min(_TABLE_BLOCK, maxn - i0)
        b = reader.read(tbase + i0 * 8, n * 8)
        if not b:
            break
        m = len(b) // 8
        if m == 0:
            break
        ptrs = struct.unpack("<%dQ" % m, b[:m * 8])
        for K in ptrs:
            if not K:
                continue
            nm = class_name(reader, K)
            if nm in want and nm not in out:
                out[nm] = K
                if len(out) == len(want):
                    break
        i0 += m
    return out


def _walk_dense_table_start(reader, seed_slot, regs, cap=0x800000):
    """Given a SLOT (an address holding a known Il2CppClass*), finds where the DENSE array of
    Il2CppClass* containing it STARTS, walking backward page by page while the page stays
    mostly filled with plausible class pointers. Mirrors walk_bounds in rva_probe3 (generous
    seed; the full verification in discover_anchor is what nails it down). `regs` bounds the
    region (don't leave it). None if the seed isn't even in a known region."""
    if not memory.in_region(regs, seed_slot):
        return None

    def filled_ratio(page):
        b = reader.read(page, 4096)
        if not b or len(b) < 64:
            return 0.0
        m = len(b) // 8
        vals = struct.unpack("<%dQ" % m, b[:m * 8])
        good = sum(1 for v in vals if _K_MIN <= v <= _K_MAX and not (v & 0x7))
        return good / m

    pg = seed_slot & ~0xFFF
    low = pg
    while low > pg - cap and memory.in_region(regs, low - 0x1000) and filled_ratio(low - 0x1000) >= 0.45:
        low -= 0x1000
    return low


def discover_anchor(reader, ga_base, ga_size, known_K, regs):
    """DISCOVERS the (anchor_rva, table_base, indices) at CALIBRATION time, DETERMINISTICALLY
    (no fuzzy search). `known_K` = {name: K} of classes ALREADY resolved (by the legacy scan);
    `regs` = READABLE regions already enumerated by resolve_all (do NOT re-enumerate — the sweep is
    expensive). Returns (anchor_rva, table_base, {name: idx}) or None if it doesn't converge (caller
    keeps the scan).

    AMENDMENT R1 + NEW-4 (deterministic, derives from ONE slot and VERIFIES the whole table):
      (1) backref of ONE known_K (one big sweep over READABLE) → candidate slots that CONTAIN that
          pointer (uses shared.memory.scan with an 8-aligned needle, like gold._backrefs);
      (2) for each slot, derive where the dense Il2CppClass* array STARTS (_walk_dense_table_start,
          generous window — indices are SPARSE, e.g. StageManager 2592 ↔ HeroInfoData 3198, so a
          tight window FALSE-FAILS);
      (3) FULL VERIFICATION (false-pass-proof): for a table_base candidate, compute
          idx[name] = (known_K's slot - table_base)/8 and confirm class_by_index→name for ALL the
          known_K via a class_name round-trip. Only accept if ALL match;
      (4) find the IN-MODULE ptr (in [ga_base, ga_base+ga_size)) whose value == table_base →
          anchor_rva = loc - ga_base. Returns the verified indices (no separate walk)."""
    known = {nm: K for nm, K in (known_K or {}).items() if K}
    if not ga_base or not ga_size or len(known) < 3:
        return None

    # (1) backref of ONE known_K — a single big sweep. Picks a deterministic one (smallest name).
    seed_name = sorted(known)[0]
    seed_K = known[seed_name]
    needle = struct.pack("<Q", seed_K)
    seed_slots = memory.scan(reader, regs, [needle], aligned=True).get(needle, [])
    if not seed_slots:
        return None

    # (2)+(3): for each seed slot, derive the dense array's base and VERIFY the whole table.
    # We only have the seed's backref (one sweep). We derive the table_base candidate from the
    # seed's slot, confirm the seed's INDEX matches by name, and then require that ALL the known_K
    # appear at some index (a direct, cheap table read) — false-pass-proof verification. A generous
    # window in the walk avoids a false-fail on sparse indices.
    tested = set()
    for slot in seed_slots:
        cand = _walk_dense_table_start(reader, slot, regs)
        if not cand or cand in tested:
            continue
        tested.add(cand)
        # `cand` is APPROXIMATE: the walk stops a few entries ABOVE the real base (low indices —
        # engine types — are sparse/low-fill). CHEAP pre-filter (no module sweep): the table from
        # `cand` must contain ALL the known_K; otherwise `cand` is garbage, skip it.
        if _verify_table(reader, cand, known) is None:
            continue
        # The in-module anchor holds the TRUE base (== or slightly BELOW `cand`), NOT `cand`. Find
        # it by RANGE and RE-VERIFY the table from the real value (authoritative). An EXACT match on
        # `cand` failed — the global holds the real base, not the walk's approximate base; that was
        # the bug that stalled calibration even on the proven build (rva_probe3 uses range).
        res = _find_table_anchor(reader, ga_base, ga_size, cand, known, regs)
        if res is not None:
            return res
    return None


def _verify_table(reader, tbase, known):
    """Confirms that ALL the known_K appear at some index in table `tbase` (a direct, cheap read)
    via a name round-trip. Returns {name: idx} if ALL match, else None (rejects the candidate →
    false-pass-proof)."""
    want_by_K = {K: nm for nm, K in known.items()}
    found = {}
    i0 = 0
    while i0 < _MAX_TABLE_ENTRIES and len(found) < len(known):
        n = min(_TABLE_BLOCK, _MAX_TABLE_ENTRIES - i0)
        b = reader.read(tbase + i0 * 8, n * 8)
        if not b:
            break
        m = len(b) // 8
        if m == 0:
            break
        ptrs = struct.unpack("<%dQ" % m, b[:m * 8])
        for j, K in enumerate(ptrs):
            if K in want_by_K:
                nm = want_by_K[K]
                if nm not in found and class_name(reader, K) == nm:
                    found[nm] = i0 + j
        i0 += m
    return found if len(found) == len(known) else None


def _find_table_anchor(reader, ga_base, ga_size, approx_base, known, regs):
    """Finds the in-module ANCHOR: an 8-aligned ptr in [ga_base, ga_base+ga_size) whose VALUE is the
    table's TRUE base. `_walk_dense_table_start` stops a few entries ABOVE the real base (sparse low
    indices) → the anchor does NOT hold `approx_base`, but the real base (== or slightly below).
    Sweeps the module for ptrs with a value NEAR `approx_base` and, for each candidate value,
    RE-VERIFIES the whole table from it (authoritative). Returns
    (anchor_rva, real_base, {name: idx}) or None. Mirrors rva_probe3's search by RANGE."""
    lo, hi = ga_base, ga_base + ga_size
    modregs = [(b, s) for (b, s) in regs if lo <= b < hi]
    # the real base is AT or slightly BELOW approx_base (the walk stops high, never below).
    locs = memory.scan_i64_range(reader, modregs, approx_base - 0x10000, approx_base + 0x1000)
    seen, cands = set(), []
    for loc in locs:
        v = reader.rptr(loc)
        if v and v not in seen:
            seen.add(v)
            cands.append((v, loc))
    for val, loc in sorted(cands):              # smallest value first = closest to index 0
        idxs = _verify_table(reader, val, known)
        if idxs is not None:
            return loc - ga_base, val, idxs
    return None
