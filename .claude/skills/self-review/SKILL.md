---
name: self-review
description: "Post-implementation self-review. Use AFTER finishing ANY code implementation or change — before declaring it done, committing, or opening a PR — to critique your own work: re-read the diff adversarially, confirm unit tests cover every branch/edge, kill duplication, follow clean-code/SOLID and the repo's own docs & invariants, decide if something should become documentation, update/prune memory, and strip outdated comments. Trigger it whenever you've just written or modified code and are about to wrap up, even if the user didn't explicitly ask for a review."
---

# Self-Review — critique your own implementation before calling it done

You just wrote this, which makes you the worst-positioned person to spot its flaws: you know
what you *meant*, not what you *wrote*. This skill forces a deliberate change of hats — stop
building and become the reviewer who's seeing the change for the first time and is mildly
skeptical of it. Run it after any non-trivial implementation, before you declare it done,
commit, or open a PR.

## How to run it

Go through each dimension below against the **actual change** (`git diff` plus the files you
touched), not your memory of it. For each dimension, either confirm it's clean or fix it.
Close with the short report at the bottom — what you checked, what you changed, and anything
you deliberately left alone and why.

## 1. Re-read the whole diff, adversarially

Read every changed line end to end, as a reviewer rather than the author. Does it actually do
what was asked — including the edge cases and failure paths, not just the happy path? Is
anything half-done, stubbed, or left as a `TODO`? Did debugging residue survive — stray
prints / `console.log`, commented-out code, temporary probes, scratch files, hardcoded test
values?

## 2. Tests cover every detail

For each new branch, edge case, and error path there should be a test that actually asserts
the behavior — not a happy-path smoke test, and not a vacuous assertion that passes no matter
what. The litmus test: if someone reintroduced the bug you just fixed (or broke a branch you
just added), would a test go red? If not, the coverage has a hole. And don't *claim* green —
run the suite and watch it pass.

## 3. Kill duplication (DRY), without over-abstracting

Repeated expressions, literals, or blocks → lift them into a well-named variable, function, or
constant (a magic number or string is duplication waiting to drift out of sync). But resist
abstracting two things that are only *coincidentally* similar — a forced abstraction couples
things that should be free to evolve apart. Extract when it's the same *idea*, not just the
same shape.

## 4. Clean code & SOLID, in the codebase's accent

Names should say what they mean and match the surrounding conventions. Functions do one thing
and stay small; watch for a god-function quietly accreting responsibilities. Dependencies
point the right way, so a change in one concern doesn't ripple across many. Above all: write
code that reads like the code already there — match its idioms, error-handling, and structure
instead of importing your own preferred style.

## 5. Honor the repo's guidelines & invariants

Re-open the relevant `CLAUDE.md`, area docs, and guideline files and check the change against
them — they encode hard-won rules. Respect documented invariants (the kind whose violation
silently corrupts data or breaks the build). If the repo keeps an anti-patterns or review
checklist, sweep the diff against it. When your instinct conflicts with an established
convention, the convention wins.

## 6. Should any of this become documentation?

If you changed behavior, architecture, a contract, or a non-obvious decision, ask whether a doc
should capture it — a new file, or an update to the README / area docs. If you changed a value
or rule that a drift-test or a doc references, update the doc in the same change so they don't
fall out of sync.

## 7. Memory — add what's durable, prune what's now wrong

Save the non-obvious, lasting facts this work surfaced: decisions, gotchas, cross-cutting
facts. Don't save what the repo or git history already records — that's noise. Just as
important, this is garbage collection: update memories this change made stale, and delete
memories that turned out to be wrong. A confident-but-wrong memory is worse than none.

## 8. Comments — the WHY, current, no lies

Remove comments that are now outdated or incorrect; a comment that contradicts the code is
worse than no comment. Comments should explain *why* (the non-obvious reason), not narrate
*what* the code plainly says. Match the surrounding comment density, and delete any scaffolding
or note-to-self comments you left mid-build.

## 9. Working-tree hygiene

Confirm the change set is only what you intended: no stray temp files, no unrelated edits swept
in, no debug logging left on. `git status` and `git diff` should read like a clean, reviewable
change.

## 10. Final verification, reported honestly

Run the project's gates (lint + types + tests) and watch them pass with your own eyes; for UI
work, verify on real output, not just unit tests. Then report faithfully — if something failed,
was skipped, or is still uncertain, say so. Don't round "probably fine" up to "done".

## Report

Close the pass with a concise summary so the review is itself reviewable:

```
Self-review:
- Diff / edge cases:        <clean | fixed X>
- Tests (every branch?):    <covered + ran green | gap: …>
- Duplication / clean-code: <clean | extracted X>
- Guidelines / invariants:  <followed | fixed X>
- Docs:                     <none needed | updated X>
- Memory:                   <added X | pruned stale Y | none>
- Comments / cleanup:       <clean | removed X>
- Gates:                    <lint/types/tests result>
- Left intentionally:       <thing + why, if any>
```
