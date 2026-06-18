import { createHash, createPrivateKey, randomUUID, sign as cryptoSign } from "node:crypto";
import type { KeyObject } from "node:crypto";

// --------------------------------------------------------------------------- //
// Ed25519 request signing for POST /runs (the run ingest path). The API verifier is
// api/src/middleware/signature.ts — that file is the source of truth and this
// module MUST produce a signature it accepts byte-for-byte.
//
// Signed message format (exact, byte-for-byte — matches signature.ts):
//   `${METHOD}\n${path}\n${sha256hex(rawBody)}\n${timestamp}\n${nonce}`
//     METHOD     — upper-case HTTP method (e.g. "POST")
//     path       — URL pathname only, no query/host (new URL(url).pathname → "/runs").
//                  This MUST equal the server's `new URL(c.req.url).pathname`.
//     sha256hex  — lowercase hex SHA-256 of the EXACT raw body bytes sent (UTF-8)
//     timestamp  — Date.now() as a string
//     nonce      — fresh random per request (randomUUID())
//
// Emitted headers:
//   X-Signature — base64 of the 64-byte Ed25519 signature over the message
//   X-Timestamp — the timestamp string
//   X-Nonce     — the nonce string
//
// CRITICAL invariant (hash == sent body): the caller serializes the body to a
// string ONCE and passes that SAME string both to signRequest() (hashed here) and
// as the fetch() body. Never JSON.stringify twice — a re-serialization can reorder
// keys or differ in whitespace and the hash would no longer match the bytes on the
// wire, so every signed request would 401. See share.ts.
//
// Signing is ALWAYS-ON when a key is present: the API ignores these headers until
// REQUIRE_RUN_SIGNATURE flips on its side, and the extra headers are harmless until then.
//
// NO signing key is committed to this repo. The production Ed25519 private key arrives
// only at build time via the TBH_SIGNING_PRIVATE_KEY build secret, injected by
// electron.vite's `define` into __TBH_SIGNING_PRIVATE_KEY__ (see env.d.ts). When no key
// is baked (dev runs + vitest, where __TBH_SIGNING_PRIVATE_KEY__ is empty/undefined) the
// signer emits NO signature headers — uploads go out unsigned, which is correct: the API
// ignores signatures until REQUIRE_RUN_SIGNATURE is enabled. To verify dev-signed uploads
// against a local API, generate your own dev keypair (api/.env.example documents the
// command) and set TBH_SIGNING_PRIVATE_KEY locally.
// --------------------------------------------------------------------------- //

/**
 * The build-baked private key, or "" when not provided. Read through a `typeof`
 * guard because under vitest there is no electron.vite `define`, so the bare
 * identifier is undefined (same pattern as variant.ts).
 */
function bakedPrivateKey(): string {
  return typeof __TBH_SIGNING_PRIVATE_KEY__ === "undefined" ? "" : __TBH_SIGNING_PRIVATE_KEY__;
}

/**
 * Parse a private key string which may be either:
 *   - base64 PKCS8 DER (a raw base64 blob, no PEM header), or
 *   - PEM (begins with "-----BEGIN ... PRIVATE KEY-----").
 * Mirrors the API verifier's parsePublicKey() so the same source values work on
 * both sides. Throws on parse failure so a misconfigured build key fails loudly
 * the first time we sign rather than silently emitting garbage.
 */
function parsePrivateKey(raw: string): KeyObject {
  const trimmed = raw.trim();
  if (trimmed.startsWith("-----")) {
    return createPrivateKey({ key: trimmed, format: "pem" });
  }
  const der = Buffer.from(trimmed, "base64");
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/**
 * Lazily parsed private key, or null when none is baked. The two sentinels are
 * distinct: `undefined` = not yet resolved (parse on first signRequest()), `null` =
 * resolved-to-no-key (dev/test build without the TBH_SIGNING_PRIVATE_KEY secret).
 */
let _key: KeyObject | null | undefined = undefined;

/** The parsed build-baked private key, or null when no key is baked (dev/test). */
function getKey(): KeyObject | null {
  if (_key !== undefined) return _key;
  const baked = bakedPrivateKey().trim();
  _key = baked ? parsePrivateKey(baked) : null;
  return _key;
}

/** The exact headers the API's verifyRunSignature middleware expects. */
export interface SignatureHeaders {
  "X-Signature": string;
  "X-Timestamp": string;
  "X-Nonce": string;
}

/**
 * Sign one request and return the signature headers to merge into fetch()'s
 * headers. `rawBodyString` MUST be the exact string passed as the fetch body
 * (the hash is computed over its UTF-8 bytes — identical to the API verifier,
 * which hashes the raw body bytes it receives).
 *
 * When no signing key is baked (dev/test, no TBH_SIGNING_PRIVATE_KEY) this returns
 * an empty object so the caller's `...signRequest(...)` spread adds NO headers and
 * the request goes out unsigned. It never throws — the API ignores signatures until
 * REQUIRE_RUN_SIGNATURE flips, so unsigned dev/test uploads are correct.
 */
export function signRequest(
  method: string,
  url: string,
  rawBodyString: string,
): SignatureHeaders | Record<string, never> {
  const key = getKey();
  if (key === null) return {};

  const upperMethod = method.toUpperCase();
  const path = new URL(url).pathname;
  // Hash the EXACT bytes that go on the wire (UTF-8). The API does
  // createHash("sha256").update(rawBody) over the body string it reads, which is
  // UTF-8; Buffer.from(str, "utf8") makes our input byte-identical for any payload
  // (incl. non-ASCII class names / session labels).
  const bodyHash = createHash("sha256").update(Buffer.from(rawBodyString, "utf8")).digest("hex");

  const timestamp = String(Date.now());
  const nonce = randomUUID();

  const message = Buffer.from(`${upperMethod}\n${path}\n${bodyHash}\n${timestamp}\n${nonce}`);
  const signature = cryptoSign(null, message, key).toString("base64");

  return {
    "X-Signature": signature,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
  };
}

/**
 * Reset the cached parsed key to the unresolved state. Exported ONLY for tests (so
 * a test can flip __TBH_SIGNING_PRIVATE_KEY__ and force a re-parse on the next
 * signRequest()). Never call this in production code.
 */
export function _resetKeyForTest(): void {
  _key = undefined;
}
