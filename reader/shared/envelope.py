"""envelope.py — per-field Result/Either for the RAW (raw/<id>.json).

Every DATA field in the raw that comes from a memory READ can fail (the game closed, the
address moved, the class didn't resolve). Instead of writing `0` or `"?"` — which becomes
permanent garbage, INDISTINGUISHABLE from a real zero (the 1.00.10 bug: gold read as 0
stuck forever in runs.jsonl) — wrap the value in a tagged envelope:

    {"ok": true,  "value": <reading>}      # read
    {"ok": false, "error": "<reason>"}     # not read

The converter (app, TS) unwraps it: `ok` → use the value; error → record it in `issues` and
degrade the run, never confusing "couldn't read" with "read zero". Mirrors the `Field<T>` in
`app/src/shared/raw-types.ts` (same shape on both sides of the contract).

Usage rule (see "RAW contract"):
- observed DATA (gold, xp, stage, heroes, damage…) → `field(lambda: <reading>)` or `ok()/err()`.
- structural META (raw_schema_version, id, ts, run, run_outcome, session) → goes RAW, no envelope
  (if this is missing, there is no record).
"""

from typing import Any, Callable


def ok(value: Any) -> dict:
    """Field read successfully. `value` can be anything, including None
    (use `ok(None)` when None is a LEGITIMATE value — e.g. act absent on a stage with no info)."""
    return {"ok": True, "value": value}


def err(error: Any) -> dict:
    """Field that could NOT be read. `error` is a short reason (string) that the converter
    propagates into `issues:{field: reason}` — it's for auditing, not for value."""
    return {"ok": False, "error": str(error)}


def field(read: Callable[[], Any]) -> dict:
    """Wrap a memory read in an envelope.

    Calls `read()`:
    - raised an exception → `err` (a memory read can `raise`);
    - returned `None`     → `err("none")` (None here = "couldn't determine");
    - returned a value    → `ok(value)`.

    Usage: `field(lambda: reader.ri32(addr + OFF))`. When None is a VALID value (not an
    error), do NOT use `field()` — use `ok(value)` directly, so a legitimate null isn't
    turned into an error.
    """
    try:
        value = read()
    except Exception as e:  # a memory read can raise (dead process, invalid addr)
        return err(f"{type(e).__name__}: {e}")
    if value is None:
        return err("none")
    return ok(value)
