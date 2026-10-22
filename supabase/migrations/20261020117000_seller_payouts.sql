/* Kobe Mweusi — seller payouts.

   A seller withdraws money that has ALREADY been released from escrow.

   The rule is enforced by the ledger, not by the app: the seller's
   ledger is credited only inside release_escrow(), so money that is
   still held in escrow has never entered the seller's balance.
   wallet_available_balance() is therefore exactly the money that has
   been released and is free to withdraw, and request_seller_payout()
   refuses anything above it.

   This migration adds the two gaps that stopped a withdrawal being
   requested at all:

     * a second request for the same money was possible. Two requests
       could each pass the balance check and together exceed the
       balance. There is now one outstanding request per seller.
     * nobody could see the requests, so neither the seller nor staff
       could tell what was waiting.

   Functions added here
     list_my_payout_requests()   the seller's own requests
     list_pending_payout_requests()  the staff queue
*/

begin;

/* ========================================================================== *
 * 1. ONE OUTSTANDING REQUEST PER SELLER
 * ========================================================================== */

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
  v_fee bigint;
  v_outstanding uuid;
begin
  if p_amount_tzs is null or p_amount_tzs <= 0 then
    raise exception 'A positive amount is required' using errcode = 'P0001';
  end if;

  -- Only money that has already been released from escrow counts. The
  -- ledger holds a seller's money only after release_escrow() has run.
  v_available := public.wallet_available_balance(p_seller_id);
  if p_amount_tzs > v_available then
    raise exception 'Requested amount exceeds the available balance' using errcode = 'P0001';
  end if;

  -- One live request at a time, so the same balance cannot be promised
  -- twice while the first one is still waiting.
  select pr.id into v_outstanding
  from public.payout_requests pr
  where pr.seller_id = p_seller_id
    and pr.status in ('requested', 'approved', 'processing')
  order by pr.created_at
  limit 1;

  if v_outstanding is not null then
    raise exception 'You already have a withdrawal waiting to be paid' using errcode = 'P0001';
  end if;

  v_key := coalesce(p_idempotency_key,
    'payout:' || p_seller_id::text || ':' || p_amount_tzs::text || ':' || (extract(epoch from clock_timestamp())::bigint / 60)::text);

  /* The fee is a share of the gross amount, computed here so the client
     cannot set it. The seller enters the amount that leaves the wallet;
     the fee is part of it, and the seller receives the remainder. */
  v_fee := round(p_amount_tzs * 0.01);

  insert into public.payout_requests
    (seller_id, requested_by, amount_tzs, fee_tzs, method, destination, idempotency_key)
  values
    (p_seller_id, coalesce(p_requested_by, p_seller_id), p_amount_tzs, v_fee,
     nullif(btrim(coalesce(p_method, '')), ''), nullif(btrim(coalesce(p_destination, '')), ''), v_key)
  on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_payout;

  insert into public.activity_events (user_id, kind, payload)
  values (p_seller_id, 'payout_requested',
    jsonb_build_object('amount', p_amount_tzs, 'fee', v_fee, 'payout_id', v_payout.id));

  return v_payout;
