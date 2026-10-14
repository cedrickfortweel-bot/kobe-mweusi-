const encoder = new TextEncoder();

export async function subjectHash(scope: string, userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${scope}:${userId}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface RateResult {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

/* Consume a token from the server-side rate limiter. Throws on limiter
   failure so the action aborts instead of running unlimited. */
export async function consumeRateLimit(
  service: ReturnType<typeof import("npm:@supabase/supabase-js@2.117.3").createClient>,
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
