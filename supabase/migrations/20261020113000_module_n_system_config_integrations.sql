/* Kobe Mweusi — Module N: system configuration and integrations.

   For every integration, document:
     1. What triggers it.
     2. Which backend function calls it.
     3. Which secrets it requires.
     4. How retries and duplicate events are handled.
     5. How errors are recorded and investigated.
     6. How it is tested in development versus production.

   Actual API keys are NEVER stored in these tables and never committed to
   GitHub. Secrets live in Supabase Vault or as Edge Function secrets.

   Tables added here
     payment_provider_config  non-secret provider configuration
     integration_health_checks external service health metadata
     scheduled_job_runs       operational history of scheduled tasks
*/

create table if not exists public.payment_provider_config (
  provider text primary key check (provider in ('azampay')),
  is_enabled boolean not null default false,
  environment text not null default 'sandbox'
    check (environment in ('sandbox', 'production')),
  merchant_identifier text,
  callback_path text,
  supported_methods text[] not null default array['mobile_money']::text[],
  fee_bps integer not null default 100 check (fee_bps between 0 and 10000),
  limits jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

alter table public.payment_provider_config enable row level security;
revoke all on public.payment_provider_config from anon, authenticated;
grant select on public.payment_provider_config to authenticated;

drop policy if exists payment_provider_config_read on public.payment_provider_config;
create policy payment_provider_config_read on public.payment_provider_config
  for select to authenticated using (public.is_internal_staff());

drop policy if exists payment_provider_config_write_staff on public.payment_provider_config;
create policy payment_provider_config_write_staff on public.payment_provider_config
  for all to authenticated
  using (public.has_permission((select auth.uid()), 'system.settings.manage'))
  with check (public.has_permission((select auth.uid()), 'system.settings.manage'));

drop trigger if exists payment_provider_config_set_updated_at on public.payment_provider_config;
create trigger payment_provider_config_set_updated_at
  before update on public.payment_provider_config
  for each row execute function public.set_updated_at();

insert into public.payment_provider_config (provider, is_enabled, environment, merchant_identifier)
values ('azampay', false, 'sandbox', null)
on conflict (provider) do nothing;

create table if not exists public.integration_health_checks (
  id uuid primary key default gen_random_uuid(),
  integration text not null check (char_length(integration) between 2 and 60),
  status text not null default 'unknown'
    check (status in ('healthy', 'degraded', 'down', 'unknown')),
  last_checked_at timestamptz not null default now(),
  last_success_at timestamptz,
  latency_ms integer,
  error text check (error is null or char_length(error) <= 500),
  detail jsonb not null default '{}'::jsonb,
  unique (integration)
);

alter table public.integration_health_checks enable row level security;
revoke all on public.integration_health_checks from anon, authenticated;
grant select on public.integration_health_checks to authenticated;

drop policy if exists integration_health_checks_read_staff on public.integration_health_checks;
create policy integration_health_checks_read_staff on public.integration_health_checks
  for select to authenticated using (public.is_internal_staff());

create table if not exists public.scheduled_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null check (char_length(job_name) between 2 and 60),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'skipped')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  rows_affected integer,
  detail jsonb not null default '{}'::jsonb,
  error text check (error is null or char_length(error) <= 1000)
);

create index if not exists scheduled_job_runs_name_idx
  on public.scheduled_job_runs (job_name, started_at desc);

alter table public.scheduled_job_runs enable row level security;
revoke all on public.scheduled_job_runs from anon, authenticated;
grant select on public.scheduled_job_runs to authenticated;

drop policy if exists scheduled_job_runs_read_staff on public.scheduled_job_runs;
create policy scheduled_job_runs_read_staff on public.scheduled_job_runs
  for select to authenticated using (public.is_internal_staff());

/* ========================================================================== *
 * 1. JOB RUN WRAPPER
 * ========================================================================== */

