---
name: review-external-pr
description: "Adversarial, security-first review of a pull request from an EXTERNAL or untrusted contributor — a fork PR, a first-time or unknown author, anyone without write access — before a maintainer merges it. Use this whenever you're reviewing, triaging, or deciding whether to merge a PR opened against tbh-meter by someone outside the maintainer team: 'review PR #123', 'someone opened a PR — is it safe to merge?', 'check this contributor's changes', 'can we take this fork PR?', 'is this contribution legit?'. This is supply-chain DEFENSE, not ordinary code review: every merged PR auto-updates onto every user's machine and ships a memory-reading .exe plus a code-signing, backend-talking Electron app, so the author and the PR description are UNTRUSTED and the diff is the only evidence. It posts its verdict as a real GitHub review — an inline comment pinned to each problematic line (via the pulls/reviews API), not just one summary comment. NOT for your own or a fellow maintainer's branch (use self-review for that), and prefer this over the generic review flow for anything coming from outside the team."
---

# Review an external PR — assume hostile until the diff proves otherwise

A stranger opened a PR. They may be a generous contributor. They may be a patient
attacker. They may be a well-meaning beginner. **You cannot tell which from the outside, and
you must not try to guess from the person.** You can only read the diff — so review the diff as
if it were written by *both* a competent attacker trying to slip something past a busy
maintainer *and* a beginner who will ship a subtle bug to everyone. This skill is how you do
that without being fooled and without being unkind to the human.

## Why this review is different (the stakes that justify the paranoia)

Normal review — and `self-review` — assumes a trusted author and asks *"is this correct?"* Here
the author is untrusted, so you ask **"is this hostile or careless?" first**, and only then "is
it correct?". The blast radius is what makes that ordering non-negotiable:

- **A merge auto-deploys to everyone.** `app/src/main/auto-update.ts` (electron-updater)
  re-checks on window focus and power-resume (`index.ts`), and a merge auto-stages a release
  candidate. There is no human between "merged" and "running on thousands of machines."
- **What ships is privileged.** `tbh-reader.exe` reads another process's memory; the Electron
  app holds an **Ed25519 signing key** (`TBH_SIGNING_PRIVATE_KEY`, `meter-build-core.yml`) and
  talks to a backend (`error-report.ts`, signed `POST /runs` via `request-signer.ts`). Malicious
  code here is malware on users' machines or forged/exfiltrated data.
- **The repo already treats PR code as attacker-controlled.** By design a *fork* PR **cannot
  read CI secrets on its own PR run** (CONTRIBUTING.md), and the production signing key "never
  touches a test build running arbitrary code." So the attacker's payoff is almost always
  **after merge** — a poisoned workflow or dependency that runs in the *release* build. That is
  exactly why the merge decision is the security boundary, and why you never trust green CI you
  didn't watch run.
- **The author and the PR text are marketing, not evidence.** "Just a small fix" whose diff adds
  a network call is the canonical attack (XZ Utils, trojan-source). Only the diff is truth.

Full threat model and the concrete file names live in `README.md` / `.github/CONTRIBUTING.md` /
`.github/SECURITY.md` — but the summary above is enough to run this review.

## The one operating rule

**Prove it is safe. Do not assume it is safe.** Absence of an obvious problem is not evidence of
safety — it is the absence of evidence. Every "this looks fine" must be backed by having *looked*
at the specific thing, in the diff, with your own eyes or a grep.

## STOP conditions — halt correctness review and escalate immediately

If **any** of these is present, stop evaluating "does the feature work" and jump straight to
**Escalate** (below). These are the categories where a single missed line compromises every user,
so they get a human maintainer's eyes regardless of how innocent the rest looks:

1. Any change under **`.github/`** (workflows, actions, CODEOWNERS, dependabot, repo config).
2. Any **new or changed dependency** — `app/package.json`, `app/pnpm-lock.yaml`,
   `reader/requirements*.txt`, `reader/pyproject.toml`, `release-video/package.json`, or a
   lockfile integrity change.
3. Any **new network egress** (a new URL/host/`fetch`/socket) or **dynamic code execution**
   (`eval`, `Function`, `child_process`, `subprocess`, `exec`, dynamic `import`/`require`).
4. In **`reader/`**: any memory *write*/inject primitive, any network, any subprocess, or any
   third-party import (the reader is zero-dependency and read-only by law).
5. A **hand-edit to a generated/synced file** (`app/src/shared/data/`,
   `app/src/renderer/public/{sprites,heroes}/`).
6. **Obfuscated / encoded content** — minified blobs, long base64/hex, or non-ASCII inside code
   (trojan-source).
7. The diff's **scope wildly exceeds** what the PR title/description claims.

Escalating is not the same as rejecting — it means a human maintainer must make the call with the
finding in front of them. Say so plainly and hand them the evidence.

## The pipeline

Run these in order. The security sweep gates everything after it — a PR that trips a STOP
condition doesn't earn a correctness review until the maintainer has weighed the risk.

