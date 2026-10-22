/* Kobe Mweusi — Module C: wallets, ledger, escrow and payments.

   Money movement is a separate, auditable subsystem. The rules this file
   enforces:

     * A client never updates a balance. Balances are DERIVED from the
       immutable ledger, and only server functions write ledger rows.
     * Every money operation carries an idempotency key, so a repeated
       provider callback cannot credit the same payment twice.
     * Provider callbacks are verified server-side before anything is
       written.
     * Concurrent money operations use row locks and run inside a
       transaction.
     * Customer funds stay separate from platform revenue.
     * A successful frontend response is never treated as proof that money
       arrived.

   IMPORTANT CHANGE OF MEANING
   --------------------------
   The deployed `finalize_order(order_id)` used to RELEASE escrow to the
   seller. That conflated two different events: capturing the buyer's
   payment and paying out the seller. The blueprint keeps them apart.

       place_funds_in_escrow()  buyer's money captured -> order in_escrow
       release_escrow()          escrow paid out to the seller

   `finalize_order()` is kept as a compatibility wrapper that now performs
   the CAPTURE step, because that is what a payment-provider callback
   means. The release path is `release_escrow()` and is reachable only
   through the delivery/confirmation flow described in Module G.

   No live payment has been captured yet (AzamPay is not connected), so
   there is no in-flight transaction to migrate.

   Tables added here
     escrow_transactions        escrow state and release/refund decisions
     payment_provider_events    verified provider callbacks, idempotent
     payout_requests            seller payout requests and approval state
     refunds                    refund requests and provider status
     financial_adjustments      controlled corrections and reversals
     platform_fees              fee attribution to platform revenue
     provider_settlements       provider settlement batches
     reconciliation_runs        ledger vs provider comparison history

   Functions added here
     create_payment_intent(), record_verified_payment(), post_ledger_transaction(),
     place_funds_in_escrow(), release_escrow(), request_refund(), approve_refund(),
     request_seller_payout(), approve_payout(), reconcile_provider_settlement(),
     wallet_balance(), wallet_available_balance(), escrow_position()
*/

/* ========================================================================== *
 * 1. ENUMS
 * ========================================================================== */

do $$
begin
  if not exists (select 1 from pg_type where typname = 'escrow_status') then
    create type public.escrow_status as enum
      ('created', 'funded', 'held', 'release_pending', 'released', 'refunded', 'split', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'refund_status') then
    create type public.refund_status as enum
      ('requested', 'approved', 'processing', 'completed', 'rejected', 'failed');
  end if;
  if not exists (select 1 from pg_type where typname = 'payout_status') then
    create type public.payout_status as enum
      ('requested', 'approved', 'processing', 'completed', 'rejected', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'adjustment_status') then
    create type public.adjustment_status as enum
      ('requested', 'approved', 'applied', 'rejected');
  end if;
  if not exists (select 1 from pg_type where typname = 'settlement_status') then
    create type public.settlement_status as enum
      ('pending', 'reconciled', 'mismatched');
  end if;
end
$$;

/* ========================================================================== *
 * 2. ESCROW TRANSACTIONS
 * ========================================================================== */

create table if not exists public.escrow_transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id) on delete cascade,
  buyer_id uuid not null references public.profiles (id),
  seller_id uuid not null references public.seller_profiles (user_id),
  payment_intent_id uuid references public.payment_intents (id),
  amount_tzs bigint not null check (amount_tzs > 0),
  buyer_fee_tzs bigint not null default 0 check (buyer_fee_tzs >= 0),
  seller_fee_tzs bigint not null default 0 check (seller_fee_tzs >= 0),
  platform_fee_tzs bigint not null default 0 check (platform_fee_tzs >= 0),
  status public.escrow_status not null default 'created',
  funded_at timestamptz,
  release_requested_at timestamptz,
  release_scheduled_for timestamptz,
  released_at timestamptz,
  refunded_at timestamptz,
  hold_reason text,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists escrow_transactions_status_idx
  on public.escrow_transactions (status, release_scheduled_for);
create index if not exists escrow_transactions_seller_idx
  on public.escrow_transactions (seller_id, created_at desc);
create index if not exists escrow_transactions_buyer_idx
  on public.escrow_transactions (buyer_id, created_at desc);

alter table public.escrow_transactions enable row level security;
revoke all on public.escrow_transactions from anon, authenticated;
grant select on public.escrow_transactions to authenticated;

drop policy if exists escrow_transactions_select_participant on public.escrow_transactions;
create policy escrow_transactions_select_participant on public.escrow_transactions
  for select to authenticated
  using (buyer_id = (select auth.uid()) or seller_id = (select auth.uid()));

