import { describe, expect, it, vi } from "vitest";

// share.ts transitively loads config.ts (which reads app.isPackaged at module load)
// and error-report.ts (which imports electron) — stub electron so the graph imports.
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => "/tmp" },
}));

import { isReportableUploadFailure, isReportableNetworkError } from "../share.js";
import type { ErrorCause } from "../error-report.js";

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

describe("isReportableNetworkError", () => {
  const cause = (code?: string, message?: string): ErrorCause => ({ code, message });

  it("suppresses transient connectivity by cause CODE (Node/undici) — user's own network, not actionable", () => {
    const codes = [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNABORTED",
      "ENETUNREACH",
      "ENETDOWN",
      "EHOSTUNREACH",
      "EPIPE",
    ];
    for (const code of codes) {
      expect(isReportableNetworkError(cause(code), "fetch failed")).toBe(false);
    }
  });

  it("suppresses transient connectivity by Chromium net:: string in the MESSAGE (net.fetch shape)", () => {
    // net.fetch surfaces the reason in the message, not a .code — the dominant 61-report case
    // (net::ERR_NAME_NOT_RESOLVED) arrives this way with no cause at all.
    const messages = [
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_INTERNET_DISCONNECTED",
      "net::ERR_NETWORK_CHANGED",
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_CONNECTION_RESET",
      "net::ERR_CONNECTION_CLOSED",
      "net::ERR_CONNECTION_TIMED_OUT",
      "net::ERR_CONNECTION_ABORTED",
      "net::ERR_ADDRESS_UNREACHABLE",
      "net::ERR_TIMED_OUT",
    ];
    for (const message of messages) {
      expect(isReportableNetworkError(cause(undefined, undefined), message)).toBe(false);
    }
  });

  it("suppresses a generic 'offline' reason wherever it appears", () => {
    expect(isReportableNetworkError(cause(undefined, "The internet connection appears to be offline."), "Load failed")).toBe(
      false,
    );
  });

  it("REPORTS TLS / cert interception — signals AV/proxy MITM, the reason we capture the cause at all", () => {
    // These are actionable: a tampered cert chain is a real, fixable environment problem
    // (allow-list the cert / disable AV HTTPS scanning), not a self-healing blip.
    for (const code of [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "CERT_HAS_EXPIRED",
      "CERT_UNTRUSTED",
    ]) {
      expect(isReportableNetworkError(cause(code, "unable to verify the first certificate"), "fetch failed")).toBe(true);
    }
  });

  it("REPORTS an unknown or empty reason — keep visibility on failures we haven't classified", () => {
    expect(isReportableNetworkError(cause(undefined, undefined), "fetch failed")).toBe(true);
    expect(isReportableNetworkError(cause(undefined, undefined), "unknown")).toBe(true);
    expect(isReportableNetworkError(cause("EUNKNOWNWEIRD", "something new"), "boom")).toBe(true);
  });

  it("matches case-insensitively (codes/messages arrive in mixed case across layers)", () => {
    expect(isReportableNetworkError(cause("enotfound"), "fetch failed")).toBe(false);
    expect(isReportableNetworkError(cause(undefined, undefined), "net::err_name_not_resolved")).toBe(false);
  });
});
