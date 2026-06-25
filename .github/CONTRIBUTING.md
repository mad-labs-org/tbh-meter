# Contributing to TBH Meter

Thanks for your interest! This guide covers local setup, the checks your PR must pass, and how
releases work. By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Repository layout

```
app/      Electron overlay (TypeScript/React). Its OWN pnpm workspace — run pnpm from here.
reader/   Python memory reader (pure ctypes + stdlib). Frozen to tbh-reader.exe by CI.
data/     Committed game-data snapshot (JSON + sprites) the app bundles. Source of truth.
scripts/  Maintainer tooling (refresh-game-data.mjs).
.github/  CI + the release pipeline workflows.
```

Area-specific rules live in `app/CLAUDE.md` and `reader/CLAUDE.md`. **Before touching reader code,
read `reader/docs/_index.md`** — the reader is the highest-risk part of the project (IL2CPP
resolution, memory offsets, calibration) and the knowledge base there is the source of truth.

## Prerequisites

- **Node 22** and **pnpm** (`corepack enable` or install pnpm directly) — for the app.
- **Python 3.12** — for the reader.
- **Windows** to actually attach to the game. The app UI, lint, and tests run on macOS/Linux too;
  only the live memory-reading path is Windows-only.

## Working on the app

```bash
cd app
pnpm install
pnpm dev      # launch the overlay. On macOS this renders the UI only (no game attach) —
              # feed fake artifacts into your ~/tbh-meter folder to exercise the watchers.
pnpm dev:mock # same as `pnpm dev`, but runs against a mocked API with NO backend (MSW) —
              # auth/upload/error-relay all complete locally; see src/mocks/.
pnpm check    # eslint + tsc (both tsconfigs) — must pass
pnpm test     # vitest — must pass
```

`pnpm dev`/`build`/`test` run `sync-data` first, which copies the `data/` snapshot into the app's
(git-ignored) runtime dirs. **Never hand-edit `app/src/shared/data/` or
`app/src/renderer/public/{sprites,heroes}/`** — they are regenerated. To change bundled game data,
refresh the snapshot (below) instead.

## Working on the reader

```bash
cd reader
pip install ruff -r requirements-dev.txt
ruff check .            # lint — must pass
python -m pytest        # tests — must pass (platform-independent; they run anywhere)
```

The reader has **no runtime dependencies** (pure `ctypes` + stdlib). The release pipeline freezes it
into `tbh-reader.exe` with PyInstaller, bundling `reader/config/` (offsets, level curve, and the
calibration seed). Maintainer scripts for live calibration live in `reader/scripts/` and require
Windows + the game running.

## Refreshing game data after a patch (maintainers)

