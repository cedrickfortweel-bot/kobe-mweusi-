/* Kobe Mweusi — the notification pipeline.

   THE PROBLEM IT SOLVES
   ---------------------
   The platform already records everything that happens in
   public.activity_events, and the Edge Functions already send web push.
   But the in-app notification centre was a localStorage array on each
   device, so:

     * a notification that arrived while the app was closed was lost
     * the bell was empty on a new phone
     * nothing was durable, so there was no record of what a user was told

   This migration makes the inbox a server-side thing. The events are the
   single source of truth, and a projection turns each one into a
   notification plus one delivery record per channel.

   THE SHAPE
   ---------
       activity_events  (what happened)
             |
             v
       project_activity_event()      the trigger
             |
             +--> public.notifications            the durable inbox
             +--> public.notification_deliveries  one row per channel
                         |
                         +--> web push   (already exists)
                         +--> email      (new)
                         +--> sms        (new)

   THE RULES ARE DATA
   -------------------
   The copy, the category, the priority and which channels an event uses
   all live in public.notification_rules, so they can be changed without
   a migration. The trigger reads the table; it does not hard-code the
   wording.

   WHICH CHANNEL GETS WHAT
   -----------------------
     money      in-app, push, email, sms
                Money is what people complain about, and the person who
                needs to know may not have the app open.
     orders     in-app, push, email
     disputes   in-app, push, email
     kyc        in-app, push, email
     chat       in-app, push
                Never email a chat message. That is how a customer ends
                up unsubscribed from everything.
     security   in-app, push, email
     system     in-app only

   The user's own preferences are honoured on top of this: a category can
   be switched off per channel in notification_preferences, and the whole
   channel can be switched off in user_settings.
*/

begin;

/* ========================================================================== *
 * 1. THE RULES
 * ========================================================================== */

create table if not exists public.notification_rules (
  kind text primary key,
  category text not null default 'system',
  title text not null,
  body text not null default '',
  link text,
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'critical')),
  channels text[] not null default array['in_app']::text[],
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists notification_rules_category_idx
  on public.notification_rules (category);

insert into public.notification_rules (kind, category, title, body, link, priority, channels) values
  -- money
  ('wallet_topped_up', 'money', 'Top-up received',
   'TSh {amount} was added to your wallet. New balance TSh {balance}.', '/transactions', 'normal',
   array['in_app','push','email','sms']::text[]),
  ('payment_credited', 'money', 'Payment received',
   'TSh {amount} was credited to your wallet.', '/transactions', 'normal',
   array['in_app','push','email','sms']::text[]),
  ('order_refunded', 'money', 'Refund issued',
   'TSh {amount} was refunded to your wallet for order {ref}.', '/transactions', 'high',
   array['in_app','push','email','sms']::text[]),
  ('payout_requested', 'money', 'Withdrawal requested',
   'Your withdrawal of TSh {amount} is with our team. You will be paid once it is approved.',
   '/transactions', 'high', array['in_app','push','email','sms']::text[]),

  -- orders
  ('order_created', 'orders', 'New order',
   'Order {ref} was created for TSh {amount}.', '/transactions', 'normal',
   array['in_app','push','email']::text[]),
  ('escrow_funded', 'orders', 'Money held in escrow',
   'TSh {amount} for order {ref} is held in escrow. It is released when the delivery is confirmed.',
   '/transactions', 'normal', array['in_app','push','email']::text[]),
  ('order_completed', 'orders', 'Order complete',
   'Order {ref} is complete. TSh {amount} has been released.', '/transactions', 'normal',
   array['in_app','push','email']::text[]),
  ('order_cancelled', 'orders', 'Order cancelled',
   'Order {ref} was cancelled.', '/transactions', 'normal',
   array['in_app','push','email']::text[]),
  ('order_delivered', 'orders', 'Order delivered',
   'Order {ref} has been delivered.', '/transactions', 'normal',
   array['in_app','push','email']::text[]),
  ('handoff_verified', 'orders', 'Handoff verified',
   'The handoff for order {ref} was verified.', '/transactions', 'normal',
   array['in_app','push','email']::text[]),
  ('handoff_scanned', 'orders', 'Handoff scanned',
   'A handoff code for order {ref} was scanned.', '/transactions', 'normal',
   array['in_app','push','email']::text[]),
  ('handoff_reissued', 'orders', 'Handoff code reissued',
   'A new handoff code was issued for order {ref}.', '/transactions', 'normal',
   array['in_app','push','email']::text[]),
  ('review_received', 'orders', 'You received a review',
   'A buyer reviewed order {ref}.', '/transactions', 'low',
   array['in_app','push']::text[]),

  -- disputes
  ('dispute_opened', 'disputes', 'A dispute was opened',
   'Order {ref} is now in dispute. The money stays frozen until it is resolved.',
   '/transactions', 'high', array['in_app','push','email']::text[]),
  ('dispute_reply', 'disputes', 'New reply on your dispute',
   'Someone replied on the dispute for order {ref}.', '/transactions', 'normal',
   array['in_app','push','email']::text[]),
  ('dispute_escalated', 'disputes', 'Dispute escalated',
   'The dispute for order {ref} was escalated for review.', '/transactions', 'high',
   array['in_app','push','email']::text[]),
  ('dispute_resolved', 'disputes', 'Dispute resolved',
   'The dispute for order {ref} was resolved.', '/transactions', 'high',
   array['in_app','push','email']::text[]),

  -- verification
  ('kyc_approved', 'kyc', 'Your seller account is verified',
   'You can now list products, publish live sessions and receive orders.',
   '/verification', 'high', array['in_app','push','email']::text[]),
  ('kyc_rejected', 'kyc', 'Your verification needs attention',
   'Your verification was not approved. Open Verification to see what to correct.',
   '/verification', 'high', array['in_app','push','email']::text[]),

  -- chat
  ('message_received', 'chat', 'New message',
   'You have a new message.', '/messages', 'normal',
   array['in_app','push']::text[]),

  -- everything else
  ('support_update', 'system', 'Update from support',
   'There is an update from the Kobe Mweusi team.', '/notifications', 'normal',
   array['in_app']::text[])
