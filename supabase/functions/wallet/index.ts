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
      const capacity = await service.rpc("seller_payout_capacity", { p_seller: auth.user.id });
      /* The buyer's own Wallet ID. It is their identifier, so it is
         returned to them and to nobody else. */
      const { data: walletRow, error: walletError } = await service
        .from("wallets")
        .select("wallet_id")
        .eq("user_id", auth.user.id)
        .maybeSingle();
      if (walletError) throw walletError;
      /* Whether a sandbox credit is possible. The app uses this to hide
         the test-credit button entirely when it is not. */
      const { data: providerConfig } = await service
        .from("payment_provider_config")
        .select("environment")
        .eq("provider", "azampay")
        .maybeSingle();
      const sandboxAvailable = providerConfig?.environment === "sandbox";
      if (balance.error) throw balance.error;
      if (held.error) throw held.error;
      if (capacity.error) throw capacity.error;

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
          wallet_id: walletRow?.wallet_id || null,
          currency: "TZS",
        },
        /* A seller can only withdraw money that has been released from
           escrow, so the capacity is reported separately from the
           balance. The two must not be shown as the same number. */
        capacity: capacity.data || null,
        /* The app hides the sandbox test-credit button when this is
           false, so it can never appear in production. */
        sandbox_available: sandboxAvailable,
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

    /* ---------------- withdraw ----------------
       The seller asks for money that has already been released from
       escrow. The database checks the released balance; the client
       never states what is available. */
    if (action === "withdraw") {
      const amount = Number(body.amount_tzs || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ApiError(400, "Enter a valid amount");
      }

      const { data: capacity, error: capacityError } = await service.rpc("seller_payout_capacity", {
        p_seller: auth.user.id,
      });
      if (capacityError) throw capacityError;

      const available = Number(capacity?.available_tzs || 0);
      if (amount > available) {
        return json({
          ok: false,
          error: "You can only withdraw money that has been released from escrow.",
          reason: "insufficient_released_balance",
          available_tzs: available,
          held_tzs: Number(capacity?.held_tzs || 0),
        }, 409);
      }

      const { data: payout, error: payoutError } = await service.rpc("request_seller_payout", {
        p_seller_id: auth.user.id,
        p_amount_tzs: Math.round(amount),
        p_method: body.method ? String(body.method) : "mobile_money",
        p_destination: body.destination ? String(body.destination) : null,
        p_requested_by: auth.user.id,
        p_idempotency_key: body.idempotency_key || null,
      });
      if (payoutError) {
        if (/already have a withdrawal/i.test(payoutError.message || "")) {
          return json({
            ok: false,
            error: "You already have a withdrawal waiting to be paid.",
            reason: "outstanding_request",
            outstanding_request: capacity?.outstanding_request ?? null,
          }, 409);
        }
        throw payoutError;
      }

      const row = Array.isArray(payout) ? payout[0] : payout;

      return json({
        ok: true,
        payout: {
          id: row?.id,
          amount_tzs: Number(row?.amount_tzs || amount),
          status: row?.status,
          method: row?.method,
          destination: row?.destination,
          requested_at: row?.created_at,
        },
        available_tzs: available - Math.round(amount),
        held_tzs: Number(capacity?.held_tzs || 0),
      }, 201);
    }

    /* ---------------- the seller's own payout requests ---------------- */
    if (action === "payouts") {
      const { data, error } = await service.rpc("list_my_payout_requests", {
        p_seller: auth.user.id,
      });
      if (error) throw error;
      const { data: capacity, error: capacityError } = await service.rpc("seller_payout_capacity", {
        p_seller: auth.user.id,
      });
      if (capacityError) throw capacityError;
      return json({ ok: true, payouts: data || [], capacity: capacity || null });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
