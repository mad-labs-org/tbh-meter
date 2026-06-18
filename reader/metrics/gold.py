"""gold.py — GOLD PER RUN, isolated. Reads only live COMBAT gold (and nothing else).

ALL gold logic lives HERE. meter_windows just calls these functions — zero inline gold
reading there. Public API (what the orchestrator uses):
    resolve_combat_gold_klass(reader, psd_list) -> klass | None   # find the live source (1x at startup)
    combat_gold_klass_ok(reader, klass)          -> bool          # validate cached klass (cheap)
    combat_gold_live(reader, klass)              -> int  | None   # cumulative combat NOW
    combat_gold_save(reader, psd)                -> int  | None   # same number, SAVE source (fallback)
    run_gain(start, end)                         -> int  | None   # delta = gold earned in the run

═══════════════════════════════════════════════════════════════════════════════════════════
MECHANISM (nailed down live with Mario, 2026-06-05). The game keeps GoldEarn as a CUMULATIVE
Dict<SubKey, long>. The SubKeys are NOT independent parallel sources:

    SubKey 1 = COMBAT   ← what the run earned killing mobs. This is what gold-per-run wants.
    SubKey 0 = TOTAL    ← rollup (combat + sale + idle + quest). Do NOT use (counts sales).
    SubKey 2 / 3 = noise ← standalone sale/idle/quest.

SELLING an item lands in TOTAL (SubKey 0) and the wallet, but NOT in COMBAT (SubKey 1) —
validated live: in a run with a 186,480 sale, live_total − live_combat = 186,480 EXACTLY,
and live_combat stayed clean. Hence gold-per-run = delta of SubKey 1.

TWO sources of the SAME number:
  • LIVE (AggregateManager.AGGREGATES[GoldEarn][SubKey1]): real-time, exact, zero-lag. PRIMARY.
  • SAVE (PlayerSaveData.AGGREGATES, GoldEarn/SubKey1): updates in JUMPS (only on save-write,
    ~every 100s) → the per-run delta is unreliable (0 if the run falls between two writes; ~2x if
    one write catches two runs). Nailed down live: the save was off by +25k in one run and +1.18M
    in another, while the live source matched to the unit. ONLY fallback.

WHY LIVE IS HARD — and how we solved it (no new offset!):
  AggregateManager is a singleton `X : nn<X>` with an OBFUSCATED 2-letter name. That name
  DRIFTS between builds (nailed down: was "ut", became "uu") → finding by name (find_class_by_name)
  picks the WRONG class → the singleton doesn't resolve → old versions fell back to the value-scan,
  which GUESSED the cell (largest value → frozen copy → gold 0; largest growth → heap garbage →
  1.97T). The OFFSET (AGGREGATES @0x20) was always right; the problem was FINDING the live object
  without depending on the name.

  NAME-FREE resolution, by STRUCTURE (resolve_combat_gold_klass):
    1. Find the live GoldEarn inner-dict by the TWO-value signature: a Dict8B entry
       KEY==1 (SubKey1) with value ≈ combat_save AND a sibling entry KEY==0 (SubKey0) with
       value >= it. NARROW range around the save (live leads the save by a few M).
       Two billion-scale numbers, together, don't happen by accident → solid signature.
    2. WALK UP the pointers (backrefs): inner-dict → the outer-dict that references it under key
       GoldEarn(2) → the object that owns the outer-dict.
    3. CONFIRM that object is the rooted SINGLETON: the static field `nn<X>.bbwf` points back
       to it (round-trip). A frozen copy (autosave/GC leftover) is NOT rooted → it doesn't pass.
       This is OWNERSHIP, not a guess.
  Caches the KLASS (stable within the session; classes don't move). On each read, re-deref the
  singleton via bbwf (robust to GC moving the instance) and walk AGGREGATES → GoldEarn →
  SubKey1 — exactly how XP reads the live exp off the hero object.
═══════════════════════════════════════════════════════════════════════════════════════════
"""

import struct

from config.offsets import (Dict, Dict8B, Array, EAggregateType, PlayerSaveData,
                             AggregateSaveData, AggregateManager)
from game import save
from il2cpp import typeinfo
from il2cpp.finder import bbwf_from_klass
from shared.memory import scan, scan_i64_range, writable_regions

# BUSINESS rules (which SubKey means what) — these aren't offsets, so they live here with the
# logic, and NOT in config/offsets.py (which is offsets/enums only). Nailed down by live oracle.
COMBAT_SUBKEY = 1            # COMBAT GoldEarn (the gold-per-run)
TOTAL_SUBKEY = 0            # TOTAL GoldEarn (rollup; includes sales → don't use)

