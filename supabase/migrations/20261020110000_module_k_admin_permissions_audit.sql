/* Kobe Mweusi — Module K: admin console, employees and permissions.

   Internal staff access is separate from customer access. A CEO or Super
   Admin may have broad authority, but sensitive actions are still
   recorded, and high-impact actions support two-person approval.

   The existing `internal_user_roles` table stays the source of truth for
   the coarse role. This module adds the fine-grained permission layer on
   top of it.

   Tables added here
     admin_permissions          permission definitions
     internal_role_permissions  role to permission mapping
     employee_profiles          employee details and employment status
     admin_invitations          controlled employee onboarding
     admin_mfa_requirements     application policy for required MFA
     audit_logs                 sensitive administrative action history
     admin_approval_requests    dual approval for high-risk actions

   Functions added here
     has_permission(), grant_permission(), revoke_permission(),
     request_admin_approval(), approve_admin_request(), reject_admin_request(),
     log_audit(), audit_log_page(), invite_employee(), accept_invitation(),
     set_admin_role()
*/

create table if not exists public.admin_permissions (
  permission text primary key check (char_length(permission) between 3 and 60),
  description text not null,
  is_high_risk boolean not null default false,
  requires_dual_approval boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.admin_permissions enable row level security;
revoke all on public.admin_permissions from anon, authenticated;
grant select on public.admin_permissions to authenticated;

create table if not exists public.internal_role_permissions (
  role text not null check (role in ('support_agent', 'admin', 'agent')),
  permission text not null references public.admin_permissions (permission) on delete cascade,
  granted_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (role, permission)
);

alter table public.internal_role_permissions enable row level security;
revoke all on public.internal_role_permissions from anon, authenticated;
grant select on public.internal_role_permissions to authenticated;

create table if not exists public.employee_profiles (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  employee_code text unique check (employee_code is null or employee_code ~ '^KOBE-EMP-[0-9]{4}$'),
  job_title text,
  department text,
  employment_status text not null default 'active'
    check (employment_status in ('active', 'on_leave', 'suspended', 'terminated')),
  hired_on date,
  manager_user_id uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employee_profiles enable row level security;
revoke all on public.employee_profiles from anon, authenticated;
grant select on public.employee_profiles to authenticated;

drop policy if exists employee_profiles_select_own_or_staff on public.employee_profiles;
create policy employee_profiles_select_own_or_staff on public.employee_profiles
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_internal_staff());

create table if not exists public.admin_invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role text not null check (role in ('support_agent', 'admin')),
  permissions text[] not null default '{}'::text[],
  token_hash text not null unique,
  invited_by uuid not null references public.profiles (id),
  accepted_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists admin_invitations_email_idx on public.admin_invitations (email, created_at desc);

alter table public.admin_invitations enable row level security;
revoke all on public.admin_invitations from anon, authenticated;

create table if not exists public.admin_mfa_requirements (
  role text not null check (role in ('support_agent', 'admin', 'agent')),
  mfa_required boolean not null default true,
  enforced_from timestamptz not null default now(),
  primary key (role)
);

alter table public.admin_mfa_requirements enable row level security;
revoke all on public.admin_mfa_requirements from anon, authenticated;
grant select on public.admin_mfa_requirements to authenticated;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id),
  actor_role text,
  action text not null check (char_length(action) between 3 and 80),
  target_type text,
  target_id uuid,
  target_user_id uuid references public.profiles (id),
  reason text check (reason is null or char_length(reason) <= 1000),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  ip_hash text,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);
create index if not exists audit_logs_action_idx on public.audit_logs (action, created_at desc);
create index if not exists audit_logs_target_idx on public.audit_logs (target_user_id, created_at desc);

alter table public.audit_logs enable row level security;
revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;

drop policy if exists audit_logs_select_staff on public.audit_logs;
create policy audit_logs_select_staff on public.audit_logs
  for select to authenticated using (public.is_internal_staff());

