/* Kobe Mweusi — the buyer's QR code is the fast release path.

   THE RULE
   --------
   There are two codes on an order.

     The SELLER's code   the buyer scans it. It shows the buyer has
                         engaged. It opens the three-hour window and
                         starts the release countdown.

     The BUYER's code    the seller, or an agent assigned to the order,
                         scans it. It shows the goods were handed over.
                         This releases the escrow IMMEDIATELY.

   So:

     buyer scans the seller's QR   ->  wait 3 hours, then release
     seller scans the buyer's QR   ->  release now
     agent  scans the buyer's QR   ->  release now

   The fast path is the BUYER'S CODE being scanned, whoever scans it.
   That is the physical proof of delivery: the buyer handed over their
   code with the parcel, in person or at the hub.

   WHY THIS CHANGES
   -----------------
   The earlier rule was "both scans present". That needed the buyer to
   scan the seller's code as well, which is a phone the seller has to
   scan. If the seller is not present to scan their own code, the
   handover still happened, and the money sat in escrow for three hours
   for no reason. Scanning the buyer's code is the stronger signal, and
   it is the one that is physically tied to the parcel.

   The three-hour window is still the fallback for the case where nobody
   scanned the buyer's code, for example when the parcel is delivered
   without a handover scan at all.

   This migration adds the two code-type timestamps, records them on
   every scan, releases immediately when the buyer's code is scanned, and
   rewrites the release decision around the new rule.
*/

begin;

/* ========================================================================== *
 * 1. TRACK WHICH CODE WAS SCANNED
 * ========================================================================== */

alter table public.order_delivery_workflows
  add column if not exists buyer_code_scanned_at timestamptz;

alter table public.order_delivery_workflows
  add column if not exists seller_code_scanned_at timestamptz;

alter table public.order_delivery_workflows
  add column if not exists buyer_code_scanned_by uuid references public.profiles (id);

alter table public.order_delivery_workflows
  add column if not exists buyer_code_scanned_role text;

comment on column public.order_delivery_workflows.buyer_code_scanned_at is
  'When the BUYER''s handoff code was scanned. Scanning it releases the escrow immediately.';

comment on column public.order_delivery_workflows.seller_code_scanned_at is
  'When the SELLER''s handoff code was scanned by the buyer. This opens the three-hour release window.';

/* ========================================================================== *
 * 2. THE POLICY
 * ========================================================================== */

insert into public.app_settings (key, value, description)
values ('escrow_policy', jsonb_build_object(
    'release_window_minutes', 180,
    'buyer_qr_scan_releases_immediately', true,
    'buyer_confirmation_releases_immediately', true,
    'agent_scan_can_release', true,
    'dispute_blocks_release', true,
    'auto_release_enabled', true
  ), 'Escrow release policy. The three-hour window, the fast path and the blocking rules.')
on conflict (key) do update
set value = excluded.value,
    description = excluded.description,
    updated_at = now();

/* ========================================================================== *
 * 3. RECORDING A SCAN
 * ========================================================================== */

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
  v_released jsonb;
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
  -- the SELLER's code is scanned by the BUYER, the BUYER's code by the
  -- SELLER. An assigned agent or staff may scan either.
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
      case when v_role = 'agent' then 'agent_to_buyer' else 'direct_handoff' end),
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

  -- Record which CODE was scanned, not just who scanned it. The buyer's
  -- code being scanned is the fast release path; the seller's code being
  -- scanned is the buyer's qualifying scan that opens the window.
  if v_code.code_type = 'buyer' then
    update public.order_delivery_workflows
      set buyer_code_scanned_at = now(),
          buyer_code_scanned_by = p_scanner,
          buyer_code_scanned_role = v_role,
          updated_at = now()
      where order_id = v_order.id;
  else
    update public.order_delivery_workflows
      set seller_code_scanned_at = coalesce(seller_code_scanned_at, now()),
          updated_at = now()
      where order_id = v_order.id;
  end if;

  -- Who scanned, for the timeline.
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
  if v_code.code_type = 'seller' then
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

  v_counterparty := case when v_code.code_type = 'buyer' then v_order.buyer_id
                         else v_order.seller_id end;

  insert into public.activity_events (user_id, kind, order_id, payload)
  values
    (v_counterparty, 'handoff_scanned', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'role', v_role, 'code_type', v_code.code_type)),
    (v_counterparty, 'handoff_verified', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'role', v_role));

  -- The buyer's code was scanned: release now.
  v_released := null;
  if v_code.code_type = 'buyer'
     and coalesce((public.escrow_policy('buyer_qr_scan_releases_immediately', 'true'::jsonb))::boolean, true) then
    v_released := public.release_escrow_funds(
      v_order.id,
      'buyer_qr_scanned by ' || v_role);
  end if;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order.id,
    'order_ref', v_order.ref,
    'role', v_role,
    'code_type', v_code.code_type,
    'scanned_at', v_code.used_at,
    'release_scheduled_for', v_workflow.release_scheduled_for,
    'released', coalesce((v_released ->> 'ok')::boolean, false),
    'release', v_released);
end;
$$;
revoke all on function public.record_handoff_scan(text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_handoff_scan(text, uuid, text) to service_role;

/* ========================================================================== *
 * 4. THE RELEASE DECISION
 * ========================================================================== */

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
  v_fast_release boolean;
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
  v_fast_release := coalesce(
    (public.escrow_policy('buyer_qr_scan_releases_immediately', 'true'::jsonb))::boolean, true);
  v_auto_enabled := coalesce(
    (public.escrow_policy('auto_release_enabled', 'true'::jsonb))::boolean, true);

  -- 1. The buyer explicitly confirmed receipt.
  if coalesce(public.escrow_policy('buyer_confirmation_releases_immediately', 'true'::jsonb)::boolean, true)
     and v_workflow.buyer_confirmed_at is not null then
    return jsonb_build_object('eligible', true, 'reason', 'buyer_confirmed',
      'path', 'explicit_confirmation', 'evaluated_at', v_now);
  end if;

  -- 2. The BUYER's code was scanned by the seller or an agent. This is
  --    the fast path: the goods were handed over, so release now.
  if v_fast_release and v_workflow.buyer_code_scanned_at is not null then
    return jsonb_build_object('eligible', true, 'reason', 'buyer_qr_scanned',
      'path', 'fast_release',
      'scanned_at', v_workflow.buyer_code_scanned_at,
      'scanned_by_role', v_workflow.buyer_code_scanned_role,
      'evaluated_at', v_now);
  end if;

  -- 3. The buyer scanned the seller's code: the three-hour window.
  if v_workflow.seller_code_scanned_at is not null
     and v_workflow.release_scheduled_for is not null then
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

  -- 4. Nothing has been recorded yet.
  return jsonb_build_object('eligible', false, 'reason', 'no_handoff_recorded',
    'evaluated_at', v_now);
end;
$$;
revoke all on function public.evaluate_escrow_release(uuid) from public, anon, authenticated;
grant execute on function public.evaluate_escrow_release(uuid) to service_role, authenticated;

/* The buyer's timer view reports the same facts. */
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
    'buyer_code_scanned_at', w.buyer_code_scanned_at,
    'seller_code_scanned_at', w.seller_code_scanned_at,
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

commit;
