# docs/ — reader knowledge base (how to use and maintain)

This folder is a **skill-graph**: an index → small interlinked notes → the code.
The goal is that any agent about to touch the reader finds **the right invariant, at the
right time**, and doesn't repeat the bugs that already bit us (swapped dict stride, obfuscated
name, un-bumped schema, runs that never close, ObscuredInt, stale cache).

## How an agent finds what it needs (progressive disclosure)

Three levels — you load only what you need, never the whole base:

1. **Index** (`_index.md`) — read first. Catalog by type **+ a "By
   symptom/task" block** at the top. Retrieval is **lexical** (the agent's `grep`/`Read` —
   like Obsidian's search, no embeddings), so the index and each note carry the
   **symptom vocabulary** (`runs not closing`, `doubled gold`, `1.97T`), not just the domain
   name. `grep -ri "<symptom or symbol>" docs/` lands straight on the note.
2. **Note** — one per invariant/fact. Read only the one you're about to touch; follow `## Related`
   for the co-required neighborhood (e.g. touching gold pulls in stride + fallback + cache).
3. **Code** — the note points to `code_anchors` (file::symbol). **The truth lives in the
   code** (`config/offsets.py` + the `tests/`). The note is a pointer, never the source.

## Note types (`type` in the frontmatter)

| type | role | required | drift-tested? |
|------|------|----------|---------------|
| `invariant` | hard rule (broken = wrong data/crash) | `description`, `code_anchors`, `symptoms` | ✅ |
| `reference` | facts: offsets, field map, damage model | `description`, `code_anchors` | ✅ |
| `guide` | how to make a recurring change | `description` | ✅ |
| `process` | methodology (map/validate a value) | `description` | partial |
| `archive` | history: shipped plans, raw RE | `description`, `status` | ❌ (snapshot) |

## Frontmatter

```yaml
---
type: invariant
description: "A rich one-liner — what it is + why it matters (>= 20 chars)."
symptoms: ["runs not closing", "dead list", "doubled gold"]   # the vocabulary the agent greps
code_anchors:                       # file::symbol — resolved by AST against the code
  - meter_windows.py::_pick_list_singleton
  - config.offsets::Dict8B.STRIDE   # ::Class.ATTR also resolves
asserts:                            # load-bearing values checked against the real code
  - meter_windows.SCHEMA_VERSION == 11
  - config.offsets.DictFloat.STRIDE == 0x10
guarded_by:                         # behavior test that proves the rule (must exist)
  - tests/test_meter_windows.py::TestPickListSingleton::test_picks_largest_valid
related: ["[[invariants/dict-strides]]", "[[invariants/metric-fallback-chains]]"]
---
```

## Rules (enforced by `tests/test_docs_consistency.py`)

- **The truth is the code.** `code_anchors` resolve by **AST** (not substring →
  a comment won't give a false-green). `asserts` compare the **value** against the real literal.
  Behavioral rule → point to a test in `guarded_by`.
- **Never copy the skill or another note** when migrating: the skill has already drifted
  (`partial` was `== 0`, the code is `<= 0`; "X-10" was a flag, the code is `stage != 10`).
  Re-verify every rule **against the code**.
- **No line numbers in the body** (`file.py:NN` route) — use `code_anchors`.
- **`reference` cites the SYMBOL from `offsets.py`, never the `@0x` literal** (it desyncs).
- **`invariant` exists only with `code_anchors` that resolve to a present symbol** — otherwise
  it's `process`/`archive`, not an invariant.
- **Cross-repo (app):** `app/...` (TS) anchors are checked only as "file exists",
  tolerant of a reader-only checkout.
- **`archive/`:** SNAPSHOT — names may be stale; exempt from the code checks.
  Use a header warning and point back to the equivalent live note.

> The `/tbh-meter-review` skill is the **gate**: it tells you to read `docs/_index.md` + the
> note(s) for what you're about to change, and to run the code tests + this `test_docs_consistency`.
> The invariant detail lives here (single source), not duplicated in the skill.
