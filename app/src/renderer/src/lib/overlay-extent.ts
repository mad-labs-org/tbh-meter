// Floating layers (tooltips) vs the height-pinned overlay window: the window is sized to the CARD's
// content, so anything floating below the card's bottom edge would be cut off at the window boundary.
// Each open floating layer reports the bottom edge (viewport px) it needs under its own id; LiveApp
// pins the window to max(card height, the largest reported extent). The extra rows are fully
// transparent, so nothing visible moves — the tooltip just gets room to render.
//
// Keyed by id (not a single value) so multiple tooltips can overlap correctly: when the cursor moves
// from one hero to another, the leaving tooltip clears ITS id while the entering one sets its own —
// the max stays right regardless of mount/unmount ordering.

const contributions = new Map<number, number>();
const subs = new Set<(px: number) => void>();
let seq = 0;

function current(): number {
  let max = 0;
  for (const v of contributions.values()) max = Math.max(max, v);
  return max;
}

function emit(): void {
  const v = current();
  for (const cb of subs) cb(v);
}

/** A fresh id for one floating-layer instance to report under (call once per tooltip mount). */
export function nextExtentId(): number {
  return ++seq;
}

/** Report (or update) the bottom edge this layer needs. */
export function setOverlayExtent(id: number, px: number): void {
  const v = Math.max(0, Math.ceil(px));
  if (contributions.get(id) === v) return;
  contributions.set(id, v);
  emit();
}

/** Drop this layer's contribution (call on unmount). */
export function clearOverlayExtent(id: number): void {
  if (contributions.delete(id)) emit();
}

/** The largest extent any open layer currently needs; 0 = nothing floating. */
export function getOverlayExtent(): number {
  return current();
}

/** Subscribe to extent changes; returns the unsubscribe. */
export function onOverlayExtent(cb: (px: number) => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
