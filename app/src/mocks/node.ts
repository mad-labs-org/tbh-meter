import { setupServer } from "msw/node";
import { handlers } from "./handlers.js";

// --------------------------------------------------------------------------- //
// MSW Node server — intercepts the main process's global `fetch` (the same fetch
// share.ts / auth.ts / error-report.ts use) so the meter talks to the mocked API
// instead of a real backend. Started ONLY by `pnpm dev:mock` from src/main/index.ts,
// behind an `import.meta.env.DEV` guard that strips this whole module from prod.
//
// `onUnhandledRequest: "bypass"` lets every request we DON'T mock (Discord OAuth,
// GitHub update checks, sprite/CDN fetches) hit the real network untouched.
// --------------------------------------------------------------------------- //

export function startMockApi(): void {
  const server = setupServer(...handlers);
  server.listen({ onUnhandledRequest: "bypass" });
  console.log("[mocks] MSW mock API active — meter is running with NO backend");
}
