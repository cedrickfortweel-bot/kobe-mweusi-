/* Kobe Mweusi — notification hardening.

   Three things that do not need a domain or an SMS provider, and that
   get harder to retrofit later.

   1. PHONE VERIFICATION
      The phone number was taken on trust at sign-up. The trigger copies
      raw_user_meta_data ->> 'phone_e164' straight into the profile, so
      anybody could put any number on their account, and that number was
      shown to the other party on every order. A profile now records
      when the number was confirmed, and the order view only shows a
      confirmed one. This is the hard prerequisite for SMS: a payout
      confirmation must not be sent to a number the account holder never
      proved they own.

   2. PERMANENT VERSUS TRANSIENT EMAIL FAILURES
      The worker retried every failure five times. A hard failure, such
      as a rejected address, will never succeed, so retrying it is
      pointless and it delays the queue. The worker now tells the two
      apart, and a hard failure suppresses the address.

   3. THE UNSUBSCRIBE LINK
      The preferences were already stored per category, but there was no
      way to use them from an email. There is now a token, a landing
      page and a function that flips the preference. The app is already
      served from an origin, so the link works there today and follows
      the domain when there is one.

   The bounce and complaint WEBHOOK still waits for a provider, but the
   suppression list it fills is in place now.
*/

begin;

/* ========================================================================== *
 * 1. A CONFIRMED PHONE NUMBER
 * ========================================================================== */

alter table public.profiles
  add column if not exists phone_verified_at timestamptz;

comment on column public.profiles.phone_verified_at is
  'When the account holder proved they own this phone number. A number that is not confirmed is never shown to another party and never receives an SMS.';

/* The order receipt must not show a number nobody proved they own. */
create or replace function public.display_phone_for(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.phone_e164
  from public.profiles p
  where p.id = p_user
    and p.phone_verified_at is not null
    and p.phone_e164 is not null;
$$;
revoke all on function public.display_phone_for(uuid) from public, anon, authenticated;
grant execute on function public.display_phone_for(uuid) to service_role;

/* ========================================================================== *
 * 1a. THE AVATAR PATH
 *
 *    The avatar bucket already had policies, but nothing ever uploaded to
 *    it: the photo was kept in localStorage, so it did not follow the
 *    account to another device and died with the browser. The profile
 *    now stores the path to the stored file, and the column is granted
 *    for update so the owner can change their own photo.
 * ========================================================================== */

alter table public.profiles
  add column if not exists avatar_path text;

do $$
begin
  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.profiles'::regclass
      and attname = 'avatar_path'
      and attnotnull
  ) then
    alter table public.profiles alter column avatar_path drop not null;
  end if;
end
$$;

grant update (display_name, phone_e164, avatar_path) on public.profiles to authenticated;

/* Record that the account holder confirmed this phone number.

   The caller is the service role, and it only calls this after reading
   Supabase Auth's own phone_confirmed_at. The browser's word is not
   evidence. */
