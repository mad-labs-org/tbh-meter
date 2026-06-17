## Description

<!-- What changed and WHY. One short paragraph. -->

<!-- If this PR closes an issue, keep the next line; otherwise delete it. -->
Closes #ISSUE

## Key changes

- <!-- change 1 -->
- <!-- change 2 -->

## Screenshots

<!-- Required for any UI change to the overlay/list windows. Drag images in here. Delete this
     section for non-UI PRs. -->

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would break existing behavior)
- [ ] Refactor / chore / docs (no user-visible behavior change)

## How was this tested?

- [ ] `app/`: `pnpm check` and `pnpm test` pass
- [ ] `reader/`: `ruff check .` and `pytest` pass
- [ ] Manually verified in the running app (Windows for the reader path; macOS dev renders the UI only)

## Checklist

- [ ] Conventional commit subjects — they drive the computed release version and the changelog
- [ ] Self-reviewed the diff
- [ ] No hand-edits to generated/synced files (`app/src/shared/data/`, `app/src/renderer/public/{sprites,heroes}/`) — edit the `data/` snapshot via `scripts/refresh-game-data.mjs` instead
- [ ] No secrets committed