create table if not exists public.admin_approval_requests (
  id uuid primary key default gen_random_uuid(),
  action text not null check (char_length(action) between 3 and 80),
  requested_by uuid not null references public.profiles (id),
  approved_by uuid references public.profiles (id),
  target_user_id uuid references public.profiles (id),
  target_id uuid,
  amount_tzs bigint check (amount_tzs is null or amount_tzs > 0),
  payload jsonb not null default '{}'::jsonb,
  reason text not null check (char_length(reason) between 5 and 1000),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'executed', 'expired')),
  decided_at timestamptz,
  executed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '48 hours'),
  created_at timestamptz not null default now()
);

create index if not exists admin_approval_requests_pending_idx
  on public.admin_approval_requests (status, created_at)
  where status = 'pending';

alter table public.admin_approval_requests enable row level security;
revoke all on public.admin_approval_requests from anon, authenticated;
grant select on public.admin_approval_requests to authenticated;

drop policy if exists admin_approval_requests_select_staff on public.admin_approval_requests;
create policy admin_approval_requests_select_staff on public.admin_approval_requests
  for select to authenticated using (public.is_internal_staff());

/* ========================================================================== *
 * 1. PERMISSION CATALOGUE
 * ========================================================================== */

insert into public.admin_permissions (permission, description, is_high_risk, requires_dual_approval) values
  ('users.view',                'View customer accounts', false, false),
  ('users.suspend',             'Suspend or reinstate a customer account', true, false),
  ('kyc.view',                  'View KYC submissions', false, false),
  ('kyc.review',                'Move a KYC submission into review', false, false),
  ('kyc.approve',               'Approve or reject a KYC submission', true, false),
  ('orders.view',               'View any order', false, false),
  ('orders.cancel',             'Cancel an order', true, false),
  ('disputes.view',             'View disputes', false, false),
  ('disputes.review',           'Assign and decide disputes', true, false),
  ('disputes.resolve',          'Execute the financial outcome of a dispute', true, true),
  ('escrow.release',            'Release escrow to a seller', true, true),
  ('escrow.hold',               'Place or lift an escrow hold', true, false),
  ('payouts.view',              'View payout requests', false, false),
  ('payouts.approve',           'Approve a seller payout', true, true),
  ('wallets.adjust',            'Apply a financial adjustment to a wallet', true, true),
  ('refunds.approve',           'Approve a refund', true, false),
  ('audit_logs.view',           'View the audit log', false, false),
  ('employees.manage',          'Invite and manage employees', true, false),
  ('system.settings.manage',    'Change application settings', true, false),
  ('agents.manage',             'Verify and manage delivery agents', true, false)
on conflict (permission) do nothing;

insert into public.internal_role_permissions (role, permission) values
  ('support_agent', 'users.view'),
  ('support_agent', 'kyc.view'),
  ('support_agent', 'kyc.review'),
  ('support_agent', 'orders.view'),
  ('support_agent', 'disputes.view'),
  ('support_agent', 'disputes.review'),
  ('support_agent', 'payouts.view'),
  ('support_agent', 'audit_logs.view'),
  ('support_agent', 'agents.manage'),
  ('admin', 'users.view'),
  ('admin', 'users.suspend'),
  ('admin', 'kyc.view'),
  ('admin', 'kyc.review'),
  ('admin', 'kyc.approve'),
  ('admin', 'orders.view'),
  ('admin', 'orders.cancel'),
  ('admin', 'disputes.view'),
  ('admin', 'disputes.review'),
  ('admin', 'disputes.resolve'),
  ('admin', 'escrow.release'),
  ('admin', 'escrow.hold'),
  ('admin', 'payouts.view'),
  ('admin', 'payouts.approve'),
  ('admin', 'wallets.adjust'),
  ('admin', 'refunds.approve'),
  ('admin', 'audit_logs.view'),
  ('admin', 'employees.manage'),
  ('admin', 'system.settings.manage'),
  ('admin', 'agents.manage')
on conflict (role, permission) do nothing;

insert into public.admin_mfa_requirements (role, mfa_required) values
  ('support_agent', false),
  ('admin', true),
  ('agent', false)
