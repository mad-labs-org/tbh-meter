import { Package } from "lucide-react";
import type { RunDrop } from "../../../shared/run-types.js";
import { chestSprite, itemName } from "~/lib/game-data";
import { useT } from "~/lib/i18n";
import { cn } from "~/lib/utils";

interface ChestGroup {
  key: string;
  src: string | null;
  boxKey: number;
  count: number;
}

/** Collapse a run's raw drops into one entry per distinct chest sprite, ordered by
 *  box_key (910* common -> 920* stage boss -> 930* act boss). Unmapped keys fall into a
 *  single "unknown" bucket (rendered with a generic glyph) so a chest is never silently
 *  dropped from the count. */
function groupDrops(drops: RunDrop[]): ChestGroup[] {
  const byKey = new Map<string, ChestGroup>();
  for (const d of drops) {
    const src = chestSprite(d.boxKey);
    const key = src ?? "unknown";
    const g = byKey.get(key);
    if (g) {
      g.count += 1;
      if (d.boxKey < g.boxKey) g.boxKey = d.boxKey;
    } else {
      byKey.set(key, { key, src, boxKey: d.boxKey, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => a.boxKey - b.boxKey);
}

const SIZES = {
  sm: { box: "size-6", img: "size-5", badge: "text-[9px]" },
  md: { box: "size-9", img: "size-7", badge: "text-[10px]" },
} as const;

/** Chest drops as a row of distinct chest sprites, each with a count badge (shown when
 *  >1). Shared by the runs-list Drops column (sm) and the run-detail drops panel (md). */
export function ChestDrops({ drops, size = "sm" }: { drops: RunDrop[]; size?: "sm" | "md" }) {
  const t = useT();
  const groups = groupDrops(drops);
  if (groups.length === 0) return <span className="text-zinc-600">—</span>;
  const s = SIZES[size];
  return (
    <div className="flex items-center gap-1.5">
      {groups.map((g) => (
        <span
          key={g.key}
          title={t("chest.tooltip", {
            name: itemName(g.boxKey) ?? t("chest.fallback"),
            count: g.count,
          })}
          className={cn(
            "relative flex shrink-0 items-center justify-center rounded bg-surface-950/50 ring-1 ring-surface-700/40",
            s.box,
          )}
        >
          {g.src ? (
            <img
              src={g.src}
              alt=""
              className={cn(s.img, "object-contain [image-rendering:pixelated]")}
            />
          ) : (
            <Package className={cn(s.img, "text-zinc-400")} />
          )}
          {g.count > 1 && (
            <span
              className={cn(
                "absolute -right-1 -bottom-1 rounded-full bg-surface-900 px-1 font-bold tabular-nums text-zinc-100 ring-1 ring-surface-600",
                s.badge,
              )}
            >
              {g.count}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
