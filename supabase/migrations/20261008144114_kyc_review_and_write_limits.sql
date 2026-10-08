drop policy if exists seller_kyc_insert_own_seller on public.seller_kyc_submissions;
create policy seller_kyc_insert_own_seller on public.seller_kyc_submissions for insert to authenticated
	with check (
		seller_id = (select auth.uid())
		and status = 'pending'
		and reviewed_by is null
		and reviewed_at is null
		and cardinality(document_paths) between 1 and 6
		and not exists (
			select 1 from unnest(document_paths) as doc(path)
			where doc.path !~ ('^' || (select auth.uid())::text || '/' || id::text || '/(nida|tin|selfie|registration|representative)/[A-Za-z0-9._-]+$')
		)
		and exists (select 1 from public.profiles p
			where p.id = (select auth.uid()) and p.account_type = 'seller')
		and exists (select 1 from public.seller_profiles s
			where s.user_id = (select auth.uid()) and s.verification_status <> 'verified')
	);

create function public.mark_seller_kyc_pending()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	update public.seller_profiles
		set verification_status = 'pending'
		where user_id = new.seller_id and verification_status <> 'verified';
	return new;
end;
$$;
revoke all on function public.mark_seller_kyc_pending() from public, anon, authenticated;
drop trigger if exists seller_kyc_mark_pending on public.seller_kyc_submissions;
create trigger seller_kyc_mark_pending after insert on public.seller_kyc_submissions
	for each row execute function public.mark_seller_kyc_pending();

create table public.kyc_review_audit (
	id uuid primary key default gen_random_uuid(),
	submission_id uuid not null references public.seller_kyc_submissions (id),
	seller_id uuid not null references public.seller_profiles (user_id),
	reviewer_id uuid not null references public.profiles (id),
	previous_status text not null,
	decision text not null check (decision in ('approved', 'rejected')),
	review_note text check (review_note is null or char_length(review_note) <= 2000),
	created_at timestamptz not null default now()
);
alter table public.kyc_review_audit enable row level security;
revoke all on public.kyc_review_audit from anon, authenticated;

create or replace function public.review_seller_kyc(
	p_submission_id uuid,
	p_reviewer_id uuid,
	p_decision text,
	p_review_note text default null
)
returns table (submission_id uuid, seller_id uuid, status text, reviewed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_seller_id uuid;
	v_previous_status text;
	v_reviewed_at timestamptz := now();
	v_note text := nullif(btrim(p_review_note), '');
begin
	if p_decision not in ('approved', 'rejected') then
		raise exception 'Decision must be approved or rejected';
	end if;
	if p_decision = 'rejected' and v_note is null then
		raise exception 'A reason is required when rejecting a submission';
	end if;
	if not exists (select 1 from public.internal_user_roles r
			where r.user_id = p_reviewer_id and r.role in ('admin', 'support_agent')) then
		raise exception 'Reviewer is not authorized';
	end if;

	select s.seller_id, s.status into v_seller_id, v_previous_status
		from public.seller_kyc_submissions s
		where s.id = p_submission_id
		for update;
	if not found or v_previous_status not in ('pending', 'under_review') then
		raise exception 'Submission is not available for review';
	end if;

	update public.seller_kyc_submissions s
		set status = p_decision, review_note = v_note,
				reviewed_by = p_reviewer_id, reviewed_at = v_reviewed_at
		where s.id = p_submission_id;
	update public.seller_profiles s
		set verification_status = case when p_decision = 'approved' then 'verified'::public.seller_verification_status
																	 else 'rejected'::public.seller_verification_status end
		where s.user_id = v_seller_id;
	insert into public.kyc_review_audit
		(submission_id, seller_id, reviewer_id, previous_status, decision, review_note)
		values (p_submission_id, v_seller_id, p_reviewer_id, v_previous_status, p_decision, v_note);

	return query select p_submission_id, v_seller_id, p_decision, v_reviewed_at;
end;
$$;
revoke all on function public.review_seller_kyc(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.review_seller_kyc(uuid, uuid, text, text) to service_role;

create or replace function public.enforce_app_write_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
	v_actor uuid := (select auth.uid());
	v_scope text := tg_table_name || '_write';
	v_subject_hash text;
	v_limit integer;
	v_window_seconds integer;
	v_allowed boolean;
	v_retry_after integer;
begin
	if v_actor is null or (select auth.role()) = 'service_role' then
		return new;
	end if;

	if tg_table_name = 'seller_profiles' then
		v_limit := 20;
		v_window_seconds := 3600;
	elsif tg_table_name = 'products' then
		v_limit := 30;
		v_window_seconds := 60;
	elsif tg_table_name = 'live_sessions' then
		v_limit := 10;
		v_window_seconds := 3600;
	elsif tg_table_name = 'seller_kyc_submissions' then
		v_limit := 3;
		v_window_seconds := 86400;
	else
		raise exception 'Rate limit trigger used on unsupported table';
	end if;

	v_subject_hash := md5(v_scope || ':' || v_actor::text) || md5('kobe-rate:' || v_scope || ':' || v_actor::text);
	select result.allowed, result.retry_after_seconds
		into v_allowed, v_retry_after
		from public.consume_rate_limit(v_scope, v_subject_hash, v_limit, v_window_seconds) result;
	if not v_allowed then
		raise exception using errcode = 'P0001', message = 'RATE_LIMITED', detail = v_retry_after::text;
	end if;
	return new;
end;
$$;
revoke all on function public.enforce_app_write_rate_limit() from public, anon, authenticated;

drop trigger if exists seller_profiles_rate_limit on public.seller_profiles;
create trigger seller_profiles_rate_limit before insert or update on public.seller_profiles
	for each row execute function public.enforce_app_write_rate_limit();
drop trigger if exists products_rate_limit on public.products;
create trigger products_rate_limit before insert or update on public.products
	for each row execute function public.enforce_app_write_rate_limit();
drop trigger if exists live_sessions_rate_limit on public.live_sessions;
create trigger live_sessions_rate_limit before insert or update on public.live_sessions
	for each row execute function public.enforce_app_write_rate_limit();
drop trigger if exists seller_kyc_rate_limit on public.seller_kyc_submissions;
create trigger seller_kyc_rate_limit before insert on public.seller_kyc_submissions
	for each row execute function public.enforce_app_write_rate_limit();
