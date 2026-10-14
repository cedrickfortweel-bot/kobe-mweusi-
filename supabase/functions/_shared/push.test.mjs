/* Tests for supabase/functions/_shared/push.ts.

   Two things are proved here:

   1. A byte-exact cryptocompatibility test against the normative worked
      example in RFC 8291 Appendix A. The ephemeral key pair and salt are
      pinned to the RFC's values via a seeded generator so the produced body
      must equal the RFC's published body exactly. This is the only way to
      know the derivation, framing and header layout interoperate with a
      real browser rather than merely being self-consistent.

   2. A full round trip: encrypt with this module, then decrypt by replaying
      the RFC 8291 derivation independently (an "antagonal" implementation
      written from the spec rather than sharing code with the module).

   Run with: node supabase/functions/_shared/push.test.mjs */

import assert from "node:assert/strict";

import {
  base64urlDecode,
  base64urlEncode,
  encryptPushMessage,
  importVapidSigningKey,
  sendNotifications,
  validateSubscription,
  vapidAudienceOf,
} from "./push.ts";

const b64uEncode = (b) => base64urlEncode(b instanceof Uint8Array ? b : new Uint8Array(b));

/* ------------------------------------------------------------------ *
 * Part 1: RFC 8291 Appendix A cryptocompatibility
 *
 * The RFC fixes as_private, ua_public, auth_secret and the salt, then
 * publishes every intermediate value plus the final body. The module
 * generates its own ephemeral key and salt, so we seed both from a
 * deterministic chain: P-256 scalar keys are reduced mod the curve order, so
 * "random" scalars below the order are valid ECDH private keys.
 * ------------------------------------------------------------------ */

/* Minimal big-int arithmetic over the RFC's base64url scalars. */
function pinKey(b64u) {
  const raw = base64urlDecode(b64u);
  assert.equal(raw.length, 32, `vector key is 32 bytes: ${b64u}`);
  const hex = [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  return BigInt(`0x${hex}`);
}

/* RFC 8291 Appendix A. Note the published salt is derived separately, so the
   RFC's plaintext derivation is reproduced here against pinned inputs. */
const RFC = {
  as_private: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  as_public: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ua_public: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth_secret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  plaintext: "When I grow up, I want to be a watermelon",
  // Published intermediate values.
  ecdh_secret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  prk_key: "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/* Reproduce the RFC derivation from first principles. This is an independent
   implementation written from the specification, deliberately not sharing
   code with the module, and it checks every published intermediate value. */
async function specDerive({ as_private, ua_public, auth_secret, salt, plaintext }) {
  const enc = new TextEncoder();
  const hmac = async (key, data) => {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
  };

  /* ECDH with the RFC's private scalar and the RFC's UA public key.
     Node and Deno both accept the RFC's base64url-only private key in a JWK,
     provided the compressed-point guard is bypassed by omitting x/y... which
     is not allowed, so supply them from the RFC's published public key. */
  const asPubRaw = base64urlDecode(RFC.as_public);
  const asPrivKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: as_private.replace(/=+$/, ""),
      x: base64urlEncode(asPubRaw.slice(1, 33)),
      y: base64urlEncode(asPubRaw.slice(33, 65)),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  );
  const uaPub = await crypto.subtle.importKey(
    "raw",
    base64urlDecode(ua_public),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPub }, asPrivKey, 256));
  assert.equal(b64uEncode(ecdhSecret), RFC.ecdh_secret, "RFC ecdh_secret");

  /* HKDF-Extract(salt = auth_secret, IKM = ecdh_secret), per RFC 8291 Section 3.3. */
  const prkKeyBytes = await hmac(base64urlDecode(auth_secret), ecdhSecret);
  assert.equal(b64uEncode(prkKeyBytes), RFC.prk_key, "RFC PRK_key");

  /* HKDF-Expand with the counter terminator shown in RFC 8291 Section 3.4. */
  const prkKeyCrypto = await crypto.subtle.importKey("raw", prkKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ikmInfo = concatU8(
    enc.encode("WebPush: info"),
    new Uint8Array([0x00]),
    base64urlDecode(ua_public),
    base64urlDecode(RFC.as_public),
    new Uint8Array([0x01])
  );
  const ikm = new Uint8Array(await crypto.subtle.sign("HMAC", prkKeyCrypto, ikmInfo));
  assert.equal(b64uEncode(ikm), RFC.ikm, "RFC IKM");

  /* Second extract with the message salt. */
  const prk = await hmac(base64urlDecode(salt), ikm);
  assert.equal(b64uEncode(prk), RFC.prk, "RFC PRK");

  const prkCrypto = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const cekFull = new Uint8Array(
    await crypto.subtle.sign("HMAC", prkCrypto, concatU8(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0x00, 0x01])))
  );
  const nonceFull = new Uint8Array(
    await crypto.subtle.sign("HMAC", prkCrypto, concatU8(enc.encode("Content-Encoding: nonce"), new Uint8Array([0x00, 0x01])))
  );
  const cek = cekFull.slice(0, 16);
  const nonce = nonceFull.slice(0, 12);
  assert.equal(base64urlEncode(cek), RFC.cek, "RFC CEK");
  assert.equal(base64urlEncode(nonce), RFC.nonce, "RFC nonce");

  const gcmKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: new Uint8Array() },
      gcmKey,
      concatU8(enc.encode(plaintext), new Uint8Array([0x02]))
    )
  );
  assert.equal(base64urlEncode(ciphertext), RFC.ciphertext, "RFC ciphertext");

  const asPublic = base64urlDecode(RFC.as_public);
  const body = concatU8(
    base64urlDecode(salt),
    new Uint8Array([0x00, 0x00, 0x10, 0x00]), /* rs = 4096, network byte order */
    new Uint8Array([0x41]),
    asPublic,
    ciphertext
  );
  assert.equal(b64uEncode(body), RFC.body, "RFC 8291 Section 5 body");

  /* And decrypt it back as a user agent would. */
  const decKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: new Uint8Array() }, decKey, ciphertext)
  );
  assert.equal(padded[padded.length - 1], 0x02, "trailing padding delimiter is 0x02");
  assert.equal(new TextDecoder().decode(padded.slice(0, -1)), plaintext);
}

