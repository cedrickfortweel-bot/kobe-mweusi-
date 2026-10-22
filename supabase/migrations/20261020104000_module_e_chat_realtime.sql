/* Kobe Mweusi — Module E: chat, messaging and realtime updates.

   Chat supports buyer/seller communication and authorised customer support.
   A conversation is never visible to a user who is not a participant.

   Tables added here
     chat_thread_members      explicit participant membership
     message_attachments     references to stored images or files
     message_read_receipts   per-user read state
     user_presence           online / last-seen presence

   Functions added here
     start_chat_thread(), send_chat_message(), mark_chat_thread_read()
     unread_message_count(), list_my_threads(), set_presence()
*/

/* ========================================================================== *
 * 1. THREAD MEMBERS
 * ========================================================================== */

create table if not exists public.chat_thread_members (
  thread_buyer uuid not null references public.profiles (id) on delete cascade,
  thread_seller uuid not null references public.profiles (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('buyer', 'seller', 'support')),
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (thread_buyer, thread_seller, user_id)
);

create index if not exists chat_thread_members_user_idx
  on public.chat_thread_members (user_id, joined_at desc);

alter table public.chat_thread_members enable row level security;
revoke all on public.chat_thread_members from anon, authenticated;
grant select on public.chat_thread_members to authenticated;

drop policy if exists chat_thread_members_select_own on public.chat_thread_members;
create policy chat_thread_members_select_own on public.chat_thread_members
  for select to authenticated using (user_id = (select auth.uid()));

/* ========================================================================== *
 * 2. ATTACHMENTS AND READ RECEIPTS
 * ========================================================================== */

create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  storage_path text not null,
  mime_type text not null check (char_length(mime_type) between 1 and 120),
  size_bytes bigint not null check (size_bytes > 0),
  created_at timestamptz not null default now()
);

create index if not exists message_attachments_message_idx
  on public.message_attachments (message_id);

alter table public.message_attachments enable row level security;
revoke all on public.message_attachments from anon, authenticated;
grant select on public.message_attachments to authenticated;

drop policy if exists message_attachments_select_participant on public.message_attachments;
create policy message_attachments_select_participant on public.message_attachments
  for select to authenticated
  using (exists (
    select 1 from public.chat_messages m
    where m.id = message_id
      and (m.thread_buyer = (select auth.uid()) or m.thread_seller = (select auth.uid()))
  ));

create table if not exists public.message_read_receipts (
  message_id uuid not null references public.chat_messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index if not exists message_read_receipts_user_idx
  on public.message_read_receipts (user_id, read_at desc);

alter table public.message_read_receipts enable row level security;
revoke all on public.message_read_receipts from anon, authenticated;
grant select on public.message_read_receipts to authenticated;

drop policy if exists message_read_receipts_select_participant on public.message_read_receipts;
create policy message_read_receipts_select_participant on public.message_read_receipts
  for select to authenticated
  using (exists (
    select 1 from public.chat_messages m
    where m.id = message_id
      and (m.thread_buyer = (select auth.uid()) or m.thread_seller = (select auth.uid()))
  ));

/* ========================================================================== *
 * 3. PRESENCE
 * ========================================================================== */

create table if not exists public.user_presence (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  is_online boolean not null default false,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_presence enable row level security;
revoke all on public.user_presence from anon, authenticated;
grant select, insert, update on public.user_presence to authenticated;

drop policy if exists user_presence_select_participant on public.user_presence;
create policy user_presence_select_participant on public.user_presence
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.chat_threads t
      where (t.buyer_id = (select auth.uid()) and t.seller_id = user_presence.user_id)
         or (t.seller_id = (select auth.uid()) and t.buyer_id = user_presence.user_id)
    )
  );

drop policy if exists user_presence_write_own on public.user_presence;
create policy user_presence_write_own on public.user_presence
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop trigger if exists user_presence_set_updated_at on public.user_presence;
create trigger user_presence_set_updated_at
  before update on public.user_presence
  for each row execute function public.set_updated_at();

/* ========================================================================== *
 * 4. CHAT FUNCTIONS
 * ========================================================================== */

/* Start (or reuse) a conversation with a counterparty. The pair is
   normalised so buyer/seller ordering is stable. */
create or replace function public.start_chat_thread(
  p_counterparty uuid,
  p_order_id uuid default null
)
returns public.chat_threads
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_buyer uuid;
  v_seller uuid;
  v_thread public.chat_threads%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_counterparty is null or p_counterparty = v_user then
    raise exception 'Choose another person to chat with' using errcode = 'P0001';
  end if;

  -- If the conversation belongs to an order, the buyer/seller sides follow
  -- the order so a seller cannot impersonate the buyer.
  if p_order_id is not null then
    select o.buyer_id, o.seller_id into v_buyer, v_seller
    from public.orders o where o.id = p_order_id;

    if found and (v_buyer = v_user or v_seller = v_user) then
      -- keep the order's orientation
    else
      v_buyer := null;
      v_seller := null;
    end if;
  end if;

  if v_buyer is null then
    if v_user < p_counterparty then
      v_buyer := v_user; v_seller := p_counterparty;
    else
      v_buyer := p_counterparty; v_seller := v_user;
    end if;
  end if;

  insert into public.chat_threads (buyer_id, seller_id, initiated_by)
  values (v_buyer, v_seller, v_user)
  on conflict (buyer_id, seller_id) do update set updated_at = now()
  returning * into v_thread;

  insert into public.chat_thread_members (thread_buyer, thread_seller, user_id, role)
  values
    (v_buyer, v_seller, v_buyer, case when v_buyer = v_user then 'buyer' else 'support' end),
    (v_buyer, v_seller, v_seller, case when v_seller = v_user then 'seller' else 'support' end)
  on conflict do nothing;

  return v_thread;
