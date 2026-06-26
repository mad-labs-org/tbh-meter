"""LogScanCursor — rotation-aware detection of NEW LogManager.LOG_LIST entries.

The run-close boundary (StageClearLog/StageFailedLog + GetBox/HeroDie/Resurrection) is
detected by scanning the LOG_LIST's NEW entries each tick. The list is CAPPED at 2000
(metrics/events.py documents the cap); once full the game evicts from the HEAD to stay at
the cap, so ABSOLUTE indices shift DOWN. The pre-fix loop used an absolute-index cursor
(`[last_size, size)`, fired only on `size > last_size`): after the cap saturated, `size`
stopped growing, the scan never ran again, and EVERY subsequent StageClearLog was missed —
runs only closed via the "abandoned" path (clear_time=0) and one open run accumulated several
stages (live mobs 1703/652). A reader/game restart did NOT fix it (the game process keeps the
saturated list; the cursor just re-seeds to the cap).

These tests pin the rotation-aware contract: identity is the entry's OBJECT POINTER (the list
slot's value — each LogData is a managed object), never its index, so head-eviction can't
desync detection. Guards docs/invariants/run-lifecycle + docs/invariants/log-event-detection."""

from meter_windows import LogScanCursor


def _fake_list(ptrs):
    """A read_ptr_at(i) over a Python list of entry pointers (oldest->newest), mirroring
    reader.rptr(items + Array.DATA + i*8). Out-of-range / None slot -> None (a bad read)."""
    def read_ptr_at(i):
        return ptrs[i] if 0 <= i < len(ptrs) and ptrs[i] else None
    return read_ptr_at


CAP = 300   # per-tick scan cap (same magnitude as the pre-fix min(size, last_size+300))


class TestSeedSkipsBacklog:
    """On attach / re-resolve the cursor SEEDs to the current tail WITHOUT replaying the
    pre-existing backlog as 'new' — the exact semantic of the old `last_size = current size`.
    Otherwise the whole history of a long session would be re-processed as clears on attach."""

    def test_seed_yields_nothing_and_marks_tail_seen(self):
        ptrs = [100, 200, 300]
        c = LogScanCursor()
        c.seed(_fake_list(ptrs), len(ptrs), CAP)
        # nothing new right after seeding the same list
        assert c.new_entries(_fake_list(ptrs), len(ptrs), CAP) == []

    def test_unseeded_first_call_self_seeds_no_replay(self):
        # defensive: new_entries before an explicit seed must NOT replay the backlog.
        ptrs = [100, 200, 300]
        c = LogScanCursor()
        assert c.new_entries(_fake_list(ptrs), len(ptrs), CAP) == []


class TestAppendOnlyGrowth:
    """Regression: the normal case (list below the cap, only grows at the tail) keeps working —
    each new entry is returned exactly once, in order."""

    def test_single_new_entry(self):
        c = LogScanCursor()
        c.seed(_fake_list([10, 20]), 2, CAP)
        assert c.new_entries(_fake_list([10, 20, 30]), 3, CAP) == [30]

    def test_multiple_new_entries_in_order(self):
        c = LogScanCursor()
        c.seed(_fake_list([10, 20]), 2, CAP)
        assert c.new_entries(_fake_list([10, 20, 30, 40, 50]), 5, CAP) == [30, 40, 50]

    def test_no_growth_yields_nothing(self):
        c = LogScanCursor()
        c.seed(_fake_list([10, 20]), 2, CAP)
        same = _fake_list([10, 20])
        assert c.new_entries(same, 2, CAP) == []
        assert c.new_entries(same, 2, CAP) == []

    def test_each_entry_returned_only_once_across_ticks(self):
        c = LogScanCursor()
        c.seed(_fake_list([1]), 1, CAP)
        assert c.new_entries(_fake_list([1, 2]), 2, CAP) == [2]
        assert c.new_entries(_fake_list([1, 2, 3]), 3, CAP) == [3]
        assert c.new_entries(_fake_list([1, 2, 3]), 3, CAP) == []


