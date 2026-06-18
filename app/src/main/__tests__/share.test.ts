import { describe, expect, it, vi } from "vitest";

// share.ts transitively loads config.ts (which reads app.isPackaged at module load)
// and error-report.ts (which imports electron) — stub electron so the graph imports.
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => "/tmp" },
}));

import { isReportableUploadFailure } from "../share.js";

describe("isReportableUploadFailure", () => {
  it("reports client-side 4xx rejections — the API refused our payload, which is actionable", () => {
    for (const status of [400, 403, 404, 409, 413, 422]) {
      expect(isReportableUploadFailure(status)).toBe(true);
    }
  });

  it("suppresses the expected/transient states auto-upload already retries (401/408/429)", () => {
    expect(isReportableUploadFailure(401)).toBe(false); // expired token (no refresh) → clearSession
    expect(isReportableUploadFailure(408)).toBe(false); // request timeout
    expect(isReportableUploadFailure(429)).toBe(false); // rate-limited, backs off
  });

  it("suppresses every server/gateway 5xx, incl. the Cloudflare 52x flooding #log-error", () => {
    for (const status of [500, 502, 503, 504, 520, 522, 524, 525]) {
      expect(isReportableUploadFailure(status)).toBe(false);
    }
  });
});
