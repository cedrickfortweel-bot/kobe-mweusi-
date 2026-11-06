import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";
import { sendNotifications } from "../_shared/push.ts";

/* Order statuses as the buyer app names them. */
const BUYER_STATUS: Record<string, string> = {
  awaiting_payment: "Awaiting payment",
  in_escrow: "In escrow",
  delivered: "In escrow",
  completed: "Completed",
  disputed: "Disputed",
  refunded: "Refunded",
  cancelled: "Cancelled",
  split: "Split",
};

/* Progress step for the seller receipt (0 = not paid, 4 = completed). */
const SELLER_PROGRESS: Record<string, number> = {
  awaiting_payment: 0,
  in_escrow: 2,
  delivered: 3,
  completed: 4,
  disputed: 2,
  refunded: 4,
  cancelled: 0,
};

const ORDER_REF = /^KM-\d{6}$/;

function newOrderRef(): string {
  return "KM-" + Math.floor(100000 + Math.random() * 900000).toString();
}

async function insertWithRef(service: any, base: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const ref = newOrderRef();
    const { data, error } = await service.from("orders").insert({ ...base, ref }).select("*").single();
    if (!error) return data;
    if (error.code !== "23505") throw error;
  }
  throw new ApiError(500, "Could not assign an order reference. Please try again.");
}

/* Full order row with participant profiles, for one viewer. */
async function loadOrder(service: any, ref: string, viewerId: string, staff: boolean) {
  const { data: order, error } = await service
    .from("orders")
    .select("*, seller_profiles:seller_id (shop_name, kobe_id), buyer_profile:buyer_id (display_name, phone_e164, phone_verified_at)")
    .eq("ref", ref)
    .maybeSingle();
  if (error) throw error;
  if (!order) throw new ApiError(404, "Order not found");
  if (!staff && order.buyer_id !== viewerId && order.seller_id !== viewerId) {
    throw new ApiError(403, "You are not part of this order");
  }
  const { data: dispute } = await service
    .from("disputes")
    .select("ref")
    .eq("order_id", order.id)
    .neq("status", "resolved")
    .maybeSingle();
  order.dispute_ref = dispute ? dispute.ref : null;
  return order;
}

/* Orders for one participant. Plain selects + JS join keep the
   query portable; the service client bypasses RLS and the
   viewer id was already verified from the access token. */
