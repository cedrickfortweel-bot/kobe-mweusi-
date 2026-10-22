/* Kobe Mweusi — wallet-funded purchases.

   THE MONEY MODEL
   ----------------
   A buyer tops up the Kobe Mweusi wallet through the payment provider
   (AzamPay). The money sits in the wallet. When the buyer buys something,
   the money moves from the wallet into escrow. It stays in escrow until
   the delivery rules release it to the seller.

       top up (AzamPay)  ->  wallet balance
       buy               ->  wallet balance  ->  escrow  ->  seller

   The provider is therefore only involved at the top-up step. A purchase
   never leaves the platform's own wallet, which is what makes the escrow
   guarantee meaningful: the money is already here when the buyer commits.

   This migration also fixes two defects in the earlier financial module:

   1. wallet_available_balance() EXCLUDED 'order_funding' entries from the
      sum. Because 'order_funding' is a DEBIT, excluding it made the
      available balance LARGER than the real balance, so a buyer could
      have spent money that was already committed to escrow. The available
      balance is now the same as the wallet balance.

   2. place_funds_in_escrow() credited the buyer fee back to the buyer.
      The buyer is charged subtotal + buyer_fee, so crediting the fee back
      meant the net charge was only the subtotal and the platform fee
      vanished. The fee is now platform revenue, recorded in
      platform_fees, and is no longer credited back.

   Functions changed here
     create_payment_intent()      now also creates a wallet top-up intent
     record_verified_payment()    now also credits a wallet top-up
     record_wallet_topup()        new
     place_funds_in_escrow()      now checks the wallet balance and locks
     wallet_available_balance()   fixed
     held_escrow()                now derived from escrow_transactions
     wallet_topup_allowed()       new
*/

begin;

/* The earlier definitions of these two functions have different
   signatures. CREATE OR REPLACE cannot change a parameter list, so the
   old ones are dropped first. Leaving them behind would create silent
   overloads with confusing behaviour. */
drop function if exists public.record_verified_payment(text, text, text, bigint, uuid, uuid, jsonb);
drop function if exists public.place_funds_in_escrow(uuid, uuid);

/* An order is now funded from the wallet rather than from a per-order
   provider payment, so the order carries its own idempotency key. The
   key is what makes a double tap, a retry or a refresh produce one
   order instead of two. */
alter table public.orders
  add column if not exists idempotency_key text;

create unique index if not exists orders_idempotency_key_idx
  on public.orders (idempotency_key)
  where idempotency_key is not null;

/* ========================================================================== *
 * 1. WALLET TOP-UP
 * ========================================================================== */

