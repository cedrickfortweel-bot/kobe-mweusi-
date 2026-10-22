/* Kobe Mweusi — development seed.

   Runs after `supabase db reset`. It creates a small, self-contained set
   of users so the buyer, seller, agent and staff flows can be exercised
   without a real payment provider.

   The auth.users rows are created directly so the seed is deterministic.
   The passwords are intentionally obvious and only valid in local
   development. NEVER run this against a production project.
*/

begin;

create extension if not exists pgcrypto;

/* ---------- users ---------- */
do $$
declare
  v_buyer uuid := '11111111-1111-4111-8111-111111111111';
  v_seller uuid := '22222222-2222-4222-8222-222222222222';
  v_agent uuid := '33333333-3333-4333-8333-333333333333';
  v_admin uuid := '44444444-4444-4444-8444-444444444444';
  v_support uuid := '55555555-5555-4555-8555-555555555555';
  v_password text := crypt('kobe-dev-password', gen_salt('bf'));
begin
  insert into auth.users
    (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values
    (v_buyer, 'buyer@kobe.test', v_password, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"account_type":"buyer","display_name":"Amina Buyer"}'),
    (v_seller, 'seller@kobe.test', v_password, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"account_type":"seller","display_name":"Juma Seller"}'),
    (v_agent, 'agent@kobe.test', v_password, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"account_type":"buyer","display_name":"Neema Agent"}'),
    (v_admin, 'admin@kobe.test', v_password, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"account_type":"buyer","display_name":"Admin"}'),
    (v_support, 'support@kobe.test', v_password, now(), now(), now(),
     '{"provider":"email","providers":["email"]}', '{"account_type":"buyer","display_name":"Support"}')
  on conflict (id) do nothing;

  -- The handle_new_user trigger has already created the profiles.
  update public.profiles
    set display_name = 'Amina Buyer', phone_e164 = '+255712000001'
    where id = v_buyer;
  update public.profiles
    set display_name = 'Juma Seller', phone_e164 = '+255712000002'
    where id = v_seller;
  update public.profiles
    set display_name = 'Neema Agent', phone_e164 = '+255712000003'
    where id = v_agent;

  -- One account may be both a buyer and a seller.
  update public.profiles set account_type = 'seller' where id = v_seller;

  -- Seller profile and its permanent identifiers.
  insert into public.seller_profiles (user_id, shop_name, shop_slug, bio, region, public_contact)
  values (v_seller, 'Juma Electronics', 'juma-electronics',
          'Phones, chargers and small appliances in Dar es Salaam.', 'Dar es Salaam', '+255712000002')
  on conflict (user_id) do nothing;

  update public.seller_profiles
    set verification_status = 'verified'
    where user_id = v_seller;

  -- Wallets.
  perform public.ensure_wallet_for(v_buyer);
  perform public.ensure_wallet_for(v_seller);
  perform public.ensure_wallet_for(v_agent);

  -- Internal staff.
  insert into public.internal_user_roles (user_id, role) values
    (v_admin, 'admin'),
    (v_support, 'support_agent'),
    (v_agent, 'agent')
  on conflict (user_id, role) do nothing;

  insert into public.employee_profiles (user_id, employment_status, job_title, department)
  values
    (v_admin, 'active', 'System Administrator', 'Operations'),
    (v_support, 'active', 'Support Agent', 'Customer Care')
  on conflict (user_id) do nothing;

  -- A verified delivery agent, with the worker ID the hub shows at the
  -- handover and the region they work in.
  insert into public.delivery_agents (user_id, verification_status, verified_at, verified_by, worker_id, region)
  values (v_agent, 'verified', now(), v_admin, 'KMW-12XL', 'Dar es Salaam')
  on conflict (user_id) do update
    set verification_status = 'verified', verified_at = now(),
        worker_id = excluded.worker_id, region = excluded.region;
end
$$;

/* ---------- catalogue ---------- */
do $$
declare
  v_seller uuid := '22222222-2222-4222-8222-222222222222';
  v_product uuid;
begin
  insert into public.products (seller_id, name, description, price_tzs, stock_quantity, status)
  values
    (v_seller, 'Solar phone charger', '20 000 mAh solar power bank', 45000, 25, 'active'),
    (v_seller, 'Wireless earbuds', 'Bluetooth earbuds with a 20 hour battery', 32000, 60, 'active'),
    (v_seller, 'Phone case', 'Shockproof case, several colours', 9000, 200, 'active')
  on conflict do nothing;

  select id into v_product from public.products
    where seller_id = v_seller and name = 'Wireless earbuds' limit 1;

  insert into public.live_sessions (seller_id, title, description, platform, external_url, status, starts_at, ends_at)
  values (v_seller, 'Evening earbuds drop', 'Live on TikTok with a limited price',
          'tiktok', 'https://www.tiktok.com/@kobe.test/live', 'live', now(), now() + interval '2 hours')
  on conflict do nothing;

  insert into public.live_session_products (session_id, product_id, sort_order, pinned)
  select l.id, p.id, 1, true
  from public.live_sessions l, public.products p
  where l.seller_id = v_seller and p.name = 'Wireless earbuds'
  on conflict do nothing;
end
$$;

/* ---------- a live order in escrow ---------- */
do $$
declare
  v_buyer uuid := '11111111-1111-4111-8111-111111111111';
  v_seller uuid := '22222222-2222-4222-8222-222222222222';
  v_agent uuid := '33333333-3333-4333-8333-333333333333';
  v_product uuid;
  v_order uuid;
  v_intent uuid;
begin
  select id into v_product from public.products
    where seller_id = v_seller and name = 'Wireless earbuds' limit 1;

  insert into public.orders
    (buyer_id, seller_id, product_id, item_name, quantity, unit_price_tzs,
     subtotal_tzs, buyer_fee_tzs, total_due_tzs, status, ref, source, expires_at)
  values
    (v_buyer, v_seller, v_product, 'Wireless earbuds', 1, 32000,
     32000, 320, 32320, 'awaiting_payment', 'KM-000001', 'store', now() + interval '24 hours')
  on conflict (id) do nothing
  returning id into v_order;

  if v_order is null then
    select id into v_order from public.orders where ref = 'KM-000001';
  end if;

  insert into public.payment_intents
    (buyer_id, order_id, provider, amount_tzs, status, idempotency_key, provider_reference)
  values (v_buyer, v_order, 'azampay', 32320, 'confirmed', 'seed:intent:KM-000001', 'SEED-REF-1')
  on conflict (idempotency_key) do nothing
  returning id into v_intent;

  if v_intent is null then
    select id into v_intent from public.payment_intents
      where idempotency_key = 'seed:intent:KM-000001';
  end if;

  -- Fund the buyer's wallet so the order below can be paid for from it.
  perform public.record_wallet_topup(
    'azampay', 'seed-topup:' || v_buyer::text, 'SEED-TOPUP-1',
    5000000, v_buyer, '{}'::jsonb);

  -- Put the order into escrow so the release rules can be exercised.
  perform public.place_funds_in_escrow(v_order, v_intent, 'wallet');

  insert into public.order_delivery_workflows (order_id, delivery_mode, stage)
  values (v_order, 'direct', 'not_started')
  on conflict (order_id) do nothing;

  insert into public.delivery_assignments (order_id, agent_user_id, status, assigned_by)
  values (v_order, v_agent, 'assigned', '44444444-4444-4444-8444-444444444444')
  on conflict do nothing;

  update public.order_delivery_workflows
    set agent_user_id = v_agent
    where order_id = v_order;
end
$$;

/* ---------- a hub ---------- */
insert into public.hubs (code, name, region, address, city, phone_e164)
values ('DAR-001', 'Kobe Mweusi Dar es Salaam Hub', 'Dar es Salaam',
        'Kariakoo Market area', 'Dar es Salaam', '+255712000100')
on conflict (code) do nothing;

/* ---------- settings ---------- */
insert into public.app_settings (key, value, description)
values ('escrow_policy', jsonb_build_object(
    'release_window_minutes', 180,
    'buyer_qr_scan_releases_immediately', true,
    'buyer_confirmation_releases_immediately', true,
    'agent_scan_can_release', true,
    'dispute_blocks_release', true,
    'auto_release_enabled', true
  ), 'Escrow release policy.')
on conflict (key) do update set value = excluded.value;

insert into public.payment_provider_config (provider, is_enabled, environment)
values ('azampay', false, 'sandbox')
on conflict (provider) do nothing;

commit;