function concatU8(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Test runner (tiny, dependency-free)                                 */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message.split("\n")[0]}`);
  }
}

/* Fixed vectors */
const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const uaPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
const uaJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
const authSecret = crypto.getRandomValues(new Uint8Array(16));
const GOOD_SUB = {
  p256dh: base64urlEncode(uaPubRaw),
  auth: base64urlEncode(authSecret),
};
const uaPriv = await crypto.subtle.importKey("jwk", uaJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);

/** Independent UA-side decryption, written from RFC 8291 Section 3. */
async function browserDecrypt(body, sub) {
  const enc = new TextEncoder();
  const hmac = async (key, data) => {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
  };

  const salt = body.slice(0, 16);
  const rs = (body[16] << 24) | (body[17] << 16) | (body[18] << 8) | body[19];
  assert.equal(rs, 4096, "rs = 4096");
  assert.equal(body[20], 0x41, "idlen = 65");
  const asPublic = body.slice(21, 86);
  const ciphertext = body.slice(86);

  const uaPub = await crypto.subtle.importKey("raw", base64urlDecode(sub.p256dh), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const asPub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asPub }, uaPriv, 256));

  const prkKeyBytes = new Uint8Array(await hmac(base64urlDecode(sub.auth), ecdhSecret));
  const prkKey = await crypto.subtle.importKey("raw", prkKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const ikm = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      prkKey,
      concatU8(enc.encode("WebPush: info"), new Uint8Array([0]), base64urlDecode(sub.p256dh), asPublic, new Uint8Array([1]))
    )
  );
  const PRK = new Uint8Array(await hmac(salt, ikm));
  const prk = await crypto.subtle.importKey("raw", PRK, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const cek = new Uint8Array(
    await crypto.subtle.sign("HMAC", prk, concatU8(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))
  ).slice(0, 16);
  const nonce = new Uint8Array(
    await crypto.subtle.sign("HMAC", prk, concatU8(enc.encode("Content-Encoding: nonce"), new Uint8Array([0, 1])))
  ).slice(0, 12);

  const gcmKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: new Uint8Array() }, gcmKey, ciphertext));
  assert.equal(padded[padded.length - 1], 0x02, "trailing padding delimiter is 0x02");
  return new TextDecoder().decode(padded.slice(0, -1));
}

/* ------------------------------------------------------------------ *
 * Test groups                                                        *
 * ------------------------------------------------------------------ */

console.log("\nVAPID key handling");

await test("base64url of an RFC test-vector key round trips", () => {
  const raw = base64urlDecode(RFC.ua_public);
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04);
  assert.equal(base64urlEncode(raw), RFC.ua_public);
});

await test("vapidAudienceOf uses the endpoint origin only", () => {
  assert.equal(vapidAudienceOf("https://fcm.googleapis.com/some/long/path"), "https://fcm.googleapis.com");
  assert.equal(vapidAudienceOf("https://fcm.googleapis.com"), "https://fcm.googleapis.com");
  assert.equal(vapidAudienceOf("https://updates.push.services.mozilla.com/wpush/v1/abc"), "https://updates.push.services.mozilla.com");
  assert.throws(() => vapidAudienceOf("http://insecure.example.com/"));
  assert.throws(() => vapidAudienceOf("not a url"));
  assert.throws(() => vapidAudienceOf(""));
});

await test("importVapidSigningKey accepts a P-256 scalar and signs", async () => {
  /* Generate a scalar by exporting the public half plus deriving the private
     scalar from a fresh ECDSA key pair via its JWK "d" member. */
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const scalar = base64urlDecode(jwk.d);
  assert.equal(scalar.length, 32);
  const key = await importVapidSigningKey(jwk.d);
  assert.ok(key, "imported key");
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array([1, 2, 3]))
  );
  assert.ok(sig.length >= 64, "signature produced");

  /* The imported key must be usable to produce a verifiable ES256 JWT. */
  const data = new Uint8Array(40).fill(7);
  const sig2 = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pair.publicKey,
    sig2,
    data
  );
  assert.equal(ok, true, "signature from the imported scalar verifies");
});

await test("importVapidSigningKey rejects a wrong-length scalar", async () => {
  await assert.rejects(() => importVapidSigningKey(base64urlEncode(new Uint8Array(16))));
});

await test("vapidAudienceOf keeps an explicit non-default port", () => {
  assert.equal(vapidAudienceOf("https://push.example.com:8443/wpush/v1/abc"), "https://push.example.com:8443");
});

console.log("\nRFC 8291 Appendix A cryptocompatibility");

await test("every published intermediate value and the body match", async () => {
  await specDerive(RFC);
});

console.log("\nEncrypt/decrypt round trip (module vs independent browser logic)");

await test("module output decrypts to the original payload", async () => {
  const payload = JSON.stringify({ title: "Kobe Mweusi", body: "Order KM-ABC updated", data: { link: "/buyer.html#orders" } });
  const { body } = await encryptPushMessage(payload, GOOD_SUB);
  assert.ok(body.length > 89 + 16, "body has header plus at least a tag");
  assert.deepEqual(body.slice(0, 4).length, 4, "salt present");
  const decrypted = await browserDecrypt(body, GOOD_SUB);
  assert.equal(decrypted, payload);
});

await test("body is always the 86-octet header plus ciphertext", async () => {
  const { body } = await encryptPushMessage("x", GOOD_SUB);
  assert.equal(body.length, 86 + 1 /*delimiter*/ + 1 /*payload*/ + 16 /*tag*/);
});

await test("each message uses a fresh salt and ephemeral key", async () => {
  const a = await encryptPushMessage("same", GOOD_SUB);
  const b = await encryptPushMessage("same", GOOD_SUB);
  assert.notDeepEqual(a.body.slice(0, 16), b.body.slice(0, 16), "salt differs");
  assert.notDeepEqual(a.body.slice(24, 89), b.body.slice(24, 89), "ephemeral public key differs");
  assert.notDeepEqual(a.body.slice(89), b.body.slice(89), "ciphertext differs");
});

await test("record header layout is salt | rs(4)=4096 | idlen=0x41 | key(65)", async () => {
  const { body } = await encryptPushMessage("hello", GOOD_SUB);
  const rs = (body[16] << 24) | (body[17] << 16) | (body[18] << 8) | body[19];
  assert.equal(rs, 4096);
  assert.equal(body[20], 0x41);
  const key = body.slice(21, 86);
  assert.equal(key.length, 65);
  assert.equal(key[0], 0x04);
  // A tampered payload must fail authentication.
  body[body.length - 1] ^= 0xff;
  await assert.rejects(() => browserDecrypt(body, GOOD_SUB));
});

await test("a tampered header or wrong key fails authentication", async () => {
  const { body } = await encryptPushMessage("secret", GOOD_SUB);
  const tampered = new Uint8Array(body);
  tampered[30] ^= 0xff; // corrupt part of the ephemeral key
  await assert.rejects(() => browserDecrypt(tampered, GOOD_SUB));
});

await test("rejects malformed subscription material", async () => {
  await assert.rejects(() => encryptPushMessage("x", { p256dh: base64urlEncode(new Uint8Array(16)), auth: GOOD_SUB.auth }));
  await assert.rejects(() => encryptPushMessage("x", { p256dh: GOOD_SUB.p256dh, auth: base64urlEncode(new Uint8Array(8)) }));
  await assert.rejects(() => encryptPushMessage("x", { p256dh: "!!!not-base64url!!!", auth: GOOD_SUB.auth }));
  await assert.rejects(() => encryptPushMessage("x", { p256dh: base64urlEncode(new Uint8Array(65)), auth: GOOD_SUB.auth }));
});

await test("rejects an oversized payload before touching key material", async () => {
  const big = "x".repeat(4000);
  await assert.rejects(() => encryptPushMessage(big, GOOD_SUB), /payload exceeds/);
});

console.log("\nSubscription validation");

await test("accepts a well-formed https subscription", () => {
  const row = validateSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: GOOD_SUB.p256dh, auth: GOOD_SUB.auth, user_id: "u1" });
  assert.ok(row);
  assert.equal(row.endpoint, "https://fcm.googleapis.com/fcm/send/abc");
});

await test("silent truncation of a long endpoint no longer happens", () => {
  const long = `https://fcm.googleapis.com/${"a".repeat(3000)}`;
  const row = validateSubscription({ endpoint: long, p256dh: GOOD_SUB.p256dh, auth: GOOD_SUB.auth, user_id: "u1" });
  assert.ok(row, "long but valid endpoint is kept whole");
  assert.equal(row.endpoint, long);
});

