/* Kobe Mweusi — Module B: Kobe IDs, buyer Wallet IDs and seller identity.

   Three identifiers, three different jobs. They must never be confused.

     Seller Kobe ID      KOBE12XL   public seller identity, assigned once,
                                   permanent. Source of truth:
                                   kobe_id_registry. The app-facing value
                                   seller_profiles.kobe_id (KM-...) is kept in
                                   sync for the existing PWAs.

     Buyer Wallet ID    KMB-27-MAZI memorable wallet identifier. NOT a
                                   password, NOT a balance, NOT a payment
                                   credential. Source of truth: wallets.

     Internal user id   uuid       Supabase Auth id. Never shown to a buyer
                                   as a customer-facing identifier.

   Design rules enforced here
     1. One account may be both buyer and seller.
     2. A seller's Kobe ID is never modified after assignment.
     3. Wallet IDs are generated server-side with collision handling and a
        unique constraint.
     4. A seller cannot list every buyer's Wallet ID. Wallet IDs are only
        revealed inside an authorized transaction context.
     5. Generating a Wallet ID never creates a balance, credits money or
        releases escrow.

   Functions added here
     ensure_my_wallet()          return (or create) the caller's wallet
     ensure_wallet_for(p_user)   server-side wallet resolution
     get_my_wallet_id()          the caller's own Wallet ID
     assign_registry_kobe_id()   reserve the canonical KOBE code for a seller
     is_verified_seller(p_user)  verified-seller check used by order creation
*/

alter table public.profiles
  add column if not exists kobe_id text;

create unique index if not exists profiles_kobe_id_idx
  on public.profiles (kobe_id)
  where kobe_id is not null;

/* ========================================================================== *
 * 1. BUYER WALLET ID GENERATION
 *
 *    Format KMB-NN-XXXX : NN is the two-digit business unit / region
 *    segment, XXXX is four uppercase letters. Generation is server-side
 *    only, retried on collision, and never touches money.
 * ========================================================================== */

create or replace function public.generate_wallet_id()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_candidate text;
  v_attempt integer := 0;
  v_letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';  /* no I, O */
  v_digit integer;
  v_letter integer;
  v_suffix text := '';
  v_segment integer;
begin
  v_segment := 10 + floor(random() * 90)::integer;

  while v_attempt < 50 loop
    v_suffix := '';
    for i in 1..4 loop
      v_digit := floor(random() * length(v_letters))::integer + 1;
      v_letter := floor(random() * 26)::integer + 1;
      v_suffix := v_suffix || substr(v_letters, v_digit, 1);
    end loop;

    v_candidate := 'KMB-' || lpad(v_segment::text, 2, '0') || '-' || v_suffix;

    if not exists (select 1 from public.wallets where wallet_id = v_candidate) then
      return v_candidate;
    end if;

    v_attempt := v_attempt + 1;
  end loop;

  raise exception 'Could not allocate a unique wallet id' using errcode = 'P0001';
end;
$$;
revoke all on function public.generate_wallet_id() from public, anon, authenticated;
grant execute on function public.generate_wallet_id() to service_role;

/* Return the caller's wallet, creating it once if needed. Idempotent. */
create or replace function public.ensure_my_wallet()
returns public.wallets
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_wallet public.wallets%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_wallet from public.wallets where user_id = v_user;
  if v_wallet.id is not null then
    return v_wallet;
  end if;

  insert into public.wallets (user_id, wallet_id)
  values (v_user, public.generate_wallet_id())
  on conflict (user_id) do update set user_id = excluded.user_id
  returning * into v_wallet;

  return v_wallet;
end;
$$;
grant execute on function public.ensure_my_wallet() to authenticated;

/* Server-side wallet resolution for Edge Functions. */
create or replace function public.ensure_wallet_for(p_user uuid)
returns public.wallets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet public.wallets%rowtype;
begin
  if p_user is null then
    raise exception 'A user id is required' using errcode = 'P0001';
  end if;

  select * into v_wallet from public.wallets where user_id = p_user;
  if v_wallet.id is not null then
    return v_wallet;
  end if;

  insert into public.wallets (user_id, wallet_id)
  values (p_user, public.generate_wallet_id())
  on conflict (user_id) do update set user_id = excluded.user_id
  returning * into v_wallet;

  return v_wallet;
end;
$$;
revoke all on function public.ensure_wallet_for(uuid) from public, anon, authenticated;
grant execute on function public.ensure_wallet_for(uuid) to service_role;

/* The caller's own Wallet ID. A seller cannot call this for a buyer. */
create or replace function public.get_my_wallet_id()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select w.wallet_id
  from public.wallets w
  where w.user_id = (select auth.uid());
$$;
grant execute on function public.get_my_wallet_id() to authenticated;

/* ========================================================================== *
 * 2. SELLER KOBE ID REGISTRY
 * ========================================================================== */

/* Reserve the canonical KOBE12XL style code for a seller. Called from the
   seller_profiles insert path. Idempotent per user. */
