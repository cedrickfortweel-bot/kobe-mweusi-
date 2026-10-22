/* Kobe Mweusi — business functions used by the Edge Functions.
   Money movement (finalize_order) is only ever called by the payment
   provider callback once AzamPay is connected; it is revoked from
   anon/authenticated and executable by service_role only. */

/* Wallet balance: net of all ledger entries for a user. */
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

/* Seller statistics for the dashboard and the public seller page. */
create or replace function public.seller_stats(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'completed', (
      select count(*) from public.orders o
      where o.seller_id = p_user and o.status = 'completed'
    ),
    'cancelled', (
      select count(*) from public.orders o
      where o.seller_id = p_user and o.status = 'cancelled'
    ),
    'disputed', (
      select count(*) from public.orders o
      where o.seller_id = p_user and o.status = 'disputed'
    ),
    'gross', (
      select coalesce(sum(o.subtotal_tzs), 0) from public.orders o
      where o.seller_id = p_user and o.status = 'completed'
    ),
    'rating', (
      select round(avg(r.stars)::numeric, 1)
      from public.reviews r
      join public.orders o on o.id = r.order_id
      where o.seller_id = p_user
    ),
    'review_count', (
      select count(*)
      from public.reviews r
      join public.orders o on o.id = r.order_id
      where o.seller_id = p_user
    )
  );
$$;
revoke all on function public.seller_stats(uuid) from public, anon, authenticated;
grant execute on function public.seller_stats(uuid) to service_role;

/* Funds held for a participant: subtotals of orders still in escrow or disputed. */
create or replace function public.held_escrow(p_user uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(o.subtotal_tzs), 0)::bigint
  from public.orders o
  where o.status in ('in_escrow', 'delivered', 'disputed')
    and (o.buyer_id = p_user or o.seller_id = p_user);
$$;
revoke all on function public.held_escrow(uuid) from public, anon, authenticated;
grant execute on function public.held_escrow(uuid) to service_role;

/* Release escrow and complete an order. Called ONLY by the secure payment
   callback after the provider confirms the funds were captured. Never call
   this from the browser or from a preview path — money must really move first. */
create or replace function public.finalize_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_seller_fee bigint;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;
  if v_order.status <> 'in_escrow' then
    raise exception 'Order is not awaiting release';
  end if;

  v_seller_fee := round(v_order.subtotal_tzs * 0.01);

  update public.orders
    set status = 'completed', updated_at = now()
    where id = p_order_id and status = 'in_escrow';

  insert into public.wallet_ledger_entries (user_id, order_id, entry_type, amount_tzs, idempotency_key)
  values
    (v_order.seller_id, v_order.id, 'escrow_release', v_order.subtotal_tzs - v_seller_fee, 'release:' || v_order.id::text),
    (v_order.seller_id, v_order.id, 'fee', -v_seller_fee, 'seller-fee:' || v_order.id::text)
  on conflict (idempotency_key) do nothing;

  insert into public.activity_events (user_id, kind, order_id, payload)
  values
    (v_order.buyer_id, 'order_completed', v_order.id, jsonb_build_object('ref', v_order.ref)),
    (v_order.seller_id, 'order_completed', v_order.id, jsonb_build_object('ref', v_order.ref, 'net', v_order.subtotal_tzs - v_seller_fee));
end;
$$;
revoke all on function public.finalize_order(uuid) from public, anon, authenticated;
grant execute on function public.finalize_order(uuid) to service_role;

/* Cancel orders whose 24h payment window expired and put the stock back.
   Intended to be scheduled (pg_cron) every few minutes. */
create or replace function public.restore_expired_orders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select * from public.orders
    where status = 'awaiting_payment'
      and expires_at is not null
      and expires_at <= now()
  loop
    update public.orders
      set status = 'cancelled', updated_at = now()
      where id = r.id and status = 'awaiting_payment';
    if found then
      update public.products
        set stock_quantity = stock_quantity + r.quantity, updated_at = now()
        where id = r.product_id;
      insert into public.activity_events (user_id, kind, order_id, payload)
      values (r.buyer_id, 'order_cancelled', r.id,
        jsonb_build_object('ref', r.ref, 'reason', 'Payment window expired'));
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function public.restore_expired_orders() from public, anon, authenticated;
grant execute on function public.restore_expired_orders() to service_role;

/* Atomic stock reservation. The Edge Function calls this BEFORE inserting the
   order row; if the order insert fails it calls restore_stock to undo it. */
create or replace function public.reserve_stock(p_product_id uuid, p_quantity integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (p_quantity > 0) then
    raise exception 'Invalid quantity' using errcode = 'P0001';
  end if;

  update public.products
    set stock_quantity = stock_quantity - p_quantity, updated_at = now()
    where id = p_product_id
      and status = 'active'
      and stock_quantity >= p_quantity;

  if not found then
    raise exception 'OUT_OF_STOCK' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.reserve_stock(uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_stock(uuid, integer) to service_role;

/* Put reserved stock back when an order is cancelled or creation fails. */
create or replace function public.restore_stock(p_product_id uuid, p_quantity integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.products
    set stock_quantity = stock_quantity + p_quantity, updated_at = now()
    where id = p_product_id;
end;
$$;
revoke all on function public.restore_stock(uuid, integer) from public, anon, authenticated;
grant execute on function public.restore_stock(uuid, integer) to service_role;

/* Transaction PIN storage (bcrypt via pgcrypto). Only
   service_role may write or read these rows. */
create or replace function public.set_transaction_pin(p_user uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.transaction_pins (user_id, pin_hash, changed_at)
  values (p_user, extensions.crypt(p_pin, extensions.gen_salt('bf')), now())
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash, changed_at = now();
end;
$$;
revoke all on function public.set_transaction_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.set_transaction_pin(uuid, text) to service_role;

create or replace function public.verify_transaction_pin(p_user uuid, p_pin text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.transaction_pins t
    where t.user_id = p_user
      and extensions.crypt(p_pin, t.pin_hash) = t.pin_hash
  );
$$;
revoke all on function public.verify_transaction_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.verify_transaction_pin(uuid, text) to service_role;

/* Record a handoff verification for both sides of an order. */
create or replace function public.record_handoff(
  p_order_id uuid,
  p_code_type public.handoff_code_type,
  p_scanned_by uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;
  insert into public.activity_events (user_id, kind, order_id, payload)
  values
    (v_order.buyer_id, 'handoff_verified', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'code_type', p_code_type::text)),
    (v_order.seller_id, 'handoff_verified', v_order.id,
      jsonb_build_object('ref', v_order.ref, 'code_type', p_code_type::text));
end;
$$;
revoke all on function public.record_handoff(uuid, public.handoff_code_type, uuid) from public, anon, authenticated;
grant execute on function public.record_handoff(uuid, public.handoff_code_type, uuid) to service_role;