/* Is this buyer allowed to top up right now? */
create or replace function public.wallet_topup_allowed(p_buyer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restriction text := public.active_restriction(p_buyer);
begin
  if not public.is_account_active(p_buyer) then
    return jsonb_build_object('ok', false, 'reason', 'account_inactive');
  end if;
  if v_restriction in ('transacting', 'withdrawing', 'full') then
    return jsonb_build_object('ok', false, 'reason', 'restricted');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.wallet_topup_allowed(uuid) from public, anon;
grant execute on function public.wallet_topup_allowed(uuid) to service_role, authenticated;

/* Credit a confirmed top-up to the buyer's wallet.

   Idempotent on the provider event id: a replayed callback cannot credit
   the buyer twice. The ledger key is derived from the provider event id
   as well, so even a hand-made duplicate row cannot double-credit. */
create or replace function public.record_wallet_topup(
  p_provider text,
  p_provider_event_id text,
  p_provider_reference text,
  p_amount_tzs bigint,
  p_buyer_id uuid,
  p_raw_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.payment_provider_events%rowtype;
  v_duplicate boolean := false;
  v_balance bigint;
begin
  if p_amount_tzs is null or p_amount_tzs <= 0 then
    raise exception 'A positive amount is required' using errcode = 'P0001';
  end if;
  if p_buyer_id is null then
    raise exception 'A buyer is required' using errcode = 'P0001';
  end if;
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
      (p_provider, p_provider_event_id, 'wallet.topup', null, null,
       p_amount_tzs, true, coalesce(p_raw_payload, '{}'::jsonb), now())
    returning * into v_event;
  end if;

  -- One top-up per provider event, enforced by the ledger key.
  perform public.post_ledger_transaction(
    p_buyer_id, p_amount_tzs, 'top_up',
    'topup:' || p_provider || ':' || p_provider_event_id, null, null);

  v_balance := public.wallet_balance(p_buyer_id);

  if not v_duplicate then
    insert into public.activity_events (user_id, kind, payload)
    values (p_buyer_id, 'wallet_topped_up',
      jsonb_build_object('amount', p_amount_tzs, 'balance', v_balance,
        'reference', p_provider_reference));
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'buyer_id', p_buyer_id,
    'amount_tzs', p_amount_tzs,
    'balance_tzs', v_balance);
end;
$$;
revoke all on function public.record_wallet_topup(text, text, text, bigint, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_wallet_topup(text, text, text, bigint, uuid, jsonb)
  to service_role;

/* ========================================================================== *
 * 2. PAYMENT INTENTS: TOP-UP OR ORDER
 * ========================================================================== */

/* A payment intent now serves two purposes:
     order_id set   -> paying for an order
     order_id null  -> topping up the wallet
   Both are recorded in payment_intents, so the wallet screen can show
   pending top-ups alongside pending order payments. */
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
  v_allowed jsonb;
begin
  if p_amount_tzs is null or p_amount_tzs <= 0 then
    raise exception 'A positive amount is required' using errcode = 'P0001';
  end if;

  if p_order_id is null then
    -- Wallet top-up.
    v_allowed := public.wallet_topup_allowed(p_buyer_id);
    if not (v_allowed ->> 'ok')::boolean then
      raise exception 'This account cannot top up right now'
        using errcode = '42501';
    end if;
  else
    -- Payment for an order.
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

/* Record a confirmed capture. A capture with no order is a wallet
   top-up; a capture with an order funds that order's escrow. */
create or replace function public.record_verified_payment(
  p_provider text,
  p_provider_event_id text,
  p_provider_reference text,
  p_amount_tzs bigint,
  p_order_id uuid,
  p_buyer_id uuid,
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
  v_result jsonb;
begin
  if p_provider_event_id is null or btrim(p_provider_event_id) = '' then
    raise exception 'A provider event id is required' using errcode = 'P0001';
  end if;

  -- A capture with no order is a wallet top-up.
  if p_order_id is null then
    if p_buyer_id is null then
      raise exception 'A buyer is required for a top-up' using errcode = 'P0001';
    end if;
    return public.record_wallet_topup(
      p_provider, p_provider_event_id, p_provider_reference,
      p_amount_tzs, p_buyer_id, p_raw_payload);
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

  v_escrow := public.place_funds_in_escrow(p_order_id, p_payment_intent_id, 'external');

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'order_id', p_order_id,
    'escrow_status', v_escrow.status,
    'amount_tzs', v_escrow.amount_tzs);
end;
$$;
revoke all on function public.record_verified_payment(text, text, text, bigint, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_verified_payment(text, text, text, bigint, uuid, uuid, uuid, jsonb)
  to service_role;

/* ========================================================================== *
 * 3. FUNDING ESCROW FROM THE WALLET
 * ========================================================================== */

/* Move the money from the buyer's wallet into escrow.

   p_funding_source:
     'wallet'    the buyer's wallet balance is debited. The balance is
                 checked first, under an advisory lock so two concurrent
                 purchases cannot both pass the check and overdraw the
                 wallet.
     'external'  the money was captured straight from the provider for
                 this order, so there is no wallet debit. */
create or replace function public.place_funds_in_escrow(
  p_order_id uuid,
  p_payment_intent_id uuid default null,
  p_funding_source text default 'wallet'
)
returns public.escrow_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_escrow public.escrow_transactions%rowtype;
  v_available bigint;
  v_source text := coalesce(p_funding_source, 'wallet');
begin
  if v_source not in ('wallet', 'external') then
    raise exception 'Unknown funding source' using errcode = 'P0001';
  end if;

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

  if v_source = 'wallet' then
    -- Serialise purchases per buyer so the balance check and the debit
    -- cannot interleave with another purchase from the same wallet.
    perform pg_advisory_xact_lock(hashtextextended(v_order.buyer_id::text, 0));

    v_available := public.wallet_available_balance(v_order.buyer_id);
    if v_available < v_order.total_due_tzs then
      raise exception 'INSUFFICIENT_WALLET_BALANCE' using
        errcode = 'P0001',
        detail = jsonb_build_object(
          'balance_tzs', v_available,
          'required_tzs', v_order.total_due_tzs,
          'shortfall_tzs', v_order.total_due_tzs - v_available)::text;
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

  if v_source = 'wallet' then
    -- Debit the buyer exactly once.
    perform public.post_ledger_transaction(
      v_order.buyer_id,
      -v_order.total_due_tzs,
      'order_funding',
      'escrow-fund:' || v_order.id::text,
      v_order.id,
      p_payment_intent_id);

    -- The buyer fee is platform revenue, not the buyer's money. It is
    -- recorded in platform_fees and is NOT credited back to the buyer.
    if v_order.buyer_fee_tzs > 0 then
      insert into public.platform_fees (order_id, user_id, fee_type, amount_tzs)
      values (v_order.id, v_order.buyer_id, 'buyer_fee', v_order.buyer_fee_tzs)
      on conflict do nothing;
    end if;
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
revoke all on function public.place_funds_in_escrow(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.place_funds_in_escrow(uuid, uuid, text) to service_role;

/* Request a wallet top-up. The provider capture that follows is what
   actually credits the wallet; this only creates the intent. */
create or replace function public.request_wallet_topup(
  p_buyer_id uuid,
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
  v_allowed jsonb;
begin
  if p_amount_tzs is null or p_amount_tzs <= 0 then
    raise exception 'A positive amount is required' using errcode = 'P0001';
  end if;
  if p_amount_tzs > 100000000 then
    raise exception 'A single top-up cannot exceed 100,000,000 TZS' using errcode = 'P0001';
  end if;

  v_allowed := public.wallet_topup_allowed(p_buyer_id);
  if not (v_allowed ->> 'ok')::boolean then
    raise exception 'This account cannot top up right now' using errcode = '42501';
  end if;

  insert into public.payment_intents
    (buyer_id, order_id, provider, amount_tzs, status, idempotency_key)
  values
    (p_buyer_id, null, p_provider, p_amount_tzs, 'pending', p_idempotency_key)
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_intent;

  return v_intent;
end;
$$;
revoke all on function public.request_wallet_topup(uuid, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.request_wallet_topup(uuid, bigint, text, text) to service_role;

/* ========================================================================== *
 * 4. BALANCES
 * ========================================================================== */
/* The spendable balance.

   Every ledger entry is a real movement of the buyer's own money, so the
   spendable balance is the sum of all of them. Money that has already
   been committed to escrow left the wallet when the order was created
   and is tracked separately by held_escrow().

   The previous version excluded 'order_funding' entries from the sum.
   Because that entry is a DEBIT, excluding it made the available balance
   larger than the real balance and allowed the buyer to spend money that
   was already in escrow. */
create or replace function public.wallet_available_balance(p_user uuid)
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
revoke all on function public.wallet_available_balance(uuid) from public, anon, authenticated;
grant execute on function public.wallet_available_balance(uuid) to service_role;

/* Money the platform is currently holding in escrow, derived from the
   escrow ledger rather than from the order list, so a split or a partial
   refund is counted correctly. */
create or replace function public.held_escrow(p_user uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(t.amount_tzs), 0)::bigint
  from public.escrow_transactions t
  where t.status in ('funded', 'held', 'release_pending')
    and (t.buyer_id = p_user or t.seller_id = p_user);
$$;
revoke all on function public.held_escrow(uuid) from public, anon, authenticated;
grant execute on function public.held_escrow(uuid) to service_role;

/* Can this buyer afford this order right now? */
create or replace function public.can_afford_order(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_available bigint;
begin
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'order_not_found');
  end if;

  v_available := public.wallet_available_balance(v_order.buyer_id);

  return jsonb_build_object(
    'ok', v_available >= v_order.total_due_tzs,
    'balance_tzs', v_available,
    'required_tzs', v_order.total_due_tzs,
    'shortfall_tzs', greatest(0, v_order.total_due_tzs - v_available));
end;
$$;
revoke all on function public.can_afford_order(uuid) from public, anon, authenticated;
grant execute on function public.can_afford_order(uuid) to service_role;

commit;
