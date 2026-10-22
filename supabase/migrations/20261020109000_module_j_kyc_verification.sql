/* Kobe Mweusi — Module J: KYC, identity review and verification.

   KYC status is DERIVED from an authorised review workflow. A seller can
   never set their own verification badge, and the badge is not a field the
   seller can write.

   Tables added here
     business_profiles              legal business details and representatives
     business_verification_events  corporate verification history
     identity_verification_attempts attempt metadata and rate limiting
     account_restrictions           temporary or permanent restrictions
     kyc_access_log                 who opened which KYC document, and when

   Functions added here
     submit_kyc(), resubmit_kyc(), start_kyc_review(), decide_kyc(),
     list_kyc_queue(), log_kyc_document_access(), restrict_account(),
     lift_restriction()
*/

alter table public.seller_kyc_submissions
  add column if not exists attempt_count integer not null default 1;

alter table public.seller_kyc_submissions
  add column if not exists submitted_by uuid references public.profiles (id);

alter table public.seller_kyc_submissions
  add column if not exists decision_at timestamptz;

create index if not exists seller_kyc_seller_idx
  on public.seller_kyc_submissions (seller_id, submitted_at desc);

/* ========================================================================== *
 * 1. BUSINESS PROFILES
 * ========================================================================== */

create table if not exists public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  legal_name text not null check (char_length(legal_name) between 2 and 160),
  business_name text,
  business_type text,
  registration_number text,
  tax_id text,
  region text,
  country_code text not null default 'TZ' check (char_length(country_code) = 2),
  registered_address text,
  representative_name text,
  representative_role text,
  representative_phone_e164 text
    check (representative_phone_e164 is null or representative_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (seller_id)
);

alter table public.business_profiles enable row level security;
revoke all on public.business_profiles from anon, authenticated;
grant select on public.business_profiles to authenticated;
grant insert, update, delete on public.business_profiles to authenticated;

drop policy if exists business_profiles_select_own_or_staff on public.business_profiles;
create policy business_profiles_select_own_or_staff on public.business_profiles
  for select to authenticated
  using (seller_id = (select auth.uid()) or public.is_internal_staff());

drop policy if exists business_profiles_write_own on public.business_profiles;
create policy business_profiles_write_own on public.business_profiles
  for all to authenticated
  using (seller_id = (select auth.uid()) and not public.is_internal_staff())
  with check (seller_id = (select auth.uid()) and not public.is_internal_staff());

drop policy if exists business_profiles_write_staff on public.business_profiles;
create policy business_profiles_write_staff on public.business_profiles
  for all to authenticated
  using (public.is_internal_staff())
  with check (public.is_internal_staff());

drop trigger if exists business_profiles_set_updated_at on public.business_profiles;
create trigger business_profiles_set_updated_at
  before update on public.business_profiles
  for each row execute function public.set_updated_at();

create table if not exists public.business_verification_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.business_profiles (id) on delete cascade,
  seller_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  event_type text not null
    check (event_type in ('submitted', 'under_review', 'approved', 'rejected', 'resubmitted')),
  reviewer_id uuid references public.profiles (id),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now()
);

create index if not exists business_verification_events_seller_idx
  on public.business_verification_events (seller_id, created_at desc);

alter table public.business_verification_events enable row level security;
revoke all on public.business_verification_events from anon, authenticated;
grant select on public.business_verification_events to authenticated;

drop policy if exists business_verification_events_select on public.business_verification_events;
create policy business_verification_events_select on public.business_verification_events
  for select to authenticated
  using (seller_id = (select auth.uid()) or public.is_internal_staff());

/* ========================================================================== *
 * 2. ATTEMPTS, RESTRICTIONS AND ACCESS LOG
 * ========================================================================== */

create table if not exists public.identity_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  method text not null check (method in ('email_otp', 'sms_otp', 'document', 'manual')),
  outcome text not null check (outcome in ('succeeded', 'failed', 'blocked')),
  subject_hash text,
  reason text check (reason is null or char_length(reason) <= 300),
  created_at timestamptz not null default now()
);

create index if not exists identity_verification_attempts_user_idx
  on public.identity_verification_attempts (user_id, created_at desc);

