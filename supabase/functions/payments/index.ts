import { json, ApiError, asApiError, corsHeaders } from "../_shared/http.ts";
import { verifyUser, serviceClient } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";

/* The payments Edge Function.

   Two very different callers use this endpoint, and they are kept apart.

   1. A signed-in BUYER asks to pay for an order.
        action: "intent"   create a payment intent for an order
        action: "status"   read the payment and escrow state of an order

   2. The PAYMENT PROVIDER calls back with a confirmed capture.
        action: "callback"  no user session: the request is authenticated
                            by a provider signature instead

   The callback path is the only place that moves the buyer's money into
   escrow, and it does so by calling the database function that verifies
   the amount against the order. A replayed callback cannot credit the
   buyer twice: the provider event id is recorded once and the ledger
   entries are keyed by idempotency key.

   The provider signature is checked HERE, in the Edge Function, because
   the provider secret lives in the function secrets and never in the
   database.
*/

const ORDER_REF = /^KM-\d{6}$/;

/* AzamPay signs the raw request body with the shared secret. The exact
   algorithm depends on the account configuration, so the comparison is
   done on the raw body bytes with a constant-time compare. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyProviderSignature(
  rawBody: string,
  signature: string | null
): Promise<boolean> {
  const secret = Deno.env.get("PAYMENT_PROVIDER_WEBHOOK_SECRET");
  if (!secret) return false;
  if (!signature) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, signature.toLowerCase());
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await request.text();
  let body: Record<string, unknown> = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const action = String(body.action || "intent");

  /* ---------------- provider callback: no user session ---------------- */
  if (action === "callback") {
    return await handleCallback(request, rawBody, body);
  }

  /* ---------------- everything else needs a signed-in user -------------- */
  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);

  try {
    /* ---------------- sandbox credit ----------------
       Lets the whole flow be walked end to end before the payment
       provider is connected. The database refuses unless the provider
       is configured for the sandbox, so it cannot run in production. */
    if (action === "sandbox-topup") {
      const amount = Number(body.amount_tzs || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ApiError(400, "Enter a valid amount");
      }

      const { data: config, error: configError } = await service
        .from("payment_provider_config")
        .select("environment")
        .eq("provider", "azampay")
        .maybeSingle();
      if (configError) throw configError;
      if (!config || config.environment !== "sandbox") {
        throw new ApiError(403, "Sandbox top-ups are only available while the payment provider is in the sandbox environment.");
      }

      const { data, error } = await service.rpc("sandbox_wallet_credit", {
        p_buyer_id: auth.user.id,
        p_amount_tzs: Math.round(amount),
        p_note: body.note ? String(body.note) : null,
      });
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      return json({
        ok: true,
        sandbox: true,
        amount_tzs: Number(row?.amount_tzs || amount),
        balance_tzs: Number(row?.balance_tzs || 0),
        message: "Sandbox credit added. No money was taken from anywhere.",
      }, 201);
    }

    /* ---------------- top up the wallet ----------------
       The buyer tops up through the payment provider. The money then
       sits in the wallet, and a purchase moves it from the wallet into
       escrow. The provider is only involved here. */
    if (action === "topup") {
      const limit = await consumeRateLimit(service, "wallet_topup", auth.user.id, 5, 60);
      if (!limit.allowed) return json({ error: "Too many requests. Please wait a moment." }, 429);

      const amount = Number(body.amount_tzs || 0);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ApiError(400, "Enter a valid top-up amount");
      }
      if (amount > 100000000) {
        throw new ApiError(400, "A single top-up cannot exceed 100,000,000 TZS");
      }

      const idempotencyKey = String(body.idempotency_key || `topup:${auth.user.id}:${amount}`);

      const { data: intent, error: intentError } = await service.rpc("request_wallet_topup", {
        p_buyer_id: auth.user.id,
        p_amount_tzs: Math.round(amount),
        p_idempotency_key: idempotencyKey,
        p_provider: "azampay",
      });
      if (intentError) throw intentError;

      const row = Array.isArray(intent) ? intent[0] : intent;

      const { data: providerConfig } = await service
        .from("payment_provider_config")
        .select("is_enabled, environment, merchant_identifier, supported_methods")
        .eq("provider", "azampay")
        .maybeSingle();

      if (!providerConfig?.is_enabled) {
        /* The provider is not connected yet. The intent exists, but no
           money has moved and the balance is unchanged. Saying so is
           the honest answer. */
        return json({
          ok: false,
          error: "Mobile money top-up is not connected yet",
          reason: "provider_disabled",
          amount_tzs: Math.round(amount),
          payment_intent_id: row?.id ?? null,
          message:
            "Top-ups are being connected. No money has been taken and your balance has not changed.",
        });
      }

      return json({
        ok: true,
        amount_tzs: Math.round(amount),
        payment_intent_id: row?.id ?? null,
        provider: "azampay",
        environment: providerConfig.environment,
        merchant_identifier: providerConfig.merchant_identifier,
        methods: providerConfig.supported_methods,
      });
    }

    if (action === "intent") {
      const limit = await consumeRateLimit(service, "payment_intent", auth.user.id, 10, 60);
      if (!limit.allowed) return json({ error: "Too many requests. Please wait a moment." }, 429);

      const ref = String(body.order_ref || "").trim().toUpperCase();
      if (!ORDER_REF.test(ref)) throw new ApiError(400, "Enter a valid order reference");

      const { data: order, error: orderError } = await service
        .from("orders")
        .select("id, buyer_id, status, total_due_tzs, ref")
        .eq("ref", ref)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) throw new ApiError(404, "Order not found");
      if (order.buyer_id !== auth.user.id) {
        throw new ApiError(403, "You are not the buyer on this order");
      }
      if (order.status !== "awaiting_payment") {
        throw new ApiError(409, "This order is not awaiting payment");
      }

      /* The idempotency key ties a repeated tap to one payment intent. */
      const idempotencyKey = String(body.idempotency_key || `intent:${ref}`);

      const { data: intent, error: intentError } = await service.rpc("create_payment_intent", {
        p_buyer_id: auth.user.id,
        p_order_id: order.id,
        p_amount_tzs: order.total_due_tzs,
        p_idempotency_key: idempotencyKey,
        p_provider: "azampay",
      });
      if (intentError) throw intentError;

      const row = Array.isArray(intent) ? intent[0] : intent;

      /* The provider call itself is intentionally not made here. Until the
         provider account is connected, the app must not pretend that a
         payment succeeded, so this returns an honest refusal with the
         amount the buyer must pay. */
      const { data: providerConfig } = await service
        .from("payment_provider_config")
        .select("is_enabled, environment, merchant_identifier, supported_methods")
        .eq("provider", "azampay")
        .maybeSingle();

      if (!providerConfig?.is_enabled) {
        return json({
          ok: false,
          error: "Payments are not enabled yet",
          order_ref: order.ref,
          amount_tzs: order.total_due_tzs,
          payment_intent_id: row?.id ?? null,
          message:
            "Mobile money payments are being connected. Your order is reserved and no money has moved.",
        });
      }

      return json({
        ok: true,
        order_ref: order.ref,
        amount_tzs: order.total_due_tzs,
        payment_intent_id: row?.id ?? null,
        provider: "azampay",
        environment: providerConfig.environment,
        merchant_identifier: providerConfig.merchant_identifier,
        methods: providerConfig.supported_methods,
      });
    }

    if (action === "status") {
      const ref = String(body.order_ref || "").trim().toUpperCase();
      if (!ORDER_REF.test(ref)) throw new ApiError(400, "Enter a valid order reference");

      const { data: order, error: orderError } = await service
        .from("orders")
        .select("id, ref, status, total_due_tzs, subtotal_tzs, buyer_id, seller_id")
        .eq("ref", ref)
        .maybeSingle();
      if (orderError) throw orderError;
      if (!order) throw new ApiError(404, "Order not found");
      if (order.buyer_id !== auth.user.id && order.seller_id !== auth.user.id) {
        throw new ApiError(403, "You are not part of this order");
      }

      const { data: intents } = await service
        .from("payment_intents")
        .select("id, status, amount_tzs, provider, created_at")
        .eq("order_id", order.id)
        .order("created_at", { ascending: false })
        .limit(1);

      const { data: escrow } = await service
        .from("escrow_transactions")
        .select("status, amount_tzs, funded_at, released_at, release_scheduled_for")
        .eq("order_id", order.id)
        .maybeSingle();

      const { data: decision } = await service.rpc("evaluate_escrow_release", {
        p_order_id: order.id,
      });

      return json({
        ok: true,
        order_ref: order.ref,
        order_status: order.status,
        amount_tzs: order.total_due_tzs,
        payment: Array.isArray(intents) ? intents[0] ?? null : null,
        escrow: escrow ?? null,
        decision: Array.isArray(decision) ? decision[0] ?? null : decision ?? null,
      });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}

