import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "~/lib/utils";
import { nextExtentId, setOverlayExtent, clearOverlayExtent } from "~/lib/overlay-extent";

// A real floating tooltip for the height-pinned, transparent overlay window. It must NOT be a
// descendant of the meter card: the card's backdrop-filter creates a containing block that clips
// position:fixed — so this portals to document.body. It positions itself just under `anchorRef`,
// clamps to the window width, and reports its bottom edge via the overlay-extent so the window grows
// (in transparent space) instead of clipping it. pointer-events-none: a plain tooltip, never grabs
// the mouse. Shared by the stage-threat badges and the per-hero resistance frames.

const EDGE_PAD = 4;
const GAP = 6;

export function OverlayTooltip({
  anchorRef,
  open,
  children,
  className,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  if (!open) return null;
  return createPortal(
    <TipBox anchorRef={anchorRef} className={className}>
      {children}
    </TipBox>,
    document.body,
  );
}

function TipBox({
  anchorRef,
  children,
  className,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<number>(nextExtentId());
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const id = idRef.current;
    const place = (): void => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const box = boxRef.current?.getBoundingClientRect();
      if (!anchor || !box) return;
      const left = Math.max(
        EDGE_PAD,
        Math.min(anchor.left, window.innerWidth - box.width - EDGE_PAD),
      );
      const top = anchor.bottom + GAP;
      setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
      setOverlayExtent(id, top + box.height + EDGE_PAD);
    };
    place();
    const ro = new ResizeObserver(place);
    if (boxRef.current) ro.observe(boxRef.current);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      clearOverlayExtent(id);
    };
    // children in deps: re-place when the tooltip's content (size) changes.
  }, [anchorRef, children]);

  return (
    <div
      ref={boxRef}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
      className={cn(
        "pointer-events-none fixed z-50 w-max max-w-[300px] rounded-md border border-surface-500/70 bg-surface-800/95 px-2.5 py-2 shadow-xl backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}
