/* Kobe Mweusi — Module D: live business, social commerce and seller content.

   Kobe Mweusi is not a marketplace with a public catalogue. Sellers
   advertise through WhatsApp, TikTok, Instagram and Facebook. The backend
   therefore supports seller verification and order-related content without
   turning the platform into a shopping mall.

   Tables added here
     seller_social_accounts   public social links and verification status
     seller_business_hours    seller availability and opening hours

   Functions added here
     create_live_session(), end_live_session(), update_live_session_status()
     verify_seller_social_link(), list_public_live_sessions()
*/

alter table public.live_sessions
  add column if not exists cover_path text;

alter table public.live_sessions
  add column if not exists claimed_at timestamptz;

alter table public.live_sessions
  add column if not exists ended_at timestamptz;

create index if not exists live_sessions_seller_idx
  on public.live_sessions (seller_id, created_at desc);

/* ========================================================================== *
 * 1. SELLER SOCIAL ACCOUNTS
 * ========================================================================== */

do $$
begin
  if not exists (select 1 from pg_type where typname = 'social_platform') then
    create type public.social_platform as enum
      ('whatsapp', 'tiktok', 'instagram', 'facebook', 'youtube', 'telegram', 'x');
  end if;
  if not exists (select 1 from pg_type where typname = 'social_verification_status') then
    create type public.social_verification_status as enum
      ('unverified', 'pending', 'verified', 'rejected');
  end if;
end
$$;

create table if not exists public.seller_social_accounts (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  platform public.social_platform not null,
  handle text not null check (char_length(handle) between 1 and 120),
  url text,
  verification_status public.social_verification_status not null default 'unverified',
  verified_at timestamptz,
  verified_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seller_id, platform)
);

create index if not exists seller_social_accounts_seller_idx
  on public.seller_social_accounts (seller_id);

alter table public.seller_social_accounts enable row level security;
revoke all on public.seller_social_accounts from anon, authenticated;
grant select on public.seller_social_accounts to anon, authenticated;
grant insert, update, delete on public.seller_social_accounts to authenticated;

drop policy if exists seller_social_accounts_read on public.seller_social_accounts;
create policy seller_social_accounts_read on public.seller_social_accounts
  for select to anon, authenticated
  using (
    verification_status = 'verified'
    or seller_id = (select auth.uid())
  );

drop policy if exists seller_social_accounts_write_own on public.seller_social_accounts;
create policy seller_social_accounts_write_own on public.seller_social_accounts
  for insert to authenticated
  with check (seller_id = (select auth.uid()));

drop policy if exists seller_social_accounts_update_own on public.seller_social_accounts;
create policy seller_social_accounts_update_own on public.seller_social_accounts
  for update to authenticated
  using (seller_id = (select auth.uid()))
  with check (seller_id = (select auth.uid()));

drop policy if exists seller_social_accounts_delete_own on public.seller_social_accounts;
create policy seller_social_accounts_delete_own on public.seller_social_accounts
  for delete to authenticated
  using (seller_id = (select auth.uid()));

drop trigger if exists seller_social_accounts_set_updated_at on public.seller_social_accounts;
create trigger seller_social_accounts_set_updated_at
  before update on public.seller_social_accounts
  for each row execute function public.set_updated_at();

/* A seller may never set their own verification badge. */
create or replace function public.prevent_self_social_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status is distinct from old.verification_status
     and (select auth.role()) <> 'service_role' then
    raise exception 'Social verification is granted by the review process'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_self_social_verification() from public, anon, authenticated;

drop trigger if exists seller_social_accounts_guard on public.seller_social_accounts;
create trigger seller_social_accounts_guard
  before update on public.seller_social_accounts
  for each row execute function public.prevent_self_social_verification();

/* ========================================================================== *
 * 2. BUSINESS HOURS
 * ========================================================================== */

create table if not exists public.seller_business_hours (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  is_closed boolean not null default false,
  note text check (note is null or char_length(note) <= 120),
  unique (seller_id, weekday)
);

alter table public.seller_business_hours enable row level security;
revoke all on public.seller_business_hours from anon, authenticated;
grant select on public.seller_business_hours to anon, authenticated;
grant insert, update, delete on public.seller_business_hours to authenticated;

drop policy if exists seller_business_hours_read on public.seller_business_hours;
create policy seller_business_hours_read on public.seller_business_hours
  for select to anon, authenticated using (true);

drop policy if exists seller_business_hours_write_own on public.seller_business_hours;
create policy seller_business_hours_write_own on public.seller_business_hours
  for all to authenticated
  using (seller_id = (select auth.uid()))
  with check (seller_id = (select auth.uid()));

/* ========================================================================== *
 * 3. LIVE SESSION FUNCTIONS
 * ========================================================================== */

/* Create a live session. The seller is always the signed-in user; a
   client-supplied seller id is never trusted. */