# Search range for the live cell = around combat_save. Live LEADS the save by the gold earned
# since the last save-write (a few M, depends on farm rate); it never falls behind. The precision
# comes from the SIGNATURE + the singleton round-trip, not the window — the range just needs to
# contain the value without sweeping half the heap (a wide range blew past the scan ceiling and
# never even reached it).
_LEAD_DOWN = 2_000_000      # slack below (read skew; live >= save)
_LEAD_UP = 60_000_000       # slack above (large lead with fast farm between save-writes)


# --------------------------------------------------------------------------- #
# SAVE (fallback) + delta
# --------------------------------------------------------------------------- #
def combat_gold_save(reader, psd):
    """Cumulative COMBAT gold from the SAVE (lagging, fallback): the AggregateSaveData with
    Type==GoldEarn AND SubKey==1. Do NOT sum all Type==GoldEarn (that caught the rollup +
    the parts = 2× plus the noise). None if not found."""
    if not psd:
        return None
    try:
        for e in reader.list_iter(reader.rptr(psd + PlayerSaveData.AGGREGATES), cap=2000):
            if (reader.ri32(e + AggregateSaveData.TYPE) == EAggregateType.GoldEarn and
                    reader.ri32(e + AggregateSaveData.SUB_KEY) == COMBAT_SUBKEY):
                return reader.ri64(e + AggregateSaveData.VALUE)
        return None
    except Exception:
        return None


def run_gain(start_value, end_value):
    """Combat gold EARNED in the run = delta of the cumulative (end − start). This IS the
    'gold per run' number: pure combat, no sale/idle/quest and no autosave double-count.

    None if a read is missing or the cumulative isn't monotonic — and in that case the caller
    must NOT fall back to the wallet-balance delta (which would include sale/idle), or the bug
    comes back."""
    if start_value is None or end_value is None or end_value < start_value:
        return None
    return end_value - start_value


# --------------------------------------------------------------------------- #
# LIVE (primary): resolve AggregateManager by STRUCTURE, read GoldEarn[SubKey1]
# --------------------------------------------------------------------------- #
def combat_gold_live(reader, klass):
    """Cumulative LIVE COMBAT gold (GoldEarn[SubKey1]) read off the AggregateManager NOW.

    Re-deref the singleton via the static field (bbwf) on every call — robust to the GC moving
    the instance (the `klass` class is stable; the instance address can change). Then walk
    AGGREGATES (outer Dict) → GoldEarn entry → inner Dict → SubKey1. None if the klass no longer
    resolves or the structure is gone → the caller falls back to the save."""
    if not klass:
        return None
    inst = bbwf_from_klass(reader, klass)
    if not inst:
        return None
    outer = reader.rptr(inst + AggregateManager.AGGREGATES)
    if not outer:
        return None
    for k, v in reader.dict8b_items(outer):
        if k == EAggregateType.GoldEarn:
            for sk, sv in reader.dict8b_items(v):       # v = pointer to the inner Dict<SubKey,long>
                if sk == COMBAT_SUBKEY:
                    return sv if (sv is not None and 0 < sv < 1_000_000_000_000_000) else None
            return None
    return None


def combat_gold_klass_ok(reader, klass):
    """True if `klass` (from the cache) still resolves a live AggregateManager with GoldEarn.
    Cheap (no scan) → lets us reuse the cache instead of re-resolving when the game didn't restart."""
    return combat_gold_live(reader, klass) is not None


def resolve_combat_gold_klass(reader, psd_list):
    """Find the LIVE AggregateManager's KLASS by STRUCTURE (name-free). Runs 1× at startup
    (and on re-attach / self-heal); the result is cacheable. None if it doesn't converge → the
    caller uses the save. See the module header for the method (2-value signature + singleton
    round-trip)."""
    sv = combat_gold_save(reader, save.pick_live_psd(reader, psd_list))
    if not sv:
        return None
    owners = _resolve_aggregate_singleton(reader, writable_regions(reader), sv)
    return owners[0][1] if owners else None      # owners = [(inst, klass)]; we want the klass


