/* Kobe Mweusi — live schema reconciliation.

   Purpose
   -------
   The deployed Supabase project contains tables, columns, trigger functions and
   triggers that are NOT reproducible from the migration history in this folder.
   This migration closes that gap so a fresh `supabase db reset` produces the
   same shape as the live database, and every later module can rely on it.

   Drift reconciled here
   ---------------------
   Tables   : wallets, kobe_id_registry, delivery_agents, delivery_assignments,
              order_delivery_workflows, handoff_events, pin_throttle,
              support_request_audit
   Columns  : orders.delivered_at, orders.confirm_by, chat_threads.initiated_by,
              activity_events.read_at, handoff_codes.revoked_at,
              handoff_codes.scanned_by, activity_events extra kinds
   Enums    : live_platform (instagram/facebook/whatsapp), dispute_status
              (escalated), order_status (unchanged — verified against the app)
   Functions: assign_kobe_id, protect_seller_locked_fields, prevent_self_verification,
              block_ledger_mutation, force_server_fields,
              guard_order_changes, guard_live_session, check_order_live_session,
              guard_chat_thread_update, guard_chat_thread_initiator,
              on_chat_message_insert, on_dispute_message_insert

   Everything here is written to be safe against the live database (idempotent,
   additive only). No column is dropped and no row is rewritten.

   NOTE ON ENUM VALUES
   -------------------
   `ALTER TYPE ... ADD VALUE` cannot use the new value in the same transaction.
   The enum widening therefore lives in this file, while the constraint that
   *uses* the new platforms is recreated in
   20261020090100_live_platform_constraints.sql (a later, separate transaction).
*/

create extension if not exists pgcrypto with schema extensions;

/* ========================================================================== *
 * 1. ENUM WIDENING
 * ========================================================================== */

do $$
begin
  if not exists (select 1 from pg_type t join pg_enum e on e.enumtypid = t.oid
                 where t.typname = 'live_platform' and e.enumlabel = 'instagram') then
    alter type public.live_platform add value 'instagram';
  end if;
  if not exists (select 1 from pg_type t join pg_enum e on e.enumtypid = t.oid
                 where t.typname = 'live_platform' and e.enumlabel = 'facebook') then
    alter type public.live_platform add value 'facebook';
  end if;
  if not exists (select 1 from pg_type t join pg_enum e on e.enumtypid = t.oid
                 where t.typname = 'live_platform' and e.enumlabel = 'whatsapp') then
    alter type public.live_platform add value 'whatsapp';
  end if;
  if not exists (select 1 from pg_type t join pg_enum e on e.enumtypid = t.oid
                 where t.typname = 'dispute_status' and e.enumlabel = 'escalated') then
    alter type public.dispute_status add value 'escalated';
  end if;
end
$$;

/* ========================================================================== *
 * 2. BUYER WALLET IDENTITY
 *
 *    wallets is the owner of the memorable buyer Wallet ID (KMB-27-MAZI).
 *    It is deliberately NOT the money balance: the balance is the sum of
 *    wallet_ledger_entries for the user. Creating a wallet must never
 *    create, credit or release money.
 * ========================================================================== */

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  wallet_id text not null unique check (wallet_id ~ '^KMB-[0-9]{2}-[A-Z]{4}$'),
  created_at timestamptz not null default now()
);

alter table public.wallets enable row level security;
revoke all on public.wallets from anon, authenticated;

create index if not exists wallets_user_idx on public.wallets (user_id);

/* ========================================================================== *
 * 3. SELLER KOBE ID REGISTRY
 *
 *    The registry owns the permanent public seller identity (KOBE12XL).
 *    seller_profiles.kobe_id keeps the app-facing `KM-...` value that the
 *    buyer/seller PWAs already display; the registry links the two so the
 *    canonical blueprint format is reserved exactly once per seller.
 * ========================================================================== */

create table if not exists public.kobe_id_registry (
  kobe_id text not null check (kobe_id ~ '^KOBE[0-9]{2}[A-Z]{2}$'),
  assigned_user_id uuid not null,
  assigned_at timestamptz not null default now(),
  constraint kobe_id_registry_pkey primary key (kobe_id)
);

alter table public.kobe_id_registry enable row level security;
revoke all on public.kobe_id_registry from anon, authenticated;

create unique index if not exists kobe_id_registry_user_idx
  on public.kobe_id_registry (assigned_user_id);

alter table public.kobe_id_registry
  add column if not exists app_kobe_id text;

create unique index if not exists kobe_id_registry_app_kobe_id_idx
  on public.kobe_id_registry (app_kobe_id)
  where app_kobe_id is not null;