/* The provider callback. */
async function handleCallback(
  request: Request,
  rawBody: string,
  body: Record<string, unknown>
): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Payments are not configured" }, 500);

  const service = serviceClient(url);

  try {
    const signature = request.headers.get("x-payment-signature");
    const verified = await verifyProviderSignature(rawBody, signature);

    const source = String(body.source || "azampay");
    const externalId = String(body.event_id || body.transaction_id || "");
    const eventType = String(body.event_type || "payment.succeeded");

    /* Record the callback first, so a replay is visible even if the
       processing below fails. */
    const { data: receipt, error: receiptError } = await service.rpc("verify_payment_webhook", {
      p_source: source,
      p_external_id: externalId || `missing-${Date.now()}`,
      p_event_type: eventType,
      p_signature_verified: verified,
      p_payload: body,
    });
    if (receiptError) throw receiptError;

    const receiptRow = Array.isArray(receipt) ? receipt[0] : receipt;
    if (receiptRow?.duplicate) {
      return json({ ok: true, duplicate: true, message: "This callback was already processed." });
    }

    if (!verified) {
      await service.rpc("complete_webhook_receipt", {
        p_receipt_id: receiptRow.receipt_id,
        p_status: "failed",
        p_error: "Signature verification failed",
      });
      return json({ error: "Signature verification failed" }, 401);
    }

    if (eventType !== "payment.succeeded") {
      await service.rpc("complete_webhook_receipt", {
        p_receipt_id: receiptRow.receipt_id,
        p_status: "ignored",
      });
      return json({ ok: true, ignored: true, event_type: eventType });
    }

    const orderRef = String(body.order_ref || body.reference || "").trim().toUpperCase();
    const intentId = String(body.intent_id || body.payment_intent_id || "").trim();
    const amount = Number(body.amount ?? body.amount_tzs ?? 0);
    const providerReference = String(body.transaction_id || body.reference || externalId);

    /* The intent tells us whether this capture is a wallet top-up or a
       payment for an order. A top-up intent has no order. */
    let intent: any = null;
    if (intentId) {
      const { data: intentRow, error: intentError } = await service
        .from("payment_intents")
        .select("id, order_id, buyer_id, amount_tzs, status")
        .eq("id", intentId)
        .maybeSingle();
      if (intentError) throw intentError;
      if (!intentRow) {
        await service.rpc("complete_webhook_receipt", {
          p_receipt_id: receiptRow.receipt_id,
          p_status: "failed",
          p_error: "Unknown payment intent",
        });
        return json({ error: "Unknown payment intent" }, 404);
      }
      intent = intentRow;
    }

    /* A top-up: no order, and the money goes to the wallet. */
    if (!intent?.order_id && !orderRef) {
      if (!intent) {
        await service.rpc("complete_webhook_receipt", {
          p_receipt_id: receiptRow.receipt_id,
          p_status: "failed",
          p_error: "The callback did not say what it was for",
        });
        return json({ error: "The callback did not identify an order or a top-up" }, 400);
      }
      if (amount !== Number(intent.amount_tzs)) {
        await service.rpc("complete_webhook_receipt", {
          p_receipt_id: receiptRow.receipt_id,
          p_status: "failed",
          p_error: "Amount mismatch",
        });
        return json({ error: "The captured amount does not match the top-up" }, 400);
      }

      const { data: topup, error: topupError } = await service.rpc("record_wallet_topup", {
        p_provider: source,
        p_provider_event_id: externalId || providerReference,
        p_provider_reference: providerReference,
        p_amount_tzs: amount,
        p_buyer_id: intent.buyer_id,
        p_raw_payload: body,
      });
      if (topupError) {
        await service.rpc("complete_webhook_receipt", {
          p_receipt_id: receiptRow.receipt_id,
          p_status: "failed",
          p_error: topupError.message,
        });
        throw topupError;
      }

      await service
        .from("payment_intents")
        .update({ status: "confirmed", provider_reference: providerReference, updated_at: new Date().toISOString() })
        .eq("id", intent.id);

      await service.rpc("complete_webhook_receipt", {
        p_receipt_id: receiptRow.receipt_id,
        p_status: "processed",
      });

      const topupRow = Array.isArray(topup) ? topup[0] : topup;
      return json({ ok: true, kind: "topup", wallet: topupRow });
    }

    /* An order payment. The database re-checks the amount against the
       order and refuses a mismatch. This function never trusts the
       callback's amount. */
    let order: any = null;
    if (intent?.order_id) {
      const { data: orderRow } = await service
        .from("orders")
        .select("id, ref, total_due_tzs, buyer_id")
        .eq("id", intent.order_id)
        .maybeSingle();
      order = orderRow;
    } else {
      const { data: orderRow, error: orderError } = await service
        .from("orders")
        .select("id, ref, total_due_tzs, buyer_id")
        .eq("ref", orderRef)
        .maybeSingle();
      if (orderError) throw orderError;
      order = orderRow;
    }

    if (!order) {
      await service.rpc("complete_webhook_receipt", {
        p_receipt_id: receiptRow.receipt_id,
        p_status: "failed",
        p_error: "Order not found",
      });
      return json({ error: "Order not found" }, 404);
    }

    const { data: result, error: recordError } = await service.rpc("record_verified_payment", {
      p_provider: source,
      p_provider_event_id: externalId || providerReference,
      p_provider_reference: providerReference,
      p_amount_tzs: amount,
      p_order_id: order.id,
      p_buyer_id: order.buyer_id,
      p_payment_intent_id: intent?.id ?? null,
      p_raw_payload: body,
    });
    if (recordError) {
      await service.rpc("complete_webhook_receipt", {
        p_receipt_id: receiptRow.receipt_id,
        p_status: "failed",
        p_error: recordError.message,
      });
      throw recordError;
    }

    await service.rpc("complete_webhook_receipt", {
      p_receipt_id: receiptRow.receipt_id,
      p_status: "processed",
    });

    const row = Array.isArray(result) ? result[0] : result;
    return json({ ok: true, kind: "order", order_ref: order.ref, escrow: row });
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
