/* Kobe Mweusi — Module O: realtime, scheduled jobs and automatic updates.

   Realtime is a capability across modules, not a replacement for the tables
   or the backend functions. Only the tables that genuinely need a live
   subscription are added to the realtime publication, and access is
   enforced by the existing RLS policies.

   Scheduled jobs
     restore_expired_orders        cancel unpaid orders after the window
     process_due_escrow_releases   release escrow whose window elapsed
     compute_recent_metrics        refresh the daily business aggregates
     prune_notification_queue      remove old delivery and notification rows
     prune_idempotency_keys        remove expired idempotency keys
     expire_handoff_codes          revoke codes that are past their expiry
     mark_overdue_pickups          flag parcels nobody collected

   pg_cron is not available on every Supabase project. The job functions are
   created unconditionally and the schedules are added only when pg_cron is
   installed, so the migration never fails.
*/

create extension if not exists pg_cron with schema extensions;

create extension if not exists pg_net with schema extensions;

/* ========================================================================== *
 * 1. REALTIME PUBLICATION
 * ========================================================================== */

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

-- Only the tables a client genuinely needs to watch live.
do $$
declare
  t text;
  tables_to_publish text[] := array[
    'activity_events', 'notifications', 'orders', 'chat_messages',
    'chat_threads', 'disputes', 'dispute_messages', 'live_sessions',
    'handoff_events', 'order_delivery_workflows', 'payment_intents'
  ];
begin
  foreach t in array tables_to_publish loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = t) then
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then
        null;
      end when;
    end if;
  end loop;
end
$$;

/* ========================================================================== *
 * 2. JOB FUNCTIONS
 * ========================================================================== */

/* Revoke handoff codes that are past their expiry, so a stale code can
   never be scanned. */
create or replace function public.expire_handoff_codes()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  update public.handoff_codes
    set revoked_at = now()
    where used_at is null and revoked_at is null and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.expire_handoff_codes() from public, anon, authenticated;
grant execute on function public.expire_handoff_codes() to service_role;

/* Mark parcels that nobody collected. */
create or replace function public.mark_overdue_pickups(p_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  insert into public.pickup_events (order_id, hub_id, event_type, notes)
  select w.order_id, w.hub_id, 'overdue',
    'Not collected within ' || greatest(1, coalesce(p_hours, 24)) || ' hours'
  from public.order_delivery_workflows w
  join public.orders o on o.id = w.order_id
  where o.status in ('in_escrow', 'delivered')
    and w.stage in ('direct_pending', 'seller_to_agent_complete')
    and w.release_scheduled_for is not null
    and w.release_scheduled_for < now() - make_interval(hours => greatest(1, coalesce(p_hours, 24)))
    and not exists (
      select 1 from public.pickup_events pe
      where pe.order_id = w.order_id and pe.event_type = 'overdue'
    );

  get diagnostics v_count = row_count;

  if v_count > 0 then
    insert into public.activity_events (user_id, kind, order_id, payload)
    select o.buyer_id, 'support_update', o.id,
      jsonb_build_object('title', 'Pickup overdue',
        'ref', o.ref, 'message', 'Your parcel has not been collected yet. Contact support if this is unexpected.')
    from public.orders o
    join public.order_delivery_workflows w on w.order_id = o.id
    where o.status in ('in_escrow', 'delivered')
      and not exists (
        select 1 from public.pickup_events pe
        where pe.order_id = o.id and pe.event_type = 'overdue'
      );
  end if;

  return v_count;
end;
$$;
revoke all on function public.mark_overdue_pickups(integer) from public, anon, authenticated;
grant execute on function public.mark_overdue_pickups(integer) to service_role;

/* A single entry point for the scheduled jobs, so a scheduler needs one
   call rather than eight. */
create or replace function public.run_due_jobs()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_results jsonb := '{}'::jsonb;
begin
  v_results := v_results || jsonb_build_object(
    'expire_handoff_codes', public.run_scheduled_job('expire_handoff_codes', 'expire_handoff_codes'));
  v_results := v_results || jsonb_build_object(
    'restore_expired_orders', public.run_scheduled_job('restore_expired_orders', 'restore_expired_orders'));
  v_results := v_results || jsonb_build_object(
    'process_due_escrow_releases',
      public.run_scheduled_job('process_due_escrow_releases', 'process_due_escrow_releases'));
  v_results := v_results || jsonb_build_object(
    'compute_recent_metrics', public.run_scheduled_job('compute_recent_metrics', 'compute_recent_metrics'));
  v_results := v_results || jsonb_build_object(
    'prune_notification_queue', public.run_scheduled_job('prune_notification_queue', 'prune_notification_queue'));
  v_results := v_results || jsonb_build_object(
    'prune_idempotency_keys', public.run_scheduled_job('prune_idempotency_keys', 'prune_idempotency_keys'));
  v_results := v_results || jsonb_build_object(
    'mark_overdue_pickups', public.run_scheduled_job('mark_overdue_pickups', 'mark_overdue_pickups'));

  return v_results;
end;
$$;
revoke all on function public.run_due_jobs() from public, anon, authenticated;
grant execute on function public.run_due_jobs() to service_role;

/* ========================================================================== *
 * 3. SCHEDULES
 * ========================================================================== */

do $$
declare
  v_has_cron boolean := false;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into v_has_cron;

  if not v_has_cron then
    raise notice 'pg_cron is not installed: scheduled jobs are available as functions but not auto-scheduled.';
    return;
  end if;

  -- Unsubscribe first so the migration is re-runnable.
  perform cron.unschedule(jobid) from cron.job where jobname like 'kobe-%';

  -- The job bodies use a dollar-quoted tag so they do not close this block.
  perform cron.schedule('kobe-expire-handoff-codes', '*/5 * * * *',
    $cron$select public.expire_handoff_codes()$cron$);
  perform cron.schedule('kobe-restore-expired-orders', '*/10 * * * *',
    $cron$select public.restore_expired_orders()$cron$);
  perform cron.schedule('kobe-process-escrow-releases', '*/2 * * * *',
    $cron$select public.process_due_escrow_releases(200)$cron$);
  perform cron.schedule('kobe-mark-overdue-pickups', '*/30 * * * *',
    $cron$select public.mark_overdue_pickups(24)$cron$);
  perform cron.schedule('kobe-compute-metrics', '17 2 * * *',
    $cron$select public.compute_recent_metrics(7)$cron$);
  perform cron.schedule('kobe-prune-notifications', '23 3 * * *',
    $cron$select public.prune_notification_queue(30)$cron$);
  perform cron.schedule('kobe-prune-idempotency-keys', '*/15 * * * *',
    $cron$select public.prune_idempotency_keys()$cron$);
end
$$;
