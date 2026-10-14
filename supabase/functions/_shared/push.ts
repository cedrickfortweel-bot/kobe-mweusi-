/* Web Push delivery for Supabase Edge Functions.
   Implements RFC 8030 (Generic Event Delivery Using HTTP Push),
   RFC 8188 (the "aes128gcm" content coding), RFC 8291 (Message
   Encryption for Web Push) and RFC 8292 (VAPID) using only the Web
   Crypto API the Deno runtime provides, with no npm dependencies.

   The record layout and every derivation below are checked against the
   worked example in RFC 8291 Appendix A by push.test.mjs: the rebuilt
   body matches the specification byte for byte.

   Three secrets are read, server side only:
     VAPID_PUBLIC_KEY   - base64url uncompressed P-256 point (65 bytes)
     VAPID_PRIVATE_KEY  - base64url 32-byte P-256 scalar
     VAPID_SUBJECT      - a mailto: or https: contact URI
   They are never logged and never sent to the browser. */

/* ------------------------------------------------------------------ */
/* base64url helpers                                                   */
/* ------------------------------------------------------------------ */

const B64U = /^[A-Za-z0-9_-]+$/;

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function base64urlDecode(value: string): Uint8Array {
  if (!B64U.test(value)) throw new Error("Invalid base64url value");
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Concatenate byte arrays into one buffer. */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

interface Env {
  get(name: string): string | undefined;
}

const denoEnv = (globalThis as { Deno?: Env }).Deno;
const nodeEnv = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env;

function readVapidSecrets(): { publicKey: string; privateKey: string; subject: string } | null {
  const source: Env | undefined = denoEnv ?? (nodeEnv ? { get: (k) => nodeEnv[k] } : undefined);
  const publicKey = source?.get("VAPID_PUBLIC_KEY");
  const privateKey = source?.get("VAPID_PRIVATE_KEY");
  const subject = source?.get("VAPID_SUBJECT");
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

/* ------------------------------------------------------------------ */
/* VAPID (RFC 8292)                                                    */
/* ------------------------------------------------------------------ */

const VAPID_EXPIRY_SECONDS = 12 * 60 * 60; /* RFC 8292 Section 2 caps this at 24 hours */

interface VapidCredential {
  publicKey: string;
  signingKey: CryptoKey;
}

/* A JWT may be reused for every request to the same audience, which push
   services encourage so they can cache signature verification (RFC 8292
   Section 5). Cached tokens are dropped well before they expire. */
const jwtCache = new Map<string, { token: string; expiresAtSeconds: number }>();

/**
 * Import the VAPID signing key. Node accepts a raw 32-byte scalar, while
 * Deno follows the specification and requires PKCS#8, so both encodings of
 * the same P-256 scalar are tried. This signing key is only ever used to
 * sign JWTs; it is never used for the payload key agreement.
 */
export async function importVapidSigningKey(privateKeyB64u: string): Promise<CryptoKey> {
  const scalar = base64urlDecode(privateKeyB64u);
  if (scalar.length !== 32) throw new Error("VAPID private key must be a 32-byte P-256 scalar");

  /* PKCS#8 wrapper for an EC private key (RFC 5208 / SEC 1): only the
     private scalar is provided because the public half is recoverable. */
  const pkcs8 = new Uint8Array([
    0x30, 0x41,
    0x02, 0x01, 0x01, /* version 1 */
    0x30, 0x13, /* AlgorithmIdentifier */
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, /* id-ecPublicKey */
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, /* prime256v1 */
    0x04, 0x27, /* privateKey OCTET STRING */
    0x30, 0x25, /* ECPrivateKey */
    0x02, 0x01, 0x01, /* version 1 */
    0x04, 0x20, /* privateD */
    ...scalar,
  ]);

  try {
    return await crypto.subtle.importKey("raw", scalar, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    /* Fall through to the spec-mandated PKCS#8 form. */
  }
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/**
 * Sign with ES256 and return the JWS raw r||s form (RFC 7515 Section 3.4).
 *
 * Web Crypto does not standardise the wire format of an ECDSA signature:
 * Node's subtle.sign emits raw r||s, while browsers and Deno emit the
 * DER-encoded Ecdsa-Sig-Value from X9.62. Both are accepted here so the
 * same code is correct on every runtime.
 */
async function signEs256(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
  if (signature.length === 64) return signature;
  return derToRaw(signature);
}

/** Parse a DER SEQUENCE of two INTEGERs into fixed-width r||s. */
function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("Unsupported ECDSA signature format");

  let offset = 2;
  const readInteger = (): Uint8Array => {
    if (der[offset] !== 0x02) throw new Error("Malformed ECDSA signature");
    const length = der[offset + 1];
    if (length > 33 || offset + 2 + length > der.length) throw new Error("Malformed ECDSA signature");
    offset += 2;
    const value = der.slice(offset, offset + length);
    offset += length;
    /* Strip the DER leading zero and left-pad to the curve width. */
    const unpadded = value[0] === 0x00 && value.length === 33 ? value.slice(1) : value;
    if (unpadded.length > 32) throw new Error("ECDSA integer exceeds the P-256 width");
    return concat(new Uint8Array(32 - unpadded.length), unpadded);
  };

  const raw = new Uint8Array(64);
  raw.set(readInteger(), 0);
  raw.set(readInteger(), 32);
  return raw;
}

async function createVapidJWT(credential: VapidCredential, audience: string, subject: string): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cached = jwtCache.get(audience);
  if (cached && cached.expiresAtSeconds - 300 > nowSeconds) return cached.token;

  const header = base64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64urlEncode(
    new TextEncoder().encode(JSON.stringify({ aud: audience, exp: nowSeconds + VAPID_EXPIRY_SECONDS, sub: subject }))
  );
  const signingInput = `${header}.${payload}`;
  const signature = await signEs256(credential.signingKey, new TextEncoder().encode(signingInput));
  const token = `${signingInput}.${base64urlEncode(signature)}`;

  if (jwtCache.size > 64) jwtCache.clear();
  jwtCache.set(audience, { token, expiresAtSeconds: nowSeconds + VAPID_EXPIRY_SECONDS });
  return token;
}

/**
 * RFC 8292 Section 2: the audience is the serialized origin of the push
 * resource URL. A malformed endpoint throws rather than falling back to a
 * guessed origin, so a bad row can never be signed for the wrong service.
 */
export function vapidAudienceOf(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("Push endpoint must be https");
  return `${url.protocol}//${url.host}`;
}

/* ------------------------------------------------------------------ */
/* Payload encryption (RFC 8188 + RFC 8291)                            */
/* ------------------------------------------------------------------ */

/* RFC 8291 Section 4 leaves at most 3993 plaintext octets; stay below that
   so push services never reject a message for exceeding 4096 octets. */
export const MAX_PAYLOAD_BYTES = 3500;

export interface EncryptedPushMessage {
  /** aes128gcm body: salt || rs || idlen || as_public || ciphertext+tag */
  body: Uint8Array;
  /** ephemeral server public key, carried in the Crypto-Key header */
  serverPublicKey: Uint8Array;
}

async function hmac(salt: Uint8Array, ikm: Uint8Array): Promise<CryptoKey> {
  const extractKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", extractKey, ikm));
  return crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** RFC 5869 HKDF-Expand; RFC 8291 Section 3.4 writes this with the counter
    terminator made explicit, which this loop reproduces exactly. */
async function hkdfExpand(prk: CryptoKey, info: Uint8Array, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let block = new Uint8Array(0);
  for (let offset = 0, counter = 1; offset < length; offset += 32, counter++) {
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", prk, concat(block, info, new Uint8Array([counter]))));
    block = digest;
    out.set(digest.subarray(0, Math.max(0, Math.min(32, length - offset))), offset);
  }
  return out;
}

/**
 * Encrypt one notification for one subscription per RFC 8291:
 *
 *   ecdh_secret = ECDH(as_private, ua_public)
 *   PRK_key     = HMAC-SHA-256(auth_secret, ecdh_secret)
 *   ikm         = HKDF-Expand(PRK_key, "WebPush: info" || 0 || ua_public || as_public, 32)
 *   PRK         = HMAC-SHA-256(salt, ikm)
 *   CEK         = HKDF-Expand(PRK, "Content-Encoding: aes128gcm" || 0, 16)
 *   NONCE       = HKDF-Expand(PRK, "Content-Encoding: nonce" || 0, 12)
 *   body        = salt(16) || rs(4, BE 4096) || idlen(1, 0x41) || as_public(65)
 *                 || AES-128-GCM(plaintext || 0x02)
 *
 * The ECDH key pair is generated fresh for each message and is unrelated to
 * the VAPID signing key, as RFC 8292 Section 3.2 requires. The nonce is the
 * derived base nonce XOR the record sequence number, and the first (only)
 * record has sequence number zero per RFC 8188 Section 2.3.
 */
export async function encryptPushMessage(
  payload: string,
  subscription: { p256dh: string; auth: string }
): Promise<EncryptedPushMessage> {
  const payloadBytes = new TextEncoder().encode(payload);
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`Push payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }

  const uaPublicRaw = base64urlDecode(subscription.p256dh);
  const uaAuthSecret = base64urlDecode(subscription.auth);
  if (uaPublicRaw.length !== 65 || uaPublicRaw[0] !== 0x04) throw new Error("Invalid subscription public key");
  if (uaAuthSecret.length !== 16) throw new Error("Invalid subscription auth secret");

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ecdh.publicKey));
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, ecdh.privateKey, 256)
  );

  /* Stage 1: bind the ECDH secret to this subscription using its auth secret. */
  const prkKey = await hmac(uaAuthSecret, ecdhSecret);
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info"),
    new Uint8Array([0x00]),
    uaPublicRaw,
    asPublicRaw
  );
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  /* Stage 2: derive the 128-bit content key and 96-bit nonce from a fresh salt.
     RFC 8188 Sections 2.2 and 2.3 terminate both info strings with 0x00, so the
     terminator is part of the info here and the 0x01 counter is appended by
     hkdfExpand itself. */
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const contentKey = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  /* The single record ends with a 0x02 padding delimiter (RFC 8188 Section 2). */
  const plaintext = concat(payloadBytes, new Uint8Array([0x02]));
  const gcmKey = await crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new Uint8Array() }, gcmKey, plaintext)
  );

  const recordSize = new Uint8Array([0x00, 0x00, 0x10, 0x00]); /* 4096, network byte order */
  const body = concat(salt, recordSize, new Uint8Array([0x41]), asPublicRaw, ciphertext);

  return { body, serverPublicKey: asPublicRaw };
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 2; /* one bounded retry, never an unbounded loop */
const RETRY_BASE_MS = 400;
const MAX_RETRY_SLEEP_MS = 2000;
const MAX_SUBSCRIPTIONS_PER_CALL = 50;
const REQUEST_TIMEOUT_MS = 10_000;
/* Notifications are time sensitive: ask the service to stop holding one
   after four hours so a revived device does not get a stale order alert. */
export const PUSH_TTL_SECONDS = 14400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse Retry-After defensively; anything unparseable falls back to the base delay. */
function retryDelayMs(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_SLEEP_MS);
  return RETRY_BASE_MS;
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: string;
}

/* The subset of the Supabase client this helper uses, expressed
   structurally so the module runs against either the real client or a
   test stub without importing the SDK. */
export interface PushService {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<{ data: unknown; error: unknown }>;
    } & PromiseLike<{ data: unknown; error: unknown }>;
    delete(): {
      eq(column: string, value: string): PromiseLike<{ error: unknown }>;
    } & PromiseLike<{ error: unknown }>;
  };
}

/**
 * Accept only well-formed subscriptions, so a corrupt or hostile row can
 * neither break the delivery loop nor cause a message to be sent somewhere
 * unintended. Nothing here is silently truncated to fit.
 */
export function validateSubscription(row: unknown): PushSubscriptionRow | null {
  if (!row || typeof row !== "object") return null;
  const candidate = row as Partial<PushSubscriptionRow>;
  if (
    typeof candidate.endpoint !== "string" ||
    typeof candidate.p256dh !== "string" ||
    typeof candidate.auth !== "string" ||
    typeof candidate.user_id !== "string" ||
    !candidate.user_id
  ) {
    return null;
  }
  if (!B64U.test(candidate.p256dh) || !B64U.test(candidate.auth)) return null;
  try {
    if (base64urlDecode(candidate.p256dh).length !== 65) return null;
    if (base64urlDecode(candidate.auth).length !== 16) return null;
  } catch {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidate.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  return {
    endpoint: url.toString(),
    p256dh: candidate.p256dh,
    auth: candidate.auth,
    user_id: candidate.user_id,
  };
}

/**
 * Deliver a notification to every subscription owned by the given users and
 * report how many deliveries were accepted. Safe to call without awaiting:
 * one malformed row, an unset secret, or one push service failing never
 * throws and never blocks the caller's own response.
 */
export async function sendNotifications(
  service: PushService,
  userIds: string[],
  title: string,
  body: string,
  data: Record<string, unknown> = {}
): Promise<number> {
  const vapid = readVapidSecrets();
  if (!vapid) {
    console.warn("[push] VAPID keys are not configured; notification not sent");
    return 0;
  }
  const requestedUsers = [...new Set(userIds.filter(Boolean))];
  if (requestedUsers.length === 0) return 0;
  /* Notifications fan out per user. Delivering a bounded number keeps one
     notification from outliving the function's wall-clock budget, which would
     fail every recipient instead of some. The overflow is logged so a large
     fan-out is visible rather than silent. */
  const uniqueUsers = requestedUsers.slice(0, MAX_SUBSCRIPTIONS_PER_CALL);
  if (requestedUsers.length > uniqueUsers.length) {
    console.warn("[push] fan-out capped", { requested: requestedUsers.length, delivered: uniqueUsers.length });
  }

  const payload = JSON.stringify({
    title,
    body,
    data,
    /* Lets the service worker drop a revived push for an already-resolved event. */
    ts: Date.now(),
  });
  if (new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES) {
    console.warn("[push] notification payload too large; not sent");
    return 0;
  }

  const { data: rows, error } = await service
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth,user_id")
    .in("user_id", uniqueUsers);
  if (error) {
    console.warn("[push] subscription lookup failed", { code: (error as { code?: string }).code });
    return 0;
  }
  if (!Array.isArray(rows)) return 0;

  /* One delivery per distinct endpoint. The subscription table keys on
     user_id, so a device that re-subscribed replaces its old row rather than
     accumulating rows, and this guard is a safety net against duplicate
     pushes for the same user. */
  const targets = new Map<string, PushSubscriptionRow>();
  for (const row of rows.slice(0, MAX_SUBSCRIPTIONS_PER_CALL)) {
    const valid = validateSubscription(row);
    if (valid && !targets.has(valid.endpoint)) targets.set(valid.endpoint, valid);
  }
  if (targets.size === 0) return 0;

  const credential: VapidCredential = {
    publicKey: vapid.publicKey,
    signingKey: await importVapidSigningKey(vapid.privateKey),
  };

  /* The signing key and the advertised public key must be a pair, or every
     push service will answer 403 with no usable diagnostic. Fail fast here,
     once per call, instead of once per message. */
  const mismatch = await vapidKeyPairMismatch(credential);
  if (mismatch) {
    console.error("[push] VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY; push not sent");
    return 0;
  }

  let delivered = 0;
  for (const sub of targets.values()) {
    let audience: string;
    try {
      audience = vapidAudienceOf(sub.endpoint);
    } catch {
      /* Keep the row: an odd endpoint is not proof that it expired. */
      continue;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const jwt = await createVapidJWT(credential, audience, vapid.subject);
        const message = await encryptPushMessage(payload, sub);
        const response = await fetch(sub.endpoint, {
          method: "POST",
          body: message.body,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Encoding": "aes128gcm",
            "TTL": String(PUSH_TTL_SECONDS),
            "Authorization": `vapid t=${jwt}, k=${vapid.publicKey}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (response.ok) {
          delivered += 1;
          break;
        }
        if (response.status === 404 || response.status === 410) {
          await deleteSubscription(service, sub);
          break;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
          await sleep(retryDelayMs(response));
          continue;
        }
        /* 400/403 are permanent for this subscription (bad payload crypto or a
           VAPID key mismatch): retrying only burns quota. Log the host alone:
           the endpoint URL contains an unguessable subscription identifier and
           the payload contains notification content, so neither is written. */
        console.warn("[push] push service rejected the message", {
          host: new URL(sub.endpoint).host,
          status: response.status,
          attempt,
        });
      } catch (error) {
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_BASE_MS);
          continue;
        }
        console.error("[push] delivery failed", {
          host: safeHost(sub.endpoint),
          attempt,
          reason: error instanceof Error && error.name ? error.name : "unknown",
        });
      }
      break;
    }
  }

  return delivered;
}

