import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";
import { sendNotifications } from "../_shared/push.ts";

/* Buyer-seller chat. A thread exists between exactly one buyer
   and one seller; both participants can read it, nobody else
   can. The service client bypasses RLS, and the viewer id was
   verified from the access token before any query runs. */

async function isSellerUser(service: any, userId: string): Promise<boolean> {
  const { data } = await service
    .from("seller_profiles")
    .select("verification_status")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

async function counterpartyName(service: any, userId: string, asSeller: boolean) {
  if (asSeller) {
    const { data } = await service
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();
    return data?.display_name || "Buyer";
  }
  const { data } = await service
    .from("seller_profiles")
    .select("shop_name, kobe_id")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.shop_name || "Seller";
}

/* A buyer may chat with any verified seller. A seller may chat
   with a buyer only if that buyer has ordered from them. */
async function canChat(service: any, callerId: string, callerIsSeller: boolean, withId: string): Promise<boolean> {
  if (callerId === withId) return false;
  if (!callerIsSeller) {
    const { data } = await service
      .from("seller_profiles")
      .select("verification_status")
      .eq("user_id", withId)
      .eq("verification_status", "verified")
      .maybeSingle();
    return !!data;
  }
  const { data } = await service
    .from("orders")
    .select("id")
    .eq("seller_id", callerId)
    .eq("buyer_id", withId)
    .limit(1);
  return Array.isArray(data) && data.length > 0;
}

export default async function handler(request: Request) {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);
  const callerId = auth.user.id;
  const callerIsSeller = await isSellerUser(service, callerId);

  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body.action || "threads");

  try {
    /* ---------------- threads ---------------- */
    if (action === "threads") {
      const { data: threads, error } = await service
        .from("chat_threads")
        .select("*")
        .or(`buyer_id.eq.${callerId},seller_id.eq.${callerId}`)
        .order("updated_at", { ascending: false })
        .limit(100);
      if (error) throw error;

      const list: Record<string, unknown>[] = [];
      for (const thread of threads || []) {
        const withId = thread.buyer_id === callerId ? thread.seller_id : thread.buyer_id;
        const name = await counterpartyName(service, withId, callerIsSeller);
        const { data: msgs } = await service
          .from("chat_messages")
          .select("sender_id, body, created_at")
          .eq("thread_buyer", thread.buyer_id)
          .eq("thread_seller", thread.seller_id)
          .order("created_at", { ascending: false })
          .limit(1);
        const last = Array.isArray(msgs) && msgs.length ? msgs[0] : null;
        const seenAt = thread.buyer_id === callerId ? thread.buyer_seen_at : thread.seller_seen_at;
        let unread = 0;
        if (last && last.sender_id !== callerId && (!seenAt || new Date(last.created_at) > new Date(seenAt))) {
          const { data: unseen, error: unseenError } = await service
            .from("chat_messages")
            .select("id")
            .eq("thread_buyer", thread.buyer_id)
            .eq("thread_seller", thread.seller_id)
            .neq("sender_id", callerId)
            .gt("created_at", seenAt ? new Date(seenAt).toISOString() : "1970-01-01T00:00:00Z");
          if (!unseenError) unread = Array.isArray(unseen) ? unseen.length : 0;
        }
        list.push({
          withUserId: withId,
          withName: name,
          lastBody: last ? last.body : "",
          lastAt: last ? new Date(last.created_at).toISOString() : null,
          unread,
          updatedAt: thread.updated_at,
        });
      }
      return json({ ok: true, threads: list });
    }

    /* ---------------- thread messages ---------------- */
    if (action === "thread") {
      const withId = String(body.with || "");
      if (!/^[0-9a-f-]{36}$/i.test(withId)) throw new ApiError(400, "Choose a conversation");

      const allowed = await canChat(service, callerId, callerIsSeller, withId);
      if (!allowed) throw new ApiError(403, "You can only message buyers and sellers you are connected to");

      const buyerId = callerIsSeller ? withId : callerId;
      const sellerId = callerIsSeller ? callerId : withId;

      const { data: messages, error } = await service
        .from("chat_messages")
        .select("*")
        .eq("thread_buyer", buyerId)
        .eq("thread_seller", sellerId)
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) throw error;

      const name = await counterpartyName(service, withId, callerIsSeller);
      const { data: thread } = await service
        .from("chat_threads")
        .select("buyer_seen_at, seller_seen_at")
        .eq("buyer_id", buyerId)
        .eq("seller_id", sellerId)
        .maybeSingle();
      return json({
        ok: true,
        withUserId: withId,
        withName: name,
        sellerSeenAt: thread?.seller_seen_at || null,
        buyerSeenAt: thread?.buyer_seen_at || null,
        messages: (messages || []).map((m: any) => ({
          id: m.id,
          senderId: m.sender_id,
          from: m.sender_id === callerId ? "me" : "them",
          body: m.body,
          at: new Date(m.created_at).toISOString(),
        })),
      });
    }

    /* ---------------- send ---------------- */
    if (action === "send") {
      const limit = await consumeRateLimit(service, "chat_send", callerId, 30, 60);
      if (!limit.allowed) return json({ error: "Too many messages. Please wait a moment." }, 429);

      const withId = String(body.with || "");
      const text = String(body.text || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(withId)) throw new ApiError(400, "Choose a conversation");
      if (text.length < 1 || text.length > 5000) throw new ApiError(400, "Message must be 1 to 5000 characters");

      const allowed = await canChat(service, callerId, callerIsSeller, withId);
      if (!allowed) throw new ApiError(403, "You can only message buyers and sellers you are connected to");

      const buyerId = callerIsSeller ? withId : callerId;
      const sellerId = callerIsSeller ? callerId : withId;

      const { error: threadError } = await service.from("chat_threads").upsert({
        buyer_id: buyerId,
        seller_id: sellerId,
        updated_at: new Date().toISOString(),
      });
      if (threadError) throw threadError;

      const { data: message, error: messageError } = await service
        .from("chat_messages")
        .insert({ thread_buyer: buyerId, thread_seller: sellerId, sender_id: callerId, body: text })
        .select("*")
        .single();
      if (messageError) throw messageError;

      await service.from("activity_events").insert({
        user_id: withId, kind: "message_received",
        payload: { from: callerId, preview: text.slice(0, 100) },
      });

      sendNotifications(service, [withId], "New message",
        callerIsSeller ? "The seller sent you a message." : "A seller sent you a message.",
        { link: callerIsSeller ? "/seller.html#seller-messages" : "/buyer.html#chat" });

      return json({ ok: true, message: { id: message.id, at: message.created_at } }, 201);
    }

    /* ---------------- mark read ---------------- */
    if (action === "read") {
      const withId = String(body.with || "");
      if (!/^[0-9a-f-]{36}$/i.test(withId)) throw new ApiError(400, "Choose a conversation");

      const { error } = await service.from("chat_threads").upsert({
        buyer_id: callerIsSeller ? withId : callerId,
        seller_id: callerIsSeller ? callerId : withId,
        [callerIsSeller ? "seller_seen_at" : "buyer_seen_at"]: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