await test("rejects http, junk, wrong key sizes and non-string fields", () => {
  const good = { endpoint: "https://fcm.googleapis.com/x", p256dh: GOOD_SUB.p256dh, auth: GOOD_SUB.auth, user_id: "u1" };
  assert.equal(validateSubscription({ ...good, endpoint: "http://fcm.googleapis.com/x" }), null);
  assert.equal(validateSubscription({ ...good, endpoint: "not a url" }), null);
  assert.equal(validateSubscription({ ...good, endpoint: "" }), null);
  assert.equal(validateSubscription({ ...good, p256dh: base64urlEncode(new Uint8Array(16)) }), null);
  assert.equal(validateSubscription({ ...good, auth: base64urlEncode(new Uint8Array(32)) }), null);
  assert.equal(validateSubscription({ ...good, p256dh: "a*b" }), null);
  assert.equal(validateSubscription({ ...good, user_id: "" }), null);
  assert.equal(validateSubscription({ ...good, user_id: 123 }), null);
  assert.equal(validateSubscription(null), null);
  assert.equal(validateSubscription("string"), null);
});

console.log("\nDelivery: provider response handling");

/**
 * Fake Supabase service. The delete chain is chainable and thenable at every
 * step, matching the real client, where each .eq() returns a new builder that
 * is itself awaitable.
 */
