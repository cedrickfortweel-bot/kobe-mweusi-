import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, authenticatedClient, requireStaffPermission } from "../_shared/auth.ts";

/* Operations data and guarded workflows. Financial actions go through
   the owning database functions, with dual approval where required. */

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
    const permission = body.action === "orders" ? "orders.view"
      : body.action === "disputes" ? "disputes.view"
      : body.action === "audit" ? "audit_logs.view"
      : body.action === "record-dispute-decision" ? "disputes.review"
      : body.action === "request-dispute-approval" ? "disputes.resolve"
      : body.action === "request-payout-approval" || body.action === "approve-payout-request" ? "payouts.approve"
      : body.action === "approvals" || body.action === "approve-admin-request" ? "system.settings.manage"
      : "orders.view";
    const role = await requireStaffPermission(request, auth, service, permission);

    if (body.action === "access") {
      return json({ ok: true, role, mfa_required: role === "admin" });
    }

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

    if (action === "record-dispute-decision") {
      const disputeId = String(body.dispute_id || "");
      const decision = String(body.decision || "");
      const reason = String(body.reason || "").trim();
      if (!disputeId || !["buyer_refund", "seller_release", "split"].includes(decision)) {
        throw new ApiError(400, "A dispute and valid decision are required.");
      }
      if (reason.length < 5) throw new ApiError(400, "Provide a reason of at least five characters.");

      const { data: dispute, error: disputeError } = await service
        .from("disputes")
        .select("id,status,order_id")
        .eq("id", disputeId)
        .maybeSingle();
      if (disputeError) throw disputeError;
      if (!dispute) throw new ApiError(404, "Dispute not found.");
      if (dispute.status === "resolved") throw new ApiError(409, "This dispute already has a decision.");

      const { data: escrow, error: escrowError } = await service
        .from("escrow_transactions")
        .select("amount_tzs")
        .eq("order_id", dispute.order_id)
        .maybeSingle();
      if (escrowError) throw escrowError;
      if (!escrow) throw new ApiError(409, "No escrow balance is available for this dispute.");

      const escrowAmount = Number(escrow.amount_tzs);
      const buyerAmount = decision === "buyer_refund" ? escrowAmount
        : decision === "seller_release" ? 0
        : Number(body.buyer_amount_tzs);
      if (!Number.isSafeInteger(buyerAmount) || buyerAmount < 0 || buyerAmount > escrowAmount) {
        throw new ApiError(400, "The buyer refund must be a whole TSh amount within the escrow balance.");
      }
      const sellerAmount = escrowAmount - buyerAmount;

      const { data, error } = await service.rpc("resolve_dispute", {
        p_dispute_id: disputeId,
        p_decision: decision,
        p_reason: reason,
        p_buyer_amount_tzs: buyerAmount,
        p_seller_amount_tzs: sellerAmount,
        p_reviewer_id: auth.user.id,
      });
      if (error) throw error;
      return json({ ok: true, decision: data });
    }

    if (action === "request-dispute-approval" || action === "request-payout-approval") {
      const isDispute = action === "request-dispute-approval";
      const targetId = String(isDispute ? body.dispute_id || "" : body.payout_id || "");
      const reason = String(body.reason || "").trim();
      if (!targetId) throw new ApiError(400, "A target id is required.");
      if (reason.length < 5) throw new ApiError(400, "Provide a reason of at least five characters.");

      let amount: number | null = null;
      if (isDispute) {
        const { data: dispute, error: disputeError } = await service
          .from("disputes")
          .select("id,status,order_id,outcome")
          .eq("id", targetId)
          .maybeSingle();
        if (disputeError) throw disputeError;
        if (!dispute || dispute.status !== "resolved") {
          throw new ApiError(409, "Record a dispute decision before requesting financial execution.");
        }
        const { data: decision, error: decisionError } = await service
          .from("dispute_decisions")
          .select("financial_action")
          .eq("dispute_id", targetId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (decisionError) throw decisionError;
        if (!decision || decision.financial_action) throw new ApiError(409, "This dispute has no pending financial outcome.");
        const { data: order, error: orderError } = await service
          .from("orders")
          .select("ref")
          .eq("id", dispute.order_id)
          .maybeSingle();
        if (orderError) throw orderError;
        const userClient = authenticatedClient(request, auth);
        const { data, error } = await userClient.rpc("request_admin_approval", {
          p_action: "dispute.execute",
          p_reason: reason,
          p_target_id: targetId,
          p_payload: { order_ref: order?.ref || targetId, outcome: dispute.outcome },
        });
        if (error) throw error;
        return json({ ok: true, approval: data });
      } else {
        const { data: payout, error: payoutError } = await service
          .from("payout_requests")
          .select("id,status,amount_tzs,seller_id")
          .eq("id", targetId)
          .maybeSingle();
        if (payoutError) throw payoutError;
        if (!payout || payout.status !== "requested") throw new ApiError(409, "This payout is no longer waiting for approval.");
        amount = Number(payout.amount_tzs);
        const { data: seller, error: sellerError } = await service
          .from("seller_profiles")
          .select("shop_name,kobe_id")
          .eq("user_id", payout.seller_id)
          .maybeSingle();
        if (sellerError) throw sellerError;
        const userClient = authenticatedClient(request, auth);
        const { data, error } = await userClient.rpc("request_admin_approval", {
          p_action: "payout.approve",
          p_reason: reason,
          p_target_id: targetId,
          p_amount_tzs: amount,
          p_payload: { shop_name: seller?.shop_name || "Seller", kobe_id: seller?.kobe_id || null },
        });
        if (error) throw error;
        return json({ ok: true, approval: data });
      }
    }

    if (action === "approvals") {
      const { data, error } = await service
        .from("admin_approval_requests")
        .select("id,action,requested_by,approved_by,target_id,amount_tzs,payload,reason,status,created_at,expires_at")
        .in("action", ["dispute.execute", "payout.approve"])
        .in("status", ["pending", "approved"])
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return json({ ok: true, approvals: data || [] });
    }

    if (action === "approve-admin-request") {
      const requestId = String(body.request_id || "");
      if (!requestId) throw new ApiError(400, "An approval request id is required.");
      const { data: approval, error: approvalError } = await service
        .from("admin_approval_requests")
        .select("id,action,requested_by,approved_by,status,target_id")
        .eq("id", requestId)
        .maybeSingle();
      if (approvalError) throw approvalError;
      if (!approval || !["dispute.execute", "payout.approve"].includes(approval.action)) {
        throw new ApiError(404, "Approval request not found.");
      }
      await requireStaffPermission(
        request,
        auth,
        service,
        approval.action === "payout.approve" ? "payouts.approve" : "disputes.resolve"
      );
      if (approval.requested_by === auth.user.id) throw new ApiError(403, "A different administrator must approve this request.");

      if (approval.status === "pending") {
        const { error } = await service.rpc("approve_admin_request", {
          p_request_id: requestId,
          p_approver_id: auth.user.id,
        });
        if (error) throw error;
        approval.approved_by = auth.user.id;
      } else if (approval.status !== "approved") {
        throw new ApiError(409, "This approval request is no longer actionable.");
      } else if (approval.approved_by !== auth.user.id) {
        throw new ApiError(403, "Only the administrator who approved this request can finish its execution.");
      }

      let alreadyExecuted = false;
      if (approval.action === "payout.approve") {
        const { data: payout, error: payoutError } = await service
          .from("payout_requests")
          .select("status,approved_by")
          .eq("id", approval.target_id)
          .maybeSingle();
        if (payoutError) throw payoutError;
        alreadyExecuted = payout?.status === "completed" && payout.approved_by === auth.user.id;
      } else {
        const { data: decision, error: decisionError } = await service
          .from("dispute_decisions")
          .select("financial_action")
          .eq("dispute_id", approval.target_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (decisionError) throw decisionError;
        alreadyExecuted = Boolean(decision?.financial_action);
      }

      let result: unknown = { duplicate: true };
      if (!alreadyExecuted) {
        const rpcName = approval.action === "payout.approve" ? "approve_payout" : "execute_dispute_financial_outcome";
        const rpcArgs = approval.action === "payout.approve"
          ? { p_payout_id: approval.target_id, p_approver_id: auth.user.id, p_provider_reference: null }
          : { p_dispute_id: approval.target_id, p_executor_id: auth.user.id };
        const { data, error: executeError } = await service.rpc(rpcName, rpcArgs);
        if (executeError) throw executeError;
        result = data;
      }

      const { error: updateError } = await service
        .from("admin_approval_requests")
        .update({ status: "executed", executed_at: new Date().toISOString() })
        .eq("id", requestId)
        .eq("status", "approved");
      if (updateError) throw updateError;
      return json({ ok: true, result });
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
