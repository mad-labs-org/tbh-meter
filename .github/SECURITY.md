# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
open the **Security** tab of this repository and click **Report a vulnerability**. That opens a
private advisory only the maintainers can see.

Please include:

- What the issue is and the impact you expect.
- Steps to reproduce (a proof of concept helps).
- The affected component: the meter **app** (`app/`) or the **reader** (`reader/`).

We aim to acknowledge a report within a few days and to keep you updated while we work on a fix.
Please give us reasonable time to ship a fix before any public disclosure.

## Scope

In scope:

- The Electron overlay app (`app/`).
- The Python memory reader (`reader/`), shipped as `tbh-reader.exe`.
- The release pipeline (`.github/workflows/`).

Out of scope:

- The Task Bar Hero game itself. This is an unaffiliated fan project; report game issues to the
  game's developer.
- The Task Bar Hero Wiki / leaderboard API (a separate project at tbherohelper.com). The meter only
  *calls* its public HTTP endpoints — report API/website issues there.
- Dependency advisories with no demonstrated exploit in this project.
- Findings that require an already-compromised machine or physical access.

## What the reader does (so you can assess risk)

The reader attaches to the running game process and reads its memory (`ReadProcessMemory` on
Windows) to compute per-run stats. It does **not** write to game memory, modify game files, or
inject code — it is a read-only sensor. It is unsigned (see the README for the SmartScreen note),
which is the most common false-positive reported by antivirus software.

## How secrets are handled

No credentials are committed to this repository. The app talks only to public endpoints
(`api.tbherohelper.com`) and stores its own per-user auth token locally in the OS user-data
directory. A [gitleaks](https://github.com/gitleaks/gitleaks) scan runs in CI on every pull request
and push to keep the history secret-free (config: [`.gitleaks.toml`](../.gitleaks.toml)).
