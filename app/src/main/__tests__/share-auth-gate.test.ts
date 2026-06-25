import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHash,
  generateKeyPairSync,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { RunRecord } from "../../shared/run-types.js";

// Phase 2: upload REQUIRES sign-in and SIGNS the request.
//   - Signed out → uploadRun returns `unauthorized` and makes NO network call
//     (the old anonymous X-Device-Id path is gone).
//   - Signed in  → the request carries Authorization: Bearer + the three Ed25519
//     signature headers, and the signature verifies against the dev public key
//     over the EXACT body bytes that were sent (proving hash == sent body).

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0-test", getPath: () => "/tmp" },
}));

// Auth token is swapped per-describe via this mutable holder.
const authState: { token: string | null } = { token: null };
vi.mock("../auth.js", () => ({
  getAccessToken: async () => authState.token,
  clearSession: () => {},
  // Never reached in these cases (signed-out makes no call; signed-in 200s), but the
  // share.ts import binding must exist or vitest throws on resolve.
  refreshAccessToken: async () => false,
}));
vi.mock("../device-id.js", () => ({ getDeviceId: () => "device-uuid-fixed" }));
vi.mock("../runs-store.js", () => ({ getRun: () => null }));
vi.mock("../error-report.js", () => ({ reportError: () => {} }));
// uploadRun posts via httpFetch (Electron net) — delegate to the stubbed global fetch.
vi.mock("../net-fetch.js", () => ({
  httpFetch: (input: string | GlobalRequest, init?: RequestInit) => fetch(input, init),
}));

const { uploadRun } = await import("../share.js");
const { _resetKeyForTest } = await import("../request-signer.js");

// NO signing key is committed. To exercise the signed-in path we inject a throwaway
// Ed25519 PRIVATE key via the build constant request-signer.ts reads, and verify the
// upload's signature against the matching PUBLIC half. Per-test in beforeEach.
let signingPubKey: KeyObject;

function injectEphemeralSigningKey(): KeyObject {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privDerB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  vi.stubGlobal("__TBH_SIGNING_PRIVATE_KEY__", privDerB64);
  _resetKeyForTest();
  return publicKey;
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "sess-1:7",
    ts: 1_750_000_000,
    sessionId: "sess-1",
    schemaVersion: 2,
    gameVersion: "1.0.0",
    run: 7,
    status: "success",
    stage: "3-9",
    act: 3,
    stageNo: 9,
    stageKey: 309,
    mode: "Hell",
    mobs: 487,
    totalMobs: 487,
    totalDamage: 4_520_000,
    dps: 19_590,
    clearTime: 217,
    duration: 219,
    goldGained: 500_000,
    goldSource: "delta",
    xpGained: 10_300_000,
    xpSource: "delta",
    xpPerSec: 47_465,
    goldPerSec: 2_304,
    partial: false,
    heroes: [{ heroKey: 201, class: "Knight", level: 80, skills: [], items: [] }],
    ...overrides,
  } as RunRecord;
}

afterEach(() => {
  // Restore the injected signing key global so no test leaks it into the next.
  vi.unstubAllGlobals();
  _resetKeyForTest();
});

describe("uploadRun signed-out → no anonymous request", () => {
  beforeEach(() => {
    authState.token = null;
  });

  it("makes NO network call and returns unauthorized (anonymous path removed)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await uploadRun(run());

    expect(fetchSpy).not.toHaveBeenCalled(); // never an anonymous upload
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("unauthorized");
  });
});

describe("uploadRun signed-in → Bearer + valid Ed25519 signature over the sent body", () => {
  let captured: { url: string; init: RequestInit } | null = null;

  beforeEach(() => {
    authState.token = "bearer-token-xyz";
    captured = null;
    signingPubKey = injectEphemeralSigningKey();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "run-id-123", duplicate: false }),
        } as Response;
      }),
    );
  });

  it("sends Authorization: Bearer + X-Signature/X-Timestamp/X-Nonce", async () => {
    const res = await uploadRun(run());
    expect(res.ok).toBe(true);

    expect(captured).not.toBeNull();
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer bearer-token-xyz");
    expect(typeof headers["X-Signature"]).toBe("string");
    expect(typeof headers["X-Timestamp"]).toBe("string");
    expect(typeof headers["X-Nonce"]).toBe("string");
    // The anonymous device header must NOT be sent on a signed-in upload.
    expect(headers["X-Device-Id"]).toBeUndefined();
  });

  it("the signature verifies over the EXACT body string that was sent", async () => {
    await uploadRun(run());
    const headers = captured!.init.headers as Record<string, string>;
    const sentBody = captured!.init.body as string;

    // Rebuild the server's message: method, pathname, sha256hex(sentBody), ts, nonce.
    const path = new URL(captured!.url).pathname;
    expect(path).toBe("/runs");
    const bodyHash = createHash("sha256").update(sentBody).digest("hex");
    const message = Buffer.from(
      `POST\n${path}\n${bodyHash}\n${headers["X-Timestamp"]}\n${headers["X-Nonce"]}`,
    );
    const sig = Buffer.from(headers["X-Signature"], "base64");

    expect(sig.length).toBe(64);
    expect(cryptoVerify(null, message, signingPubKey, sig)).toBe(true);

    // The body on the wire is the serialized payload (hash == sent body, by
    // construction — share.ts stringifies once). Sanity-check it parses + carries
    // the device-prefixed externalId for a v2 run.
    const parsed = JSON.parse(sentBody) as { externalId: string };
    expect(parsed.externalId).toBe("device-uuid-fixed:sess-1:7");
  });
});
