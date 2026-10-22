/* Kobe Mweusi — Module F: notifications and device management.

   A database row alone does not cause a notification to appear on a phone.
   Browser push needs permission, a service worker, a VAPID key pair and a
   delivery worker. This module provides the durable records those pieces
   need: a persistent inbox, per-category preferences, delivery attempts with
   retries, and the web-push subscription registry.

   Tables added here
     notification_preferences   categories and channels per user
     notification_deliveries    delivery attempts, provider status, retries

   Functions added here
     create_notification(), mark_notification_read(), list_my_notifications()
     register_push_subscription(), remove_push_subscription()
     process_notification_queue(), unread_notification_count()
*/

alter table public.notifications
  add column if not exists category text not null default 'general';

alter table public.notifications
  add column if not exists channel text not null default 'in_app';

alter table public.notifications
  add column if not exists order_id uuid references public.orders (id) on delete cascade;

alter table public.notifications
  add column if not exists priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'critical'));

create index if not exists notifications_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;

create index if not exists notifications_category_idx
  on public.notifications (user_id, category, created_at desc);

/* ========================================================================== *
 * 1. PREFERENCES
 * ========================================================================== */

create table if not exists public.notification_preferences (
  user_id uuid not null references public.profiles (id) on delete cascade,
  category text not null,
  in_app boolean not null default true,
  push boolean not null default true,
  email boolean not null default false,
  sms boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from anon, authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;

drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop trigger if exists notification_preferences_set_updated_at on public.notification_preferences;
create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

/* ========================================================================== *
 * 2. DELIVERY RECORDS
 * ========================================================================== */

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  channel text not null check (channel in ('in_app', 'push', 'email', 'sms')),
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  next_attempt_at timestamptz not null default now(),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_deliveries_queue_idx
  on public.notification_deliveries (next_attempt_at)
  where status in ('queued', 'failed');
create index if not exists notification_deliveries_user_idx
  on public.notification_deliveries (user_id, created_at desc);

alter table public.notification_deliveries enable row level security;
revoke all on public.notification_deliveries from anon, authenticated;

drop trigger if exists notification_deliveries_set_updated_at on public.notification_deliveries;
create trigger notification_deliveries_set_updated_at
  before update on public.notification_deliveries
  for each row execute function public.set_updated_at();

/* ========================================================================== *
 * 3. NOTIFICATION FUNCTIONS
 * ========================================================================== */

/* Create a notification and queue the push delivery. */
create or replace function public.create_notification(
  p_user_id uuid,
  p_kind text,
  p_title text,
  p_body text,
  p_link text default null,
  p_payload jsonb default '{}'::jsonb,
  p_category text default 'general',
  p_priority text default 'normal',
  p_order_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_push_ok boolean;
begin
  if p_user_id is null then
    raise exception 'A recipient is required' using errcode = 'P0001';
  end if;

  insert into public.notifications
    (user_id, kind, title, body, link, payload, category, priority, order_id)
  values
    (p_user_id, p_kind, btrim(p_title), btrim(p_body), p_link,
     coalesce(p_payload, '{}'::jsonb), coalesce(p_category, 'general'),
     coalesce(p_priority, 'normal'), p_order_id)
  returning id into v_id;

  select coalesce(np.push, true) into v_push_ok
  from (select true) x
  left join public.notification_preferences np
    on np.user_id = p_user_id and np.category = coalesce(p_category, 'general');

  if v_push_ok and exists (select 1 from public.push_subscriptions s where s.user_id = p_user_id) then
    insert into public.notification_deliveries
      (notification_id, user_id, channel, status, next_attempt_at)
    values (v_id, p_user_id, 'push', 'queued', now());
  end if;

  return v_id;
end;
$$;
revoke all on function public.create_notification(uuid, text, text, text, text, jsonb, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_notification(uuid, text, text, text, text, jsonb, text, text, uuid)
  to service_role;

/* Mark one notification read. */
create or replace function public.mark_notification_read(p_notification_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.notifications
    set read_at = now()
    where id = p_notification_id
      and user_id = (select auth.uid())
      and read_at is null;
  return found;
end;
$$;
revoke all on function public.mark_notification_read(uuid) from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;

/* Mark every notification read. */
create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  update public.notifications
    set read_at = now()
    where user_id = (select auth.uid()) and read_at is null;
  get diagnostics v_count = ROW_COUNT;
  return v_count;
end;
$$;
revoke all on function public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_all_notifications_read() to authenticated;

create or replace function public.unread_notification_count()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer
  from public.notifications
  where user_id = (select auth.uid()) and read_at is null;
$$;
grant execute on function public.unread_notification_count() to authenticated;

create or replace function public.list_my_notifications(p_limit integer default 50)
returns setof public.notifications
language sql
stable
security invoker
set search_path = ''
as $$
  select n.*
  from public.notifications n
  where n.user_id = (select auth.uid())
  order by n.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
grant execute on function public.list_my_notifications(integer) to authenticated;

/* ========================================================================== *
 * 4. PUSH SUBSCRIPTIONS
 * ========================================================================== */

/* Register a browser push subscription. The endpoint is the identity; a
   device may re-subscribe with fresh keys. */
create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_endpoint is null or btrim(p_endpoint) = '' then
    raise exception 'An endpoint is required' using errcode = 'P0001';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (v_user, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh,
        auth = excluded.auth, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.register_push_subscription(text, text, text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text) to authenticated;

/* Remove a push subscription. A user may only remove their own. */
create or replace function public.remove_push_subscription(p_endpoint text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.push_subscriptions
    where endpoint = p_endpoint and user_id = (select auth.uid());
  return found;
end;
$$;
revoke all on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.remove_push_subscription(text) to authenticated;

/* ========================================================================== *
 * 5. DELIVERY QUEUE
 * ========================================================================== */

/* Claim queued deliveries for the push worker. Returns the rows and marks
   them "sending" so two workers cannot pick up the same notification. */
create or replace function public.claim_notification_deliveries(p_limit integer default 50)
returns setof public.notification_deliveries
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  return query
  with picked as (
    select d.id
    from public.notification_deliveries d
    where d.status in ('queued', 'failed')
      and d.next_attempt_at <= now()
      and d.attempts < d.max_attempts
    order by d.next_attempt_at
    for update skip locked
    limit v_batch
  )
  update public.notification_deliveries d
    set status = 'sending', attempts = d.attempts + 1, updated_at = now()
  from picked p
  where d.id = p.id
  returning d.*;
end;
$$;
revoke all on function public.claim_notification_deliveries(integer) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(integer) to service_role;

/* Report the result of a delivery attempt. A failure schedules a retry with
   exponential backoff until max_attempts is reached. */
create or replace function public.complete_notification_delivery(
  p_delivery_id uuid,
  p_success boolean,
  p_error text default null,
  p_provider_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery public.notification_deliveries%rowtype;
begin
  select d.* into v_delivery
  from public.notification_deliveries d
  where d.id = p_delivery_id for update;

  if not found then
    raise exception 'Delivery not found' using errcode = 'P0002';
  end if;

  update public.notification_deliveries
    set status = case when p_success then 'sent'::text
                      when attempts >= max_attempts then 'failed'::text
                      else 'failed'::text end,
        sent_at = case when p_success then now() else sent_at end,
        last_error = case when p_success then null
                          else nullif(left(coalesce(p_error, 'unknown error'), 500), '') end,
        provider_message_id = coalesce(p_provider_message_id, provider_message_id),
        next_attempt_at = case
          when p_success then next_attempt_at
          else now() + make_interval(secs => least(3600, (2 ^ attempts) * 30))
        end,
        updated_at = now()
    where id = p_delivery_id
    returning * into v_delivery;

  return jsonb_build_object(
    'ok', true, 'status', v_delivery.status, 'attempts', v_delivery.attempts,
    'next_attempt_at', v_delivery.next_attempt_at);
end;
$$;
revoke all on function public.complete_notification_delivery(uuid, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_notification_delivery(uuid, boolean, text, text) to service_role;

/* Expired subscriptions and notifications are pruned on a schedule. */
create or replace function public.prune_notification_queue(p_older_than_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_rows integer := 0;
begin
  delete from public.notification_deliveries
    where status in ('sent', 'failed')
      and updated_at < now() - make_interval(days => greatest(1, coalesce(p_older_than_days, 30)));
  get diagnostics v_count = ROW_COUNT;

  delete from public.notifications
    where read_at is not null
      and created_at < now() - make_interval(days => greatest(1, coalesce(p_older_than_days, 30)));
  get diagnostics v_rows = row_count;
  v_count := v_count + v_rows;

  return v_count;
end;
$$;
revoke all on function public.prune_notification_queue(integer) from public, anon, authenticated;
grant execute on function public.prune_notification_queue(integer) to service_role;
