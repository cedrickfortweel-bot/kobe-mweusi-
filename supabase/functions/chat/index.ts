import { json, ApiError, asApiError } from "../_shared/http.ts";
import { verifyUser, serviceClient, isStaff } from "../_shared/auth.ts";
import { consumeRateLimit } from "../_shared/rate.ts";
import { sendNotifications } from "../_shared/push.ts";

/* Buyer-seller chat.

   A thread is between exactly one buyer and one seller. Both participants
   can read it and nobody else can. The service client bypasses RLS, so
   the viewer is taken from the access token and every query is scoped to
   that viewer.

   THE THREAD ORIENTATION
   ----------------------
   The row has a buyer and a seller, so both sides have to agree which
   one is which, or a message lands in a thread the other side cannot
   find. The rule is derived from the pair, not from the caller's account
   type, because one account may be both a buyer and a seller:

     the counterparty has a shop and the caller does not
        the caller is buying, so the caller is the buyer

     the caller has a shop and the counterparty does not
        the caller is selling, so the counterparty is the buyer

     both have shops
        the pair is ordered by id, so both sides land on the same row

   REPLYING
   --------
   A buyer may ask any verified seller a question before they have
   ordered. The seller must then be able to ANSWER it, even though there
   is still no order. So once a thread exists, both parties may always
   continue it. The order requirement only gates starting a new
   conversation with a buyer.

   The old code checked "does this buyer have an order from me" on every
   message, which meant a seller could not reply to a first inquiry, and
   the role was guessed from the caller's account type, which broke for
   an account that both buys and sells.
*/

