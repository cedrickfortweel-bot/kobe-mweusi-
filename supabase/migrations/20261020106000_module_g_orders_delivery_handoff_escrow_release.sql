/* Kobe Mweusi — Module G: orders, delivery hubs, pickup, handoff QR and the
   escrow release window.

   THE RELEASE RULE (this is the part that decides when money moves)
   ------------------------------------------------------------------
   An order's money sits in escrow until the release conditions are met.
   The server owns the clock; a phone's clock is never trusted.

   Qualifying events
     * BUYER_SCAN   the buyer scans the SELLER's handoff code. This is the
                   buyer's qualifying scan. It opens the three-hour window
                   and starts release_scheduled_for = scan_time + 3 hours.
     * SELLER_SCAN  the seller scans the BUYER's handoff code. On its own it
                   records the handover but does NOT move money.
     * AGENT_SCAN   an agent assigned to the order scans the relevant code
                   for the handover stage. It records the handover and does
                   NOT move money.
     * CONFIRM      the buyer explicitly confirms receipt. This releases
                   immediately.

   Release outcomes
     1. Buyer confirmed receipt          -> release now
     2. Buyer scan AND seller scan       -> release now (fast path)
     3. Buyer scan only, window elapsed  -> release now, no dispute, no hold
     4. Seller scan or agent scan only   -> no release, no window opens
     5. Open dispute or escrow hold      -> no release, ever

   A timer alone never releases money without re-checking the order state,
   the dispute state and the hold flag at the moment of release.

   Tables added here
     hubs                  physical pickup / warehouse hubs
     hub_operating_hours   hub schedules and holiday rules
     pickup_events         explicit pickup lifecycle events
     app_settings          safe application settings (escrow policy lives here)

   Functions added here
     validate_handoff_scan(), record_handoff_scan(), start_escrow_release_window(),
     evaluate_escrow_release(), process_due_escrow_releases(),
     release_escrow_funds(), confirm_receipt(), issue_handoff_codes()
*/

alter table public.orders
  add column if not exists delivered_at timestamptz;

alter table public.orders
  add column if not exists confirm_by timestamptz;

alter table public.orders
  add column if not exists hub_id uuid;

alter table public.order_delivery_workflows
  add column if not exists hub_id uuid;

alter table public.order_delivery_workflows
  add column if not exists buyer_confirmed_at timestamptz;

alter table public.order_delivery_workflows
  add column if not exists release_window_started_at timestamptz;

alter table public.order_delivery_workflows
  add column if not exists release_scheduled_for timestamptz;

alter table public.order_delivery_workflows
  add column if not exists fast_release_eligible boolean not null default false;

alter table public.order_delivery_workflows
  add column if not exists buyer_scanned_at timestamptz;

alter table public.order_delivery_workflows
  add column if not exists seller_scanned_at timestamptz;

alter table public.order_delivery_workflows
  add column if not exists agent_scanned_at timestamptz;

alter table public.order_delivery_workflows
  add column if not exists notes text;

create index if not exists order_delivery_workflows_due_idx
  on public.order_delivery_workflows (release_scheduled_for)
  where release_scheduled_for is not null;

create index if not exists order_delivery_workflows_agent_idx
  on public.order_delivery_workflows (agent_user_id, created_at desc);

/* ========================================================================== *
 * 1. SETTINGS (escrow policy)
 * ========================================================================== */

create table if not exists public.app_settings (
  key text primary key check (char_length(key) between 1 and 80),
  value jsonb not null default '{}'::jsonb check (jsonb_typeof(value) = 'object'),
  description text,
  is_secret boolean not null default false,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to authenticated;

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
  for select to authenticated using (is_secret = false);

drop trigger if exists app_settings_set_updated_at on public.app_settings;
create trigger app_settings_set_updated_at
  before update on public.app_settings
  for each row execute function public.set_updated_at();

insert into public.app_settings (key, value, description)
values ('escrow_policy', jsonb_build_object(
    'release_window_minutes', 180,
    'require_both_scans_for_fast_release', true,
    'buyer_confirmation_releases_immediately', true,
    'agent_scan_can_release', false,
    'dispute_blocks_release', true,
    'auto_release_enabled', true
  ), 'Escrow release policy. The three-hour window, the fast path and the blocking rules.')
on conflict (key) do nothing;

/* Read a policy value with a safe default. */
create or replace function public.escrow_policy(p_key text, p_default jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select s.value -> p_key from public.app_settings s where s.key = 'escrow_policy'),
    p_default
  );
