import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupServer } from "msw/node";

// handlers.ts transitively loads config.ts, which reads app.isPackaged at module
// load — stub electron so the import graph resolves (matches share.test.ts). With
// isPackaged=false, API_URL falls back to the dev base http://localhost:8787.
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => "/tmp" },
}));

const { handlers } = await import("./handlers.js");
const { API_URL } = await import("../main/config.js");

// Own server lifecycle, isolated to this file — does not touch any other test's
// fetch mocking. This proves MSW intercepts Node's global fetch, which is exactly
// what the Electron MAIN process uses (share.ts / auth.ts / error-report.ts).
const server = setupServer(...handlers);

describe("MSW mock API handlers", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("intercepts POST /runs with a created run (id + duplicate) — what share.ts reads", async () => {
    const res = await fetch(`${API_URL}/runs`, { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; duplicate: boolean };
    expect(body.id).toBeTruthy();
    expect(body.duplicate).toBe(false);
  });

  it("intercepts GET /me with a signed-in profile — what auth.ts reads", async () => {
    const res = await fetch(`${API_URL}/me`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { user: { displayName: string; avatarUrl: string } };
    expect(body.user.displayName).toBe("Mock User");
    expect(body.user.avatarUrl).toBeTruthy();
  });

  it("intercepts POST /runs/claim (claimed count)", async () => {
    const res = await fetch(`${API_URL}/runs/claim`, { method: "POST" });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { claimed: number };
    expect(body.claimed).toBe(0);
  });

  it("intercepts POST /meter-errors with a 204 — the relay never reads the body", async () => {
    const res = await fetch(`${API_URL}/meter-errors`, { method: "POST" });
    expect(res.status).toBe(204);
  });
});
