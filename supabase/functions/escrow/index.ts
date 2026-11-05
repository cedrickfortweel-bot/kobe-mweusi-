import { json, ApiError, asApiError, corsHeaders } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";

/* The escrow Edge Function.

   It is the HTTP surface for the escrow release rules that live in
   PostgreSQL. The function itself never moves money directly: it asks the
   database to evaluate the release conditions and, when they are met, asks
   the database to release. All the money logic stays in one place.

   Actions
     status    the caller's escrow timers and release decisions
     evaluate  the decision for one order
     confirm   the buyer confirms receipt (releases immediately)
     release   re-evaluate and release if eligible
     scan      record a handoff QR scan (see the handoff function)
*/

const ORDER_REF = /^KM-\d{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* The app knows orders by their reference (KM-000001), the database by
   their uuid. Accept either so the client never has to translate. */
async function resolveOrderId(
  service: ReturnType<typeof serviceClient>,
  orderRefOrId: string
): Promise<string> {
  const value = String(orderRefOrId || "").trim();
  if (UUID.test(value)) return value;
  if (ORDER_REF.test(value.toUpperCase())) {
    const { data, error } = await service
      .from("orders")
      .select("id")
      .eq("ref", value.toUpperCase())
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ApiError(404, "Order not found");
    return data.id as string;
  }
  throw new ApiError(400, "Enter a valid order reference");
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);
  const staff = await isStaff(service, auth.user.id);

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const action = String(body.action || "status");

  try {
    /* ---------------- wallet: the caller's own Wallet ID ---------------- */
    if (action === "wallet") {
      /* This function uses the service-role client, which has no caller
         auth.uid(). Pass the identity already verified by verifyUser. */
      const { data, error } = await service.rpc("ensure_wallet_for", {
        p_user: auth.user.id,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return json({ ok: true, wallet_id: row?.wallet_id ?? null });
    }

    /* ---------------- status: every order waiting on money ---------------- */
    if (action === "status") {
      const { data, error } = await service.rpc("my_escrow_timers");
      if (error) throw error;
      return json({ ok: true, timers: data ?? [] });
    }

    /* ---------------- evaluate: the decision for one order ---------------- */
    if (action === "evaluate") {
      const orderId = await resolveOrderId(service, String(body.order_id || body.order_ref || ""));
      if (!orderId) throw new ApiError(400, "An order id is required");

      await assertParticipant(service, orderId, auth.user.id, staff);

      const { data, error } = await service.rpc("evaluate_escrow_release", {
        p_order_id: orderId,
      });
      if (error) throw error;

      const decision = Array.isArray(data) ? data[0] : data;
      return json({ ok: true, decision: decision ?? null });
    }

    /* ---------------- confirm: the buyer confirms receipt ---------------- */
    if (action === "confirm") {
      const limit = await consumeRateLimit(service, "escrow_confirm", auth.user.id, 20, 60);
      if (!limit.allowed) return json({ error: "Too many requests. Please wait a moment." }, 429);

      const orderId = await resolveOrderId(service, String(body.order_id || body.order_ref || ""));
      if (!orderId) throw new ApiError(400, "An order id is required");

      const { data, error } = await service.rpc("confirm_receipt", { p_order_id: orderId });
      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.ok) {
        return json(
          {
            ok: false,
            confirmed: Boolean(result?.confirmed),
            reason: result?.decision?.reason ?? "not_eligible",
            message: explain(result?.decision?.reason),
          },
          409
        );
      }
      return json({ ok: true, result });
    }

    /* ---------------- release: evaluate then release if eligible -------- */
    if (action === "release") {
      const limit = await consumeRateLimit(service, "escrow_release", auth.user.id, 20, 60);
      if (!limit.allowed) return json({ error: "Too many requests. Please wait a moment." }, 429);

      const orderId = await resolveOrderId(service, String(body.order_id || body.order_ref || ""));
      if (!orderId) throw new ApiError(400, "An order id is required");

      await assertParticipant(service, orderId, auth.user.id, staff);

      const { data, error } = await service.rpc("release_escrow_funds", {
        p_order_id: orderId,
        p_reason: "buyer_requested_release",
      });
      if (error) throw error;

      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.ok) {
        return json(
          {
            ok: false,
            reason: result?.decision?.reason ?? "not_eligible",
            message: explain(result?.decision?.reason),
            decision: result?.decision ?? null,
          },
          409
        );
      }
      return json({ ok: true, result });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}

/* Only the buyer, the seller or staff may read an order's escrow state. */
async function assertParticipant(
  service: ReturnType<typeof serviceClient>,
  orderId: string,
  userId: string,
  staff: boolean
): Promise<void> {
  const { data, error } = await service
    .from("orders")
    .select("buyer_id, seller_id")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "Order not found");
  if (staff) return;
  if (data.buyer_id !== userId && data.seller_id !== userId) {
    throw new ApiError(403, "You are not part of this order");
  }
}

/* Turn a release reason into something a customer can read. */
function explain(reason: string | undefined): string {
  switch (reason) {
    case "awaiting_buyer_scan":
      return "The buyer still needs to scan the seller's code before the timer can start.";
    case "awaiting_buyer":
      return "Waiting for the buyer to confirm that the item was received.";
    case "waiting_for_window":
      return "The three-hour release window is still running.";
    case "open_dispute":
      return "This order has an open dispute, so the money stays frozen until support decides.";
    case "on_hold":
      return "This payment is on hold. Support will contact you.";
    case "auto_release_disabled":
      return "Automatic release is currently switched off for this order.";
    case "no_handoff_recorded":
      return "The handoff has not been recorded yet.";
    case "already_released":
      return "This order has already been paid out.";
    default:
      return "This order is not ready to be released yet.";
  }
}
