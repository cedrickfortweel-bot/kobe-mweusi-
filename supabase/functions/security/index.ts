import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

/* Transaction PIN (bcrypt via pgcrypto) and password changes.
   The PIN never leaves the server as plaintext; only a bcrypt
   hash is stored. Password changes re-verify the old
   password before applying the new one. */

const PIN_RE = /^\d{6}$/;
const WEAK_PINS = new Set([
  "000000", "111111", "123456", "654321", "123123",
  "121212", "777777", "999999", "100000", "258000",
]);

function weakPin(pin: string): boolean {
  return WEAK_PINS.has(pin) || /^(\d)\1{5}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin);
}

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "pin-set");

  try {
    /* ---------------- PIN set / change ---------------- */
    if (action === "pin-set" || action === "pin-change") {
      const limit = await consumeRateLimit(service, "security_pin", auth.user.id, 10, 3600);
      if (!limit.allowed) return json({ error: "Too many PIN attempts this hour." }, 429);

      const oldPin = String(body.old_pin || "");
      const newPin = String(body.new_pin || "");
      if (!PIN_RE.test(newPin)) throw new ApiError(400, "Use exactly 6 digits");
      if (weakPin(newPin)) throw new ApiError(400, "That PIN is too easy to guess. Choose another.");

      const { data: row, error: rowError } = await service
        .from("transaction_pins")
        .select("pin_hash")
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (rowError) throw rowError;

      if (action === "pin-change") {
        if (!row) throw new ApiError(409, "Set a PIN first");
        if (!oldPin) throw new ApiError(400, "Enter your current PIN");
        const { data: check, error: checkError } = await service.rpc("verify_transaction_pin", {
          p_user: auth.user.id,
          p_pin: oldPin,
        });
        if (checkError) throw checkError;
        if (check !== true) throw new ApiError(403, "Current PIN is wrong");
        if (oldPin === newPin) throw new ApiError(400, "New PIN must be different");
      }

      const { error: upsertError } = await service.rpc("set_transaction_pin", {
        p_user: auth.user.id,
        p_pin: newPin,
      });
      if (upsertError) throw upsertError;

      return json({ ok: true, action: action === "pin-set" ? "PIN set" : "PIN changed" });
    }

    /* ---------------- PIN verify ---------------- */
    if (action === "pin-verify") {
      const pin = String(body.pin || "");
      const { data, error } = await service.rpc("verify_transaction_pin", {
        p_user: auth.user.id,
        p_pin: pin,
      });
      if (error) throw error;
      return json({ ok: data === true });
    }

    /* ---------------- PIN status ---------------- */
    if (action === "pin-status") {
      const { data, error } = await service
        .from("transaction_pins")
        .select("user_id")
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (error) throw error;
      return json({ ok: true, hasPin: !!data });
    }

    /* ---------------- password change ---------------- */
    if (action === "password-change") {
      const limit = await consumeRateLimit(service, "security_password", auth.user.id, 5, 3600);
      if (!limit.allowed) return json({ error: "Too many attempts this hour." }, 429);

      const oldPassword = String(body.old_password || "");
      const newPassword = String(body.new_password || "");
      if (!oldPassword) throw new ApiError(400, "Enter your current password");
      if (newPassword.length < 8) throw new ApiError(400, "Use at least 8 characters");
      if (oldPassword === newPassword) throw new ApiError(400, "New password must be different");

      const url = Deno.env.get("SUPABASE_URL");
      const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
      if (!url || !publicKey) throw new ApiError(500, "Auth service unavailable");

      /* Re-authenticate: the old password must be correct
         before the new one is applied. */
      const authClient = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: signInError } = await authClient.auth.signInWithPassword({
        email: auth.user.email as string,
        password: oldPassword,
      });
      if (signInError) throw new ApiError(403, "Current password is wrong");

      const { error: updateError } = await service.auth.admin.updateUserById(auth.user.id, {
        password: newPassword,
      });
      if (updateError) throw updateError;

      return json({ ok: true, action: "Password changed" });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