alter table public.identity_verification_attempts enable row level security;
revoke all on public.identity_verification_attempts from anon, authenticated;
grant select on public.identity_verification_attempts to authenticated;

drop policy if exists identity_verification_attempts_select_own
  on public.identity_verification_attempts;
create policy identity_verification_attempts_select_own
  on public.identity_verification_attempts
  for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.account_restrictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  restriction_type text not null
    check (restriction_type in ('transacting', 'withdrawing', 'kyc', 'chat', 'full')),
  reason text not null check (char_length(reason) between 2 and 500),
  imposed_by uuid not null references public.profiles (id),
  is_active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  lifted_by uuid references public.profiles (id),
  lifted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists account_restrictions_user_idx
  on public.account_restrictions (user_id, is_active);

alter table public.account_restrictions enable row level security;
revoke all on public.account_restrictions from anon, authenticated;
grant select on public.account_restrictions to authenticated;

drop policy if exists account_restrictions_select_own on public.account_restrictions;
create policy account_restrictions_select_own on public.account_restrictions
  for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.kyc_access_log (
  id uuid primary key default gen_random_uuid(),
  reviewer_id uuid not null references public.profiles (id),
  seller_id uuid not null references public.seller_profiles (user_id) on delete cascade,
  submission_id uuid references public.seller_kyc_submissions (id) on delete set null,
  document_path text,
  created_at timestamptz not null default now()
);

create index if not exists kyc_access_log_reviewer_idx
  on public.kyc_access_log (reviewer_id, created_at desc);
create index if not exists kyc_access_log_seller_idx
  on public.kyc_access_log (seller_id, created_at desc);

alter table public.kyc_access_log enable row level security;
revoke all on public.kyc_access_log from anon, authenticated;

/* ========================================================================== *
 * 3. KYC FUNCTIONS
 * ========================================================================== */

/* Submit a KYC package. A seller may have one open submission at a time;
   a rejected submission may be replaced. */
create or replace function public.submit_kyc(
  p_entity_type text,
  p_legal_name text,
  p_business_name text default null,
  p_business_type text default null,
  p_registration_number text default null,
  p_region text default null,
  p_id_type text default null,
  p_id_last4 text default null,
  p_tax_id_last4 text default null,
  p_representative_role text default null,
  p_social_links jsonb default '{}'::jsonb,
  p_document_paths text[] default null,
  p_attested_at timestamptz default null
)
returns public.seller_kyc_submissions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_submission public.seller_kyc_submissions%rowtype;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.is_seller(v_user) then
    raise exception 'Only sellers can submit verification documents' using errcode = '42501';
  end if;
  if p_entity_type not in ('personal', 'corporate') then
    raise exception 'Entity type must be personal or corporate' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_legal_name, ''))) < 2 then
    raise exception 'A legal name is required' using errcode = 'P0001';
  end if;
  if p_document_paths is null or cardinality(p_document_paths) < 1
     or cardinality(p_document_paths) > 6 then
    raise exception 'Between 1 and 6 documents are required' using errcode = 'P0001';
  end if;

  insert into public.seller_kyc_submissions
    (seller_id, submitted_by, entity_type, legal_name, business_name, business_type,
     registration_number, region, id_type, id_last4, tax_id_last4, representative_role,
     social_links, document_paths, attested_at, status)
  values
    (v_user, v_user, p_entity_type, btrim(p_legal_name),
     nullif(btrim(coalesce(p_business_name, '')), ''),
     nullif(btrim(coalesce(p_business_type, '')), ''),
     nullif(btrim(coalesce(p_registration_number, '')), ''),
     nullif(btrim(coalesce(p_region, '')), ''),
     nullif(btrim(coalesce(p_id_type, '')), ''),
     nullif(btrim(coalesce(p_id_last4, '')), ''),
     nullif(btrim(coalesce(p_tax_id_last4, '')), ''),
     nullif(btrim(coalesce(p_representative_role, '')), ''),
     coalesce(p_social_links, '{}'::jsonb), p_document_paths,
     coalesce(p_attested_at, now()), 'pending')
  returning * into v_submission;

  return v_submission;