async function hasShop(service: any, userId: string): Promise<boolean> {
  const { data } = await service
    .from("seller_profiles")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

/* The name of the other person, taken from the thread's role rather
   than from the caller's account type, so both sides see the same
   name. */
async function counterpartyName(service: any, userId: string, role: "buyer" | "seller") {
  if (role === "buyer") {
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

/* An order between the two, if there is one. */
async function sharedOrder(service: any, a: string, b: string) {
  const { data } = await service
    .from("orders")
    .select("id, buyer_id, seller_id")
    .or(`buyer_id.eq.${a},seller_id.eq.${a}`)
    .limit(200);
  const rows = (data || []).filter((o: any) => o.buyer_id === b || o.seller_id === b);
  return rows.length ? rows[0] : null;
}

async function threadExists(service: any, buyerId: string, sellerId: string) {
  const { data } = await service
    .from("chat_threads")
    .select("buyer_id")
    .eq("buyer_id", buyerId)
    .eq("seller_id", sellerId)
    .maybeSingle();
  return !!data;
}

/* Work out the thread for a pair, and whether the caller may use it. */
async function resolveThread(
  service: any,
  callerId: string,
  withId: string
): Promise<{ allowed: boolean; buyerId?: string; sellerId?: string; reason?: string }> {
  if (callerId === withId) {
    return { allowed: false, reason: "Choose someone else to message." };
  }

  const callerHasShop = await hasShop(service, callerId);
  const withHasShop = await hasShop(service, withId);

  /* Both have shops: order the pair so both sides reach the same row. */
  if (callerHasShop && withHasShop) {
    const pair = [callerId, withId].sort();
    return { allowed: true, buyerId: pair[0], sellerId: pair[1] };
  }

  /* The counterparty sells and the caller does not: the caller is
     buying, and may ask any seller a question. */
  if (withHasShop && !callerHasShop) {
    return { allowed: true, buyerId: callerId, sellerId: withId };
  }

  /* The caller sells and the counterparty does not: the counterparty is
     a buyer. A seller may start a conversation with a buyer who has
     ordered, and may always continue one that already exists. */
  if (callerHasShop && !withHasShop) {
    const order = await sharedOrder(service, callerId, withId);
    const existing = await threadExists(service, withId, callerId);
    if (!order && !existing) {
      return {
        allowed: false,
        reason: "You can message a buyer once they have ordered from you.",
      };
    }
    return { allowed: true, buyerId: withId, sellerId: callerId };
  }

  /* Neither has a shop, so there is nothing to trade. */
  return {
    allowed: false,
    reason: "You can only message a seller, or a buyer who has ordered from you.",
  };
}

/* The role the counterparty plays in a thread. */
function counterpartyRole(buyerId: string, sellerId: string, otherId: string): "buyer" | "seller" {
  return otherId === sellerId ? "seller" : "buyer";
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = await verifyUser(request);
  const service = serviceClient(auth.url);
  const callerId = auth.user.id;

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
        .limit(50);
      if (error) throw error;

      const rows = threads || [];
      if (!rows.length) return json({ ok: true, threads: [] });

      /* One query for every thread's messages, rather than three per
         thread. A seller with fifty conversations used to run a hundred
         and fifty queries. */
      const pairs = rows.map((t: any) => `and(thread_buyer.eq.${t.buyer_id},thread_seller.eq.${t.seller_id})`);
      const { data: messages, error: messagesError } = await service
        .from("chat_messages")
        .select("id, thread_buyer, thread_seller, sender_id, body, created_at")
        .or(pairs.join(","))
        .order("created_at", { ascending: true })
        .limit(2000);
      if (messagesError) throw messagesError;

      const byThread = new Map<string, any[]>();
      for (const m of messages || []) {
        const key = `${m.thread_buyer}|${m.thread_seller}`;
        const list = byThread.get(key) || [];
        list.push(m);
        byThread.set(key, list);
      }

      const list: Record<string, unknown>[] = [];
      for (const thread of rows) {
        const key = `${thread.buyer_id}|${thread.seller_id}`;
        const msgs = byThread.get(key) || [];
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        const seenAt = thread.buyer_id === callerId ? thread.buyer_seen_at : thread.seller_seen_at;
        const seenMs = seenAt ? new Date(seenAt).getTime() : 0;
        const unread = msgs.filter(
          (m) => m.sender_id !== callerId && new Date(m.created_at).getTime() > seenMs
        ).length;

        const withId = thread.buyer_id === callerId ? thread.seller_id : thread.buyer_id;
        const name = await counterpartyName(
          service,
          withId,
          counterpartyRole(thread.buyer_id, thread.seller_id, withId)
        );

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

      const resolved = await resolveThread(service, callerId, withId);
      if (!resolved.allowed) {
        throw new ApiError(403, resolved.reason || "You cannot open this conversation");
      }
      const buyerId = resolved.buyerId!;
      const sellerId = resolved.sellerId!;

      const { data: messages, error } = await service
        .from("chat_messages")
        .select("*")
        .eq("thread_buyer", buyerId)
        .eq("thread_seller", sellerId)
        .order("created_at", { ascending: true })
        .limit(200);
      if (error) throw error;

      const name = await counterpartyName(
        service,
        withId,
        counterpartyRole(buyerId, sellerId, withId)
      );
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

      const resolved = await resolveThread(service, callerId, withId);
      if (!resolved.allowed) {
        throw new ApiError(403, resolved.reason || "You cannot message this person");
      }
      const buyerId = resolved.buyerId!;
      const sellerId = resolved.sellerId!;

      /* Keep the thread's activity in step with the message. The upsert
         creates the row if it is new, so two people writing at the same
         moment cannot both create it. */
      const { error: threadError } = await service.from("chat_threads").upsert({
        buyer_id: buyerId,
        seller_id: sellerId,
        updated_at: new Date().toISOString(),
      });
      if (threadError) throw threadError;

      /* The initiator is whoever opened the conversation, so it is only
         filled in once and never overwritten. */
      await service
        .from("chat_threads")
        .update({ initiated_by: callerId })
        .eq("buyer_id", buyerId)
        .eq("seller_id", sellerId)
        .is("initiated_by", null);

      const { data: message, error: messageError } = await service
        .from("chat_messages")
        .insert({ thread_buyer: buyerId, thread_seller: sellerId, sender_id: callerId, body: text })
        .select("*")
        .single();
      if (messageError) throw messageError;

      await service.from("chat_thread_members").upsert(
        [
          { thread_buyer: buyerId, thread_seller: sellerId, user_id: buyerId, role: "buyer" },
          { thread_buyer: buyerId, thread_seller: sellerId, user_id: sellerId, role: "seller" },
        ],
        { onConflict: "thread_buyer,thread_seller,user_id" }
      );

      await service.from("activity_events").insert({
        user_id: withId,
        kind: "message_received",
        payload: { from: callerId, preview: text.slice(0, 100) },
      });

      const callerIsSellerInThread = sellerId === callerId;
      sendNotifications(service, [withId], "New message",
        callerIsSellerInThread ? "The seller sent you a message." : "A seller sent you a message.",
        { link: callerIsSellerInThread ? "/seller.html#seller-messages" : "/buyer.html#chat" });

      return json({ ok: true, message: { id: message.id, at: message.created_at } }, 201);
    }

    /* ---------------- mark read ----------------
       This used to upsert, so simply calling it created a conversation
       with anybody. It now marks a conversation that already exists. */
    if (action === "read") {
      const withId = String(body.with || "");
      if (!/^[0-9a-f-]{36}$/i.test(withId)) throw new ApiError(400, "Choose a conversation");

      const resolved = await resolveThread(service, callerId, withId);
      if (!resolved.allowed) {
        throw new ApiError(403, resolved.reason || "You cannot open this conversation");
      }
      const buyerId = resolved.buyerId!;
      const sellerId = resolved.sellerId!;

      const { data: existing } = await service
        .from("chat_threads")
        .select("buyer_id")
        .eq("buyer_id", buyerId)
        .eq("seller_id", sellerId)
        .maybeSingle();
      if (!existing) return json({ ok: true, note: "No conversation to mark" });

      const { error } = await service
        .from("chat_threads")
        .update({
          [sellerId === callerId ? "seller_seen_at" : "buyer_seen_at"]: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("buyer_id", buyerId)
        .eq("seller_id", sellerId);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
