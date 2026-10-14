import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";

/* Seller dashboard aggregation and the public
   verified-seller directory. */

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);
  const staff = await isStaff(service, auth.user.id);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "overview");

  try {
    /* ---------------- seller overview ---------------- */
    if (action === "overview") {
      const stats = await service.rpc("seller_stats", { p_user: auth.user.id });
      const wallet = await service.rpc("wallet_balance", { p_user: auth.user.id });
      const held = await service.rpc("held_escrow", { p_user: auth.user.id });
      if (stats.error) throw stats.error;
      if (wallet.error) throw wallet.error;
      if (held.error) throw held.error;

      const { data: orders, error: ordersError } = await service
        .from("orders")
        .select("*, buyer_profile:buyer_id (display_name, phone_e164)")
        .eq("seller_id", auth.user.id)
        .order("created_at", { ascending: false })
        .limit(10);
      if (ordersError) throw ordersError;

      const { data: activity, error: activityError } = await service
        .from("activity_events")
        .select("*")
        .eq("user_id", auth.user.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (activityError) throw activityError;

      const { data: myOrderIds, error: idsError } = await service
        .from("orders")
        .select("id")
        .eq("seller_id", auth.user.id)
        .limit(200);
      if (idsError) throw idsError;

      let openDisputes: any[] = [];
      const orderIds = (myOrderIds || []).map((o: any) => o.id);
      if (orderIds.length) {
        const { data: disputes, error: disputesError } = await service
          .from("disputes")
          .select("id, ref, reason, created_at, order_id")
          .in("order_id", orderIds)
          .neq("status", "resolved")
          .order("created_at", { ascending: false })
          .limit(5);
        if (disputesError) throw disputesError;
        openDisputes = disputes || [];
      }

      return json({
        ok: true,
        overview: {
          stats: stats.data || {},
          wallet: { balance: Number(wallet.data || 0), held: Number(held.data || 0) },
          orders: orders || [],
          activity: activity || [],
          openDisputes,
        },
      });
    }

    /* ---------------- public seller directory ---------------- */
    if (action === "directory") {
      const query = String(body.q || "").trim().toLowerCase();
      const limit = Math.min(Number(body.limit) || 20, 50);

      let rows: any[] = [];
      if (query) {
        const { data, error } = await service
          .from("seller_profiles")
          .select("user_id, shop_name, kobe_id, region, bio, socials")
          .eq("verification_status", "verified")
          .or(`shop_name.ilike.%${query}%,kobe_id.ilike.%${query}%`)
          .limit(limit);
        if (error) throw error;
        rows = data || [];
      } else {
        const { data, error } = await service
          .from("seller_profiles")
          .select("user_id, shop_name, kobe_id, region, bio, socials")
          .eq("verification_status", "verified")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        rows = data || [];
      }

      const sellers: Record<string, unknown>[] = [];
      for (const row of rows) {
        const stats = await service.rpc("seller_stats", { p_user: row.user_id });
        const s = (stats.data || {}) as Record<string, any>;
        sellers.push({
          userId: row.user_id,
          kid: row.kobe_id,
          name: row.shop_name,
          region: row.region || "",
          about: row.bio || "",
          socials: row.socials || {},
          deals: Number(s.completed || 0),
          rating: s.rating ? Number(s.rating) : 0,
          ratingCount: Number(s.review_count || 0),
          cancelled: Number(s.cancelled || 0),
          disputed: Number(s.disputed || 0),
        });
      }
      return json({ ok: true, sellers });
    }

    /* ---------------- activity feed ---------------- */
    if (action === "activity") {
      const before = body.before ? new Date(String(body.before)).toISOString() : null;
      let query = service
        .from("activity_events")
        .select("*")
        .eq("user_id", auth.user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (before) query = query.lt("created_at", before);
      const { data, error } = await query;
      if (error) throw error;
      return json({ ok: true, activity: data || [] });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
