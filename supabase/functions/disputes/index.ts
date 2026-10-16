import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";
import { sendNotifications } from "../_shared/push.ts";

const DISPUTE_REASONS = [
  "Item damaged / not as described",
  "Wrong item",
  "Never received",
  "Seller asked to cancel payment",
  "Other problem",
];

const OUTCOMES: Record<string, string> = {
  buyer_refund: "Refund issued to you",
  seller_release: "Payment released to seller",
  split: "Split decision",
};

const SELLER_REPLY_WINDOW_MS = 48 * 3600 * 1000;
const DISPUTE_REF = /^DSP-\d{6}$/;
const ORDER_REF = /^KM-\d{6}$/;

function newDisputeRef(): string {
  return "DSP-" + Math.floor(100000 + Math.random() * 900000).toString();
}

async function insertDisputeWithRef(service: any, base: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const ref = newDisputeRef();
    const { data, error } = await service.from("disputes").insert({ ...base, ref }).select("*").single();
    if (!error) return data;
    if (error.code !== "23505") throw error;
  }
  throw new ApiError(500, "Could not assign a dispute reference. Please try again.");
}

/* Canonical dispute used by both the buyer and the seller app;
   each app renders the fields it needs. */
async function mapDisputes(service: any, rows: any[], viewerId: string) {
  const ids = rows.map((row: any) => row.id);
  const messages: Record<string, any[]> = {};
  const evidence: Record<string, any[]> = {};

  if (ids.length) {
    const { data: msgs } = await service
      .from("dispute_messages")
      .select("*")
      .in("dispute_id", ids)
      .order("created_at", { ascending: true });
    (msgs || []).forEach((m: any) => {
      (messages[m.dispute_id] = messages[m.dispute_id] || []).push(m);
    });

    const { data: ev } = await service
      .from("dispute_evidence")
      .select("*")
      .in("dispute_id", ids)
      .order("created_at", { ascending: true });
    const paths = (ev || []).map((e: any) => e.storage_path);
    let signed: { signedUrl: string }[] = [];
    if (paths.length) {
      const urls = await service.storage
        .from("dispute-evidence")
        .createSignedUrls(paths, 120);
      signed = urls.data || [];
    }
    (ev || []).forEach((e: any, i: number) => {
      const name = String(e.storage_path).split("/").pop() || "";
      (evidence[e.dispute_id] = evidence[e.dispute_id] || []).push({
        id: e.id,
        senderId: e.sender_id,
        path: e.storage_path,
        name: name.replace(/^[0-9a-f-]+-/, ""),
        createdAt: e.created_at,
        url: signed[i]?.signedUrl || "",
      });
    });
  }

  return rows.map((row: any) => {
    const order = row.orders || {};
    const sellerName = order.seller_profiles?.shop_name || "Seller";
    const buyerName = order.buyer_profile?.display_name || "Buyer";
    return {
      id: row.ref,
      disputeId: row.id,
      orderId: order.ref,
      orderIdUuid: row.order_id,
      sellerId: order.seller_id,
      buyerId: order.buyer_id,
      sellerName,
      buyerName,
      item: order.item_name || "",
      amount: Number(order.subtotal_tzs || 0),
      reason: row.reason,
      description: row.description,
      status: row.status === "open" ? "Open" : row.status === "under_review" ? "Under review" : "Resolved",
      outcome: row.outcome ? OUTCOMES[row.outcome] || row.outcome : null,
      createdAt: new Date(row.created_at).getTime(),
      sellerDeadline: new Date(row.seller_deadline).getTime(),
      sellerRepliedAt: row.replied_at ? new Date(row.replied_at).getTime() : null,
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).getTime() : null,
      messages: (messages[row.id] || []).map((m: any) => ({
        id: m.id,
        senderId: m.sender_id,
        from: m.sender_id === viewerId ? "You" : (m.sender_id === order.seller_id ? sellerName : buyerName),
        text: m.body,
        at: new Date(m.created_at).toISOString(),
      })),
      evidence: evidence[row.id] || [],
    };
  });
}

