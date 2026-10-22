/* Kobe Mweusi — the email channel.

   The delivery queue already exists (notification_deliveries, one row per
   channel). This adds what the email channel needs:

     * the non-secret provider settings, so an administrator can turn
       email on and set the from address without a code change
     * the lookup of a user's email address, which lives in auth.users
       and must never be copied into public
     * the rendering of a notification into an email, so every email
       looks the same

   THE API KEY IS NOT IN THE DATABASE
   ----------------------------------
   The provider key is an Edge Function secret, set with
   `supabase secrets set RESEND_API_KEY=...`. It is read from the
   environment at send time and is never written to a table, never
   logged, and never sent to the browser.

   WHO GETS AN EMAIL
   -----------------
   Only the events whose rules list 'email'. The rules are data, in
   public.notification_rules, so which events reach a mailbox is an
   administrator's decision rather than a deployment. A chat message
   never sends an email.
*/

begin;

/* ========================================================================== *
 * 1. THE PROVIDER SETTINGS
 * ========================================================================== */

create table if not exists public.email_provider_config (
  provider text primary key check (provider in ('resend')),
  is_enabled boolean not null default false,
  from_name text not null default 'Kobe Mweusi',
  from_email text,
  reply_to text,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

alter table public.email_provider_config enable row level security;
revoke all on public.email_provider_config from anon, authenticated;
grant select on public.email_provider_config to authenticated;

drop policy if exists email_provider_config_read_staff on public.email_provider_config;
create policy email_provider_config_read_staff on public.email_provider_config
  for select to authenticated using (public.is_internal_staff());

drop trigger if exists email_provider_config_set_updated_at on public.email_provider_config;
create trigger email_provider_config_set_updated_at
  before update on public.email_provider_config
  for each row execute function public.set_updated_at();

insert into public.email_provider_config (provider, is_enabled, from_name)
values ('resend', false, 'Kobe Mweusi')
on conflict (provider) do nothing;

/* ========================================================================== *
 * 2. THE EMAIL ADDRESS
 *
 *    It lives in auth.users, which the public schema cannot read. This
 *    function is the only way to get it, and it is only for the
 *    service role.
 * ========================================================================== */

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

  -- Never send to an address that has not been confirmed. An unconfirmed
  -- address is a typo, and sending to it burns the sending reputation.
  if not exists (
    select 1 from auth.users u
    where u.id = p_user and u.email_confirmed_at is not null
  ) then
    return null;
  end if;

  return lower(btrim(v_email));
end;
$$;
revoke all on function public.email_address_for(uuid) from public, anon, authenticated;
grant execute on function public.email_address_for(uuid) to service_role;

/* ========================================================================== *
 * 3. RENDERING AN EMAIL
 *
 *    One template for every email, so they look the same and a change
 *    to the brand reaches all of them.
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

  v_text := v_row.body;

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
    '<p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#7C8A81;">' ||
    'This message was sent because of an activity on your Kobe Mweusi account. ' ||
    'You can change what you hear about in Notification settings in the app.' ||
    '</p></div></div>' ||
    '<p style="max-width:560px;margin:14px auto 0;font-size:11px;color:#8A968D;text-align:center;">' ||
    'Kobe Mweusi · Dar es Salaam, Tanzania</p></body></html>',
    v_row.title,
    v_row.body
  );

  return jsonb_build_object(
    'title', v_row.title,
    'body', v_row.body,
    'html', v_html,
    'text', v_text,
    'category', v_row.category,
    'priority', v_row.priority
  );
end;
$$;
revoke all on function public.render_notification_email(uuid) from public, anon, authenticated;
grant execute on function public.render_notification_email(uuid) to service_role;

commit;