drop trigger if exists escrow_transactions_set_updated_at on public.escrow_transactions;
create trigger escrow_transactions_set_updated_at
  before update on public.escrow_transactions
  for each row execute function public.set_updated_at();

/* ========================================================================== *
 * 3. PROVIDER CALLBACKS, PAYOUTS, REFUNDS, ADJUSTMENTS
 * ========================================================================== */

create table if not exists public.payment_provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('azampay')),
  provider_event_id text not null,
  event_type text not null,
  payment_intent_id uuid references public.payment_intents (id),
  order_id uuid references public.orders (id),
  amount_tzs bigint,
  signature_verified boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index if not exists payment_provider_events_order_idx
  on public.payment_provider_events (order_id, created_at desc);

alter table public.payment_provider_events enable row level security;
revoke all on public.payment_provider_events from anon, authenticated;
grant select on public.payment_provider_events to authenticated;

drop policy if exists payment_provider_events_select_own on public.payment_provider_events;
create policy payment_provider_events_select_own on public.payment_provider_events
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id
      and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
  ));

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  escrow_transaction_id uuid references public.escrow_transactions (id),
  requested_by uuid not null references public.profiles (id),
  approved_by uuid references public.profiles (id),
  reason text not null check (char_length(reason) between 2 and 500),
  amount_tzs bigint not null check (amount_tzs > 0),
  provider text not null default 'azampay' check (provider in ('azampay')),
  provider_reference text,
  status public.refund_status not null default 'requested',
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists refunds_order_idx on public.refunds (order_id, created_at desc);

alter table public.refunds enable row level security;
revoke all on public.refunds from anon, authenticated;
grant select on public.refunds to authenticated;

drop policy if exists refunds_select_participant on public.refunds;
create policy refunds_select_participant on public.refunds
  for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_id
      and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
  ));

drop trigger if exists refunds_set_updated_at on public.refunds;
create trigger refunds_set_updated_at
  before update on public.refunds
  for each row execute function public.set_updated_at();

create table if not exists public.payout_requests (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.seller_profiles (user_id),
  requested_by uuid not null references public.profiles (id),
  approved_by uuid references public.profiles (id),
  amount_tzs bigint not null check (amount_tzs > 0),
  fee_tzs bigint not null default 0 check (fee_tzs >= 0),
  method text check (method is null or method in ('mobile_money', 'bank')),
  destination text,
  status public.payout_status not null default 'requested',
  idempotency_key text not null unique,
  provider_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists payout_requests_seller_idx
  on public.payout_requests (seller_id, created_at desc);

alter table public.payout_requests enable row level security;
revoke all on public.payout_requests from anon, authenticated;
grant select on public.payout_requests to authenticated;

drop policy if exists payout_requests_select_own on public.payout_requests;
create policy payout_requests_select_own on public.payout_requests
  for select to authenticated using (seller_id = (select auth.uid()));

drop trigger if exists payout_requests_set_updated_at on public.payout_requests;
create trigger payout_requests_set_updated_at
  before update on public.payout_requests
  for each row execute function public.set_updated_at();

create table if not exists public.financial_adjustments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  order_id uuid references public.orders (id),
  entry_type public.wallet_entry_type not null,
  amount_tzs bigint not null check (amount_tzs <> 0),
  reason_code text not null check (char_length(reason_code) between 2 and 60),
  reason text not null check (char_length(reason) between 5 and 1000),
  requested_by uuid not null references public.profiles (id),
  approved_by uuid references public.profiles (id),
  status public.adjustment_status not null default 'requested',
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz
);

alter table public.financial_adjustments enable row level security;
revoke all on public.financial_adjustments from anon, authenticated;

create table if not exists public.platform_fees (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders (id) on delete cascade,
  user_id uuid references public.profiles (id),
  fee_type text not null check (fee_type in ('buyer_fee', 'seller_fee', 'payout_fee', 'adjustment')),
  amount_tzs bigint not null check (amount_tzs >= 0),
  ledger_entry_id uuid references public.wallet_ledger_entries (id),
  created_at timestamptz not null default now()
);

create index if not exists platform_fees_created_idx on public.platform_fees (created_at desc);

alter table public.platform_fees enable row level security;
revoke all on public.platform_fees from anon, authenticated;

create table if not exists public.provider_settlements (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('azampay')),
  provider_batch_id text not null,
  settlement_date date not null,
  gross_tzs bigint not null default 0,
  fees_tzs bigint not null default 0,
  net_tzs bigint not null default 0,
  transaction_count integer not null default 0,
  status public.settlement_status not null default 'pending',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_batch_id)
);

