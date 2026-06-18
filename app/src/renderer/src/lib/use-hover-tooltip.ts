import { useEffect, useRef, useState, type RefObject } from "react";

// A hover open/close state machine for the floating OverlayTooltip: open on enter, close after a
// short grace delay on leave (so the cursor can cross a small gap to the tooltip). Returns the
// `open` flag, the `anchorRef` to attach to the trigger element, and `hover(on)` for the
// enter/leave handlers. Shared by the stage-threat badges and the per-hero resistance frames.

const CLOSE_DELAY_MS = 150;

export function useHoverTooltip<T extends HTMLElement>(): {
  open: boolean;
  anchorRef: RefObject<T | null>;
  hover: (on: boolean) => void;
} {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<T>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hover = (on: boolean): void => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (on) setOpen(true);
    else closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  return { open, anchorRef, hover };
}
