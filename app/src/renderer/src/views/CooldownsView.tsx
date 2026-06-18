import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, Power } from "lucide-react";
import type { ChestCooldown } from "../../../shared/cooldown-types.js";
import { remainingMs, isReady } from "../../../shared/cooldown-types.js";
import type { AppSettings } from "../../../shared/ipc-types.js";
import { clampCooldownMin } from "../../../shared/ipc-types.js";
import { chestSprite, chestLevel, boxBestStage, bossBoxRate, stageDifficulty, stageCode, blueBoxes } from "~/lib/game-data";
import { modeTextClass, modeLabel, ago } from "~/lib/format";
import { useCooldowns, useNow, formatRemaining, buildTrackerEntries } from "~/lib/cooldown";
import { CooldownCard } from "~/components/CooldownCard";
import { DropRatePct } from "~/components/DropRatePct";
import { useT } from "~/lib/i18n";
import { cn } from "~/lib/utils";

/** A read-only history row: when it dropped + the chest + origin stage·mode + current status. */
function HistoryRow({ cd, now, cooldownMs }: { cd: ChestCooldown; now: number; cooldownMs: number }) {
  const t = useT();
  const src = chestSprite(cd.boxKey);
  const level = chestLevel(cd.boxKey);
  const stageKey = cd.lastStageKey ?? boxBestStage(cd.boxKey);
  const mode = (stageKey != null ? stageDifficulty(stageKey) : null) ?? cd.mode ?? null;
  const code = stageKey != null ? stageCode(stageKey) : null;
  const label = code ? t("cooldowns.stageLabel", { code }) : t("cooldowns.chestLabel", { level: level ?? "?" });
  const rate = stageKey != null ? bossBoxRate(stageKey) : null; // origin stage's base rate
  const ready = isReady(cd, now, cooldownMs);
  return (
    <div className="flex items-center gap-2 border-b border-surface-700/60 px-1 py-1.5 text-xs last:border-0">
      <span className="w-16 shrink-0 text-[10px] tabular-nums text-zinc-500">{ago(cd.dropAt, t)}</span>
      <span className="flex w-9 shrink-0 items-center justify-center gap-0.5">
        {src ? <img src={src} alt="" className="size-5 object-contain [image-rendering:pixelated]" /> : null}
        {level != null && <span className="font-mono text-[9px] text-sky-300">Lv{level}</span>}
      </span>
      <span className="truncate font-semibold text-zinc-200">{label}</span>
      {mode && stageKey != null && (
        <button
          type="button"
          title={t("cooldowns.openStage")}
          onClick={() => window.meter.openStagePage(stageKey)}
          className={cn(
            "shrink-0 cursor-pointer text-[10px] font-bold uppercase hover:underline",
            modeTextClass(mode),
          )}
        >
          {modeLabel(mode, t)}
        </button>
      )}
      <DropRatePct rate={rate} className="shrink-0" />
      <span
        className={cn(
          "ml-auto shrink-0 font-mono text-[10px] tabular-nums",
          ready ? "text-emerald-400" : "text-sky-300/80",
        )}
      >
        {ready ? t("cooldowns.ready") : formatRemaining(remainingMs(cd, now, cooldownMs))}
      </span>
    </div>
  );
}

/** Runs-window "Tracker" tab: the master on/off toggle, the route pin chips, then the tracked
 *  chests as full cards (active cooldowns + pinned route placeholders) and the append-only drop
 *  HISTORY below. The timer length / "track outside route" / "clear all" config lives in the
 *  Settings tab (Blue-chest tracker). */