alter table public.provider_settlements enable row level security;
revoke all on public.provider_settlements from anon, authenticated;

create table if not exists public.reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('azampay')),
  settlement_id uuid references public.provider_settlements (id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  internal_total_tzs bigint not null default 0,
  provider_total_tzs bigint not null default 0,
  difference_tzs bigint not null default 0,
  matched_count integer not null default 0,
  mismatched_count integer not null default 0,
  status public.settlement_status not null default 'pending',
  detail jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists reconciliation_runs_started_idx
  on public.reconciliation_runs (started_at desc);

alter table public.reconciliation_runs enable row level security;
revoke all on public.reconciliation_runs from anon, authenticated;

/* ========================================================================== *
 * 4. LEDGER PRIMITIVE
 * ========================================================================== */

/* Append one ledger entry. The only way money is ever recorded.
   `on conflict do nothing` makes it idempotent: a repeated callback with
   the same key cannot post the same money twice. */
create or replace function public.post_ledger_transaction(
  p_user_id uuid,
  p_amount_tzs bigint,
  p_entry_type public.wallet_entry_type,
  p_idempotency_key text,
  p_order_id uuid default null,
  p_payment_intent_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_amount_tzs = 0 then
    raise exception 'A ledger entry must not be zero' using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'An idempotency key is required' using errcode = 'P0001';
  end if;

  insert into public.wallet_ledger_entries
    (user_id, order_id, payment_intent_id, entry_type, amount_tzs, idempotency_key)
  values
    (p_user_id, p_order_id, p_payment_intent_id, p_entry_type, p_amount_tzs, p_idempotency_key)
  on conflict (idempotency_key) do nothing
  returning id into v_id;

  if v_id is null then
    select e.id into v_id
    from public.wallet_ledger_entries e
    where e.idempotency_key = p_idempotency_key;
  end if;

  return v_id;
end;
$$;
revoke all on function public.post_ledger_transaction(uuid, bigint, public.wallet_entry_type, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.post_ledger_transaction(uuid, bigint, public.wallet_entry_type, text, uuid, uuid)
  to service_role;

/* Balance = sum of the ledger. Never a stored column that a client can touch. */
create or replace function public.wallet_balance(p_user uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(e.amount_tzs), 0)::bigint
  from public.wallet_ledger_entries e
  where e.user_id = p_user;
$$;
revoke all on function public.wallet_balance(uuid) from public, anon, authenticated;
grant execute on function public.wallet_balance(uuid) to service_role;

/* Balance that is genuinely spendable: money currently held in escrow is
   not the buyer's to spend again. */
create or replace function public.wallet_available_balance(p_user uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(e.amount_tzs), 0)::bigint
  from public.wallet_ledger_entries e
  where e.user_id = p_user
    and e.entry_type <> 'order_funding';
$$;
revoke all on function public.wallet_available_balance(uuid) from public, anon, authenticated;
grant execute on function public.wallet_available_balance(uuid) to service_role;

/* Money currently held in escrow for a user (as buyer or seller). */
create or replace function public.escrow_position(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'held_as_buyer', coalesce((
      select sum(t.amount_tzs) from public.escrow_transactions t
      where t.buyer_id = p_user and t.status in ('funded', 'held', 'release_pending')
    ), 0),
    'held_as_seller', coalesce((
      select sum(t.amount_tzs) from public.escrow_transactions t
      where t.seller_id = p_user and t.status in ('funded', 'held', 'release_pending')
    ), 0),
    'pending_release', coalesce((
      select sum(t.amount_tzs) from public.escrow_transactions t
      where t.seller_id = p_user and t.status = 'release_pending'
    ), 0),
    'count_open', (
      select count(*) from public.escrow_transactions t
      where (t.buyer_id = p_user or t.seller_id = p_user)
        and t.status in ('funded', 'held', 'release_pending')
    )
  );
$$;
revoke all on function public.escrow_position(uuid) from public, anon, authenticated;
grant execute on function public.escrow_position(uuid) to service_role;

/* ========================================================================== *
 * 5. PAYMENT INTENT AND VERIFIED CAPTURE
 * ========================================================================== */

create or replace function public.create_payment_intent(
  p_buyer_id uuid,
  p_order_id uuid,
  p_amount_tzs bigint,
  p_idempotency_key text,
  p_provider text default 'azampay'
)
returns public.payment_intents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent public.payment_intents%rowtype;
  v_order public.orders%rowtype;
begin
  if p_amount_tzs is null or p_amount_tzs <= 0 then
    raise exception 'A positive amount is required' using errcode = 'P0001';
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.buyer_id <> p_buyer_id then
    raise exception 'This order belongs to another buyer' using errcode = '42501';
  end if;
  if v_order.status <> 'awaiting_payment' then
    raise exception 'This order is not awaiting payment' using errcode = 'P0001';
  end if;
  if p_amount_tzs <> v_order.total_due_tzs then
    raise exception 'Amount does not match the order' using errcode = 'P0001';
  end if;

  insert into public.payment_intents
    (buyer_id, order_id, provider, amount_tzs, status, idempotency_key)
  values
    (p_buyer_id, p_order_id, p_provider, p_amount_tzs, 'pending', p_idempotency_key)
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_intent;

  return v_intent;
end;
$$;
revoke all on function public.create_payment_intent(uuid, uuid, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.create_payment_intent(uuid, uuid, bigint, text, text) to service_role;

/* Record a payment the provider has CONFIRMED. Idempotent on the provider
   event id, so a replayed webhook cannot credit the buyer twice. */
create or replace function public.record_verified_payment(
  p_provider text,
  p_provider_event_id text,
  p_provider_reference text,
  p_amount_tzs bigint,
  p_order_id uuid,
  p_payment_intent_id uuid default null,
  p_raw_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.payment_provider_events%rowtype;
  v_intent public.payment_intents%rowtype;
  v_order public.orders%rowtype;
  v_escrow public.escrow_transactions%rowtype;
  v_duplicate boolean := false;
begin
  if p_provider_event_id is null or btrim(p_provider_event_id) = '' then
    raise exception 'A provider event id is required' using errcode = 'P0001';
  end if;

  select e.* into v_event
  from public.payment_provider_events e
  where e.provider = p_provider and e.provider_event_id = p_provider_event_id;

  if found then
    v_duplicate := true;
  else
    insert into public.payment_provider_events
      (provider, provider_event_id, event_type, payment_intent_id, order_id,
       amount_tzs, signature_verified, raw_payload, processed_at)
    values
      (p_provider, p_provider_event_id, 'payment.succeeded',
       p_payment_intent_id, p_order_id, p_amount_tzs, true,
       coalesce(p_raw_payload, '{}'::jsonb), now())
    returning * into v_event;
  end if;

  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if p_amount_tzs <> v_order.total_due_tzs then
    update public.payment_provider_events
      set processing_error = 'amount_mismatch'
      where id = v_event.id;
    raise exception 'Captured amount does not match the order' using errcode = 'P0001';
  end if;

  if p_payment_intent_id is not null then
    select i.* into v_intent from public.payment_intents i where i.id = p_payment_intent_id for update;
    if found and v_intent.status = 'confirmed' then
      return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', p_order_id);
    end if;
  end if;

  if p_payment_intent_id is not null then
    update public.payment_intents
      set status = 'confirmed', provider_reference = coalesce(p_provider_reference, provider_reference),
          updated_at = now()
      where id = p_payment_intent_id;
  end if;

  -- Capture the buyer's money into escrow.
  v_escrow := public.place_funds_in_escrow(p_order_id, p_payment_intent_id);

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'order_id', p_order_id,
    'escrow_status', v_escrow.status,
    'amount_tzs', v_escrow.amount_tzs
  );
end;
$$;
revoke all on function public.record_verified_payment(text, text, text, bigint, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_verified_payment(text, text, text, bigint, uuid, uuid, jsonb)
  to service_role;

/* ========================================================================== *
 * 6. ESCROW: FUND, HOLD, RELEASE
 * ========================================================================== */

/* Move a paid order into escrow. Idempotent: calling it twice for the same
   order does not double-charge the buyer. */
create or replace function public.place_funds_in_escrow(
  p_order_id uuid,
  p_payment_intent_id uuid default null
)
returns public.escrow_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_escrow public.escrow_transactions%rowtype;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  select e.* into v_escrow from public.escrow_transactions e where e.order_id = p_order_id for update;
  if found then
    if v_escrow.status in ('funded', 'held', 'release_pending', 'released') then
      return v_escrow;
    end if;
  end if;

  if v_order.status = 'awaiting_payment' then
    update public.orders
      set status = 'in_escrow', updated_at = now()
      where id = p_order_id and status = 'awaiting_payment';
  elsif v_order.status <> 'in_escrow' then
    raise exception 'Order is not awaiting payment' using errcode = 'P0001';
  end if;

  if v_escrow.id is null then
    insert into public.escrow_transactions
      (order_id, buyer_id, seller_id, payment_intent_id, amount_tzs,
       buyer_fee_tzs, seller_fee_tzs, status, funded_at)
    values
      (v_order.id, v_order.buyer_id, v_order.seller_id, p_payment_intent_id,
       v_order.total_due_tzs, v_order.buyer_fee_tzs, 0, 'funded', now())
    returning * into v_escrow;
  else
    update public.escrow_transactions
      set status = 'funded', funded_at = coalesce(funded_at, now()),
          payment_intent_id = coalesce(p_payment_intent_id, payment_intent_id),
          updated_at = now()
      where id = v_escrow.id
      returning * into v_escrow;
  end if;

  -- Debit the buyer exactly once.
  perform public.post_ledger_transaction(
    v_order.buyer_id,
    -v_order.total_due_tzs,
    'order_funding',
    'escrow-fund:' || v_order.id::text,
    v_order.id,
    p_payment_intent_id
  );

  -- The platform's buyer fee is revenue, not customer money. It is
  -- recorded here and is NOT credited back to the buyer: the buyer is
  -- charged subtotal + buyer_fee, and crediting the fee back would make
  -- the net charge only the subtotal and the platform fee would vanish.
  if v_order.buyer_fee_tzs > 0 then
    insert into public.platform_fees (order_id, user_id, fee_type, amount_tzs)
    values (v_order.id, v_order.buyer_id, 'buyer_fee', v_order.buyer_fee_tzs)
    on conflict do nothing;
  end if;

  insert into public.activity_events (user_id, kind, order_id, payload)
  values
    (v_order.buyer_id, 'escrow_funded', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'amount', v_order.total_due_tzs)),
    (v_order.seller_id, 'escrow_funded', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'amount', v_order.subtotal_tzs));

  return v_escrow;
end;
$$;
revoke all on function public.place_funds_in_escrow(uuid, uuid) from public, anon, authenticated;
grant execute on function public.place_funds_in_escrow(uuid, uuid) to service_role;

/* Freeze the escrow. A dispute or a staff hold stops any release. */
create or replace function public.place_escrow_hold(
  p_order_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(btrim(p_reason), '');
begin
  if v_note is null then
    raise exception 'A hold reason is required' using errcode = 'P0001';
  end if;

  update public.escrow_transactions
    set status = 'held', hold_reason = v_note, updated_at = now()
    where order_id = p_order_id
      and status in ('funded', 'release_pending');

  return found;
end;
$$;
revoke all on function public.place_escrow_hold(uuid, text) from public, anon, authenticated;
grant execute on function public.place_escrow_hold(uuid, text) to service_role;

/* Pay the escrow out to the seller. This is the ONLY path that credits a
   seller with order money. Idempotent. */
create or replace function public.release_escrow(
  p_order_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_escrow public.escrow_transactions%rowtype;
  v_seller_fee bigint;
  v_net bigint;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  select e.* into v_escrow from public.escrow_transactions e
  where e.order_id = p_order_id for update;

  if not found then
    raise exception 'No escrow transaction for this order' using errcode = 'P0002';
  end if;

  if v_escrow.status = 'released' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'order_id', p_order_id);
  end if;

  if v_escrow.status in ('refunded', 'split', 'cancelled') then
    raise exception 'This escrow is already closed' using errcode = 'P0001';
  end if;

  if v_escrow.status = 'held' then
    raise exception 'This escrow is on hold and cannot be released' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.disputes d
    where d.order_id = p_order_id and d.status <> 'resolved'
  ) then
    raise exception 'An open dispute blocks escrow release' using errcode = 'P0001';
  end if;

  if v_order.status not in ('in_escrow', 'delivered') then
    raise exception 'Order is not eligible for release' using errcode = 'P0001';
  end if;

  v_seller_fee := coalesce(v_escrow.seller_fee_tzs, 0);
  if v_seller_fee = 0 then
    v_seller_fee := round(v_order.subtotal_tzs * 0.01);
  end if;
  v_net := v_order.subtotal_tzs - v_seller_fee;

  update public.orders
    set status = 'completed', updated_at = now()
    where id = p_order_id and status in ('in_escrow', 'delivered');

  if not found then
    raise exception 'Order is not eligible for release' using errcode = 'P0001';
  end if;

  update public.escrow_transactions
    set status = 'released', released_at = now(),
        seller_fee_tzs = v_seller_fee,
        release_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'delivery confirmed'),
        updated_at = now()
    where id = v_escrow.id;

  perform public.post_ledger_transaction(
    v_order.seller_id, v_net, 'escrow_release',
    'release:' || v_order.id::text, v_order.id);

  if v_seller_fee > 0 then
    perform public.post_ledger_transaction(
      v_order.seller_id, -v_seller_fee, 'fee',
      'seller-fee:' || v_order.id::text, v_order.id);

    insert into public.platform_fees (order_id, user_id, fee_type, amount_tzs)
    values (v_order.id, v_order.seller_id, 'seller_fee', v_seller_fee);
  end if;

  insert into public.activity_events (user_id, kind, order_id, payload)
  values
    (v_order.buyer_id, 'order_completed', v_order.id,
      jsonb_build_object('ref', v_order.ref)),
    (v_order.seller_id, 'order_completed', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'net', v_net));

  return jsonb_build_object(
    'ok', true, 'order_id', p_order_id, 'seller_id', v_order.seller_id,
    'gross_tzs', v_order.subtotal_tzs, 'seller_fee_tzs', v_seller_fee, 'net_tzs', v_net);
end;
$$;
revoke all on function public.release_escrow(uuid, text) from public, anon, authenticated;
grant execute on function public.release_escrow(uuid, text) to service_role;

/* Compatibility wrapper. The deployed version released escrow; the payment
   callback means "the payment is finalised", which is the CAPTURE step.
   The release path is release_escrow().

   The previous definition returned void. PostgreSQL cannot change the
   return type of an existing function with CREATE OR REPLACE, so the old
   one is dropped first. */
drop function if exists public.finalize_order(uuid);
create or replace function public.finalize_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_escrow public.escrow_transactions%rowtype;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if v_order.status = 'awaiting_payment' then
    v_escrow := public.place_funds_in_escrow(p_order_id, null);
    return jsonb_build_object('ok', true, 'stage', 'escrow_funded',
      'order_id', p_order_id, 'escrow_status', v_escrow.status);
  end if;

  return public.release_escrow(p_order_id, 'finalize_order');
end;
$$;
revoke all on function public.finalize_order(uuid) from public, anon, authenticated;
grant execute on function public.finalize_order(uuid) to service_role;

/* ========================================================================== *
 * 7. REFUNDS
 * ========================================================================== */

create or replace function public.request_refund(
  p_order_id uuid,
  p_amount_tzs bigint,
  p_reason text,
  p_requested_by uuid,
  p_idempotency_key text default null
)
returns public.refunds
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
  v_order public.orders%rowtype;
  v_escrow public.escrow_transactions%rowtype;
  v_key text;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  select e.* into v_escrow from public.escrow_transactions e where e.order_id = p_order_id;
  if not found then
    raise exception 'No escrow transaction for this order' using errcode = 'P0002';
  end if;
  if v_escrow.status in ('refunded', 'cancelled') then
    raise exception 'This order has already been refunded' using errcode = 'P0001';
  end if;
  if p_amount_tzs is null or p_amount_tzs <= 0 or p_amount_tzs > v_escrow.amount_tzs then
    raise exception 'Invalid refund amount' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 2 then
    raise exception 'A reason is required' using errcode = 'P0001';
  end if;

  v_key := coalesce(p_idempotency_key, 'refund:' || p_order_id::text || ':' || p_amount_tzs::text);

  insert into public.refunds
    (order_id, escrow_transaction_id, requested_by, reason, amount_tzs, idempotency_key)
  values (p_order_id, v_escrow.id, p_requested_by, btrim(p_reason), p_amount_tzs, v_key)
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_refund;

  return v_refund;
end;
$$;
revoke all on function public.request_refund(uuid, bigint, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_refund(uuid, bigint, text, uuid, text) to service_role;

/* Approve and execute a refund. The money is returned to the buyer and the
   escrow row is closed. */
create or replace function public.approve_refund(
  p_refund_id uuid,
  p_approver_id uuid,
  p_provider_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds%rowtype;
  v_order public.orders%rowtype;
  v_escrow public.escrow_transactions%rowtype;
begin
  select r.* into v_refund from public.refunds r where r.id = p_refund_id for update;
  if not found then
    raise exception 'Refund not found' using errcode = 'P0002';
  end if;
  if v_refund.status not in ('requested', 'approved') then
    raise exception 'This refund is not awaiting a decision' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_approver_id and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Approver is not authorized' using errcode = '42501';
  end if;

  select o.* into v_order from public.orders o where o.id = v_refund.order_id for update;
  select e.* into v_escrow from public.escrow_transactions e
  where e.order_id = v_refund.order_id for update;

  if v_escrow.status = 'refunded' then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  update public.refunds
    set status = 'completed', approved_by = p_approver_id,
        provider_reference = coalesce(p_provider_reference, provider_reference),
        decided_at = now(), updated_at = now()
    where id = p_refund_id;

  perform public.post_ledger_transaction(
    v_order.buyer_id, v_refund.amount_tzs, 'refund',
    'refund:' || v_refund.id::text, v_order.id);

  update public.escrow_transactions
    set status = 'refunded', refunded_at = now(), updated_at = now()
    where id = v_escrow.id;

  update public.orders
    set status = 'refunded', updated_at = now()
    where id = v_order.id and status in ('in_escrow', 'delivered', 'disputed');

  insert into public.activity_events (user_id, kind, order_id, payload)
  values
    (v_order.buyer_id, 'order_refunded', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'amount', v_refund.amount_tzs)),
    (v_order.seller_id, 'order_refunded', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'amount', v_refund.amount_tzs));

  return jsonb_build_object('ok', true, 'refund_id', p_refund_id, 'amount_tzs', v_refund.amount_tzs);
end;
$$;
revoke all on function public.approve_refund(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_refund(uuid, uuid, text) to service_role;

/* ========================================================================== *
 * 8. SELLER PAYOUTS
 * ========================================================================== */

/* Request a payout of the seller's available balance. The amount is checked
   against the ledger, never taken from a client-supplied balance. */
create or replace function public.request_seller_payout(
  p_seller_id uuid,
  p_amount_tzs bigint,
  p_method text,
  p_destination text,
  p_requested_by uuid default null,
  p_idempotency_key text default null
)
returns public.payout_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout public.payout_requests%rowtype;
  v_available bigint;
  v_key text;
begin
  if p_amount_tzs is null or p_amount_tzs <= 0 then
    raise exception 'A positive amount is required' using errcode = 'P0001';
  end if;

  v_available := public.wallet_available_balance(p_seller_id);
  if p_amount_tzs > v_available then
    raise exception 'Requested amount exceeds the available balance' using errcode = 'P0001';
  end if;

  v_key := coalesce(p_idempotency_key,
    'payout:' || p_seller_id::text || ':' || p_amount_tzs::text || ':' || (extract(epoch from clock_timestamp())::bigint / 60)::text);

  insert into public.payout_requests
    (seller_id, requested_by, amount_tzs, method, destination, idempotency_key)
  values
    (p_seller_id, coalesce(p_requested_by, p_seller_id), p_amount_tzs,
     nullif(btrim(coalesce(p_method, '')), ''), nullif(btrim(coalesce(p_destination, '')), ''), v_key)
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_payout;

  insert into public.activity_events (user_id, kind, payload)
  values (p_seller_id, 'payout_requested',
    jsonb_build_object('amount', p_amount_tzs, 'payout_id', v_payout.id));

  return v_payout;
end;
$$;
revoke all on function public.request_seller_payout(uuid, bigint, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_seller_payout(uuid, bigint, text, text, uuid, text) to service_role;

/* Approve a payout: the money leaves the seller's ledger. */
create or replace function public.approve_payout(
  p_payout_id uuid,
  p_approver_id uuid,
  p_provider_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout public.payout_requests%rowtype;
begin
  select p.* into v_payout from public.payout_requests p where p.id = p_payout_id for update;
  if not found then
    raise exception 'Payout not found' using errcode = 'P0002';
  end if;
  if v_payout.status not in ('requested', 'approved') then
    raise exception 'This payout is not awaiting a decision' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_approver_id and r.role = 'admin'
  ) then
    raise exception 'Only an admin may approve a payout' using errcode = '42501';
  end if;

  if v_payout.amount_tzs > public.wallet_available_balance(v_payout.seller_id) then
    raise exception 'Available balance no longer covers this payout' using errcode = 'P0001';
  end if;

  update public.payout_requests
    set status = 'completed', approved_by = p_approver_id,
        provider_reference = coalesce(p_provider_reference, provider_reference),
        decided_at = now(), updated_at = now()
    where id = p_payout_id;

  perform public.post_ledger_transaction(
    v_payout.seller_id, -v_payout.amount_tzs, 'withdrawal',
    'payout:' || v_payout.id::text);

  if v_payout.fee_tzs > 0 then
    perform public.post_ledger_transaction(
      v_payout.seller_id, -v_payout.fee_tzs, 'fee',
      'payout-fee:' || v_payout.id::text);
    insert into public.platform_fees (user_id, fee_type, amount_tzs)
    values (v_payout.seller_id, 'payout_fee', v_payout.fee_tzs);
  end if;

  return jsonb_build_object('ok', true, 'payout_id', p_payout_id, 'amount_tzs', v_payout.amount_tzs);
end;
$$;
revoke all on function public.approve_payout(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_payout(uuid, uuid, text) to service_role;

/* ========================================================================== *
 * 9. CONTROLLED ADJUSTMENTS
 * ========================================================================== */

create or replace function public.apply_financial_adjustment(
  p_adjustment_id uuid,
  p_approver_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_adj public.financial_adjustments%rowtype;
begin
  select a.* into v_adj from public.financial_adjustments a
  where a.id = p_adjustment_id for update;

  if not found then
    raise exception 'Adjustment not found' using errcode = 'P0002';
  end if;
  if v_adj.status <> 'approved' then
    raise exception 'This adjustment is not approved' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_approver_id and r.role = 'admin'
  ) then
    raise exception 'Only an admin may apply a financial adjustment' using errcode = '42501';
  end if;

  perform public.post_ledger_transaction(
    v_adj.user_id, v_adj.amount_tzs, v_adj.entry_type,
    'adjustment:' || v_adj.id::text, v_adj.order_id);

  update public.financial_adjustments
    set status = 'applied', approved_by = p_approver_id, applied_at = now(), updated_at = now()
    where id = p_adjustment_id;

  return jsonb_build_object('ok', true, 'adjustment_id', p_adjustment_id);
end;
$$;
revoke all on function public.apply_financial_adjustment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_financial_adjustment(uuid, uuid) to service_role;

/* ========================================================================== *
 * 10. RECONCILIATION
 * ========================================================================== */

create or replace function public.reconcile_provider_settlement(
  p_provider text,
  p_provider_batch_id text,
  p_settlement_date date,
  p_gross_tzs bigint,
  p_fees_tzs bigint,
  p_net_tzs bigint,
  p_transaction_count integer,
  p_settlement_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settlement public.provider_settlements%rowtype;
  v_run public.reconciliation_runs%rowtype;
  v_internal bigint;
  v_matched integer := 0;
  v_mismatched integer := 0;
begin
  insert into public.provider_settlements
    (provider, provider_batch_id, settlement_date, gross_tzs, fees_tzs, net_tzs, transaction_count)
  values (p_provider, p_provider_batch_id, p_settlement_date, p_gross_tzs, p_fees_tzs,
          p_net_tzs, coalesce(p_transaction_count, 0))
  on conflict (provider, provider_batch_id) do update
    set gross_tzs = excluded.gross_tzs, fees_tzs = excluded.fees_tzs,
        net_tzs = excluded.net_tzs, transaction_count = excluded.transaction_count,
        updated_at = now()
  returning * into v_settlement;

  -- Internal total: money the platform believes it collected in that period.
  select coalesce(sum(i.amount_tzs), 0) into v_internal
  from public.payment_intents i
  where i.provider = p_provider and i.status = 'confirmed'
    and i.created_at >= p_settlement_date::timestamptz
    and i.created_at < (p_settlement_date + 1)::timestamptz;

  if v_internal = p_gross_tzs then
    v_matched := coalesce(p_transaction_count, 0);
  else
    v_mismatched := coalesce(p_transaction_count, 0);
  end if;

  update public.provider_settlements
    set status = case when v_internal = p_gross_tzs then 'reconciled'::public.settlement_status
                      else 'mismatched'::public.settlement_status end,
        updated_at = now()
    where id = v_settlement.id;

  insert into public.reconciliation_runs
    (provider, settlement_id, period_start, period_end,
     internal_total_tzs, provider_total_tzs, difference_tzs,
     matched_count, mismatched_count, status, finished_at)
  values
    (p_provider, v_settlement.id, p_settlement_date::timestamptz,
     (p_settlement_date + 1)::timestamptz,
     v_internal, p_gross_tzs, v_internal - p_gross_tzs,
     v_matched, v_mismatched,
     case when v_internal = p_gross_tzs then 'reconciled'::public.settlement_status
          else 'mismatched'::public.settlement_status end,
     now())
  returning * into v_run;

  return jsonb_build_object(
    'ok', true,
    'settlement_id', v_settlement.id,
    'run_id', v_run.id,
    'internal_total_tzs', v_internal,
    'provider_total_tzs', p_gross_tzs,
    'difference_tzs', v_internal - p_gross_tzs,
    'status', v_run.status
  );
end;
$$;
revoke all on function public.reconcile_provider_settlement(text, text, date, bigint, bigint, bigint, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.reconcile_provider_settlement(text, text, date, bigint, bigint, bigint, integer, uuid)
  to service_role;
