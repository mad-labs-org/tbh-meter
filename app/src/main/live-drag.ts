import type { BrowserWindow } from "electron";

export type DragMode = "move" | "resize";
export interface Point {
  x: number;
  y: number;
}

export interface LiveDragDeps {
  /** The live overlay window, or null if it's gone (destroyed / not yet created). */
  getWindow(): BrowserWindow | null;
  /** OS cursor position in DIP — `screen.getCursorScreenPoint()`. */
  getCursor(): Point;
  /** Apply a window WIDTH (clamped to the floor main-side); keeps the left edge fixed. */
  setWidth(width: number): void;
}

interface DragState {
  mode: DragMode;
  /** The window's left/top at grab (DIP). For resize, winX is the fixed left edge. */
  winX: number;
  winY: number;
  /** Cursor offset within the window at grab (DIP) — keeps the grab point under the cursor while moving. */
  offX: number;
  offY: number;
}

/**
 * Custom move (title bar) / width-resize (right edge) of the live overlay, resolved HERE
 * against the OS cursor in DIP. `screen.getCursorScreenPoint()` and `getBounds()` share the
 * DIP coordinate space, so this is correct under ANY Windows display scale / page zoom.
 *
 * The renderer only drives cadence (pointer capture for robust move/up, #377) and sends NO
 * coordinates: its `screenX` is in the renderer's coordinate space, which leaks PHYSICAL
 * pixels at `devicePixelRatio != 1` while `setBounds` consumes DIP. Feeding that straight in
 * inflated the width by the scale factor, so the right edge ran away from the cursor and
 * could not be shrunk back — runaway, un-shrinkable growth on scaled monitors (e.g. 1440p
 * @ 150%). Capturing the anchor once (#377) fixed the feedback loop but not the unit
 * mismatch; doing the geometry main-side in DIP removes the mismatch entirely.
 */
export function createLiveDrag(deps: LiveDragDeps): {
  start(mode: DragMode): void;
  move(): void;
  end(): void;
} {
  let state: DragState | null = null;

  return {
    start(mode: DragMode): void {
      const win = deps.getWindow();
      if (!win) return;
      const b = win.getBounds();
      const c = deps.getCursor();
      state = { mode, winX: b.x, winY: b.y, offX: c.x - b.x, offY: c.y - b.y };
    },

    move(): void {
      const win = deps.getWindow();
      if (!win || !state) return;
      const c = deps.getCursor();
      if (state.mode === "resize") {
        // Left edge fixed (setWidth keeps b.x); width = cursor − left edge.
        deps.setWidth(c.x - state.winX);
      } else {
        win.setPosition(Math.round(c.x - state.offX), Math.round(c.y - state.offY));
      }
    },

    end(): void {
      state = null;
    },
  };
}
