"""Synthetic memory tests for the live BoxOpen aggregate."""

from config.offsets import AggregateManager, EAggregateType
from metrics import boxes


INST = 0x1000
OUTER = 0x2000
INNER = 0x3000


class FakeReader:
    def __init__(self, outer_items=None, inner_items=None):
        self.outer_items = outer_items if outer_items is not None else [
            (int(EAggregateType.GoldEarn), 0x4000),
            (int(EAggregateType.BoxOpen), INNER),
        ]
        self.inner_items = inner_items if inner_items is not None else [(0, 590), (1, 407), (2, 166)]

    def rptr(self, addr):
        return OUTER if addr == INST + AggregateManager.AGGREGATES else None

    def dict8b_items(self, addr):
        if addr == OUTER:
            return iter(self.outer_items)
        if addr == INNER:
            return iter(self.inner_items)
        return iter(())


def test_box_open_counts_reads_total_regular_and_blue(monkeypatch):
    monkeypatch.setattr(boxes, "bbwf_from_klass", lambda _reader, _klass: INST)
    assert boxes.box_open_counts_live(FakeReader(), 0x5000) == [590, 407, 166]


def test_box_open_counts_returns_none_without_live_singleton(monkeypatch):
    monkeypatch.setattr(boxes, "bbwf_from_klass", lambda _reader, _klass: None)
    assert boxes.box_open_counts_live(FakeReader(), 0x5000) is None


def test_box_open_counts_returns_none_without_box_open_aggregate(monkeypatch):
    monkeypatch.setattr(boxes, "bbwf_from_klass", lambda _reader, _klass: INST)
    reader = FakeReader(outer_items=[(int(EAggregateType.GoldEarn), 0x4000)])
    assert boxes.box_open_counts_live(reader, 0x5000) is None


def test_box_open_counts_ignores_invalid_values_and_unknown_subkeys(monkeypatch):
    monkeypatch.setattr(boxes, "bbwf_from_klass", lambda _reader, _klass: INST)
    reader = FakeReader(inner_items=[
        (0, -1),
        (1, 1_000_000_000_000),
        (2, 166),
        (3, 999),
    ])
    assert boxes.box_open_counts_live(reader, 0x5000) == [0, 0, 166]


def test_box_open_counts_returns_none_when_blue_subkey_is_unreadable(monkeypatch):
    monkeypatch.setattr(boxes, "bbwf_from_klass", lambda _reader, _klass: INST)
    reader = FakeReader(inner_items=[(0, 590), (1, 407), (2, None)])
    assert boxes.box_open_counts_live(reader, 0x5000) is None
