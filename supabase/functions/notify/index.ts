import { json, ApiError, asApiError, corsHeaders } from "../_shared/http.ts";
import { serviceClient } from "../_shared/auth.ts";
import { sendNotifications } from "../_shared/push.ts";

/* The notification worker.

   It drains public.notification_deliveries and delivers each record on
   its channel:

     push    web push, using the existing VAPID implementation
     email   transactional email, through the configured provider
     sms     not wired yet; records are marked so they do not pile up

   The records are claimed with FOR UPDATE SKIP LOCKED, so two workers
   can run at the same time without delivering the same notification
   twice. A failure is retried with a backoff, and a record that has run
   out of attempts is marked failed rather than retried forever.

   The provider API key is an Edge Function secret. It is never in the
   database and never logged.

   Call it from a scheduler, or by hand while testing:

     supabase functions invoke notify --no-verify-jwt
*/

const MAX_ATTEMPTS = 5;

/* Send one email. The provider is chosen by the database so a different
   one can be added without changing this file.

   The result says whether the failure is PERMANENT. A rejected address
   or a bad request will never succeed, so retrying it is pointless and
   it holds up the queue. A rate limit or a provider outage is
   temporary, so it is worth retrying. */
async function sendEmail(
  service: any,
  to: string,
  subject: string,
  html: string,
  text: string
): Promise<{ ok: boolean; error?: string; permanent?: boolean }> {
  const { data: config, error: configError } = await service
    .from("email_provider_config")
    .select("provider, is_enabled, from_name, from_email, reply_to")
    .eq("provider", "resend")
    .maybeSingle();

  if (configError) return { ok: false, error: configError.message };
  if (!config || !config.is_enabled) {
    return { ok: false, error: "Email is not enabled" };
  }
  if (!config.from_email) {
    return { ok: false, error: "No from address is configured for email" };
  }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "The email provider key is not configured" };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${config.from_name} <${config.from_email}>`,
        to: [to],
        subject,
        html,
        text,
        ...(config.reply_to ? { reply_to: config.reply_to } : {}),
        tags: [{ name: "category", value: "kobe-mweusi" }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      /* 4xx is the provider saying this request will never work, except
         429, which is a rate limit and is worth waiting out. 5xx is the
         provider having a bad day. */
      const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
      return {
        ok: false,
        permanent,
        error: `provider ${response.status}: ${body.slice(0, 300)}`,
      };
    }
    return { ok: true };
  } catch (error) {
    /* The provider could not be reached. That is always temporary. */
    return { ok: false, permanent: false, error: (error as Error)?.message || "the provider could not be reached" };
  }
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const service = serviceClient();

  try {
    /* Claim the records that are due. The claim marks them as being
       worked on, so a second worker cannot take the same one. */
    const { data: claimed, error: claimError } = await service.rpc("claim_notification_deliveries", {
      p_limit: 50,
    });
    if (claimError) throw claimError;

    const deliveries = (claimed || []) as any[];
    if (!deliveries.length) {
      return json({ ok: true, processed: 0, sent: 0, failed: 0 });
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const delivery of deliveries) {
      const { data: rendered } = await service.rpc("render_notification_email", {
        p_notification_id: delivery.notification_id,
      });
      const row = Array.isArray(rendered) ? rendered[0] : rendered;

      if (delivery.channel === "sms") {
        /* Not wired yet. Marking it keeps the queue from growing, and it
           is visible that it was skipped rather than lost. */
        await service.rpc("complete_notification_delivery", {
          p_delivery_id: delivery.id,
          p_success: true,
          p_error: "SMS is not wired yet",
        });
        skipped++;
        continue;
      }

      if (delivery.channel === "push") {
        const { data: notification } = await service
          .from("notifications")
          .select("title, body, link, payload")
          .eq("id", delivery.notification_id)
          .maybeSingle();

        if (!notification) {
          await service.rpc("complete_notification_delivery", {
            p_delivery_id: delivery.id,
            p_success: false,
            p_error: "The notification is missing",
          });
          failed++;
          continue;
        }

        /* The push helper reports how many people it reached. A record
           with no subscriptions is still a success: the in-app inbox
           row is the durable copy. */
        const delivered = await sendNotifications(
          service,
          [delivery.user_id],
          notification.title,
          notification.body,
          { ...(notification.payload || {}), link: notification.link || "" }
        );

        await service.rpc("complete_notification_delivery", {
          p_delivery_id: delivery.id,
          p_success: true,
          p_error: null,
        });
        sent++;
        continue;
      }

      if (delivery.channel === "email") {
        const { data: address } = await service.rpc("email_address_for", {
          p_user: delivery.user_id,
        });

        if (!address) {
          /* No address, or an unconfirmed one. There is nothing to
             retry, so the record is closed rather than retried. */
          await service.rpc("complete_notification_delivery", {
            p_delivery_id: delivery.id,
            p_success: true,
            p_error: "No confirmed email address",
          });
          skipped++;
          continue;
        }

        const result = await sendEmail(
          service,
          address,
          row?.title || "Kobe Mweusi",
          row?.html || "",
          row?.text || row?.body || ""
        );

        if (result.ok) {
          await service.rpc("complete_notification_delivery", {
            p_delivery_id: delivery.id,
            p_success: true,
            p_error: null,
          });
          sent++;
          continue;
        }

        /* A permanent failure will never succeed, so the address is
           suppressed and the record is closed rather than retried five
           times. */
        if (result.permanent) {
          await service.rpc("suppress_email", {
            p_email: address,
            p_reason: "bounced",
            p_provider: "resend",
            p_detail: result.error || null,
          });
          await service.rpc("complete_notification_delivery", {
            p_delivery_id: delivery.id,
            p_success: true,
            p_error: result.error || "the address was rejected",
          });
          skipped++;
          continue;
        }

        /* A temporary failure is retried with a backoff. */
        await service.rpc("complete_notification_delivery", {
          p_delivery_id: delivery.id,
          p_success: false,
          p_error: result.error || "the email could not be sent",
        });
        failed++;
        continue;
      }

      /* An unknown channel. Close it so it does not pile up. */
      await service.rpc("complete_notification_delivery", {
        p_delivery_id: delivery.id,
        p_success: true,
        p_error: `Unknown channel: ${delivery.channel}`,
      });
      skipped++;
    }

    return json({ ok: true, processed: deliveries.length, sent, failed, skipped });
  } catch (error) {
    const api = error instanceof ApiError ? error : asApiError(error);
    return json({ ok: false, error: api.message }, api.status);
  }
}
