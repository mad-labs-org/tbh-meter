import { useState, useEffect, useCallback, useRef } from "react";
import {
  FolderOpen,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  LogOut,
  Loader2,
  Trash2,
  Minus,
  Plus,
  FileText,
} from "lucide-react";
import type { AppSettings, AuthStatus, UpdateStatus } from "../../../shared/ipc-types.js";
import { FONT_SCALE_MIN, FONT_SCALE_MAX, clampFontScale } from "../../../shared/ipc-types.js";
import { COUNT_FLOOR_SEC } from "../../../shared/run-types.js";
import { AUTO_LOCALE, LOCALES } from "../../../shared/i18n/index.js";
import { clampMinDuration } from "~/lib/run-filter";
import {
  clampMaxRuns,
  MIN_MAX_RUNS,
  clampCooldownMin,
  COOLDOWN_MIN_MINUTES,
  COOLDOWN_MAX_MINUTES,
} from "../../../shared/ipc-types.js";
import { chestSprite } from "~/lib/game-data";
import { DiscordIcon } from "~/components/DiscordIcon";
import { Modal } from "~/components/Modal";
import { useT } from "~/lib/i18n";
import { cn } from "~/lib/utils";
import { DiagnosticsLogView } from "./DiagnosticsLogView";

interface SettingsViewProps {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
}

export function SettingsView({ settings, onSettingsChange }: SettingsViewProps) {
  const t = useT();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const opacityPct = Math.round(settings.opacity * 100);
  const [resolvedDir, setResolvedDir] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  const [updaterSupported, setUpdaterSupported] = useState(false);

  const refreshDir = useCallback(() => {
    window.meter.resolvedOutputDir().then(setResolvedDir);
  }, []);

  useEffect(() => {
    refreshDir();
  }, [refreshDir, settings.outputDir]);

  // Current version + live auto-update status. Fetch on mount (catches events that
  // fired before this window opened) and subscribe for changes.
  useEffect(() => {
    window.meter.getAppVersion().then(setVersion);
    window.meter.updaterSupported().then(setUpdaterSupported);
    window.meter.getUpdateStatus().then(setUpdate);
    return window.meter.onUpdateStatus(setUpdate);
  }, []);

  const handleChooseFolder = async () => {
    const picked = await window.meter.pickOutputDir();
    if (picked) {
      onSettingsChange({ outputDir: picked });
      setResolvedDir(picked);
    }
  };

  if (diagnosticsOpen) return <DiagnosticsLogView onBack={() => setDiagnosticsOpen(false)} />;

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
      <div>
        <p className="text-xs font-medium text-zinc-300">{t("settings.meterFolder")}</p>
        <p className="mt-0.5 text-xs text-zinc-500">{t("settings.meterFolderDesc")}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded bg-surface-800/80 px-2 py-1 font-mono text-xs text-zinc-400">
            {resolvedDir ?? t("settings.notSet")}
          </span>
          <button
            onClick={() => window.meter.openDataFolder()}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded bg-surface-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-surface-600 hover:text-white"
          >
            <FolderOpen className="size-3" />
            {t("settings.openFolder")}
          </button>
          <button
            onClick={handleChooseFolder}
            className="shrink-0 cursor-pointer rounded px-2 py-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            {t("settings.change")}
          </button>
        </div>
      </div>

      <div className="border-t border-surface-600 pt-3">
        <div className="flex items-center justify-between gap-2">
          <span>
            <span className="text-xs font-medium text-zinc-300">{t("settings.position")}</span>
            <p className="mt-0.5 text-xs text-zinc-500">{t("settings.positionDesc")}</p>
          </span>
          <button
            type="button"
            onClick={() => window.meter.resetWindowPosition()}
            className="shrink-0 cursor-pointer rounded bg-surface-600/60 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-surface-600"
          >
            {t("common.reset")}
          </button>
        </div>
      </div>

      <div className="border-t border-surface-600 pt-3">
        <AlwaysOnTopRow settings={settings} onSettingsChange={onSettingsChange} />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <PercentSlider
          id="opacity"
          label={t("settings.opacity")}
          labelClassName="font-medium text-zinc-300"
          min={50}
          max={100}
          pct={opacityPct}
          onPctChange={(pct) => onSettingsChange({ opacity: pct / 100 })}
        />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <FontSizeRow settings={settings} onSettingsChange={onSettingsChange} />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <LanguageRow settings={settings} onSettingsChange={onSettingsChange} />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <StartupRow settings={settings} onSettingsChange={onSettingsChange} />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <RunFilterRow settings={settings} onSettingsChange={onSettingsChange} />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <MaxRunsRow settings={settings} onSettingsChange={onSettingsChange} />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <NotificationsRow settings={settings} onSettingsChange={onSettingsChange} />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <BlueChestTrackerRow settings={settings} onSettingsChange={onSettingsChange} />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <LeaderboardRow />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <UsageStatsRow settings={settings} onSettingsChange={onSettingsChange} onOpenDiagnostics={() => setDiagnosticsOpen(true)} />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <RunHistoryRow />
      </div>

      <div className="border-t border-surface-600 pt-3">
        <FeedbackRow />
      </div>

      <div className="mt-auto border-t border-surface-600 pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-zinc-500">
            tbh-meter <span className="tabular-nums text-zinc-400">v{version ?? "…"}</span>
            {" · "}
            <button
              onClick={() => window.meter.openExternal("https://github.com/mad-labs-org")}
              className="cursor-pointer underline-offset-2 transition-colors hover:text-brand-300 hover:underline"
            >
              {t("settings.createdBy")}
            </button>
          </p>
          {/* Manual check — only on installs that can self-update, and only when no
              check/download is already in flight (UpdateRow carries those states). */}
          {updaterSupported &&
            (update.state === "idle" ||
              update.state === "up-to-date" ||
              update.state === "error") && (
              <button
                onClick={() => window.meter.checkForUpdates()}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded bg-surface-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-surface-600 hover:text-white"
              >
                <RefreshCw className="size-3" />
                {t("settings.checkUpdates")}
              </button>
            )}
        </div>
        <UpdateRow status={update} />
      </div>
    </div>
  );
}

