"""Shared fixtures for all reader tests.

MockReader: implements the same interface as shared/memory.py::Reader, but reads
from in-memory dicts. Lets you build fake memory layouts without attaching to a
real process.
"""

import pytest


class MockReader:
    """Implements the minimal Reader interface used by the metric modules.

    mem: {addr: value} — ri32/ri64/rptr return mem.get(addr).
    lists: {list_ptr: [entry_addr, ...]} — list_iter iterates over that list.
    """

    def __init__(self, mem=None, lists=None):
        self._mem = dict(mem or {})
        self._lists = dict(lists or {})

    def ri32(self, addr):
        return self._mem.get(addr)

    def ri64(self, addr):
        return self._mem.get(addr)

    def rf32(self, addr):
        return self._mem.get(addr)

    def ru32(self, addr):
        return self._mem.get(addr)

    def rptr(self, addr):
        return self._mem.get(addr)

    def list_iter(self, ptr, cap=1000):
        if not ptr:
            return iter([])
        return iter(self._lists.get(ptr, [])[:cap])

    def read_string(self, addr):
        return self._mem.get(addr)

    def read_cstr(self, addr):
        return self._mem.get(addr)


@pytest.fixture
def mock_reader():
    return MockReader()


@pytest.fixture
def fake_curve(monkeypatch):
    """Replaces metrics.xp._CURVE with a minimal curve (levels 1–5) to
    isolate the tests from any file reads."""
    import metrics.xp as xp_mod
    curve = {1: 30, 2: 150, 3: 500, 4: 1000, 5: 2600}
    monkeypatch.setattr(xp_mod, "_CURVE", curve)
    return curve


@pytest.fixture
def real_curve(monkeypatch):
    """Forces the REAL curve (reloads from config/level_curve.json) for the cap edge tests,
    and RESTORES _CURVE on teardown (monkeypatch) — without that the real curve stayed cached
    globally and leaked into order-dependent tests. Returns the loaded curve."""
    import metrics.xp as xp_mod
    monkeypatch.setattr(xp_mod, "_CURVE", None)   # force reload; monkeypatch restores the original afterward
    return xp_mod.curve()
