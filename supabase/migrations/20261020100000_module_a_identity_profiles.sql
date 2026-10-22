/* Kobe Mweusi — Module A: authentication, profiles and account security.

   Account model (agreed):
     * One account may be both a buyer AND a seller.
     * Sign-in: phone/email with password, plus verified email confirmation.
     * A seller is a user who owns a row in seller_profiles. `profiles.account_type`
       records the account a user registered as, and is NOT a permission gate:
       the real seller capability is "does seller_profiles exist for this user".

   Passwords, OTPs, recovery tokens and access tokens are NEVER stored in
   application tables. Supabase Auth owns all of that.

   Tables added here
     user_settings             theme, language, privacy and user preferences
     user_devices              registered devices and last-seen timestamps
     user_consents             terms / privacy acceptance with version history
     account_security_events   security events without secrets

   Functions added here
     update_my_profile()          update permitted profile fields
     close_my_account()           controlled account-closure workflow
     admin_suspend_account()      administrative suspension with audit trail
     get_my_preferences()         read the merged settings row
     record_account_security_event()
*/

/* ========================================================================== *
 * 1. PROFILE STATUS
 * ========================================================================== */

do $$
begin
  if not exists (select 1 from pg_type where typname = 'profile_status') then
    create type public.profile_status as enum ('active', 'suspended', 'closed');
  end if;
end
$$;

alter table public.profiles
  add column if not exists status public.profile_status not null default 'active';

alter table public.profiles
  add column if not exists locale text not null default 'en';

alter table public.profiles
  add column if not exists suspended_at timestamptz;

alter table public.profiles
  add column if not exists suspension_reason text;

alter table public.profiles
  add column if not exists closed_at timestamptz;

alter table public.profiles
  add column if not exists avatar_path text;

create index if not exists profiles_status_idx on public.profiles (status)
  where status <> 'active';

/* ========================================================================== *
 * 2. USER SETTINGS
 * ========================================================================== */

create table if not exists public.user_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  theme text not null default 'dark'
    check (theme in ('dark', 'light', 'emerald', 'midnight', 'system')),
  language text not null default 'en' check (language in ('en', 'sw')),
  push_enabled boolean not null default true,
  email_enabled boolean not null default true,
  sms_enabled boolean not null default true,
  order_updates boolean not null default true,
  chat_updates boolean not null default true,
  marketing_updates boolean not null default false,
  two_factor_required boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;
revoke all on public.user_settings from anon, authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;

drop policy if exists user_settings_own on public.user_settings;
create policy user_settings_own on public.user_settings
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

/* ========================================================================== *
 * 3. USER DEVICES
 * ========================================================================== */

create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  device_label text not null check (char_length(device_label) between 1 and 80),
  platform text check (platform is null or platform in ('web', 'android', 'ios', 'desktop')),
  device_fingerprint text,
  push_endpoint text,
  trusted boolean not null default false,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists user_devices_fingerprint_idx
  on public.user_devices (user_id, device_fingerprint)
  where device_fingerprint is not null and revoked_at is null;

create index if not exists user_devices_user_seen_idx
  on public.user_devices (user_id, last_seen_at desc);

alter table public.user_devices enable row level security;
revoke all on public.user_devices from anon, authenticated;
grant select, insert, update, delete on public.user_devices to authenticated;

drop policy if exists user_devices_own on public.user_devices;
create policy user_devices_own on public.user_devices
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

/* ========================================================================== *
 * 4. USER CONSENTS
 * ========================================================================== */

create table if not exists public.user_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  consent_type text not null
    check (consent_type in ('terms_of_service', 'privacy_policy', 'transaction_pins', 'data_processing')),
  version text not null check (char_length(version) between 1 and 40),
  accepted boolean not null default true,
  accepted_at timestamptz not null default now(),
  ip_hash text,
  user_agent text,
  unique (user_id, consent_type, version)
);

