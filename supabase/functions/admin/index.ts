import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";

/* The operations console.

   Everything here is a read. The console answers questions about the
   platform: what is held in escrow, what is stuck, what needs a person.
   The actions that move money or change someone's status stay in the
   functions that already own them, where they are audited and, where it
   matters, need a second person to approve.

   The caller must be staff. The database functions behind these actions
   are granted to service_role alone, so the console reaches them through
   this function and nowhere else. */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "overview");

  try {
    const staff = await isStaff(service, auth.user.id);
    if (!staff) throw new ApiError(403, "Only operations staff can open the console.");

    if (action === "overview") {
      const { data, error } = await service.rpc("admin_overview");
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return json({ ok: true, overview: row || {} });
    }

    if (action === "orders") {
      const query = body.query ? String(body.query) : null;
      const limit = Number(body.limit) || 50;
      const { data, error } = await service.rpc("admin_order_queue", {
        p_query: query,
        p_limit: limit,
      });
      if (error) throw error;
      return json({ ok: true, orders: data || [] });
    }

    if (action === "disputes") {
      const limit = Number(body.limit) || 50;
      const { data, error } = await service.rpc("admin_dispute_queue", { p_limit: limit });
      if (error) throw error;
      return json({ ok: true, disputes: data || [] });
    }

    if (action === "audit") {
      const limit = Number(body.limit) || 50;
      const offset = Number(body.offset) || 0;
      const { data, error } = await service.rpc("audit_log_page", {
        p_limit: limit,
        p_offset: offset,
        p_action: null,
      });
      if (error) throw error;
      return json({ ok: true, entries: data || [] });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message, reason: api.reason || null }, api.status);
  }
}