create or replace function public.assign_registry_kobe_id(p_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing text;
  v_candidate text;
  v_attempt integer := 0;
  v_letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_suffix text := '';
  v_app_kobe_id text;
begin
  select r.kobe_id into v_existing
  from public.kobe_id_registry r where r.assigned_user_id = p_user;

  if v_existing is not null then
    return v_existing;
  end if;

  select s.kobe_id into v_app_kobe_id
  from public.seller_profiles s where s.user_id = p_user;

  while v_attempt < 50 loop
    v_suffix := '';
    for i in 1..2 loop
      v_suffix := v_suffix || substr(v_letters,
        floor(random() * length(v_letters))::integer + 1, 1);
    end loop;

    v_candidate := 'KOBE' || lpad((floor(random() * 100))::integer::text, 2, '0') || v_suffix;

    if not exists (select 1 from public.kobe_id_registry where kobe_id = v_candidate) then
      insert into public.kobe_id_registry (kobe_id, assigned_user_id, app_kobe_id)
      values (v_candidate, p_user, v_app_kobe_id)
      on conflict (assigned_user_id) do update set app_kobe_id = excluded.app_kobe_id;
      return v_candidate;
    end if;

    v_attempt := v_attempt + 1;
  end loop;

  raise exception 'Could not allocate a unique Kobe ID' using errcode = 'P0001';
end;
$$;
revoke all on function public.assign_registry_kobe_id(uuid) from public, anon, authenticated;
grant execute on function public.assign_registry_kobe_id(uuid) to service_role;

/* Keep the registry in step with seller_profiles.kobe_id. */
create or replace function public.sync_registry_kobe_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.kobe_id is distinct from old.kobe_id then
    perform public.assign_registry_kobe_id(new.user_id);
  end if;
  return new;
end;
$$;
revoke all on function public.sync_registry_kobe_id() from public, anon, authenticated;

drop trigger if exists seller_profiles_sync_registry on public.seller_profiles;
create trigger seller_profiles_sync_registry
  after insert or update of kobe_id on public.seller_profiles
  for each row execute function public.sync_registry_kobe_id();

/* The public seller identity, safe to display. */
create or replace function public.public_seller_identity(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'kobe_id', coalesce(
      (select r.kobe_id from public.kobe_id_registry r where r.assigned_user_id = p_user),
      (select s.kobe_id from public.seller_profiles s where s.user_id = p_user)
    ),
    'shop_name', (select s.shop_name from public.seller_profiles s where s.user_id = p_user),
    'shop_slug', (select s.shop_slug from public.seller_profiles s where s.user_id = p_user),
    'region', (select s.region from public.seller_profiles s where s.user_id = p_user),
    'verified', coalesce(
      (select s.verification_status = 'verified' from public.seller_profiles s where s.user_id = p_user),
      false
    )
  );
$$;
revoke all on function public.public_seller_identity(uuid) from public, anon, authenticated;
grant execute on function public.public_seller_identity(uuid) to service_role;

/* ========================================================================== *
 * 3. SELLER CAPABILITY
 *
 *    A user is a seller when a seller_profiles row exists for them. The
 *    `profiles.account_type` column records how the account registered and
 *    must not be used as the permission gate, because one account may buy
 *    and sell at the same time.
 * ========================================================================== */

create or replace function public.is_seller(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.seller_profiles s where s.user_id = p_user);
$$;
revoke all on function public.is_seller(uuid) from public, anon;
grant execute on function public.is_seller(uuid) to service_role, authenticated;

create or replace function public.is_verified_seller(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.seller_profiles s
    where s.user_id = p_user and s.verification_status = 'verified'
  );
$$;
revoke all on function public.is_verified_seller(uuid) from public, anon;
grant execute on function public.is_verified_seller(uuid) to service_role, authenticated;

/* A user may become a seller at any time; the account is not split. */
create or replace function public.become_seller(
  p_shop_name text,
  p_shop_slug text default null,
  p_region text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_existing uuid;
  v_slug text := nullif(lower(btrim(coalesce(p_shop_slug, ''))), '');
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if char_length(btrim(p_shop_name)) < 2 then
    raise exception 'A shop name of at least 2 characters is required' using errcode = 'P0001';
  end if;

  select s.user_id into v_existing from public.seller_profiles s where s.user_id = v_user;
  if v_existing is not null then
    return v_existing;
  end if;

  if v_slug is null then
    v_slug := regexp_replace(lower(btrim(p_shop_name)), '[^a-z0-9]+', '-', 'g');
    v_slug := trim(both '-' from v_slug);
    if v_slug = '' then
      v_slug := 'shop-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    end if;
  end if;

  insert into public.seller_profiles (user_id, shop_name, shop_slug, region)
  values (v_user, btrim(p_shop_name), v_slug, nullif(btrim(coalesce(p_region, '')), ''))
  returning user_id into v_existing;

  return v_existing;
end;
$$;
revoke all on function public.become_seller(text, text, text) from public, anon;
grant execute on function public.become_seller(text, text, text) to authenticated;

/* ========================================================================== *
 * 4. WALLET ID VISIBILITY
 *
 *    A buyer's Wallet ID may only be revealed inside an authorized
 *    transaction context: to that buyer, to the seller of an order with
 *    that buyer, or to internal staff.
 * ========================================================================== */

create or replace function public.reveal_wallet_id(p_user uuid, p_actor uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_wallet_id text;
  v_is_staff boolean;
begin
  select w.wallet_id into v_wallet_id from public.wallets w where w.user_id = p_user;
  if v_wallet_id is null then
    return null;
  end if;

  if p_actor = p_user then
    return v_wallet_id;
  end if;

  select exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_actor and r.role in ('admin', 'support_agent')
  ) into v_is_staff;
  if v_is_staff then
    return v_wallet_id;
  end if;

  if exists (
    select 1 from public.orders o
    where o.seller_id = p_actor and o.buyer_id = p_user
  ) then
    return v_wallet_id;
  end if;

  return null;
end;
$$;
revoke all on function public.reveal_wallet_id(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reveal_wallet_id(uuid, uuid) to service_role;