$$;
grant execute on function public.escrow_policy(text, jsonb) to authenticated, service_role;

/* ========================================================================== *
 * 2. HUBS
 * ========================================================================== */

create table if not exists public.hubs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z]{3}-[0-9]{3}$'),
  name text not null check (char_length(name) between 2 and 120),
  region text,
  address text,
  city text,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hubs_active_idx on public.hubs (is_active, region);

alter table public.hubs enable row level security;
revoke all on public.hubs from anon, authenticated;
grant select on public.hubs to anon, authenticated;
grant insert, update, delete on public.hubs to authenticated;

drop policy if exists hubs_read_active on public.hubs;
create policy hubs_read_active on public.hubs
  for select to anon, authenticated using (is_active = true);

drop policy if exists hubs_write_staff on public.hubs;
create policy hubs_write_staff on public.hubs
  for all to authenticated
  using (public.is_internal_staff())
  with check (public.is_internal_staff());

drop trigger if exists hubs_set_updated_at on public.hubs;
create trigger hubs_set_updated_at
  before update on public.hubs
  for each row execute function public.set_updated_at();

create table if not exists public.hub_operating_hours (
  id uuid primary key default gen_random_uuid(),
  hub_id uuid not null references public.hubs (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  is_closed boolean not null default false,
  note text,
  unique (hub_id, weekday)
);

alter table public.hub_operating_hours enable row level security;
revoke all on public.hub_operating_hours from anon, authenticated;
grant select on public.hub_operating_hours to anon, authenticated;

drop policy if exists hub_operating_hours_read on public.hub_operating_hours;
create policy hub_operating_hours_read on public.hub_operating_hours
  for select to anon, authenticated using (true);

drop policy if exists hub_operating_hours_write_staff on public.hub_operating_hours;
create policy hub_operating_hours_write_staff on public.hub_operating_hours
  for all to authenticated
  using (public.is_internal_staff())
  with check (public.is_internal_staff());

/* ========================================================================== *
 * 3. PICKUP EVENTS
 * ========================================================================== */

create table if not exists public.pickup_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  hub_id uuid references public.hubs (id) on delete set null,
  event_type text not null
    check (event_type in ('arrived', 'ready_for_pickup', 'collected', 'overdue', 'returned')),
  actor_id uuid references public.profiles (id),
  notes text check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now()
);

create index if not exists pickup_events_order_idx on public.pickup_events (order_id, created_at desc);

alter table public.pickup_events enable row level security;
revoke all on public.pickup_events from anon, authenticated;
grant select on public.pickup_events to authenticated;

drop policy if exists pickup_events_select_participant on public.pickup_events;
create policy pickup_events_select_participant on public.pickup_events
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id
      and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
  ));

/* ========================================================================== *
 * 4. DELIVERY AGENT MANAGEMENT
 * ========================================================================== */