async function listOrdersFor(service: any, viewerId: string, role: string) {
  const isSeller = role === "seller";
  const { data: rows, error } = await service
    .from("orders")
    .select("*, seller_profiles:seller_id (shop_name, kobe_id), buyer_profile:buyer_id (display_name, phone_e164, phone_verified_at)")
    .eq(isSeller ? "seller_id" : "buyer_id", viewerId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;

  const ids = (rows || []).map((row: any) => row.id);
  let disputeRefs: Record<string, string> = {};
  if (ids.length) {
    const { data: open } = await service
      .from("disputes")
      .select("order_id, ref")
      .in("order_id", ids)
      .neq("status", "resolved");
    disputeRefs = (open || []).reduce((map: Record<string, string>, d: any) => {
      map[d.order_id] = d.ref;
      return map;
    }, {});
  }

  return (rows || []).map((row: any) =>
    isSeller ? mapSellerOrder(row, disputeRefs[row.id]) : mapBuyerOrder(row, disputeRefs[row.id])
  );
}

function mapBuyerOrder(row: any, disputeRef?: string | null): Record<string, unknown> {
  return {
    id: row.ref,
    orderId: row.id,
    seller: row.seller_profiles?.shop_name || "Seller",
    sellerKid: row.seller_profiles?.kobe_id || "",
    sellerId: row.seller_id,
    item: row.item_name + (row.quantity > 1 ? ` ×${row.quantity}` : ""),
    itemName: row.item_name,
    quantity: row.quantity,
    unitPrice: Number(row.unit_price_tzs),
    subtotal: Number(row.subtotal_tzs),
    fee: Number(row.buyer_fee_tzs),
    total: Number(row.total_due_tzs),
    status: BUYER_STATUS[row.status] || row.status,
    /* The raw state, so the app can tell "in escrow" from "delivered"
       without parsing a label. */
    state: row.status,
    createdAt: new Date(row.created_at).getTime(),
    disputeId: disputeRef || null,
    productId: row.product_id,
    source: row.source,
    expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
    exp: row.confirm_by
      ? new Date(row.confirm_by).getTime()
      : row.expires_at
        ? new Date(row.expires_at).getTime()
        : null,
  };
}

function mapSellerOrder(row: any, disputeRef?: string | null): Record<string, unknown> {
  return {
    id: row.ref,
    who: row.buyer_profile?.display_name || "Buyer",
    /* Only a number the buyer has confirmed is shown. A number nobody
       proved they own must not be handed to a stranger. */
    ph: row.buyer_profile?.phone_verified_at ? row.buyer_profile?.phone_e164 || "" : "",
    item: row.item_name,
    q: row.quantity,
    u: Number(row.unit_price_tzs),
    amt: Number(row.subtotal_tzs),
    fee: Number(row.seller_fee_tzs),
    total: Number(row.total_due_tzs),
    dt: new Date(row.created_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    s: BUYER_STATUS[row.status] || row.status,
    d: SELLER_PROGRESS[row.status] ?? 0,
    disputeId: disputeRef || null,
    buyerId: row.buyer_id,
    productId: row.product_id,
    createdAt: new Date(row.created_at).toISOString(),
    /* The deadline by which the buyer must confirm, if the order carries
       one. The actual release time is decided by the escrow rules, and
       the seller app reads that from the escrow timers. */
    exp: row.confirm_by
      ? new Date(row.confirm_by).getTime()
      : row.expires_at
        ? new Date(row.expires_at).getTime()
        : null,
  };
}

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);
  const staff = await isStaff(service, auth.user.id);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "list");

  try {
    /* ---------------- create ---------------- */
    if (action === "create") {
      const limit = await consumeRateLimit(service, "order_create", auth.user.id, 20, 60);
      if (!limit.allowed) return json({ error: "Too many orders. Please wait a moment." }, 429);

      const productId = String(body.product_id || "");
      const quantity = Number(body.quantity || 1);
      const note = body.note ? String(body.note).slice(0, 500) : null;
      const source = ["store", "live", "manual"].includes(String(body.source || "")) ? String(body.source) : "store";
      const liveSessionId = body.live_session_id ? String(body.live_session_id) : null;
      const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey).slice(0, 255) : null;

      if (!/^[0-9a-f-]{36}$/i.test(productId)) throw new ApiError(400, "Choose a product to buy");
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new ApiError(400, "Quantity must be between 1 and 99");

      const { data: product, error: productError } = await service
        .from("products")
        .select("*, seller:seller_id (verification_status)")
        .eq("id", productId)
        .maybeSingle();
      if (productError) throw productError;
      if (!product) throw new ApiError(404, "Product not found");
      if (product.status !== "active") throw new ApiError(409, "This product is no longer available");
      if (product.seller?.verification_status !== "verified") throw new ApiError(409, "This seller is not verified yet");
      if (product.seller_id === auth.user.id) throw new ApiError(403, "You cannot buy from your own shop");
      if (quantity > product.stock_quantity) throw new ApiError(409, "Only " + product.stock_quantity + " left in stock");

      const subtotal = Number(product.price_tzs) * quantity;
      const buyerFee = Math.round(subtotal * 0.01);
      const sellerFee = Math.round(subtotal * 0.01);
      const total = subtotal + buyerFee;

      /* A repeated request (double tap, retry, refresh) with the same
         idempotency key returns the original order instead of creating
         a second one. */
      if (idempotencyKey) {
        const { data: existing, error: existingError } = await service
          .from("orders")
          .select("*, seller_profiles:seller_id (shop_name, kobe_id)")
          .eq("idempotency_key", idempotencyKey)
          .eq("buyer_id", auth.user.id)
          .maybeSingle();
        if (existingError) throw existingError;
        if (existing) {
          const { data: dispute } = await service
            .from("disputes")
            .select("ref")
            .eq("order_id", existing.id)
            .neq("status", "resolved")
            .maybeSingle();
          return json({ ok: true, order: mapBuyerOrder(existing, dispute?.ref), alreadyCreated: true });
        }
      }

      /* The buyer's wallet funds the purchase. Check the balance before
         touching the stock, so a short balance never reserves stock. */
      const { error: walletSetupError } = await service.rpc("ensure_wallet_for", {
        p_user: auth.user.id,
      });
      if (walletSetupError) throw walletSetupError;
      const { data: wallet, error: walletError } = await service.rpc("wallet_available_balance", {
        p_user: auth.user.id,
      });
      if (walletError) throw walletError;
      const balance = Number(wallet || 0);

      if (balance < total) {
        return json({
          ok: false,
          error: "Your wallet balance is not enough for this purchase.",
          reason: "insufficient_balance",
          balance_tzs: balance,
          required_tzs: total,
          shortfall_tzs: total - balance,
        }, 409);
      }

      /* Reserve stock first; put it back if the order row cannot be created. */
      const { error: stockError } = await service.rpc("reserve_stock", {
        p_product_id: productId,
        p_quantity: quantity,
      });
      if (stockError) {
        if (stockError.code === "P0001") throw new ApiError(409, "That item just sold out");
        throw stockError;
      }

      let orderRow: any;
      try {
        orderRow = await insertWithRef(service, {
          buyer_id: auth.user.id,
          seller_id: product.seller_id,
          product_id: productId,
          live_session_id: liveSessionId,
          item_name: product.name,
          quantity,
          unit_price_tzs: product.price_tzs,
          subtotal_tzs: subtotal,
          buyer_fee_tzs: buyerFee,
          seller_fee_tzs: sellerFee,
          total_due_tzs: total,
          status: "awaiting_payment",
          note,
          source,
          idempotency_key: idempotencyKey,
          expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        });
      } catch (error) {
        await service.rpc("restore_stock", { p_product_id: productId, p_quantity: quantity }).catch(() => {});
        throw error;
      }

      /* Move the money from the wallet into escrow. The database checks
         the balance again under a lock, so two purchases from the same
         wallet cannot both pass the check. */
      const { data: escrow, error: escrowError } = await service.rpc("place_funds_in_escrow", {
        p_order_id: orderRow.id,
        p_payment_intent_id: null,
        p_funding_source: "wallet",
      });

      if (escrowError) {
        /* The balance went away between the check and the debit, or
           something else went wrong. Undo the order completely. */
        await service.rpc("restore_stock", { p_product_id: productId, p_quantity: quantity }).catch(() => {});
        await service.from("orders").update({ status: "cancelled" }).eq("id", orderRow.id).catch(() => {});

        if (escrowError.code === "P0001" && /INSUFFICIENT_WALLET_BALANCE/.test(escrowError.message || "")) {
          let shortfall = 0;
          try {
            const detail = JSON.parse(escrowError.details || "{}");
            shortfall = Number(detail.shortfall_tzs || 0);
          } catch { /* the detail is best effort */ }
          return json({
            ok: false,
            error: "Your wallet balance is not enough for this purchase.",
            reason: "insufficient_balance",
            shortfall_tzs: shortfall,
            required_tzs: total,
          }, 409);
        }
        throw escrowError;
      }

      const { data: sellerProfile } = await service
        .from("seller_profiles")
        .select("shop_name, kobe_id")
        .eq("user_id", product.seller_id)
        .maybeSingle();

      await service.from("activity_events").insert([
        { user_id: auth.user.id, kind: "order_created", order_id: orderRow.id, payload: { ref: orderRow.ref, seller: sellerProfile?.shop_name, total } },
        { user_id: product.seller_id, kind: "order_created", order_id: orderRow.id, payload: { ref: orderRow.ref, total, buyer: auth.user.id } },
      ]);

      sendNotifications(service, [product.seller_id], "New order " + orderRow.ref,
        "A buyer ordered " + product.name + " for TSh " + total.toLocaleString() + ". The money is held in escrow.",
        { link: "/seller.html#seller-orders", order: orderRow.ref });

      return json({
        ok: true,
        order: mapBuyerOrder({ ...orderRow, status: "in_escrow", seller_profiles: sellerProfile }),
        escrow: { status: escrow?.status ?? "funded", amount: total, source: "wallet" },
        balance_tzs: balance - total,
      }, 201);
    }

    /* ---------------- list ---------------- */
    if (action === "list") {
      const role = String(body.role) === "seller" ? "seller" : "buyer";
      const orders = await listOrdersFor(service, auth.user.id, role);
      return json({ ok: true, orders });
    }

    /* ---------------- lookup ---------------- */
    if (action === "lookup") {
      const ref = String(body.ref || "").trim().toUpperCase();
      if (!ORDER_REF.test(ref)) throw new ApiError(400, "Enter a valid order reference like KM-123456");
      const order = await loadOrder(service, ref, auth.user.id, staff);
      const isSeller = order.seller_id === auth.user.id;
      return json({
        ok: true,
        order: isSeller ? mapSellerOrder(order, order.dispute_ref) : mapBuyerOrder(order, order.dispute_ref),
      });
    }

    /* ---------------- cancel ---------------- */
    if (action === "cancel") {
      const ref = String(body.ref || "").trim().toUpperCase();
      if (!ORDER_REF.test(ref)) throw new ApiError(400, "Enter a valid order reference");
      const order = await loadOrder(service, ref, auth.user.id, staff);
      if (order.buyer_id !== auth.user.id && !staff) throw new ApiError(403, "Only the buyer can cancel this order");
      if (order.status !== "awaiting_payment") throw new ApiError(409, "Only unpaid orders can be cancelled");

      const { error: cancelError } = await service
        .from("orders")
        .update({ status: "cancelled" })
        .eq("id", order.id)
        .eq("status", "awaiting_payment");
      if (cancelError) throw cancelError;

      if (order.product_id) {
        await service.rpc("restore_stock", { p_product_id: order.product_id, p_quantity: order.quantity }).catch(() => {});
      }
      await service.from("activity_events").insert({
        user_id: order.buyer_id, kind: "order_cancelled", order_id: order.id,
        payload: { ref: order.ref, reason: "Cancelled by buyer" },
      });
      sendNotifications(service, [order.seller_id], "Order " + order.ref + " cancelled",
        "The buyer cancelled the unpaid order.", { link: "/seller.html#seller-orders", order: order.ref });
      return json({ ok: true, order: mapBuyerOrder({ ...order, status: "cancelled" }) });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