/** Label + % readout + range input — shared by the opacity and font-size sliders. */
function PercentSlider({
  id,
  label,
  labelClassName,
  min,
  max,
  step,
  pct,
  onPctChange,
  className,
}: {
  id: string;
  label: string;
  /** Label tone; defaults to the muted sub-row style (the opacity row overrides). */
  labelClassName?: string;
  min: number;
  max: number;
  step?: number;
  pct: number;
  onPctChange: (pct: number) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className={cn("text-xs", labelClassName ?? "text-zinc-400")}>
          {label}
        </label>
        <span className="text-xs tabular-nums text-zinc-500">{pct}%</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={pct}
        onChange={(e) => onPctChange(Number(e.target.value))}
        className="mt-1.5 h-3 w-full cursor-pointer accent-brand-500"
      />
    </div>
  );
}

/**
 * Font-size section (#232): one slider per window, persisted as liveFontScale /
 * listFontScale and applied main-side as a webContents zoom. The live overlay's
 * bottom-edge drag writes the SAME liveFontScale, so the slider tracks it live.
 */
function FontSizeRow({
  settings,
  onSettingsChange,
}: {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
}) {
  const t = useT();
  const minPct = Math.round(FONT_SCALE_MIN * 100);
  const maxPct = Math.round(FONT_SCALE_MAX * 100);
  const toPct = (scale: number): number => Math.round(clampFontScale(scale) * 100);

  return (
    <div>
      <p className="text-xs font-medium text-zinc-300">{t("settings.fontSize")}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{t("settings.fontSizeDesc")}</p>
      <PercentSlider
        id="font-live"
        label={t("settings.fontLive")}
        min={minPct}
        max={maxPct}
        step={5}
        pct={toPct(settings.liveFontScale)}
        onPctChange={(pct) => onSettingsChange({ liveFontScale: clampFontScale(pct / 100) })}
        className="mt-2"
      />
      <PercentSlider
        id="font-list"
        label={t("settings.fontRuns")}
        min={minPct}
        max={maxPct}
        step={5}
        pct={toPct(settings.listFontScale)}
        onPctChange={(pct) => onSettingsChange({ listFontScale: clampFontScale(pct / 100) })}
        className="mt-2"
      />
    </div>
  );
}

