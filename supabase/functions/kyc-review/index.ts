import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";
import { consumeRateLimit, subjectHash } from "../_shared/rate.ts";
import { sendNotifications } from "../_shared/push.ts";

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);
  const staff = await isStaff(service, auth.user.id);
  if (!staff) return json({ error: "Staff access required" }, 403);

  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  }
  const action = request.method === "GET" ? "list" : String(body.action || "");
  const rule = action === "review" ? { scope: "kyc_review", limit: 10, window: 60 } : { scope: "kyc_queue", limit: 30, window: 60 };
  const { data: limits, error: limitError } = await service.rpc("consume_rate_limit", {
    p_scope: rule.scope,
    p_subject_hash: await subjectHash(rule.scope, auth.user.id),
    p_limit: rule.limit,
    p_window_seconds: rule.window,
  });
  if (limitError) return json({ error: "Rate limiter unavailable" }, 503);
  if (!limits?.[0]?.allowed) {
    return json({ error: "Too many requests. Try again shortly." }, { status: 429, headers: { "Retry-After": String(limits?.[0]?.retry_after_seconds || 60) } });
  }

  if (action === "review") {
    const submissionId = String(body.submission_id || "");
    const decision = String(body.decision || "");
    const note = String(body.review_note || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(submissionId)) return json({ error: "Invalid submission ID" }, 400);
    if (decision !== "approved" && decision !== "rejected") return json({ error: "Choose approve or reject" }, 400);
    if (decision === "rejected" && !note) return json({ error: "Add a reason when rejecting a submission" }, 400);
    const { data, error } = await service.rpc("review_seller_kyc", {
      p_submission_id: submissionId,
      p_reviewer_id: auth.user.id,
      p_decision: decision,
      p_review_note: note || null,
    });
    if (error) return json({ error: error.message }, 409);
    const result = data?.[0] || null;
    if (result?.seller_id) {
      const approved = result.status === "approved";
      await sendNotifications(service, [result.seller_id], approved ? "Seller verification approved" : "Seller verification needs attention", approved ? "Your seller account is approved. Your Kobe ID is " + (result.kobe_id || "now available") + "." : "Your KYC submission needs attention. Open your seller dashboard to review the next steps.", { link: "/seller.html#verification", kobe_id: result.kobe_id || null, decision: result.status });
    }
    return json({ result });
  }

  if (action !== "list") return json({ error: "Unknown action" }, 400);
  const { data: rows, error: queueError } = await service.from("seller_kyc_submissions")
    .select("id,seller_id,entity_type,legal_name,business_name,business_type,registration_number,region,id_type,id_last4,tax_id_last4,representative_role,social_links,document_paths,status,submitted_at,seller_profiles:seller_id (kobe_id, shop_name)")
    .in("status", ["pending", "under_review"]).order("submitted_at", { ascending: true }).limit(25);
  if (queueError) return json({ error: "Could not load the review queue" }, 500);

  const submissions = await Promise.all((rows || []).map(async row => {
    const { data: documents } = await service.storage.from("kyc-documents").createSignedUrls(row.document_paths, 120);
    return {
      ...row,
      documents: (documents || []).map((document, index) => ({ path: row.document_paths[index], url: document.signedUrl })),
    };
  }));
  return json({ submissions });
}