create or replace function public.mark_phone_verified(p_user uuid, p_phone text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if p_user is null then
    raise exception 'A user is required' using errcode = 'P0001';
  end if;

  -- The number must be in the E.164 shape, because it is going to be
  -- messaged and dialled.
  if p_phone is null or btrim(p_phone) !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'That is not a valid phone number' using errcode = 'P0001';
  end if;

  update public.profiles
  set phone_e164 = btrim(p_phone),
      phone_verified_at = now(),
      updated_at = now()
  where id = p_user
  returning phone_verified_at into v_at;

  if v_at is null then
    raise exception 'Profile not found' using errcode = 'P0002';
  end if;

  insert into public.activity_events (user_id, kind, payload)
  values (p_user, 'security_events', jsonb_build_object('event', 'phone_verified'));

  return v_at;
end;
$$;
revoke all on function public.mark_phone_verified(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_phone_verified(uuid, text) to service_role;

/* ========================================================================== *
 * 2. EMAIL SUPPRESSIONS
 *
 *    An address that hard-bounces is never mailed again. Without this a
 *    bad address is retried on every notification, which is slow, and it
 *    damages the sending reputation of the domain.
 * ========================================================================== */

create table if not exists public.email_suppressions (
  email text primary key check (email = lower(btrim(email))),
  reason text not null default 'bounced' check (reason in ('bounced', 'complained', 'invalid', 'manual')),
  provider text,
  detail text check (detail is null or char_length(detail) <= 500),
  created_at timestamptz not null default now()
);

alter table public.email_suppressions enable row level security;
revoke all on public.email_suppressions from anon, authenticated;
grant select on public.email_suppressions to authenticated;

drop policy if exists email_suppressions_read_staff on public.email_suppressions;
create policy email_suppressions_read_staff on public.email_suppressions
  for select to authenticated using (public.is_internal_staff());

/* Record a suppression. The provider webhook calls this. */
create or replace function public.suppress_email(
  p_email text,
  p_reason text default 'bounced',
  p_provider text default null,
  p_detail text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_email = '' then
    return false;
  end if;
  insert into public.email_suppressions (email, reason, provider, detail)
  values (v_email, coalesce(p_reason, 'bounced'), p_provider, nullif(left(coalesce(p_detail, ''), 500), ''))
  on conflict (email) do update
    set reason = excluded.reason,
        detail = excluded.detail,
        created_at = now();
  return true;
end;
$$;
revoke all on function public.suppress_email(text, text, text, text) from public, anon, authenticated;
grant execute on function public.suppress_email(text, text, text, text) to service_role;

/* The address lookup now refuses a suppressed address. */
create or replace function public.email_address_for(p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select u.email into v_email
  from auth.users u
  where u.id = p_user;

  if v_email is null or btrim(v_email) = '' then
    return null;
  end if;

  -- An unconfirmed address is a typo. Sending to it burns the sending
  -- reputation for the domain.
  if not exists (
    select 1 from auth.users u
    where u.id = p_user and u.email_confirmed_at is not null
  ) then
    return null;
  end if;

  v_email := lower(btrim(v_email));

  -- A hard bounce or a complaint means never email this address again.
  if exists (select 1 from public.email_suppressions s where s.email = v_email) then
    return null;
  end if;

  return v_email;
end;
$$;
revoke all on function public.email_address_for(uuid) from public, anon, authenticated;
grant execute on function public.email_address_for(uuid) to service_role;

/* ========================================================================== *
 * 3. THE UNSUBSCRIBE LINK
 * ========================================================================== */

create table if not exists public.notification_unsubscribe_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  category text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create index if not exists notification_unsubscribe_tokens_user_idx
  on public.notification_unsubscribe_tokens (user_id, category);

alter table public.notification_unsubscribe_tokens enable row level security;
revoke all on public.notification_unsubscribe_tokens from anon, authenticated;

/* The token is the authorisation for the unsubscribe, so it is
   unguessable and it is the only thing needed. It is reusable, so a
   customer can unsubscribe from a category and then subscribe again
   from the app. */
create or replace function public.unsubscribe_token_for(p_user uuid, p_category text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select t.id into v_id
  from public.notification_unsubscribe_tokens t
  where t.user_id = p_user and t.category = p_category
  limit 1;

  if v_id is null then
    insert into public.notification_unsubscribe_tokens (user_id, category)
    values (p_user, p_category)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;
revoke all on function public.unsubscribe_token_for(uuid, text) from public, anon, authenticated;
grant execute on function public.unsubscribe_token_for(uuid, text) to service_role;

/* Consume a token. Anyone holding it may use it, which is the point: the
   link works from an inbox, with no sign-in. */
create or replace function public.consume_unsubscribe_token(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.notification_unsubscribe_tokens%rowtype;
begin
  select t.* into v_row
  from public.notification_unsubscribe_tokens t
  where t.id = p_token;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'This link is not valid.');
  end if;

  insert into public.notification_preferences (user_id, category, email)
  values (v_row.user_id, v_row.category, false)
  on conflict (user_id, category) do update set email = false;

  update public.notification_unsubscribe_tokens
  set used_at = now()
  where id = p_token;

  return jsonb_build_object(
    'ok', true,
    'category', v_row.category,
    'message', 'You will no longer receive email for this category.');
end;
$$;
revoke all on function public.consume_unsubscribe_token(uuid) from public, anon, authenticated;
grant execute on function public.consume_unsubscribe_token(uuid) to anon, authenticated;

/* ========================================================================== *
 * 4. THE EMAIL TEMPLATE GETS THE LINK
 * ========================================================================== */

create or replace function public.render_notification_email(p_notification_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_html text;
  v_text text;
  v_app_url text;
  v_token uuid;
  v_unsub text;
begin
  select n.title, n.body, n.link, n.category, n.priority, n.created_at, n.user_id
    into v_row
  from public.notifications n
  where n.id = p_notification_id;

  if not found then
    return null;
  end if;

  v_app_url := coalesce(
    (select value ->> 'app_url' from public.app_settings where key = 'app'),
    'https://kobemweusi.co.tz');

  -- The unsubscribe link, one per category, so the same token can be
  -- reused across every email of that category.
  v_token := public.unsubscribe_token_for(v_row.user_id, v_row.category);
  v_unsub := v_app_url || '/unsubscribe.html?token=' || v_token::text;

  v_text := v_row.body
    || E'\n\nTo stop receiving email like this, open: ' || v_unsub;

  v_html := format(
    '<!doctype html><html><body style="margin:0;padding:24px 12px;background:#F7F6F0;font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,sans-serif;color:#16231B;">' ||
    '<div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #E3E7E0;border-radius:16px;overflow:hidden;">' ||
    '<div style="background:#16231B;padding:18px 24px;"><span style="color:#F7F6F0;font-weight:800;letter-spacing:.02em;font-size:15px;">KOBE MWEUSI</span></div>' ||
    '<div style="padding:24px;">' ||
    '<h1 style="margin:0 0 10px;font-size:18px;line-height:1.35;font-weight:800;">%s</h1>' ||
    '<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4A5A51;">%s</p>' ||
    (case when v_row.link is not null and v_row.link <> '' then
       format('<a href="%s%s" style="display:inline-block;background:#16231B;color:#F7F6F0;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:10px;">Open in the app</a>', v_app_url, v_row.link)
     else '' end) ||
    '<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #E3E7E0;font-size:12px;line-height:1.6;color:#7C8A81;">' ||
    'You are getting this because of activity on your Kobe Mweusi account. ' ||
    '<a href="%s" style="color:#3F6B4A;">Stop receiving email like this</a>.' ||
    '</p></div></div>' ||
    '<p style="max-width:560px;margin:14px auto 0;font-size:11px;color:#8A968D;text-align:center;">' ||
    'Kobe Mweusi · Dar es Salaam, Tanzania</p></body></html>',
    v_row.title,
    v_row.body,
    v_unsub
  );

  return jsonb_build_object(
    'title', v_row.title,
    'body', v_row.body,
    'html', v_html,
    'text', v_text,
    'category', v_row.category,
    'priority', v_row.priority,
    'unsubscribe_url', v_unsub
  );
end;
$$;
revoke all on function public.render_notification_email(uuid) from public, anon, authenticated;
grant execute on function public.render_notification_email(uuid) to service_role;

commit;