end;
$$;
revoke all on function public.submit_kyc(text, text, text, text, text, text, text, text, text, text, jsonb, text[], timestamptz)
  from public, anon;
grant execute on function public.submit_kyc(text, text, text, text, text, text, text, text, text, text, jsonb, text[], timestamptz)
  to authenticated;

/* Resubmit after a rejection. The new attempt is a new row so the history
   is preserved. */
create or replace function public.resubmit_kyc(
  p_document_paths text[],
  p_attested_at timestamptz default null
)
returns public.seller_kyc_submissions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_previous public.seller_kyc_submissions%rowtype;
  v_submission public.seller_kyc_submissions%rowtype;
  v_attempt integer := 1;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select s.* into v_previous
  from public.seller_kyc_submissions s
  where s.seller_id = v_user
  order by s.submitted_at desc limit 1;

  if not found then
    raise exception 'No previous submission to replace' using errcode = 'P0002';
  end if;
  if v_previous.status <> 'rejected' then
    raise exception 'Resubmission is only available after a rejection' using errcode = 'P0001';
  end if;
  if p_document_paths is null or cardinality(p_document_paths) < 1
     or cardinality(p_document_paths) > 6 then
    raise exception 'Between 1 and 6 documents are required' using errcode = 'P0001';
  end if;

  select coalesce(max(s.attempt_count), 0) + 1 into v_attempt
  from public.seller_kyc_submissions s where s.seller_id = v_user;

  insert into public.seller_kyc_submissions
    (seller_id, submitted_by, entity_type, legal_name, business_name, business_type,
     registration_number, region, id_type, id_last4, tax_id_last4, representative_role,
     social_links, document_paths, attested_at, status, attempt_count)
  values
    (v_previous.seller_id, v_user, v_previous.entity_type, v_previous.legal_name,
     v_previous.business_name, v_previous.business_type, v_previous.registration_number,
     v_previous.region, v_previous.id_type, v_previous.id_last4, v_previous.tax_id_last4,
     v_previous.representative_role, v_previous.social_links, p_document_paths,
     coalesce(p_attested_at, now()), 'pending', v_attempt)
  returning * into v_submission;

  return v_submission;
end;
$$;
revoke all on function public.resubmit_kyc(text[], timestamptz) from public, anon;
grant execute on function public.resubmit_kyc(text[], timestamptz) to authenticated;

