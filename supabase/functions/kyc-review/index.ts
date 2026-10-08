import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function subjectHash(scope: string, userId: string) {
  const bytes = new TextEncoder().encode(`${scope}:${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET" && request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const authorization = request.headers.get("Authorization");
  if (!url || !serviceKey || !publicKey || !authorization) return response({ error: "Unauthorized" }, 401);

  const userClient = createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return response({ error: "Unauthorized" }, 401);

  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: roles, error: roleError } = await service.from("internal_user_roles")
    .select("role").eq("user_id", userData.user.id).in("role", ["admin", "support_agent"]).limit(1);
  if (roleError) return response({ error: "Could not verify staff access" }, 500);
  if (!roles?.length) return response({ error: "Staff access required" }, 403);

  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try { body = await request.json(); } catch { return response({ error: "Invalid JSON body" }, 400); }
  }
  const action = request.method === "GET" ? "list" : String(body.action || "");
  const rule = action === "review" ? { scope: "kyc_review", limit: 10, window: 60 } : { scope: "kyc_queue", limit: 30, window: 60 };
  const { data: limits, error: limitError } = await service.rpc("consume_rate_limit", {
    p_scope: rule.scope,
    p_subject_hash: await subjectHash(rule.scope, userData.user.id),
    p_limit: rule.limit,
    p_window_seconds: rule.window,
  });
  if (limitError) return response({ error: "Rate limiter unavailable" }, 503);
  if (!limits?.[0]?.allowed) {
    return new Response(JSON.stringify({ error: "Too many requests. Try again shortly." }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Retry-After": String(limits?.[0]?.retry_after_seconds || 60) },
    });
  }

  if (action === "review") {
    const submissionId = String(body.submission_id || "");
    const decision = String(body.decision || "");
    const note = String(body.review_note || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(submissionId)) return response({ error: "Invalid submission ID" }, 400);
    if (decision !== "approved" && decision !== "rejected") return response({ error: "Choose approve or reject" }, 400);
    if (decision === "rejected" && !note) return response({ error: "Add a reason when rejecting a submission" }, 400);
    const { data, error } = await service.rpc("review_seller_kyc", {
      p_submission_id: submissionId,
      p_reviewer_id: userData.user.id,
      p_decision: decision,
      p_review_note: note || null,
    });
    if (error) return response({ error: error.message }, 409);
    return response({ result: data?.[0] || null });
  }

  if (action !== "list") return response({ error: "Unknown action" }, 400);
  const { data: rows, error: queueError } = await service.from("seller_kyc_submissions")
    .select("id,seller_id,entity_type,legal_name,business_name,business_type,registration_number,region,id_type,id_last4,tax_id_last4,representative_role,social_links,document_paths,status,submitted_at")
    .in("status", ["pending", "under_review"]).order("submitted_at", { ascending: true }).limit(25);
  if (queueError) return response({ error: "Could not load the review queue" }, 500);

  const submissions = await Promise.all((rows || []).map(async row => {
    const { data: documents } = await service.storage.from("kyc-documents").createSignedUrls(row.document_paths, 120);
    return {
      ...row,
      documents: (documents || []).map((document, index) => ({ path: row.document_paths[index], url: document.signedUrl })),
    };
  }));
  return response({ submissions });
});