/** Language section (#232): Auto (system) + the 16 game locales, shown as endonyms. */
function LanguageRow({
  settings,
  onSettingsChange,
}: {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-2">
      <span>
        <span className="text-xs font-medium text-zinc-300">{t("settings.language")}</span>
        <p className="mt-0.5 text-xs text-zinc-500">{t("settings.languageDesc")}</p>
      </span>
      <select
        value={settings.language}
        onChange={(e) => onSettingsChange({ language: e.target.value })}
        className="shrink-0 cursor-pointer rounded bg-surface-700 px-2 py-1 text-xs text-zinc-200 outline-none transition-colors hover:bg-surface-600 focus:ring-1 focus:ring-brand-600"
      >
        <option value={AUTO_LOCALE}>{t("settings.languageAuto")}</option>
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Start-with-Windows section (#232): registers the packaged app as a login item. */
function StartupRow({
  settings,
  onSettingsChange,
}: {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
}) {
  const t = useT();
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={settings.launchOnStartup}
        onChange={(e) => onSettingsChange({ launchOnStartup: e.target.checked })}
        className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-brand-500"
      />
      <span>
        <span className="text-xs font-medium text-zinc-300">{t("settings.startup")}</span>
        <span className="block text-[11px] text-zinc-500">{t("settings.startupDesc")}</span>
      </span>
    </label>
  );
}

/** Always-on-top section: surfaces the alwaysOnTop setting (the overlay's pin button is the
 *  other entry point). Off lets other windows cover the meter; its taskbar button brings it back. */
function AlwaysOnTopRow({
  settings,
  onSettingsChange,
}: {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
}) {
  const t = useT();
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={settings.alwaysOnTop}
        onChange={(e) => onSettingsChange({ alwaysOnTop: e.target.checked })}
        className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-brand-500"
      />
      <span>
        <span className="text-xs font-medium text-zinc-300">{t("settings.alwaysOnTop")}</span>
        <span className="block text-[11px] text-zinc-500">{t("settings.alwaysOnTopDesc")}</span>
      </span>
    </label>
  );
}

/**
 * Run-filter section (PR6) — the LOCAL display filter for the runs list (layer 3 of the 3-layer
 * status model; never touches the leaderboard). Two prefs, both persisted to settings.json:
 *   - hideNonCounted (default on): hide skipped / degraded runs. `counted` and `partial` (a real
 *     clear joined mid-way, under-counted but badged) stay visible — hiding partials made the list
 *     look empty after the slow first-launch attach. Mirrors the runs-list "show ignored" toggle —
 *     same setting, two entry points.
 *   - minDurationSec (default off): hide runs shorter than N seconds. The minimum the user can pick
 *     is the SYSTEM floor (COUNT_FLOOR_SEC) — runs under it never count anyway — so the input is
 *     clamped to it before persisting; x-10 boss clears are always exempt. The floor is a converter
 *     constant, NOT this setting (don't conflate the system rule with the pref).
 */
function RunFilterRow({
  settings,
  onSettingsChange,
}: {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
}) {
  const t = useT();
  const filterOn = settings.minDurationSec != null;
  // Local draft of the seconds input so the user can edit freely; we clamp + persist on commit
  // (change/blur). Seeded from the persisted value, falling back to the floor when the filter is off.
  const [draft, setDraft] = useState<string>(String(settings.minDurationSec ?? COUNT_FLOOR_SEC));

  // Re-seed the draft if the persisted value changes elsewhere (another window, a reset).
  useEffect(() => {
    if (settings.minDurationSec != null) setDraft(String(settings.minDurationSec));
  }, [settings.minDurationSec]);

  const commitDuration = (raw: string): void => {
    const n = Number(raw);
    const clamped = clampMinDuration(Number.isFinite(n) ? n : null);
    // An empty / unparseable / sub-floor entry snaps to the floor (the filter is ON here — the
    // checkbox controls on/off). Reflect the committed value back into the draft.
    const next = clamped ?? COUNT_FLOOR_SEC;
    setDraft(String(next));
    if (next !== settings.minDurationSec) onSettingsChange({ minDurationSec: next });
  };

  const toggleFilter = (on: boolean): void => {
    if (on) {
      const next = clampMinDuration(Number(draft)) ?? COUNT_FLOOR_SEC;
      setDraft(String(next));
      onSettingsChange({ minDurationSec: next });
    } else {
      onSettingsChange({ minDurationSec: null });
    }
  };

  return (
    <div>
      <p className="text-xs font-medium text-zinc-300">{t("settings.runFilter")}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{t("settings.runFilterDesc")}</p>

      <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={settings.hideNonCounted}
          onChange={(e) => onSettingsChange({ hideNonCounted: e.target.checked })}
          className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-brand-500"
        />
        <span>
          {t("settings.hideIgnored")}
          <span className="block text-[11px] text-zinc-500">{t("settings.hideIgnoredDesc")}</span>
        </span>
      </label>

      <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={filterOn}
          onChange={(e) => toggleFilter(e.target.checked)}
          className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-brand-500"
        />
        <span className="flex-1">
          <span className="flex items-center gap-1.5">
            {t("settings.hideShorter")}
            <input
              type="number"
              min={COUNT_FLOOR_SEC}
              step={5}
              value={draft}
              disabled={!filterOn}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={(e) => filterOn && commitDuration(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filterOn) commitDuration((e.target as HTMLInputElement).value);
              }}
              className="w-14 rounded bg-surface-800/80 px-1.5 py-0.5 text-center tabular-nums text-zinc-200 outline-none transition-colors focus:ring-1 focus:ring-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {t("settings.seconds")}
          </span>
          <span className="block text-[11px] text-zinc-500">
            {t("settings.minDurationDesc", { floor: COUNT_FLOOR_SEC })}
          </span>
        </span>
      </label>
    </div>
  );
}

