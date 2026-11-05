begin;

create or replace function public.admin_dispute_queue(p_limit integer default 50)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id,
    'order_ref', o.ref,
    'order_id', o.id,
    'item_name', o.item_name,
    'total_due_tzs', o.total_due_tzs,
    'escrow_amount_tzs', e.amount_tzs,
    'reason', d.reason,
    'status', d.status,
    'outcome', d.outcome,
    'financial_action', (
      select dec.financial_action
      from public.dispute_decisions dec
      where dec.dispute_id = d.id
      order by dec.created_at desc
      limit 1
    ),
    'decision_reason', (
      select dec.reason
      from public.dispute_decisions dec
      where dec.dispute_id = d.id
      order by dec.created_at desc
      limit 1
    ),
    'buyer_amount_tzs', (
      select dec.buyer_amount_tzs
      from public.dispute_decisions dec
      where dec.dispute_id = d.id
      order by dec.created_at desc
      limit 1
    ),
    'seller_amount_tzs', (
      select dec.seller_amount_tzs
      from public.dispute_decisions dec
      where dec.dispute_id = d.id
      order by dec.created_at desc
      limit 1
    ),
    'opened_at', d.created_at,
    'seller_deadline', d.seller_deadline,
    'overdue', d.seller_deadline < now(),
    'buyer_name', bp.display_name,
    'seller_name', sp.shop_name,
    'escrow_status', e.status
  )
  from public.disputes d
  join public.orders o on o.id = d.order_id
  join public.profiles bp on bp.id = d.opened_by
  join public.seller_profiles sp on sp.user_id = o.seller_id
  left join public.escrow_transactions e on e.order_id = o.id
  where d.status <> 'resolved'
     or exists (
       select 1
       from public.dispute_decisions dec
       where dec.dispute_id = d.id
         and dec.financial_action is null
     )
  order by (d.seller_deadline < now()) desc, d.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke all on function public.admin_dispute_queue(integer) from public, anon, authenticated;
grant execute on function public.admin_dispute_queue(integer) to service_role;

create or replace function public.audit_log_page(
  p_limit integer default 50,
  p_offset integer default 0,
  p_action text default null
)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with entries as (
    select
      a.created_at,
      a.action as action_key,
      jsonb_build_object(
        'id', a.id,
        'actor_id', a.actor_id,
        'actor_role', a.actor_role,
        'action', a.action,
        'target_type', a.target_type,
        'target_id', a.target_id,
        'target_user_id', a.target_user_id,
        'reason', a.reason,
        'detail', a.detail,
        'created_at', a.created_at
      ) as entry
    from public.audit_logs a

    union all

    select
      k.created_at,
      'kyc.' || k.decision,
      jsonb_build_object(
        'id', k.id,
        'actor_id', k.reviewer_id,
        'actor_role', 'staff',
        'action', 'kyc.' || k.decision,
        'target_type', 'seller_kyc_submission',
        'target_id', k.submission_id,
        'target_user_id', k.seller_id,
        'reason', k.review_note,
        'detail', jsonb_build_object('previous_status', k.previous_status),
        'created_at', k.created_at
      )
    from public.kyc_review_audit k

    union all

    select
      t.created_at,
      'dispute.' || t.event,
      jsonb_build_object(
        'id', t.id,
        'actor_id', t.actor_id,
        'actor_role', 'staff',
        'action', 'dispute.' || t.event,
        'target_type', 'dispute',
        'target_id', t.dispute_id,
        'target_user_id', null,
        'reason', t.detail ->> 'reason',
        'detail', t.detail,
        'created_at', t.created_at
      )
    from public.dispute_timeline t
    where t.event in (
      'reviewer_assigned',
      'more_evidence_requested',
      'decision_recorded',
      'financial_outcome_executed',
      'dispute_reopened'
    )
  )
  select entry
  from entries
  where p_action is null or action_key = p_action
  order by created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function public.audit_log_page(integer, integer, text) from public, anon, authenticated;
grant execute on function public.audit_log_page(integer, integer, text) to service_role;

create or replace function public.audit_admin_payout_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed' and old.status is distinct from new.status then
    perform public.log_audit(
      'payout.approved',
      'payout_request',
      new.id,
      new.seller_id,
      null,
      jsonb_build_object(
        'amount_tzs', new.amount_tzs,
        'fee_tzs', new.fee_tzs,
        'provider_reference', new.provider_reference
      ),
      new.approved_by
    );
  end if;
  return new;
end;
$$;