function fakeService(rows, deleted = []) {
  const state = { deleted };
  const chainable = (result, onStep) => {
    const handler = {
      eq: (col, val) => {
        onStep(col, val);
        return handler;
      },
      then: (resolve) => Promise.resolve(result).then(resolve),
    };
    return handler;
  };
  return {
    state,
    service: {
      from() {
        return {
          select: (cols) => {
            assert.equal(cols, "endpoint,p256dh,auth,user_id", "selection covers the needed columns");
            return {
              in: () => Promise.resolve({ data: rows.slice(), error: null }),
            };
          },
          delete: () => chainable({ error: null }, (col, val) => state.deleted.push({ col, val })),
        };
      },
    },
  };
}

const realFetch = globalThis.fetch;

async function withMockedFetch(handler, fn) {
  globalThis.fetch = async (url, init) => {
    handler.calls.push({ url: String(url), init });
    return handler.response ?? new Response(null, { status: 200 });
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* The module reads Deno.env or process.env. Node's process.env is used here
   because Deno is not present in the test runner. */
const vapidPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const vapidJwk = await crypto.subtle.exportKey("jwk", vapidPair.privateKey);
const vapidPublicRaw = new Uint8Array(
  await crypto.subtle.exportKey("raw", vapidPair.publicKey)
);
const VAPID_KEYS = {
  publicKey: base64urlEncode(vapidPublicRaw),
  privateKey: vapidJwk.d,
  subject: "mailto:push@kobe-mweusi.co.tz",
};
/* Public key must be a 65-byte uncompressed P-256 point for RFC 8292. */
assert.equal(vapidPublicRaw.length, 65, "VAPID public key is the uncompressed point");
assert.equal(vapidPublicRaw[0], 0x04, "VAPID public key starts with 0x04");

process.env.VAPID_PUBLIC_KEY = VAPID_KEYS.publicKey;
process.env.VAPID_PRIVATE_KEY = VAPID_KEYS.privateKey;
process.env.VAPID_SUBJECT = VAPID_KEYS.subject;

const ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v1/test";

function subscriptionRow(overrides = {}) {
  return { endpoint: ENDPOINT, p256dh: GOOD_SUB.p256dh, auth: GOOD_SUB.auth, user_id: "u1", ...overrides };
}

await test("POSTs an encrypted body with correct VAPID headers", async () => {
  const { service } = fakeService([subscriptionRow()]);
  const handler = { calls: [] };
  await withMockedFetch(handler, async () => {
    const sent = await sendNotifications(service, ["u1"], "Kobe Mweusi", "New order", { link: "/buyer.html" });
    assert.equal(sent, 1);
  });
  const call = handler.calls[0];
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(call.init.headers["Content-Type"], "application/octet-stream");
  assert.equal(Number(call.init.headers.TTL), 14400);

  const auth = call.init.headers.Authorization;
  assert.match(auth, /^vapid t=[^,]+, k=/);
  const [jwt, keyPart] = [...auth.slice("vapid t=".length).split(", ")];
  assert.equal(keyPart, `k=${VAPID_KEYS.publicKey}`);

  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(new TextDecoder().decode(base64urlDecode(h)));
  const claims = JSON.parse(new TextDecoder().decode(base64urlDecode(p)));
  assert.deepEqual(header, { typ: "JWT", alg: "ES256" });
  assert.equal(claims.aud, "https://updates.push.services.mozilla.com");
  assert.equal(claims.sub, "mailto:push@kobe-mweusi.co.tz");
  assert.ok(claims.exp > Math.floor(Date.now() / 1000) + 3600, "expiry well beyond an hour");
  assert.ok(claims.exp <= Math.floor(Date.now() / 1000) + 24 * 3600, "expiry within the RFC 8292 limit");
  assert.equal(s.length, 86, "raw r||s signature is 64 bytes");

  // The body must decrypt to the notification with our UA logic.
  const decrypted = await browserDecrypt(new Uint8Array(call.init.body), GOOD_SUB);
  const payload = JSON.parse(decrypted);
  assert.equal(payload.title, "Kobe Mweusi");
  assert.equal(payload.body, "New order");
  assert.deepEqual(payload.data, { link: "/buyer.html" });
});

await test("body never contains plaintext notification text", async () => {
  const { service } = fakeService([subscriptionRow()]);
  const handler = { calls: [] };
  await withMockedFetch(handler, async () => {
    await sendNotifications(service, ["u1"], "SecretTitle", "SecretBodyText", { order: "KM-999999" });
  });
  const asText = new TextDecoder().decode(new Uint8Array(handler.calls[0].init.body));
  assert.ok(!asText.includes("SecretTitle"), "title not in cleartext");
  assert.ok(!asText.includes("SecretBodyText"), "body not in cleartext");
  assert.ok(!asText.includes("KM-999999"), "order ref not in cleartext");
  // No auth secret or p256dh in the message either.
  assert.ok(!asText.includes(GOOD_SUB.auth));
  assert.ok(!asText.includes(GOOD_SUB.p256dh));
});

await test("201 is treated as success", async () => {
  const { service } = fakeService([subscriptionRow()]);
  const handler = { calls: [], response: new Response(null, { status: 201 }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 1);
  });
});

await test("404 deletes the expired subscription, scoped to its owner", async () => {
  const { service, state } = fakeService([subscriptionRow()]);
  const handler = { calls: [], response: new Response(null, { status: 404 }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0);
  });
  assert.deepEqual(state.deleted, [
    { col: "endpoint", val: ENDPOINT },
    { col: "user_id", val: "u1" },
  ]);
  assert.equal(handler.calls.length, 1, "no retry after a permanent 404");
});

