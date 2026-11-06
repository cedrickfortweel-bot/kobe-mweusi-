export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

export class ApiError extends Error {
  status: number;
  /* A machine-readable reason, so the app can react to a specific case
     rather than only showing the message. */
  reason?: string;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/* Normalize a Supabase error into an ApiError the caller can render. */
export function asApiError(error: unknown, fallback = "Request failed"): ApiError {
  const e = error as { code?: string; message?: string; details?: string | null };
  if (!e) return new ApiError(500, fallback);
  if (e.code === "P0001" && e.message === "RATE_LIMITED") {
    const seconds = Math.max(1, Number(e.details) || 60);
    return new ApiError(429, `Too many changes. Please wait ${seconds} seconds and try again.`);
  }
  if (e.code === "23505" && String(e.message).includes("seller_kyc_one_open_submission_idx")) {
    return new ApiError(409, "You already have a verification submission under review.");
  }
  if (e.code === "42501") return new ApiError(403, "This action is not allowed.");
  if (e.code === "23505") return new ApiError(409, "That already exists. Please reload and try again.");
  return new ApiError(500, e.message || fallback);
}
