import { Package, X } from "lucide-react";
import type { ChestCooldown } from "../../../shared/cooldown-types.js";
import { remainingMs, remainingFraction } from "../../../shared/cooldown-types.js";
import { chestSprite, chestLevel, boxBestStage, stageCode, stageDifficulty } from "~/lib/game-data";
import { modeAbbrev, modeTextClass } from "~/lib/format";
import { formatRemaining, buildTrackerEntries, useCooldowns, useCooldownMs, useNow, useRoute, useTrackerEnabled } from "~/lib/cooldown";
import { BlueBoxSpots } from "./BlueBoxSpots";
import { useT } from "~/lib/i18n";
import { cn } from "~/lib/utils";

interface CooldownCardProps {
  /** The chest level's box (920xxx) — the card's identity. */
  boxKey: number;
  /** The active cooldown for this box, or null when the box is only PINNED to the route and
   *  hasn't dropped yet (a placeholder shown as "available now"). */
  cd: ChestCooldown | null;
  /** Wall clock (ms) from a single useNow() in the parent, so every card ticks together. */
  now: number;
  /** Cooldown length in ms (the user setting), so the countdown/fill match the configured timer. */
  cooldownMs: number;
  variant?: "full" | "compact";
  /** The "X" on a real cooldown: clear this active line (history kept; a re-drop re-creates it,
   *  and a pinned box returns as a placeholder). */
  onDismiss?: (boxKey: number) => void;
  /** The "X" on a placeholder: unpin this box from the route (it only shows because it's pinned). */
  onUnpin?: (boxKey: number) => void;
}

/** Chest sprite + level stacked — the left column that spans the full card's two rows. */
function ChestBadge({ src }: { src: string | null }) {
  return src ? (
    <img src={src} alt="" className="size-8 object-contain [image-rendering:pixelated]" />
  ) : (
    <Package className="size-8 text-zinc-400" />
  );
}

/** A blue-chest cooldown card, keyed by chest level (box). The background is a full-bleed fill =
 *  REMAINING time, draining to empty as the cooldown runs (z-0); content sits on top (z-10).
 *  Ready/available = drained + an emerald highlight. The hover "X" dismisses a cooldown or unpins
 *  a placeholder. The compact (overlay) variant runs one font notch above the full card (#232). */
