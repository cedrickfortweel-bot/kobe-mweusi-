/* Kobe Mweusi — Module M: analytics, reports and company finance.

   The admin dashboard needs reliable operational metrics without confusing
   customer money with company income. Everything here is built on
   authorised queries, views and aggregate tables. Dashboard users never
   get unrestricted access to raw KYC documents or sensitive financial data
   simply because they need reports.

   Views created here
     v_platform_revenue      platform fees, separated from customer money
     v_order_metrics         order volume and lifecycle
     v_payment_metrics       payment success and failure
     v_dispute_metrics       dispute volume and resolution
     v_escrow_position       what the platform currently holds
     v_seller_performance    per-seller completion and dispute rates
     v_daily_business        daily aggregates for the dashboard

   Tables added here
     daily_business_metrics  materialised daily aggregates
     financial_reports       generated report metadata
*/

create table if not exists public.daily_business_metrics (
  metric_date date primary key,
  orders_created integer not null default 0,
  orders_completed integer not null default 0,
  orders_cancelled integer not null default 0,
  orders_disputed integer not null default 0,
  gross_volume_tzs bigint not null default 0,
  escrow_held_tzs bigint not null default 0,
  platform_revenue_tzs bigint not null default 0,
  refunds_tzs bigint not null default 0,
  payments_succeeded integer not null default 0,
  payments_failed integer not null default 0,
  disputes_opened integer not null default 0,
  disputes_resolved integer not null default 0,
  computed_at timestamptz not null default now()
);

alter table public.daily_business_metrics enable row level security;
revoke all on public.daily_business_metrics from anon, authenticated;
grant select on public.daily_business_metrics to authenticated;

drop policy if exists daily_business_metrics_select_staff on public.daily_business_metrics;
create policy daily_business_metrics_select_staff on public.daily_business_metrics
  for select to authenticated using (public.is_internal_staff());

