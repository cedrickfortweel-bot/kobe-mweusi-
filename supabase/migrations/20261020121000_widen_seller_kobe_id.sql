/* Kobe Mweusi — widen the Seller Kobe ID.

   The Seller Kobe ID was KOBE + two digits + two letters, which is
   100 x 24 x 24 = 57,600 combinations. That is comfortable for a few
   thousand sellers and runs out for a national platform.

   NEW sellers get three digits:

       KOBE123XL    three digits, two letters

   That is 900 x 24 x 24 = 518,400 combinations, ten times the space.

   IDs ALREADY IN CIRCULATION KEEP THEIR OLD SHAPE. A Seller Kobe ID is
   printed on shop pages, put in public links, read out at a hub and saved
   by buyers, so changing an existing one would break all of that. The
   constraint therefore accepts both forms:

       ^KOBE[0-9]{2,3}[A-Z]{2}$

   Both resolve, because public_seller_identity_by_kid() looks the ID up
   in the registry first and then by the app-facing id, and either way
   returns the canonical one.

   THE LOOKUP IS ALSO FASTER
   -------------------------
   It used to join the registry and the profile table with an OR across
   two different tables, which PostgreSQL cannot serve from a single
   index. It now does two index lookups in sequence: the registry by its
   primary key, then the profile by its unique index. Both are O(log n),
   and neither scans.

   Only the regexes and the digit count change. Nothing else in the
   system needs to know.
*/

begin;

/* ========================================================================== *
 * 1. WIDEN THE CONSTRAINT
 *
 *    The constraint is dropped by looking it up, because its name depends
 *    on whether it was created inline or explicitly. Every check that
 *    mentions KOBE is removed and one with a clear name is added.
 * ========================================================================== */

do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.kobe_id_registry'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%KOBE%'
  loop
    execute format('alter table public.kobe_id_registry drop constraint %I', r.conname);
  end loop;
end
$$;

alter table public.kobe_id_registry
  add constraint kobe_id_registry_kobe_id_format
  check (kobe_id ~ '^KOBE[0-9]{2,3}[A-Z]{2}$');

comment on constraint kobe_id_registry_kobe_id_format on public.kobe_id_registry is
  'Two or three digits then two letters. The two-digit form is kept so IDs already in circulation keep working.';

/* ========================================================================== *
 * 2. NEW SELLERS GET THREE DIGITS
 * ========================================================================== */

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
  v_letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';  /* no I, O */
  v_suffix text := '';
  v_app_kobe_id text;
  v_segment integer;
  v_pick integer;
begin
  /* A seller who already has an ID keeps it, whatever shape it is. */
  select r.kobe_id into v_existing
  from public.kobe_id_registry r where r.assigned_user_id = p_user;

  if v_existing is not null then
    return v_existing;
  end if;

  select s.kobe_id into v_app_kobe_id
  from public.seller_profiles s where s.user_id = p_user;

  while v_attempt < 200 loop
    /* Three digits, from 100 so the ID never starts with a run of zeros
       that a person would have to read as "one hundred and something". */
    v_segment := 100 + floor(random() * 900)::integer;
    v_suffix := '';
    v_pick := floor(random() * length(v_letters))::integer + 1;
    v_suffix := v_suffix || substr(v_letters, v_pick, 1);
    v_pick := floor(random() * length(v_letters))::integer + 1;
    v_suffix := v_suffix || substr(v_letters, v_pick, 1);

    v_candidate := 'KOBE' || v_segment::text || v_suffix;

    if not exists (select 1 from public.kobe_id_registry where kobe_id = v_candidate)
       and not exists (select 1 from public.seller_profiles where kobe_id = v_candidate) then
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

/* ========================================================================== *
 * 3. THE LOOKUP, AS TWO INDEX HITS
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
  v_user uuid;
  v_canonical text;
  v_row record;
begin
  if v_kid = '' then
    return null;
  end if;

  -- 1. the canonical form, by the registry primary key
  select r.assigned_user_id, r.kobe_id
    into v_user, v_canonical
  from public.kobe_id_registry r
  where r.kobe_id = v_kid;

  -- 2. the app-facing form, by its unique index
  if v_user is null then
    select s.user_id into v_user
    from public.seller_profiles s
    where s.kobe_id = v_kid;

    if v_user is not null then
      select r.kobe_id into v_canonical
      from public.kobe_id_registry r
      where r.assigned_user_id = v_user;
    end if;
  end if;

  if v_user is null then
    return null;
  end if;

  select s.shop_name, s.shop_slug, s.region, s.verification_status,
         s.avatar_path, s.cover_path, s.kobe_id as app_kid
    into v_row
  from public.seller_profiles s
  where s.user_id = v_user;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'kobe_id', coalesce(v_canonical, v_row.app_kid),
    'app_kobe_id', v_row.app_kid,
    'user_id', v_user,
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

commit;
