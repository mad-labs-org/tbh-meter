import { formatDropRate } from "~/lib/game-data";
import { cn } from "~/lib/utils";

/** A blue-chest BASE drop-rate chip (e.g. "15%"), bold + tabular. Renders nothing when the
 *  rate is unknown. Shared by the cooldown cards + history so the % style stays consistent. */
export function DropRatePct({ rate, className }: { rate: number | null; className?: string }) {
  if (rate == null) return null;
  return (
    <span className={cn("font-mono text-[10px] font-bold tabular-nums text-zinc-200", className)}>
      {formatDropRate(rate)}
    </span>
  );
}