create or replace function public.create_live_session(
  p_title text,
  p_description text default null,
  p_platform public.live_platform default null,
  p_external_url text default null,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null
)
returns public.live_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session public.live_sessions%rowtype;
  v_platform public.live_platform;
  v_url text := nullif(btrim(coalesce(p_external_url, '')), '');
  v_link public.seller_social_accounts%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.is_seller(v_user) then
    raise exception 'Only sellers can publish a live session' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) < 1 then
    raise exception 'A title is required' using errcode = 'P0001';
  end if;

  -- Prefer the platform the seller registered, so the published link always
  -- matches a verified social account.
  if p_platform is null then
    select s.platform, s.url into v_platform, v_url
    from public.seller_social_accounts s
    where s.seller_id = v_user and s.verification_status = 'verified'
    order by s.created_at
    limit 1;
  else
    v_platform := p_platform;
  end if;

  if v_platform is null then
    raise exception 'Add a verified social link before publishing a live session'
      using errcode = 'P0001';
  end if;
  if v_url is null then
    raise exception 'A session link is required' using errcode = 'P0001';
  end if;

  insert into public.live_sessions
    (seller_id, title, description, platform, external_url, status, starts_at, ends_at)
  values
    (v_user, btrim(p_title), coalesce(p_description, ''), v_platform, v_url,
     case when p_starts_at is null or p_starts_at <= now() then 'live'::public.live_status
          else 'scheduled'::public.live_status end,
     p_starts_at, p_ends_at)
  returning * into v_session;

  return v_session;
end;
$$;
revoke all on function public.create_live_session(text, text, public.live_platform, text, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.create_live_session(text, text, public.live_platform, text, timestamptz, timestamptz)
  to authenticated;

/* Move a session to a new status. Only the owning seller or staff may do
   this, and an archived session can never be reopened. */
create or replace function public.update_live_session_status(
  p_session_id uuid,
  p_status public.live_status
)
returns public.live_sessions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_session public.live_sessions%rowtype;
  v_is_staff boolean := false;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_user and r.role in ('admin', 'support_agent')
  ) into v_is_staff;

  select l.* into v_session from public.live_sessions l where l.id = p_session_id for update;
  if not found then
    raise exception 'Live session not found' using errcode = 'P0002';
  end if;

  if v_session.seller_id <> v_user and not v_is_staff then
    raise exception 'You do not own this live session' using errcode = '42501';
  end if;

  if v_session.status = 'archived' then
    raise exception 'An archived live session cannot be reopened' using errcode = 'P0001';
  end if;

  update public.live_sessions
    set status = p_status,
        ended_at = case when p_status = 'ended' then now() else ended_at end
    where id = p_session_id
    returning * into v_session;

  return v_session;
end;
$$;
revoke all on function public.update_live_session_status(uuid, public.live_status) from public, anon;
grant execute on function public.update_live_session_status(uuid, public.live_status) to authenticated;

/* End a live session. Thin wrapper that keeps the calling code readable. */
create or replace function public.end_live_session(p_session_id uuid)
returns public.live_sessions
language sql
security invoker
set search_path = ''
as $$
  select public.update_live_session_status(p_session_id, 'ended'::public.live_status);
$$;
revoke all on function public.end_live_session(uuid) from public, anon;
grant execute on function public.end_live_session(uuid) to authenticated;

/* Mark a social link as verified. Staff only, and always audited. */
create or replace function public.verify_seller_social_link(
  p_social_id uuid,
  p_verified boolean,
  p_reviewer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid := coalesce(p_reviewer_id, (select auth.uid()));
  v_seller uuid;
begin
  if v_reviewer is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_reviewer and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Reviewer is not authorized' using errcode = '42501';
  end if;

  select s.seller_id into v_seller from public.seller_social_accounts s where s.id = p_social_id;
  if v_seller is null then
    raise exception 'Social account not found' using errcode = 'P0002';
  end if;

  update public.seller_social_accounts
    set verification_status = case when p_verified then 'verified'::public.social_verification_status
                                   else 'rejected'::public.social_verification_status end,
        verified_at = case when p_verified then now() else null end,
        verified_by = v_reviewer
    where id = p_social_id;

  insert into public.activity_events (user_id, kind, payload)
  values (v_seller, 'support_update',
    jsonb_build_object('title', 'Social link updated',
      'verified', p_verified));

  return jsonb_build_object('ok', true, 'seller_id', v_seller, 'verified', p_verified);
end;
$$;
revoke all on function public.verify_seller_social_link(uuid, boolean, uuid) from public, anon, authenticated;
grant execute on function public.verify_seller_social_link(uuid, boolean, uuid) to service_role;

/* Public live feed. Only verified sellers and live or scheduled sessions. */
create or replace function public.list_public_live_sessions(p_limit integer default 20)
returns setof public.live_sessions
language sql
stable
security definer
set search_path = ''
as $$
  select l.*
  from public.live_sessions l
  where l.status in ('scheduled', 'live')
    and exists (select 1 from public.seller_profiles s
                where s.user_id = l.seller_id and s.verification_status = 'verified')
  order by l.starts_at asc nulls last, l.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;
revoke all on function public.list_public_live_sessions(integer) from public, anon, authenticated;
grant execute on function public.list_public_live_sessions(integer) to anon, authenticated;