drop trigger if exists payout_admin_audit on public.payout_requests;
create trigger payout_admin_audit
  after update of status on public.payout_requests
  for each row execute function public.audit_admin_payout_completion();

create or replace function public.set_agent_worker_identity(
  p_agent_id uuid,
  p_worker_id text,
  p_region text default null,
  p_reviewer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clean text := nullif(upper(btrim(p_worker_id)), '');
  v_region text := nullif(btrim(p_region), '');
begin
  if p_reviewer_id is null then
    raise exception 'A reviewer is required' using errcode = 'P0001';
  end if;
  if not public.has_permission(p_reviewer_id, 'agents.manage') then
    raise exception 'Only authorized operations staff may manage agents' using errcode = '42501';
  end if;
  if v_clean is not null and v_clean !~ '^KMW-[0-9]{2}[A-Z]{2}$' then
    raise exception 'A worker ID looks like KMW-12XL' using errcode = 'P0001';
  end if;

  insert into public.delivery_agents (user_id, worker_id, region)
  values (p_agent_id, v_clean, v_region)
  on conflict (user_id) do update
    set worker_id = excluded.worker_id,
        region = coalesce(excluded.region, public.delivery_agents.region),
        updated_at = now();

  perform public.log_audit(
    'agent.identity_updated',
    'delivery_agent',
    p_agent_id,
    p_agent_id,
    null,
    jsonb_build_object('worker_id', v_clean, 'region', v_region),
    p_reviewer_id
  );

  return jsonb_build_object('ok', true, 'worker_id', v_clean, 'region', v_region);
end;
$$;
revoke all on function public.set_agent_worker_identity(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.set_agent_worker_identity(uuid, text, text, uuid) to service_role;

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
  v_status text := case when p_verified then 'verified' else 'rejected' end;
begin
  if v_reviewer is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.has_permission(v_reviewer, 'agents.manage') then
    raise exception 'Reviewer is not authorized' using errcode = '42501';
  end if;

  insert into public.delivery_agents (user_id, verification_status, verified_at, verified_by)
  values (p_agent_id, v_status, case when p_verified then now() else null end, v_reviewer)
  on conflict (user_id) do update
    set verification_status = excluded.verification_status,
        verified_at = excluded.verified_at,
        verified_by = excluded.verified_by,
        updated_at = now();

  perform public.log_audit(
    'agent.verification_updated',
    'delivery_agent',
    p_agent_id,
    p_agent_id,
    null,
    jsonb_build_object('verification_status', v_status),
    v_reviewer
  );

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
  v_order_ref text;
begin
  if v_assigner is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.has_permission(v_assigner, 'agents.manage') then
    raise exception 'Assigner is not authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.delivery_agents a
    where a.user_id = p_agent_id and a.verification_status = 'verified'
  ) then
    raise exception 'That agent is not verified' using errcode = 'P0001';
  end if;

  select o.ref into v_order_ref
  from public.orders o
  where o.id = p_order_id
  for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  insert into public.delivery_assignments (order_id, agent_user_id, status, assigned_by)
  values (p_order_id, p_agent_id, 'assigned', v_assigner)
  returning * into v_assignment;

  insert into public.order_delivery_workflows
    (order_id, delivery_mode, stage, agent_user_id)
  values (p_order_id, 'agent', 'not_started', p_agent_id)
  on conflict (order_id) do update
    set delivery_mode = 'agent', agent_user_id = p_agent_id, updated_at = now();

  perform public.log_audit(
    'agent.order_assigned',
    'order',
    p_order_id,
    p_agent_id,
    null,
    jsonb_build_object('order_ref', v_order_ref, 'assignment_id', v_assignment.id),
    v_assigner
  );

  return v_assignment;
end;
$$;
revoke all on function public.assign_delivery_agent(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_delivery_agent(uuid, uuid, uuid) to service_role;

create or replace function public.request_admin_approval(
  p_action text,
  p_reason text,
  p_target_user_id uuid default null,
  p_target_id uuid default null,
  p_amount_tzs bigint default null,
  p_payload jsonb default '{}'::jsonb
)
returns public.admin_approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_permission text := case p_action
    when 'payout.approve' then 'payouts.approve'
    when 'dispute.execute' then 'disputes.resolve'
    else null
  end;
  v_dual_approval boolean;
  v_request public.admin_approval_requests%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if v_permission is null then
    raise exception 'This action cannot be requested through this workflow' using errcode = 'P0001';
  end if;
  if not public.has_permission(v_user, v_permission) then
    raise exception 'You do not have permission to request this action' using errcode = '42501';
  end if;
  select p.requires_dual_approval into v_dual_approval
  from public.admin_permissions p
  where p.permission = v_permission;
  if v_dual_approval is distinct from true then
    raise exception 'This action is not configured for dual approval' using errcode = 'P0001';
  end if;
  if p_target_id is null or char_length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A target and reason are required' using errcode = 'P0001';
  end if;
  if p_action = 'payout.approve' and (p_amount_tzs is null or p_amount_tzs <= 0) then
    raise exception 'A positive payout amount is required' using errcode = 'P0001';
  end if;
  if p_action = 'payout.approve' and not exists (
    select 1
    from public.payout_requests p
    where p.id = p_target_id
      and p.status = 'requested'
      and p.amount_tzs = p_amount_tzs
  ) then
    raise exception 'The payout is no longer pending or its amount has changed' using errcode = 'P0001';
  end if;
  if p_action = 'dispute.execute' and (
    not exists (
      select 1 from public.disputes d
      where d.id = p_target_id and d.status = 'resolved'
    )
    or not exists (
      select 1 from public.dispute_decisions dec
      where dec.dispute_id = p_target_id and dec.financial_action is null
    )
  ) then
    raise exception 'The dispute has no pending financial outcome' using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from public.admin_approval_requests r
    where r.action = p_action
      and r.target_id = p_target_id
      and r.status in ('pending', 'approved')
  ) then
    raise exception 'An approval request for this action is already active' using errcode = 'P0001';
  end if;

  insert into public.admin_approval_requests
    (action, requested_by, target_user_id, target_id, amount_tzs, payload, reason)
  values
    (p_action, v_user, p_target_user_id, p_target_id, p_amount_tzs,
     coalesce(p_payload, '{}'::jsonb), btrim(p_reason))
  returning * into v_request;

  perform public.log_audit('approval.requested', 'admin_approval_request', v_request.id,
    p_target_user_id, p_reason, jsonb_build_object('action', p_action, 'amount', p_amount_tzs), v_user);

  return v_request;
end;
$$;
revoke all on function public.request_admin_approval(text, text, uuid, uuid, bigint, jsonb)
  from public, anon;
grant execute on function public.request_admin_approval(text, text, uuid, uuid, bigint, jsonb)
  to authenticated, service_role;

create or replace function public.validate_dispute_decision_amounts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_escrow_amount bigint;
begin
  select e.amount_tzs into v_escrow_amount
  from public.disputes d
  join public.escrow_transactions e on e.order_id = d.order_id
  where d.id = new.dispute_id
  order by e.created_at desc
  limit 1;

  if v_escrow_amount is null
    or new.buyer_amount_tzs < 0
    or new.seller_amount_tzs < 0
    or new.buyer_amount_tzs + new.seller_amount_tzs <> v_escrow_amount then
    raise exception 'Dispute decision amounts must equal the escrow balance' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_dispute_decision_amounts() from public, anon, authenticated;

drop trigger if exists dispute_decision_amounts_valid on public.dispute_decisions;
create trigger dispute_decision_amounts_valid
  before insert or update of buyer_amount_tzs, seller_amount_tzs on public.dispute_decisions
  for each row execute function public.validate_dispute_decision_amounts();

create or replace function public.require_payout_dual_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed' and old.status is distinct from new.status
    and not exists (
      select 1
      from public.admin_approval_requests r
      where r.action = 'payout.approve'
        and r.target_id = new.id
        and r.status = 'approved'
        and r.approved_by = new.approved_by
        and r.requested_by <> r.approved_by
    ) then
    raise exception 'A second administrator approval is required before paying out' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.require_payout_dual_approval() from public, anon, authenticated;

drop trigger if exists payout_dual_approval_required on public.payout_requests;
create trigger payout_dual_approval_required
  before update of status on public.payout_requests
  for each row execute function public.require_payout_dual_approval();

create or replace function public.require_dispute_dual_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.financial_action is null and new.financial_action is not null
    and not exists (
      select 1
      from public.admin_approval_requests r
      where r.action = 'dispute.execute'
        and r.target_id = new.dispute_id
        and r.status = 'approved'
        and r.requested_by <> r.approved_by
    ) then
    raise exception 'A second administrator approval is required before executing the dispute outcome' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.require_dispute_dual_approval() from public, anon, authenticated;

drop trigger if exists dispute_dual_approval_required on public.dispute_decisions;
create trigger dispute_dual_approval_required
  before update of financial_action on public.dispute_decisions
  for each row execute function public.require_dispute_dual_approval();

commit;
