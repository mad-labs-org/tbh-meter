import { blueBoxSpotsForBox } from "~/lib/game-data";
import { modeAbbrev, modeTextClass } from "~/lib/format";
import { cn } from "~/lib/utils";

/** The blue box's cross-mode drop spots as one inline run: each MODE (abbreviated, in its
 *  color) + its `[range]·%` segments in white-bold, modes separated by a blank space.
 *  Embedded in the cooldown card (the chest icon + level live on the card itself).
 *  Renders nothing when the key isn't a blue box. */
export function BlueBoxSpots({ boxKey }: { boxKey: number | null | undefined }) {
  const modes = blueBoxSpotsForBox(boxKey);
  if (!modes) return null;
  return (
    <>
      {modes.map((m, idx) => (
        <span key={m.mode} className={cn("tabular-nums", modeTextClass(m.mode), idx > 0 && "ml-2")}>
          {m.segments.map((s, i) => (
            <span key={i} className={cn("font-bold text-zinc-100", i > 0 && "ml-2")}>
              [{s.range}]·{s.pct}
            </span>
          ))}{" "}
          <span className="font-bold uppercase tracking-wide">{modeAbbrev(m.mode)}</span>
        </span>
      ))}
    </>
  );
}