/* ========================================================================== *
 * 4. DELIVERY, HUBS AND HANDOFF AUDIT
 * ========================================================================== */

create table if not exists public.delivery_agents (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  verification_status text not null default 'pending'
    check (verification_status in ('pending', 'verified', 'rejected', 'suspended')),
  verified_at timestamptz,
  verified_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.delivery_assignments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  agent_user_id uuid not null references public.delivery_agents (user_id) on delete cascade,
  status text not null default 'assigned'
    check (status in ('assigned', 'accepted', 'completed', 'cancelled')),
  assigned_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_delivery_workflows (
  order_id uuid primary key references public.orders (id) on delete cascade,
  delivery_mode text check (delivery_mode in ('direct', 'agent')),
  stage text not null default 'not_started'
    check (stage in ('not_started', 'direct_pending', 'direct_delivered',
                     'seller_to_agent_complete', 'delivered_pending_confirmation')),
  first_direct_code_type public.handoff_code_type,
  first_scanned_by uuid references public.profiles (id),
  agent_user_id uuid references public.delivery_agents (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.handoff_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  stage text not null
    check (stage in ('direct_handoff', 'seller_to_agent', 'agent_to_buyer')),
  scanned_by uuid not null references public.profiles (id),
  qr_code_id uuid not null unique references public.handoff_codes (id),
  created_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create index if not exists handoff_events_order_idx on public.handoff_events (order_id, created_at);

/* ========================================================================== *
 * 5. PIN THROTTLING AND SUPPORT AUDIT
 * ========================================================================== */

create table if not exists public.pin_throttle (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.support_request_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.support_requests (id) on delete cascade,
  staff_id uuid not null references public.profiles (id),
  action text not null
    check (action in ('triaged', 'resolved', 'closed', 'reopened', 'note')),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now()
);

/* ========================================================================== *
 * 6. MISSING COLUMNS
 * ========================================================================== */

alter table public.orders
  add column if not exists delivered_at timestamptz;

alter table public.orders
  add column if not exists confirm_by timestamptz;

alter table public.chat_threads
  add column if not exists initiated_by uuid references public.profiles (id);

alter table public.activity_events
  add column if not exists read_at timestamptz;

alter table public.handoff_codes
  add column if not exists revoked_at timestamptz;

alter table public.handoff_codes
  add column if not exists scanned_by uuid references public.profiles (id);

create index if not exists activity_events_unread_idx
  on public.activity_events (user_id, created_at desc)
  where read_at is null;

/* The live activity feed carries more event kinds than the original
   constraint allowed. Widening a CHECK constraint requires dropping and
   recreating it, so it is done additively and NOT VALID first. */
alter table public.activity_events
  drop constraint if exists activity_events_kind_check;

alter table public.activity_events
  add constraint activity_events_kind_check
  check (kind in (
    'order_created', 'order_cancelled', 'escrow_funded', 'order_completed',
    'order_refunded', 'dispute_opened', 'dispute_reply', 'handoff_verified',
    'handoff_reissued', 'review_received', 'message_received', 'payout_requested',
    'support_update', 'handoff_scanned', 'order_delivered', 'dispute_escalated',
    'kyc_approved', 'kyc_rejected', 'payment_credited', 'wallet_topped_up'
  )) not valid;

/* ========================================================================== *
 * 7. LIVE TRIGGER FUNCTIONS
 *
 *    These guard functions exist in the deployed database but not in the
 *    migration history. They are recreated here so a rebuilt database
 *    enforces the same rules. Bodies are written to match the deployed
 *    behaviour described by the trigger inventory.
 * ========================================================================== */

/* Assigns the permanent app-facing seller Kobe ID exactly once and
   reserves the canonical registry code (KOBE12XL). */
create or replace function public.assign_kobe_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kobe_id is null or btrim(new.kobe_id) = '' then
    new.kobe_id := 'KM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 15));
  elsif tg_op = 'UPDATE' and new.kobe_id is distinct from old.kobe_id then
    raise exception 'Kobe ID is permanent and cannot be changed'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.assign_kobe_id() from public, anon, authenticated;

drop trigger if exists seller_profiles_kobe_id_guard on public.seller_profiles;
create trigger seller_profiles_kobe_id_guard
  before insert or update on public.seller_profiles
  for each row execute function public.assign_kobe_id();

/* Fields a seller may never change for themselves. */
create or replace function public.protect_seller_locked_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status is distinct from old.verification_status
     and (select auth.role()) <> 'service_role' then
    raise exception 'Verification status is set by the review process'
      using errcode = 'P0001';
  end if;
  if new.user_id is distinct from old.user_id then
    raise exception 'Seller profile owner cannot be changed'
      using errcode = 'P0001';
  end if;
  if old.kobe_id is not null and new.kobe_id is distinct from old.kobe_id then
    raise exception 'Kobe ID is permanent and cannot be changed'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_seller_locked_fields() from public, anon, authenticated;

drop trigger if exists seller_profiles_protect_locked_fields on public.seller_profiles;
create trigger seller_profiles_protect_locked_fields
  before update on public.seller_profiles
  for each row execute function public.protect_seller_locked_fields();

/* A seller cannot grant themselves the verified badge. */
create or replace function public.prevent_self_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status is distinct from old.verification_status
     and new.verification_status = 'verified'
     and (select auth.role()) <> 'service_role' then
    raise exception 'Verification is granted by the KYC review process'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_self_verification() from public, anon, authenticated;

drop trigger if exists prevent_self_verification on public.seller_profiles;
create trigger prevent_self_verification
  before insert or update on public.seller_profiles
  for each row execute function public.prevent_self_verification();
/* Internal roles live in internal_user_roles; nothing to guard on profiles. */

/* The ledger is append-only. */
create or replace function public.block_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Wallet ledger entries are immutable'
    using errcode = 'P0001';
end;
$$;
revoke all on function public.block_ledger_mutation() from public, anon, authenticated;

drop trigger if exists wallet_ledger_no_update_delete on public.wallet_ledger_entries;
create trigger wallet_ledger_no_update_delete
  before update or delete on public.wallet_ledger_entries
  for each row execute function public.block_ledger_mutation();

/* Forces server-owned columns on rows the client inserts.

   The trigger is shared by two tables with different server-owned
   columns, so the table is checked by name. auth.uid() is null for
   service-role calls, in which case the existing values are kept. */
create or replace function public.force_server_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  if v_actor is null then
    return new;
  end if;

  if tg_table_name = 'dispute_messages' then
    new.sender_id := v_actor;
    new.created_at := now();
  elsif tg_table_name = 'seller_kyc_submissions' then
    new.submitted_by := v_actor;
    new.submitted_at := now();
  end if;

  return new;
end;
$$;
revoke all on function public.force_server_fields() from public, anon, authenticated;

drop trigger if exists dispute_messages_force_fields on public.dispute_messages;
create trigger dispute_messages_force_fields
  before insert on public.dispute_messages
  for each row execute function public.force_server_fields();

drop trigger if exists seller_kyc_force_fields on public.seller_kyc_submissions;
create trigger seller_kyc_force_fields
  before insert on public.seller_kyc_submissions
  for each row execute function public.force_server_fields();

/* Order state machine guards. */
create or replace function public.guard_order_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.buyer_id is distinct from old.buyer_id
     or new.seller_id is distinct from old.seller_id
     or new.subtotal_tzs is distinct from old.subtotal_tzs
     or new.total_due_tzs is distinct from old.total_due_tzs
     or new.quantity is distinct from old.quantity
     or new.unit_price_tzs is distinct from old.unit_price_tzs then
    raise exception 'Order amounts and parties are immutable after creation'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_order_changes() from public, anon, authenticated;

drop trigger if exists orders_guard_changes on public.orders;
create trigger orders_guard_changes
  before update on public.orders
  for each row execute function public.guard_order_changes();

/* Live sessions may only move forward through the lifecycle. */
create or replace function public.guard_live_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.seller_id is distinct from old.seller_id then
      raise exception 'Live session owner cannot be changed'
        using errcode = 'P0001';
    end if;
    if old.status = 'archived' and new.status <> 'archived' then
      raise exception 'An archived live session cannot be reopened'
        using errcode = 'P0001';
    end if;
    if old.status = 'ended' and new.status = 'live' then
      raise exception 'A live session cannot restart after it ended'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_live_session() from public, anon, authenticated;

drop trigger if exists live_sessions_guard on public.live_sessions;
create trigger live_sessions_guard
  before insert or update on public.live_sessions
  for each row execute function public.guard_live_session();

/* An order may only point at a live session that belongs to its seller. */
create or replace function public.check_order_live_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_seller uuid;
begin
  if new.live_session_id is null then
    return new;
  end if;
  select l.seller_id into v_session_seller
  from public.live_sessions l where l.id = new.live_session_id;
  if v_session_seller is null then
    raise exception 'Live session not found' using errcode = 'P0001';
  end if;
  if v_session_seller <> new.seller_id then
    raise exception 'Live session does not belong to this seller'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.check_order_live_session() from public, anon, authenticated;

drop trigger if exists orders_check_live_session on public.orders;
create trigger orders_check_live_session
  before insert on public.orders
  for each row execute function public.check_order_live_session();

/* Chat thread guards. */
create or replace function public.guard_chat_thread_initiator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.initiated_by is not null and new.initiated_by <> (select auth.uid())
       and (select auth.role()) <> 'service_role' then
      raise exception 'Only the signed-in user can start a chat thread'
        using errcode = 'P0001';
    end if;
  elsif new.initiated_by is distinct from old.initiated_by then
    raise exception 'The thread initiator cannot be changed'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_chat_thread_initiator() from public, anon, authenticated;

drop trigger if exists chat_threads_initiator_guard on public.chat_threads;
create trigger chat_threads_initiator_guard
  before insert or update on public.chat_threads
  for each row execute function public.guard_chat_thread_initiator();

create or replace function public.guard_chat_thread_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.buyer_id is distinct from old.buyer_id
     or new.seller_id is distinct from old.seller_id then
    raise exception 'Chat participants cannot be changed'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_chat_thread_update() from public, anon, authenticated;

drop trigger if exists chat_threads_guard_update on public.chat_threads;
create trigger chat_threads_guard_update
  before update on public.chat_threads
  for each row execute function public.guard_chat_thread_update();

/* Chat and dispute side effects. */
create or replace function public.on_chat_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.chat_threads
    set updated_at = now()
    where buyer_id = new.thread_buyer and seller_id = new.thread_seller;

  insert into public.activity_events (user_id, kind, payload)
  select new.thread_seller, 'message_received',
    jsonb_build_object('thread_buyer', new.thread_buyer)
  where new.thread_buyer <> new.thread_seller;
  return new;
end;
$$;
revoke all on function public.on_chat_message_insert() from public, anon, authenticated;

drop trigger if exists chat_messages_bump_thread on public.chat_messages;
create trigger chat_messages_bump_thread
  after insert on public.chat_messages
  for each row execute function public.on_chat_message_insert();

create or replace function public.on_dispute_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_buyer uuid;
  v_seller uuid;
begin
  update public.disputes d
    set replied_at = now()
    from public.orders o
    where d.id = new.dispute_id and o.id = d.order_id;

  select o.buyer_id, o.seller_id into v_buyer, v_seller
  from public.disputes d join public.orders o on o.id = d.order_id
  where d.id = new.dispute_id;

  if v_buyer is not null then
    insert into public.activity_events (user_id, kind, dispute_id, payload)
    values (v_buyer, 'dispute_reply', new.dispute_id, jsonb_build_object('body', left(new.body, 280)));
  end if;
  if v_seller is not null and v_seller <> v_buyer then
    insert into public.activity_events (user_id, kind, dispute_id, payload)
    values (v_seller, 'dispute_reply', new.dispute_id, jsonb_build_object('body', left(new.body, 280)));
  end if;
  return new;
end;
$$;
revoke all on function public.on_dispute_message_insert() from public, anon, authenticated;

drop trigger if exists dispute_messages_notify on public.dispute_messages;
create trigger dispute_messages_notify
  after insert on public.dispute_messages
  for each row execute function public.on_dispute_message_insert();

/* ========================================================================== *
 * 8. ROLES FOR THE RECONCILED TABLES
 * ========================================================================== */

alter table public.delivery_agents enable row level security;
alter table public.delivery_assignments enable row level security;
alter table public.order_delivery_workflows enable row level security;
alter table public.handoff_events enable row level security;
alter table public.pin_throttle enable row level security;
alter table public.support_request_audit enable row level security;

revoke all on public.delivery_agents, public.delivery_assignments,
  public.order_delivery_workflows, public.handoff_events,
  public.pin_throttle, public.support_request_audit from anon, authenticated;

grant select on public.delivery_agents, public.support_request_audit to authenticated;

drop policy if exists delivery_agents_select_own on public.delivery_agents;
create policy delivery_agents_select_own on public.delivery_agents
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists support_request_audit_select_own on public.support_request_audit;
create policy support_request_audit_select_own on public.support_request_audit
  for select to authenticated
  using (exists (
    select 1 from public.support_requests s
    where s.id = request_id and s.user_id = (select auth.uid())
  ));

drop policy if exists handoff_events_select_participant on public.handoff_events;
create policy handoff_events_select_participant on public.handoff_events
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id
      and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
  ));
