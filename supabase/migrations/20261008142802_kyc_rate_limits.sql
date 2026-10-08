alter table public.seller_profiles
	alter column kobe_id set default (
		'KM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 15))
	);

create table public.seller_kyc_submissions (
	id uuid primary key default gen_random_uuid(),
	seller_id uuid not null references public.seller_profiles (user_id),
	entity_type text not null check (entity_type in ('personal', 'corporate')),
	legal_name text not null check (char_length(legal_name) between 2 and 160),
	business_name text,
	business_type text,
	registration_number text,
	region text,
	id_type text,
	id_last4 text check (id_last4 is null or id_last4 ~ '^[0-9A-Za-z]{4}$'),
	tax_id_last4 text check (tax_id_last4 is null or tax_id_last4 ~ '^[0-9A-Za-z]{4}$'),
	representative_role text,
	social_links jsonb not null default '{}'::jsonb check (jsonb_typeof(social_links) = 'object'),
	document_paths text[] not null check (cardinality(document_paths) between 1 and 6),
	attested_at timestamptz not null,
	status text not null default 'pending' check (status in ('pending', 'under_review', 'approved', 'rejected')),
	review_note text check (review_note is null or char_length(review_note) <= 2000),
	reviewed_by uuid references public.profiles (id),
	submitted_at timestamptz not null default now(),
	reviewed_at timestamptz,
	constraint kyc_reviewer_matches_status check ((status in ('approved', 'rejected')) = (reviewed_at is not null))
);

create unique index seller_kyc_one_open_submission_idx
	on public.seller_kyc_submissions (seller_id)
	where status in ('pending', 'under_review');
create index seller_kyc_admin_queue_idx
	on public.seller_kyc_submissions (status, submitted_at);

alter table public.seller_kyc_submissions enable row level security;
revoke all on public.seller_kyc_submissions from anon, authenticated;
grant select, insert on public.seller_kyc_submissions to authenticated;

create function public.is_internal_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select exists (
		select 1 from public.internal_user_roles r
		where r.user_id = (select auth.uid()) and r.role in ('support_agent', 'admin')
	);
$$;
revoke all on function public.is_internal_staff() from public, anon;
grant execute on function public.is_internal_staff() to authenticated;

create policy seller_kyc_select_own_or_staff on public.seller_kyc_submissions for select to authenticated
	using (seller_id = (select auth.uid()) or public.is_internal_staff());
create policy seller_kyc_insert_own_seller on public.seller_kyc_submissions for insert to authenticated
	with check (
		seller_id = (select auth.uid())
		and status = 'pending'
		and reviewed_by is null
		and reviewed_at is null
		and exists (select 1 from public.profiles p
			where p.id = (select auth.uid()) and p.account_type = 'seller')
		and exists (select 1 from public.seller_profiles s
			where s.user_id = (select auth.uid()) and s.verification_status <> 'verified')
	);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc-documents', 'kyc-documents', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
	allowed_mime_types = excluded.allowed_mime_types;

create policy kyc_documents_upload_own on storage.objects for insert to authenticated
	with check (
		bucket_id = 'kyc-documents'
		and (storage.foldername(name))[1] = (select auth.uid())::text
	);
create policy kyc_documents_read_own on storage.objects for select to authenticated
	using (
		bucket_id = 'kyc-documents'
		and (storage.foldername(name))[1] = (select auth.uid())::text
	);

create table public.rate_limit_counters (
	scope text not null check (char_length(scope) between 1 and 64),
	subject_hash text not null check (subject_hash ~ '^[a-f0-9]{64}$'),
	window_started_at timestamptz not null,
	hit_count integer not null check (hit_count > 0),
	primary key (scope, subject_hash)
);
alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from anon, authenticated;

create function public.consume_rate_limit(
	p_scope text,
	p_subject_hash text,
	p_limit integer,
	p_window_seconds integer
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
	v_now timestamptz := clock_timestamp();
	v_started timestamptz;
	v_hits integer;
begin
	if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
		raise exception 'Invalid rate-limit configuration';
	end if;

	insert into public.rate_limit_counters as counters (scope, subject_hash, window_started_at, hit_count)
	values (p_scope, p_subject_hash, v_now, 1)
	on conflict (scope, subject_hash) do update
		set window_started_at = case
					when counters.window_started_at + make_interval(secs => p_window_seconds) <= v_now then v_now
					else counters.window_started_at
				end,
				hit_count = case
					when counters.window_started_at + make_interval(secs => p_window_seconds) <= v_now then 1
					else counters.hit_count + 1
				end
	returning counters.window_started_at, counters.hit_count into v_started, v_hits;

	return query select
		v_hits <= p_limit,
		greatest(0, p_limit - v_hits),
		greatest(0, ceil(extract(epoch from (v_started + make_interval(secs => p_window_seconds) - v_now)))::integer);
end;
$$;
revoke all on function public.consume_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, text, integer, integer) to service_role;