on conflict (kind) do update
set category = excluded.category,
    title = excluded.title,
    body = excluded.body,
    link = excluded.link,
    priority = excluded.priority,
    channels = excluded.channels;

/* ========================================================================== *
 * 2. THE PROJECTION
 * ========================================================================== */

create or replace function public.project_activity_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule public.notification_rules%rowtype;
  v_notification_id uuid;
  v_channel text;
  v_title text;
  v_body text;
  v_payload jsonb;
  v_settings public.user_settings%rowtype;
  v_pref public.notification_preferences%rowtype;
  v_delivery_id uuid;
begin
  select r.* into v_rule
  from public.notification_rules r
  where r.kind = new.kind and r.enabled;

  if not found then
    return new;
  end if;

  v_payload := coalesce(new.payload, '{}'::jsonb);

  -- The wording may refer to the order, the amount or the shop, so those
  -- are pulled in here rather than by whoever wrote the event.
  if new.order_id is not null then
    v_payload := v_payload || coalesce(
      (select jsonb_build_object('ref', o.ref, 'amount', o.total_due_tzs)
         from public.orders o where o.id = new.order_id),
      '{}'::jsonb);
  end if;

  v_title := v_rule.title;
  v_body := v_rule.body;

  -- {ref}, {amount}, {balance} and {shop} are the placeholders.
  v_body := replace(v_body, '{ref}', coalesce(v_payload ->> 'ref', ''));
  v_body := replace(v_body, '{amount}',
    case when (v_payload ->> 'amount') is not null
         then 'TSh ' || to_char((v_payload ->> 'amount')::numeric, 'FM999,999,999')
         else '' end);
  v_body := replace(v_body, '{balance}',
    case when (v_payload ->> 'balance') is not null
         then 'TSh ' || to_char((v_payload ->> 'balance')::numeric, 'FM999,999,999')
         else '' end);
  v_body := replace(v_body, '{shop}', coalesce(v_payload ->> 'shop', ''));
  v_title := replace(v_title, '{ref}', coalesce(v_payload ->> 'ref', ''));
  v_title := replace(v_title, '{amount}',
    case when (v_payload ->> 'amount') is not null
         then 'TSh ' || to_char((v_payload ->> 'amount')::numeric, 'FM999,999,999')
         else '' end);

  -- A body that ends up saying "TSh ." is worse than no body at all.
  v_body := regexp_replace(v_body, '\s+TSh\s*\.', '', 'g');
  v_body := trim(both ' ' from v_body);

  -- The durable inbox row.
  insert into public.notifications
    (user_id, kind, title, body, link, payload, category, channel, priority, order_id)
  values
    (new.user_id, new.kind, left(v_title, 160), left(v_body, 2000),
     v_rule.link, v_payload, v_rule.category, 'in_app', v_rule.priority, new.order_id)
  returning id into v_notification_id;

  -- The user's own settings, which can switch a whole channel off.
  select s.* into v_settings
  from public.user_settings s where s.user_id = new.user_id;

  -- One delivery record per channel, so each channel can be retried on
  -- its own and fail on its own.
  foreach v_channel in array v_rule.channels loop
    -- The global channel switches.
    if v_channel = 'push' and coalesce(v_settings.push_enabled, true) = false then
      continue;
    end if;
    if v_channel = 'email' and coalesce(v_settings.email_enabled, true) = false then
      continue;
    end if;
    if v_channel = 'sms' and coalesce(v_settings.sms_enabled, true) = false then
      continue;
    end if;

    -- The per-category switch. No row means the default, which is on.
    select p.* into v_pref
    from public.notification_preferences p
    where p.user_id = new.user_id and p.category = v_rule.category;

    if v_pref.category is not null then
      if v_channel = 'in_app' and v_pref.in_app = false then continue; end if;
      if v_channel = 'push' and v_pref.push = false then continue; end if;
      if v_channel = 'email' and v_pref.email = false then continue; end if;
      if v_channel = 'sms' and v_pref.sms = false then continue; end if;
    end if;

    insert into public.notification_deliveries
      (notification_id, user_id, channel, status, next_attempt_at)
    values
      (v_notification_id, new.user_id, v_channel, 'queued', now())
    returning id into v_delivery_id;
  end loop;

  return new;
end;
$$;
revoke all on function public.project_activity_event() from public, anon;
grant execute on function public.project_activity_event() to service_role;

drop trigger if exists activity_events_project on public.activity_events;
create trigger activity_events_project
  after insert on public.activity_events
  for each row execute function public.project_activity_event();

/* ========================================================================== *
 * 3. A USER-SIDE VIEW
 *
 *    The apps read this instead of the notifications table directly, so
 *    the shape they depend on is in one place.
 * ========================================================================== */

create or replace view public.my_notifications
with (security_invoker = true)
as
  select
    n.id,
    n.kind,
    n.title,
    n.body,
    n.link,
    n.payload,
    n.category,
    n.priority,
    n.order_id,
    n.read_at,
    n.created_at
  from public.notifications n
  where n.user_id = (select auth.uid());

grant select on public.my_notifications to authenticated;
revoke all on public.my_notifications from anon;

commit;
