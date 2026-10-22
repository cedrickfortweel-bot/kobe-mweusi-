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
      const select =
        "user_id, shop_name, kobe_id, region, bio, socials, kobe_id_registry(kobe_id)";

      let rows: any[] = [];

      /* A customer searches with the Seller Kobe ID they were given, which
         is the canonical KOBE12XL form. Resolve that to the seller
         first, so the directory can find them even though the search
         column holds the older app-facing id. */
      let resolvedUserId: string | null = null;
      if (query) {
        const { data: ident, error: identError } = await service.rpc(
          "public_seller_identity_by_kid",
          { p_kid: query }
        );
        if (identError) throw identError;
        const row = Array.isArray(ident) ? ident[0] : ident;
        if (row && row.user_id) resolvedUserId = row.user_id as string;
      }

      if (resolvedUserId) {
        const { data, error } = await service
          .from("seller_profiles")
          .select(select)
          .eq("user_id", resolvedUserId)
          .eq("verification_status", "verified")
          .limit(1);
        if (error) throw error;
        rows = data || [];
      } else if (query) {
        const { data, error } = await service
          .from("seller_profiles")
          .select(select)
          .eq("verification_status", "verified")
          .or(`shop_name.ilike.%${query}%,kobe_id.ilike.%${query}%`)
          .limit(limit);
        if (error) throw error;
        rows = data || [];
      } else {
        const { data, error } = await service
          .from("seller_profiles")
          .select(select)
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
        const registry = Array.isArray(row.kobe_id_registry)
          ? row.kobe_id_registry[0]
          : row.kobe_id_registry;
        sellers.push({
          userId: row.user_id,
          /* The canonical Seller Kobe ID is what a customer reads. The
             app-facing id is kept so an old link still resolves. */
          kid: (registry && registry.kobe_id) || row.kobe_id,
          appKid: row.kobe_id,
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

    /* ---------------- the staff payout queue ----------------
       A seller requests a withdrawal of money that has already been
       released from escrow. Staff approve it here. The money leaves the
       seller's ledger when the payout is approved. */
    if (action === "payouts") {
      if (!staff) throw new ApiError(403, "Only staff can review payouts.");
      const { data, error } = await service.rpc("list_pending_payout_requests");
      if (error) throw error;
      return json({ ok: true, payouts: data || [] });
    }

    if (action === "approve-payout") {
      if (!staff) throw new ApiError(403, "Only staff can approve payouts.");
      const payoutId = String(body.payout_id || "");
      if (!payoutId) throw new ApiError(400, "A payout id is required");

      const { data, error } = await service.rpc("approve_payout", {
        p_payout_id: payoutId,
        p_approver_id: auth.user.id,
        p_provider_reference: body.provider_reference ? String(body.provider_reference) : null,
      });
      if (error) throw error;
      return json({ ok: true, payout: Array.isArray(data) ? data[0] : data });
    }

    /* ---------------- the delivery agent network ----------------
       Staff decide who may scan. An agent needs a delivery_agents row, a
       worker ID to show at the handover, and a region they work in. The
       orders they carry are assigned here as well, and only a verified
       agent can be given one. */
    if (action === "agents") {
      if (!staff) throw new ApiError(403, "Only staff can manage agents.");

      const { data: agents, error } = await service
        .from("delivery_agents")
        .select("user_id,worker_id,region,verification_status,verified_at,created_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;

      const ids = (agents || []).map(agent => agent.user_id).filter(Boolean);
      const people = ids.length
        ? (await service.from("profiles").select("id,display_name,phone_e164").in("id", ids)).data || []
        : [];

      const { data: assignments } = await service
        .from("delivery_assignments")
        .select("order_id,agent_user_id,status,created_at")
        .limit(500);

      const orderIds = [...new Set((assignments || []).map(row => row.order_id).filter(Boolean))];
      const orders = orderIds.length
        ? (await service.from("orders").select("id,ref,item_name,status").in("id", orderIds)).data || []
        : [];

      const orderById = new Map(orders.map(order => [order.id, order]));
      const peopleById = new Map(people.map(person => [person.id, person]));
      const assignmentsByAgent = new Map<string, Record<string, unknown>[]>();
      (assignments || []).forEach(row => {
        const list = assignmentsByAgent.get(row.agent_user_id) || [];
        const order = orderById.get(row.order_id);
        list.push({
          order_id: row.order_id,
          status: row.status,
          ref: order?.ref || null,
          item_name: order?.item_name || null,
          order_status: order?.status || null,
        });
        assignmentsByAgent.set(row.agent_user_id, list);
      });

      return json({
        ok: true,
        agents: (agents || []).map(agent => ({
          user_id: agent.user_id,
          worker_id: agent.worker_id,
          region: agent.region,
          verification_status: agent.verification_status,
          verified_at: agent.verified_at,
          display_name: peopleById.get(agent.user_id)?.display_name || null,
          phone_e164: peopleById.get(agent.user_id)?.phone_e164 || null,
          assignments: assignmentsByAgent.get(agent.user_id) || [],
        })),
      });
    }

    if (action === "set-agent-identity") {
      if (!staff) throw new ApiError(403, "Only staff can manage agents.");
      const agentId = String(body.agent_id || "");
      if (!agentId) throw new ApiError(400, "An agent is required");
      const workerId = body.worker_id === null || body.worker_id === undefined
        ? null
        : String(body.worker_id);
      const region = body.region ? String(body.region) : null;

      const { data, error } = await service.rpc("set_agent_worker_identity", {
        p_agent_id: agentId,
        p_worker_id: workerId,
        p_region: region,
        p_reviewer_id: auth.user.id,
      });
      if (error) throw error;
      return json({ ok: true, agent: Array.isArray(data) ? data[0] : data });
    }

    if (action === "set-agent-verification") {
      if (!staff) throw new ApiError(403, "Only staff can manage agents.");
      const agentId = String(body.agent_id || "");
      if (!agentId) throw new ApiError(400, "An agent is required");
      const verified = body.verified === true;

      const { data, error } = await service.rpc("set_agent_verification", {
        p_agent_id: agentId,
        p_verified: verified,
        p_reviewer_id: auth.user.id,
      });
      if (error) throw error;
      return json({ ok: true, agent: Array.isArray(data) ? data[0] : data });
    }

    if (action === "assign-agent") {
      if (!staff) throw new ApiError(403, "Only staff can assign agents.");
      const orderRef = String(body.order_ref || "").trim().toUpperCase();
      const agentId = String(body.agent_id || "");
      if (!/^KM-\d{6}$/.test(orderRef)) throw new ApiError(400, "Enter a valid order reference");
      if (!agentId) throw new ApiError(400, "An agent is required");

      const { data: order, error: orderError } = await service
        .from("orders")
        .select("id,ref")
        .eq("ref", orderRef)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) throw new ApiError(404, "That order does not exist");

      const { data, error } = await service.rpc("assign_delivery_agent", {
        p_order_id: order.id,
        p_agent_id: agentId,
        p_assigned_by: auth.user.id,
      });
      if (error) throw error;
      return json({ ok: true, assignment: Array.isArray(data) ? data[0] : data });
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