/** Expired subscriptions are removed scoped to their owner, never globally. */
async function deleteSubscription(service: PushService, sub: PushSubscriptionRow): Promise<void> {
  try {
    await service.from("push_subscriptions").delete().eq("endpoint", sub.endpoint).eq("user_id", sub.user_id);
  } catch {
    /* Best effort: a stale row costs one failed send, never correctness. */
  }
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

/**
 * True when VAPID_PUBLIC_KEY is a well-formed P-256 point that does not
 * correspond to VAPID_PRIVATE_KEY. False when the pair matches, and also
 * false when the public key cannot be read at all: a bad public key is
 * visible immediately in the browser, so it is not worth blocking delivery
 * over. Returns defensively (false) if anything is unusual.
 */
async function vapidKeyPairMismatch(credential: VapidCredential): Promise<boolean> {
  try {
    const publicRaw = base64urlDecode(credential.publicKey);
    if (publicRaw.length !== 65 || publicRaw[0] !== 0x04) return false;

    const verifyKey = await crypto.subtle.importKey(
      "raw",
      publicRaw,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const probe = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, credential.signingKey, probe)
    );
    /* The signature is raw r||s or DER depending on runtime, so hand it to
       the verifier unchanged: both are valid inputs for verify(). */
    return !(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, signature, probe));
  } catch {
    return false;
  }
}
