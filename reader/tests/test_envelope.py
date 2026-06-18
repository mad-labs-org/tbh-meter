"""Testes do envelope Result/Either por campo (shared/envelope.py).

Garante o contrato que o conversor (app) assume: ok carrega value; err carrega motivo
(string); field() transforma raise/None em err e nunca confunde "não-li" com "li zero"
(o bug do 1.00.10).
"""

from shared.envelope import err, field, ok


def test_ok_carries_value():
    assert ok(123) == {"ok": True, "value": 123}


def test_ok_allows_legit_none():
    # None LEGÍTIMO (ex.: act ausente) é um valor, não um erro.
    assert ok(None) == {"ok": True, "value": None}


def test_ok_distinguishes_real_zero_from_failure():
    # O ponto do envelope: zero-de-verdade != não-consegui-ler.
    assert ok(0) == {"ok": True, "value": 0}
    assert ok(0) != err("none")


def test_err_stringifies_reason():
    assert err("addr inválido") == {"ok": False, "error": "addr inválido"}
    assert err(ValueError("boom")) == {"ok": False, "error": "boom"}


def test_field_wraps_successful_read():
    assert field(lambda: 42) == {"ok": True, "value": 42}


def test_field_none_becomes_err():
    assert field(lambda: None) == {"ok": False, "error": "none"}


def test_field_exception_becomes_err_with_type():
    def boom():
        raise RuntimeError("processo morto")

    result = field(boom)
    assert result["ok"] is False
    assert "RuntimeError" in result["error"]
    assert "processo morto" in result["error"]


def test_field_preserves_falsy_non_none():
    # 0 / "" / [] são valores LIDOS (ok), não falhas — só None/raise viram err.
    assert field(lambda: 0) == {"ok": True, "value": 0}
    assert field(lambda: "") == {"ok": True, "value": ""}
    assert field(lambda: []) == {"ok": True, "value": []}
