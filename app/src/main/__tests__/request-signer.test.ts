import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHash,
  generateKeyPairSync,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

// request-signer.ts has NO electron import, but pin a stub anyway in case the
// module graph ever picks one up — keeps this test isolated from app state.
vi.mock("electron", () => ({ app: { isPackaged: false } }));

import { signRequest, _resetKeyForTest } from "../request-signer.js";

// ── Ephemeral signing keypair ───────────────────────────────────────────────────
// NO signing key is committed to the repo. We generate a throwaway Ed25519 pair at
// runtime, inject the PRIVATE half via the build constant the signer reads
// (__TBH_SIGNING_PRIVATE_KEY__, base64 PKCS8 DER), then verify the produced signature
// against the GENERATED PUBLIC half with crypto.verify(null, …) — exactly what the
// API's verifyRunSignature does. Each test gets a fresh pair in beforeEach.
let signingPubKey: KeyObject;

function injectPrivateKeyDerB64(): KeyObject {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privDerB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  // The signer reads the global build constant; set it then reset the cached key so
  // the next signRequest() re-parses. stubGlobal is auto-restored by unstubAllGlobals.
  vi.stubGlobal("__TBH_SIGNING_PRIVATE_KEY__", privDerB64);
  _resetKeyForTest();
  return publicKey;
}

/** Reproduce the API verifier's message reconstruction (signature.ts), so we test
 *  against the SERVER's exact view, not just against ourselves. */
function rebuildMessage(method: string, path: string, body: string, ts: string, nonce: string): Buffer {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return Buffer.from(`${method.toUpperCase()}\n${path}\n${bodyHash}\n${ts}\n${nonce}`);
}

beforeEach(() => {
  signingPubKey = injectPrivateKeyDerB64();
});

afterEach(() => {
  // Restore the injected global so no test leaks a signing key into the next one.
  vi.unstubAllGlobals();
  _resetKeyForTest();
});

