---
name: dev
description: Boot and drive the tbh-meter app + reader locally to see a change working — what runs on macOS (UI only; the reader is win32-only) and how to feed the overlay/list fake data. Use when asked to run/start the meter, verify a change in the running app, screenshot the overlay, or reproduce a bug locally.
---

# Running tbh-meter locally

## The app (Electron overlay) — macOS runs UI only

```bash
cd app && pnpm dev   # electron-vite; the reader spawn is a win32+packaged no-op on macOS
```

On macOS the reader never spawns, but the file-watching sources still work — drive the UI by writing
artifacts into `~/tbh-meter/`:

- `raw/<endTsMs>.json` — a finished run. The converter turns it into `logs/<id>.json` and the list updates.
- `live.json` — the overlay snapshot. **Rewrite it with an ADVANCING mtime** each tick, or the overlay
  won't animate (engagement detection keys off mtime).

Steal real fixtures from `app/src/main/**/__tests__/` or a teammate's `~/tbh-meter/`. RC build uses
`~/tbh-meter-rc/` instead.

### Screenshot the overlay/list (CDP)

Renderer changes must be verified on real pixels, not just unit tests (`app/CLAUDE.md`). Launch with
the debugger open and drive it over CDP:

```bash
cd app && pnpm dev -- --remote-debugging-port=9222
```

Then connect a CDP client to `localhost:9222` and capture the window against the seeded `~/tbh-meter/`
artifacts above.

## The reader (Python) — Windows only

The reader reads game memory and only runs on `win32` (`reader/CLAUDE.md`). On macOS you can lint and
test it but not attach to the game:

```bash
cd reader && ruff check . && python3 -m pytest
```

## Verify before finishing

```bash
cd app    && pnpm check && pnpm test     # eslint + tsc (both tsconfigs) + vitest
cd reader && ruff check . && python3 -m pytest
```
