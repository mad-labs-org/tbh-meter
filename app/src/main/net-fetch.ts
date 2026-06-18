import { net } from "electron";

// --------------------------------------------------------------------------- //
// Main-process HTTP — route through Electron's `net.fetch` instead of Node's
// global `fetch` (undici).
//
// WHY: undici does NOT honor the Windows system proxy nor the OS certificate
// store. Electron's `net` module rides Chromium's network stack — the same one
// the browser uses — so it DOES honor the system proxy and trusts the OS root
// store. That fixes uploads for users behind:
//   - an antivirus doing TLS/HTTPS interception (its root CA is trusted by
//     Windows + the browser, but not by Node), and
//   - a system/corporate proxy.
// On undici these surface only as an opaque `TypeError: fetch failed` (the real
// reason is buried in `err.cause`), even though the user's browser can reach the
// API fine.
//
// `net.fetch` is signature- and shape-compatible with global fetch (returns a
// standard Response: `res.ok`, `res.json()`, headers, plus the same `method` /
// `body` / header init), so callers migrate as a drop-in. `net` requires the app
// to be ready before use — every caller here runs well after app-ready, except
// the pre-ready guard in error-report.ts.
// --------------------------------------------------------------------------- //

/** Drop-in replacement for global `fetch` that uses Electron's Chromium network stack. */
export function httpFetch(
  input: string | GlobalRequest,
  init?: RequestInit,
): Promise<GlobalResponse> {
  return net.fetch(input, init);
}
