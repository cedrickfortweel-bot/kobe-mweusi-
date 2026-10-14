import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient } from "../_shared/auth.ts";

/* Web push subscription management and VAPID key handoff.

   The VAPID public key is public information and safe to ship to browsers.
   Subscriptions live in push_subscriptions, keyed on user_id, with full RLS.
   Delivery itself happens from the _shared/push.ts helper inside the
   notifying function; nothing in this file sends a push. */

/* Bounds are generous but finite, matching realistic Push API values:
   endpoints are long opaque URLs and the two key material fields are fixed
   size once base64url-decoded. Anything longer is rejected, never truncated,
   so a corrupted row can never be silently "fixed" into a wrong one. */
const MAX_ENDPOINT_CHARS = 2000;
const MAX_P256DH_CHARS = 100;
const MAX_AUTH_CHARS = 100;

interface PushSubscriptionBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

function base64urlChars(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/** Decode a base64url field, rejecting padding, whitespace and wrong lengths. */
function decodeFixedBase64(
  value: string,
  expectedBytes: number,
  expectedFirstByte: number | null,
  field: string
): void {
  if (!base64urlChars(value)) throw new ApiError(400, `Push ${field} is not valid base64url`);
  if (value.length > expectedBytes + 8) throw new ApiError(400, `Push ${field} is too long`);
  let padded = value.replace(/-/g, "+").replace(/_/g, "/");
  padded += "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== expectedBytes) {
    throw new ApiError(400, `Push ${field} has the wrong length`);
  }
  if (expectedFirstByte !== null && bytes[0] !== expectedFirstByte) {
    throw new ApiError(400, `Push ${field} is not an uncompressed P-256 key`);
  }
}

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "config");

  try {
    if (action === "config") {
      const publicKey = Deno.env.get("VAPID_PUBLIC_KEY") || "";
      return json({ ok: true, vapidPublicKey: publicKey, enabled: !!publicKey });
    }

    if (action === "subscribe") {
      const sub = body.subscription as PushSubscriptionBody | undefined;
      if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
        throw new ApiError(400, "Invalid push subscription");
      }
      if (typeof sub.endpoint !== "string" || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") {
        throw new ApiError(400, "Invalid push subscription");
      }
      if (sub.endpoint.length > MAX_ENDPOINT_CHARS) {
        throw new ApiError(400, "Push endpoint is too long");
      }
      let endpointUrl: URL;
      try {
        endpointUrl = new URL(sub.endpoint);
      } catch {
        throw new ApiError(400, "Push endpoint is not a valid URL");
      }
      if (endpointUrl.protocol !== "https:") throw new ApiError(400, "Push endpoint must be https");
      if (sub.keys.p256dh.length > MAX_P256DH_CHARS || sub.keys.auth.length > MAX_AUTH_CHARS) {
        throw new ApiError(400, "Push key material is too long");
      }
      decodeFixedBase64(sub.keys.p256dh, 65, 0x04, "public key");
      decodeFixedBase64(sub.keys.auth, 16, null, "auth secret");

      const { error } = await service.from("push_subscriptions").upsert({
        user_id: auth.user.id,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "unsubscribe") {
      const endpoint = body.endpoint;
      if (typeof endpoint !== "string" || !endpoint) throw new ApiError(400, "Missing endpoint");
      if (endpoint.length > MAX_ENDPOINT_CHARS) throw new ApiError(400, "Push endpoint is too long");
      let endpointUrl: URL;
      try {
        endpointUrl = new URL(endpoint);
      } catch {
        throw new ApiError(400, "Push endpoint is not a valid URL");
      }
      if (endpointUrl.protocol !== "https:") throw new ApiError(400, "Push endpoint must be https");
      const { error } = await service
        .from("push_subscriptions")
        .delete()
        .eq("endpoint", endpoint)
        .eq("user_id", auth.user.id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
