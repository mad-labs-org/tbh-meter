---
name: tbh-commit
argument-hint: "[--pr] [--draft] [--issue <n>] [-n [name]]"
description: >
  Standardized commit + PR workflow for tbh-meter. Analyzes changes, makes conventional commits
  (subjects feed the release changelog), and for any overlay/UI change captures a seed-driven
  screenshot to attach to the PR. Use when asked to commit, open a PR, or "commit this".
disable-model-invocation: false
---

# tbh-commit

Turn working-tree changes into clean conventional commits and (optionally) a PR. Commit subjects
become the release changelog — the meter computes versions and release notes from them (see
`.github/CONTRIBUTING.md` -> How releases work).

Honor the repo's laws: **branch + PR, never commit to `main`**; conventional commits; **never
force-push or rewrite pushed history**; never hand-edit generated files (the `guard-generated-files`
hook denies edits to `app/src/shared/data/` and `app/src/renderer/public/{sprites,heroes}/`).

## Arguments

| Argument | Meaning |
|----------|---------|
| `--pr` | Open a PR after pushing (default: just commit + push). |
| `--draft` | Open the PR as a draft (implies `--pr`). |
| `--issue <n>` | Add `Closes #n` to the PR description. |
| `-n [name]` / `--new-branch [name]` | Branch before committing; auto-name if none given. |

## Steps

### 1. Gather

```bash
git status
git diff
git diff --staged
git branch --show-current
git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main
```

No changes → stop ("Nothing to commit."). Conflict markers → stop (ask to resolve first).

### 2. Branch (never commit to `main`)

- On `main`/`master` **or** `-n` given → create `type/short-description` (slug, ≤ 5 words;
  `type/issue-N-...` when `--issue`): `git checkout -b "<branch>"`.
- Already on a feature branch and no `-n` → reuse it.

### 3. Group + write conventional subjects

Consider staged, unstaged, AND untracked. Group by logical change. Each subject:

```
type(scope): imperative description    # < 60 chars, lowercase, no period, no em dash
```

`type` ∈ feat|fix|perf|refactor|docs|style|test|chore|ci|build · `scope` = the area touched
(`app`, `reader`, `data`, `scripts`, `release`, …). **These subjects are the release notes** — make
each read as a standalone changelog line. Show the grouping before committing.

### 4. Overlay/UI gate

If the diff touches the renderer (`app/src/renderer/**`, `app/src/**/*.tsx`), verify on real pixels —
the renderer rule requires eyeballing, not just unit tests (`app/CLAUDE.md`):

1. Run the overlay/list on **seeded** `~/tbh-meter/` artifacts via CDP (full recipe: `dev` skill —
   `cd app && pnpm dev -- --remote-debugging-port=9222`, write `raw/<id>.json` + `live.json` with an
   advancing mtime).
2. Show the result and get the human's "ficou bom".
3. Attach the approved frame(s) to the PR (drag into the PR body, or `gh pr comment`).

If the app genuinely can't run (e.g. a Windows-only path, no fixtures), say so and ask the human for
captures — never skip the visual check silently.

### 5. Commit each group

```bash
git add <files for this group>          # explicit paths — never `git add -A`
git commit -m "type(scope): description"
```

Stage explicit paths, never `git add -A` (avoids sweeping generated files; the hook denies hand-edits
to `app/src/shared/data/` and the generated `public/{sprites,heroes}/`).

### 6. Push (never force)

```bash
git push -u origin "$(git branch --show-current)"
```

Rejected and only a force would fix it → **STOP**, explain, ask the human to run it. Never
`--force`/`--force-with-lease`, never rewrite pushed history. To sync with base, merge base in and
plain-push.

### 7. PR (only with `--pr` / `--draft`)

1. Fetch the template: `.github/PULL_REQUEST_TEMPLATE.md` (use its exact structure).
2. Fill it: Description / Key changes from the commits; **Closes #n** only if `--issue`; for an
   overlay PR, embed the approved screenshot(s); check the boxes that apply.
3. Create + (unless draft) enable auto-merge:
   ```bash
   gh pr create [--draft] --base "$BASE" --title "type(scope): summary" --body "$(cat <<'EOF'
   <filled template>
   EOF
   )"
   gh pr merge --auto --squash "$(gh pr view --json number --jq .number)" \
     || echo "Auto-merge unavailable — continuing."
   ```
4. Return the PR URL.

### 8. Report

Branch, commits (subjects), PR URL. For an overlay PR, confirm the screenshot(s) render in the PR body.

## Error handling

| Situation | Action |
|-----------|--------|
| No changes | Stop. "Nothing to commit." |
| Conflict markers | Stop. Ask to resolve first. |
| UI change, app can't run | Say so; ask the human for captures. Never skip the gate silently. |
| Push rejected (needs force) | STOP. Explain. Ask the human to force it himself. |
| Generated-file hook denies a stage | Don't fight it — unstage it; edit the generator (`app/scripts/sync-data.mjs`) instead. |
| `gh` missing/unauthed | `brew install gh` / `gh auth login`. |
| Auto-merge unavailable | Non-fatal. Report once; return the PR URL. |
