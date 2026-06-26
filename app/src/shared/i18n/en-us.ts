// English UI strings — the source of truth (#232). Every key lives here and its type
// drives `DictKey`. Other locale files provide partial overrides; missing keys fall
// back to English at lookup time (see ./index.ts). Same architecture as the web wiki
// (web/src/lib/locales/) so terminology stays consistent across the two apps.
//
// Game terms shown as raw data (stage codes like "3-9", mode abbreviations, hero
// classes, item names) are NOT translated here.

export const DICT = {
  // ── Common ──
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.reset": "Reset",
  "common.signOut": "Sign out",
  "common.signInDiscord": "Sign in with Discord",
  "common.waitingBrowser": "Waiting for browser…",

  // ── Live overlay ──
  "live.pillStarting": "Starting",
  "live.pillOffline": "Offline",
  "live.startingMsg": "Starting up — reading the game (first launch 1–2 min, up to 5)",
  "live.offlineMsg": "Meter offline — open Task Bar Hero",
  "live.blockedMsg": "Reader blocked — antivirus may be closing it.",
  "live.retry": "Retry",
  "live.statusLive": "Live",
  "live.statusOffline": "Offline",
  "live.syncLive": "Live — uploading runs to the leaderboard",
  "live.syncOff": "Not syncing — sign in to upload your runs",
  "live.dps": "DPS",
  "live.mobs": "Mobs",
  "live.gold": "Gold",
  "live.exp": "EXP",
  "live.loot": "Loot",
  "live.noLoot": "no loot",
  "live.team": "Team",
  "live.time": "Time",
  "live.timeToLevel": "Time to level",
  "live.maxed": "MAX",
  "live.chestCommon": "Common",
  "live.chestStageBoss": "Stage boss",
  "live.chestActBoss": "Act boss",
  "live.minimizeTitle": "Minimize (keeps running in the background)",
  "live.collapseTitle": "Collapse (2 lines)",
  "live.expandTitle": "Expand",
  "live.pinTitle": "Always on top (click to turn off)",
  "live.unpinTitle": "Not always on top (click to pin the meter above other windows)",
  "live.sessionStats": "Session stats",
  "live.openLogs": "Open logs",
  "live.dragResize": "Drag to resize",
  "live.dragScale": "Drag to scale the meter",

  // ── Startup splash ──
  "splash.searching": "Looking for Task Bar Hero…",
  "splash.resolving": "Reading the game's memory…",
  "splash.scanning": "First time on this version — mapping memory (a few minutes). Just once.",
  "splash.ready": "Ready!",
  "splash.update.badge": "Update",
  "splash.update.note": "Installing the latest version — takes a few seconds, then the meter restarts itself.",
  "splash.update.restarting": "Updated! Restarting the meter…",
  "splash.tipLabel": "Tip:",
  "splash.tip1": "Drag the meter by the handle on the left to reposition it.",
  "splash.tip2": "Enter combat to see your DPS in real time.",
  "splash.tip3": "Signed in, your runs upload to the leaderboard automatically.",
  "splash.tip4": "The meter only READS the game's memory — it never writes anything.",

  // ── Window headers ──
  "header.tabRuns": "Runs",
  "header.tabTracker": "Tracker",
  "header.tabPlanner": "Leveling Planner",
  "header.tabSettings": "Settings",
  "header.signIn": "Sign in",
  "header.signedIn": "Signed in",
  "header.appVersion": "App version",
  "header.restartToUpdate": "Restart to update",
  "header.updateReady": "Update v{version} ready",
  "header.updateDownloading": "Downloading update v{version}…",
  "header.updateBadge": "Update v{version}…",

  // ── Settings ──
  "settings.meterFolder": "Meter folder",
  "settings.meterFolderDesc": "Runs and live data, plus a logs/ archive (one JSON per run)",
  "settings.notSet": "Not set",
  "settings.openFolder": "Open folder",
  "settings.change": "Change…",
  "settings.position": "Meter position",
  "settings.positionDesc": "Lost the overlay off-screen? Recenter it at the default size.",
  "settings.alwaysOnTop": "Keep the meter always on top",
  "settings.alwaysOnTopDesc":
    "The live meter floats above every other window. Turn off to let other windows cover it — use its taskbar button to bring it back.",
  "settings.opacity": "Window opacity",
  "settings.language": "Language",
  "settings.languageDesc": "Language of the meter windows.",
  "settings.languageAuto": "Auto (system)",
  "settings.fontSize": "Font size",
  "settings.fontSizeDesc":
    "Scales the text of each window. You can also drag the live meter's bottom edge.",
  "settings.fontLive": "Live meter",
  "settings.fontRuns": "Runs window",
  "settings.startup": "Start with Windows",
  "settings.startupDesc": "Open the meter automatically when Windows starts.",
  "settings.runFilter": "Run filter",
  "settings.runFilterDesc":
    "Choose which runs show in your list. This is local only — it never changes the leaderboard.",
  "settings.hideIgnored": "Hide ignored runs",
  "settings.hideIgnoredDesc":
    "Skipped and unreadable-data runs stay hidden; partial clears (the meter joined mid-run) still show. Hidden runs still count toward your session and can be revealed from the runs list anytime.",
  "settings.hideShorter": "Hide runs shorter than",
  "settings.seconds": "seconds",
  "settings.minDurationDesc":
    "Minimum {floor}s (shorter runs never count). Act-boss (x-10) clears are always shown.",
  "settings.maxRuns": "Limit stored runs",
  "settings.maxRunsDesc":
    "Keep at most this many runs on this computer. When you go over, the oldest runs are deleted automatically. Favorited runs are always kept and don't count toward the limit.",
  "settings.maxRunsUnit": "runs",
  "settings.leaderboard": "Leaderboard",
  "settings.signedInAs": "Signed in as",
  "settings.uploadAuto": "Successful runs upload automatically.",
  "settings.signInPitch":
    "Sign in with Discord from the header to rank on the TBH Helper leaderboard. Signing in also claims the runs already uploaded anonymously from this computer.",
  "settings.usageStats": "Usage statistics",
  "settings.usageStatsLabel": "Share anonymous usage statistics",
  "settings.usageStatsDesc":
    "Helps us see how many people use the meter (anonymous, via Google Analytics). No personal data, no run details. Turn this off to opt out completely.",
  "settings.runHistory": "Run history",
  "settings.runHistoryDesc":
    "Delete all runs stored on this computer. Runs already shared to the leaderboard are not affected and stay on the web.",
  "settings.clearHistory": "Clear run history",
  "settings.clearConfirmTitle": "Clear run history?",
  "settings.clearConfirmBody":
    "This deletes every run from this meter, including the logs archive. Favorited runs are kept. It cannot be undone. Runs already shared to the leaderboard stay there.",
  "settings.clearError": "Could not clear the run history. Please try again.",
  "settings.clearing": "Clearing…",
  "settings.deleteAll": "Delete all runs",
  "settings.community": "Community",
  "settings.communityDesc": "Bug reports and feature requests live in the community Discord.",
  "settings.discordBtn": "Bugs & feedback on Discord",
  "settings.createdBy": "Created by Mad Labs",
  "settings.checkUpdates": "Check for updates",
  "settings.updateChecking": "Checking for updates…",
  "settings.upToDate": "On the latest version",
  "settings.updateFailed": "Update check failed",

  // ── Runs list ──
  "runs.colStage": "Stage",
  "runs.colClearTime": "Clear time",
  "runs.colTeam": "Team",
  "runs.colDps": "DPS",
  "runs.colTotalDamage": "Total DMG",
  "runs.colExp": "EXP",
  "runs.colExpPerSec": "EXP/s",
  "runs.colGold": "Gold",
  "runs.colGoldPerSec": "Gold/s",
  "runs.colDrops": "Drops",
  "runs.colDate": "Date",
  "runs.flaggedRun": "{label} run",
  "runs.teamTooltip": "{class} · lvl {level}",
  "runs.hideIgnoredBtn": "Hide ignored",
  "runs.showIgnoredBtn": "Show ignored ({count})",
  "runs.hideIgnoredTitle":
    "Hide skipped and degraded runs (partial clears still show; everything still counts toward your session)",
  "runs.showIgnoredTitle":
    "Show runs the meter ignored — too short or with unreadable data",
  "runs.columns": "Columns",
  "runs.columnsTitle": "Show / hide / reorder columns",
  "runs.newSession": "New session",
  "runs.newSessionConfirm": "Confirm?",
  "runs.newSessionTitle":
    "Ends the current session. The next runs start a new session; runs already uploaded stay on the site.",
  "runs.sessionStats": "Session stats",
  "runs.sessionStatsTitle": "Open the current session's stats in your browser",
  "runs.hintNoRunsCurrent":
    "No runs in the current session yet. Finish a run and it'll appear on the site.",
  "runs.hintNoRuns":
    "Finish at least one run. Your session is saved on the site once it has a completed run.",
  "runs.emptyFiltered": "No runs match your filter",
  "runs.showIgnoredOne": "Show {count} ignored run",
  "runs.showIgnoredMany": "Show {count} ignored runs",
  "runs.emptyDuration": "All runs are shorter than your minimum duration",
  "runs.clearDurationFilter": "Clear duration filter",
  "runs.emptyNone": "No completed runs yet",
  "runs.currentSession": "Current session",
  "runs.earlierRuns": "Earlier runs",
  // Interactive filter bar + sort + favorites (Feature 3/4)
  "runs.colFavorite": "★",
  "runs.favorite": "Favorite",
  "runs.favoriteAdd": "Add to favorites",
  "runs.favoriteRemove": "Remove from favorites",
  "runs.filters": "Filters",
  "runs.filtersTitle": "Filter the runs you see",
  "runs.filterStage": "Stage",
  "runs.filterMode": "Mode",
  "runs.filterStatus": "Status",
  "runs.filterFavorites": "Favorites only",
  "runs.filterAny": "Any",
  "runs.clearFilters": "Clear filters",
  "runs.sortBy": "Sort by",
  "runs.sortDesc": "Highest first",
  "runs.sortAsc": "Lowest first",
  "runs.emptyFilterBar": "No runs match these filters",
  "runs.rows": "Rows",
  "runs.rangeOf": "{start}–{end} of {total}",
  "runs.prevPage": "Previous page",
  "runs.nextPage": "Next page",

  // ── Run detail ──
  "detail.back": "Runs",
  "detail.loading": "Loading…",
  "detail.notFound": "Run not found or data is corrupt.",
  "detail.backToList": "Back to list",
  "detail.measuredTitle": "measured duration",
  "detail.measuredParen": "(measured {duration})",
  "detail.measuredNe": "measured ≠ official",
  "detail.damage": "Damage",
  "detail.xp": "XP",
  "detail.mobs": "Mobs",
  "detail.deaths": "Deaths",
  "detail.revived": "{count} revived",
  "detail.drops": "Drops",
  "detail.chestsOne": "{count} chest",
  "detail.chestsMany": "{count} chests",
  "detail.shareView": "View on TBH Helper",
  "detail.sharing": "Sharing…",
  "detail.shareBtn": "Share to leaderboard",
  "detail.shareSignIn": "Sign in with Discord to share",
  "detail.shareError": "Something went wrong. Please try again.",
  "detail.fullDetails":
    "Want the full breakdown? The party with each hero's equipment, skills, and stats is on the run page on TBH Helper.",
  "detail.fullDetailsShare": "Share the run to view it on the site.",
  "detail.viewFull": "View full details",
  "detail.xpByHero": "XP by hero",
  "detail.heroLv": "Lv {level}",
  "detail.levelUp": "Leveled up",
  "detail.heroDeaths": "{count} deaths",

  // ── Run status + quality verdicts ──
  "status.success": "Success",
  "status.fail": "Fail",
  "status.abandoned": "Abandoned",
  "quality.partialLabel": "Partial",
  "quality.partialTitle":
    "The meter joined this run while it was already in progress, so its totals are under-counted. It was not uploaded to the leaderboard.",
  "quality.degradedLabel": "Degraded",
  "quality.degradedTitle":
    "Some values could not be read for this run, so the numbers may be wrong. It was not uploaded to the leaderboard.",
  "quality.skippedLabel": "Invalid",
  "quality.skippedTitle":
    "This run is not a valid clear (too short, or it ended in a fail or abandon), so it does not count and was not uploaded to the leaderboard.",

  // ── Run-outcome marker (the runs-list icon/tint + detail banner) — distinguishes WHY a run did
  //    not count by combining status + quality, unlike the quality-only verdict copy above. Purely
  //    cosmetic; it never changes which runs count, upload, or are hidden. ──
  "outcome.buggedLabel": "Bugged",
  "outcome.buggedTitle":
    "Some values could not be read for this run, so the numbers may be wrong. It was not uploaded to the leaderboard.",
  "outcome.failedLabel": "Failed (wipe)",
  "outcome.failedTitle":
    "The party was wiped before clearing the stage, so this run does not count and was not uploaded to the leaderboard.",
  "outcome.abandonedLabel": "Abandoned",
  "outcome.abandonedTitle":
    "This run was left before the stage was cleared, so it does not count and was not uploaded to the leaderboard.",
  "outcome.partialLabel": "Partial",
  "outcome.partialTitle":
    "The meter joined this run while it was already in progress, so its totals are under-counted. It was not uploaded to the leaderboard.",
  "outcome.tooShortLabel": "Too short",
  "outcome.tooShortTitle":
    "This clear was below the minimum length to count, so it does not count and was not uploaded to the leaderboard.",

  // ── Blue-chest tracker ──
  "cooldowns.title": "Blue-chest tracker",
  "cooldowns.desc": "Auto-detects drops and tracks each chest level's cooldown — no clicks.",
  "cooldowns.toggleOn": "Tracker on — click to turn off",
  "cooldowns.toggleOff": "Tracker off — click to turn on",
  "cooldowns.offTitle": "Tracker off",
  "cooldowns.offDesc": "Turn it on above to auto-detect blue-chest drops.",
  "cooldowns.emptyTitle": "No blue chest tracked yet",
  "cooldowns.history": "History",
  "cooldowns.hideHistory": "Hide history",
  "cooldowns.showHistory": "Show history",
  "cooldowns.showingRecent": "showing {shown} most recent of {total}",
  "cooldowns.stageLabel": "Stage {code}",
  "cooldowns.openStage": "Open this stage on the site",
  "cooldowns.ready": "Ready",
  "cooldowns.readyCheck": "✓ Ready",
  "cooldowns.remove": "Remove (reappears on the next drop)",
  "cooldowns.spots": "spots",
  "cooldowns.notifTitle": "Blue chest ready",
  "cooldowns.notifBody": "{where} — the blue chest is off cooldown.",
  "cooldowns.chestLabel": "Lv{level}",
  "cooldowns.available": "Available",
  "cooldowns.unpin": "Unpin from route",
  "cooldowns.timerLabel": "Cooldown (min)",
  "cooldowns.routeLabel": "Route — pin chest levels to always track",
  "cooldowns.trackOutside": "Track chests outside the route",
  "cooldowns.trackOutsideDesc": "When off, only pinned levels are tracked.",
  "cooldowns.clearAll": "Clear all",
  "cooldowns.clearAllConfirm": "Click to confirm",
  // ── Notifications (per-chest-type drop alerts) ──
  "notifications.title": "Notifications",
  "notifications.desc": "Get an OS notification when a chest drops. Choose which chest types.",
  "notifications.common": "Common chest",
  "notifications.commonDesc": "Off by default: common chests drop almost constantly.",
  "notifications.commonTitle": "Common chest dropped",
  "notifications.commonBody": "{where}: a common chest just dropped.",
  "notifications.stageBoss": "Blue chest (stage boss)",
  "notifications.stageBossDesc": "The stage-boss chest, on its 14-min farm cooldown.",
  "notifications.stageBossTitle": "Blue chest dropped",
  "notifications.stageBossBody": "{where}: a blue chest just dropped.",
  "notifications.actBoss": "Act-boss chest",
  "notifications.actBossDesc": "The rare chest from an act-boss clear.",
  "notifications.actBossTitle": "Act-boss chest dropped",
  "notifications.actBossBody": "{where}: an act-boss chest just dropped.",

  // ── Sign-in prompt modal ──
  "signin.title": "Share your runs on the leaderboard",
  "signin.body":
    "You're not signed in, so your runs stay on this computer and never reach the leaderboard. Sign in with Discord to sync them so they count for the leaderboard and your profile.",
  "signin.dontShow": "Don't show this again",
  "signin.notNow": "Not now",

  "signin.pendingTitle": "Your runs aren't syncing",
  "signin.pendingBody":
    "You're signed out, so finished runs stopped reaching the leaderboard ({count} waiting locally). Sign in to sync them.",
  "signin.expiredTitle": "Your session expired",
  "signin.expiredBody":
    "You were signed out, so your runs stopped syncing to the leaderboard. They're saved locally. Sign in again to resume.",
  // ── Tray menu ──
  "tray.showLive": "Show live meter",
  "tray.openRuns": "Open runs",
  "tray.quit": "Quit",

  // ── Native dialogs (main process) ──
  "dialog.notSignedInTitle": "You are not signed in",
  "dialog.notSignedInMsg": "Your runs are not being uploaded to the site.",
  "dialog.notSignedInDetail":
    "The session page will show up empty. Sign in with Discord to upload your runs. Runs made while signed out (including this session's) are uploaded as soon as you sign in.",
  "dialog.openAnyway": "Open anyway",

  // ── Chests / drops ──
  "chest.fallback": "Chest",
  "chest.tooltip": "{name} ×{count}",

  // ── EXP "Leveling Planner" (measured-first) ──
  // Step 1 — pick the subject
  "planner.stepWho": "Who do you want to level?",
  "planner.subjectTeam": "Team",
  "planner.subjectTeamFull": "Whole team",
  "planner.heroesCaption": "Your {n} most-recently-played heroes, from your run history.",
  "planner.maxPill": "MAX",
  // Step 2 — target
  "planner.stepHowFar": "How far?",
  "planner.targetLabel": "Target level",
  // Step 3 — the plan + its sub-tabs
  "planner.planForHero": "{subject}'s plan",
  "planner.tabFullClimb": "Full Climb",
  "planner.tabNextLevel": "Next Level",
  // Data-basis mode (practical = farmed-only / theoretical = + datamine estimates)
  "planner.modePractical": "Practical",
  "planner.modeTheoretical": "Theoretical",
  "planner.modePracticalDef": "Only stages you've farmed — ranked by your real XP/s. No estimates.",
  "planner.modeTheoreticalDef": "Every stage, including ones you've never farmed — times are game-data estimates.",
  "planner.practicalEmpty": "No farmed stages for this hero yet — switch to",
  // Full Climb tab
  "planner.climbTo": "To {target}",
  "planner.climbTotal": "≈ {time} · at {dps} DPS",
  "planner.colLevels": "Levels",
  "planner.colStage": "Best stage",
  "planner.colTime": "Time",
  "planner.colSource": "Source",
  "planner.gatedBy": "Gated by {hero} (last to finish).",
  "planner.perHeroBreakdown": "Per-hero breakdown",
  // Next Level tab
  "planner.nextLevelUp": "Next level-up",
  "planner.nextLevelJump": "Lv {from} → {to}",
  "planner.nextBestRoute": "best route",
  "planner.nextWhereToFarm": "Where to farm it — fastest first:",
  "planner.showAllStages": "Show all {n}",
  "planner.showFewer": "Show fewer",
  "planner.gatingHero": "gating hero",
  // Source badges (the only confidence signal — measured XP vs datamine estimate)
  "planner.srcMeasured": "your runs",
  "planner.srcEstimated": "estimated",
  "planner.srcMeasuredTip": "Time from the real XP you earned on this stage — your runes & accessories are already baked in.",
  "planner.srcEstimatedTip": "You haven't farmed this stage — projected from game data scaled by your measured EXP rate; sharpens as you play it.",
  "planner.footMeasuredVsEstimated":
    "From your runs = the real XP you earned there. Estimated = stages you haven't farmed, projected from game data.",
  // Under-level keep warning (the lone keep caveat that survives)
  "planner.keepApprox": "above your level",
  "planner.keepApproxTip":
    "This stage is above your level — the XP-keep here is unvalidated; treat as a rough guide.",
  "planner.noFarmStage": "No valid farm stage at Lv {level} — clear a higher stage first.",
  // How it works
  "planner.howTitle": "How it works",
  "planner.how1": "Reads your runs — your levels, clear times, and the real XP you gained per stage.",
  "planner.how2": "Finds the fastest route — the best stage for each level as you climb (the sweet spot rises with you).",
  "planner.how3": "Honest about confidence — ● from your runs where you've farmed; ◔ estimated from game data elsewhere.",
  // States
  "planner.emptyTitle": "Play a few runs first",
  "planner.emptyBody":
    "The planner learns from your own clears — your levels, clear times, and the real XP you gained per stage. Once you've finished a run or two, it'll map the fastest path to your target level.",
  "planner.maxedTitle": "Your team is maxed",
  "planner.maxedBody": "Nothing left to climb.",
  "planner.alreadyThere": "Already at the target level.",

  // ── Difficulty modes (game enum, display only) ──
  "mode.Normal": "Normal",
  "mode.Nightmare": "Nightmare",
  "mode.Hell": "Hell",
  "mode.Torment": "Torment",

  // ── Relative time ──
  "ago.justNow": "just now",
  "ago.m": "{n}m ago",
  "ago.h": "{n}h ago",
  "ago.d": "{n}d ago",
  "ago.w": "{n}w ago",
  "ago.mo": "{n}mo ago",
  "ago.y": "{n}y ago",
} as const;

export type DictKey = keyof typeof DICT;