When Task Bar Hero updates and the bundled metadata goes stale, regenerate the `data/` snapshot from
a [Task Bar Hero Wiki](https://tbherohelper.com) checkout (which runs the datamine pipeline):

```bash
node scripts/refresh-game-data.mjs --wiki /path/to/tbh-wiki
```

That rewrites `data/{json,sprites,heroes}`. Commit the result. (A game patch usually also needs the
reader re-calibrated — see `reader/CLAUDE.md` / the reader docs.)

## How changes get in

Trunk-based — there is no `dev` or `prod` branch. `main` is the single long-lived branch and is
always releasable. Everything lands through a pull request; nobody pushes to `main` directly.

### Contributors — fork & PR

You need **no access to this repo** to contribute — the standard open-source flow:

1. **Fork** the repository (UI "Fork" button, or `gh repo fork mad-labs-org/tbh-meter --clone`).
2. In your fork, branch off `main` (`fix/…`, `feat/…`) and commit your work.
3. **Open a pull request** against `main` here. Start every change from an issue and reference it
   (`Closes #123` in the PR description).

Because your branch lives in **your** fork, the main repo stays clean and you keep full control of
your own work — you can update or close your PR, and close the issue you opened, any time. CI (the
app + reader gates, the gitleaks scan, and the PR-hygiene checks) plus a maintainer's **code-owner
review** must pass before it merges.

### Maintainers — direct branch

Maintainers (write access) skip the fork: clone the repo, branch off `main`, push, and open the PR
the same way. **Write access is reserved for maintainers** — it carries trust over the release
pipeline and repository secrets (a PR from an in-repo branch can read CI secrets; a fork PR can't),
so everyone else uses the fork flow above. New maintainers are invited after a track record of solid
contributions.

### Notes

- **Merging to `main` does not ship anything to players** (see *How releases work*, below). It lands
  the change and auto-stages a release *candidate* tag; nothing reaches users until a maintainer
  ships, deliberately.
- **Unfinished or risky work goes behind a flag/config**, not a long-lived branch, so it can land on
  `main` without being switched on for users.
- **"Production" is not a branch:** it is whatever release is flagged **Latest** on this repository's
  [Releases](../../releases) — the feed the in-app updater follows. (Auto-update means everyone moves
  forward together, so we don't keep an old-version branch.)

## Maintainers & governance

Maintained by @marioalvial, @viniarruda, and @pedrobullo (see `.github/CODEOWNERS` for who reviews
what). Governance is deliberately light for a small project: changes land by **maintainer consensus**
through PR review, and when there's no clear consensus the **code owner of the affected area** has the
final say for that area. New maintainers are invited by the current ones after a track record of solid
contributions. Security issues follow [`SECURITY.md`](./SECURITY.md), conduct follows the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Commits & pull requests

- **Use [Conventional Commits](https://www.conventionalcommits.org)** (`feat:`, `fix:`, `chore:`,
  `feat!:`/`BREAKING CHANGE:`). They are **load-bearing**: the release pipeline computes the next
  version from them, and the changelog is built from the subjects.
- Keep PRs focused. Fill in the PR template, including how you tested.
- CI (`.github/workflows/ci.yml`) runs the app and reader gates above on every PR. A
  [gitleaks](https://github.com/gitleaks/gitleaks) secret scan also runs — **never commit secrets**.

## How releases work (maintainers)

Releases are driven by `tbh-meter-v*` git tags and are **decoupled from merging**: merging a PR to
`main` never ships to players — you ship deliberately, when you decide. Installers and the
auto-update feed are published as **GitHub Releases on this repository** — the same feed the in-app
updater and the wiki's download button read.

### What goes into the next release, and when

- **What** — every meter commit (`app/`, `reader/`, `data/`) merged to `main` **since the last stable
  `tbh-meter-v<x.y.z>` tag**. It is always visible: the **Create version tag** run prints
  _"Meter commits since vX: N"_ and lists the pending changes in its run summary, and locally
  `git log <last-stable-tag>..main -- app reader data` shows the same set. Those commit subjects
  become the release changelog — so writing good Conventional Commit subjects _is_ writing the
  changelog.
- **When** — a deliberate maintainer decision; there is no automatic ship. Cut a release when enough
  has accumulated to be worth it, or when a fix needs to reach players now. The pipeline keeps the
  next version staged and ready, so you only choose the moment.
- **Version** — computed from those commits (`feat` → minor, `fix` → patch, breaking → major; while
  the major is `0`, both `feat` and breaking bump the minor).

For planning _intent_ (what you'd like in a release vs. what is actually staged), optionally keep a
GitHub **Milestone** per version — but the commit range above stays the source of truth for what
actually ships.

### The pipeline — three numbered workflows

Tag-driven, in the Actions tab (the build only runs on demand):

1. **Create version tag** (`meter-1-stage`) — automatic on push to `main` touching `app/`, `reader/`,
   or `data/`. Computes the next RC version from the commits and pushes a marker tag
   `tbh-meter-v<ver>-rc.<N>`. No build. It is a **green no-op when nothing under `app/`, `reader/`, or
   `data/` changed** (the same "refuse on empty" guard `compute-version.mjs` enforces). You never click
   this one.
2. **Build test version** (`meter-2-build`) — manual. Builds the **RC variant** and publishes a **draft
   release** here for smoke-testing (invisible to anonymous users and to the in-app updater). Inputs:
   blank = the newest staged RC; `candidate=<ver>` = a specific RC; `pr=<N>` = a throwaway pre-merge
   build of that PR's head (version `0.0.0-pr.<N>.<run>`, download link posted as a PR comment). One
   mutable draft slot per target.
3. **Release to players** (`meter-3-ship`) — manual. Rebuilds the **stable variant** from the chosen
   RC's exact commit (frozen lockfile, so "ship == tested commit"), publishes it draft-first then flips
   it to **Latest**, pushes the clean `tbh-meter-v<ver>` tag at the built commit (a plain push — never
   forced), sweeps stale RC drafts, and announces on Discord. `direct_from_main=true` ships main's
   current code straight to players with no RC. Guards refuse a downgrade (≤ the current Latest) and a
   duplicate tag pointing at a different commit.

`meter-build-core` is the internal Windows build (reader exe + `--selftest` + electron-builder) shared
by 2 and 3.

`meter-pr-cleanup` runs automatically when a PR closes (you never click it): it deletes that PR's
throwaway test-build draft and, on a **merge**, shows the version the push just staged — with a
one-click build link — right on the run named after your PR. A merge fires both a `push` and a
`pull_request` event, so staging (Meter 1) and this cleanup land in two separate, single-purpose runs.

**The RC variant installs side by side.** `meter-2` (and PR builds) set `TBH_BUILD_VARIANT=rc`, so the
RC installs as `tbh-meter-rc` in its own folder, stores its data in `~/tbh-meter-rc`, and has auto-update
**disabled** — testing an RC never clobbers a real install.

**Versioning** (`app/scripts/compute-version.mjs`): the base is the highest clean `X.Y.Z` `tbh-meter-v*`
tag; `-rc.N` and `0.0.0-pr.*` tags never become the base. With **zero meter commits since the base it
refuses**, so an empty release can't be cut. Graduating to `1.0.0` is just a normal commit that bumps the
`package.json` version floor; that version is written only for the build, never committed.

### Required repository secrets (maintainers)

| Secret | Used by | Purpose |
|---|---|---|
| `DISCORD_ANNOUNCE_WEBHOOK` | meter-3 | Posts the release announcement to Discord. |

The default `GITHUB_TOKEN` covers everything else — publishing releases, tag pushes, and changelog
reads — since the source, the pipeline, and the release artifacts now all live in this one
repository. CI and the secret scan need no secrets.
