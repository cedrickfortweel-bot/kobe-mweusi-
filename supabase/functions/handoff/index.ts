import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";
import { sendNotifications } from "../_shared/push.ts";
import {
  hashHandoffToken,
  looksLikeHandoffCode,
  scanFailure,
  handoffNotice,
  type HandoffOrder,
} from "../_shared/handoff.ts";

/* The handoff QR flow:
   1. An order in escrow (or delivered) issues two single-use codes:
      - a SELLER code, which only the order's buyer may scan
      - a BUYER code, which only the order's seller may scan
      (staff may scan either)
   2. Scanning verifies the signer, order membership, code expiry,
      escrow state and one-time use, then records the handoff.
   Scanning never moves money — release happens in finalize_order,
   which only the payment callback may call. */

const ORDER_REF = /^KM-\d{6}$/;
/* A handoff code has NO clock on it.

   It is valid from the moment it is issued until it is scanned, until a
   newer code replaces it, or until the order closes. A time limit was
   never the right instrument: a buyer showing their code while an agent
   was delayed would have had it expire mid-handover, and the scan would
   be refused, leaving the order stuck in escrow.

   The order's own state is a better clock than a timestamp, and the
   database enforces it. */
const CODE_LIFETIME_MS = 0;

async function hashToken(token: string): Promise<string> {
  return hashHandoffToken(token);
}
function newToken(): string {
  return "KMH1." + crypto.randomUUID();
}

async function loadEscrowOrder(service: any, ref: string, viewerId: string, staff: boolean) {
  const { data: order, error } = await service
    .from("orders")
    .select("*, seller_profiles:seller_id (shop_name, kobe_id), buyer_profile:buyer_id (display_name, phone_e164)")
    .eq("ref", ref)
    .maybeSingle();
  if (error) throw error;
  if (!order) throw new ApiError(404, "Order not found");
  if (!staff && order.buyer_id !== viewerId && order.seller_id !== viewerId) {
    throw new ApiError(403, "You are not part of this order");
  }
  if (order.status !== "in_escrow" && order.status !== "delivered") {
    throw new ApiError(409, "Handoff codes only exist while money is held in escrow");
  }
  return order;
}

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);
  const staff = await isStaff(service, auth.user.id);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "verify");

  try {
    /* ---------------- issue ---------------- */
    if (action === "issue") {
      const limit = await consumeRateLimit(service, "handoff_issue", auth.user.id, 30, 60);
      if (!limit.allowed) return json({ error: "Too many requests. Please wait a moment." }, 429);

      const ref = String(body.order_ref || "").trim().toUpperCase();
      if (!ORDER_REF.test(ref)) throw new ApiError(400, "Enter a valid order reference");
      const order = await loadEscrowOrder(service, ref, auth.user.id, staff);

      /* No expiry: the code lives until it is scanned, replaced, or the
         order closes. */
      const expiresAt: string | null = CODE_LIFETIME_MS > 0
        ? new Date(Date.now() + CODE_LIFETIME_MS).toISOString()
        : null;

      const sellerToken = newToken();
      const buyerToken = newToken();

      /* The database owns the issue rules: escrow state, expiry, and the
         one-active-code-per-order rule. It revokes the previous unused
         codes rather than deleting them, so the audit trail survives. */
      const { data: issued, error: issueError } = await service.rpc("issue_handoff_codes", {
        p_order_id: order.id,
        p_seller_token_hash: await hashToken(sellerToken),
        p_buyer_token_hash: await hashToken(buyerToken),
        p_expires_at: expiresAt,
      });
      if (issueError) throw issueError;

      return json({
        ok: true,
        order_ref: order.ref,
        seller_code: sellerToken,
        buyer_code: buyerToken,
        expires_at: expiresAt,
        issued: issued ?? null,
      });
    }

    /* ---------------- verify ---------------- */
    if (action === "verify") {
      const limit = await consumeRateLimit(service, "handoff_verify", auth.user.id, 60, 60);
      if (!limit.allowed) return json({ error: "Too many scans. Please wait a moment." }, 429);

      const scanned = String(body.code || "").trim();
      if (!looksLikeHandoffCode(scanned)) {
        throw new ApiError(400, "That is not a valid Kobe handoff code");
      }

      const tokenHash = await hashToken(scanned);

      /* The database owns the scan rules: code validity, one-time use,
         order membership, the escrow state, who may scan, the handoff
         audit trail and the release window. It also owns the wording, so
         that every way a scan can fail tells the person holding the
         phone exactly what happened. */
      const { data: recorded, error: recordError } = await service.rpc("record_handoff_scan", {
        p_token_hash: tokenHash,
        p_scanner: auth.user.id,
        p_stage: null,
      });
      if (recordError) throw scanFailure(recordError);

      const result = Array.isArray(recorded) ? recorded[0] : recorded;
      const orderId = result?.order_id;
      if (!orderId) throw new ApiError(500, "The scan was not recorded");

      const { data: order, error: orderError } = await service
        .from("orders")
        .select("*, seller_profiles:seller_id (shop_name, kobe_id), buyer_profile:buyer_id (display_name, phone_e164)")
        .eq("id", orderId)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) throw new ApiError(404, "The order for this code no longer exists");

      const counterparty = result.code_type === "buyer"
        ? (order.buyer_profile?.display_name || "Buyer")
        : (order.seller_profiles?.shop_name || "Seller");

      /* The side that owns the scanned code is the side whose handover
         just became true, so that is who hears about it. */
      const handoffOrder: HandoffOrder = {
        ref: order.ref,
        buyer_id: order.buyer_id,
        seller_id: order.seller_id,
      };
      const notice = handoffNotice(handoffOrder, result.role, result.code_type);

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
        counterparty,
        scanned_at: result.scanned_at,
        /* The buyer's code being scanned releases the escrow at once.
           The seller's code being scanned opens the three-hour window. */
        released: result.released === true,
        release_scheduled_for: result.release_scheduled_for ?? null,
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    /* The reason travels with the message, so the app can tell the
       difference between "already scanned", "wrong person" and "the
       handover is done" without parsing English. */
    return json({ ok: false, error: api.message, reason: api.reason || null }, api.status);
  }
}
