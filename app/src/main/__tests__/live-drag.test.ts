import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createLiveDrag, type LiveDragDeps, type Point } from "../live-drag.js";

// A drag is resolved against the OS cursor in DIP (getCursorScreenPoint) — the SAME space
// as getBounds/setBounds — so it is correct under any Windows display scale. These tests
// pin that contract: the API takes NO renderer coordinates (structurally immune to the
// physical-px screenX leak at devicePixelRatio != 1 that drove the runaway resize, #377),
// width anchors to the LEFT edge captured at grab, and move keeps the grab point under the
// cursor.

function harness(opts: { bounds: { x: number; y: number; width: number; height: number } }) {
  let cursor: Point = { x: 0, y: 0 };
  const setPosition = vi.fn();
  const setWidth = vi.fn();
  const win = {
    isDestroyed: () => false,
    getBounds: () => opts.bounds,
    setPosition,
  } as unknown as BrowserWindow;
  const deps: LiveDragDeps = {
    getWindow: () => win,
    getCursor: () => cursor,
    setWidth,
  };
  return {
    drag: createLiveDrag(deps),
    setCursor: (p: Point) => {
      cursor = p;
    },
    setPosition,
    setWidth,
  };
}

describe("createLiveDrag — resize (width)", () => {
  it("sets width = cursor.x − the left edge captured at grab", () => {
    const h = harness({ bounds: { x: 100, y: 50, width: 420, height: 48 } });
    h.setCursor({ x: 700, y: 60 });
    h.drag.start("resize");
    h.setCursor({ x: 900, y: 60 });
    h.drag.move();
    // left edge = 100 (DIP); width follows the cursor, NOT inflated by any scale factor.
    expect(h.setWidth).toHaveBeenCalledWith(800);
  });

  it("shrinks symmetrically — the left edge stays the anchor as the cursor moves left", () => {
    const h = harness({ bounds: { x: 100, y: 50, width: 600, height: 48 } });
    h.setCursor({ x: 700, y: 60 });
    h.drag.start("resize");
    h.setCursor({ x: 300, y: 60 });
    h.drag.move();
    expect(h.setWidth).toHaveBeenLastCalledWith(200); // 300 − 100; clamping is the caller's job
  });
});

describe("createLiveDrag — move (position)", () => {
  it("keeps the grab point under the cursor (rounded DIP)", () => {
    const h = harness({ bounds: { x: 100, y: 50, width: 420, height: 48 } });
    h.setCursor({ x: 150, y: 70 }); // grab offset = (50, 20) within the window
    h.drag.start("move");
    h.setCursor({ x: 400.6, y: 250.4 });
    h.drag.move();
    // new top-left = cursor − grab offset = (400.6 − 50, 250.4 − 20) rounded
    expect(h.setPosition).toHaveBeenCalledWith(351, 230);
  });
});

describe("createLiveDrag — lifecycle", () => {
  it("ignores a move with no active drag, and after end()", () => {
    const h = harness({ bounds: { x: 0, y: 0, width: 420, height: 48 } });
    h.setCursor({ x: 10, y: 10 });
    h.drag.move(); // no start yet
    h.drag.start("resize");
    h.drag.end();
    h.setCursor({ x: 900, y: 10 });
    h.drag.move(); // ended
    expect(h.setWidth).not.toHaveBeenCalled();
    expect(h.setPosition).not.toHaveBeenCalled();
  });

  it("is a no-op when the live window is gone", () => {
    const setWidth = vi.fn();
    const drag = createLiveDrag({
      getWindow: () => null,
      getCursor: () => ({ x: 500, y: 0 }),
      setWidth,
    });
    drag.start("resize");
    drag.move();
    expect(setWidth).not.toHaveBeenCalled();
  });
});