create index if not exists user_consents_user_idx
  on public.user_consents (user_id, consent_type, accepted_at desc);

alter table public.user_consents enable row level security;
revoke all on public.user_consents from anon, authenticated;
grant select, insert on public.user_consents to authenticated;

drop policy if exists user_consents_select_own on public.user_consents;
create policy user_consents_select_own on public.user_consents
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists user_consents_insert_own on public.user_consents;
create policy user_consents_insert_own on public.user_consents
  for insert to authenticated
  with check (user_id = (select auth.uid()));

/* ========================================================================== *
 * 5. ACCOUNT SECURITY EVENTS
 * ========================================================================== */

create table if not exists public.account_security_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  event_type text not null
    check (event_type in (
      'password_changed', 'password_reset_requested', 'password_reset_completed',
      'email_changed', 'phone_changed', 'new_device_signed_in', 'suspicious_login',
      'transaction_pin_set', 'transaction_pin_changed', 'transaction_pin_lockout',
      'account_suspended', 'account_reinstated', 'account_closed',
      'mfa_enrolled', 'mfa_disabled', 'session_revoked'
    )),
  severity text not null default 'info'
    check (severity in ('info', 'warning', 'critical')),
  device_label text,
  ip_hash text,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists account_security_events_user_idx
  on public.account_security_events (user_id, created_at desc);

alter table public.account_security_events enable row level security;
revoke all on public.account_security_events from anon, authenticated;
grant select on public.account_security_events to authenticated;

drop policy if exists account_security_events_select_own
  on public.account_security_events;
create policy account_security_events_select_own on public.account_security_events
  for select to authenticated using (user_id = (select auth.uid()));

/* ========================================================================== *
 * 6. FUNCTIONS
 * ========================================================================== */

/* Update the fields a user is allowed to change on their own profile.
   `account_type`, `status`, `id` and the suspension columns are never
   writable here — they are server or admin controlled. */
create or replace function public.update_my_profile(
  p_display_name text default null,
  p_phone_e164 text default null,
  p_locale text default null,
  p_avatar_path text default null
)
returns public.profiles
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_profile public.profiles%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  update public.profiles
    set display_name = coalesce(p_display_name, display_name),
        phone_e164 = case
          when p_phone_e164 is null then phone_e164
          else nullif(btrim(p_phone_e164), '')
        end,
        locale = coalesce(p_locale, locale),
        avatar_path = coalesce(p_avatar_path, avatar_path),
        updated_at = now()
    where id = v_user
    returning * into v_profile;

  if v_profile.id is null then
    raise exception 'Profile not found' using errcode = 'P0002';
  end if;

  return v_profile;
end;
$$;
grant execute on function public.update_my_profile(text, text, text, text) to authenticated;

/* Merge the user's own settings with the platform defaults. */
create or replace function public.get_my_preferences()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select to_jsonb(s) from public.user_settings s
      where s.user_id = (select auth.uid())),
    jsonb_build_object(
      'theme', 'dark', 'language', 'en', 'push_enabled', true,
      'email_enabled', true, 'sms_enabled', true, 'order_updates', true,
      'chat_updates', true, 'marketing_updates', false,
      'two_factor_required', false
    )
  );
$$;
grant execute on function public.get_my_preferences() to authenticated;