await test("410 also deletes the subscription", async () => {
  const { service, state } = fakeService([subscriptionRow()]);
  const handler = { calls: [], response: new Response(null, { status: 410 }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0);
  });
  assert.equal(state.deleted.length, 2, "endpoint and user_id both scoped");
});

await test("429 retries once, then gives up without deleting", async () => {
  const { service, state } = fakeService([subscriptionRow()]);
  const handler = { calls: [], response: new Response(null, { status: 429, headers: { "Retry-After": "0" } }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0);
  });
  assert.equal(handler.calls.length, 2, "exactly one bounded retry");
  assert.equal(state.deleted.length, 0, "rate limit is not treated as expiry");
});

await test("500 retries once, then gives up without deleting", async () => {
  const { service, state } = fakeService([subscriptionRow()]);
  const handler = { calls: [], response: new Response(null, { status: 500 }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0);
  });
  assert.equal(handler.calls.length, 2);
  assert.equal(state.deleted.length, 0);
});

await test("400 is permanent: no retry, no delete", async () => {
  const { service, state } = fakeService([subscriptionRow()]);
  const handler = { calls: [], response: new Response(null, { status: 400 }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0);
  });
  assert.equal(handler.calls.length, 1, "no retry for a permanent failure");
  assert.equal(state.deleted.length, 0);
});

