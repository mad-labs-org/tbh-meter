"""OBSCURED offsets are off-limits: they exist as NAMED constants (so the
docs/invariants/obscured-data-offlimits note has something to anchor to) and NO reader module may
reference them — reading at these offsets yields garbage (ObscuredFloat/XOR), a real bug class."""
from pathlib import Path

from config.offsets import Monster, Unit

ROOT = Path(__file__).resolve().parent.parent


def test_obscured_markers_exist():
    assert Unit.CORE_STATS_OBSCURED == 0x104
    assert Monster.CACHE_OBSCURED == 0x3C0  # 1.00.27: Unit grew +0x8 again (0x3B8->0x3C0)


def test_no_reader_module_reads_obscured_offsets():
    """The markers are "DO NOT READ" — if a reader module references them, someone will read there."""
    offenders = []
    for sub in ("metrics", "game"):
        for f in (ROOT / sub).glob("*.py"):
            txt = f.read_text(encoding="utf-8")
            if "CORE_STATS_OBSCURED" in txt or "CACHE_OBSCURED" in txt:
                offenders.append(f"{sub}/{f.name}")
    assert not offenders, f"reader modules reference OBSCURED offset (reading yields garbage): {offenders}"