/**
 * Max-runs section (Feature 2): an optional cap on how many runs are kept locally. When the stored
 * count exceeds the cap, the main process deletes the OLDEST non-favorited runs down to it (the
 * deletion + favorite-exemption live in main/runs-store.pruneToMaxRuns). Off by default (null =
 * unlimited). Mirrors RunFilterRow's checkbox + number-input pattern: the checkbox is on/off, the
 * number is the cap, clamped to MIN_MAX_RUNS before persisting (clampMaxRuns).
 */
function MaxRunsRow({
  settings,
  onSettingsChange,
}: {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
}) {
  const t = useT();
  const capOn = settings.maxRuns != null;
  const [draft, setDraft] = useState<string>(String(settings.maxRuns ?? 500));

  // Re-seed the draft if the persisted value changes elsewhere (another window, a reset).
  useEffect(() => {
    if (settings.maxRuns != null) setDraft(String(settings.maxRuns));
  }, [settings.maxRuns]);

  const commitCap = (raw: string): void => {
    const n = Number(raw);
    const clamped = clampMaxRuns(Number.isFinite(n) ? n : null);
    const next = clamped ?? MIN_MAX_RUNS; // the checkbox controls on/off; here the cap is ON
    setDraft(String(next));
    if (next !== settings.maxRuns) onSettingsChange({ maxRuns: next });
  };

  const toggleCap = (on: boolean): void => {
    if (on) {
      const next = clampMaxRuns(Number(draft)) ?? 500;
      setDraft(String(next));
      onSettingsChange({ maxRuns: next });
    } else {
      onSettingsChange({ maxRuns: null });
    }
  };

  return (
    <div>
      <p className="text-xs font-medium text-zinc-300">{t("settings.maxRuns")}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{t("settings.maxRunsDesc")}</p>
      <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={capOn}
          onChange={(e) => toggleCap(e.target.checked)}
          className="size-3.5 shrink-0 cursor-pointer accent-brand-500"
        />
        <span className="flex items-center gap-1.5">
          {t("settings.maxRuns")}
          <input
            type="number"
            min={MIN_MAX_RUNS}
            step={50}
            value={draft}
            disabled={!capOn}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => capOn && commitCap(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && capOn) commitCap((e.target as HTMLInputElement).value);
            }}
            className="w-20 rounded bg-surface-800/80 px-1.5 py-0.5 text-center tabular-nums text-zinc-200 outline-none transition-colors focus:ring-1 focus:ring-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {t("settings.maxRunsUnit")}
        </span>
      </label>
    </div>
  );
}