export function CooldownsView() {
  const t = useT();
  const { active, log } = useCooldowns();
  const now = useNow(1000);
  const [cfg, setCfg] = useState({ enabled: true, cooldownMin: 13, route: [] as number[] });
  const [historyOpen, setHistoryOpen] = useState(true);

  useEffect(() => {
    const apply = (s: AppSettings): void =>
      setCfg({ enabled: s.cooldownTrackerEnabled, cooldownMin: clampCooldownMin(s.chestCooldownMin), route: s.chestRoute });
    void window.meter.getSettings().then(apply);
    return window.meter.onSettingsChanged(apply);
  }, []);

  const toggleEnabled = (): void => {
    const next = !cfg.enabled;
    setCfg((c) => ({ ...c, enabled: next })); // optimistic; main echoes via onSettingsChanged
    void window.meter.setSettings({ cooldownTrackerEnabled: next });
  };
  // Pin/unpin a chest level on the route — the chip strip at the top + the card's placeholder X.
  const toggleBox = (boxKey: number): void => {
    const route = cfg.route.includes(boxKey) ? cfg.route.filter((k) => k !== boxKey) : [...cfg.route, boxKey];
    setCfg((c) => ({ ...c, route }));
    void window.meter.setSettings({ chestRoute: route });
  };

  const cooldownMs = cfg.cooldownMin * 60 * 1000;
  const entries = buildTrackerEntries(active, cfg.route).sort(
    (a, b) =>
      (a.cd ? remainingMs(a.cd, now, cooldownMs) : 0) - (b.cd ? remainingMs(b.cd, now, cooldownMs) : 0),
  );
  // History: the 10 most recent drops, newest-first.
  const HISTORY_LIMIT = 10;
  const recent = [...log].sort((a, b) => b.dropAt - a.dropAt).slice(0, HISTORY_LIMIT);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      {/* Master toggle; the route chips render below. Timer + track-outside + clear-all live in Settings → Blue-chest tracker. */}
      <div className="flex items-center justify-between gap-3 border-b border-surface-700 px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-semibold text-zinc-200">{t("cooldowns.title")}</span>
          <span className="truncate text-[10px] text-zinc-500">{t("cooldowns.desc")}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={cfg.enabled}
          title={cfg.enabled ? t("cooldowns.toggleOn") : t("cooldowns.toggleOff")}
          onClick={toggleEnabled}
          className={cn(
            "relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
            cfg.enabled ? "bg-brand-600" : "bg-surface-600",
          )}
        >
          <span className={cn("absolute top-0.5 size-4 rounded-full bg-white transition-all", cfg.enabled ? "left-4" : "left-0.5")} />
        </button>
      </div>

      {!cfg.enabled ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-zinc-500">
          <Power className="size-8 text-surface-500" />
          <p className="text-sm font-medium text-zinc-400">{t("cooldowns.offTitle")}</p>
          <p className="max-w-xs text-xs text-zinc-600">{t("cooldowns.offDesc")}</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-3">
          {/* Route — the FIRST element: pick which chest levels to always track. */}
          <div className="flex flex-col gap-1.5">
            <span className="px-0.5 text-[11px] text-zinc-400">{t("cooldowns.routeLabel")}</span>
            <div className="flex flex-wrap gap-1">
              {blueBoxes().map(({ boxKey, level }) => {
                const on = cfg.route.includes(boxKey);
                const src = chestSprite(boxKey);
                return (
                  <button
                    key={boxKey}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleBox(boxKey)}
                    className={cn(
                      "flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold transition-colors",
                      on
                        ? "border-brand-500/70 bg-brand-600/20 text-sky-200"
                        : "border-surface-600 bg-surface-800 text-zinc-500 hover:border-surface-500 hover:text-zinc-300",
                    )}
                  >
                    {src && <img src={src} alt="" className="size-3.5 object-contain [image-rendering:pixelated]" />}
                    Lv{level ?? "?"}
                  </button>
                );
              })}
            </div>
          </div>

          {entries.length > 0 ? (
            <section className="flex flex-col gap-1.5">
              {entries.map((e) => (
                <CooldownCard
                  key={e.boxKey}
                  boxKey={e.boxKey}
                  cd={e.cd}
                  now={now}
                  cooldownMs={cooldownMs}
                  variant="full"
                  onDismiss={(k) => window.meter.dismissCooldown(k)}
                  onUnpin={toggleBox}
                />
              ))}
            </section>
          ) : log.length === 0 ? (
            <p className="px-1 py-2 text-xs text-zinc-600">{t("cooldowns.emptyTitle")}</p>
          ) : null}

          {log.length > 0 && (
            <section className="flex flex-col">
              <button
                type="button"
                onClick={() => setHistoryOpen((o) => !o)}
                aria-expanded={historyOpen}
                title={historyOpen ? t("cooldowns.hideHistory") : t("cooldowns.showHistory")}
                className="flex items-center gap-1 px-0.5 pb-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500 hover:text-zinc-300"
              >
                {historyOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {t("cooldowns.history")}
              </button>
              {historyOpen && (
                <div className="rounded-lg border border-surface-700 bg-surface-800/50 px-2">
                  {recent.map((cd, i) => (
                    <HistoryRow key={`${cd.boxKey}-${cd.dropAt}-${i}`} cd={cd} now={now} cooldownMs={cooldownMs} />
                  ))}
                  {log.length > recent.length && (
                    <p className="border-t border-surface-700/60 px-1 py-1.5 text-center text-[10px] text-zinc-600">
                      {t("cooldowns.showingRecent", { shown: recent.length, total: log.length })}
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