end;
$$;
revoke all on function public.request_seller_payout(uuid, bigint, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_seller_payout(uuid, bigint, text, text, uuid, text) to service_role;

/* ========================================================================== *
 * 2. APPROVING A PAYOUT
 *
   The seller is debited the gross amount, once. The fee is a share of
   that same amount, so it is recorded as platform revenue rather than
   debited a second time. Debiting amount + fee would have taken more
   from the seller than the balance check approved.
 * ========================================================================== */

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
  v_net bigint;
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

  /* One debit for the whole amount that leaves the wallet. */
  perform public.post_ledger_transaction(
    v_payout.seller_id, -v_payout.amount_tzs, 'withdrawal',
    'payout:' || v_payout.id::text);

  if v_payout.fee_tzs > 0 then
    insert into public.platform_fees (user_id, fee_type, amount_tzs)
    values (v_payout.seller_id, 'payout_fee', v_payout.fee_tzs);
  end if;

  v_net := v_payout.amount_tzs - coalesce(v_payout.fee_tzs, 0);

  insert into public.activity_events (user_id, kind, payload)
  values (v_payout.seller_id, 'payout_requested',
    jsonb_build_object('title', 'Payout sent', 'amount', v_net, 'payout_id', v_payout.id));

  return jsonb_build_object(
    'ok', true,
    'payout_id', p_payout_id,
    'amount_tzs', v_payout.amount_tzs,
    'fee_tzs', v_payout.fee_tzs,
    'net_tzs', v_net);
end;
$$;
revoke all on function public.approve_payout(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_payout(uuid, uuid, text) to service_role;

/* ========================================================================== *
 * 2. READING THE REQUESTS
 * ========================================================================== */

/* The seller's own requests, newest first. */
create or replace function public.list_my_payout_requests(p_seller uuid)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', pr.id,
    'amount_tzs', pr.amount_tzs,
    'fee_tzs', pr.fee_tzs,
    'method', pr.method,
    'destination', pr.destination,
    'status', pr.status,
    'requested_at', pr.created_at,
    'decided_at', pr.decided_at,
    'provider_reference', pr.provider_reference
  )
  from public.payout_requests pr
  where pr.seller_id = p_seller
  order by pr.created_at desc
  limit 50;
$$;
revoke all on function public.list_my_payout_requests(uuid) from public, anon, authenticated;
grant execute on function public.list_my_payout_requests(uuid) to service_role;

/* The staff queue. A payout that is high risk can be requested, then
   approved by a different person; the list makes that visible. */
create or replace function public.list_pending_payout_requests()
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', pr.id,
    'seller_id', pr.seller_id,
    'shop_name', s.shop_name,
    'kobe_id', s.kobe_id,
    'amount_tzs', pr.amount_tzs,
    'method', pr.method,
    'destination', pr.destination,
    'status', pr.status,
    'requested_at', pr.created_at,
    'requested_by', pr.requested_by,
    'seller_balance_tzs', public.wallet_available_balance(pr.seller_id)
  )
  from public.payout_requests pr
  left join public.seller_profiles s on s.user_id = pr.seller_id
  where pr.status in ('requested', 'approved', 'processing')
  order by pr.created_at
  limit 100;
$$;
revoke all on function public.list_pending_payout_requests() from public, anon, authenticated;
grant execute on function public.list_pending_payout_requests() to service_role;

/* The money a seller may withdraw right now, and what is still held.
   The two are different numbers and the app must not mix them up.

   held_tzs is what the seller will actually receive if every escrow
   completes, not the gross the buyer paid: the buyer's fee is platform
   revenue, and the seller's own fee is deducted on release. The gross
   is amount_tzs - buyer_fee_tzs. */
create or replace function public.seller_payout_capacity(p_seller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'available_tzs', public.wallet_available_balance(p_seller),
    'held_tzs', coalesce((
      select sum(t.amount_tzs - t.buyer_fee_tzs
                  - round((t.amount_tzs - t.buyer_fee_tzs) * 0.01))
      from public.escrow_transactions t
      where t.seller_id = p_seller
        and t.status in ('funded', 'held', 'release_pending')
    ), 0),
    'held_gross_tzs', coalesce((
      select sum(t.amount_tzs) from public.escrow_transactions t
      where t.seller_id = p_seller
        and t.status in ('funded', 'held', 'release_pending')
    ), 0),
    'pending_tzs', coalesce((
      select sum(pr.amount_tzs) from public.payout_requests pr
      where pr.seller_id = p_seller
        and pr.status in ('requested', 'approved', 'processing')
    ), 0),
    'outstanding_request', (
      select pr.id from public.payout_requests pr
      where pr.seller_id = p_seller
        and pr.status in ('requested', 'approved', 'processing')
      order by pr.created_at limit 1
    )
  );
$$;
revoke all on function public.seller_payout_capacity(uuid) from public, anon, authenticated;
grant execute on function public.seller_payout_capacity(uuid) to service_role;

commit;
