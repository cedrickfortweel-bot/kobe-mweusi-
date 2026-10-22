# The notification system

How a person is told something, across the website and their inbox.

## 1. What there was before

The platform already recorded everything that happens in
`public.activity_events`, and the Edge Functions already sent web push.
But the notification bell was a **localStorage array on each device**.

That meant:

* a notification that arrived while the app was closed was **lost**
* the bell was **empty on a new phone**
* there was no record of what a user had actually been told
* a chat message and a refund both arrived the same way, with no
  difference in importance

There was also **no email at all**. The only email in the system was
Supabase Auth's own confirmation message.

## 2. The shape now

```
   something happens
          |
          v
   public.activity_events          the single source of truth
          |
          v
   project_activity_event()        the trigger
          |
          +--> public.notifications            the durable inbox
          +--> public.notification_deliveries  one row per channel
                      |
                      +--> web push    (the existing VAPID implementation)
                      +--> email       (new)
                      +--> sms         (reserved)
```

The apps read `public.my_notifications` and subscribe to the
`notifications` table over realtime, so a notification appears in the
bell on every device, and arrives while the app is open.

The local copy is now only a **cache**, so the bell still opens
instantly and still works offline.

## 3. The rules are data

`public.notification_rules` holds one row per event kind:

| Column | What it decides |
|---|---|
| `category` | money, orders, disputes, kyc, chat, security, system |
| `title`, `body` | the wording, with `{ref}`, `{amount}`, `{balance}` placeholders |
| `link` | where the notification takes you |
| `priority` | low, normal, high, critical |
| `channels` | which channels this event uses |
| `enabled` | a switch to mute one event entirely |

So the copy and the channel policy are changed with an `update`, not a
migration.

## 4. Which channel gets what

| Category | In-app | Push | Email | SMS |
|---|:---:|:---:|:---:|:---:|
| **money** | ● | ● | ● | ● |
| **orders** | ● | ● | ● | |
| **disputes** | ● | ● | ● | |
| **kyc** | ● | ● | ● | |
| **chat** | ● | ● | | |
| **security** | ● | ● | ● | |
| **system** | ● | | | |

The reasoning:

* **Money reaches every channel, including email.** Money is what people
  complain about, and the person who needs to know may not have the app
  open. An email that says "your withdrawal was sent" is the difference
  between a customer and a support ticket.
* **Chat never sends an email.** A message from a seller is not worth an
  inbox, and sending it is how a customer ends up unsubscribed from
  everything.
* **A review does not send an email** either. It is nice to know, but
  not urgent.
* **System updates stay in the app.** They are not worth interrupting
  anyone for.

On top of this the user's own settings are honoured: a category can be
switched off per channel in `notification_preferences`, and a whole
channel can be switched off in `user_settings` (`push_enabled`,
`email_enabled`, `sms_enabled`).

## 5. The email channel

### The provider

`resend` is the first provider. It needs one API key, has no SMTP
plumbing, and delivers well.

**The API key is never in the database.** It is an Edge Function secret:

```bash
supabase secrets set RESEND_API_KEY=re_...
```

The database only holds the non-secret settings in
`public.email_provider_config`: whether email is on, the from name and
the from address.

### Turning it on

```sql
update public.email_provider_config
set is_enabled = true,
    from_email = 'Kobe Mweusi <no-reply@kobemweusi.co.tz>',
    reply_to = 'support@kobemweusi.co.tz'
where provider = 'resend';
```

Until that runs, the worker closes email records with "Email is not
enabled" rather than retrying them forever.

### The address

The address lives in `auth.users`, which `public` cannot read.
`email_address_for()` is the only way to get it, and it **returns
nothing for an unconfirmed address**, and nothing for a **suppressed**
one. Sending to an unconfirmed address is sending to a typo, and it
burns the sending reputation for the domain.

### The unsubscribe link

Every email carries one, built per category so the same token is reused:

```
{app_url}/unsubscribe.html?token=<uuid>
```

The token is the authorisation, so the link works from an inbox with no
sign-in. It flips that category's email preference off, and the
preference can be turned back on in the app.