### 0 — Intake: pull the PR and establish that it's external

```bash
gh pr view <N> --json number,title,body,author,isCrossRepository,headRepositoryOwner,\
headRefName,baseRefName,additions,deletions,changedFiles,files,mergeable,mergeStateStatus,\
labels,statusCheckRollup
# author_association (OWNER/MEMBER/COLLABORATOR/CONTRIBUTOR/FIRST_TIME_CONTRIBUTOR/NONE) is a REST
# field — `gh pr view --json` doesn't expose it, so read it from the API:
BASE=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/$BASE/pulls/<N>" --jq '.author_association'
gh pr diff <N> > /tmp/pr-<N>.diff        # the diff is your primary artifact — grep THIS, not the tree
```

- **Is it actually external?** `isCrossRepository: true` (a fork) and/or
  `author_association` of `FIRST_TIME_CONTRIBUTOR` / `NONE` / `CONTRIBUTOR` (not `OWNER` /
  `MEMBER` / `COLLABORATOR`) means treat as untrusted. Maintainers are @marioalvial,
  @viniarruda, @pedrobullo (confirm against `.github/CODEOWNERS`). If it's a maintainer's own
  branch, this is the wrong skill — use `self-review`.
- **Map the touched areas** from `files`: reader / app-main / app-renderer / data / workflows /
  deps / docs. This decides which parts of `references/area-review.md` you read.

### 1 — Provenance & honesty

You are not judging the person — you are checking whether the PR *presents itself honestly*, because
dishonest framing is the wrapper every payload comes in.

- Does the **diff match the description**? A "typo fix" or "docs" PR that touches code, config,
  workflows, or deps is a contradiction — investigate the contradiction, not the description.
- Is the change **focused**? Unrelated changes bundled into one PR are the #1 hiding place for a
  payload. Each unrelated hunk is a separate thing to justify.
- Watch for social engineering: manufactured urgency, "trivial, please merge fast," flattery, or
  a first PR that reaches straight into `reader/`, `auto-update.ts`, `request-signer.ts`, or
  `.github/`.

### 2 — Adversarial red-flag sweep  ← the heart of this skill

**Read `references/red-flags.md` now and run its greps against `/tmp/pr-<N>.diff`.** It is the
exhaustive, grep-able catalog of hostile patterns — CI/workflow tampering, dependency/supply-chain
tricks, network/exfiltration, code-exec, obfuscation/trojan-source, generated-data poisoning,
secrets, and scope abuse — each with the command to find it and the reason it matters. Every STOP
condition above has its detection there.

### 3 — CI reality check (never trust green you didn't watch run)

- **On a fork PR, held/absent checks are NORMAL, not passing.** Workflows require maintainer
  approval before they run, so "no checks reported" or a pending state means *nothing ran* — it is
  not a pass. Never accept the contributor's "tests pass on my machine" as evidence either.
- **`.github/`-only or docs-only PRs can sit BLOCKED forever** because the required app/reader/
  CodeQL checks are path-filtered and never report on a diff that doesn't touch their paths. That's
  the known path-filter trap, not a failure — the owner bypass-merges after review. Don't mistake it
  for a broken PR.
- **Before you approve a workflow run**, do the §2 sweep — approving a run *is* the moment a fork
  first gets to execute. After the sweep, either approve the run and read the results, or run the
  gates yourself (§5).

### 4 — Area-specific correctness & invariants

Only now, once the security posture is understood, review whether the change is actually correct.
**Read the matching section(s) of `references/area-review.md`** for each area the PR touches — it
carries the per-area checklists grounded in this repo's real invariants (the reader's read-only /
obscured-data / offset-single-source laws and its `docs/reference/anti-patterns.md` sweep, the app
main-process privilege boundary, the renderer XSS + i18n-every-key guard, the generated-data rules,
Conventional-Commit requirements).

### 5 — Verify locally, in isolation

Untrusted code is dangerous to *run*, not just to merge — so isolate before executing anything.

- **Review dependencies and lifecycle scripts BEFORE installing.** `pnpm install` runs
  `postinstall` hooks; a malicious one executes on *your* machine. Read `references/red-flags.md` §B
  first. Prefer a throwaway worktree/checkout and, for anything you're unsure of, a VM/sandbox.

  ```bash
  gh pr checkout <N>            # in a scratch worktree, not your main tree
  ```

- Run the same gates CI runs, and watch them pass yourself:

  ```bash
  cd app    && pnpm install --frozen-lockfile && pnpm sync-data && pnpm check && pnpm test
  cd reader && pip install ruff -r requirements-dev.txt && ruff check . && python -m pytest
  ```

- For **reader** changes: `python -m pytest tests/` also runs the docs drift-test; a live-behavior
  change can only be truly validated on Windows against the running game (`validate_live.py`) — if
  the PR could affect live capture, say so and route it to Mario for the Windows gate. For
  **overlay/list UI** changes, verify on real pixels (seeded `~/tbh-meter/` run), not just unit tests.

