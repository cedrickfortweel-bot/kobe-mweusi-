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
    /* ---------------- phone verification ----------------
       The phone number is only trusted once the account holder has
       proved they own it. The proof is Supabase Auth's own phone
       confirmation, so the server reads Auth's state and never trusts
       the browser's word.

       The browser does the OTP dance with the Auth client:
         await client.auth.updateUser({ phone })      sends the code
         await client.auth.verifyOtp({ phone, token }) confirms it
       and then calls this action, which records the confirmation.

       A number that is not confirmed is never shown to another party
       and never receives an SMS. */
    if (action === "verify-phone") {
      const limit = await consumeRateLimit(service, "security_phone", auth.user.id, 5, 3600);
      if (!limit.allowed) return json({ error: "Too many verification attempts this hour." }, 429);

      const { data: userRow, error: userError } = await service.auth.admin.getUserById(auth.user.id);
      if (userError) throw userError;

      const phone = userRow?.phone ? String(userRow.phone) : "";
      if (!phone) throw new ApiError(400, "Add a phone number to your account first.");
      if (!userRow?.phone_confirmed_at) {
        throw new ApiError(409, "That phone number has not been confirmed yet. Enter the code we sent to it.");
      }

      const { error: profileError } = await service.rpc("mark_phone_verified", {
        p_user: auth.user.id,
        p_phone: phone,
      });
      if (profileError) throw profileError;

      return json({ ok: true, phone, message: "Your phone number is confirmed." });
    }

    /* ---------------- the current verification state ---------------- */
    if (action === "phone-status") {
      const { data: row, error: rowError } = await service
        .from("profiles")
        .select("phone_e164, phone_verified_at")
        .eq("id", auth.user.id)
        .maybeSingle();
      if (rowError) throw rowError;
      return json({
        ok: true,
        phone: row?.phone_e164 || null,
        verified: !!row?.phone_verified_at,
        verified_at: row?.phone_verified_at || null,
      });
    }

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

    /* ---------------- set or change, in one operation ----------------
       The page used to send "set-pin", which no branch handled, so a
       buyer could never set a PIN at all. One action now covers both
       cases: the database checks the current PIN when one exists, and
       counts a wrong one towards the lockout. */
    if (action === "set-pin" || action === "pin-set-or-change") {
      const limit = await consumeRateLimit(service, "security_pin", auth.user.id, 10, 3600);
      if (!limit.allowed) return json({ error: "Too many PIN attempts this hour." }, 429);

      const currentPin = String(body.current || body.current_pin || body.old_pin || "");
      const newPin = String(body.new || body.new_pin || body.pin || "");

      if (!/^\d{6}$/.test(newPin)) throw new ApiError(400, "Use exactly 6 digits");
      /* The database holds the weak list, so the page and the server
         cannot drift apart. */
      const { data: reason, error: reasonError } = await service.rpc("pin_rejection_reason", {
        p_pin: newPin,
      });
      if (reasonError) throw reasonError;
      if (reason) throw new ApiError(400, String(reason));

      const { data: result, error: changeError } = await service.rpc("change_transaction_pin", {
        p_user: auth.user.id,
        p_current_pin: currentPin,
        p_new_pin: newPin,
      });
      if (changeError) throw changeError;

      const row = Array.isArray(result) ? result[0] : result;
      if (!row || row.ok !== true) {
        if (row && row.reason === "locked") {
          throw new ApiError(429, `Too many wrong attempts. Try again in ${row.retry_after_seconds || 900} seconds.`, "locked");
        }
        if (row && row.reason === "invalid") {
          throw new ApiError(403, "Your current PIN is not correct.", "invalid");
        }
        throw new ApiError(400, "The PIN could not be changed.");
      }

      return json({ ok: true, action: row.action === "set" ? "PIN set" : "PIN changed" });
    }

    /* ---------------- reset a forgotten PIN ----------------
       Two proofs are required: the account password, and a phone code
       the server can see was confirmed by Supabase Auth. The page
       confirms the code with Auth first, then calls this; the server
       checks Auth's own record that the phone is confirmed, so a page
       cannot claim a phone it never proved. */
    if (action === "pin-reset") {
      const limit = await consumeRateLimit(service, "security_pin_reset", auth.user.id, 5, 3600);
      if (!limit.allowed) return json({ error: "Too many reset attempts this hour." }, 429);

      const password = String(body.password || "");
      const newPin = String(body.new_pin || body.pin || "");
      if (!password) throw new ApiError(400, "Enter your password");
      if (!/^\d{6}$/.test(newPin)) throw new ApiError(400, "Use exactly 6 digits");

      const { data: reason, error: reasonError } = await service.rpc("pin_rejection_reason", {
        p_pin: newPin,
      });
      if (reasonError) throw reasonError;
      if (reason) throw new ApiError(400, String(reason));

      const url = Deno.env.get("SUPABASE_URL");
      const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
      if (!url || !publicKey) throw new ApiError(500, "Auth service unavailable");

      /* The password proves the account holder is present. */
      const authClient = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: signInError } = await authClient.auth.signInWithPassword({
        email: auth.user.email as string,
        password,
      });
      if (signInError) throw new ApiError(403, "That password is not correct.");

      /* Auth must have confirmed the phone. A page cannot assert this. */
      const { data: userRow, error: userError } = await service.auth.admin.getUserById(auth.user.id);
      if (userError) throw userError;
      if (!userRow?.phone || !userRow?.phone_confirmed_at) {
        throw new ApiError(403, "Confirm your phone number with the code we sent before resetting your PIN.");
      }

      const { error: setError } = await service.rpc("set_transaction_pin", {
        p_user: auth.user.id,
        p_pin: newPin,
      });
      if (setError) throw setError;

      /* The PIN is already changed, so a logging failure must not fail
         the request. */
      await service.rpc("record_account_security_event", {
        p_user_id: auth.user.id,
        p_event_type: "transaction_pin_changed",
        p_severity: "warning",
        p_detail: { via: "password_and_phone" },
      }).catch(() => {});

      return json({ ok: true, action: "PIN reset" });
    }

    /* ---------------- PIN verify ----------------
       This used to call the raw verify function, which has no throttle
       and records no failure. A signed-in user could therefore guess a
       six digit PIN as often as they liked. It now goes through the
       locked path, so five wrong attempts lock the PIN and a correct
       one clears the counter. */
    if (action === "pin-verify") {
      const limit = await consumeRateLimit(service, "security_pin_verify", auth.user.id, 10, 60);
      if (!limit.allowed) return json({ error: "Too many attempts. Please wait a moment." }, 429);

      const pin = String(body.pin || "");
      const { data, error } = await service.rpc("check_transaction_pin", {
        p_user: auth.user.id,
        p_pin: pin,
      });
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      if (row && row.ok === true) return json({ ok: true });

      if (row && row.reason === "locked") {
        return json({
          ok: false,
          reason: "locked",
          error: `Too many wrong attempts. Try again in ${row.retry_after_seconds || 900} seconds.`,
          locked_until: row.locked_until,
          retry_after_seconds: row.retry_after_seconds,
        }, 429);
      }

      return json({
        ok: false,
        reason: "invalid",
        error: "That PIN is not correct.",
        attempts_remaining: row ? row.attempts_remaining : null,
      }, 403);
    }

    /* ---------------- PIN status ---------------- */
    if (action === "pin-status") {
      const { data, error } = await service.rpc("pin_state", { p_user: auth.user.id });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return json({
        ok: true,
        hasPin: !!(row && row.has_pin),
        locked_until: (row && row.locked_until) || null,
        changed_at: (row && row.changed_at) || null,
      });
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
