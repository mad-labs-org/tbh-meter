import { http, HttpResponse } from "msw";
import { API_URL } from "../main/config.js";

// --------------------------------------------------------------------------- //
// MSW request handlers — a no-backend stand-in for the wiki API, so a contributor
// can run the whole meter (auth + upload + error relay) without the Hono API
// running. Wired in only by `pnpm dev:mock` (see src/mocks/node.ts) and dead-code
// eliminated from production builds (see src/main/index.ts). NEVER ships.
//
// Each response is shaped to satisfy the EXACT fields its caller reads:
//   - POST /runs        -> share.ts reads `id` (required) + `duplicate`; builds
//                          the public URL as `${SITE_URL}/leaderboards/${id}`.
//   - POST /runs/claim  -> share.ts reads optional `claimed` (count).
//   - GET  /me          -> auth.ts reads displayName/avatar (top-level or under `user`).
//   - POST /meter-errors-> error-report.ts ignores the body; 204 is plenty.
//
// Anything NOT listed here (Discord OAuth, GitHub update checks, …) is left to
// pass through to the real network — see the `onUnhandledRequest: "bypass"` in
// node.ts. The handlers only cover the calls a backend would otherwise answer.
// --------------------------------------------------------------------------- //

export const handlers = [
  // Run upload. Returns a freshly-"created" run so share.ts records a working URL.
  // Flip `duplicate` to true to exercise the already-uploaded path.
  http.post(`${API_URL}/runs`, () =>
    HttpResponse.json({ id: "mock-run-1", duplicate: false }, { status: 201 }),
  ),

  // Re-attribution of anonymous uploads on sign-in. share.ts only logs `claimed`.
  http.post(`${API_URL}/runs/claim`, () => HttpResponse.json({ claimed: 0 })),

  // Signed-in profile. auth.ts accepts the profile nested under `user`; supply a
  // display name + avatar so the renderer shows a real-looking signed-in user.
  http.get(`${API_URL}/me`, () =>
    HttpResponse.json({
      user: {
        displayName: "Mock User",
        avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
      },
    }),
  ),

  // Error relay. error-report.ts is fire-and-forget and never reads the body.
  http.post(`${API_URL}/meter-errors`, () => new HttpResponse(null, { status: 204 })),
];
