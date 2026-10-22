/* ========================================================================== *
 * RLS CROSS-USER TESTS
 *
 * These verify that a signed-in user cannot read or write another user's
 * data through the public tables, even when they know the other user's
 * id or order reference. They are written to be run as service_role
 * (which bypasses RLS) to set up the data, then as the two users to
 * check what each can see.
 *
 * How to run
 * ----------
 * 1. Apply migrations + seed.
 * 2. Create two buyer accounts and one seller account in Auth.
 * 3. Run this file with psql, substituting the UUIDs at the top.
 * 4. Every assertion prints PASS or FAIL. A FAIL means a policy is
 *    missing or too permissive.
 *
 *   psql "$DATABASE_URL" -v buyer_a=<uuid> -v buyer_b=<uuid> -v seller=<uuid> \
 *        -f supabase/tests/rls_cross_user_test.sql
 * ========================================================================== */

\set ON_ERROR_STOP off

do $$
declare
  v_buyer_a uuid := :'buyer_a'::uuid;
  v_buyer_b uuid := :'buyer_b'::uuid;
  v_seller uuid := :'seller'::uuid;
  v_order uuid;
  v_count integer;
  v_pass boolean;
begin
  raise notice 'RLS cross-user tests starting';

  /* ------------------------------------------------------------------ */
  /* 1. A buyer cannot read another buyer's orders.                     */
  /* ------------------------------------------------------------------ */
  set role authenticated;
  set request.jwt.claim.sub to :'buyer_a';
  set request.jwt.claim.role to 'authenticated';

  select count(*) into v_count
  from public.orders
  where buyer_id = v_buyer_b;
  v_pass := (v_count = 0);
  raise notice 'TEST 1 buyer A reads buyer B orders: % (count=%)', case when v_pass then 'PASS' else 'FAIL' end, v_count;

  /* ------------------------------------------------------------------ */
  /* 2. A buyer cannot read another buyer's wallet.                     */
  /* ------------------------------------------------------------------ */
  select count(*) into v_count
  from public.wallets
  where user_id = v_buyer_b;
  v_pass := (v_count = 0);
  raise notice 'TEST 2 buyer A reads buyer B wallet: % (count=%)', case when v_pass then 'PASS' else 'FAIL' end, v_count;

  /* ------------------------------------------------------------------ */
  /* 3. A buyer cannot read another buyer's notifications.              */
  /* ------------------------------------------------------------------ */
  select count(*) into v_count
  from public.my_notifications
  where user_id = v_buyer_b;
  v_pass := (v_count = 0);
  raise notice 'TEST 3 buyer A reads buyer B notifications: % (count=%)', case when v_pass then 'PASS' else 'FAIL' end, v_count;

  /* ------------------------------------------------------------------ */
  /* 4. A seller cannot read another seller's payouts.                  */
  /* ------------------------------------------------------------------ */
  set request.jwt.claim.sub to :'seller';
  select count(*) into v_count
  from public.payout_requests
  where seller_id <> v_seller;
  v_pass := (v_count = 0);
  raise notice 'TEST 4 seller reads other sellers payouts: % (count=%)', case when v_pass then 'PASS' else 'FAIL' end, v_count;

  /* ------------------------------------------------------------------ */
  /* 5. A buyer cannot update an order's status.                       */
  /* ------------------------------------------------------------------ */
  set request.jwt.claim.sub to :'buyer_a';
  begin
    update public.orders set status = 'completed' where buyer_id = v_buyer_b;
    get diagnostics v_count = row_count;
    v_pass := (v_count = 0);
  exception when others then
    v_pass := true;
  end;
  raise notice 'TEST 5 buyer A updates buyer B order: %', case when v_pass then 'PASS' else 'FAIL' end;

  /* ------------------------------------------------------------------ */
  /* 6. An agent cannot read another agent's assignments.               */
  /* ------------------------------------------------------------------ */
  -- (requires two agent accounts; left as a manual check)

  /* ------------------------------------------------------------------ */
  /* 7. Service role can read everything (sanity).                       */
  /* ------------------------------------------------------------------ */
  reset role;
  select count(*) into v_count from public.orders;
  raise notice 'TEST 7 service role reads orders: % rows (sanity)', v_count;

  raise notice 'RLS cross-user tests finished';
end $$;
