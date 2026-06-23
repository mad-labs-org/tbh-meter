# reader/ — read before you touch it

> ## ✠ THE FIRST COMMANDMENT OF TBH — engrave it, never ask again
>
> **THE PARTY IS ALWAYS FIGHTING.** From the instant the game opens, the party is deployed and in
> combat. There is **NO pause, NO town-idle, NO "between stages"** — the *only* thing that stops combat
> is **closing the game**. This is ground truth, confirmed by the game's daily operator.
>
> **Therefore, as law:**
> - **NEVER** ask "were you in combat?" / "was the party deployed?" — the game has no other state, so the
>   question is always nonsense.
> - A `validate_live.py` **FAIL** on `party-live` / `hero-class` / `xp-live` / `stats` / `stage`
>   (`sm=NOT found`) or `dps` (`monsters=0`) is **NEVER "not in combat"** — it is a **REAL REGRESSION** in
>   the live-party / live-`StageManager` / monster resolution (the obfuscated `HeroRuntime` path). `monsters=0`
>   while the game is open means the reader is reading the wrong instance/offset — full stop. Investigate the
>   code; never blame the capture conditions.

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
