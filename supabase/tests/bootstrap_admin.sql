/* ========================================================================== *
 * BOOTSTRAP THE FIRST ADMIN
 *
 * There is no admin account until someone is promoted. Run this once,
 * against the live database, as service_role, after the first person has
 * signed up through the app.
 *
 * Replace <email> with the real address. The script looks the user up by
 * email, so it works even if you do not know their UUID.
 *
 *   psql "$DATABASE_URL" -v email='ops@kobemweusi.co' \
 *        -f supabase/tests/bootstrap_admin.sql
 * ========================================================================== */

\set ON_ERROR_STOP on

do $$
declare
  v_email text := :'email';
  v_user uuid;
begin
  select id into v_user from auth.users where email = v_email;
  if v_user is null then
    raise exception 'No user with email %', v_email;
  end if;

  /* The platform has two admin layers:
       internal_user_roles  -- the application role (admin/support_agent)
       admin_employees      -- the HR record (name, department, status)
     Both are needed for the console to open. */

  insert into public.internal_user_roles (user_id, role)
  values (v_user, 'admin')
  on conflict (user_id, role) do nothing;

  insert into public.admin_employees (user_id, display_name, department, status)
  select v_user, coalesce(raw_user_meta_data->>'display_name', v_email), 'Operations', 'active'
  from auth.users where id = v_user
  on conflict (user_id) do update set status = 'active';

  raise notice 'Promoted % (%) to admin.', v_email, v_user;
  raise notice 'Sign in to admin.html with that account.';
end $$;