describe("signRequest — verifies under the injected public key (matches the API verifier)", () => {
  it("produces a signature crypto.verify(null,…) accepts for the EXACT sent body", () => {
    const body = JSON.stringify({ externalId: "device:1", stageKey: 309, party: [] });
    const headers = signRequest("POST", "http://localhost:8787/runs", body) as Record<string, string>;

    // The server rebuilds the message from: the method, the pathname, sha256hex of
    // the body bytes IT received (= our `body`), and the echoed timestamp + nonce.
    const message = rebuildMessage(
      "POST",
      "/runs",
      body,
      headers["X-Timestamp"],
      headers["X-Nonce"],
    );
    const sig = Buffer.from(headers["X-Signature"], "base64");

    expect(sig.length).toBe(64); // Ed25519 signatures are 64 bytes
    expect(cryptoVerify(null, message, signingPubKey, sig)).toBe(true);
  });

  it("the hashed body == the exact string passed in (any other string fails to verify)", () => {
    const sent = JSON.stringify({ externalId: "device:7", stageKey: 101 });
    const headers = signRequest("POST", "https://api.tbherohelper.com/runs", sent) as Record<
      string,
      string
    >;

    // Verifying against the SENT body passes …
    const good = rebuildMessage("POST", "/runs", sent, headers["X-Timestamp"], headers["X-Nonce"]);
    expect(cryptoVerify(null, good, signingPubKey, Buffer.from(headers["X-Signature"], "base64"))).toBe(
      true,
    );

    // … but the SAME object re-serialized with even one different byte does NOT,
    // which is exactly why share.ts must serialize once and hash THAT string.
    const tampered = JSON.stringify({ externalId: "device:7", stageKey: 102 });
    const bad = rebuildMessage("POST", "/runs", tampered, headers["X-Timestamp"], headers["X-Nonce"]);
    expect(cryptoVerify(null, bad, signingPubKey, Buffer.from(headers["X-Signature"], "base64"))).toBe(
      false,
    );
  });

  it("hashes UTF-8 bytes (non-ASCII body still verifies)", () => {
    // Hero class names / session labels can carry non-ASCII; the API hashes UTF-8
    // bytes, so our Buffer.from(body,'utf8') must match for these too.
    const body = JSON.stringify({ note: "ünïcödé — café 日本語 ✓", externalId: "device:9" });
    const headers = signRequest("POST", "http://localhost:8787/runs", body) as Record<string, string>;
    const message = rebuildMessage("POST", "/runs", body, headers["X-Timestamp"], headers["X-Nonce"]);
    expect(
      cryptoVerify(null, message, signingPubKey, Buffer.from(headers["X-Signature"], "base64")),
    ).toBe(true);
  });

  it("signs the URL PATHNAME only — query/host are excluded (matches server view)", () => {
    const body = "{}";
    // A query string on the URL must NOT change the signed path; the server signs
    // new URL(c.req.url).pathname, which strips the query.
    const headers = signRequest("POST", "http://localhost:8787/runs?foo=bar&x=1", body) as Record<
      string,
      string
    >;
    const message = rebuildMessage("POST", "/runs", body, headers["X-Timestamp"], headers["X-Nonce"]);
    expect(
      cryptoVerify(null, message, signingPubKey, Buffer.from(headers["X-Signature"], "base64")),
    ).toBe(true);
  });

  it("upper-cases the method (a lowercase 'post' signs as 'POST')", () => {
    const body = "{}";
    const headers = signRequest("post", "http://localhost:8787/runs", body) as Record<string, string>;
    // Server reconstructs with c.req.method.toUpperCase() → "POST".
    const message = rebuildMessage("POST", "/runs", body, headers["X-Timestamp"], headers["X-Nonce"]);
    expect(
      cryptoVerify(null, message, signingPubKey, Buffer.from(headers["X-Signature"], "base64")),
    ).toBe(true);
  });

  it("emits exactly the three signature headers, fresh nonce + numeric ms timestamp per call", () => {
    const before = Date.now();
    const h1 = signRequest("POST", "http://localhost:8787/runs", "{}") as Record<string, string>;
    const after = Date.now();

    expect(Object.keys(h1).sort()).toEqual(["X-Nonce", "X-Signature", "X-Timestamp"]);

    const ts = Number(h1["X-Timestamp"]);
    expect(Number.isInteger(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    // nonce is a UUID
    expect(h1["X-Nonce"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const h2 = signRequest("POST", "http://localhost:8787/runs", "{}") as Record<string, string>;
    expect(h2["X-Nonce"]).not.toBe(h1["X-Nonce"]); // fresh nonce each request
  });
});

describe("signRequest — build-injected private key parsing (PEM + base64 DER)", () => {
  // The injected key proves the build constant (__TBH_SIGNING_PRIVATE_KEY__) is parsed
  // and used, and accepts BOTH PEM and base64 PKCS8 DER.

  it("uses a base64 PKCS8 DER build key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privDerB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
    vi.stubGlobal("__TBH_SIGNING_PRIVATE_KEY__", privDerB64);
    _resetKeyForTest();

    const body = "{}";
    const headers = signRequest("POST", "http://localhost:8787/runs", body) as Record<string, string>;
    const message = rebuildMessage("POST", "/runs", body, headers["X-Timestamp"], headers["X-Nonce"]);
    expect(
      cryptoVerify(null, message, publicKey, Buffer.from(headers["X-Signature"], "base64")),
    ).toBe(true);
  });

  it("uses a PEM build key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    vi.stubGlobal("__TBH_SIGNING_PRIVATE_KEY__", privPem);
    _resetKeyForTest();

    const body = '{"a":1}';
    const headers = signRequest("POST", "http://localhost:8787/runs", body) as Record<string, string>;
    const message = rebuildMessage("POST", "/runs", body, headers["X-Timestamp"], headers["X-Nonce"]);
    expect(
      cryptoVerify(null, message, publicKey, Buffer.from(headers["X-Signature"], "base64")),
    ).toBe(true);
  });
});

describe("signRequest — no key baked → no signature (unsigned, never throws)", () => {
  // No committed key: when the build constant is empty/undefined the signer emits NO
  // headers, so the caller's `...signRequest(...)` spread is a no-op and the request
  // goes out unsigned (correct — the API ignores signatures until REQUIRE_RUN_SIGNATURE).

  it("returns {} (no headers) when the build constant is the empty string", () => {
    vi.stubGlobal("__TBH_SIGNING_PRIVATE_KEY__", "");
    _resetKeyForTest();
    const headers = signRequest("POST", "http://localhost:8787/runs", "{}");
    expect(headers).toEqual({});
    expect(Object.keys(headers)).toHaveLength(0);
  });

  it("returns {} (no headers) when the build constant is undefined (vitest, no define)", () => {
    // stubGlobal(undefined) makes the bare identifier resolve to undefined, exercising
    // request-signer's `typeof __TBH_SIGNING_PRIVATE_KEY__ === "undefined"` guard.
    vi.stubGlobal("__TBH_SIGNING_PRIVATE_KEY__", undefined);
    _resetKeyForTest();
    const headers = signRequest("POST", "http://localhost:8787/runs", "{}");
    expect(headers).toEqual({});
  });

  it("does not throw when there is no key", () => {
    vi.stubGlobal("__TBH_SIGNING_PRIVATE_KEY__", "");
    _resetKeyForTest();
    expect(() => signRequest("POST", "http://localhost:8787/runs", "{}")).not.toThrow();
  });
});
