import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient } from "../_shared/auth.ts";

/* Wallet summary. Balances are always computed from the
   ledger and escrowed orders server-side — the client
   never supplies a balance. Until a real payment
   provider is connected, both numbers are genuinely 0
   because no money has moved. */

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "summary");

  try {
    if (action === "summary") {
      const balance = await service.rpc("wallet_balance", { p_user: auth.user.id });
      const held = await service.rpc("held_escrow", { p_user: auth.user.id });
      if (balance.error) throw balance.error;
      if (held.error) throw held.error;

      const { data: ledger, error: ledgerError } = await service
        .from("wallet_ledger_entries")
        .select("*")
        .eq("user_id", auth.user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (ledgerError) throw ledgerError;

      const { data: pending, error: pendingError } = await service
        .from("payment_intents")
        .select("id, amount_tzs, status, created_at")
        .eq("buyer_id", auth.user.id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(20);
      if (pendingError) throw pendingError;

      return json({
        ok: true,
        wallet: {
          balance: Number(balance.data || 0),
          held: Number(held.data || 0),
          currency: "TZS",
        },
        ledger: (ledger || []).map((e: any) => ({
          id: e.id,
          orderId: e.order_id,
          type: e.entry_type,
          amount: Number(e.amount_tzs),
          at: e.created_at,
        })),
        pendingPayments: pending || [],
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