/* Run a job and record the outcome, whether it succeeds or fails. */
create or replace function public.run_scheduled_job(
  p_job_name text,
  p_job_fn text,
  p_detail jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.scheduled_job_runs%rowtype;
  v_started timestamptz := now();
  v_result jsonb;
  v_error text;
begin
  insert into public.scheduled_job_runs (job_name, status, started_at, detail)
  values (p_job_name, 'running', v_started, coalesce(p_detail, '{}'::jsonb))
  returning * into v_run;

  begin
    execute format('select public.%I()', p_job_fn) into v_result;
  exception when others then
    v_error := left(sqlerrm, 1000);
    update public.scheduled_job_runs
      set status = 'failed', finished_at = now(),
          duration_ms = (extract(epoch from (now() - v_started)) * 1000)::int,
          error = v_error
      where id = v_run.id;

    return jsonb_build_object('ok', false, 'job', p_job_name, 'error', v_error, 'run_id', v_run.id);
  end;

  update public.scheduled_job_runs
    set status = 'succeeded', finished_at = now(),
        duration_ms = (extract(epoch from (now() - v_started)) * 1000)::int,
        detail = coalesce(detail, '{}'::jsonb) || jsonb_build_object('result', v_result)
    where id = v_run.id;

  return jsonb_build_object('ok', true, 'job', p_job_name, 'result', v_result, 'run_id', v_run.id);
end;
$$;
revoke all on function public.run_scheduled_job(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.run_scheduled_job(text, text, jsonb) to service_role;

/* ========================================================================== *
 * 2. INTEGRATION HEALTH
 * ========================================================================== */

create or replace function public.record_integration_health(
  p_integration text,
  p_status text,
  p_latency_ms integer default null,
  p_error text default null,
  p_detail jsonb default '{}'::jsonb
)
returns public.integration_health_checks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.integration_health_checks%rowtype;
begin
  insert into public.integration_health_checks as h
    (integration, status, last_checked_at, last_success_at, latency_ms, error, detail)
  values
    (p_integration, coalesce(p_status, 'unknown'), now(),
     case when p_status = 'healthy' then now() else null end,
     p_latency_ms, nullif(left(coalesce(p_error, ''), 500), ''),
     coalesce(p_detail, '{}'::jsonb))
  on conflict (integration) do update set
    status = excluded.status,
    last_checked_at = now(),
    last_success_at = case when excluded.status = 'healthy' then now()
                            else public.integration_health_checks.last_success_at end,
    latency_ms = excluded.latency_ms,
    error = excluded.error,
    detail = excluded.detail
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.record_integration_health(text, text, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_integration_health(text, text, integer, text, jsonb) to service_role;

/* ========================================================================== *
 * 3. SETTINGS
 * ========================================================================== */

create or replace function public.set_app_setting(
  p_key text,
  p_value jsonb,
  p_description text default null,
  p_actor_id uuid default null
)
returns public.app_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(p_actor_id, (select auth.uid()));
  v_row public.app_settings%rowtype;
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.has_permission(v_actor, 'system.settings.manage') then
    raise exception 'Only an admin may change application settings' using errcode = '42501';
  end if;

  insert into public.app_settings (key, value, description, updated_by, updated_at)
  values (p_key, coalesce(p_value, '{}'::jsonb), p_description, v_actor, now())
  on conflict (key) do update set
    value = excluded.value,
    description = coalesce(excluded.description, public.app_settings.description),
    updated_by = excluded.updated_by,
    updated_at = now()
  returning * into v_row;

  perform public.log_audit('settings.changed', 'app_settings', null, null, p_description,
    jsonb_build_object('key', p_key), v_actor);

  return v_row;
end;
$$;
revoke all on function public.set_app_setting(text, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.set_app_setting(text, jsonb, text, uuid) to service_role;

/* The escrow policy is what decides when money moves. Reading it is
   allowed for authenticated users so the app can show the timer. */
create or replace function public.get_escrow_policy()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select s.value from public.app_settings s where s.key = 'escrow_policy'),
    jsonb_build_object(
      'release_window_minutes', 180,
      'require_both_scans_for_fast_release', true,
      'buyer_confirmation_releases_immediately', true,
      'agent_scan_can_release', false,
      'dispute_blocks_release', true,
      'auto_release_enabled', true
    )
  );
$$;
grant execute on function public.get_escrow_policy() to authenticated;
