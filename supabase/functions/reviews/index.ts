import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";
import { sendNotifications } from "../_shared/push.ts";

/* Reviews can only be written by the buyer of a
   completed order, once per order. A seller can never
   review their own order, and a review can never be
   attached to an order the reviewer did not pay for. */

const ORDER_REF = /^KM-\d{6}$/;

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);
  const staff = await isStaff(service, auth.user.id);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "submit");

  try {
    /* ---------------- submit ---------------- */
    if (action === "submit") {
      const limit = await consumeRateLimit(service, "review_submit", auth.user.id, 10, 3600);
      if (!limit.allowed) return json({ error: "Too many reviews this hour." }, 429);

      const ref = String(body.order_ref || "").trim().toUpperCase();
      const stars = Number(body.stars || 0);
      const comment = String(body.comment || "").trim();
      const tags = Array.isArray(body.tags) ? body.tags.map(String).filter(t => t && t.length <= 50).slice(0, 4) : [];

      if (!ORDER_REF.test(ref)) throw new ApiError(400, "Enter a valid order reference");
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new ApiError(400, "Pick 1 to 5 stars");
      if (comment.length > 2000) throw new ApiError(400, "Keep the review under 2000 characters");

      const { data: order, error: orderError } = await service
        .from("orders")
        .select("id, seller_id, buyer_id, status")
        .eq("ref", ref)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) throw new ApiError(404, "Order not found");
      if (order.buyer_id !== auth.user.id) throw new ApiError(403, "Only the buyer can review this order");
      if (order.seller_id === auth.user.id) throw new ApiError(403, "You cannot review your own shop");
      if (order.status !== "completed") throw new ApiError(409, "Reviews unlock after a completed order");

      const { data: existing, error: existingError } = await service
        .from("reviews")
        .select("id")
        .eq("order_id", order.id)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existing) throw new ApiError(409, "You already reviewed this order");

      const { data: review, error: reviewError } = await service
        .from("reviews")
        .insert({ order_id: order.id, stars, comment, tags })
        .select("*")
        .single();
      if (reviewError) throw reviewError;

      await service.from("activity_events").insert({
        user_id: order.seller_id, kind: "review_received", order_id: order.id,
        payload: { stars, order_ref: ref },
      });

      sendNotifications(service, [order.seller_id], "New review for order " + ref,
        "A buyer rated your shop " + stars + " of 5.",
        { link: "/seller.html#seller-page", order: ref });

      return json({ ok: true, review: { id: review.id, stars, comment } }, 201);
    }

    /* ---------------- seller's public reviews ---------------- */
    if (action === "seller") {
      const kobeId = String(body.kobe_id || "").trim().toUpperCase();
      const { data: seller, error: sellerError } = await service
        .from("seller_profiles")
        .select("user_id")
        .eq("kobe_id", kobeId)
        .maybeSingle();
      if (sellerError) throw sellerError;
      if (!seller) throw new ApiError(404, "Seller not found");

      const { data: rows, error: rowsError } = await service
        .from("reviews")
        .select("stars, comment, tags, created_at, order_id")
        .order("created_at", { ascending: false })
        .limit(100);
      if (rowsError) throw rowsError;

      /* Filter server-side by joining order ownership in a
         second query, so only this seller's reviews return. */
      const reviews: any[] = [];
      for (const row of rows || []) {
        const { data: orderRow } = await service
          .from("orders")
          .select("seller_id")
          .eq("id", row.order_id)
          .maybeSingle();
        if (orderRow && orderRow.seller_id === seller.user_id) reviews.push(row);
        if (reviews.length >= 50) break;
      }

      const avg = reviews.length
        ? Math.round((reviews.reduce((sum: number, r: any) => sum + Number(r.stars), 0) / reviews.length) * 10) / 10
        : 0;

      return json({
        ok: true,
        reviews: reviews.map((r: any) => ({
          stars: r.stars,
          comment: r.comment,
          tags: r.tags || [],
          createdAt: r.created_at,
        })),
        average: avg,
        count: reviews.length,
      });
    }

    /* ---------------- caller's own reviews ---------------- */
    if (action === "mine") {
      const { data: mine, error } = await service
        .from("reviews")
        .select("id, stars, comment, tags, created_at, order_id")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;

      const reviews: any[] = [];
      for (const row of mine || []) {
        const { data: orderRow } = await service
          .from("orders")
          .select("ref, seller_id, buyer_id")
          .eq("id", row.order_id)
          .maybeSingle();
        if (orderRow && orderRow.buyer_id === auth.user.id) {
          reviews.push({ ...row, order_ref: orderRow.ref });
        }
      }
      return json({ ok: true, reviews });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
