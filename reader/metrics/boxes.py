"""boxes.py - live chest-open aggregate counters.

The AggregateManager already gives the reader a live, cumulative dictionary for plain counters.
Gold uses GoldEarn[SubKey1]; chest opens use BoxOpen[subkey]. Live manual-open captures confirmed
the BoxOpen subkeys are total=0, regular=1, blue=2. They are not EMonsterLogType values.
"""

from config.offsets import AggregateManager, EAggregateType
from il2cpp.finder import bbwf_from_klass


BOX_OPEN_SUBKEY_COUNT = 3
BLUE_OPEN_SUBKEY = 2


def box_open_counts_live(reader, klass):
    """Cumulative live BoxOpen counts: [total, regular, blue].

    Returns None if the AggregateManager or blue subkey cannot be read this tick. Missing non-blue
    subkeys are zeroes; malformed/negative values are ignored rather than treated as opens.
    """
    counts = [0] * BOX_OPEN_SUBKEY_COUNT
    if not klass:
        return None
    inst = bbwf_from_klass(reader, klass)
    if not inst:
        return None
    outer = reader.rptr(inst + AggregateManager.AGGREGATES)
    if not outer:
        return None
    for agg_type, inner in reader.dict8b_items(outer):
        if agg_type == EAggregateType.BoxOpen:
            blue_read = False
            for subkey, value in reader.dict8b_items(inner):
                if (subkey is not None and 0 <= subkey < BOX_OPEN_SUBKEY_COUNT
                        and value is not None and 0 <= value < 1_000_000_000_000):
                    counts[subkey] = int(value)
                    blue_read = blue_read or subkey == BLUE_OPEN_SUBKEY
            return counts if blue_read else None
    return None
