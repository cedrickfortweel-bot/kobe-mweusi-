import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";
import { sendNotifications } from "../_shared/push.ts";

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
const CODE_LIFETIME_MS = 15 * 60 * 1000;

const encoder = new TextEncoder();
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
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

      const expiresAt = new Date(Date.now() + CODE_LIFETIME_MS).toISOString();

      /* Replace any previous unused codes for this order. */
      await service.from("handoff_codes").delete().eq("order_id", order.id).is("used_at", null);

      const sellerToken = newToken();
      const buyerToken = newToken();
      const { error: insertError } = await service.from("handoff_codes").insert([
        {
          order_id: order.id,
          code_type: "seller",
          token_hash: await hashToken(sellerToken),
          issued_to: order.seller_id,
          expires_at: expiresAt,
        },
        {
          order_id: order.id,
          code_type: "buyer",
          token_hash: await hashToken(buyerToken),
          issued_to: order.buyer_id,
          expires_at: expiresAt,
        },
      ]);
      if (insertError) throw insertError;

      return json({
        ok: true,
        order_ref: order.ref,
        seller_code: sellerToken,
        buyer_code: buyerToken,
        expires_at: expiresAt,
      });
    }

    /* ---------------- verify ---------------- */
    if (action === "verify") {
      const limit = await consumeRateLimit(service, "handoff_verify", auth.user.id, 60, 60);
      if (!limit.allowed) return json({ error: "Too many scans. Please wait a moment." }, 429);

      const scanned = String(body.code || "").trim();
      if (!scanned.startsWith("KMH1.") || scanned.length < 40) {
        throw new ApiError(400, "That is not a valid Kobe handoff code");
      }

      const tokenHash = await hashToken(scanned);
      const { data: codeRow, error: codeError } = await service
        .from("handoff_codes")
        .select("*")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (codeError) throw codeError;
      if (!codeRow) throw new ApiError(404, "This code is not valid. Scan the code from the matching order screen.");

      if (codeRow.used_at) throw new ApiError(409, "This code has already been used");
      if (new Date(codeRow.expires_at).getTime() <= Date.now()) {
        throw new ApiError(409, "This code expired. Go back and generate a fresh one.");
      }

      const { data: order, error: orderError } = await service
        .from("orders")
        .select("*, seller_profiles:seller_id (shop_name, kobe_id), buyer_profile:buyer_id (display_name, phone_e164)")
        .eq("id", codeRow.order_id)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) throw new ApiError(404, "The order for this code no longer exists");
      if (order.status !== "in_escrow" && order.status !== "delivered") {
        throw new ApiError(409, "The money for this order is no longer held in escrow");
      }
      if (order.status === "disputed") {
        throw new ApiError(409, "This order is disputed. The money stays frozen until support resolves it.");
      }

      /* A seller code (the seller's own QR) may only be scanned by
         the buyer who paid, or staff. A buyer code (the buyer's QR)
         may only be scanned by the assigned seller, or staff. */
      const isBuyerCode = codeRow.code_type === "buyer";
      const authorized = staff
        || (isBuyerCode && order.seller_id === auth.user.id)
        || (!isBuyerCode && order.buyer_id === auth.user.id);
      if (!authorized) {
        throw new ApiError(403, "Only " + (isBuyerCode ? "the seller of this order" : "the buyer of this order") + " can scan this code");
      }

      /* Atomic one-time claim: if two scans race, only one wins. */
      const { data: claimed, error: claimError } = await service
        .from("handoff_codes")
        .update({ used_at: new Date().toISOString(), scanned_by: auth.user.id })
        .eq("id", codeRow.id)
        .is("used_at", null)
        .select("*")
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) throw new ApiError(409, "This code has already been used");

      await service.rpc("record_handoff", {
        p_order_id: order.id,
        p_code_type: codeRow.code_type,
        p_scanned_by: auth.user.id,
      });

      const counterparty = isBuyerCode
        ? (order.buyer_profile?.display_name || "Buyer")
        : (order.seller_profiles?.shop_name || "Seller");

      const otherPartyId = isBuyerCode ? order.buyer_id : order.seller_id;
      sendNotifications(service, [otherPartyId], "Handoff verified for order " + order.ref,
        "The " + (isBuyerCode ? "seller" : "buyer") + " scanned the handoff code for order " + order.ref + ".",
        { link: (isBuyerCode ? "/seller.html#seller-orders" : "/buyer.html#order/" + order.ref), order: order.ref });

      return json({
        ok: true,
        order_ref: order.ref,
        item_name: order.item_name,
        quantity: order.quantity,
        amount: Number(order.subtotal_tzs),
        code_type: codeRow.code_type,
        counterparty,
        scanned_at: claimed.used_at,
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
