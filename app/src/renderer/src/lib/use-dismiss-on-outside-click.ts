import { useEffect, type RefObject } from "react";

// Close an open popover when the user clicks outside it: while `open`, a document-level mousedown
// that lands outside `ref` calls `onClose`. No-op (and no listener) while closed. Shared by the
// runs-list popovers (filter bar, columns menu, session-stats hint).
export function useDismissOnOutsideClick(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, ref, onClose]);
}
