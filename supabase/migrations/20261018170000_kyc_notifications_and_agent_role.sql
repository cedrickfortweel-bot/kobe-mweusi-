/* KYC decision notifications and production staff roles. */

alter table public.internal_user_roles
  drop constraint if exists internal_user_roles_role_check;

alter table public.internal_user_roles
  add constraint internal_user_roles_role_check
  check (role in ('support_agent', 'admin', 'agent'));

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  title text not null check (char_length(title) between 1 and 160),
  body text not null check (char_length(body) between 1 and 2000),
  link text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
revoke all on public.notifications from anon;
grant select, update on public.notifications to authenticated;

create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));

create policy notifications_mark_own on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create or replace function public.notify_seller_kyc_decision(
  p_submission_id uuid,
  p_seller_id uuid,
  p_decision text,
  p_kobe_id text,
  p_review_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
  v_body text;
begin
  if p_decision = 'approved' then
    v_title := 'Seller verification approved';
    v_body := 'Your KYC documents were approved. Your Kobe ID is ' || coalesce(p_kobe_id, 'being assigned') || '. You can now complete your seller profile and start selling.';
  else
    v_title := 'Seller verification needs attention';
    v_body := 'Your KYC submission was not approved. Review the note and submit clearer or corrected documents.';
  end if;

  insert into public.notifications (user_id, kind, title, body, link, payload)
  values (
    p_seller_id,
    'kyc_decision',
    v_title,
    case when p_decision = 'approved' then v_body
      else v_body || case when nullif(btrim(p_review_note), '') is not null then ' Reviewer note: ' || btrim(p_review_note) else '' end
    end,
    '/seller.html#verification',
    jsonb_build_object('submission_id', p_submission_id, 'decision', p_decision, 'kobe_id', p_kobe_id)
  );
end;
$$;

revoke all on function public.notify_seller_kyc_decision(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.notify_seller_kyc_decision(uuid, uuid, text, text, text) to service_role;

drop function if exists public.review_seller_kyc(uuid, uuid, text, text);
create or replace function public.review_seller_kyc(
  p_submission_id uuid,
  p_reviewer_id uuid,
  p_decision text,
  p_review_note text default null
)
returns table (submission_id uuid, seller_id uuid, status text, kobe_id text, reviewed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seller_id uuid;
  v_previous_status text;
  v_kobe_id text;
  v_reviewed_at timestamptz := now();
  v_note text := nullif(btrim(p_review_note), '');
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'Decision must be approved or rejected'; end if;
  if p_decision = 'rejected' and v_note is null then raise exception 'A reason is required when rejecting a submission'; end if;
  if not exists (select 1 from public.internal_user_roles r where r.user_id = p_reviewer_id and r.role in ('admin', 'support_agent')) then
    raise exception 'Reviewer is not authorized';
  end if;
  select s.seller_id, s.status into v_seller_id, v_previous_status from public.seller_kyc_submissions s where s.id = p_submission_id for update;
  if not found or v_previous_status not in ('pending', 'under_review') then raise exception 'Submission is not available for review'; end if;
  update public.seller_kyc_submissions set status = p_decision, review_note = v_note, reviewed_by = p_reviewer_id, reviewed_at = v_reviewed_at where id = p_submission_id;
  update public.seller_profiles set verification_status = case when p_decision = 'approved' then 'verified'::public.seller_verification_status else 'rejected'::public.seller_verification_status end where user_id = v_seller_id;
  select s.kobe_id into v_kobe_id from public.seller_profiles s where s.user_id = v_seller_id;
  insert into public.kyc_review_audit (submission_id, seller_id, reviewer_id, previous_status, decision, review_note) values (p_submission_id, v_seller_id, p_reviewer_id, v_previous_status, p_decision, v_note);
  perform public.notify_seller_kyc_decision(p_submission_id, v_seller_id, p_decision, v_kobe_id, v_note);
  return query select p_submission_id, v_seller_id, p_decision, v_kobe_id, v_reviewed_at;
end;
$$;

revoke all on function public.review_seller_kyc(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.review_seller_kyc(uuid, uuid, text, text) to service_role;
