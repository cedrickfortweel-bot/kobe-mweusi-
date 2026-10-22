import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";
import { sendNotifications } from "../_shared/push.ts";
import {
  hashHandoffToken,
  looksLikeHandoffCode,
  scanFailure,
  handoffNotice,
  type HandoffOrder,
} from "../_shared/handoff.ts";

/* The delivery agent hub.

   The agent signs in like every other account, but the server only treats
   them as an agent when a delivery_agents row says so. The scan itself is
   handed to the database, which decides whether this agent is the one
   assigned to this order, so the money rules stay exactly where they are
   for the buyer and the seller: an agent scan never invents a release,
   it records the handover and lets the escrow policy decide what
   happens next. */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

interface AgentRow {
  user_id: string;
  worker_id: string | null;
  region: string | null;
  verification_status: string;
  verified_at: string | null;
}

async function loadAgent(service: any, userId: string): Promise<AgentRow> {
  const { data, error } = await service
    .from("delivery_agents")
    .select("user_id,worker_id,region,verification_status,verified_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(403, "This account is not a delivery agent.");
  return data as AgentRow;
}

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "snapshot");

  try {
    /* Every action needs an agent. A buyer account that finds this
       endpoint is refused before it can read or record anything. */
    const agent = await loadAgent(service, auth.user.id);

    /* ------------------------------------------------------------------
     * The dashboard: who the agent is, what they carry and what they
     * have scanned today.
     * ------------------------------------------------------------------ */
    if (action === "snapshot") {
      const limit = Number(body.limit) || 20;
      const { data, error } = await service.rpc("agent_hub_snapshot", {
        p_user: auth.user.id,
        p_limit: limit,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return json({
        ok: true,
        worker_id: (row && row.worker_id) || agent.worker_id,
        region: (row && row.region) || agent.region,
        verification_status: agent.verification_status,
        verified: agent.verification_status === "verified",
        verified_at: agent.verified_at,
        today_scans: (row && row.today_scans) || 0,
        assignments: (row && row.assignments) || [],
        scans: (row && row.scans) || [],
      });
    }

    /* ------------------------------------------------------------------
     * A scan.
     * ------------------------------------------------------------------ */
    if (action === "scan") {
      const limit = await consumeRateLimit(service, "agent_scan", auth.user.id, 60, 60);
      if (!limit.allowed) return json({ error: "Too many scans. Please wait a moment." }, 429);

      const code = String(body.code || "").trim();
      if (!looksLikeHandoffCode(code)) {
        throw new ApiError(400, "That is not a valid Kobe handoff code.");
      }

      /* The database owns the scan rules: code validity, one-time use,
         order membership, escrow state, who may scan, the audit trail
         and the release decision. */
      const { data, error } = await service.rpc("record_handoff_scan", {
        p_token_hash: await hashHandoffToken(code),
        p_scanner: auth.user.id,
        p_stage: null,
      });
      if (error) throw scanFailure(error);

      const result = Array.isArray(data) ? data[0] : data;
      const orderId = result?.order_id;
      if (!orderId) throw new ApiError(500, "The scan was not recorded.");

      const { data: order, error: orderError } = await service
        .from("orders")
        .select("id,ref,item_name,quantity,subtotal_tzs,status,buyer_id,seller_id")
        .eq("id", orderId)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) throw new ApiError(404, "The order for this code no longer exists.");

      const handoffOrder: HandoffOrder = {
        ref: order.ref,
        buyer_id: order.buyer_id,
        seller_id: order.seller_id,
      };
      const notice = handoffNotice(handoffOrder, result.role, result.code_type);

      /* The agent's own inbox gets the scan too, so the hub history and
         the notification list agree. */
      await service.from("activity_events").insert({
        user_id: auth.user.id,
        kind: "handoff_scanned",
        order_id: order.id,
        payload: {
          ref: order.ref,
          role: result.role,
          code_type: result.code_type,
          worker_id: agent.worker_id,
        },
      }).catch(() => { /* the scan itself already succeeded */ });

      sendNotifications(
        service,
        notice.recipients.map((entry) => entry.id),
        notice.title,
        notice.body,
        { link: notice.recipients[0]?.link, order: order.ref }
      );

      return json({
        ok: true,
        order_ref: order.ref,
        item_name: order.item_name,
        quantity: order.quantity,
        amount: Number(order.subtotal_tzs),
        code_type: result.code_type,
        role: result.role,
        scanned_at: result.scanned_at,
        released: result.released === true,
        release_scheduled_for: result.release_scheduled_for ?? null,
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message, reason: api.reason || null }, api.status);
  }
}
