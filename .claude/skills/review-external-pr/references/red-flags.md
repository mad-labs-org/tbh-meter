# Red-flag catalog — hunt the payload in the diff

This is the adversarial sweep (SKILL.md §2, and re-used in §5). You are looking for the things a
patient attacker hides in an otherwise-plausible PR, and for the careless mistakes that have the
same blast radius because everything auto-updates to every user.

**Grep the diff, not the tree** — you care about what this PR *adds*. Get it once and search added
lines only:

```bash
gh pr diff <N> > /tmp/pr-<N>.diff
added() { grep -nE '^\+[^+]' "/tmp/pr-<N>.diff" | grep -iE "$1"; }   # added lines matching a pattern
```

Every hit is a *lead*, not a verdict — open the file:line, read the surrounding code, and decide.
But an un-investigated hit in a STOP category (SKILL.md) blocks the review.

## Contents

- [A. CI / workflow / repo-config tampering](#a) — the path to the release pipeline and its secrets
- [B. Dependency / supply-chain changes](#b)
- [C. Network egress, exfiltration & code execution](#c)
- [D. Obfuscation & trojan-source](#d)
- [E. Generated-file & game-data poisoning](#e)
- [F. Secrets & credentials](#f)
- [G. Scope & honesty mismatch](#g)

---

<a id="a"></a>
## A. CI / workflow / repo-config tampering — HIGHEST severity

**Why.** A *fork* PR cannot read this repo's secrets on its own PR run — that's a deliberate
boundary (CONTRIBUTING.md). The payoff comes **after merge**, when the workflow runs on
`push`/`main` (or in the release build) with the `production` environment secrets
(`DISCORD_ANNOUNCE_WEBHOOK`) and, above all, the ability to SHIP a release that auto-updates onto
every user. A poisoned action, a new exfil step, or a trigger that hands secrets to PR-controlled
code is how you lose the release pipeline. **Any diff under `.github/` from an external contributor is a STOP → escalate**,
full stop; the patterns below are what you point the maintainer at.

```bash
# Did the PR touch CI / actions / repo config at all?
grep -nE '^\+\+\+ b/\.github/' /tmp/pr-<N>.diff
grep -nE '^\+\+\+ b/(\.gitleaks\.toml|\.github/(workflows|actions|CODEOWNERS|dependabot))' /tmp/pr-<N>.diff
```

Point the maintainer at these specific patterns (each is a known CI-attack primitive):

- **`pull_request_target` / `workflow_run`** — these run with a **read/write token and access to
  secrets even for fork PRs**. Combined with checking out and building the PR head, this is the
  classic "pwn request" that leaks secrets from an unmerged PR. `added 'pull_request_target|workflow_run'`
- **Secret references added or moved** — `added 'secrets\.'` (esp. into a job a fork can trigger, or
  echoed/curled anywhere).
- **Permission escalation** — `added 'permissions:|contents: write|id-token: write|packages: write'`.
- **Script injection** — untrusted `${{ github.event.* }}` (PR title/body/branch) interpolated into a
  `run:` block. `added 'github\.event\.(pull_request|issue|comment)'` then read the `run:` around it.
- **Un-pinned or repointed actions** — an action moved from a pinned SHA to a tag/branch, or to a
  fork (`uses: someone-else/...`). This repo pins actions to SHAs on purpose — a change away from a
  SHA is a supply-chain regression. `added 'uses:'`
- **Arbitrary network / shell in build steps** — `added 'curl|wget|Invoke-WebRequest|nc |bash <|\| *sh'`.
- **Self-hosted runners** — `added 'runs-on:.*self-hosted'`.
- **The release path itself** — any edit to `meter-build-core.yml`, `meter-2-build.yml`,
  `meter-3-ship.yml`, `meter-1-stage.yml`, or `codeql.yml`/`scorecard.yml`/`secret-scan.yml`/
  `dependency-review.yml` (weakening a security gate is as bad as adding an exploit).
- **CODEOWNERS / branch-protection / gitleaks config** — a diff that removes reviewers, widens who
  can approve, or loosens `.gitleaks.toml` is tampering with the controls, not the code.

<a id="b"></a>
## B. Dependency / supply-chain changes — STOP → escalate

**Why.** A dependency runs with the app's full privileges and auto-ships to every user; a malicious
or typosquatted package, or a `postinstall` hook, is the highest-leverage single-line attack. A
"small feature" that *also* adds a dependency deserves 10× scrutiny on the dependency, not the
feature. The dependency-review workflow helps, but a fork PR's checks may be held (§3) — verify by hand.

```bash
grep -nE '^\+\+\+ b/(app/package\.json|app/pnpm-lock\.yaml|reader/(requirements.*\.txt|pyproject\.toml)|release-video/package\.json)' /tmp/pr-<N>.diff
added '"[^"]+": *"[^"]*"'          # added manifest entries (npm)
added 'postinstall|preinstall|prepare|prepublish|install"'   # lifecycle scripts run code on install
```

- **The reader is zero-dependency by law** (pure `ctypes` + stdlib — CONTRIBUTING.md, `reader/CLAUDE.md`).
  **Any** added entry in `reader/requirements.txt` / `pyproject.toml` is a giant flag; a runtime dep
  there is almost never legitimate.
- **Lifecycle scripts** (`postinstall` et al.) — code that runs the instant someone installs. Read it.
- **Typosquat / dependency-confusion** — a package name that's a homoglyph or near-miss of a popular
  one, or an internal-sounding name pulled from the public registry.
- **Non-registry sources** — a git/URL/tarball/`file:` dependency, or `overrides`/`resolutions`
  redirecting an existing dep to another version or source.
- **Lockfile-only changes** — an integrity-hash or resolved-URL change in `pnpm-lock.yaml` with no
  matching `package.json` change is lockfile poisoning. The lockfile must be explained by the manifest.
- **Version bumps** — bumping an existing dep can pull a compromised release; treat a bump like a new
  dep (what changed upstream, is the new version real and not yanked/backdoored).

<a id="c"></a>
## C. Network egress, exfiltration & code execution — STOP → escalate

**Why.** The app talks to exactly one place (GitHub Releases, for the auto-update check — per
SECURITY.md) and the reader talks to *nothing*. Any *new* outbound path or any dynamic code
execution is how data (memory contents, local files) leaves the machine or how attacker-controlled
code runs.

```bash
added 'https?://|wss?://|fetch\(|XMLHttpRequest|WebSocket|dgram|net\.(connect|Socket)|dns\.'
added 'child_process|execSync|execFile|spawn|\beval\(|new Function|require\([^'\''"]|import\('
added 'socket|urllib|httplib|http\.client|requests|ftplib|smtplib|subprocess|os\.system|os\.popen|os\.exec|pty\.|pickle\.loads|marshal\.loads|__import__|getattr\('
```

- **App main process** — scrutinize any change to `auto-update.ts` (the update **feed URL** —
  repointing it hijacks auto-update) and `net-fetch.ts`. The app has NO other outbound calls:
  a new host, or user data flowing to any sink, is exfil.
- **Reader** — it is read-only and offline. Any `import socket/urllib/http/subprocess`, any
  `os.system`/`popen`/`exec*`, or any `ctypes` process-manipulation beyond reading
  (**`WriteProcessMemory`, `CreateRemoteThread`, `VirtualAllocEx`, `OpenProcess` with write/operation
  access** — vs the allowed `PROCESS_VM_READ`) turns the sensor into an injector/cheat/malware.
  See area-review.md → reader → memory-safety.
- **Dynamic execution** — `eval`, `new Function`, dynamic `require`/`import`, Node `vm`/`child_process`,
  Python `exec`/`eval`/`compile`/`pickle`/`marshal`/`__import__`/attribute-dispatch on attacker data.
  A meter has essentially no legitimate reason to build and run code at runtime.
- **Credential reads that then move** — reading local files, env vars, or keytar and
  passing them into any of the sinks above.

<a id="d"></a>
## D. Obfuscation & trojan-source — STOP → escalate

**Why.** If you can't read it, you can't review it — and unreadable code is where payloads live.
Trojan-source uses invisible or look-alike Unicode so the diff you *read* differs from what
*compiles/runs*.

```bash
# Non-ASCII inside added lines (trojan-source / homoglyph identifiers). Excludes the legit
# localization surface: i18n dicts, data JSON, and the known unicode test fixture (repo is
# English-only by policy — non-ASCII anywhere ELSE in code is suspect).
grep -nP '^\+[^+].*[^\x00-\x7F]' /tmp/pr-<N>.diff \
  | grep -viE 'locales?/|i18n|/data/|\.json:|unicode.*fixture|test.*unicode'
added 'atob|Buffer\.from\([^,]+, *.base64|fromCharCode|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|base64|b64decode|codecs\.decode'
```

- **Bidi / zero-width control chars** — U+202A–202E, U+2066–2069 (bidi overrides), U+200B–200D, U+FEFF
  (zero-width). These reorder or hide code. The `grep -P` above surfaces any non-ASCII; inspect each.
- **Homoglyph identifiers** — Cyrillic/Greek letters that look Latin, defining a second identifier that
  shadows a real one.
- **Encoded blobs** — long base64/hex strings, `atob`/`Buffer.from(...,'base64')`, `\xNN`/`\uNNNN`
  arrays, minified or "vendored" bundles added as source. Decode and read them, or reject the blob.
- **Whitespace tricks** — code pushed far off-screen to the right, or hidden after long comment lines.

<a id="e"></a>
## E. Generated-file & game-data poisoning — STOP → escalate

**Why.** `app/src/shared/data/` and `app/src/renderer/public/{sprites,heroes}/` are **generated** from
the `data/` snapshot by `scripts/sync-data.mjs` (hook-enforced) — they are not source. A diff that
hand-edits them bypasses the pipeline and can inject arbitrary bundled content (code, or an image
shipped to every user) while looking like a "data update." `data/` itself is the source snapshot, but
it's regenerated from the wiki datamine (`scripts/refresh-game-data.mjs`), not authored by hand.

```bash
grep -nE '^\+\+\+ b/(app/src/shared/data/|app/src/renderer/public/(sprites|heroes)/)' /tmp/pr-<N>.diff
grep -nE '^\+\+\+ b/data/' /tmp/pr-<N>.diff
```

- Any hunk touching the two generated paths → the contributor edited a build output. Reject and ask
  them to change `data/` via the refresh script, and confirm the sync hook wasn't also disabled.
- Edits to `data/`: are they a coherent datamine result, or arbitrary values? Binary sprite/asset
  swaps can smuggle payloads or inappropriate images — verify provenance, don't eyeball a PNG.

<a id="f"></a>
## F. Secrets & credentials

**Why.** No credentials live in this repo (SECURITY.md); gitleaks scans every PR. But a fork PR's
scan may be held (§3), and gitleaks isn't perfect — verify, and note that weakening `.gitleaks.toml`
(category A) is itself the attack.

```bash
added 'AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{36}|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key|secret|token *[:=]'
```

Distinguish a real leaked credential (block, and warn: it must be rotated, not just deleted from the
diff — git history keeps it) from a variable *named* `token` that holds nothing sensitive.

<a id="g"></a>
## G. Scope & honesty mismatch

**Why.** The single most reliable tell across all of the above is a change that doesn't fit its story.
Payloads ride in on unrelated hunks bundled into a plausible PR.

- Cross-check the `files` list (§0) against the PR's stated purpose. A "fix typo" / "update docs" /
  "bump copy" PR that touches `.github/`, `*.ts` in `src/main`, `reader/`, or any manifest is lying by
  omission — treat the mismatch itself as the finding.
- Every file outside the stated scope is a separate thing the contributor must justify. "While I was
  here I also…" in security-sensitive code is where you slow down, not speed up.