/**
 * Notifications section: per-chest-type OS drop alerts. Each chest type the reader counts
 * gets its own switch (common defaults off — it drops near-constantly; stage-boss/blue and
 * act-boss default on). Independent of the blue-chest cooldown tracker. The chest sprite
 * sits next to each label, derived from a representative box key per tier (910x/920x/930x).
 */
function NotificationsRow({
  settings,
  onSettingsChange,
}: {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
}) {
  const t = useT();
  const notify = settings.chestDropNotify;

  // type -> the setting key, its label/description i18n keys, and a representative box key
  // for the sprite (all chests of a tier share one icon, per chests-min.json).
  const types: {
    key: keyof typeof notify;
    boxKey: number;
    label: string;
    desc: string;
  }[] = [
    {
      key: "stageBoss",
      boxKey: 920001,
      label: t("notifications.stageBoss"),
      desc: t("notifications.stageBossDesc"),
    },
    {
      key: "actBoss",
      boxKey: 930101,
      label: t("notifications.actBoss"),
      desc: t("notifications.actBossDesc"),
    },
    {
      key: "common",
      boxKey: 910011,
      label: t("notifications.common"),
      desc: t("notifications.commonDesc"),
    },
  ];

  const set = (key: keyof typeof notify, value: boolean): void => {
    onSettingsChange({ chestDropNotify: { ...notify, [key]: value } });
  };

  return (
    <div>
      <p className="text-xs font-medium text-zinc-300">{t("notifications.title")}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{t("notifications.desc")}</p>
      {types.map((ty) => {
        const src = chestSprite(ty.boxKey);
        return (
          <label
            key={ty.key}
            className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-zinc-400"
          >
            <input
              type="checkbox"
              checked={notify[ty.key]}
              onChange={(e) => set(ty.key, e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-brand-500"
            />
            {src && (
              <img
                src={src}
                alt=""
                className="mt-0.5 size-4 shrink-0 object-contain [image-rendering:pixelated]"
              />
            )}
            <span>
              {ty.label}
              <span className="block text-[11px] text-zinc-500">{ty.desc}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Blue-chest tracker config (#3 follow-up): the cooldown length, the track-outside-route toggle,
 * and Clear all. The live cards, the master on/off toggle and the chest-level "route" pin chips
 * live in the Tracker tab; this is the rest of the config. Reuses the cooldowns.* i18n.
 */
function BlueChestTrackerRow({
  settings,
  onSettingsChange,
}: {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
}) {
  const t = useT();
  const min = clampCooldownMin(settings.chestCooldownMin);
  const step = (delta: number): void => onSettingsChange({ chestCooldownMin: clampCooldownMin(min + delta) });

  // "Clear all" with a 2-click inline confirm (the app avoids native dialogs for minor actions).
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (armTimer.current) clearTimeout(armTimer.current); }, []);
  const clickClear = (): void => {
    if (armed) {
      if (armTimer.current) clearTimeout(armTimer.current);
      setArmed(false);
      window.meter.clearCooldowns();
    } else {
      setArmed(true);
      armTimer.current = setTimeout(() => setArmed(false), 3000);
    }
  };

  return (
    <div>
      <p className="text-xs font-medium text-zinc-300">{t("cooldowns.title")}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{t("cooldowns.desc")}</p>

      {/* Cooldown length stepper — kept next to its label, not pushed to the edge. */}
      <div className="mt-2 flex items-center gap-3">
        <span className="text-xs text-zinc-400">{t("cooldowns.timerLabel")}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("cooldowns.timerLabel")}
            disabled={min <= COOLDOWN_MIN_MINUTES}
            onClick={() => step(-1)}
            className="grid size-5 cursor-pointer place-items-center rounded bg-surface-700 text-zinc-300 hover:bg-surface-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Minus className="size-3" />
          </button>
          <span className="w-8 text-center font-mono text-xs tabular-nums text-zinc-200">{min}</span>
          <button
            type="button"
            aria-label={t("cooldowns.timerLabel")}
            disabled={min >= COOLDOWN_MAX_MINUTES}
            onClick={() => step(1)}
            className="grid size-5 cursor-pointer place-items-center rounded bg-surface-700 text-zinc-300 hover:bg-surface-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="size-3" />
          </button>
        </div>
      </div>

      {/* Track outside route. */}
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={settings.trackOutsideRoute}
          onChange={(e) => onSettingsChange({ trackOutsideRoute: e.target.checked })}
          className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-brand-500"
        />
        <span>
          {t("cooldowns.trackOutside")}
          <span className="block text-[11px] text-zinc-500">{t("cooldowns.trackOutsideDesc")}</span>
        </span>
      </label>

      {/* Clear all tracked drops + history (keeps the route). */}
      <button
        type="button"
        onClick={clickClear}
        className={cn(
          "mt-3 flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
          armed
            ? "bg-rose-600/90 text-white hover:bg-rose-600"
            : "bg-surface-700 text-zinc-300 hover:bg-surface-600 hover:text-rose-300",
        )}
      >
        <Trash2 className="size-3" />
        {armed ? t("cooldowns.clearAllConfirm") : t("cooldowns.clearAll")}
      </button>
    </div>
  );
}

/**
 * Discord account section for leaderboard sharing.
 *   signed out -> pitch pointing at the header's sign-in button (sign in to upload)
 *   signed in  -> "Signed in as <name>" + sign out
 */
/** Privacy toggle: opt out of the anonymous usage count (Google Analytics on the
 *  overlay). Always visible (not auth-gated) so anyone can turn it off. */
function UsageStatsRow({
  settings,
  onSettingsChange,
  onOpenDiagnostics,
}: {
  settings: AppSettings;
  onSettingsChange: (partial: Partial<AppSettings>) => void;
  onOpenDiagnostics: () => void;
}) {
  const t = useT();
  return (
    <div>
      <p className="text-xs font-medium text-zinc-300">{t("settings.usageStats")}</p>
      <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={settings.analyticsEnabled}
          onChange={(e) => onSettingsChange({ analyticsEnabled: e.target.checked })}
          className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-brand-500"
        />
        <span>
          {t("settings.usageStatsLabel")}
          <span className="block text-[11px] text-zinc-500">{t("settings.usageStatsDesc")}</span>
        </span>
      </label>
      <button
        onClick={onOpenDiagnostics}
        className="mt-2 flex cursor-pointer items-center gap-1.5 rounded bg-surface-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-surface-600 hover:text-white"
      >
        <FileText className="size-3" />
        {t("settings.diagnosticsLog")}
      </button>
      <p className="mt-1.5 text-[11px] text-zinc-500">
        {t("settings.diagnosticsLogDesc")}
      </p>
    </div>
  );
}

function LeaderboardRow() {
  const t = useT();
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  useEffect(() => {
    window.meter.authGetStatus().then(setAuth);
    return window.meter.onAuthChanged(setAuth);
  }, []);

  return (
    <div>
      <p className="text-xs font-medium text-zinc-300">{t("settings.leaderboard")}</p>
      {auth?.signedIn ? (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-xs text-zinc-500">
            {t("settings.signedInAs")}{" "}
            <span className="text-zinc-300">{auth.displayName ?? "Discord"}</span>.{" "}
            {t("settings.uploadAuto")}
          </p>
          <button
            onClick={() => window.meter.authSignOut()}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <LogOut className="size-3" />
            {t("common.signOut")}
          </button>
        </div>
      ) : (
        <p className="mt-0.5 text-xs text-zinc-500">{t("settings.signInPitch")}</p>
      )}
    </div>
  );
}

/** Local-only destructive action: wipe runs.jsonl + the logs/ mirror behind a
 *  confirm modal. Runs already shared keep living on the web leaderboard. */
function RunHistoryRow() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClear = async () => {
    setClearing(true);
    setError(null);
    const ok = await window.meter.clearRuns().catch(() => false);
    setClearing(false);
    setConfirming(!ok);
    if (!ok) setError(t("settings.clearError"));
  };

  return (
    <div>
      <p className="text-xs font-medium text-zinc-300">{t("settings.runHistory")}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{t("settings.runHistoryDesc")}</p>
      <button
        onClick={() => setConfirming(true)}
        className="mt-1.5 flex cursor-pointer items-center gap-1.5 rounded bg-red-900/40 px-2 py-1 text-xs font-medium text-red-300 transition-colors hover:bg-red-900/70 hover:text-red-200"
      >
        <Trash2 className="size-3" />
        {t("settings.clearHistory")}
      </button>

      {confirming && (
        <Modal title={t("settings.clearConfirmTitle")} onClose={() => setConfirming(false)}>
          <p className="mt-2 text-xs text-zinc-400">{t("settings.clearConfirmBody")}</p>
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setConfirming(false)}
              className="cursor-pointer rounded px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={handleClear}
              disabled={clearing}
              className="flex cursor-pointer items-center gap-1.5 rounded bg-red-700 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-default disabled:opacity-60"
            >
              {clearing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              {clearing ? t("settings.clearing") : t("settings.deleteAll")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Link to the community Discord for bug reports and feature requests. */
function FeedbackRow() {
  const t = useT();
  return (
    <div>
      <p className="text-xs font-medium text-zinc-300">{t("settings.community")}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{t("settings.communityDesc")}</p>
      <button
        onClick={() => window.meter.openExternal("https://discord.gg/eYqUkxu3")}
        className="mt-1.5 flex cursor-pointer items-center gap-1.5 rounded bg-discord px-2 py-1 text-xs font-semibold text-white transition-colors hover:bg-discord-dark"
      >
        <DiscordIcon className="size-3" />
        {t("settings.discordBtn")}
      </button>
    </div>
  );
}

/** One-line auto-update status. Renders nothing when idle (dev / macOS — the updater
 *  never runs there). */
function UpdateRow({ status }: { status: UpdateStatus }) {
  const t = useT();
  switch (status.state) {
    case "checking":
      return (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
          <RefreshCw className="size-3 animate-spin" /> {t("settings.updateChecking")}
        </p>
      );
    case "available":
      return (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-400">
          <Download className="size-3" />{" "}
          {t("header.updateDownloading", { version: status.version })}
        </p>
      );
    case "downloading":
      return (
        <div className="mt-2">
          <p className="flex items-center gap-1.5 text-xs text-zinc-400">
            <Download className="size-3" />{" "}
            {t("header.updateDownloading", { version: status.version })} {status.percent}%
          </p>
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-surface-700">
            <div
              className="h-full bg-brand-500 transition-all"
              style={{ width: `${status.percent}%` }}
            />
          </div>
        </div>
      );
    case "downloaded":
      return (
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-brand-300">
            {t("header.updateReady", { version: status.version })}
          </span>
          <button
            onClick={() => window.meter.quitAndInstall()}
            className="shrink-0 cursor-pointer rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-500"
          >
            {t("header.restartToUpdate")}
          </button>
        </div>
      );
    case "up-to-date":
      return (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-600">
          <CheckCircle2 className="size-3" /> {t("settings.upToDate")}
        </p>
      );
    case "error":
      return (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-zinc-600" title={status.message}>
          <AlertCircle className="size-3" /> {t("settings.updateFailed")}
        </p>
      );
    default:
      return null;
  }
}