/* Record a security event. Never store secrets in `detail`. */
create or replace function public.record_account_security_event(
  p_user_id uuid,
  p_event_type text,
  p_severity text default 'info',
  p_device_label text default null,
  p_ip_hash text default null,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.account_security_events
    (user_id, event_type, severity, device_label, ip_hash, detail)
  values
    (p_user_id, p_event_type, coalesce(p_severity, 'info'),
     nullif(btrim(p_device_label), ''), p_ip_hash,
     coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.record_account_security_event(uuid, text, text, text, text, jsonb)
  from public, anon;
grant execute on function public.record_account_security_event(uuid, text, text, text, text, jsonb)
  to service_role;

/* Controlled account closure. Money is never deleted: outstanding escrow,
   pending payouts and open disputes must be settled first, otherwise the
   account is flagged for review instead of being closed. */
create or replace function public.close_my_account(p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_open_disputes integer;
  v_live_orders integer;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select count(*) into v_open_disputes
  from public.disputes d join public.orders o on o.id = d.order_id
  where d.status <> 'resolved'
    and (o.buyer_id = v_user or o.seller_id = v_user);

  select count(*) into v_live_orders
  from public.orders
  where status in ('awaiting_payment', 'in_escrow', 'delivered', 'disputed')
    and (buyer_id = v_user or seller_id = v_user);

  if v_open_disputes > 0 or v_live_orders > 0 then
    return jsonb_build_object(
      'ok', false,
      'reason', 'outstanding_activity',
      'open_disputes', v_open_disputes,
      'live_orders', v_live_orders,
      'message', 'Your account has open disputes or active orders. Support must settle them before the account can be closed.'
    );
  end if;

  update public.profiles
    set status = 'closed', closed_at = now(), updated_at = now()
    where id = v_user;

  perform public.record_account_security_event(
    v_user, 'account_closed', 'warning', null, null,
    jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), ''))
  );

  return jsonb_build_object('ok', true, 'closed_at', now());
end;
$$;
revoke all on function public.close_my_account(text) from public, anon;
grant execute on function public.close_my_account(text) to authenticated;

/* Administrative suspension. Requires a reason and writes an audit trail. */
create or replace function public.admin_suspend_account(
  p_user_id uuid,
  p_reason text,
  p_reviewer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid := coalesce(p_reviewer_id, (select auth.uid()));
  v_note text := nullif(btrim(p_reason), '');
  v_status public.profile_status;
begin
  if v_reviewer is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if v_note is null then
    raise exception 'A reason is required to suspend an account' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_reviewer and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Reviewer is not authorized' using errcode = '42501';
  end if;

  select status into v_status from public.profiles where id = p_user_id for update;
  if v_status is null then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  if v_status = 'closed' then
    raise exception 'A closed account cannot be suspended' using errcode = 'P0001';
  end if;

  update public.profiles
    set status = 'suspended', suspended_at = now(),
        suspension_reason = v_note, updated_at = now()
    where id = p_user_id;

  perform public.record_account_security_event(
    p_user_id, 'account_suspended', 'critical', null, null,
    jsonb_build_object('reason', v_note, 'reviewer', v_reviewer)
  );

  insert into public.activity_events (user_id, kind, payload)
  values (p_user_id, 'support_update',
    jsonb_build_object('title', 'Account suspended', 'reason', v_note));

  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'status', 'suspended');
end;
$$;
revoke all on function public.admin_suspend_account(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_suspend_account(uuid, text, uuid) to service_role;

/* Reinstate a suspended account. */
create or replace function public.admin_reinstate_account(
  p_user_id uuid,
  p_reason text,
  p_reviewer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid := coalesce(p_reviewer_id, (select auth.uid()));
  v_note text := nullif(btrim(p_reason), '');
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

  update public.profiles
    set status = 'active', suspended_at = null, suspension_reason = null,
        updated_at = now()
    where id = p_user_id and status = 'suspended';

  if not found then
    raise exception 'Account is not suspended' using errcode = 'P0001';
  end if;

  perform public.record_account_security_event(
    p_user_id, 'account_reinstated', 'info', null, null,
    jsonb_build_object('reason', v_note, 'reviewer', v_reviewer)
  );

  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'status', 'active');
end;
$$;
revoke all on function public.admin_reinstate_account(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_reinstate_account(uuid, text, uuid) to service_role;

/* A suspended or closed account must not be able to transact. */
create or replace function public.is_account_active(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user and p.status = 'active'
  );
$$;
revoke all on function public.is_account_active(uuid) from public, anon;
grant execute on function public.is_account_active(uuid) to service_role, authenticated;