create or replace function public.set_agent_verification(
  p_agent_id uuid,
  p_verified boolean,
  p_reviewer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid := coalesce(p_reviewer_id, (select auth.uid()));
begin
  if v_reviewer is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_reviewer and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Reviewer is not authorized' using errcode = '42501';
  end if;

  insert into public.delivery_agents (user_id, verification_status, verified_at, verified_by)
  values (p_agent_id,
          case when p_verified then 'verified' else 'rejected' end,
          case when p_verified then now() else null end,
          v_reviewer)
  on conflict (user_id) do update
    set verification_status = excluded.verification_status,
        verified_at = excluded.verified_at,
        verified_by = excluded.verified_by,
        updated_at = now();

  return jsonb_build_object('ok', true, 'agent_id', p_agent_id, 'verified', p_verified);
end;
$$;
revoke all on function public.set_agent_verification(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.set_agent_verification(uuid, boolean, uuid) to service_role;

create or replace function public.assign_delivery_agent(
  p_order_id uuid,
  p_agent_id uuid,
  p_assigned_by uuid default null
)
returns public.delivery_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assignment public.delivery_assignments%rowtype;
  v_assigner uuid := coalesce(p_assigned_by, (select auth.uid()));
begin
  if v_assigner is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if not exists (
    select 1 from public.delivery_agents a
    where a.user_id = p_agent_id and a.verification_status = 'verified'
  ) then
    raise exception 'That agent is not verified' using errcode = 'P0001';
  end if;

  insert into public.delivery_assignments (order_id, agent_user_id, status, assigned_by)
  values (p_order_id, p_agent_id, 'assigned', v_assigner)
  returning * into v_assignment;

  insert into public.order_delivery_workflows
    (order_id, delivery_mode, stage, agent_user_id)
  values (p_order_id, 'agent', 'not_started', p_agent_id)
  on conflict (order_id) do update
    set delivery_mode = 'agent', agent_user_id = p_agent_id, updated_at = now();

  return v_assignment;
end;
$$;
revoke all on function public.assign_delivery_agent(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_delivery_agent(uuid, uuid, uuid) to service_role;

/* Is this user an agent assigned to this order? */
create or replace function public.is_assigned_agent(p_order_id uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.delivery_assignments da
    where da.order_id = p_order_id
      and da.agent_user_id = p_user
      and da.status in ('assigned', 'accepted')
  );
$$;
revoke all on function public.is_assigned_agent(uuid, uuid) from public, anon;
grant execute on function public.is_assigned_agent(uuid, uuid) to service_role;

/* ========================================================================== *
 * 5. HANDOFF QR: ISSUE, VALIDATE, RECORD
 * ========================================================================== */

/* Issue the two single-use codes for an order. The token itself is
   generated by the caller (Edge Function) and only its hash is stored, so
   a database leak cannot be replayed as a live code. */
create or replace function public.issue_handoff_codes(
  p_order_id uuid,
  p_seller_token_hash text,
  p_buyer_token_hash text,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_expiry timestamptz := coalesce(p_expires_at, now() + interval '24 hours');
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status not in ('in_escrow', 'delivered') then
    raise exception 'Handoff codes only exist while money is held in escrow'
      using errcode = 'P0001';
  end if;

  -- Replace any previous unused codes for this order.
  update public.handoff_codes
    set revoked_at = now()
    where order_id = p_order_id and used_at is null and revoked_at is null;

  insert into public.handoff_codes (order_id, code_type, issued_to, token_hash, expires_at)
  values
    (p_order_id, 'seller', v_order.seller_id, p_seller_token_hash, v_expiry),
    (p_order_id, 'buyer',  v_order.buyer_id,  p_buyer_token_hash,  v_expiry);

  return jsonb_build_object('ok', true, 'order_id', p_order_id, 'expires_at', v_expiry);
end;
$$;
revoke all on function public.issue_handoff_codes(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.issue_handoff_codes(uuid, text, text, timestamptz) to service_role;

/* Validate a scan WITHOUT consuming the code. Returns who may scan it. */
create or replace function public.validate_handoff_scan(
  p_token_hash text,
  p_scanner uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code public.handoff_codes%rowtype;
  v_order public.orders%rowtype;
  v_is_staff boolean;
  v_allowed boolean := false;
  v_reason text;
  v_role text;
begin
  select c.* into v_code from public.handoff_codes c where c.token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_code.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_used');
  end if;
  if v_code.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;
  if v_code.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  select o.* into v_order from public.orders o where o.id = v_code.order_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_missing');
  end if;
  if v_order.status not in ('in_escrow', 'delivered') then
    return jsonb_build_object('ok', false, 'reason', 'not_in_escrow');
  end if;

  select exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_scanner and r.role in ('admin', 'support_agent')
  ) into v_is_staff;

  -- The SELLER's code is scanned by the BUYER.
  -- The BUYER's code  is scanned by the SELLER.
  if v_code.code_type = 'seller' then
    if v_order.buyer_id = p_scanner then
      v_allowed := true; v_role := 'buyer';
    end if;
  else
    if v_order.seller_id = p_scanner then
      v_allowed := true; v_role := 'seller';
    end if;
  end if;

  if public.is_assigned_agent(v_order.id, p_scanner) then
    v_allowed := true; v_role := 'agent';
  end if;

  if v_is_staff then
    v_allowed := true; v_role := 'staff';
  end if;

  if not v_allowed then
    v_reason := 'not_authorised';
  end if;

  return jsonb_build_object(
    'ok', v_allowed,
    'reason', v_reason,
    'order_id', v_order.id,
    'code_type', v_code.code_type,
    'role', v_role,
    'expires_at', v_code.expires_at
  );
end;
$$;
revoke all on function public.validate_handoff_scan(text, uuid) from public, anon, authenticated;
grant execute on function public.validate_handoff_scan(text, uuid) to service_role;

/* Record an authorised scan. Consumes the code, writes the audit event,
   advances the delivery workflow and starts the release window when the
   buyer is the one who scanned. */
create or replace function public.record_handoff_scan(
  p_token_hash text,
  p_scanner uuid,
  p_stage text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code public.handoff_codes%rowtype;
  v_order public.orders%rowtype;
  v_workflow public.order_delivery_workflows%rowtype;
  v_role text;
  v_window_minutes integer;
  v_release_at timestamptz;
  v_event public.handoff_events%rowtype;
  v_counterparty uuid;
begin
  select c.* into v_code from public.handoff_codes c where c.token_hash = p_token_hash for update;
  if not found then
    raise exception 'This code is not valid' using errcode = 'P0001';
  end if;
  if v_code.used_at is not null then
    raise exception 'This code has already been used' using errcode = 'P0001';
  end if;
  if v_code.revoked_at is not null then
    raise exception 'This code is no longer valid' using errcode = 'P0001';
  end if;
  if v_code.expires_at <= now() then
    raise exception 'This code expired' using errcode = 'P0001';
  end if;

  select o.* into v_order from public.orders o where o.id = v_code.order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status not in ('in_escrow', 'delivered') then
    raise exception 'The money for this order is no longer held in escrow' using errcode = 'P0001';
  end if;

  -- Work out who is scanning. The code type determines the counterparty:
  -- the SELLER's code is scanned by the BUYER, the BUYER's code by the SELLER.
  if v_code.code_type = 'seller' and v_order.buyer_id = p_scanner then
    v_role := 'buyer';
  elsif v_code.code_type = 'buyer' and v_order.seller_id = p_scanner then
    v_role := 'seller';
  elsif public.is_assigned_agent(v_order.id, p_scanner) then
    v_role := 'agent';
  elsif exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_scanner and r.role in ('admin', 'support_agent')
  ) then
    v_role := 'staff';
  else
    raise exception 'You are not allowed to scan this code' using errcode = '42501';
  end if;

  -- Atomic one-time claim.
  update public.handoff_codes
    set used_at = now(), scanned_by = p_scanner
    where id = v_code.id and used_at is null;
  if not found then
    raise exception 'This code has already been used' using errcode = 'P0001';
  end if;

  insert into public.handoff_events (order_id, stage, scanned_by, qr_code_id, details)
  values (
    v_order.id,
    coalesce(p_stage,
      case when v_role = 'buyer' then 'direct_handoff'
           when v_role = 'seller' then 'direct_handoff'
           else 'agent_to_buyer' end),
    p_scanner, v_code.id,
    jsonb_build_object('role', v_role, 'code_type', v_code.code_type))
  returning * into v_event;

  insert into public.order_delivery_workflows
    (order_id, delivery_mode, stage, first_direct_code_type, first_scanned_by)
  values
    (v_order.id,
     case when v_role = 'agent' then 'agent' else 'direct' end,
     case when v_role = 'agent' then 'seller_to_agent_complete' else 'direct_pending' end,
     v_code.code_type, p_scanner)
  on conflict (order_id) do update
    set updated_at = now(),
        stage = case
          when excluded.stage = 'seller_to_agent_complete' then 'seller_to_agent_complete'
          else public.order_delivery_workflows.stage end,
        first_direct_code_type = coalesce(public.order_delivery_workflows.first_direct_code_type, excluded.first_direct_code_type),
        first_scanned_by = coalesce(public.order_delivery_workflows.first_scanned_by, excluded.first_scanned_by);

  -- Which side scanned?
  if v_role = 'buyer' then
    update public.order_delivery_workflows
      set buyer_scanned_at = now(), updated_at = now()
      where order_id = v_order.id;
  elsif v_role = 'seller' then
    update public.order_delivery_workflows
      set seller_scanned_at = now(), updated_at = now()
      where order_id = v_order.id;
  else
    update public.order_delivery_workflows
      set agent_scanned_at = now(), updated_at = now()
      where order_id = v_order.id;
  end if;

  update public.orders
    set delivered_at = coalesce(delivered_at, now()), updated_at = now()
    where id = v_order.id and status = 'in_escrow';

  -- The buyer's qualifying scan opens the three-hour window.
  if v_role = 'buyer' then
    v_window_minutes := coalesce(
      (public.escrow_policy('release_window_minutes', '180'::jsonb))::int, 180);
    v_release_at := now() + make_interval(mins => v_window_minutes);

    update public.order_delivery_workflows
      set release_window_started_at = coalesce(release_window_started_at, now()),
          release_scheduled_for = coalesce(release_scheduled_for, v_release_at),
          updated_at = now()
      where order_id = v_order.id;
  end if;

  select * into v_workflow from public.order_delivery_workflows w where w.order_id = v_order.id;

  v_counterparty := case when v_role = 'buyer' then v_order.seller_id
                         when v_role = 'seller' then v_order.buyer_id
                         else v_order.buyer_id end;

  insert into public.activity_events (user_id, kind, order_id, payload)
  values
    (v_counterparty, 'handoff_scanned', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'role', v_role, 'code_type', v_code.code_type)),
    (v_counterparty, 'handoff_verified', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'role', v_role));

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order.id,
    'order_ref', v_order.ref,
    'role', v_role,
    'code_type', v_code.code_type,
    'scanned_at', v_code.used_at,
    'release_scheduled_for', v_workflow.release_scheduled_for,
    'fast_release_eligible', v_workflow.fast_release_eligible
  );
end;
$$;
revoke all on function public.record_handoff_scan(text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_handoff_scan(text, uuid, text) to service_role;

/* Open the release window explicitly. */
create or replace function public.start_escrow_release_window(p_order_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_minutes integer;
  v_release_at timestamptz;
begin
  v_window_minutes := coalesce(
    (public.escrow_policy('release_window_minutes', '180'::jsonb))::int, 180);
  v_release_at := now() + make_interval(mins => v_window_minutes);

  insert into public.order_delivery_workflows
    (order_id, release_window_started_at, release_scheduled_for)
  values (p_order_id, now(), v_release_at)
  on conflict (order_id) do update
    set release_window_started_at = coalesce(public.order_delivery_workflows.release_window_started_at, now()),
        release_scheduled_for = coalesce(public.order_delivery_workflows.release_scheduled_for, v_release_at),
        updated_at = now();

  return v_release_at;
end;
$$;
revoke all on function public.start_escrow_release_window(uuid) from public, anon, authenticated;
grant execute on function public.start_escrow_release_window(uuid) to service_role;

/* ========================================================================== *
 * 6. RELEASE EVALUATION
 * ========================================================================== */

/* Decide whether an order may be released RIGHT NOW, and why. Pure
   evaluation: it never moves money. */
create or replace function public.evaluate_escrow_release(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_workflow public.order_delivery_workflows%rowtype;
  v_escrow public.escrow_transactions%rowtype;
  v_has_dispute boolean;
  v_window_minutes integer;
  v_require_both boolean;
  v_auto_enabled boolean;
  v_now timestamptz := now();
begin
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'order_not_found');
  end if;

  select e.* into v_escrow from public.escrow_transactions e where e.order_id = p_order_id;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'no_escrow');
  end if;
  if v_escrow.status = 'released' then
    return jsonb_build_object('eligible', false, 'reason', 'already_released');
  end if;
  if v_escrow.status in ('refunded', 'split', 'cancelled') then
    return jsonb_build_object('eligible', false, 'reason', 'escrow_closed');
  end if;
  if v_escrow.status = 'held' then
    return jsonb_build_object('eligible', false, 'reason', 'on_hold',
      'hold_reason', v_escrow.hold_reason);
  end if;
  if v_order.status not in ('in_escrow', 'delivered') then
    return jsonb_build_object('eligible', false, 'reason', 'order_status_' || v_order.status::text);
  end if;

  select exists (
    select 1 from public.disputes d where d.order_id = p_order_id and d.status <> 'resolved'
  ) into v_has_dispute;
  if v_has_dispute then
    return jsonb_build_object('eligible', false, 'reason', 'open_dispute');
  end if;

  select w.* into v_workflow from public.order_delivery_workflows w where w.order_id = p_order_id;
  if not found then
    v_workflow.order_id := p_order_id;
  end if;

  v_window_minutes := coalesce(
    (public.escrow_policy('release_window_minutes', '180'::jsonb))::int, 180);
  v_require_both := coalesce(
    (public.escrow_policy('require_both_scans_for_fast_release', 'true'::jsonb))::boolean, true);
  v_auto_enabled := coalesce(
    (public.escrow_policy('auto_release_enabled', 'true'::jsonb))::boolean, true);

  -- 1. The buyer explicitly confirmed receipt.
  if coalesce(public.escrow_policy('buyer_confirmation_releases_immediately', 'true'::jsonb))::boolean, true)
     and v_workflow.buyer_confirmed_at is not null then
    return jsonb_build_object('eligible', true, 'reason', 'buyer_confirmed',
      'path', 'explicit_confirmation', 'evaluated_at', v_now);
  end if;

  -- 2. Both scans present -> fast path.
  if v_workflow.buyer_scanned_at is not null and v_workflow.seller_scanned_at is not null then
    return jsonb_build_object('eligible', true, 'reason', 'both_scans',
      'path', 'fast_release', 'evaluated_at', v_now);
  end if;

  if v_require_both and v_workflow.seller_scanned_at is not null
     and v_workflow.buyer_scanned_at is null then
    return jsonb_build_object('eligible', false, 'reason', 'awaiting_buyer_scan',
      'seller_scanned_at', v_workflow.seller_scanned_at, 'evaluated_at', v_now);
  end if;

  -- 3. Buyer's scan only: wait for the three-hour window.
  if v_workflow.buyer_scanned_at is not null and v_workflow.release_scheduled_for is not null then
    if v_now >= v_workflow.release_scheduled_for then
      if not v_auto_enabled then
        return jsonb_build_object('eligible', false, 'reason', 'auto_release_disabled',
          'release_scheduled_for', v_workflow.release_scheduled_for, 'evaluated_at', v_now);
      end if;
      return jsonb_build_object('eligible', true, 'reason', 'window_elapsed',
        'path', 'timed_release',
        'release_scheduled_for', v_workflow.release_scheduled_for,
        'window_minutes', v_window_minutes,
        'evaluated_at', v_now);
    end if;
    return jsonb_build_object('eligible', false, 'reason', 'waiting_for_window',
      'release_scheduled_for', v_workflow.release_scheduled_for,
      'window_minutes', v_window_minutes,
      'seconds_remaining', greatest(0, ceil(extract(epoch from (v_workflow.release_scheduled_for - v_now)))::int),
      'evaluated_at', v_now);
  end if;

  -- 4. Seller or agent scan only.
  if v_workflow.seller_scanned_at is not null or v_workflow.agent_scanned_at is not null then
    return jsonb_build_object('eligible', false, 'reason', 'awaiting_buyer',
      'evaluated_at', v_now);
  end if;

  -- 5. Nothing has happened yet.
  return jsonb_build_object('eligible', false, 'reason', 'no_handoff_recorded',
    'evaluated_at', v_now);
end;
$$;
revoke all on function public.evaluate_escrow_release(uuid) from public, anon, authenticated;
grant execute on function public.evaluate_escrow_release(uuid) to service_role, authenticated;

/* Release the escrow if the evaluation says it is allowed. */
create or replace function public.release_escrow_funds(
  p_order_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision jsonb;
begin
  v_decision := public.evaluate_escrow_release(p_order_id);

  if not (v_decision ->> 'eligible')::boolean then
    return jsonb_build_object('ok', false, 'decision', v_decision);
  end if;

  return public.release_escrow(
    p_order_id,
    coalesce(p_reason, 'release:' || (v_decision ->> 'reason')));
end;
$$;
revoke all on function public.release_escrow_funds(uuid, text) from public, anon, authenticated;
grant execute on function public.release_escrow_funds(uuid, text) to service_role;

/* Scheduled job: release every order whose window has elapsed. */
create or replace function public.process_due_escrow_releases(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_released integer := 0;
  v_skipped integer := 0;
  v_errors integer := 0;
  v_details jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  for r in
    select w.order_id
    from public.order_delivery_workflows w
    join public.orders o on o.id = w.order_id
    where w.release_scheduled_for is not null
      and w.release_scheduled_for <= now()
      and o.status in ('in_escrow', 'delivered')
    order by w.release_scheduled_for
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  loop
    v_result := public.release_escrow_funds(r.order_id, 'three_hour_window_elapsed');

    if (v_result ->> 'ok')::boolean then
      v_released := v_released + 1;
    else
      v_skipped := v_skipped + 1;
      if v_result -> 'decision' ->> 'reason' = 'open_dispute' then
        v_errors := v_errors + 1;
      end if;
    end if;

    v_details := v_details || jsonb_build_array(jsonb_build_object(
      'order_id', r.order_id,
      'released', (v_result ->> 'ok')::boolean,
      'reason', coalesce(v_result -> 'decision' ->> 'reason', v_result ->> 'ok')
    ));
  end loop;

  return jsonb_build_object(
    'ok', true,
    'released', v_released,
    'skipped', v_skipped,
    'blocked', v_errors,
    'details', v_details,
    'ran_at', now());
end;
$$;
revoke all on function public.process_due_escrow_releases(integer) from public, anon, authenticated;
grant execute on function public.process_due_escrow_releases(integer) to service_role;

/* The buyer confirms receipt. This is the explicit fast path. */
create or replace function public.confirm_receipt(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_result jsonb;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.buyer_id <> (select auth.uid()) then
    raise exception 'Only the buyer can confirm receipt' using errcode = '42501';
  end if;
  if v_order.status not in ('in_escrow', 'delivered') then
    raise exception 'This order is not waiting for confirmation' using errcode = 'P0001';
  end if;

  insert into public.order_delivery_workflows (order_id, buyer_confirmed_at)
  values (p_order_id, now())
  on conflict (order_id) do update
    set buyer_confirmed_at = coalesce(public.order_delivery_workflows.buyer_confirmed_at, now()),
        stage = 'delivered_pending_confirmation',
        updated_at = now();

  update public.orders
    set delivered_at = coalesce(delivered_at, now()), updated_at = now()
    where id = p_order_id;

  v_result := public.release_escrow_funds(p_order_id, 'buyer_confirmed_receipt');

  if not (v_result ->> 'ok')::boolean then
    return jsonb_build_object(
      'ok', false, 'confirmed', true, 'decision', v_result -> 'decision');
  end if;

  return jsonb_build_object('ok', true, 'confirmed', true, 'release', v_result);
end;
$$;
revoke all on function public.confirm_receipt(uuid) from public, anon;
grant execute on function public.confirm_receipt(uuid) to authenticated;

/* The buyer's view of the release timer. */
create or replace function public.my_escrow_timers()
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'order_id', o.id,
    'ref', o.ref,
    'item_name', o.item_name,
    'amount_tzs', o.subtotal_tzs,
    'status', o.status,
    'buyer_confirmed_at', w.buyer_confirmed_at,
    'buyer_scanned_at', w.buyer_scanned_at,
    'seller_scanned_at', w.seller_scanned_at,
    'release_scheduled_for', w.release_scheduled_for,
    'seconds_remaining', case
      when w.release_scheduled_for is null then null
      else greatest(0, ceil(extract(epoch from (w.release_scheduled_for - now())))::int) end,
    'decision', public.evaluate_escrow_release(o.id)
  )
  from public.orders o
  left join public.order_delivery_workflows w on w.order_id = o.id
  where o.buyer_id = (select auth.uid())
    and o.status in ('in_escrow', 'delivered')
  order by o.created_at desc;
$$;
grant execute on function public.my_escrow_timers() to authenticated;
