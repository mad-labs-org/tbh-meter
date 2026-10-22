"""models.py — LIVE WORLD reads (monsters) for DPS + the runtime stageKey.

Free functions taking (reader, ...), mirroring the monolith (same validated logic).
DPS = Σ of monster HP drops (the game doesn't store damage); HP is a RAW float @0x40/0x50."""

from config.offsets import MonsterSpawnManager, Unit, UnitHealthController, Monster


def live_monsters(reader, msm):
    """Iterates (unit_addr, hp_cur, hp_max) over the live + summoned monsters.

    HOT LOOP (10Hz, every mob on the stage): the pointer list comes out in a BATCH
    (reader.list_ptrs -> read_array_ptrs, 1 syscall for all Units, not 1 per Unit);
    and hp_cur+hp_max come from a SINGLE read (read_struct, 16B: 0x40..0x50) instead of two.
    That leaves 1 syscall to dereference each Unit's HealthController (addresses
    are scattered, so no batching). HP is a RAW float @0x40 (cur) / @0x50 (max)."""
    for field in (MonsterSpawnManager.MONSTER_LIST, MonsterSpawnManager.SUMMONED_LIST):
        for u in reader.list_ptrs(reader.rptr(msm + field), cap=600):
            hc = reader.rptr(u + Unit.HEALTH_CONTROLLER)
            if not hc:
                continue
            # HP_CURRENT@0x40 and HP_MAX (1.3.0: 0x50, auto-calibrated per build by field_calib) read
            # in ONE syscall. The window spans HP_CURRENT..HP_MAX inclusive so it follows a shifted
            # HP_MAX automatically (field_calib may move HP_MAX on a future recompile).
            cur_off = UnitHealthController.HP_CURRENT
            max_off = UnitHealthController.HP_MAX
            span = max_off - cur_off
            nfloats = span // 4 + 1
            vals = reader.read_struct(hc + cur_off, "<%df" % nfloats)
            if vals is not None:
                yield u, vals[0], vals[span // 4]


def live_stage_key(reader, msm):
    """LIVE stageKey = Monster.STAGE_KEY (every mob has the same one; flips instantly on a stage
    change — the save's currentStageKey is stale). Mode of the first few reads."""
    keys = []
    for u in reader.list_iter(reader.rptr(msm + MonsterSpawnManager.MONSTER_LIST), cap=600):
        k = reader.ri32(u + Monster.STAGE_KEY)
        if k is not None and 0 < k < 10_000_000:
            keys.append(k)
        if len(keys) >= 10:
            break
    return max(set(keys), key=keys.count) if keys else None