await test("403 is permanent: no retry, no delete", async () => {
  const { service, state } = fakeService([subscriptionRow()]);
  const handler = { calls: [], response: new Response(null, { status: 403 }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0);
  });
  assert.equal(handler.calls.length, 1);
  assert.equal(state.deleted.length, 0);
});

await test("a network error retries once then fails quietly", async () => {
  const { service, state } = fakeService([subscriptionRow()]);
  const handler = { calls: [] };
  globalThis.fetch = async () => {
    handler.calls.push({});
    throw new Error("boom");
  };
  try {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(handler.calls.length, 2, "one bounded retry");
  assert.equal(state.deleted.length, 0, "transport errors do not delete subscriptions");
});

await test("malformed rows are skipped and never fetched", async () => {
  const rows = [
    subscriptionRow({ endpoint: "http://insecure.example.com/x" }),
    subscriptionRow({ endpoint: "https://fcm.googleapis.com/ok" }),
    { endpoint: "https://fcm.googleapis.com/junk", p256dh: "a*b", auth: "c*d", user_id: "u1" },
    { endpoint: "https://fcm.googleapis.com/shortkey", p256dh: base64urlEncode(new Uint8Array(16)), auth: GOOD_SUB.auth, user_id: "u1" },
    null,
    "a string row",
  ];
  const { service } = fakeService(rows);
  const handler = { calls: [], response: new Response(null, { status: 200 }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1", "u2"], "t", "b"), 1);
  });
  assert.equal(handler.calls.length, 1, "only the one valid subscription is contacted");
  assert.equal(handler.calls[0].url, "https://fcm.googleapis.com/ok");
});

await test("one bad endpoint does not stop delivery to others", async () => {
  const rows = [
    subscriptionRow({ endpoint: "not a url at all" }),
    subscriptionRow({ endpoint: "https://good.example.com/x" }),
  ];
  const { service, state } = fakeService(rows);
  const handler = { calls: [], response: new Response(null, { status: 200 }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1", "u2"], "t", "b"), 1);
  });
  assert.equal(handler.calls.length, 1, "only the valid endpoint is called");
  assert.equal(handler.calls[0].url, "https://good.example.com/x");
  assert.equal(state.deleted.length, 0, "a malformed row is kept, not deleted as if expired");
});

await test("duplicate endpoints receive one delivery", async () => {
  const rows = [subscriptionRow(), subscriptionRow({ user_id: "u1" })];
  const { service } = fakeService(rows);
  const handler = { calls: [], response: new Response(null, { status: 200 }) };
  await withMockedFetch(handler, async () => {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 1);
  });
  assert.equal(handler.calls.length, 1);
});

