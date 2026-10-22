/* ========================================================================== *
 * DELIVERY AGENT HUB
 *
 * The agent workspace (agent.html) was a local demo. It kept its own
 * password in the browser, recorded scans in an array, and never asked the
 * server anything: a scan was "captured", the seller was never told, and
 * the money was never tracked. The database already knew how to take an
 * agent's scan (record_handoff_scan accepts an assigned agent), but the
 * agent had no identity and no way to read its own work back.
 *
 * This migration gives the agent:
 *   * a worker ID and a region, so the hub shows who is on the handover,
 *   * read access to the orders assigned to them, their delivery workflow
 *     and the handoff events they recorded,
 *   * agent_hub_snapshot(), which assembles the whole dashboard in one
 *     call so the page never has to guess what it may see.
 *
 * The function takes the user id as an argument rather than reading
 * auth.uid(), because it is called with the service key from the Edge
 * Function, where the request has no user claims of its own. Only
 * service_role may execute it, and the Edge Function passes the id it
 * verified from the caller's token.
 * ========================================================================== */

begin;

alter table public.delivery_agents
  add column if not exists worker_id text,
  add column if not exists region text;

create unique index if not exists delivery_agents_worker_id_idx
  on public.delivery_agents (worker_id)
  where worker_id is not null;

/* --------------------------------------------------------------------------
 * Staff set the worker ID and the region of an agent.
 * -------------------------------------------------------------------------- */
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
begin
  if p_reviewer_id is null then
    raise exception 'A reviewer is required' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_reviewer_id and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Only operations staff can set an agent worker ID' using errcode = '42501';
  end if;

  if v_clean is not null and v_clean !~ '^KMW-[0-9]{2}[A-Z]{2}$' then
    raise exception 'A worker ID looks like KMW-12XL' using errcode = 'P0001';
  end if;

  insert into public.delivery_agents (user_id, worker_id, region)
  values (p_agent_id, v_clean, nullif(btrim(p_region), ''))
  on conflict (user_id) do update
    set worker_id = excluded.worker_id,
        region = coalesce(excluded.region, public.delivery_agents.region),
        updated_at = now();

  return jsonb_build_object(
    'ok', true,
    'worker_id', v_clean,
    'region', nullif(btrim(p_region), '')
  );
end;
$$;

revoke all on function public.set_agent_worker_identity(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.set_agent_worker_identity(uuid, text, text, uuid) to service_role;

/* --------------------------------------------------------------------------
 * Agent read access.
 *
 * The tables were readable by nobody, so an agent could not even see the
 * work assigned to them. Each policy names the agent explicitly.
 * -------------------------------------------------------------------------- */
alter table public.delivery_assignments enable row level security;
alter table public.order_delivery_workflows enable row level security;

grant select on public.delivery_assignments, public.order_delivery_workflows to authenticated;

drop policy if exists delivery_assignments_select_own on public.delivery_assignments;
create policy delivery_assignments_select_own on public.delivery_assignments
  for select to authenticated
  using (agent_user_id = (select auth.uid()));

drop policy if exists order_delivery_workflows_select_participant on public.order_delivery_workflows;
create policy order_delivery_workflows_select_participant on public.order_delivery_workflows
  for select to authenticated
  using (
    agent_user_id = (select auth.uid())
    or exists (
      select 1 from public.orders o
      where o.id = public.order_delivery_workflows.order_id
        and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
    )
  );

drop policy if exists handoff_events_select_participant on public.handoff_events;
create policy handoff_events_select_participant on public.handoff_events
  for select to authenticated
  using (
    scanned_by = (select auth.uid())
    or exists (
      select 1 from public.orders o
      where o.id = public.handoff_events.order_id
        and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
    )
    or exists (
      select 1 from public.delivery_assignments da
      where da.order_id = public.handoff_events.order_id
        and da.agent_user_id = (select auth.uid())
    )
  );

/* --------------------------------------------------------------------------
 * The dashboard, in one call.
 *
 * The agent's day is read from the handoff events they recorded, so the
 * count can never drift from the audit trail. The business day is the
 * Tanzania day, because "today's scans" is a local question.
 * -------------------------------------------------------------------------- */
create or replace function public.agent_hub_snapshot(
  p_user uuid,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent public.delivery_agents%rowtype;
  v_scans jsonb;
  v_assignments jsonb;
  v_today integer := 0;
  v_count integer;
begin
  if p_user is null then
    raise exception 'A user is required' using errcode = 'P0001';
  end if;

  v_count := least(greatest(coalesce(p_limit, 20), 1), 100);

  select * into v_agent
  from public.delivery_agents d
  where d.user_id = p_user;

  if not found then
    raise exception 'This account is not a delivery agent' using errcode = '42501';
  end if;

  select count(*) into v_today
  from public.handoff_events e
  where e.scanned_by = p_user
    and e.created_at >= date_trunc('day', now() at time zone 'Africa/Dar_es_Salaam')
                        at time zone 'Africa/Dar_es_Salaam';

  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_assignments
  from (
    select o.ref as order_ref,
           o.item_name,
           o.status as order_status,
           w.stage,
           w.delivery_mode,
           a.status as assignment_status,
           a.created_at as assigned_at
    from public.delivery_assignments a
    join public.orders o on o.id = a.order_id
    left join public.order_delivery_workflows w on w.order_id = o.id
    where a.agent_user_id = p_user
      and a.status <> 'cancelled'
    order by a.created_at desc
    limit 50
  ) x;

  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_scans
  from (
    select e.id,
           e.stage,
           e.created_at,
           e.details,
           o.ref as order_ref,
           o.item_name
    from public.handoff_events e
    join public.orders o on o.id = e.order_id
    where e.scanned_by = p_user
    order by e.created_at desc
    limit v_count
  ) x;

  return jsonb_build_object(
    'ok', true,
    'worker_id', v_agent.worker_id,
    'region', v_agent.region,
    'verification_status', v_agent.verification_status,
    'verified', v_agent.verification_status = 'verified',
    'verified_at', v_agent.verified_at,
    'today_scans', v_today,
    'assignments', v_assignments,
    'scans', v_scans
  );
end;
$$;

revoke all on function public.agent_hub_snapshot(uuid, integer) from public, anon, authenticated;
grant execute on function public.agent_hub_snapshot(uuid, integer) to service_role;

commit;
