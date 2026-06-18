"""Per-field Result/Either envelope tests (shared/envelope.py).

Locks the contract the converter (app) relies on: ok carries value; err carries a reason
(string); field() turns raise/None into err and never confuses "didn't-read" with "read zero"
(the 1.00.10 bug).
"""

from shared.envelope import err, field, ok


def test_ok_carries_value():
    assert ok(123) == {"ok": True, "value": 123}


def test_ok_allows_legit_none():
    # A LEGITIMATE None (e.g. act absent) is a value, not an error.
    assert ok(None) == {"ok": True, "value": None}


def test_ok_distinguishes_real_zero_from_failure():
    # The whole point of the envelope: real-zero != couldn't-read.
    assert ok(0) == {"ok": True, "value": 0}
    assert ok(0) != err("none")


def test_err_stringifies_reason():
    assert err("invalid addr") == {"ok": False, "error": "invalid addr"}
    assert err(ValueError("boom")) == {"ok": False, "error": "boom"}


def test_field_wraps_successful_read():
    assert field(lambda: 42) == {"ok": True, "value": 42}


def test_field_none_becomes_err():
    assert field(lambda: None) == {"ok": False, "error": "none"}


def test_field_exception_becomes_err_with_type():
    def boom():
        raise RuntimeError("process dead")

    result = field(boom)
    assert result["ok"] is False
    assert "RuntimeError" in result["error"]
    assert "process dead" in result["error"]


def test_field_preserves_falsy_non_none():
    # 0 / "" / [] are READ values (ok), not failures — only None/raise become err.
    assert field(lambda: 0) == {"ok": True, "value": 0}
    assert field(lambda: "") == {"ok": True, "value": ""}
    assert field(lambda: []) == {"ok": True, "value": []}