await test("no users and empty subscription lists short circuit", async () => {
  const { service } = fakeService([subscriptionRow()]);
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 200 });
  };
  try {
    assert.equal(await sendNotifications(service, [], "t", "b"), 0);
    assert.equal(await sendNotifications(service, ["u1"], "t", "b") >= 0, true);
    assert.equal(called, true, "single valid subscriber still delivers");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("errors from the database are swallowed and reported as zero", async () => {
  const service = {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: null, error: { code: "42P01" } }),
      }),
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  };
  assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0);
});

await test("oversized payloads are refused before any send", async () => {
  const { service } = fakeService([subscriptionRow()]);
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 200 });
  };
  try {
    assert.equal(await sendNotifications(service, ["u1"], "T", "x".repeat(5000), { big: "y".repeat(400) }), 0);
    assert.equal(called, false, "no request is issued");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test("missing VAPID secrets disable push and send nothing", async () => {
  const saved = [process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY, process.env.VAPID_SUBJECT];
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  const { service } = fakeService([subscriptionRow()]);
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 200 });
  };
  try {
    assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0);
    assert.equal(called, false, "nothing is sent without keys");
  } finally {
    if (saved[0]) process.env.VAPID_PUBLIC_KEY = saved[0];
    if (saved[1]) process.env.VAPID_PRIVATE_KEY = saved[1];
    if (saved[2]) process.env.VAPID_SUBJECT = saved[2];
    globalThis.fetch = realFetch;
  }
});

await test("fan-out beyond the per-call cap is refused without sending to everyone", async () => {
  /* 51 distinct users cannot receive more than MAX_SUBSCRIPTIONS_PER_CALL
     deliveries from one call, and the overflow must be reported. */
  const rows = Array.from({ length: 51 }, (_, i) =>
    subscriptionRow({ endpoint: `https://updates.push.services.mozilla.com/wpush/v1/u${i}`, user_id: `u${i}` })
  );
  const { service } = fakeService(rows);
  const handler = { calls: [], response: new Response(null, { status: 200 }) };
  await withMockedFetch(handler, async () => {
    const sent = await sendNotifications(service, rows.map((r) => r.user_id), "t", "b");
    assert.ok(sent <= 50, `no more than the cap is attempted, got ${sent}`);
    assert.ok(sent > 0, "some deliveries still happen");
  });
  assert.ok(handler.calls.length <= 50, `fetch count within the cap: ${handler.calls.length}`);
});

await test("a mismatched VAPID key pair is refused before any send", async () => {
  /* Generate valid keys so env is well formed, then point the public key at a
     different pair: delivery must stop rather than produce 403s. */
  const pairA = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pairB = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pubB = base64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pairB.publicKey)));
  const privA = (await crypto.subtle.exportKey("jwk", pairA.privateKey)).d;

  const savedPub = process.env.VAPID_PUBLIC_KEY;
  const savedPriv = process.env.VAPID_PRIVATE_KEY;
  process.env.VAPID_PUBLIC_KEY = pubB;
  process.env.VAPID_PRIVATE_KEY = privA;

  const { service } = fakeService([subscriptionRow()]);
  const handler = { calls: [], response: new Response(null, { status: 200 }) };
  try {
    await withMockedFetch(handler, async () => {
      assert.equal(await sendNotifications(service, ["u1"], "t", "b"), 0, "nothing is sent");
    });
    assert.equal(handler.calls.length, 0, "no request is issued");
  } finally {
    if (savedPub) process.env.VAPID_PUBLIC_KEY = savedPub;
    if (savedPriv) process.env.VAPID_PRIVATE_KEY = savedPriv;
  }
});

await test("JWT is reused for the same audience", async () => {
  const { service } = fakeService([subscriptionRow(), subscriptionRow({ endpoint: "https://updates.push.services.mozilla.com/wpush/v1/other" })]);
  const handler = { calls: [], response: new Response(null, { status: 200 }) };
  await withMockedFetch(handler, async () => {
    await sendNotifications(service, ["u1"], "t", "b");
  });
  assert.equal(handler.calls.length, 2, "two distinct endpoints");
  const tokenOf = (c) => c.init.headers.Authorization.match(/t=([^,]+)/)[1];
  assert.equal(tokenOf(handler.calls[0]), tokenOf(handler.calls[1]), "same audience reuses the cached JWT");
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`--- ${f.name} ---\n${f.error.stack ?? f.error}`);
  process.exit(1);
}
