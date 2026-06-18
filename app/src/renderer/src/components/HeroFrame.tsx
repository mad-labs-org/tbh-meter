import { cn } from "~/lib/utils";
import { heroName } from "~/lib/game-data";
import { heroResistances, type HeroResistance, type ResElement } from "~/lib/hero-resistance";
import { OverlayTooltip } from "~/components/OverlayTooltip";
import { useHoverTooltip } from "~/lib/use-hover-tooltip";

// One deployed hero in the live Team frame: the idle sprite + a hover tooltip of its EFFECTIVE
// elemental resistances on the current stage (the hero's own resistance minus the difficulty
// penalty — see hero-resistance.ts). Negative = vulnerable. This is the number the game only shows
// one hero at a time in a panel; here it's a glance across the whole team.

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
  mode,
}: {
  heroKey: number;
  src: string;
  stats: Record<number, number> | undefined;
  mode: string;
}) {
  const { open, anchorRef, hover } = useHoverTooltip<HTMLSpanElement>();

  const info = heroResistances(stats, mode);

  return (
    <>
      <span
        ref={anchorRef}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
        className="flex size-7 items-center justify-center overflow-hidden rounded bg-surface-900/80 ring-1 ring-surface-500/70"
      >
        <img
          src={src}
          alt=""
          aria-hidden
          className="size-6 max-w-none object-contain [image-rendering:pixelated]"
        />
      </span>
      {info && (
        <OverlayTooltip anchorRef={anchorRef} open={open}>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3 border-b border-surface-600/70 pb-1">
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-200">
                {heroName(heroKey)}
              </span>
              <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
                Resist · {mode}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[10px]">
              {info.resistances.map((r) => (
                <ResLine key={r.element} r={r} />
              ))}
            </div>
          </div>
        </OverlayTooltip>
      )}
    </>
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