end;
$$;
revoke all on function public.start_chat_thread(uuid, uuid) from public, anon;
grant execute on function public.start_chat_thread(uuid, uuid) to authenticated;

/* Send a message. The sender is always the signed-in user. */
create or replace function public.send_chat_message(
  p_counterparty uuid,
  p_body text,
  p_order_id uuid default null
)
returns public.chat_messages
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_thread public.chat_threads%rowtype;
  v_message public.chat_messages%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) < 1 then
    raise exception 'A message cannot be empty' using errcode = 'P0001';
  end if;

  v_thread := public.start_chat_thread(p_counterparty, p_order_id);

  insert into public.chat_messages (thread_buyer, thread_seller, sender_id, body)
  values (v_thread.buyer_id, v_thread.seller_id, v_user, btrim(p_body))
  returning * into v_message;

  return v_message;
end;
$$;
revoke all on function public.send_chat_message(uuid, text, uuid) from public, anon;
grant execute on function public.send_chat_message(uuid, text, uuid) to authenticated;

/* Mark everything in a thread as read for the signed-in user. */
create or replace function public.mark_chat_thread_read(p_counterparty uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_buyer uuid;
  v_seller uuid;
  v_count integer := 0;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if v_user < p_counterparty then
    v_buyer := v_user; v_seller := p_counterparty;
  else
    v_buyer := p_counterparty; v_seller := v_user;
  end if;

  update public.chat_threads
    set buyer_seen_at = case when buyer_id = v_user then now() else buyer_seen_at end,
        seller_seen_at = case when seller_id = v_user then now() else seller_seen_at end
    where buyer_id = v_buyer and seller_id = v_seller;

  insert into public.message_read_receipts (message_id, user_id)
  select m.id, v_user
  from public.chat_messages m
  where m.thread_buyer = v_buyer and m.thread_seller = v_seller
    and m.sender_id <> v_user
    and not exists (
      select 1 from public.message_read_receipts r
      where r.message_id = m.id and r.user_id = v_user
    )
  on conflict do nothing;

  get diagnostics v_count = row_count;

  return v_count;
end;
$$;
revoke all on function public.mark_chat_thread_read(uuid) from public, anon;
grant execute on function public.mark_chat_thread_read(uuid) to authenticated;

/* Unread count for the badge. */
create or replace function public.unread_message_count()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer
  from public.chat_messages m
  where (m.thread_buyer = (select auth.uid()) or m.thread_seller = (select auth.uid()))
    and m.sender_id <> (select auth.uid())
    and not exists (
      select 1 from public.message_read_receipts r
      where r.message_id = m.id and r.user_id = (select auth.uid())
    );
$$;
grant execute on function public.unread_message_count() to authenticated;

/* The caller's conversations, most recently active first. */
create or replace function public.list_my_threads(p_limit integer default 50)
returns table (
  thread_buyer uuid,
  thread_seller uuid,
  counterparty_id uuid,
  counterparty_name text,
  last_body text,
  last_message_at timestamptz,
  unread integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with mine as (
    select t.*,
      case when t.buyer_id = (select auth.uid()) then t.seller_id else t.buyer_id end as other
    from public.chat_threads t
    where t.buyer_id = (select auth.uid()) or t.seller_id = (select auth.uid())
  )
  select m.buyer_id as thread_buyer, m.seller_id as thread_seller, m.other,
    coalesce(nullif(sp.shop_name, ''), pr.display_name, 'Kobe user'),
    (select msg.body from public.chat_messages msg
      where msg.thread_buyer = m.buyer_id and msg.thread_seller = m.seller_id
      order by msg.created_at desc limit 1),
    (select max(msg.created_at) from public.chat_messages msg
      where msg.thread_buyer = m.buyer_id and msg.thread_seller = m.seller_id),
    (select count(*)::integer from public.chat_messages msg
      where msg.thread_buyer = m.buyer_id and msg.thread_seller = m.seller_id
        and msg.sender_id <> (select auth.uid())
        and not exists (
          select 1 from public.message_read_receipts r
          where r.message_id = msg.id and r.user_id = (select auth.uid())
        ))
  from mine m
  left join public.seller_profiles sp on sp.user_id = m.other
  left join public.profiles pr on pr.id = m.other
  order by 6 desc nulls last
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
grant execute on function public.list_my_threads(integer) to authenticated;

/* Presence heartbeat. */
create or replace function public.set_presence(p_online boolean)
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

  insert into public.user_presence (user_id, is_online, last_seen_at)
  values (v_user, coalesce(p_online, false), now())
  on conflict (user_id) do update
    set is_online = excluded.is_online, last_seen_at = now(), updated_at = now();

  return jsonb_build_object('ok', true, 'is_online', coalesce(p_online, false), 'at', now());
end;
$$;
revoke all on function public.set_presence(boolean) from public, anon;
grant execute on function public.set_presence(boolean) to authenticated;
