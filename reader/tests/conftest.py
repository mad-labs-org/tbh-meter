"""Fixtures compartilhadas para todos os testes do reader.

MockReader: implementa a mesma interface que shared/memory.py::Reader, mas lê
de dicionários em memória. Permite montar layouts falsos de memória sem anexar
a um processo real.
"""

import pytest


class MockReader:
    """Implementa a interface mínima do Reader usada pelos módulos de métrica.

    mem: {addr: valor} — ri32/ri64/rptr retornam mem.get(addr).
    lists: {list_ptr: [entry_addr, ...]} — list_iter itera sobre essa lista.
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
    """Substitui metrics.xp._CURVE por uma curva mínima (níveis 1–5) para
    isolar os testes de qualquer leitura de arquivo."""
    import metrics.xp as xp_mod
    curve = {1: 30, 2: 150, 3: 500, 4: 1000, 5: 2600}
    monkeypatch.setattr(xp_mod, "_CURVE", curve)
    return curve


@pytest.fixture
def real_curve(monkeypatch):
    """Força a curva REAL (recarrega de config/level_curve.json) p/ os testes de borda do cap,
    e RESTAURA _CURVE no teardown (monkeypatch) — sem isso a curva real ficava cacheada global
    e vazava p/ testes order-dependentes. Devolve a curva carregada."""
    import metrics.xp as xp_mod
    monkeypatch.setattr(xp_mod, "_CURVE", None)   # força reload; monkeypatch restaura o original depois
    return xp_mod.curve()