# --------------------------------------------------------------------------- #
# FAST PATH (primary): AggregateManager klass by TypeDefIndex (RVA) — no scan
# --------------------------------------------------------------------------- #
def resolve_combat_gold_klass_by_index(reader, tbase, idx_ut):
    """LIVE AggregateManager KLASS resolved by TypeDefIndex (`table[idx_ut]`) — the fast
    path that KILLS the ~90s value-scan (proof rva_probe5/6: idx_ut=2744 on v1.00.07 → klass
    identical to the value-scan's, in ~0.1ms). NAME-FREE by construction (§3): the gold singleton
    is obfuscated and the name DRIFTS (`ut`→`uu`), so resolve by INDEX, NEVER by name.

    `combat_gold_klass_ok` is the anti-poison GATE: it confirms the klass resolves a live
    AggregateManager with GoldEarn (= singleton round-trip). Bad RVA/idx (build changed, stale
    calib) → wrong klass → gate fails → None → the caller falls back to the value-scan
    (`resolve_combat_gold_klass`). Caches nothing and writes nothing — just resolves and validates."""
    K = typeinfo.class_by_index(reader, tbase, idx_ut)
    return K if (K and combat_gold_klass_ok(reader, K)) else None


def gold_index_of_klass(reader, tbase, klass):
    """Locate the TypeDefIndex of an ALREADY-resolved gold-klass, scanning the TypeInfoTable by
    value==klass (direct read, cheap; hard cap `_MAX_TABLE_ENTRIES`, §10). This is the value-scan-
    FREE part of calibration: when the legacy scan ALREADY found `gold_klass`, calibration reuses
    THIS walk instead of re-running the ~90s value-scan (and without needing `psd_list`). Name-free
    by construction. None if tbase/klass is invalid or not found."""
    if not tbase or not klass:
        return None
    for idx in range(typeinfo._MAX_TABLE_ENTRIES):
        if typeinfo.class_by_index(reader, tbase, idx) == klass:
            return idx
    return None


def find_gold_index(reader, tbase, psd_list):
    """CALIBRATION WITHOUT a pre-resolved klass: runs the value-scan ONCE (needs `psd_list` to
    anchor the range via combat_gold_save) to get the live gold-klass, then finds its index via
    `gold_index_of_klass`. PREFER `gold_index_of_klass(reader, tbase, gold_klass)` when the legacy
    scan already resolved the klass (the `_calibrate` case) — avoids the redundant ~90s value-scan.
    None if it doesn't converge → the caller keeps the value-scan on every run."""
    if not tbase:
        return None
    return gold_index_of_klass(reader, tbase, resolve_combat_gold_klass(reader, psd_list))


def gold_index_by_structure(reader, tbase):
    """idx_ut (AggregateManager's TypeDefIndex) by STRUCTURE, WITHOUT a value-scan: the SMALLEST idx
    whose `table[idx]` passes `combat_gold_klass_ok` — i.e. resolves a LIVE AggregateManager with
    GoldEarn (singleton rooted by bbwf + GoldEarn[SubKey1]). Name-free (§3): tests the SAME gate as
    the fast path by scanning the indices of the ALREADY-discovered table — never touches the
    obfuscated name (ut/uu/…).

    WHY (1.00.11): the value-scan (`resolve_combat_gold_klass`) bootstraps gold_klass by VALUE in a
    narrow range around `combat_gold_save` — fragile: if the save lags the live source (farm between
    save-writes), it doesn't converge → gold_klass None → calibration died with
    'FAILED to locate gold idx'. This walk does NOT depend on the save: proven live (gold11_diag,
    build 1.00.11) a single hit idx=2744 in <1s. PREFERABLE to `gold_index_of_klass(gold_klass)` in
    calibration because it skips the entire value-scan. None if nothing passes (ran outside combat →
    the caller keeps the scan)."""
    if not tbase:
        return None
    for idx in range(typeinfo._MAX_TABLE_ENTRIES):
        K = typeinfo.class_by_index(reader, tbase, idx)
        if K and combat_gold_klass_ok(reader, K):
            return idx
    return None


# --------------------------------------------------------------------------- #
# internals (the structural "walk-up") — all private; only resolve_combat_gold_klass uses them
# --------------------------------------------------------------------------- #
def _backrefs(reader, wregs, targets):
    """{target: [8-aligned addresses that CONTAIN a pointer == target]}. Finds who points
    to each target. After the structural filters the targets are FEW (≈1), so the pointer
    scan (C, fast) is cheap. 1 scan resolves all targets at once."""
    needles = {struct.pack("<Q", t): t for t in targets if t}
    res = scan(reader, wregs, list(needles.keys()), aligned=True) if needles else {}
    return {t: res.get(nd, []) for nd, t in needles.items()}


