/* Kobe Mweusi — a handoff code lives until it is scanned.

   A handoff code now has NO clock on it. It is valid from the moment it
   is issued until one of these happens:

     * it is scanned        the scan consumes it, atomically
     * it is replaced       a newer code was issued for the same order
     * the order closes     the escrow was released, cancelled or refunded

   A time limit was never the right instrument here. A buyer showing
   their code while an agent was delayed would have had the code expire
   mid-handover, and the scan would be refused, leaving the order stuck
   in escrow with nobody able to release it. The order's own state is a
   better clock than a timestamp.

   So expires_at becomes NULL, which means "no time limit". The column
   stays, because a code issued by an older build may still carry one,
   and that one is still honoured.

   THE MESSAGES MATTER
   -------------------
   Every way a scan can fail now says exactly what happened, because the
   person holding the phone is usually a customer who needs to know
   whether to try again or give up:

     not a real code        "This code does not belong to any order."
     already scanned        "This code was already scanned. The handover
                             is recorded and the payment has moved."
     replaced               "This code was replaced by a newer one. Use
                             the code on the screen."
     wrong person           "This is the seller's code. Only the buyer of
                             this order can scan it."
     handover already done  "This handover is already done. The payment
                             was released when the code was scanned."
*/

begin;

/* ========================================================================== *
 * 1. NO CLOCK
 * ========================================================================== */

alter table public.handoff_codes
  alter column expires_at drop not null;

comment on column public.handoff_codes.expires_at is
  'NULL means the code has no time limit: it is valid until it is scanned, replaced, or the order closes.';

/* Issuing a code no longer sets an expiry. */
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
  v_expiry timestamptz := p_expires_at;
begin
  select o.* into v_order
  from public.orders o
  where o.id = p_order_id for update;

  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status not in ('in_escrow', 'delivered') then
    raise exception 'This order is closed, so there is no handover left to record.' using errcode = 'P0001';
  end if;

  -- Replace any previous unused codes for this order. They are revoked
  -- rather than deleted, so the audit trail survives.
  update public.handoff_codes
  set revoked_at = now()
  where order_id = p_order_id and used_at is null and revoked_at is null;

  insert into public.handoff_codes (order_id, code_type, issued_to, token_hash, expires_at)
  values
    (p_order_id, 'seller', v_order.seller_id, p_seller_token_hash, v_expiry),
    (p_order_id, 'buyer',  v_order.buyer_id,  p_buyer_token_hash,  v_expiry);

  return jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'expires_at', v_expiry,
    'lifetime', 'until it is scanned, replaced, or the order closes');
