import { heroSprite } from "~/lib/game-data";

// A hero's idle portrait in a small rounded frame: the sprite when one exists, else a 2-letter
// class fallback. Shared by the runs-list team cell and the run-detail per-hero XP rows.
export function HeroPortrait({ heroKey, heroClass }: { heroKey: number; heroClass: string }) {
  const src = heroSprite(heroKey);
  return (
    <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-950/50 ring-1 ring-surface-700/40">
      {src ? (
        // Native 1x — fractional pixel-art scaling looks mangled, so crop instead.
        <img src={src} alt={heroClass} className="max-w-none [image-rendering:pixelated]" />
      ) : (
        <span className="text-[9px] text-zinc-400">{heroClass.slice(0, 2)}</span>
      )}
    </span>
  );
}