on conflict (role) do nothing;

/* ========================================================================== *
 * 2. PERMISSION CHECKS
 * ========================================================================== */

/* Does a user hold a permission through any of their internal roles? */
create or replace function public.has_permission(p_user uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.internal_user_roles r
    join public.internal_role_permissions rp on rp.role = r.role
    where r.user_id = p_user and rp.permission = p_permission
  );
$$;
revoke all on function public.has_permission(uuid, text) from public, anon;
grant execute on function public.has_permission(uuid, text) to authenticated, service_role;

/* Does the signed-in user hold a permission? */
create or replace function public.i_have_permission(p_permission text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select public.has_permission((select auth.uid()), p_permission);
$$;
grant execute on function public.i_have_permission(text) to authenticated;

/* Grant or revoke a permission for a role. */
create or replace function public.grant_permission(
  p_role text,
  p_permission text,
  p_granted_by uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = coalesce(p_granted_by, (select auth.uid())) and r.role = 'admin'
  ) then
    raise exception 'Only an admin may change permissions' using errcode = '42501';
  end if;
  if not exists (select 1 from public.admin_permissions p where p.permission = p_permission) then
    raise exception 'Unknown permission' using errcode = 'P0001';
  end if;

  insert into public.internal_role_permissions (role, permission, granted_by)
  values (p_role, p_permission, coalesce(p_granted_by, (select auth.uid())))
  on conflict (role, permission) do nothing;

  return true;
end;
$$;
revoke all on function public.grant_permission(text, text, uuid) from public, anon, authenticated;
grant execute on function public.grant_permission(text, text, uuid) to service_role;

create or replace function public.revoke_permission(
  p_role text,
  p_permission text,
  p_revoked_by uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = coalesce(p_revoked_by, (select auth.uid())) and r.role = 'admin'
  ) then
    raise exception 'Only an admin may change permissions' using errcode = '42501';
  end if;

  delete from public.internal_role_permissions
    where role = p_role and permission = p_permission;

  return true;
end;
$$;
revoke all on function public.revoke_permission(text, text, uuid) from public, anon, authenticated;
grant execute on function public.revoke_permission(text, text, uuid) to service_role;

/* ========================================================================== *
 * 3. AUDIT LOG
 * ========================================================================== */

create or replace function public.log_audit(
  p_action text,
  p_target_type text default null,
  p_target_id uuid default null,
  p_target_user_id uuid default null,
  p_reason text default null,
  p_detail jsonb default '{}'::jsonb,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(p_actor_id, (select auth.uid()));
  v_id uuid;
  v_role text;
begin
  select r.role into v_role
  from public.internal_user_roles r
  where r.user_id = v_actor
  order by case r.role when 'admin' then 0 else 1 end
  limit 1;

  insert into public.audit_logs
    (actor_id, actor_role, action, target_type, target_id, target_user_id, reason, detail)
  values
    (v_actor, v_role, p_action, p_target_type, p_target_id, p_target_user_id,
     nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.log_audit(text, text, uuid, uuid, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.log_audit(text, text, uuid, uuid, text, jsonb, uuid) to service_role;

create or replace function public.audit_log_page(
  p_limit integer default 50,
  p_offset integer default 0,
  p_action text default null
)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id,
    'actor_id', a.actor_id,
    'actor_role', a.actor_role,
    'action', a.action,
    'target_type', a.target_type,
    'target_id', a.target_id,
    'target_user_id', a.target_user_id,
    'reason', a.reason,
    'detail', a.detail,
    'created_at', a.created_at
  )
  from public.audit_logs a
  where (p_action is null or a.action = p_action)
  order by a.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function public.audit_log_page(integer, integer, text) from public, anon, authenticated;
grant execute on function public.audit_log_page(integer, integer, text) to service_role;

/* ========================================================================== *
 * 4. DUAL APPROVAL
 * ========================================================================== */

create or replace function public.request_admin_approval(
  p_action text,
  p_reason text,
  p_target_user_id uuid default null,
  p_target_id uuid default null,
  p_amount_tzs bigint default null,
  p_payload jsonb default '{}'::jsonb
)
returns public.admin_approval_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_request public.admin_approval_requests%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A reason is required' using errcode = 'P0001';
  end if;

  insert into public.admin_approval_requests
    (action, requested_by, target_user_id, target_id, amount_tzs, payload, reason)
  values
    (p_action, v_user, p_target_user_id, p_target_id, p_amount_tzs,
     coalesce(p_payload, '{}'::jsonb), btrim(p_reason))
  returning * into v_request;

  perform public.log_audit('approval.requested', 'admin_approval_request', v_request.id,
    p_target_user_id, p_reason, jsonb_build_object('action', p_action, 'amount', p_amount_tzs), v_user);

  return v_request;
end;
$$;
revoke all on function public.request_admin_approval(text, text, uuid, uuid, bigint, jsonb)
  from public, anon;
grant execute on function public.request_admin_approval(text, text, uuid, uuid, bigint, jsonb)
  to authenticated, service_role;

/* Approve a request. The approver must be a different person from the
   requester: that is the point of two-person approval. */
create or replace function public.approve_admin_request(
  p_request_id uuid,
  p_approver_id uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approver uuid := coalesce(p_approver_id, (select auth.uid()));
  v_request public.admin_approval_requests%rowtype;
begin
  if v_approver is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.has_permission(v_approver, 'system.settings.manage') then
    raise exception 'Approver does not hold the required permission' using errcode = '42501';
  end if;

  select r.* into v_request from public.admin_approval_requests r
  where r.id = p_request_id for update;

  if not found then
    raise exception 'Approval request not found' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This request has already been decided' using errcode = 'P0001';
  end if;
  if v_request.requested_by = v_approver then
    raise exception 'A request must be approved by a different person' using errcode = 'P0001';
  end if;
  if v_request.expires_at <= now() then
    update public.admin_approval_requests
      set status = 'expired', decided_at = now()
      where id = p_request_id;
    raise exception 'This request has expired' using errcode = 'P0001';
  end if;

  update public.admin_approval_requests
    set status = 'approved', approved_by = v_approver, decided_at = now()
    where id = p_request_id;

  perform public.log_audit('approval.approved', 'admin_approval_request', p_request_id,
    v_request.target_user_id, p_note, jsonb_build_object('action', v_request.action), v_approver);

  return jsonb_build_object('ok', true, 'request_id', p_request_id, 'status', 'approved');
end;
$$;
revoke all on function public.approve_admin_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_admin_request(uuid, uuid, text) to service_role;

create or replace function public.reject_admin_request(
  p_request_id uuid,
  p_rejecter_id uuid default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rejecter uuid := coalesce(p_rejecter_id, (select auth.uid()));
begin
  if v_rejecter is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  update public.admin_approval_requests
    set status = 'rejected', approved_by = v_rejecter, decided_at = now()
    where id = p_request_id and status = 'pending';

  if not found then
    raise exception 'Approval request not found or already decided' using errcode = 'P0002';
  end if;

  perform public.log_audit('approval.rejected', 'admin_approval_request', p_request_id,
    null, p_note, '{}'::jsonb, v_rejecter);

  return jsonb_build_object('ok', true, 'request_id', p_request_id, 'status', 'rejected');
end;
$$;
revoke all on function public.reject_admin_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reject_admin_request(uuid, uuid, text) to service_role;

/* ========================================================================== *
 * 5. EMPLOYEES AND INVITATIONS
 * ========================================================================== */

create or replace function public.invite_employee(
  p_email text,
  p_role text,
  p_permissions text[] default '{}'::text[],
  p_token_hash text default null,
  p_expires_at timestamptz default null
)
returns public.admin_invitations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_invitation public.admin_invitations%rowtype;
  v_token text := coalesce(p_token_hash, replace(gen_random_uuid()::text, '-', ''));
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.has_permission(v_user, 'employees.manage') then
    raise exception 'Only an admin may invite employees' using errcode = '42501';
  end if;
  if p_role not in ('support_agent', 'admin') then
    raise exception 'Role must be support_agent or admin' using errcode = 'P0001';
  end if;

  insert into public.admin_invitations
    (email, role, permissions, token_hash, invited_by, expires_at)
  values
    (lower(btrim(p_email)), p_role, coalesce(p_permissions, '{}'::text[]), v_token, v_user,
     coalesce(p_expires_at, now() + interval '7 days'))
  returning * into v_invitation;

  perform public.log_audit('employee.invited', 'admin_invitation', v_invitation.id, null,
    'invited ' || p_email, jsonb_build_object('role', p_role), v_user);

  return v_invitation;
end;
$$;
revoke all on function public.invite_employee(text, text, text[], text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.invite_employee(text, text, text[], text, timestamptz) to service_role;

/* Accept an invitation. The user id comes from the signed-in account, and
   the invitation is claimed only if it matches that account's email. */
create or replace function public.accept_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_invitation public.admin_invitations%rowtype;
  v_email text;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select i.* into v_invitation from public.admin_invitations i
  where i.token_hash = p_token_hash for update;

  if not found then
    raise exception 'This invitation is not valid' using errcode = 'P0002';
  end if;
  if v_invitation.accepted_at is not null then
    raise exception 'This invitation was already used' using errcode = 'P0001';
  end if;
  if v_invitation.revoked_at is not null then
    raise exception 'This invitation was revoked' using errcode = 'P0001';
  end if;
  if v_invitation.expires_at <= now() then
    raise exception 'This invitation has expired' using errcode = 'P0001';
  end if;

  select lower(coalesce(u.email, '')) into v_email from auth.users u where u.id = v_user;
  if v_email is null or v_email <> v_invitation.email then
    raise exception 'This invitation was issued to a different email address'
      using errcode = '42501';
  end if;

  insert into public.internal_user_roles (user_id, role)
  values (v_user, v_invitation.role)
  on conflict (user_id, role) do nothing;

  update public.admin_invitations
    set accepted_at = now()
    where id = v_invitation.id;

  insert into public.employee_profiles (user_id, employment_status)
  values (v_user, 'active')
  on conflict (user_id) do nothing;

  perform public.log_audit('employee.invitation_accepted', 'admin_invitation',
    v_invitation.id, v_user, null, jsonb_build_object('role', v_invitation.role), v_user);

  return jsonb_build_object('ok', true, 'role', v_invitation.role);
end;
$$;
revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;

/* Set an internal role. Always audited, never self-service. */
create or replace function public.set_admin_role(
  p_user_id uuid,
  p_role text,
  p_reason text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(p_actor_id, (select auth.uid()));
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.has_permission(v_actor, 'employees.manage') then
    raise exception 'Only an admin may change internal roles' using errcode = '42501';
  end if;
  if p_role not in ('support_agent', 'admin', 'agent') then
    raise exception 'Unknown role' using errcode = 'P0001';
  end if;

  insert into public.internal_user_roles (user_id, role)
  values (p_user_id, p_role)
  on conflict (user_id, role) do nothing;

  perform public.log_audit('role.granted', 'profile', p_user_id, p_user_id, p_reason,
    jsonb_build_object('role', p_role), v_actor);

  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'role', p_role);
end;
$$;
revoke all on function public.set_admin_role(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.set_admin_role(uuid, text, text, uuid) to service_role;

/* Remove an internal role. */
create or replace function public.remove_admin_role(
  p_user_id uuid,
  p_role text,
  p_reason text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := coalesce(p_actor_id, (select auth.uid()));
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.has_permission(v_actor, 'employees.manage') then
    raise exception 'Only an admin may change internal roles' using errcode = '42501';
  end if;

  delete from public.internal_user_roles where user_id = p_user_id and role = p_role;

  perform public.log_audit('role.revoked', 'profile', p_user_id, p_user_id, p_reason,
    jsonb_build_object('role', p_role), v_actor);

  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'role', p_role);
end;
$$;
revoke all on function public.remove_admin_role(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.remove_admin_role(uuid, text, text, uuid) to service_role;