export function CooldownCard({ boxKey, cd, now, cooldownMs, variant = "full", onDismiss, onUnpin }: CooldownCardProps) {
  const t = useT();
  const available = cd == null; // pinned-but-never-dropped placeholder
  const remaining = cd ? remainingMs(cd, now, cooldownMs) : 0;
  const ready = available || remaining <= 0;
  const frac = cd ? remainingFraction(cd, now, cooldownMs) : 0; // 1 at drop -> 0 at ready
  const sprite = chestSprite(boxKey);
  const level = chestLevel(boxKey);
  const label = t("cooldowns.chestLabel", { level: level ?? "?" });
  // Where "open stage" points: the box's best farm spot, or the stage the last drop came from.
  const openStage = cd?.lastStageKey ?? boxBestStage(boxKey);
  // The chest's CURRENT stage (where this cooldown dropped; the best spot for a pinned
  // placeholder) — shown inline as "<code> <MODE>" so each line says WHICH stage it's for
  // at a glance, in plain weight without the heavier "Stage" label.
  const stageLabel = openStage != null ? stageCode(openStage) : null;
  const stageMode = openStage != null ? stageDifficulty(openStage) : null;

  // The hover "X": dismiss a real cooldown, or unpin a placeholder. Absent when neither applies.
  const remove = available ? onUnpin : onDismiss;
  const removeTitle = available ? t("cooldowns.unpin") : t("cooldowns.remove");

  // Full-bleed draining fill, behind everything. Linear 1s transition matches the 1s tick.
  const fill = (
    <span
      aria-hidden
      className="absolute inset-y-0 left-0 z-0 bg-sky-500/15 transition-[width] duration-1000 ease-linear"
      style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }}
    />
  );

  const dismiss = remove && (
    <button
      type="button"
      title={removeTitle}
      onClick={() => remove(boxKey)}
      className="shrink-0 cursor-pointer rounded p-0.5 text-zinc-500 transition-colors hover:text-rose-300"
    >
      <X className="size-3.5" />
    </button>
  );

  const openTitle = t("cooldowns.openStage");

  if (variant === "compact") {
    const status = available ? (
      <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-wider text-emerald-300/90">
        {t("cooldowns.available")}
      </span>
    ) : ready ? (
      <span className="shrink-0 font-mono text-[11px] font-bold uppercase tracking-wider text-emerald-300">
        {t("cooldowns.readyCheck")}
      </span>
    ) : (
      <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-sky-200">
        {formatRemaining(remaining)}
      </span>
    );
    return (
      <div
        className={cn(
          "group relative overflow-hidden rounded ring-1",
          ready ? "bg-emerald-500/5 ring-emerald-500/40" : "bg-surface-800/80 ring-surface-600/60",
        )}
      >
        {fill}
        {/* Single line: chest + level inline, then the chest label + spots + status/X. */}
        <div className="relative z-10 flex items-center gap-1 px-1.5 py-0.5 text-[11px] leading-none">
          {sprite ? (
            <img src={sprite} alt="" className="size-3.5 shrink-0 object-contain [image-rendering:pixelated]" />
          ) : (
            <Package className="size-3.5 shrink-0 text-zinc-400" />
          )}
          <button
            type="button"
            title={openTitle}
            onClick={() => openStage != null && window.meter.openStagePage(openStage)}
            className="shrink-0 cursor-pointer font-semibold text-white hover:underline"
          >
            {label}
          </button>
          {/* Current stage of this cooldown — plain "<code> <MODE>", so the line names the
              stage without the heavier "Stage" label. */}
          {stageLabel && (
            <span className="shrink-0 font-mono text-white">
              {stageLabel}
              {stageMode && (
                <span className={cn("ml-1 uppercase", modeTextClass(stageMode))}>
                  {modeAbbrev(stageMode)}
                </span>
              )}
            </span>
          )}
          {/* RIGHT (ml-auto): where you CAN drop (spots) + timer, grouped on the right.
              Spots truncate first when the row is tight; the timer stays pinned. */}
          <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-2">
            <span className="shrink-0 font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
              {t("cooldowns.spots")}
            </span>
            <span className="min-w-0 shrink truncate font-mono text-[10px]">
              <BlueBoxSpots boxKey={boxKey} />
            </span>
            {status}
            {dismiss}
          </span>
        </div>
      </div>
    );
  }

  const status = available ? (
    <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-300/90">
      {t("cooldowns.available")}
    </span>
  ) : ready ? (
    <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-300">
      {t("cooldowns.readyCheck")}
    </span>
  ) : (
    <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-sky-200">
      {formatRemaining(remainingMs(cd, now, cooldownMs))}
    </span>
  );

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border",
        ready ? "border-emerald-500/50 bg-emerald-500/5" : "border-surface-600 bg-surface-800",
      )}
    >
      {fill}
      <div className="relative z-10 flex items-stretch gap-2.5 p-2">
        <span className="flex w-11 shrink-0 items-center justify-center">
          <ChestBadge src={sprite} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              title={openTitle}
              onClick={() => openStage != null && window.meter.openStagePage(openStage)}
              className="truncate text-left text-xs font-semibold text-white hover:underline"
            >
              {label}
            </button>
            <span className="ml-auto flex items-center gap-1.5">
              {status}
              {dismiss}
            </span>
          </div>
          {/* Where to farm this chest level: cross-mode stage ranges + base rate. */}
          <div className="min-w-0 truncate font-mono text-[10px] leading-relaxed">
            <BlueBoxSpots boxKey={boxKey} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Overlay container: the ACTIVE cooldowns + pinned route boxes as compact 1-line cards, soonest-
 *  ready first. Self-fetches (works in the always-on-top window even while the meter is offline);
 *  renders nothing when the tracker is OFF or there is nothing to show. The X HIDES an active
 *  line (declutter, not delete — a re-drop brings it back) and UNPINS a route placeholder.
 *  Mounted as a sibling of LiveView in LiveApp. */
export function OverlayCooldowns() {
  const enabled = useTrackerEnabled();
  const { active } = useCooldowns();
  const route = useRoute();
  const cooldownMs = useCooldownMs();
  const now = useNow(1000);
  if (!enabled) return null;
  // Hidden entries (overlay X) leave the strip but stay tracked + visible in the tab.
  const entries = buildTrackerEntries(active, route).filter((e) => !e.cd?.hidden);
  if (entries.length === 0) return null;
  const sorted = entries.sort(
    (a, b) =>
      (a.cd ? remainingMs(a.cd, now, cooldownMs) : 0) - (b.cd ? remainingMs(b.cd, now, cooldownMs) : 0),
  );
  return (
    <div className="flex flex-col gap-0.5 border-t border-surface-600 bg-surface-900/80 px-1 py-1">
      {sorted.map((e) => (
        <CooldownCard
          key={e.boxKey}
          boxKey={e.boxKey}
          cd={e.cd}
          now={now}
          cooldownMs={cooldownMs}
          variant="compact"
          onDismiss={(k) => window.meter.hideCooldown(k)}
          onUnpin={(k) => window.meter.setSettings({ chestRoute: route.filter((b) => b !== k) })}
        />
      ))}
    </div>
  );
}
