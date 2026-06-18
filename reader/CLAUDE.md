# reader/ — read before you touch it

Changing **anything under `tbh-meter/reader/`?** The knowledge base that prevents the historical bugs
(swapped dict stride, obfuscated name, un-bumped schema, runs that never close, ObscuredFloat, stale
cache) lives in **`docs/_index.md`** — start there (it has a "by symptom/task" block), find the note by
symptom, and follow its `code_anchors` to the code (the truth).

- The knowledge is **drift-tested**: run `pytest tests/` after any change
  (`tests/test_docs_consistency.py` fails when a note lies about the code).
- Before opening a PR, **sweep the diff against `docs/reference/anti-patterns.md`** — the checklist of
  known smells, each linked to the invariant note it violates.
- Adding a note or changing a rule: the truth is the CODE. Offset/enum/stride → `config/offsets.py`;
  business rule → the logic module. Never duplicate the value in a note — cite the symbol
  (`code_anchors` + `asserts`) so the drift-test guards you. Conventions: `docs/README.md`.
