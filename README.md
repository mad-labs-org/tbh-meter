<div align="center">

# TBH Meter

**A live DPS meter & run tracker overlay for [Task Bar Hero](https://store.steampowered.com/)**

[![Latest Release](https://img.shields.io/github/v/release/mad-labs-org/tbh-meter-releases?label=latest&color=4c1)](https://github.com/mad-labs-org/tbh-meter-releases/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/mad-labs-org/tbh-meter-releases/total?color=blue)](https://github.com/mad-labs-org/tbh-meter-releases/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2B-0078d4)](https://github.com/mad-labs-org/tbh-meter-releases/releases/latest)

[<img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="45">](https://buymeacoffee.com/viniarruda)

</div>

---

## What is TBH Meter?

TBH Meter is a lightweight, always-on-top overlay that tracks your **Task Bar Hero** runs in real time:

| Metric | Description |
| ------ | ----------- |
| **MODE** | Current run difficulty (Normal / Nightmare / Hell / Torment) |
| **STAGE** | Current stage and act |
| **DPS** | Live damage per second |
| **DAMAGE** | Total damage dealt this run |
| **MOBS** | Monsters killed / total |
| **TIME** | Elapsed run time |

Every completed run is also saved with full details — result (success / fail / abandoned), gold & XP gained, gold/XP per second, and a complete snapshot of your heroes (class, level, items, mods, skills, and stats) — browsable from the built-in **Runs** window:

<div align="center">

![Runs window — per-run DPS, damage, XP, gold and clear time](.github/assets/runs-window.png)

</div>

## 📥 Installation

1. Go to the [**latest release**](https://github.com/mad-labs-org/tbh-meter-releases/releases/latest).
2. Download **`tbh-meter-Setup-<version>.exe`**.
3. Run the installer. **No admin rights required** — it installs per-user.
4. Launch Task Bar Hero, then launch TBH Meter (or the other way around — order doesn't matter).
5. On first launch the reader takes **1–2 minutes** to lock onto the game. Once it does, live stats appear automatically.

### ⚠️ "Windows protected your PC" warning

These builds are **not code-signed**, so Windows SmartScreen shows a blue warning the first time you run them. This is expected — the app is open-source and safe. To proceed:

1. Click **More info**
2. Click **Run anyway**

### 🛡️ Antivirus false positive

If your antivirus quarantines **`tbh-reader.exe`**, it is a **false positive** — that is the bundled game reader. Allow or restore it so the meter can read the game.

## ⚙️ How it works

TBH Meter has two parts working together:

1. **The reader** (`tbh-reader.exe`) — a small bundled process that reads the game's memory **read-only**. It never writes to or modifies the game in any way. It outputs live stats (~10×/second) and one record per finished run.
2. **The overlay app** — an Electron app that watches the reader's output and renders the live strip and run history.

Data is stored locally in **`~/tbh-meter/`** (configurable in Settings):

- `meter_live.txt` — live stats feed
- `runs.jsonl` — your full run history, one JSON record per run

If the game closes, the reader simply waits and reattaches automatically when you start playing again.

## 🖥️ Usage

- **Live overlay** — frameless, draggable, always-on-top strip. Resize its width by dragging the edges.
- **Follow game window** — pin the meter right below the game window so it moves with it (toggle in Settings; dragging the meter manually disables it).
- **Tray icon** — left-click to show/hide the meter; right-click for *Show live meter*, *Open runs*, and *Quit*.
- **Runs window** — browse your run history with full hero/item/stat details per run.

### Settings

| Setting | Description |
| ------- | ----------- |
| **Meter folder** | Where run data is stored (default `~/tbh-meter`) |
| **Follow game window** | Auto-pin the overlay below the game |
| **Window opacity** | 50–100% overlay transparency |
| **Leaderboard** | Sign in with Discord to auto-upload successful runs to the TBH Helper leaderboard |
| **Check for updates** | Manually check for a new version |

## 🔄 Updates

The app checks for updates on launch and every 6 hours, downloads them in the background, and offers a *Restart to update* prompt — no manual reinstall needed.

## ❓ FAQ

**Does it work on macOS / Linux?**
No — Windows 10+ only. The reader relies on Windows APIs.

**Can it get me banned?**
The reader only *reads* memory and never injects, modifies, or automates anything in the game.

**Where is my data? Is anything sent anywhere?**
Everything is stored locally in `~/tbh-meter/`. Runs are only uploaded if you explicitly sign in to the leaderboard in Settings.

**The meter says "Starting up — reading the game" forever.**
Make sure Task Bar Hero is actually running. The first attach can take 1–2 minutes. If it persists, restart both the game and the meter.

## ☕ Support

If TBH Meter helps your runs, consider buying me a coffee — it keeps development going!

[<img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="45">](https://buymeacoffee.com/viniarruda)

---

<sub>This repository hosts release artifacts and the auto-update feed only. The app is built and published by the private <code>tbh-wiki</code> CI. © 2025–2026 TBH Wiki Contributors.</sub>