end;
$$;
revoke all on function public.issue_handoff_codes(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.issue_handoff_codes(uuid, text, text, timestamptz) to service_role;

/* ========================================================================== *
 * 2. THE SCAN, WITH MESSAGES THAT SAY WHAT HAPPENED
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
  select c.* into v_code
  from public.handoff_codes c
  where c.token_hash = p_token_hash for update;

  if not found then
    raise exception 'This code does not belong to any order.' using errcode = 'P0001';
  end if;

  -- Already scanned. Say so plainly, because the person holding the
  -- phone needs to know the handover is recorded, not that they made a
  -- mistake.
  if v_code.used_at is not null then
    raise exception 'This code was already scanned. The handover is recorded and the payment has moved.'
      using errcode = 'P0001';
  end if;

  if v_code.revoked_at is not null then
    raise exception 'This code was replaced by a newer one. Use the code on the screen.'
      using errcode = 'P0001';
  end if;

  -- A code issued by an older build may still carry a clock.
  if v_code.expires_at is not null and v_code.expires_at <= now() then
    raise exception 'This code is no longer valid. Ask for a fresh one.'
      using errcode = 'P0001';
  end if;

  select o.* into v_order
  from public.orders o
  where o.id = v_code.order_id for update;

  if not found then
    raise exception 'This order no longer exists.' using errcode = 'P0002';
  end if;

  -- The order's own state is the clock. A completed order means the
  -- handover is already recorded.
  if v_order.status = 'completed' then
    raise exception 'This handover is already done. The payment was released when the code was scanned.'
      using errcode = 'P0001';
  end if;
  if v_order.status in ('cancelled', 'refunded', 'split') then
    raise exception 'This order is closed, so there is no handover left to record.'
      using errcode = 'P0001';
  end if;
  if v_order.status not in ('in_escrow', 'delivered') then
    raise exception 'The money for this order is no longer held in escrow.' using errcode = 'P0001';
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
    -- Say which side the code belongs to, so the person knows whether
    -- they are the wrong person or on the wrong screen.
    if v_code.code_type = 'seller' then
      raise exception 'This is the seller''s code. Only the buyer of this order can scan it.'
        using errcode = '42501';
    else
      raise exception 'This is the buyer''s code. Only the seller of this order, or an assigned Kobe Mweusi agent, can scan it.'
        using errcode = '42501';
    end if;
  end if;

  -- Atomic one-time claim.
  update public.handoff_codes
  set used_at = now(), scanned_by = p_scanner
  where id = v_code.id and used_at is null;
  if not found then
    raise exception 'This code was already scanned. The handover is recorded and the payment has moved.'
      using errcode = 'P0001';
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

  -- Which CODE was scanned, not just who scanned it. The buyer's code
  -- being scanned is the fast release path; the seller's code being
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

  select * into v_workflow
  from public.order_delivery_workflows w where w.order_id = v_order.id;

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

/* The pre-check says the same things, so the app can warn before the
   camera even opens. */
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
    return jsonb_build_object('ok', false, 'reason', 'not_valid',
      'message', 'This code does not belong to any order.');
  end if;

  if v_code.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_scanned',
      'message', 'This code was already scanned. The handover is recorded and the payment has moved.');
  end if;
  if v_code.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'replaced',
      'message', 'This code was replaced by a newer one. Use the code on the screen.');
  end if;
  if v_code.expires_at is not null and v_code.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired',
      'message', 'This code is no longer valid. Ask for a fresh one.');
  end if;

  select o.* into v_order from public.orders o where o.id = v_code.order_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_valid',
      'message', 'This order no longer exists.');
  end if;

  if v_order.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'already_done',
      'message', 'This handover is already done. The payment was released when the code was scanned.');
  end if;
  if v_order.status in ('cancelled', 'refunded', 'split') then
    return jsonb_build_object('ok', false, 'reason', 'order_closed',
      'message', 'This order is closed, so there is no handover left to record.');
  end if;
  if v_order.status not in ('in_escrow', 'delivered') then
    return jsonb_build_object('ok', false, 'reason', 'not_in_escrow',
      'message', 'The money for this order is no longer held in escrow.');
  end if;

  select exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_scanner and r.role in ('admin', 'support_agent')
  ) into v_is_staff;

  if v_code.code_type = 'seller' and v_order.buyer_id = p_scanner then
    v_allowed := true; v_role := 'buyer';
  elsif v_code.code_type = 'buyer' and v_order.seller_id = p_scanner then
    v_allowed := true; v_role := 'seller';
  elsif public.is_assigned_agent(v_order.id, p_scanner) then
    v_allowed := true; v_role := 'agent';
  elsif v_is_staff then
    v_allowed := true; v_role := 'staff';
  end if;

  if not v_allowed then
    v_reason := 'wrong_person';
  end if;

  return jsonb_build_object(
    'ok', v_allowed,
    'reason', v_reason,
    'message', case when v_allowed then ''
      when v_code.code_type = 'seller'
        then 'This is the seller''s code. Only the buyer of this order can scan it.'
      else 'This is the buyer''s code. Only the seller of this order, or an assigned Kobe Mweusi agent, can scan it.' end,
    'order_id', v_order.id,
    'code_type', v_code.code_type,
    'role', v_role,
    'expires_at', v_code.expires_at
  );
end;
$$;
revoke all on function public.validate_handoff_scan(text, uuid) from public, anon, authenticated;
grant execute on function public.validate_handoff_scan(text, uuid) to service_role;

commit;