The app is already served from an origin, so the link works there today
and follows the domain when there is one.

### Bounces

A hard failure from the provider, a rejected address or a bad request,
is permanent: it will never succeed, so retrying it is pointless and
it holds up the queue. The worker tells permanent from temporary
failures, and a permanent one **suppresses the address**, so it is never
mailed again.

A rate limit or a provider outage is temporary, and is retried with a
backoff.

### One template

`render_notification_email()` renders every email, so they all look the
same and a change to the brand reaches all of them. The email is plain
HTML with a plain-text alternative.

## 6. The worker

`supabase/functions/notify` drains the queue.

* It claims records with `FOR UPDATE SKIP LOCKED`, so two workers can
  run at the same time and neither will deliver the same notification
  twice.
* A failure is retried with an exponential backoff, up to five
  attempts, and then the record is marked failed rather than retried
  forever.
* A record with no subscriptions, or no confirmed address, is closed as
  a success. There is nothing to retry, and the in-app row is the
  durable copy.
* SMS records are closed as skipped until that channel is wired.

Run it by hand while testing:

```bash
supabase functions invoke notify --no-verify-jwt
```

### The schedule

pg_cron cannot call an Edge Function directly, so it goes through
pg_net. The service key is read from **Supabase Vault**, never from a
table:

```sql
insert into vault.secrets (name, secret)
values
  ('kobe_functions_url', 'https://<project-ref>.supabase.co'),
  ('kobe_service_key',  '<service-role-key>');
```

The schedule runs every minute. If Vault is not available the migration
skips the schedule rather than failing, and any external scheduler can
call the worker instead.

## 7. What a user actually receives

| Event | Buyer | Seller |
|---|---|---|
| New order | in-app, push, email | in-app, push, email |
| Money held in escrow | in-app, push, email | in-app, push, email |
| Handoff scanned | in-app, push, email | in-app, push, email |
| Escrow released | in-app, push, email | in-app, push, email |
| Refund | in-app, push, email, sms | — |
| Withdrawal requested | — | in-app, push, email, sms |
| Verification approved | — | in-app, push, email |
| Verification rejected | — | in-app, push, email |
| Dispute opened | in-app, push, email | in-app, push, email |
| New message | in-app, push | in-app, push |
| New review | in-app, push | in-app, push |
| Support update | in-app | in-app |

## 8. Still to do

* **SMS.** The channel is reserved, the rules can include it, the queue
  carries it, the worker has a branch for it, `user_settings.sms_enabled`
  exists and `profiles.phone_e164` is already in E.164 form. When you get
  an Arkesel or Africa's Talking account it is a config row and one send
  function. For Tanzania this matters most: a payout confirmation that
  only exists in the app **will be missed**.
* **The bounce and complaint webhook.** The suppression list it fills is
  in place, and the worker already suppresses a hard-bounced address, but
  nothing receives the provider's bounce reports yet.
* **A digest.** Someone who gets forty order notifications in a day
  stops reading them. A daily summary for the low-priority categories
  would fix that, and the rules already separate priority from channel.
* **Email templates per category.** There is one template for every
  email. Per-category wording would be better, and the rules table has
  room for it.

## 9. The phone number

A phone number is only trusted once the account holder has proved they
own it. Supabase Auth sends the code and confirms it; the server then
records the confirmation in `profiles.phone_verified_at`.

**This matters now, before SMS, for two reasons.**

1. **An unconfirmed number was shown to other people.** The buyer's phone
   appeared on the seller's order receipt, and the number was copied
   straight from the sign-up metadata with nothing checking it. Anybody
   could have put a stranger's number on their account, and a seller
   would then have dialled it. The receipt now only carries a number
   that was confirmed, and says nothing rather than showing an
   unverified one.

2. **A payout confirmation must not go to a number the account holder
   never proved they own.** That is the hard prerequisite for SMS.

The flow is in Account settings: enter the number, save it, then
**Send me a code to confirm this number**, enter the code, and it is
confirmed. The confirmation is recorded by the server from Auth's own
state, never from the browser's word.
