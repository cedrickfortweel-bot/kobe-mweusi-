/* Kobe Mweusi — Module H: disputes and resolution.

   A dispute has its own lifecycle, private evidence, an authorised staff
   decision and an auditable financial outcome. A decision and the money
   movement it causes are two separate, traceable steps.

   Rules
     * A buyer or seller sees only disputes involving their own transaction.
     * Evidence is private by default.
     * Only a reviewer with the dispute-review permission may decide.
     * A frontend update of disputes.status never moves money by itself.
     * Every decision records who, when, why, and which financial action
       followed.

   Tables added here
     dispute_decisions   the decision, the reason, the reviewer, the outcome
     dispute_timeline    human-readable sequence of dispute events

   Functions added here
     open_dispute(), submit_dispute_evidence(), send_dispute_message(),
     assign_dispute_reviewer(), request_more_dispute_evidence(),
     resolve_dispute(), execute_dispute_financial_outcome(), reopen_dispute(),
     my_disputes()
*/

alter table public.disputes
  add column if not exists assigned_reviewer_id uuid references public.profiles (id);

alter table public.disputes
  add column if not exists requires_evidence boolean not null default false;

alter table public.disputes
  add column if not exists escalated_at timestamptz;

alter table public.disputes
  add column if not exists reopened_count integer not null default 0;

alter table public.disputes
  add column if not exists closed_at timestamptz;

create index if not exists disputes_reviewer_idx
  on public.disputes (assigned_reviewer_id, status)
  where assigned_reviewer_id is not null;

create index if not exists disputes_participant_idx
  on public.disputes (order_id, status);

/* ========================================================================== *
 * 1. DECISIONS AND TIMELINE
 * ========================================================================== */

create table if not exists public.dispute_decisions (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes (id) on delete cascade,
  reviewer_id uuid not null references public.profiles (id),
  decision text not null check (decision in ('buyer_refund', 'seller_release', 'split')),
  reason text not null check (char_length(reason) between 5 and 2000),
  buyer_amount_tzs bigint not null default 0 check (buyer_amount_tzs >= 0),
  seller_amount_tzs bigint not null default 0 check (seller_amount_tzs >= 0),
  financial_action text check (financial_action is null or financial_action in
    ('refund_issued', 'escrow_released', 'split_applied', 'none')),
  financial_reference text,
  created_at timestamptz not null default now()
);

create index if not exists dispute_decisions_dispute_idx
  on public.dispute_decisions (dispute_id, created_at desc);

alter table public.dispute_decisions enable row level security;
revoke all on public.dispute_decisions from anon, authenticated;
grant select on public.dispute_decisions to authenticated;

drop policy if exists dispute_decisions_select_participant on public.dispute_decisions;
create policy dispute_decisions_select_participant on public.dispute_decisions
  for select to authenticated
  using (exists (
    select 1 from public.disputes d join public.orders o on o.id = d.order_id
    where d.id = dispute_id
      and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
  ));

