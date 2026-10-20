import { createClient } from "npm:@supabase/supabase-js@2.117.3";

/* ---------- inlined shared/http.ts ---------- */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function asApiError(error: unknown, fallback = "Request failed"): ApiError {
  const e = error as { code?: string; message?: string; details?: string | null };
  if (!e) return new ApiError(500, fallback);
  if (e.code === "P0001" && e.message === "RATE_LIMITED") {
    const seconds = Math.max(1, Number(e.details) || 60);
    return new ApiError(429, `Too many changes. Please wait ${seconds} seconds and try again.`);
  }
  if (e.code === "42501") return new ApiError(403, "This action is not allowed for your account.");
  if (e.code === "23505") return new ApiError(409, "That already exists. Please reload and try again.");
  return new ApiError(500, e.message || fallback);
}

/* ---------- inlined shared/auth.ts ---------- */
interface AuthedRequest {
  user: { id: string; email?: string };
  url: string;
  publicKey: string;
}

async function verifyUser(request: Request): Promise<AuthedRequest> {
  const url = Deno.env.get("SUPABASE_URL");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const authorization = request.headers.get("Authorization");
  if (!url || !publicKey || !authorization) throw new ApiError(401, "Unauthorized");

  const client = createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new ApiError(401, "Unauthorized");
  return { user: { id: data.user.id, email: data.user.email }, url: url as string, publicKey: publicKey as string };
}

function serviceClient(url: string): ReturnType<typeof createClient> {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/* ---------- inlined shared/rate.ts ---------- */
async function subjectHash(scope: string, userId: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${scope}:${userId}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface RateResult { allowed: boolean; remaining: number; retry_after_seconds: number; }

async function consumeRateLimit(
  service: ReturnType<typeof createClient>,
  scope: string,
  userId: string,
  limit: number,
  windowSeconds: number
): Promise<RateResult> {
  const { data, error } = await service.rpc("consume_rate_limit", {
    p_scope: scope,
    p_subject_hash: await subjectHash(scope, userId),
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new Error("Rate limiter unavailable");
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error("Rate limiter unavailable");
  return row as RateResult;
}

/* ---------- security logic ---------- */
const PIN_RE = /^\d{6}$/;
const WEAK_PINS = new Set([
  "000000", "111111", "123456", "654321", "123123",
  "121212", "777777", "999999", "100000", "258000",
]);

function weakPin(pin: string): boolean {
  return WEAK_PINS.has(pin) || /^(\d)\1{5}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin);
}

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "pin-set");

  try {
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

    if (action === "pin-verify") {
      const pin = String(body.pin || "");
      const { data, error } = await service.rpc("verify_transaction_pin", {
        p_user: auth.user.id,
        p_pin: pin,
      });
      if (error) throw error;
      return json({ ok: data === true });
    }

    if (action === "pin-status") {
      const { data, error } = await service
        .from("transaction_pins")
        .select("user_id")
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (error) throw error;
      return json({ ok: true, hasPin: !!data });
    }

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