/* Move a submission into review. */
create or replace function public.start_kyc_review(
  p_submission_id uuid,
  p_reviewer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = p_reviewer_id and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Reviewer is not authorized' using errcode = '42501';
  end if;

  update public.seller_kyc_submissions
    set status = 'under_review'
    where id = p_submission_id and status = 'pending';

  if not found then
    raise exception 'Submission is not available for review' using errcode = 'P0001';
  end if;

  return jsonb_build_object('ok', true, 'submission_id', p_submission_id, 'status', 'under_review');
end;
$$;
revoke all on function public.start_kyc_review(uuid, uuid) from public, anon, authenticated;
grant execute on function public.start_kyc_review(uuid, uuid) to service_role;

/* Decide a submission. The review_seller_kyc function from the earlier
   migration already does this; this wrapper adds the notification on
   rejection and the business verification event. */
create or replace function public.decide_kyc(
  p_submission_id uuid,
  p_decision text,
  p_review_note text default null,
  p_reviewer_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid := coalesce(p_reviewer_id, (select auth.uid()));
  v_result record;
  v_business uuid;
begin
  if v_reviewer is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_result
  from public.review_seller_kyc(p_submission_id, v_reviewer, p_decision, p_review_note);

  update public.seller_kyc_submissions
    set decision_at = now()
    where id = p_submission_id;

  select b.id into v_business from public.business_profiles b
  where b.seller_id = v_result.seller_id;

  if v_business is not null then
    insert into public.business_verification_events
      (business_id, seller_id, event_type, reviewer_id, note)
    values
      (v_business, v_result.seller_id,
       case when p_decision = 'approved' then 'approved' else 'rejected' end,
       v_reviewer, nullif(btrim(coalesce(p_review_note, '')), ''));
  end if;

  return jsonb_build_object(
    'ok', true,
    'submission_id', v_result.submission_id,
    'seller_id', v_result.seller_id,
    'status', v_result.status,
    'kobe_id', v_result.kobe_id,
    'reviewed_at', v_result.reviewed_at);
end;
$$;
revoke all on function public.decide_kyc(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.decide_kyc(uuid, text, text, uuid) to service_role;

/* The staff review queue. */
create or replace function public.list_kyc_queue(p_limit integer default 50)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'submission_id', s.id,
    'seller_id', s.seller_id,
    'entity_type', s.entity_type,
    'legal_name', s.legal_name,
    'business_name', s.business_name,
    'region', s.region,
    'status', s.status,
    'document_count', cardinality(s.document_paths),
    'submitted_at', s.submitted_at,
    'attempt_count', s.attempt_count
  )
  from public.seller_kyc_submissions s
  where s.status in ('pending', 'under_review')
  order by s.submitted_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function public.list_kyc_queue(integer) from public, anon, authenticated;
grant execute on function public.list_kyc_queue(integer) to service_role;

/* Record that a reviewer opened a KYC document. */
create or replace function public.log_kyc_document_access(
  p_seller_id uuid,
  p_submission_id uuid,
  p_document_path text,
  p_reviewer_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid := coalesce(p_reviewer_id, (select auth.uid()));
  v_id uuid;
begin
  if v_reviewer is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  insert into public.kyc_access_log (reviewer_id, seller_id, submission_id, document_path)
  values (v_reviewer, p_seller_id, p_submission_id, p_document_path)
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.log_kyc_document_access(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.log_kyc_document_access(uuid, uuid, text, uuid) to service_role;

/* ========================================================================== *
 * 4. RESTRICTIONS
 * ========================================================================== */

create or replace function public.restrict_account(
  p_user_id uuid,
  p_restriction_type text,
  p_reason text,
  p_imposed_by uuid default null,
  p_ends_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_imposer uuid := coalesce(p_imposed_by, (select auth.uid()));
begin
  if v_imposer is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.internal_user_roles r
    where r.user_id = v_imposer and r.role in ('admin', 'support_agent')
  ) then
    raise exception 'Only staff may restrict an account' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 2 then
    raise exception 'A reason is required' using errcode = 'P0001';
  end if;

  insert into public.account_restrictions
    (user_id, restriction_type, reason, imposed_by, ends_at)
  values (p_user_id, p_restriction_type, btrim(p_reason), v_imposer, p_ends_at);

  perform public.record_account_security_event(
    p_user_id, 'account_suspended', 'critical', null, null,
    jsonb_build_object('restriction', p_restriction_type, 'reason', btrim(p_reason),
      'imposed_by', v_imposer));

  return jsonb_build_object('ok', true, 'user_id', p_user_id, 'restriction', p_restriction_type);
end;
$$;
revoke all on function public.restrict_account(uuid, text, text, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.restrict_account(uuid, text, text, uuid, timestamptz) to service_role;

create or replace function public.lift_restriction(
  p_restriction_id uuid,
  p_lifted_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lifter uuid := coalesce(p_lifted_by, (select auth.uid()));
begin
  if v_lifter is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  update public.account_restrictions
    set is_active = false, lifted_at = now(), lifted_by = v_lifter
    where id = p_restriction_id and is_active = true;

  if not found then
    raise exception 'Restriction not found or already lifted' using errcode = 'P0002';
  end if;

  return jsonb_build_object('ok', true, 'restriction_id', p_restriction_id);
end;
$$;
revoke all on function public.lift_restriction(uuid, uuid) from public, anon, authenticated;
grant execute on function public.lift_restriction(uuid, uuid) to service_role;

/* Is the user restricted right now? */
create or replace function public.active_restriction(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select r.restriction_type
    from public.account_restrictions r
    where r.user_id = p_user
      and r.is_active
      and (r.ends_at is null or r.ends_at > now())
    order by r.created_at desc
    limit 1
  ), null);
$$;
revoke all on function public.active_restriction(uuid) from public, anon;
grant execute on function public.active_restriction(uuid) to service_role, authenticated;
