import { ShieldAlert } from "lucide-react";
import { cn } from "~/lib/utils";
import { OverlayTooltip } from "~/components/OverlayTooltip";
import { useHoverTooltip } from "~/lib/use-hover-tooltip";
import type { StageThreatInfo, ThreatElement } from "~/lib/stage-threat";

// Stage-threat badges (element dots + penalty shield next to the stage label) with a floating
// tooltip on hover, via the shared OverlayTooltip (portal + window-grow). Shows which elements the
// stage throws (and which monsters bring them) plus the difficulty's base resistance penalty.

const ELEMENT_DOT: Record<ThreatElement, string> = {
  Fire: "bg-orange-400",
  Cold: "bg-sky-400",
  Lightning: "bg-yellow-300",
  Chaos: "bg-fuchsia-400",
};

const ELEMENT_TEXT: Record<ThreatElement, string> = {
  Fire: "text-orange-300",
  Cold: "text-sky-300",
  Lightning: "text-yellow-200",
  Chaos: "text-fuchsia-300",
};

/** The hover trigger + tooltip, self-contained: drop it next to the mode badge. */
export function StageThreatBadges({ info }: { info: StageThreatInfo }) {
  const { open, anchorRef, hover } = useHoverTooltip<HTMLSpanElement>();

  return (
    <>
      <span
        ref={anchorRef}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
        className="flex shrink-0 cursor-default items-center gap-1"
      >
        {info.elements.map((e) => (
          <span key={e.element} className={cn("size-1.5 rounded-full", ELEMENT_DOT[e.element])} />
        ))}
        {info.penalty != null && <ShieldAlert className="size-2.5 text-rose-400/90" />}
      </span>
      <OverlayTooltip anchorRef={anchorRef} open={open}>
        <div className="flex flex-col gap-1 font-mono text-[10px]">
          {info.elements.map((e) => (
            <div key={e.element} className="flex min-w-0 items-center gap-1.5 leading-tight">
              <span className={cn("size-1.5 shrink-0 rounded-full", ELEMENT_DOT[e.element])} />
              <span
                className={cn(
                  "shrink-0 font-semibold uppercase tracking-wider",
                  ELEMENT_TEXT[e.element],
                )}
              >
                {e.element}
              </span>
              <span className="min-w-0 truncate text-zinc-500">
                {e.monsters.map((m) => (m.boss ? `${m.name} (boss)` : m.name)).join(", ")}
              </span>
            </div>
          ))}
          {info.penalty != null && (
            <div className="flex min-w-0 items-center gap-1.5 leading-tight">
              <ShieldAlert className="size-3 shrink-0 text-rose-400" />
              <span className="shrink-0 font-semibold text-rose-300">
                All resistances −{info.penalty}%
              </span>
              {/* "base": the data tier for this difficulty — a hero's effective value (with their
                  own resistance) shows on the per-hero tooltip; here it's the stage's raw penalty. */}
              <span className="truncate text-zinc-600">{info.mode} base penalty</span>
            </div>
          )}
        </div>
      </OverlayTooltip>
    </>
  );
}