create table if not exists public.financial_reports (
  id uuid primary key default gen_random_uuid(),
  report_type text not null
    check (report_type in ('revenue', 'escrow', 'payouts', 'reconciliation', 'tax', 'audit')),
  period_start date not null,
  period_end date not null,
  generated_by uuid references public.profiles (id),
  storage_path text,
  totals jsonb not null default '{}'::jsonb,
  status text not null default 'ready' check (status in ('pending', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  constraint financial_reports_period check (period_end >= period_start)
);

create index if not exists financial_reports_type_idx
  on public.financial_reports (report_type, period_end desc);

alter table public.financial_reports enable row level security;
revoke all on public.financial_reports from anon, authenticated;
grant select on public.financial_reports to authenticated;

drop policy if exists financial_reports_select_staff on public.financial_reports;
create policy financial_reports_select_staff on public.financial_reports
  for select to authenticated using (public.is_internal_staff());

/* ========================================================================== *
 * 1. VIEWS
 * ========================================================================== */

create or replace view public.v_platform_revenue
with (security_invoker = true)
as
  select
    p.fee_type,
    count(*)::int as entries,
    coalesce(sum(p.amount_tzs), 0)::bigint as total_tzs,
    min(p.created_at) as first_at,
    max(p.created_at) as last_at
  from public.platform_fees p
  group by p.fee_type;

create or replace view public.v_order_metrics
with (security_invoker = true)
as
  select
    o.status::text as status,
    count(*)::int as orders,
    coalesce(sum(o.subtotal_tzs), 0)::bigint as gross_tzs,
    coalesce(sum(o.total_due_tzs), 0)::bigint as charged_tzs,
    coalesce(sum(o.buyer_fee_tzs), 0)::bigint as buyer_fees_tzs,
    min(o.created_at) as first_at,
    max(o.created_at) as last_at
  from public.orders o
  group by o.status;

create or replace view public.v_payment_metrics
with (security_invoker = true)
as
  select
    i.provider,
    i.status::text as status,
    count(*)::int as payments,
    coalesce(sum(i.amount_tzs), 0)::bigint as amount_tzs,
    min(i.created_at) as first_at,
    max(i.created_at) as last_at
  from public.payment_intents i
  group by i.provider, i.status;

create or replace view public.v_dispute_metrics
with (security_invoker = true)
as
  select
    d.status::text as status,
    coalesce(d.outcome::text, 'none') as outcome,
    count(*)::int as disputes,
    coalesce(sum(o.subtotal_tzs), 0)::bigint as amount_tzs,
    avg(extract(epoch from (coalesce(d.resolved_at, now()) - d.created_at)) / 3600)::numeric(10,2)
      as avg_hours_to_resolve
  from public.disputes d
  join public.orders o on o.id = d.order_id
  group by d.status, coalesce(d.outcome::text, 'none');

create or replace view public.v_escrow_position
with (security_invoker = true)
as
  select
    t.status::text as status,
    count(*)::int as transactions,
    coalesce(sum(t.amount_tzs), 0)::bigint as amount_tzs,
    coalesce(sum(t.buyer_fee_tzs), 0)::bigint as buyer_fees_tzs,
    coalesce(sum(t.seller_fee_tzs), 0)::bigint as seller_fees_tzs
  from public.escrow_transactions t
  group by t.status;

create or replace view public.v_seller_performance
with (security_invoker = true)
as
  select
    s.user_id as seller_id,
    s.shop_name,
    s.verification_status::text as verification_status,
    count(o.id)::int as orders,
    count(*) filter (where o.status = 'completed')::int as completed,
    count(*) filter (where o.status = 'disputed')::int as disputed,
    count(*) filter (where o.status = 'cancelled')::int as cancelled,
    coalesce(sum(o.subtotal_tzs) filter (where o.status = 'completed'), 0)::bigint as earned_tzs,
    coalesce((select round(avg(r.stars)::numeric, 2) from public.reviews r where r.seller_id = s.user_id), 0) as rating,
    coalesce((select count(*) from public.reviews r where r.seller_id = s.user_id), 0)::int as review_count
  from public.seller_profiles s
  left join public.orders o on o.seller_id = s.user_id
  group by s.user_id, s.shop_name, s.verification_status;

create or replace view public.v_daily_business
with (security_invoker = true)
as
  select
    (o.created_at at time zone 'Africa/Dar_es_Salaam')::date as day,
    count(*)::int as orders,
    count(*) filter (where o.status = 'completed')::int as completed,
    count(*) filter (where o.status = 'disputed')::int as disputed,
    count(*) filter (where o.status = 'cancelled')::int as cancelled,
    coalesce(sum(o.subtotal_tzs), 0)::bigint as gross_tzs,
    coalesce(sum(o.buyer_fee_tzs), 0)::bigint as buyer_fees_tzs
  from public.orders o
  group by 1;

create or replace view public.v_kobe_id_directory
with (security_invoker = true)
as
  select
    r.kobe_id,
    s.shop_name,
    s.shop_slug,
    s.region,
    s.verification_status::text as verification_status,
    r.assigned_at
  from public.kobe_id_registry r
  join public.seller_profiles s on s.user_id = r.assigned_user_id;

grant select on public.v_platform_revenue, public.v_order_metrics,
  public.v_payment_metrics, public.v_dispute_metrics, public.v_escrow_position,
  public.v_seller_performance, public.v_daily_business, public.v_kobe_id_directory
  to authenticated;

revoke all on public.v_platform_revenue, public.v_order_metrics,
  public.v_payment_metrics, public.v_dispute_metrics, public.v_escrow_position,
  public.v_seller_performance, public.v_daily_business, public.v_kobe_id_directory
  from anon;

drop policy if exists v_kobe_id_directory_read_verified on public.kobe_id_registry;
create policy v_kobe_id_directory_read_verified on public.kobe_id_registry
  for select to authenticated
  using (exists (
    select 1 from public.seller_profiles s
    where s.user_id = kobe_id_registry.assigned_user_id
      and s.verification_status = 'verified'
  ));

/* ========================================================================== *
 * 2. AGGREGATION
 * ========================================================================== */

/* Recompute the daily metrics for a given day. Idempotent. */
create or replace function public.compute_daily_metrics(p_day date)
returns public.daily_business_metrics
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz := p_day::timestamptz;
  v_end timestamptz := (p_day + 1)::timestamptz;
  v_row public.daily_business_metrics%rowtype;
begin
  insert into public.daily_business_metrics as d
    (metric_date, orders_created, orders_completed, orders_cancelled, orders_disputed,
     gross_volume_tzs, escrow_held_tzs, platform_revenue_tzs, refunds_tzs,
     payments_succeeded, payments_failed, disputes_opened, disputes_resolved, computed_at)
  select
    p_day,
    (select count(*)::int from public.orders o
      where o.created_at >= v_start and o.created_at < v_end),
    (select count(*)::int from public.orders o
      where o.status = 'completed' and o.updated_at >= v_start and o.updated_at < v_end),
    (select count(*)::int from public.orders o
      where o.status = 'cancelled' and o.updated_at >= v_start and o.updated_at < v_end),
    (select count(*)::int from public.orders o
      where o.status = 'disputed' and o.created_at >= v_start and o.created_at < v_end),
    (select coalesce(sum(o.subtotal_tzs), 0)::bigint from public.orders o
      where o.created_at >= v_start and o.created_at < v_end),
    (select coalesce(sum(t.amount_tzs), 0)::bigint from public.escrow_transactions t
      where t.status in ('funded', 'held', 'release_pending')),
    (select coalesce(sum(f.amount_tzs), 0)::bigint from public.platform_fees f
      where f.created_at >= v_start and f.created_at < v_end),
    (select coalesce(sum(r.amount_tzs), 0)::bigint from public.refunds r
      where r.status = 'completed' and r.updated_at >= v_start and r.updated_at < v_end),
    (select count(*)::int from public.payment_intents i
      where i.status = 'confirmed' and i.created_at >= v_start and i.created_at < v_end),
    (select count(*)::int from public.payment_intents i
      where i.status = 'failed' and i.created_at >= v_start and i.created_at < v_end),
    (select count(*)::int from public.disputes d
      where d.created_at >= v_start and d.created_at < v_end),
    (select count(*)::int from public.disputes d
      where d.status = 'resolved' and d.resolved_at >= v_start and d.resolved_at < v_end),
    now()
  on conflict (metric_date) do update set
    orders_created = excluded.orders_created,
    orders_completed = excluded.orders_completed,
    orders_cancelled = excluded.orders_cancelled,
    orders_disputed = excluded.orders_disputed,
    gross_volume_tzs = excluded.gross_volume_tzs,
    escrow_held_tzs = excluded.escrow_held_tzs,
    platform_revenue_tzs = excluded.platform_revenue_tzs,
    refunds_tzs = excluded.refunds_tzs,
    payments_succeeded = excluded.payments_succeeded,
    payments_failed = excluded.payments_failed,
    disputes_opened = excluded.disputes_opened,
    disputes_resolved = excluded.disputes_resolved,
    computed_at = now()
  returning * into v_row;

  return v_row;
end;
$$;
revoke all on function public.compute_daily_metrics(date) from public, anon, authenticated;
grant execute on function public.compute_daily_metrics(date) to service_role;

/* Recompute the last N days. */
create or replace function public.compute_recent_metrics(p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  i integer;
  n integer := 0;
begin
  for i in 0..greatest(0, least(coalesce(p_days, 7), 90)) loop
    perform public.compute_daily_metrics((current_date - i));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.compute_recent_metrics(integer) from public, anon, authenticated;
grant execute on function public.compute_recent_metrics(integer) to service_role;

/* A financial report snapshot. */
create or replace function public.generate_financial_report(
  p_report_type text,
  p_period_start date,
  p_period_end date,
  p_generated_by uuid default null
)
returns public.financial_reports
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.financial_reports%rowtype;
  v_start timestamptz := p_period_start::timestamptz;
  v_end timestamptz := (p_period_end + 1)::timestamptz;
  v_totals jsonb;
begin
  v_totals := jsonb_build_object(
    'gross_volume_tzs', (select coalesce(sum(o.subtotal_tzs), 0) from public.orders o
      where o.created_at >= v_start and o.created_at < v_end),
    'orders', (select count(*) from public.orders o
      where o.created_at >= v_start and o.created_at < v_end),
    'platform_revenue_tzs', (select coalesce(sum(f.amount_tzs), 0) from public.platform_fees f
      where f.created_at >= v_start and f.created_at < v_end),
    'refunds_tzs', (select coalesce(sum(r.amount_tzs), 0) from public.refunds r
      where r.status = 'completed' and r.updated_at >= v_start and r.updated_at < v_end),
    'payouts_tzs', (select coalesce(sum(p.amount_tzs), 0) from public.payout_requests p
      where p.status = 'completed' and p.updated_at >= v_start and p.updated_at < v_end),
    'escrow_held_tzs', (select coalesce(sum(t.amount_tzs), 0) from public.escrow_transactions t
      where t.status in ('funded', 'held', 'release_pending')),
    'disputes_opened', (select count(*) from public.disputes d
      where d.created_at >= v_start and d.created_at < v_end)
  );

  insert into public.financial_reports
    (report_type, period_start, period_end, generated_by, totals, status)
  values (p_report_type, p_period_start, p_period_end, p_generated_by, v_totals, 'ready')
  returning * into v_report;

  return v_report;
end;
$$;
revoke all on function public.generate_financial_report(text, date, date, uuid)
  from public, anon, authenticated;
grant execute on function public.generate_financial_report(text, date, date, uuid) to service_role;
