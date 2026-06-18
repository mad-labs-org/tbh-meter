import { useEffect, useRef, useState } from "react";
import { LiveView } from "~/views/LiveView";
import { OverlayCooldowns } from "~/components/CooldownCard";
import { getOverlayExtent, onOverlayExtent } from "~/lib/overlay-extent";
import { clampFontScale } from "../../shared/ipc-types.js";
import { useT } from "~/lib/i18n";

// Window shell for the realtime meter. Owns only window-level behavior: height is
// content-driven (measured here, pinned by main), width is user-resizable via a JS
// edge-handle, the whole strip is scalable via a JS bottom-handle (#232 "vertical
// resize" — height is content-pinned, so scaling the content IS the vertical resize),
// and the window is dragged from the title bar (JS-driven via Pointer Events + pointer
// capture, not -webkit-app-region, so the CSS cursor sticks). All content lives in LiveView.
export default function LiveApp() {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const lastH = useRef(0);
  // Current font scale (zoom), kept in sync with settings: the bottom-edge drag needs
  // it as its starting point. Stored in a ref-readable state pair so the drag handler
  // (bound at mousedown) reads the freshest value without re-binding.
  const [fontScale, setFontScale] = useState(1);
  const fontScaleRef = useRef(1);
  fontScaleRef.current = fontScale;

  useEffect(() => {
    void window.meter.getSettings().then((s) => setFontScale(clampFontScale(s.liveFontScale)));
    return window.meter.onSettingsChanged((s) => setFontScale(clampFontScale(s.liveFontScale)));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The window is pinned to the CARD's height — plus, while a floating tooltip is
    // open past the card's bottom, to the tooltip's reported extent (the extra rows
    // are fully transparent, so the card itself never moves).
    const report = (): void => {
      // CSS px — main multiplies by the live font scale to get window px (pinLiveHeight).
      const h = Math.ceil(Math.max(el.getBoundingClientRect().height, getOverlayExtent()));
      if (h > 0 && h !== lastH.current) {
        lastH.current = h;
        window.meter.setLiveHeight(h);
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    const offExtent = onOverlayExtent(report);
    return () => {
      ro.disconnect();
      offExtent();
    };
  }, []);

  // One JS-driven window drag/resize at a time, via Pointer Events + pointer capture.
  // Capture is what makes this robust: the captured element keeps receiving
  // pointermove/up even when the window slides under the cursor (setPosition breaks the
  // OS mouse grab) or the pointer leaves the transparent frameless window. Plain
  // mousemove/up on window could MISS the mouseup there, leaving a dangling listener that
  // later ran CONCURRENTLY with the next drag (#377). This hook owns ONLY the pointer
  // lifecycle (cadence); move/resize delegate the GEOMETRY to the main process, which
  // resolves it against the OS cursor in DIP — the renderer's screenX leaks physical px at
  // devicePixelRatio != 1, which made the resize run away on scaled monitors (Windows scale
  // 150% → #377 follow-up).
  const dragging = useRef(false);
  const beginWindowDrag = (
    e: React.PointerEvent,
    handlers: { onMove: (ev: PointerEvent) => void; onStart?: () => void; onEnd?: () => void },
  ): void => {
    if (e.button !== 0 || dragging.current) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const { pointerId } = e;
    dragging.current = true;
    el.setPointerCapture(pointerId);
    handlers.onStart?.();
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId === pointerId) handlers.onMove(ev);
    };
    const end = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      dragging.current = false;
      handlers.onEnd?.();
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        // capture already released (pointercancel) — ignore
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  // Move the window from the title bar. Main keeps the grab point under the cursor (DIP).
  const onTitlePointerDown = (e: React.PointerEvent): void =>
    beginWindowDrag(e, {
      onStart: () => window.meter.startWindowDrag("move"),
      onMove: () => window.meter.moveWindowDrag(),
      onEnd: () => window.meter.endWindowDrag(),
    });

  // Resize WIDTH by dragging the right edge. Main pins the left edge and sets
  // width = cursor − left edge (DIP), clamped to MIN_LIVE_WIDTH; grows AND shrinks
  // symmetrically. Native resize is off for transparent frameless windows; height stays
  // content-pinned.
  const onResizePointerDown = (e: React.PointerEvent): void =>
    beginWindowDrag(e, {
      onStart: () => window.meter.startWindowDrag("resize"),
      onMove: () => window.meter.moveWindowDrag(),
      onEnd: () => window.meter.endWindowDrag(),
    });

  // "Vertical resize" (#232): dragging the BOTTOM edge scales the whole strip. Height is
  // content-pinned, so the only meaningful vertical resize is a content scale — the drag
  // adjusts liveFontScale proportionally (clamped main-side too) and the window height
  // follows via the content re-pin. Grows AND shrinks; persisted like any setting, and
  // the Settings slider moves live since both write the same key. Stays renderer-side: it
  // is a unit-free RATIO of screenY distances, so it is immune to the DPI coordinate-space
  // mismatch that the move/resize had.
  const onScalePointerDown = (e: React.PointerEvent): void => {
    const winTop = window.screenY;
    const startSpan = Math.max(24, e.screenY - winTop); // window-top → grab-point distance
    const startScale = fontScaleRef.current;
    let raf = 0;
    beginWindowDrag(e, {
      onMove: (ev) => {
        if (raf) return; // coalesce to one settings write per frame
        raf = requestAnimationFrame(() => {
          raf = 0;
          const next = clampFontScale(
            Math.round(startScale * ((ev.screenY - winTop) / startSpan) * 100) / 100,
          );
          if (next !== fontScaleRef.current) {
            setFontScale(next);
            void window.meter.setSettings({ liveFontScale: next });
          }
        });
      },
      onEnd: () => {
        if (raf) cancelAnimationFrame(raf);
      },
    });
  };

  return (
    <div
      ref={ref}
      className="relative w-screen overflow-hidden rounded-lg border border-brand-600/40 bg-surface-900/90 text-white shadow-2xl backdrop-blur"
    >
      <LiveView onStartDrag={onTitlePointerDown} onOpenLogs={() => window.meter.openListWindow()} />

      {/* Active blue-chest cooldowns — below the meter, ALWAYS rendered (even while the meter
          is offline/between runs, since a 14-min chest keeps cooling). Self-fetching; renders
          nothing when there are none. The window height is content-pinned, so it grows to fit. */}
      <OverlayCooldowns />

      {/* Right-edge handle: drag to resize the window width (height stays content-pinned). */}
      <div
        onPointerDown={onResizePointerDown}
        title={t("live.dragResize")}
        className="absolute inset-y-0 right-0 z-10 flex w-1.5 cursor-ew-resize items-center justify-center hover:bg-surface-700/50"
      >
        <div className="h-3.5 w-px bg-surface-600" />
      </div>

      {/* Bottom-edge handle: drag to scale the meter (font size) — the #232 vertical resize. */}
      <div
        onPointerDown={onScalePointerDown}
        title={t("live.dragScale")}
        className="absolute inset-x-0 bottom-0 z-10 flex h-1.5 cursor-ns-resize items-center justify-center hover:bg-surface-700/50"
      >
        <div className="h-px w-3.5 bg-surface-600" />
      </div>
    </div>
  );
}
