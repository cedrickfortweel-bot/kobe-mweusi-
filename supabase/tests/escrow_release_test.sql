/* Kobe Mweusi — escrow release rule tests.

   Exercises the outcome table in docs/escrow-release-rules.md against a
   real database.

   Run after `supabase db reset`:
     psql "$SUPABASE_DB_URL" -f supabase/tests/escrow_release_test.sql

   The test creates its own users, orders and escrow rows, asserts the
   expected outcome for each rule, and rolls back at the end so the
   database is left exactly as it was found.
*/

begin;

set local search_path = public;

/* ------------------------------------------------------------------ setup */

do $$
declare
  v_buyer uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_seller uuid := 'aaaaaaaa-0000-4000-8000-000000000002';
  v_agent uuid := 'aaaaaaaa-0000-4000-8000-000000000003';
  v_admin uuid := 'aaaaaaaa-0000-4000-8000-000000000004';
  v_password text := crypt('test-password', gen_salt('bf'));
  v_product uuid;
begin
  insert into auth.users
    (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    (v_buyer, 't-buyer@kobe.test', v_password, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"account_type":"buyer"}'),
    (v_seller, 't-seller@kobe.test', v_password, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"account_type":"seller"}'),
    (v_agent, 't-agent@kobe.test', v_password, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"account_type":"buyer"}'),
    (v_admin, 't-admin@kobe.test', v_password, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"account_type":"seller"}')
  on conflict (id) do nothing;

  /* Staff cannot approve a payout without the admin role. */
  insert into public.internal_user_roles (user_id, role)
  values (v_admin, 'admin')
  on conflict (user_id, role) do nothing;

  insert into public.seller_profiles (user_id, shop_name, shop_slug)
  values (v_seller, 'Test Shop', 'test-shop')
  on conflict (user_id) do nothing;

  update public.seller_profiles set verification_status = 'verified' where user_id = v_seller;

  insert into public.delivery_agents (user_id, verification_status)
  values (v_agent, 'verified')
  on conflict (user_id) do update set verification_status = 'verified';

  insert into public.products (seller_id, name, price_tzs, stock_quantity, status)
  values (v_seller, 'Test product', 10000, 10, 'active')
  on conflict do nothing;

  select id into v_product from public.products
    where seller_id = v_seller and name = 'Test product' limit 1;
end
$$;

/* Top the buyer up so the wallet can fund the test orders. */
do $$
declare
  v_buyer uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
begin
  perform public.record_wallet_topup(
    'azampay', 'test-topup-' || v_buyer::text, 'TEST-TOPUP-1',
    10000000, v_buyer, '{}'::jsonb);
end
$$;

/* Build a funded order in escrow. */
create or replace function pg_temp.make_order(p_buyer uuid, p_seller uuid, p_ref text)
returns uuid
language plpgsql
as $$
declare
  v_order uuid;
  v_intent uuid;
begin
  insert into public.orders
    (buyer_id, seller_id, item_name, quantity, unit_price_tzs, subtotal_tzs,
     buyer_fee_tzs, total_due_tzs, status, ref, expires_at)
  values
    (p_buyer, p_seller, 'Test product', 1, 10000, 10000, 100, 10100,
     'awaiting_payment', p_ref, now() + interval '24 hours')
  returning id into v_order;

  insert into public.payment_intents
    (buyer_id, order_id, provider, amount_tzs, status, idempotency_key)
  values (p_buyer, v_order, 'azampay', 10100, 'confirmed', 'test-intent:' || p_ref)
  returning id into v_intent;

  -- The order is paid for from the buyer's wallet.
  perform public.place_funds_in_escrow(v_order, v_intent, 'wallet');

  insert into public.order_delivery_workflows (order_id, delivery_mode, stage)
  values (v_order, 'direct', 'not_started')
  on conflict (order_id) do nothing;

  return v_order;
end;
$$;

/* Issue a pair of handoff codes and return the two raw token hashes. */
create or replace function pg_temp.issue_codes(p_order uuid)
returns table (seller_hash text, buyer_hash text)
language plpgsql
as $$
begin
  seller_hash := 'hash-seller-' || p_order::text;
  buyer_hash := 'hash-buyer-' || p_order::text;

  perform public.issue_handoff_codes(
    p_order, seller_hash, buyer_hash, now() + interval '15 minutes');
end;
$$;

do $$
declare
  v_buyer uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  v_seller uuid := 'aaaaaaaa-0000-4000-8000-000000000002';
  v_agent uuid := 'aaaaaaaa-0000-4000-8000-000000000003';
  v_order uuid;
  v_codes record;
  v_decision jsonb;
  v_result jsonb;
  v_failures integer := 0;
  v_checks integer := 0;
begin
  /* ================================================================== */
  /* Rule 5: nothing has happened yet -> not eligible                  */
  /* ================================================================== */
  v_order := pg_temp.make_order(v_buyer, v_seller, 'KM-T001');
  v_decision := public.evaluate_escrow_release(v_order);
  v_checks := v_checks + 1;
  if (v_decision ->> 'eligible')::boolean then
    raise exception 'FAIL rule 5: expected not eligible before any scan';
  end if;
  if v_decision ->> 'reason' <> 'no_handoff_recorded' then
    raise exception 'FAIL rule 5: expected no_handoff_recorded, got %', v_decision ->> 'reason';
  end if;

  /* ================================================================== */
  /* Rule 2: the seller scans the BUYER's code -> instant release       */
  /* ================================================================== */
  select * into v_codes from pg_temp.issue_codes(v_order);
  v_result := public.record_handoff_scan(v_codes.buyer_hash, v_seller, null);
  v_checks := v_checks + 1;
  if v_result ->> 'role' <> 'seller' then
    raise exception 'FAIL rule 2: expected the seller role, got %', v_result ->> 'role';
  end if;
  v_checks := v_checks + 1;
  if (v_result ->> 'released')::boolean is not true then
    raise exception 'FAIL rule 2: scanning the buyer''s code must release at once';
  end if;

  v_decision := public.evaluate_escrow_release(v_order);
  v_checks := v_checks + 1;
  if v_decision ->> 'reason' <> 'already_released' then
    raise exception 'FAIL rule 2: expected already_released, got %', v_decision ->> 'reason';
  end if;

  v_checks := v_checks + 1;
  if not exists (
    select 1 from public.orders o
    where o.id = v_order and o.status = 'completed'
  ) then
    raise exception 'FAIL rule 2: the order should be completed';
  end if;

  v_checks := v_checks + 1;
  if public.wallet_balance(v_seller) <> 9900 then
    raise exception 'FAIL rule 2: the seller should hold 9900 after the 1%% fee, got %',
      public.wallet_balance(v_seller);
  end if;

  /* Releasing twice must not pay the seller twice. */
  v_result := public.release_escrow_funds(v_order, 'test: replay');
  v_checks := v_checks + 1;
  if public.wallet_balance(v_seller) <> 9900 then
    raise exception 'FAIL rule 2: a replayed release paid the seller twice';
  end if;

  /* ================================================================== */
  /* Rule 2b: an AGENT scans the buyer's code -> instant release too    */
  /* ================================================================== */
  v_order := pg_temp.make_order(v_buyer, v_seller, 'KM-T002');
  insert into public.delivery_assignments (order_id, agent_user_id, status)
  values (v_order, v_agent, 'assigned')
  on conflict do nothing;

  select * into v_codes from pg_temp.issue_codes(v_order);
  v_result := public.record_handoff_scan(v_codes.buyer_hash, v_agent, null);
  v_checks := v_checks + 1;
  if v_result ->> 'role' <> 'agent' then
    raise exception 'FAIL rule 2b: expected the agent role, got %', v_result ->> 'role';
  end if;
  v_checks := v_checks + 1;
  if (v_result ->> 'released')::boolean is not true then
    raise exception 'FAIL rule 2b: an agent scanning the buyer''s code must release at once';
  end if;
  v_checks := v_checks + 1;
  if not exists (
    select 1 from public.orders o
    where o.id = v_order and o.status = 'completed'
  ) then
    raise exception 'FAIL rule 2b: the order should be completed';
  end if;

  /* ================================================================== */
  /* Rule 2c: with agent_scan_can_release switched off, an agent scan    */
  /* records the handover but does not move the money                     */
  /* ================================================================== */
  v_order := pg_temp.make_order(v_buyer, v_seller, 'KM-T002B');
  insert into public.delivery_assignments (order_id, agent_user_id, status)
  values (v_order, v_agent, 'assigned')
  on conflict do nothing;

  declare
    v_policy jsonb;
  begin
    select value into v_policy from public.app_settings where key = 'escrow_policy';

    update public.app_settings
      set value = coalesce(value, '{}'::jsonb) || jsonb_build_object('agent_scan_can_release', false)
      where key = 'escrow_policy';

    select * into v_codes from pg_temp.issue_codes(v_order);
    v_result := public.record_handoff_scan(v_codes.buyer_hash, v_agent, null);
    v_checks := v_checks + 1;
    if v_result ->> 'role' <> 'agent' then
      raise exception 'FAIL rule 2c: expected the agent role, got %', v_result ->> 'role';
    end if;
    v_checks := v_checks + 1;
    if (v_result ->> 'released')::boolean is not false then
      raise exception 'FAIL rule 2c: an agent scan must not release while the switch is off';
    end if;

    v_decision := public.evaluate_escrow_release(v_order);
    v_checks := v_checks + 1;
    if (v_decision ->> 'eligible')::boolean then
      raise exception 'FAIL rule 2c: the escrow must still be held';
    end if;
    v_checks := v_checks + 1;
    if v_decision ->> 'reason' <> 'agent_release_disabled' then
      raise exception 'FAIL rule 2c: expected agent_release_disabled, got %', v_decision ->> 'reason';
    end if;

    /* The handover is still recorded, so the audit trail is complete. */
    v_checks := v_checks + 1;
    if not exists (
      select 1 from public.handoff_events e
      where e.order_id = v_order and e.scanned_by = v_agent
    ) then
      raise exception 'FAIL rule 2c: the agent scan was not recorded';
    end if;

    update public.app_settings set value = v_policy where key = 'escrow_policy';
  end;

  /* ================================================================== */
  /* Rule 3: the buyer scans the SELLER's code -> three-hour window      */
  /* ================================================================== */
  v_order := pg_temp.make_order(v_buyer, v_seller, 'KM-T003');
  select * into v_codes from pg_temp.issue_codes(v_order);
  v_result := public.record_handoff_scan(v_codes.seller_hash, v_buyer, null);

  v_checks := v_checks + 1;
  if v_result ->> 'release_scheduled_for' is null then
    raise exception 'FAIL rule 3: the buyer scan did not open a release window';
  end if;

  v_decision := public.evaluate_escrow_release(v_order);
  v_checks := v_checks + 1;
  if (v_decision ->> 'eligible')::boolean then
    raise exception 'FAIL rule 3: the window must not be eligible yet';
  end if;
  if v_decision ->> 'reason' <> 'waiting_for_window' then
    raise exception 'FAIL rule 3: expected waiting_for_window, got %', v_decision ->> 'reason';
  end if;

  /* The window is three hours, not less. */
  v_checks := v_checks + 1;
  if (v_decision ->> 'window_minutes')::int <> 180 then
    raise exception 'FAIL rule 3: expected a 180 minute window, got %', v_decision ->> 'window_minutes';
  end if;

  /* Move the scheduled time into the past, as the clock would. */
  update public.order_delivery_workflows
    set release_scheduled_for = now() - interval '1 minute'
    where order_id = v_order;

  v_decision := public.evaluate_escrow_release(v_order);
  v_checks := v_checks + 1;
  if not (v_decision ->> 'eligible')::boolean then
    raise exception 'FAIL rule 3: an elapsed window must be eligible, reason was %', v_decision ->> 'reason';
  end if;
  if v_decision ->> 'reason' <> 'window_elapsed' then
    raise exception 'FAIL rule 3: expected window_elapsed, got %', v_decision ->> 'reason';
  end if;

  /* The scheduled job releases it. */
  v_result := public.process_due_escrow_releases(50);
  v_checks := v_checks + 1;
  if not exists (
    select 1 from public.orders o where o.id = v_order and o.status = 'completed'
  ) then
    raise exception 'FAIL rule 3: the scheduled job did not release the escrow';
  end if;

  /* ================================================================== */
  /* Rule 1: the buyer confirms receipt -> immediate release             */
  /* ================================================================== */
  v_order := pg_temp.make_order(v_buyer, v_seller, 'KM-T004');
  v_decision := public.evaluate_escrow_release(v_order);
  v_checks := v_checks + 1;
  if (v_decision ->> 'eligible')::boolean then
    raise exception 'FAIL rule 1: an unconfirmed order must not be eligible';
  end if;

  -- confirm_receipt is security definer and reads auth.uid(), so the
  -- decision path is exercised directly through the workflow row.
  update public.order_delivery_workflows
    set buyer_confirmed_at = now()
    where order_id = v_order;

  v_decision := public.evaluate_escrow_release(v_order);
  v_checks := v_checks + 1;
  if not (v_decision ->> 'eligible')::boolean then
    raise exception 'FAIL rule 1: a confirmed receipt must be eligible';
  end if;
  if v_decision ->> 'reason' <> 'buyer_confirmed' then
    raise exception 'FAIL rule 1: expected buyer_confirmed, got %', v_decision ->> 'reason';
  end if;

  /* ================================================================== */
  /* Rule 5: an open dispute freezes the escrow                         */
  /* ================================================================== */
  v_order := pg_temp.make_order(v_buyer, v_seller, 'KM-T005'004');
  select * into v_codes from pg_temp.issue_codes(v_order);
  perform public.record_handoff_scan(v_codes.seller_hash, v_buyer, null);
  perform public.record_handoff_scan(v_codes.buyer_hash, v_seller, null);

  -- Opening a dispute holds the escrow and freezes the order.
  perform public.open_dispute(v_order, 'item not as described',
    'The item arrived damaged and does not match the description in the listing.', v_buyer);

  v_decision := public.evaluate_escrow_release(v_order);
  v_checks := v_checks + 1;
  if (v_decision ->> 'eligible')::boolean then
    raise exception 'FAIL rule 5: an open dispute must block the release';
  end if;
  if v_decision ->> 'reason' <> 'open_dispute' then
    raise exception 'FAIL rule 5: expected open_dispute, got %', v_decision ->> 'reason';
  end if;

  -- The release itself is refused too.
  v_result := public.release_escrow_funds(v_order, 'test: disputed');
  v_checks := v_checks + 1;
  if (v_result ->> 'ok')::boolean then
    raise exception 'FAIL rule 5: the release must be refused while a dispute is open';
  end if;

  /* The escrow is on hold, so the timed job skips it as well. */
  update public.order_delivery_workflows
    set release_scheduled_for = now() - interval '1 minute'
    where order_id = v_order;
  perform public.process_due_escrow_releases(50);
  v_checks := v_checks + 1;
  if not exists (
    select 1 from public.orders o where o.id = v_order and o.status = 'disputed'
  ) then
    raise exception 'FAIL rule 5: the timed job released a disputed order';
  end if;

  /* ================================================================== */
  /* The code cannot be used twice                                        */
  /* ================================================================== */
  v_order := pg_temp.make_order(v_buyer, v_seller, 'KM-T006'005');
  select * into v_codes from pg_temp.issue_codes(v_order);
  perform public.record_handoff_scan(v_codes.seller_hash, v_buyer, null);

  v_checks := v_checks + 1;
  begin
    perform public.record_handoff_scan(v_codes.seller_hash, v_buyer, null);
    raise exception 'FAIL: a handoff code was accepted twice';
  exception when others then
    if sqlerrm = 'FAIL: a handoff code was accepted twice' then
      raise;
    end if;
  end;

  /* ================================================================== */
  /* A stranger cannot scan a code                                        */
  /* ================================================================== */
  v_order := pg_temp.make_order(v_buyer, v_seller, 'KM-T007'006');
  select * into v_codes from pg_temp.issue_codes(v_order);

  v_checks := v_checks + 1;
  begin
    perform public.record_handoff_scan(v_codes.seller_hash, v_agent, null);
    raise exception 'FAIL: an unassigned agent was allowed to scan';
  exception when others then
    if sqlerrm = 'FAIL: an unassigned agent was allowed to scan' then
      raise;
    end if;
  end;

  /* ================================================================== */
  /* The ledger is append-only                                            */
  /* ================================================================== */
  v_checks := v_checks + 1;
  begin
    update public.wallet_ledger_entries set amount_tzs = amount_tzs + 1;
    raise exception 'FAIL: a ledger entry was updated';
  exception when others then
    if sqlerrm = 'FAIL: a ledger entry was updated' then
      raise;
    end if;
  end;

  /* ================================================================== */
  /* Payouts: only money that has been released can be withdrawn          */
  /* ================================================================== */
  declare
    v_seller_balance bigint;
    v_payout uuid;
    v_approved jsonb;
    v_capacity jsonb;
  begin
    /* The seller's balance is exactly the money that has been released
       from escrow. Whatever earlier rules released is what is here, and
       money still in escrow was never credited. */
    v_seller_balance := public.wallet_balance(v_seller);
    v_checks := v_checks + 1;
    if v_seller_balance <= 0 then
      raise exception 'FAIL payouts: the seller has no released balance to withdraw';
    end if;

    /* More than the released balance is refused. */
    v_checks := v_checks + 1;
    begin
      perform public.request_seller_payout(v_seller, v_seller_balance + 1, 'mobile_money', '+255700000000', v_seller);
      raise exception 'FAIL payouts: a payout above the released balance was accepted';
    exception when others then
      if sqlerrm = 'FAIL payouts: a payout above the released balance was accepted' then
        raise;
      end if;
    end;

    /* A request within the balance is accepted. */
    v_checks := v_checks + 1;
    perform public.request_seller_payout(v_seller, 5000, 'mobile_money', '+255700000000', v_seller, 'test-payout-1')
      returning id into v_payout;
    if v_payout is null then
      raise exception 'FAIL payouts: the request was not created';
    end if;

    /* The fee is a share of the amount, computed on the server. */
    v_checks := v_checks + 1;
    if (select fee_tzs from public.payout_requests where id = v_payout) <> 50 then
      raise exception 'FAIL payouts: expected a 50 fee, got %',
        (select fee_tzs from public.payout_requests where id = v_payout);
    end if;

    /* A second request is refused while the first is outstanding. */
    v_checks := v_checks + 1;
    begin
      perform public.request_seller_payout(v_seller, 1000, 'mobile_money', '+255700000000', v_seller, 'test-payout-2');
      raise exception 'FAIL payouts: a second outstanding request was accepted';
    exception when others then
      if sqlerrm = 'FAIL payouts: a second outstanding request was accepted' then
        raise;
      end if;
    end;

    /* The capacity reports the two figures separately: what can be
       withdrawn now, and what is still waiting to be paid out. */
    v_capacity := public.seller_payout_capacity(v_seller);
    v_checks := v_checks + 1;
    if (v_capacity ->> 'available_tzs')::bigint <> v_seller_balance then
      raise exception 'FAIL payouts: expected % available, got %', v_seller_balance, v_capacity ->> 'available_tzs';
    end if;
    v_checks := v_checks + 1;
    if (v_capacity ->> 'pending_tzs')::bigint <> 5000 then
      raise exception 'FAIL payouts: expected 5000 pending, got %', v_capacity ->> 'pending_tzs';
    end if;

    /* Approving the payout debits the gross amount exactly once. The
       fee is part of that amount, not an extra debit. */
    v_approved := public.approve_payout(v_payout, 'aaaaaaaa-0000-4000-8000-000000000004');
    v_checks := v_checks + 1;
    if public.wallet_balance(v_seller) <> v_seller_balance - 5000 then
      raise exception 'FAIL payouts: expected a balance of % after the payout, got %',
        v_seller_balance - 5000, public.wallet_balance(v_seller);
    end if;

    /* Approving twice does not pay twice. */
    v_checks := v_checks + 1;
    begin
      perform public.approve_payout(v_payout, 'aaaaaaaa-0000-4000-8000-000000000004');
    exception when others then
      null; -- already completed, which is the correct outcome
    end;
    if public.wallet_balance(v_seller) <> v_seller_balance - 5000 then
      raise exception 'FAIL payouts: a repeated approval paid the seller twice';
    end if;
  end;

  /* ================================================================== */
  /* Funding the same order twice does not charge the buyer twice        */
  /* ================================================================== */
  v_order := pg_temp.make_order(v_buyer, v_seller, 'KM-T008'007');
  v_checks := v_checks + 1;
  declare
    v_before bigint;
    v_after bigint;
  begin
    v_before := public.wallet_balance(v_buyer);
    perform public.place_funds_in_escrow(v_order, null);
    v_after := public.wallet_balance(v_buyer);
    if v_before <> v_after then
      raise exception 'FAIL: funding the same order twice changed the balance';
    end if;
  end;

  raise notice 'All % escrow release checks passed.', v_checks;
end
$$;

rollback;