def _inner_array_of(reader, c, cval):
    """Base of the entries-array of the GoldEarn inner-dict that contains the cell `c` (=SubKey1=cval).
    Validates the SIGNATURE: SubKey1==cval AND SubKey0 present with total>=combat. Deterministic
    and specific → ~zero false positives. None if it doesn't match."""
    for j in range(16):                                            # index of the SubKey1 entry
        a = c - Dict8B.VALUE - Dict.DATA - j * Dict8B.STRIDE       # entries-array candidate
        subs = {}
        for i in range(16):
            e = a + Dict.DATA + i * Dict8B.STRIDE
            h = reader.ri32(e + Dict8B.HASH)
            if h is None:
                break
            if h < 0:                                              # tombstone
                continue
            k = reader.ri32(e + Dict8B.KEY)
            v = reader.ri64(e + Dict8B.VALUE)
            if k is not None and v is not None and 0 <= k <= 3:
                subs.setdefault(k, v)
        if subs.get(COMBAT_SUBKEY) == cval and TOTAL_SUBKEY in subs and subs[TOTAL_SUBKEY] >= cval:
            return a
    return None


def _array_base_of_slot(reader, loc, maxidx=128):
    """Given a VALUE-slot `loc` (entry+0x10) inside an entries-array, find the array base by
    local search (plausible MAX_LENGTH + valid klass pointer). None if not found."""
    for i in range(maxidx):
        a = loc - Dict8B.VALUE - Dict.DATA - i * Dict8B.STRIDE
        ml = reader.ri32(a + Array.MAX_LENGTH)
        kls = reader.rptr(a)
        if ml is not None and i < ml <= 8192 and kls and kls > 0x10000:
            return a
    return None


def _dict_owning_array(reader, wregs, arr):
    """Dict-objs D such that D+ENTRIES == arr (found by backref to the array)."""
    out = []
    for loc in _backrefs(reader, wregs, [arr]).get(arr, []):
        d = loc - Dict.ENTRIES
        if reader.rptr(d + Dict.ENTRIES) == arr:
            cnt = reader.ri32(d + Dict.COUNT)
            if cnt is not None and 0 <= cnt <= 100000:
                out.append(d)
    return out


def _resolve_aggregate_singleton(reader, wregs, sv):
    """Find [(inst, klass)] of the LIVE AggregateManager by STRUCTURE, name-free, in ~4 batched
    scans (independent of the number of candidates). sv = combat_gold_save (center of the narrow
    range). The live cell is the only GoldEarn[SubKey1] that walks up, via backrefs, to a rooted
    SINGLETON (bbwf round-trip); frozen copies stop short. List (≈1 element) or []."""
    lo, hi = max(0, sv - _LEAD_DOWN), sv + _LEAD_UP
    arrays = {}                                       # A_in (inner dict's entries-array) -> cval
    for c in scan_i64_range(reader, wregs, lo, hi):
        cv = reader.ri64(c)
        if cv is None:
            continue
        a = _inner_array_of(reader, c, cv)
        if a:
            arrays.setdefault(a, cv)
    if not arrays:
        return []
    dins = set()                                      # A_in -> D_in (inner dict object)
    for a, locs in _backrefs(reader, wregs, list(arrays.keys())).items():
        for loc in locs:
            d = loc - Dict.ENTRIES
            if reader.rptr(d + Dict.ENTRIES) == a:
                cnt = reader.ri32(d + Dict.COUNT)
                if cnt is not None and 0 <= cnt <= 100000:
                    dins.add(d)
    slots = []                                        # D_in -> outer-dict slot with KEY==GoldEarn(2)
    for _, locs in _backrefs(reader, wregs, list(dins)).items():
        for loc in locs:
            if reader.ri32(loc - (Dict8B.VALUE - Dict8B.KEY)) == EAggregateType.GoldEarn:
                slots.append(loc)
    aouts = set()                                     # slot -> A_out (outer dict's entries-array)
    for slot in slots:
        a_out = _array_base_of_slot(reader, slot)
        if a_out:
            aouts.add(a_out)
    douts = set()                                     # A_out -> D_out
    for a, locs in _backrefs(reader, wregs, list(aouts)).items():
        for loc in locs:
            d = loc - Dict.ENTRIES
            if reader.rptr(d + Dict.ENTRIES) == a:
                douts.add(d)
    owners, seen = [], set()                          # D_out -> INST (confirms rooted singleton)
    for _, locs in _backrefs(reader, wregs, list(douts)).items():
        for loc in locs:
            inst = loc - AggregateManager.AGGREGATES
            kk = reader.rptr(inst)                     # Obj.KLASS @ +0x0
            if kk and inst not in seen and bbwf_from_klass(reader, kk) == inst:
                seen.add(inst)
                owners.append((inst, kk))
    return owners