async function loadDispute(service: any, ref: string, viewerId: string, staff: boolean) {
  const { data: row, error } = await service
    .from("disputes")
    .select(`*,
      orders:order_id (
        *,
        seller_profiles:seller_id (shop_name, kobe_id),
        buyer_profile:buyer_id (display_name, phone_e164)
      )`)
    .eq("ref", ref)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new ApiError(404, "Dispute not found");
  const order = row.orders || {};
  const participant = row.opened_by === viewerId || order.buyer_id === viewerId || order.seller_id === viewerId;
  if (!staff && !participant) throw new ApiError(403, "You are not part of this dispute");
  return row;
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
    /* ---------------- list ---------------- */
    if (action === "list") {
      const { data: mine } = await service
        .from("disputes")
        .select(`*, orders:order_id (*, seller_profiles:seller_id (shop_name), buyer_profile:buyer_id (display_name))`)
        .eq("opened_by", auth.user.id)
        .order("created_at", { ascending: false })
        .limit(100);

      const { data: myOrders } = await service
        .from("orders")
        .select("id")
        .eq("seller_id", auth.user.id)
        .limit(200);
      const sellerOrderIds = (myOrders || []).map((o: any) => o.id);
      let asSeller: any[] = [];
      if (sellerOrderIds.length) {
        const { data: theirs } = await service
          .from("disputes")
          .select(`*, orders:order_id (*, seller_profiles:seller_id (shop_name), buyer_profile:buyer_id (display_name))`)
          .in("order_id", sellerOrderIds)
          .neq("opened_by", auth.user.id)
          .order("created_at", { ascending: false })
          .limit(100);
        asSeller = theirs || [];
      }

      const merged = [...(mine || []), ...asSeller]
        .sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, 100);
      const disputes = await mapDisputes(service, merged, auth.user.id);
      return json({ ok: true, disputes });
    }

    /* ---------------- get ---------------- */
    if (action === "get") {
      const ref = String(body.dispute_ref || "").trim().toUpperCase();
      if (!DISPUTE_REF.test(ref)) throw new ApiError(400, "Enter a valid dispute reference");
      const row = await loadDispute(service, ref, auth.user.id, staff);
      const [dispute] = await mapDisputes(service, [row], auth.user.id);
      return json({ ok: true, dispute });
    }

    /* ---------------- open ---------------- */
    if (action === "open") {
      const limit = await consumeRateLimit(service, "dispute_open", auth.user.id, 5, 3600);
      if (!limit.allowed) return json({ error: "Too many disputes opened this hour. Contact support." }, 429);

      const ref = String(body.order_ref || "").trim().toUpperCase();
      const reason = String(body.reason || "");
      const description = String(body.description || "").trim();
      if (!ORDER_REF.test(ref)) throw new ApiError(400, "Enter a valid order reference");
      if (!DISPUTE_REASONS.includes(reason)) throw new ApiError(400, "Choose a valid dispute reason");
      if (description.length < 10 || description.length > 5000) {
        throw new ApiError(400, "Describe the problem in 10 to 5000 characters");
      }

      const { data: order, error: orderError } = await service
        .from("orders")
        .select("*, seller_profiles:seller_id (shop_name)")
        .eq("ref", ref)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) throw new ApiError(404, "Order not found");
      if (order.buyer_id !== auth.user.id) throw new ApiError(403, "Only the buyer can open a dispute for this order");
      if (order.status !== "in_escrow") {
        throw new ApiError(409, "Disputes are only possible while money is held in escrow");
      }

      const dispute = await insertDisputeWithRef(service, {
        order_id: order.id,
        opened_by: auth.user.id,
        reason,
        description,
        status: "open",
        seller_deadline: new Date(Date.now() + SELLER_REPLY_WINDOW_MS).toISOString(),
      });

      const { error: statusError } = await service
        .from("orders")
        .update({ status: "disputed" })
        .eq("id", order.id)
        .eq("status", "in_escrow");
      if (statusError) throw statusError;

      await service.from("activity_events").insert([
        { user_id: auth.user.id, kind: "dispute_opened", dispute_id: dispute.id, order_id: order.id, payload: { ref: dispute.ref, reason } },
        { user_id: order.seller_id, kind: "dispute_opened", dispute_id: dispute.id, order_id: order.id, payload: { ref: dispute.ref, reason, buyer: auth.user.id } },
      ]);

      sendNotifications(service, [order.seller_id], "Dispute " + dispute.ref + " opened",
        "A buyer reported a problem with order " + order.ref + ". Reply within 48 hours.",
        { link: "/seller.html#seller-disputes", dispute: dispute.ref });

      return json({ ok: true, dispute: { id: dispute.ref, disputeId: dispute.id, orderId: ref, status: "Open" } }, 201);
    }

    /* ---------------- reply ---------------- */
    if (action === "reply") {
      const limit = await consumeRateLimit(service, "dispute_reply", auth.user.id, 30, 60);
      if (!limit.allowed) return json({ error: "Too many messages. Please wait a moment." }, 429);

      const ref = String(body.dispute_ref || "").trim().toUpperCase();
      const text = String(body.text || "").trim();
      const paths = Array.isArray(body.evidence_paths) ? body.evidence_paths.map(String) : [];
      if (!DISPUTE_REF.test(ref)) throw new ApiError(400, "Enter a valid dispute reference");
      if (text.length < 1 || text.length > 2000) throw new ApiError(400, "Message must be 1 to 2000 characters");
      if (paths.length > 6) throw new ApiError(400, "Attach at most 6 evidence files");

      const row = await loadDispute(service, ref, auth.user.id, staff);
      if (row.status === "resolved") throw new ApiError(409, "This dispute is resolved");

      const order = row.order_id;
      const { data: orderRow } = await service.from("orders").select("buyer_id, seller_id").eq("id", order).maybeSingle();
      const isSeller = orderRow && orderRow.seller_id === auth.user.id;
      const otherParty = orderRow ? (isSeller ? orderRow.buyer_id : orderRow.seller_id) : null;

      const prefix = row.id + "/";
      for (const path of paths) {
        if (!path.startsWith(prefix) || path.length > 300 || path.includes("..")) {
          throw new ApiError(400, "Invalid evidence path");
        }
      }
      const { data: knownRows } = await service
        .from("dispute_evidence")
        .select("storage_path")
        .eq("dispute_id", row.id);
      const known = new Set((knownRows || []).map((e: any) => e.storage_path));
      const fresh = paths.filter((p: string) => !known.has(p));
      if (fresh.length) {
        const { error: insertError } = await service.from("dispute_evidence").insert(
          fresh.map((p: string) => ({ dispute_id: row.id, sender_id: auth.user.id, storage_path: p }))
        );
        if (insertError) throw insertError;
      }

      const { data: message, error: messageError } = await service.from("dispute_messages").insert({
        dispute_id: row.id,
        sender_id: auth.user.id,
        body: text,
      }).select("*").single();
      if (messageError) throw messageError;

      if (isSeller) {
        await service.from("disputes").update({ replied_at: new Date().toISOString() }).eq("id", row.id);
      }

      await service.from("activity_events").insert({
        user_id: auth.user.id, kind: "dispute_reply", dispute_id: row.id, order_id: order,
        payload: { ref: row.ref, is_seller: !!isSeller },
      });

      if (otherParty) {
        sendNotifications(service, [otherParty], "New message in dispute " + row.ref,
          isSeller ? "The seller replied to your dispute." : "The buyer sent a new message in the dispute.",
          { link: "/buyer.html#dispute/" + row.ref, dispute: row.ref });
      }

      return json({ ok: true, message: { id: message.id, createdAt: message.created_at } });
    }

    /* ---------------- evidence ---------------- */
    if (action === "evidence") {
      const ref = String(body.dispute_ref || "").trim().toUpperCase();
      const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
      if (!DISPUTE_REF.test(ref)) throw new ApiError(400, "Enter a valid dispute reference");
      if (paths.length < 1 || paths.length > 6) throw new ApiError(400, "Attach 1 to 6 evidence files");

      const row = await loadDispute(service, ref, auth.user.id, staff);
      if (row.status === "resolved") throw new ApiError(409, "This dispute is resolved");

      const prefix = row.id + "/";
      for (const path of paths) {
        if (!path.startsWith(prefix) || path.length > 300 || path.includes("..")) {
          throw new ApiError(400, "Invalid evidence path");
        }
      }

      const { data: existing } = await service
        .from("dispute_evidence")
        .select("storage_path")
        .eq("dispute_id", row.id);
      const known = new Set((existing || []).map((e: any) => e.storage_path));
      const fresh = paths.filter((p: string) => !known.has(p));

      if (fresh.length) {
        const { error: insertError } = await service.from("dispute_evidence").insert(
          fresh.map((p: string) => ({ dispute_id: row.id, sender_id: auth.user.id, storage_path: p }))
        );
        if (insertError) throw insertError;
      }

      const { data: ev } = await service
        .from("dispute_evidence")
        .select("*")
        .eq("dispute_id", row.id)
        .order("created_at", { ascending: true });
      const allPaths = (ev || []).map((e: any) => e.storage_path);
      const urls = allPaths.length ? (await service.storage.from("dispute-evidence").createSignedUrls(allPaths, 120)).data || [] : [];
      const evidence = (ev || []).map((e: any, i: number) => ({
        id: e.id,
        senderId: e.sender_id,
        path: e.storage_path,
        name: String(e.storage_path).split("/").pop() || "",
        url: urls[i]?.signedUrl || "",
      }));

      return json({ ok: true, evidence });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
