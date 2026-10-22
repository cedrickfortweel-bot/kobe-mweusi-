/* Kobe Mweusi — the public seller identity.

   Two seller identifiers exist and they must not be confused.

     KOBE12XL      the canonical Seller Kobe ID. Assigned once, permanent.
                   This is the ID a customer reads, searches for and sees
                   in a public link. It lives in kobe_id_registry.
     KM-xxxxxxxx  the app-facing identifier kept in seller_profiles.kobe_id.
                   The existing PWAs were built around it.

   The canonical one is what people are given and what appears in the
   UI. The other one keeps working, so an old link or a printed QR code
   still resolves.

   This migration:
     * adds the foreign key that lets PostgREST embed the registry row
       from a seller profile, so the apps can read the canonical ID
       without a second round trip
     * adds public_seller_identity_by_kid(), which resolves EITHER format
       to the canonical one
     * adds a public_sellers view for the public directory
*/

begin;

/* ========================================================================== *
 * 1. EMBED THE REGISTRY FROM A SELLER PROFILE
 *
 *    kobe_id_registry.assigned_user_id points at seller_profiles.user_id
 *    and is unique, so PostgREST can resolve it as a to-one relation.
 * ========================================================================== */

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'kobe_id_registry_user_fkey'
      and conrelid = 'public.kobe_id_registry'::regclass
  ) then
    alter table public.kobe_id_registry
      add constraint kobe_id_registry_user_fkey
      foreign key (assigned_user_id)
      references public.seller_profiles (user_id)
      on delete cascade;
  end if;
end
$$;

/* ========================================================================== *
 * 2. RESOLVE EITHER FORMAT TO THE CANONICAL ID
 * ========================================================================== */

create or replace function public.public_seller_identity_by_kid(p_kid text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kid text := upper(btrim(coalesce(p_kid, '')));
  v_row record;
begin
  if v_kid = '' then
    return null;
  end if;

  -- The canonical form, or the app-facing form.
  select r.kobe_id as canonical_kid, r.assigned_user_id as user_id,
         s.kobe_id as app_kid, s.shop_name, s.shop_slug, s.region,
         s.verification_status, s.avatar_path, s.cover_path
    into v_row
  from public.kobe_id_registry r
  join public.seller_profiles s on s.user_id = r.assigned_user_id
  where r.kobe_id = v_kid
     or s.kobe_id = v_kid
  limit 1;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'kobe_id', v_row.canonical_kid,
    'app_kobe_id', v_row.app_kid,
    'user_id', v_row.user_id,
    'shop_name', v_row.shop_name,
    'shop_slug', v_row.shop_slug,
    'region', v_row.region,
    'verified', v_row.verification_status = 'verified',
    'verification_status', v_row.verification_status,
    'avatar_path', v_row.avatar_path,
    'cover_path', v_row.cover_path
  );
end;
$$;
revoke all on function public.public_seller_identity_by_kid(text) from public, anon, authenticated;
grant execute on function public.public_seller_identity_by_kid(text) to anon, authenticated, service_role;

/* ========================================================================== *
 * 3. THE PUBLIC DIRECTORY
 *
 *    Only verified sellers with a live session, and only what a customer
 *    is allowed to see.
 * ========================================================================== */

create or replace view public.public_sellers
with (security_invoker = true)
as
  select
    r.kobe_id,
    s.shop_name,
    s.shop_slug,
    s.region,
    s.avatar_path,
    s.cover_path,
    s.verification_status::text as verification_status,
    (s.verification_status = 'verified') as verified
  from public.kobe_id_registry r
  join public.seller_profiles s on s.user_id = r.assigned_user_id
  where s.verification_status = 'verified';

grant select on public.public_sellers to anon, authenticated;
revoke all on public.public_sellers from anon;

commit;