class TestCapRotation:
    """THE BUG. The list is pinned at the cap and rotates (evict head, append at tail) so size
    NEVER changes. The pre-fix absolute-index scan fired only on `size > last_size` and so missed
    EVERY post-cap entry. Pointer identity detects the tail append regardless of size/index."""

    def test_rotation_with_size_pinned_detects_new_tail_entry(self):
        cap_len = 2000
        before = list(range(1, cap_len + 1))          # pointers 1..2000, size == cap
        c = LogScanCursor()
        c.seed(_fake_list(before), cap_len, CAP)
        # rotate: evict the head (1), append a NEW entry (9999) at the tail; size STILL 2000.
        after = before[1:] + [9999]
        assert len(after) == cap_len                   # size unchanged — the pre-fix killer
        assert c.new_entries(_fake_list(after), cap_len, CAP) == [9999]

    def test_repeated_rotation_each_new_tail_detected_once(self):
        cap_len = 2000
        lst = list(range(1, cap_len + 1))
        c = LogScanCursor()
        c.seed(_fake_list(lst), cap_len, CAP)
        seen_new = []
        for newp in (9001, 9002, 9003):
            lst = lst[1:] + [newp]                      # one eviction + one append per tick
            seen_new += c.new_entries(_fake_list(lst), cap_len, CAP)
        assert seen_new == [9001, 9002, 9003]

    def test_multiple_appends_during_one_rotated_tick(self):
        # the reader stalled a tick: several entries appended (with head eviction) since last scan.
        cap_len = 2000
        lst = list(range(1, cap_len + 1))
        c = LogScanCursor()
        c.seed(_fake_list(lst), cap_len, CAP)
        lst = lst[3:] + [7001, 7002, 7003]              # 3 evicted, 3 appended; size pinned
        assert c.new_entries(_fake_list(lst), cap_len, CAP) == [7001, 7002, 7003]


class TestClearThenBoxOrderingAcrossRotation:
    """The pending-close (run-lifecycle) depends on detection ORDER: the StageClearLog must surface
    BEFORE its trailing boss GetBoxLog so close_run opens the pending and the box is then absorbed
    into it (not credited to the next run). The boss box trails the clear ~0.6s — it can land a tick
    later (separate growth) OR in the same batch. The cursor yields oldest->newest, so the close
    always precedes the box. This pins that property under cap-rotation (where the bug lived)."""

    CLEAR, BOX = 0xC1EA, 0xB0C5    # sentinel pointers standing in for StageClearLog / GetBoxLog

    def test_clear_then_box_separate_rotated_ticks(self):
        cap_len = 2000
        lst = list(range(1, cap_len + 1))
        c = LogScanCursor()
        c.seed(_fake_list(lst), cap_len, CAP)
        # tick N: clear appended at the tail (head evicted), size pinned -> close opens the pending.
        lst = lst[1:] + [self.CLEAR]
        assert c.new_entries(_fake_list(lst), cap_len, CAP) == [self.CLEAR]
        # tick N+1: the boss box appends ~0.6s later (another rotation) -> absorbed into the pending.
        lst = lst[1:] + [self.BOX]
        assert c.new_entries(_fake_list(lst), cap_len, CAP) == [self.BOX]

    def test_clear_then_box_same_rotated_batch_in_order(self):
        # both surface on the SAME tick (one stalled scan): order must still be clear-then-box, so
        # the close swaps R first and the box routes to the freshly-opened pending.
        cap_len = 2000
        lst = list(range(1, cap_len + 1))
        c = LogScanCursor()
        c.seed(_fake_list(lst), cap_len, CAP)
        lst = lst[2:] + [self.CLEAR, self.BOX]
        assert c.new_entries(_fake_list(lst), cap_len, CAP) == [self.CLEAR, self.BOX]


class TestScanCapBounded:
    """The per-tick scan is bounded (the pre-fix loop capped at 300). A pathological burst beyond
    the cap stops at the cap (same accepted exposure as before) and never scans the whole list."""

    def test_scan_does_not_exceed_cap_reads(self):
        cap_len = 2000
        before = list(range(1, cap_len + 1))
        c = LogScanCursor()
        c.seed(_fake_list(before), cap_len, CAP)
        reads = {"n": 0}

        def counting(i):
            reads["n"] += 1
            return before[i] if 0 <= i < len(before) and before[i] else None

        # last-seen pointer evicted far beyond the window -> can't early-stop; still bounded by CAP.
        rotated = list(range(10_001, 10_001 + cap_len))   # an ENTIRELY fresh list (full rotation)

        def counting_rot(i):
            reads["n"] += 1
            return rotated[i] if 0 <= i < len(rotated) and rotated[i] else None

        c.new_entries(counting_rot, cap_len, CAP)
        assert reads["n"] <= CAP + 1     # never walked all 2000 slots


class TestExceptionSafety:
    """Per-entry exception-safety contract: falsy slots (None/0 from a bad read) are skipped, not
    collected and not crashing — the loop primitives (rptr) return None on unreadable memory."""

    def test_none_slots_are_skipped(self):
        c = LogScanCursor()
        c.seed(_fake_list([10]), 1, CAP)
        # a hole (None) between real entries: skipped, the real new ones still returned.
        ptrs = [10, None, 20, 0, 30]
        assert c.new_entries(_fake_list(ptrs), 5, CAP) == [20, 30]

    def test_size_zero_or_none_yields_nothing(self):
        c = LogScanCursor()
        c.seed(_fake_list([10, 20]), 2, CAP)
        assert c.new_entries(_fake_list([]), 0, CAP) == []
        assert c.new_entries(_fake_list([]), None, CAP) == []