create table if not exists public.dispute_timeline (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes (id) on delete cascade,
  actor_id uuid references public.profiles (id),
  event text not null check (char_length(event) between 1 and 80),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists dispute_timeline_dispute_idx
  on public.dispute_timeline (dispute_id, created_at);

alter table public.dispute_timeline enable row level security;
revoke all on public.dispute_timeline from anon, authenticated;
grant select on public.dispute_timeline to authenticated;

drop policy if exists dispute_timeline_select_participant on public.dispute_timeline;
create policy dispute_timeline_select_participant on public.dispute_timeline
  for select to authenticated
  using (exists (
    select 1 from public.disputes d join public.orders o on o.id = d.order_id
    where d.id = dispute_id
      and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
  ));

/* Append to the timeline. */
create or replace function public.log_dispute_timeline(
  p_dispute_id uuid,
  p_event text,
  p_detail jsonb default '{}'::jsonb,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.dispute_timeline (dispute_id, actor_id, event, detail)
  values (p_dispute_id, coalesce(p_actor_id, (select auth.uid())), p_event, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.log_dispute_timeline(uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.log_dispute_timeline(uuid, text, jsonb, uuid) to service_role;

/* ========================================================================== *
 * 2. OPENING A DISPUTE
 * ========================================================================== */

/* Open a dispute on an order. The order is frozen immediately: escrow can
   no longer be released while the dispute is open. */
create or replace function public.open_dispute(
  p_order_id uuid,
  p_reason text,
  p_description text,
  p_opened_by uuid default null
)
returns public.disputes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_opener uuid := coalesce(p_opened_by, (select auth.uid()));
  v_order public.orders%rowtype;
  v_dispute public.disputes%rowtype;
  v_ref text;
  v_attempt integer := 0;
begin
  if v_opener is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if v_order.buyer_id <> v_opener and v_order.seller_id <> v_opener then
    if not exists (select 1 from public.internal_user_roles r
                   where r.user_id = v_opener and r.role in ('admin', 'support_agent')) then
      raise exception 'Only the buyer or the seller of this order can open a dispute'
        using errcode = '42501';
    end if;
  end if;

  if v_order.status not in ('in_escrow', 'delivered', 'disputed') then
    raise exception 'A dispute can only be opened while the money is held'
      using errcode = 'P0001';
  end if;

  select d.* into v_dispute from public.disputes d where d.order_id = p_order_id;
  if found and v_dispute.status <> 'resolved' then
    raise exception 'There is already an open dispute on this order' using errcode = 'P0001';
  end if;

  -- A public reference, unique across disputes.
  loop
    v_ref := 'DSP-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    v_attempt := v_attempt + 1;
    exit when not exists (select 1 from public.disputes d where d.ref = v_ref);
    if v_attempt > 20 then
      raise exception 'Could not allocate a dispute reference' using errcode = 'P0001';
    end if;
  end loop;

  if v_dispute.id is null then
    insert into public.disputes
      (order_id, opened_by, reason, description, status, ref, seller_deadline)
    values
      (p_order_id, v_opener, btrim(p_reason), btrim(p_description), 'open', v_ref,
       now() + interval '48 hours')
    returning * into v_dispute;
  else
    update public.disputes
      set opened_by = v_opener, reason = btrim(p_reason), description = btrim(p_description),
          status = 'open', outcome = null, resolved_at = null, closed_at = null,
          ref = v_ref, seller_deadline = now() + interval '48 hours',
          reopened_count = reopened_count + 1
      where id = v_dispute.id
      returning * into v_dispute;
  end if;

  update public.orders
    set status = 'disputed', updated_at = now()
    where id = p_order_id and status in ('in_escrow', 'delivered');

  -- Freeze the escrow so no timer can pay the seller while this is open.
  perform public.place_escrow_hold(p_order_id, 'dispute opened: ' || v_dispute.ref);

  perform public.log_dispute_timeline(v_dispute.id, 'dispute_opened',
    jsonb_build_object('reason', v_dispute.reason, 'ref', v_dispute.ref), v_opener);

  insert into public.activity_events (user_id, kind, dispute_id, payload)
  select u.id, 'dispute_opened', v_dispute.id,
    jsonb_build_object('ref', v_dispute.ref, 'order_ref', v_order.ref)
  from (select v_order.buyer_id as id union all select v_order.seller_id) u;

  return v_dispute;
end;
$$;
revoke all on function public.open_dispute(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.open_dispute(uuid, text, text, uuid) to service_role, authenticated;

/* ========================================================================== *
 * 3. EVIDENCE AND MESSAGES
 * ========================================================================== */

/* Submit evidence. The file lives in a private bucket; only the path is
   recorded here. */
create or replace function public.submit_dispute_evidence(
  p_dispute_id uuid,
  p_storage_path text,
  p_sender_id uuid default null
)
returns public.dispute_evidence
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender uuid := coalesce(p_sender_id, (select auth.uid()));
  v_dispute public.disputes%rowtype;
  v_evidence public.dispute_evidence%rowtype;
begin
  select d.* into v_dispute from public.disputes d where d.id = p_dispute_id;
  if not found then
    raise exception 'Dispute not found' using errcode = 'P0002';
  end if;
  if v_dispute.status = 'resolved' then
    raise exception 'This dispute is closed' using errcode = 'P0001';
  end if;
  if p_storage_path is null or btrim(p_storage_path) = '' then
    raise exception 'An evidence path is required' using errcode = 'P0001';
  end if;

  insert into public.dispute_evidence (dispute_id, sender_id, storage_path)
  values (p_dispute_id, v_sender, btrim(p_storage_path))
  returning * into v_evidence;

  perform public.log_dispute_timeline(v_dispute.id, 'evidence_submitted',
    jsonb_build_object('evidence_id', v_evidence.id), v_sender);

  return v_evidence;
end;
$$;
revoke all on function public.submit_dispute_evidence(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.submit_dispute_evidence(uuid, text, uuid) to service_role, authenticated;

/* Post a message inside a dispute. */
create or replace function public.send_dispute_message(
  p_dispute_id uuid,
  p_body text,
  p_sender_id uuid default null
)
returns public.dispute_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender uuid := coalesce(p_sender_id, (select auth.uid()));
  v_dispute public.disputes%rowtype;
  v_message public.dispute_messages%rowtype;
begin
  if v_sender is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) < 1 then
    raise exception 'A message cannot be empty' using errcode = 'P0001';
  end if;

  select d.* into v_dispute from public.disputes d where d.id = p_dispute_id;
  if not found then
    raise exception 'Dispute not found' using errcode = 'P0002';
  end if;
  if v_dispute.status = 'resolved' then
    raise exception 'This dispute is closed' using errcode = 'P0001';
  end if;

  insert into public.dispute_messages (dispute_id, sender_id, body)
  values (p_dispute_id, v_sender, btrim(p_body))
  returning * into v_message;

  perform public.log_dispute_timeline(v_dispute.id, 'message_posted',
    jsonb_build_object('message_id', v_message.id), v_sender);

  return v_message;
end;
$$;
revoke all on function public.send_dispute_message(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.send_dispute_message(uuid, text, uuid) to service_role, authenticated;

/* ========================================================================== *
 * 4. REVIEW WORKFLOW
 * ========================================================================== */

/* Assign a reviewer. */
create or replace function public.assign_dispute_reviewer(
  p_dispute_id uuid,
  p_reviewer_id uuid,
  p_assigned_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assigner uuid := coalesce(p_assigned_by, (select auth.uid()));
begin
  if v_assigner is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_assigner and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Only staff may assign a reviewer' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_reviewer_id and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'The reviewer is not a staff member' using errcode = 'P0001';
  end if;

  update public.disputes
    set assigned_reviewer_id = p_reviewer_id,
        status = case when status = 'open' then 'under_review'::public.dispute_status else status end
    where id = p_dispute_id and status <> 'resolved';

  if not found then
    raise exception 'Dispute is not available for assignment' using errcode = 'P0001';
  end if;

  perform public.log_dispute_timeline(p_dispute_id, 'reviewer_assigned',
    jsonb_build_object('reviewer_id', p_reviewer_id), v_assigner);

  return jsonb_build_object('ok', true, 'reviewer_id', p_reviewer_id);
end;
$$;
revoke all on function public.assign_dispute_reviewer(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_dispute_reviewer(uuid, uuid, uuid) to service_role;

/* Ask a party for more evidence. */
create or replace function public.request_more_dispute_evidence(
  p_dispute_id uuid,
  p_note text,
  p_requested_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requester uuid := coalesce(p_requested_by, (select auth.uid()));
begin
  if v_requester is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_requester and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Only staff may request more evidence' using errcode = '42501';
  end if;

  update public.disputes
    set requires_evidence = true, status = 'under_review'::public.dispute_status
    where id = p_dispute_id and status <> 'resolved';

  if not found then
    raise exception 'Dispute is not available' using errcode = 'P0001';
  end if;

  perform public.log_dispute_timeline(p_dispute_id, 'more_evidence_requested',
    jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')), v_requester);

  insert into public.activity_events (user_id, kind, dispute_id, payload)
  select u.id, 'dispute_reply', p_dispute_id,
    jsonb_build_object('title', 'More evidence requested',
      'note', nullif(btrim(coalesce(p_note, '')), ''))
  from (
    select o.buyer_id as id from public.disputes d join public.orders o on o.id = d.order_id
    where d.id = p_dispute_id
    union
    select o.seller_id from public.disputes d join public.orders o on o.id = d.order_id
    where d.id = p_dispute_id
  ) u;

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.request_more_dispute_evidence(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.request_more_dispute_evidence(uuid, text, uuid) to service_role;

/* Record the decision. This does NOT move money: the decision and the
   financial action are separate, traceable steps. */
create or replace function public.resolve_dispute(
  p_dispute_id uuid,
  p_decision text,
  p_reason text,
  p_buyer_amount_tzs bigint default 0,
  p_seller_amount_tzs bigint default 0,
  p_reviewer_id uuid default null
)
returns public.dispute_decisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid := coalesce(p_reviewer_id, (select auth.uid()));
  v_dispute public.disputes%rowtype;
  v_decision_row public.dispute_decisions%rowtype;
begin
  if v_reviewer is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_decision not in ('buyer_refund', 'seller_release', 'split') then
    raise exception 'Decision must be buyer_refund, seller_release or split'
      using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason is required' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_reviewer and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Reviewer is not authorized' using errcode = '42501';
  end if;

  select d.* into v_dispute from public.disputes d where d.id = p_dispute_id for update;
  if not found then
    raise exception 'Dispute not found' using errcode = 'P0002';
  end if;
  if v_dispute.status = 'resolved' then
    raise exception 'This dispute is already resolved' using errcode = 'P0001';
  end if;

  insert into public.dispute_decisions
    (dispute_id, reviewer_id, decision, reason, buyer_amount_tzs, seller_amount_tzs)
  values
    (p_dispute_id, v_reviewer, p_decision, btrim(p_reason),
     coalesce(p_buyer_amount_tzs, 0), coalesce(p_seller_amount_tzs, 0))
  returning * into v_decision_row;

  update public.disputes
    set status = 'resolved', outcome = p_decision::public.dispute_outcome,
        resolved_at = now(), closed_at = now(), requires_evidence = false
    where id = p_dispute_id;

  perform public.log_dispute_timeline(p_dispute_id, 'decision_recorded',
    jsonb_build_object('decision', p_decision, 'reviewer_id', v_reviewer,
      'buyer_amount', coalesce(p_buyer_amount_tzs, 0),
      'seller_amount', coalesce(p_seller_amount_tzs, 0)), v_reviewer);

  return v_decision_row;
end;
$$;
revoke all on function public.resolve_dispute(uuid, text, text, bigint, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_dispute(uuid, text, text, bigint, bigint, uuid) to service_role;

/* Carry out the financial outcome of a recorded decision. */
create or replace function public.execute_dispute_financial_outcome(
  p_dispute_id uuid,
  p_executor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_executor uuid := coalesce(p_executor_id, (select auth.uid()));
  v_dispute public.disputes%rowtype;
  v_decision public.dispute_decisions%rowtype;
  v_escrow public.escrow_transactions%rowtype;
  v_order public.orders%rowtype;
  v_refund public.refunds%rowtype;
  v_result jsonb;
begin
  if v_executor is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_executor and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Executor is not authorized' using errcode = '42501';
  end if;

  select d.* into v_dispute from public.disputes d where d.id = p_dispute_id for update;
  if not found then
    raise exception 'Dispute not found' using errcode = 'P0002';
  end if;
  if v_dispute.status <> 'resolved' or v_dispute.outcome is null then
    raise exception 'Record a decision before executing the financial outcome'
      using errcode = 'P0001';
  end if;

  select dec.* into v_decision
  from public.dispute_decisions dec
  where dec.dispute_id = p_dispute_id
  order by dec.created_at desc limit 1;

  if not found then
    raise exception 'No decision was recorded for this dispute' using errcode = 'P0002';
  end if;
  if v_decision.financial_action is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'action', v_decision.financial_action);
  end if;

  select o.* into v_order from public.orders o where o.id = v_dispute.order_id for update;
  select e.* into v_escrow from public.escrow_transactions e where e.order_id = v_order.id for update;

  if v_escrow.id is null then
    raise exception 'No escrow transaction for this order' using errcode = 'P0002';
  end if;

  if v_decision.decision = 'buyer_refund' then
    v_refund := public.request_refund(
      v_order.id, v_decision.buyer_amount_tzs,
      'dispute ' || v_dispute.ref || ': ' || v_decision.reason,
      v_executor, 'dispute-refund:' || v_dispute.id::text);

    v_result := public.approve_refund(v_refund.id, v_executor);

    update public.dispute_decisions
      set financial_action = 'refund_issued',
          financial_reference = v_refund.id::text
      where id = v_decision.id;

  elsif v_decision.decision = 'seller_release' then
    -- Lift the hold, then release through the normal escrow path.
    update public.escrow_transactions
      set status = 'funded', hold_reason = null, updated_at = now()
      where id = v_escrow.id and status = 'held';

    v_result := public.release_escrow(v_order.id, 'dispute ' || v_dispute.ref || ': ' || v_decision.reason);

    update public.dispute_decisions
      set financial_action = 'escrow_released',
          financial_reference = v_order.id::text
      where id = v_decision.id;

  else
    -- Split: the buyer gets their part back, the seller keeps the rest.
    if v_decision.buyer_amount_tzs > 0 then
      v_refund := public.request_refund(
        v_order.id, v_decision.buyer_amount_tzs,
        'dispute split ' || v_dispute.ref,
        v_executor, 'dispute-split-refund:' || v_dispute.id::text);
      v_result := public.approve_refund(v_refund.id, v_executor);
    else
      v_result := jsonb_build_object('ok', true, 'note', 'no buyer portion');
    end if;

    if v_decision.seller_amount_tzs > 0 then
      update public.escrow_transactions
        set status = 'funded', hold_reason = null, updated_at = now()
        where id = v_escrow.id and status = 'held';

      perform public.post_ledger_transaction(
        v_order.seller_id, v_decision.seller_amount_tzs, 'escrow_release',
        'split-release:' || v_dispute.id::text, v_order.id);
    end if;

    update public.escrow_transactions
      set status = 'split', refunded_at = now(), updated_at = now()
      where id = v_escrow.id;

    update public.orders
      set status = 'split', updated_at = now()
      where id = v_order.id;

    update public.dispute_decisions
      set financial_action = 'split_applied',
          financial_reference = v_decision.id::text
      where id = v_decision.id;
  end if;

  perform public.log_dispute_timeline(p_dispute_id, 'financial_outcome_executed',
    jsonb_build_object('action', v_decision.decision, 'executor_id', v_executor), v_executor);

  insert into public.activity_events (user_id, kind, dispute_id, order_id, payload)
  values
    (v_order.buyer_id, 'order_refunded', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'dispute_ref', v_dispute.ref)),
    (v_order.seller_id, 'order_refunded', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'dispute_ref', v_dispute.ref));

  return jsonb_build_object('ok', true, 'action', v_decision.decision, 'result', v_result);
end;
$$;
revoke all on function public.execute_dispute_financial_outcome(uuid, uuid) from public, anon, authenticated;
grant execute on function public.execute_dispute_financial_outcome(uuid, uuid) to service_role;

/* Reopen a dispute. Only under an explicit, authorised policy. */
create or replace function public.reopen_dispute(
  p_dispute_id uuid,
  p_reason text,
  p_reviewer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid := coalesce(p_reviewer_id, (select auth.uid()));
  v_dispute public.disputes%rowtype;
begin
  if v_reviewer is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason is required to reopen a dispute' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_reviewer and r.role = 'admin'
  ) then
    raise exception 'Only an admin may reopen a dispute' using errcode = '42501';
  end if;

  select d.* into v_dispute from public.disputes d where d.id = p_dispute_id for update;
  if not found then
    raise exception 'Dispute not found' using errcode = 'P0002';
  end if;
  if v_dispute.status <> 'resolved' then
    raise exception 'This dispute is not resolved' using errcode = 'P0001';
  end if;

  update public.disputes
    set status = 'open', outcome = null, resolved_at = null, closed_at = null,
        reopened_count = reopened_count + 1, seller_deadline = now() + interval '48 hours'
    where id = p_dispute_id;

  update public.orders
    set status = 'disputed', updated_at = now()
    where id = v_dispute.order_id;

  perform public.place_escrow_hold(v_dispute.order_id, 'dispute reopened: ' || p_dispute_id::text);

  perform public.log_dispute_timeline(p_dispute_id, 'dispute_reopened',
    jsonb_build_object('reason', btrim(p_reason)), v_reviewer);

  return jsonb_build_object('ok', true, 'dispute_id', p_dispute_id);
end;
$$;
revoke all on function public.reopen_dispute(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reopen_dispute(uuid, text, uuid) to service_role;

/* ========================================================================== *
 * 5. VIEWS FOR PARTICIPANTS
 * ========================================================================== */

create or replace function public.my_disputes()
returns setof jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id,
    'ref', d.ref,
    'order_id', d.order_id,
    'order_ref', o.ref,
    'item_name', o.item_name,
    'amount_tzs', o.subtotal_tzs,
    'status', d.status,
    'outcome', d.outcome,
    'reason', d.reason,
    'description', d.description,
    'seller_deadline', d.seller_deadline,
    'resolved_at', d.resolved_at,
    'opened_by_me', d.opened_by = (select auth.uid()),
    'evidence_count', (select count(*) from public.dispute_evidence e where e.dispute_id = d.id),
    'message_count', (select count(*) from public.dispute_messages m where m.dispute_id = d.id)
  )
  from public.disputes d
  join public.orders o on o.id = d.order_id
  where o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid())
  order by d.created_at desc;
$$;
grant execute on function public.my_disputes() to authenticated;
