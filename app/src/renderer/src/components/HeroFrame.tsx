import { cn } from "~/lib/utils";
import { heroName, levelCurve } from "~/lib/game-data";
import { heroResistances, type HeroResistance, type ResElement } from "~/lib/hero-resistance";
import { OverlayTooltip } from "~/components/OverlayTooltip";
import { useHoverTooltip } from "~/lib/use-hover-tooltip";
import { useT } from "~/lib/i18n";
import { formatEta, humanize } from "~/lib/format";
import { expToNextLevel, measuredExpPerSecond, timeToNextLevel } from "../../../shared/exp-model.js";

// One deployed hero in the live Team frame: the idle sprite, its live level (corner badge) + the ETA
// to the next level beneath it, and a hover card. The card shows the leveling detail (within-level
// progress bar, the measured XP/sec, the ETA) AND the hero's EFFECTIVE elemental resistances on the
// current stage (its own resistance minus the difficulty penalty — see hero-resistance.ts). The ETA
// is derived from the meter's MEASURED live XP/sec (the game's own number), so it carries no
// penalty-model risk; a hero at the level cap shows "MAX" and no ETA.

/** Per-hero live leveling snapshot (mirrors LiveSnapshot.partyProgress[heroKey]). */
export interface HeroProgress {
  level: number;
  /** Within-level exp (resets on level-up); remaining = curve[level] − exp. */
  exp: number;
  /** Run-accumulated xp for this hero (level-up-bridged) → the measured rate is gain / elapsed. */
  gain: number;
}

const ELEMENT_DOT: Record<ResElement, string> = {
  Fire: "bg-orange-400",
  Cold: "bg-sky-400",
  Lightning: "bg-yellow-300",
  Chaos: "bg-fuchsia-400",
};

/** Color the effective value: negative = vulnerable (red), positive = resistant (green), 0 = muted. */
function effClass(v: number): string {
  if (v < 0) return "text-rose-300";
  if (v > 0) return "text-emerald-300";
  return "text-zinc-400";
}

function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v}%`;
}

export function HeroFrame({
  heroKey,
  src,
  stats,
  progress,
  elapsedSec,
  mode,
}: {
  heroKey: number;
  src: string;
  stats: Record<number, number> | undefined;
  progress: HeroProgress | undefined;
  elapsedSec: number;
  mode: string;
}) {
  const t = useT();
  const { open, anchorRef, hover } = useHoverTooltip<HTMLSpanElement>();
  const info = heroResistances(stats, mode);

  // Leveling — all from the MEASURED live rate (no penalty model). need=null ⇒ at the cap.
  const need = progress ? expToNextLevel(progress.level, levelCurve) : null;
  const capped = progress != null && need == null;
  const rate = progress ? measuredExpPerSecond(progress.gain, elapsedSec) : 0;
  const eta = progress ? timeToNextLevel(progress.level, progress.exp, rate, levelCurve) : null;
  const etaLabel = eta == null ? "—" : formatEta(eta);
  const hasEta = progress != null && !capped && etaLabel !== "—";
  const pct = progress && need ? Math.min(100, Math.max(0, (progress.exp / need) * 100)) : 0;

  return (
    <span
      ref={anchorRef}
      onMouseEnter={() => hover(true)}
      onMouseLeave={() => hover(false)}
      className="flex flex-col items-center gap-0.5"
    >
      <span className="relative">
        <span className="flex size-7 items-center justify-center overflow-hidden rounded bg-surface-900/80 ring-1 ring-surface-500/70">
          <img
            src={src}
            alt=""
            aria-hidden
            className="size-6 max-w-none object-contain [image-rendering:pixelated]"
          />
        </span>
        {progress && (
          <span className="absolute -right-1 -top-1 rounded bg-surface-700 px-0.5 text-[8px] font-bold leading-[1.45] tabular-nums text-zinc-300 ring-1 ring-surface-500/80">
            {progress.level}
          </span>
        )}
      </span>
      {progress && (
        <span
          className={cn(
            // normal-case: the footer is uppercase, but "36m" must not read as "36M" (millions).
            "font-mono text-[8px] font-semibold normal-case leading-none tabular-nums",
            capped ? "text-zinc-600" : hasEta ? "text-emerald-300" : "text-zinc-500",
          )}
        >
          {capped ? t("live.maxed") : etaLabel}
        </span>
      )}

      {(progress || info) && (
        // placement="top": this frame lives in the overlay's bottom footer, so the card opens the
        // tooltip UPWARD — a downward one would grow the window under the cursor and flicker (see
        // OverlayTooltip).
        <OverlayTooltip anchorRef={anchorRef} open={open} placement="top">
          <div className="flex min-w-[8.5rem] flex-col gap-2">
            <div className="flex items-center justify-between gap-3 border-b border-surface-600/70 pb-1">
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-200">
                {heroName(heroKey)}
              </span>
              {progress && (
                <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
                  {capped ? t("live.maxed") : `lv ${progress.level}`}
                </span>
              )}
            </div>

            {progress && !capped && need != null && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3 font-mono text-[10px]">
                  <span className="uppercase tracking-wider text-zinc-500">{t("live.timeToLevel")}</span>
                  <span className="font-semibold tabular-nums text-emerald-300">
                    {hasEta ? `→ ${progress.level + 1} · ${etaLabel}` : "—"}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-surface-600">
                  <span
                    className="block h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-400"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="font-mono text-[9px] tabular-nums text-zinc-500">
                  {humanize(rate)} xp/s · {pct.toFixed(0)}%
                </span>
              </div>
            )}

            {info && (
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
                  Resist · {mode}
                </span>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px]">
                  {info.resistances.map((r) => (
                    <ResLine key={r.element} r={r} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </OverlayTooltip>
      )}
    </span>
  );
}

function ResLine({ r }: { r: HeroResistance }) {
  return (
    <span className="flex items-center gap-1.5 leading-tight">
      <span className={cn("size-1.5 shrink-0 rounded-full", ELEMENT_DOT[r.element])} />
      <span className="w-14 shrink-0 text-zinc-400">{r.element}</span>
      <span className={cn("tabular-nums font-semibold", effClass(r.effective))}>
        {fmtPct(r.effective)}
      </span>
    </span>
  );
}