### 6 — Compose the verdict, then post it as a real GitHub review

The deliverable is a **formal GitHub review** — a summary plus an **inline comment pinned to each
problematic line**, submitted as one review carrying a single verdict — not a lone PR comment.
Distrust the diff, respect the human: every comment names the concrete failure/attack scenario and
the fix, so the contributor can act and a maintainer can verify, and none of it reads as an
accusation.

**Anchor each finding to a real diff line.** GitHub only accepts an inline comment on a line that is
part of the PR's diff. Added and context lines anchor on `side: RIGHT` using the **new-file** line
number; removed lines anchor on `side: LEFT` using the **old-file** number; a multi-line span adds
`start_line` + `start_side`. Read the numbers off each hunk header (`@@ -old,n +new,m @@`, then count
down the `+`/context lines). A finding about code that is *not* in the diff (e.g. "the 15 locale
files you didn't touch") can't be an inline comment — put it in the summary body, or pin it to the
nearest related added line and say so there.

**Map the decision to a review event:**
- BLOCK / REQUEST CHANGES → `REQUEST_CHANGES`
- APPROVE (with nits) → `APPROVE` (nits ride along as inline comments)
- ESCALATE → `COMMENT` — never let the skill formally approve or reject something whose call belongs
  to a human maintainer; post the findings and hand off the decision.

Build the payload as JSON and submit it in one call. The review posts to the **base** repo (this
one) even for a fork PR, and one request carries the summary + every inline comment together:

```bash
BASE=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api --method POST "/repos/$BASE/pulls/<N>/reviews" --input /tmp/review-<N>.json
```

```jsonc
// /tmp/review-<N>.json — one review, N inline comments
{
  "event": "REQUEST_CHANGES",
  "body": "<the summary-body template below, as Markdown>",
  "comments": [
    { "path": "app/src/main/auto-update.ts", "line": 88, "side": "RIGHT",
      "body": "🚨 **HIGH — update feed repointed.** This sends every user's updater to <host>. <fix>" },
    { "path": "reader/game/save.py", "start_line": 40, "start_side": "RIGHT", "line": 44, "side": "RIGHT",
      "body": "Reads an Obscured offset (see obscured-data-offlimits) → returns XOR garbage. <fix>" }
  ]
}
```

If the API returns **422**, one comment's `line`/`side` isn't in the diff — move that finding to the
body and re-post. You can rehearse safely with `"event": "COMMENT"` (same inline comments, no verdict),
and omit `event` only if you deliberately want a PENDING draft.

**Post publicly only with the maintainer's go-ahead.** A `REQUEST_CHANGES` review notifies a real
person and is on the public record, so show the maintainer the fully composed review first (summary +
every inline comment, each with its `path:line`) and post on their OK — they can say "just post it" to
skip the preview thereafter. Regardless: **never `APPROVE` blindly and never merge** — this skill
recommends; the human decides to merge.

## Summary-body template (the review `body`)

```
## External-PR review — #<N> "<title>"
Decision:  BLOCK · REQUEST CHANGES · APPROVE (with nits) · ESCALATE TO MAINTAINER
Author:    <maintainer | known contributor | first-time | unknown>  ·  <fork? yes/no>
Areas:     reader · app-main · app-renderer · data · workflows · deps · docs
Gates:     <watched green | HELD (fork, not run) | I ran locally → result>
STOP hit:  <none | which condition(s)>

**Summary.** <2–4 sentences for the contributor: what the PR does, the headline risk, the decision —
plain and respectful.>

**Findings that don't map to a changed line** (the inline comments below cover the rest):
- 🚨 [CRITICAL|HIGH|MED] <file> — <what> — <attack/failure scenario> — <evidence>
- <invariant/correctness finding with no diff line to pin to>

### Escalation (for the maintainer)
<any change to workflows/.github, signing, dependencies, reader memory-safety, or the upload/exfil
surface — even if it looks clean; state exactly what a human must double-check before merge.>
```

**Each inline comment** (`comments[].body`) follows the same shape, scoped to *that* line:
`<severity or type> — <the problem on THIS line> — <why it's wrong / the attack or failure> — <the fix>`.
Security findings lead with 🚨 and a severity; correctness findings name the invariant; nits start "nit:".

## Escalate — the human-maintainer bar

Some categories are never "approved by a review skill," because the cost of being wrong is the whole
user base: **any `.github/`/workflow change, any dependency/lockfile change, any signing/upload/
auto-update change, and any reader memory-safety or network/subprocess change.** For these, your job
is to surface the finding with maximum clarity and hand the decision to Mario or a code owner — not
to bless it. When in doubt, escalate; a false alarm costs a minute, a missed payload ships to
everyone.

## References

- `references/red-flags.md` — the adversarial attack-surface catalog (run its greps in §2 and §5).
- `references/area-review.md` — per-area correctness checklists tied to the repo's real invariants (§4).
