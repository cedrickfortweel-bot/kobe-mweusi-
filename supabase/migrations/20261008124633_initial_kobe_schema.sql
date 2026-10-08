create type public.account_type as enum ('buyer', 'seller');
create type public.seller_verification_status as enum ('unverified', 'pending', 'verified', 'rejected');
create type public.product_status as enum ('draft', 'active', 'archived');
create type public.live_platform as enum ('tiktok', 'youtube');
create type public.live_status as enum ('scheduled', 'live', 'ended', 'archived');
create type public.order_status as enum ('awaiting_payment', 'in_escrow', 'delivered', 'completed', 'disputed', 'refunded', 'cancelled', 'split');
create type public.payment_status as enum ('pending', 'confirmed', 'failed', 'cancelled');
create type public.dispute_status as enum ('open', 'under_review', 'resolved');
create type public.dispute_outcome as enum ('buyer_refund', 'seller_release', 'split');
create type public.handoff_code_type as enum ('buyer', 'seller');
create type public.wallet_entry_type as enum ('top_up', 'order_funding', 'escrow_release', 'refund', 'withdrawal', 'fee', 'adjustment');

create table public.profiles (
	id uuid primary key references auth.users (id) on delete cascade,
	account_type public.account_type not null default 'buyer',
	display_name text not null default 'Kobe user' check (char_length(display_name) between 2 and 100),
	phone_e164 text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint profiles_phone_format check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);

create table public.seller_profiles (
	user_id uuid primary key references public.profiles (id) on delete cascade,
	shop_slug text unique,
	shop_name text not null check (char_length(shop_name) between 2 and 120),
	bio text not null default '' check (char_length(bio) <= 2000),
	region text,
	public_contact text,
	verification_status public.seller_verification_status not null default 'unverified',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint seller_slug_format check (shop_slug is null or (shop_slug = lower(shop_slug) and shop_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'))
);

create table public.products (
	id uuid primary key default gen_random_uuid(),
	seller_id uuid not null references public.seller_profiles (user_id) on delete cascade,
	name text not null check (char_length(name) between 1 and 160),
	description text not null default '' check (char_length(description) <= 5000),
	price_tzs bigint not null check (price_tzs > 0),
	stock_quantity integer not null default 0 check (stock_quantity >= 0),
	status public.product_status not null default 'draft',
	image_path text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create table public.live_sessions (
	id uuid primary key default gen_random_uuid(),
	seller_id uuid not null references public.seller_profiles (user_id) on delete cascade,
	title text not null check (char_length(title) between 1 and 180),
	description text not null default '' check (char_length(description) <= 3000),
	platform public.live_platform not null,
	external_url text not null,
	status public.live_status not null default 'scheduled',
	starts_at timestamptz,
	ends_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint live_session_external_url check (
		(platform = 'tiktok' and external_url ~* '^https://([a-z0-9-]+\.)*tiktok\.com/') or
		(platform = 'youtube' and external_url ~* '^https://(www\.)?youtube\.com/|^https://youtu\.be/')
	),
	constraint live_session_time_order check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table public.live_session_products (
	session_id uuid not null references public.live_sessions (id) on delete cascade,
	product_id uuid not null references public.products (id) on delete cascade,
	sort_order integer not null default 0,
	pinned boolean not null default false,
	primary key (session_id, product_id)
);

create table public.orders (
	id uuid primary key default gen_random_uuid(),
	buyer_id uuid not null references public.profiles (id),
	seller_id uuid not null references public.seller_profiles (user_id),
	product_id uuid references public.products (id) on delete set null,
	live_session_id uuid references public.live_sessions (id) on delete set null,
	item_name text not null check (char_length(item_name) between 1 and 160),
	quantity integer not null check (quantity > 0),
	unit_price_tzs bigint not null check (unit_price_tzs > 0),
	subtotal_tzs bigint not null check (subtotal_tzs > 0),
	buyer_fee_tzs bigint not null default 0 check (buyer_fee_tzs >= 0),
	seller_fee_tzs bigint not null default 0 check (seller_fee_tzs >= 0),
	total_due_tzs bigint not null check (total_due_tzs = subtotal_tzs + buyer_fee_tzs),
	status public.order_status not null default 'awaiting_payment',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint order_subtotal_matches_quantity check (subtotal_tzs = unit_price_tzs * quantity)
);

create table public.payment_intents (
	id uuid primary key default gen_random_uuid(),
	buyer_id uuid not null references public.profiles (id),
	order_id uuid references public.orders (id),
	provider text not null check (provider in ('azampay')),
	amount_tzs bigint not null check (amount_tzs > 0),
	status public.payment_status not null default 'pending',
	idempotency_key text not null unique,
	provider_reference text unique,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create table public.wallet_ledger_entries (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references public.profiles (id),
	order_id uuid references public.orders (id),
	payment_intent_id uuid references public.payment_intents (id),
	entry_type public.wallet_entry_type not null,
	amount_tzs bigint not null check (amount_tzs <> 0),
	idempotency_key text not null unique,
	created_at timestamptz not null default now()
);

create table public.handoff_codes (
	id uuid primary key default gen_random_uuid(),
	order_id uuid not null references public.orders (id) on delete cascade,
	code_type public.handoff_code_type not null,
	issued_to uuid not null references public.profiles (id),
	token_hash text not null unique,
	expires_at timestamptz not null,
	used_at timestamptz,
	created_at timestamptz not null default now(),
	constraint handoff_expiry_after_creation check (expires_at > created_at)
);

create table public.disputes (
	id uuid primary key default gen_random_uuid(),
	order_id uuid not null unique references public.orders (id),
	opened_by uuid not null references public.profiles (id),
	reason text not null check (char_length(reason) between 2 and 100),
	description text not null check (char_length(description) between 10 and 5000),
	status public.dispute_status not null default 'open',
	outcome public.dispute_outcome,
	seller_deadline timestamptz not null default (now() + interval '48 hours'),
	resolved_at timestamptz,
	created_at timestamptz not null default now(),
	constraint resolved_dispute_has_outcome check ((status = 'resolved') = (outcome is not null))
);

create table public.dispute_messages (
	id uuid primary key default gen_random_uuid(),
	dispute_id uuid not null references public.disputes (id) on delete cascade,
	sender_id uuid not null references public.profiles (id),
	body text not null check (char_length(body) between 1 and 5000),
	created_at timestamptz not null default now()
);

create table public.reviews (
	id uuid primary key default gen_random_uuid(),
	order_id uuid not null unique references public.orders (id),
	buyer_id uuid not null references public.profiles (id),
	seller_id uuid not null references public.seller_profiles (user_id),
	stars smallint not null check (stars between 1 and 5),
	comment text not null default '' check (char_length(comment) <= 2000),
	created_at timestamptz not null default now()
);

create table public.internal_user_roles (
	user_id uuid not null references public.profiles (id) on delete cascade,
	role text not null check (role in ('support_agent', 'admin')),
	created_at timestamptz not null default now(),
	primary key (user_id, role)
);

create index products_seller_status_idx on public.products (seller_id, status);
create index live_sessions_public_idx on public.live_sessions (status, starts_at);
create index orders_buyer_created_idx on public.orders (buyer_id, created_at desc);
create index orders_seller_created_idx on public.orders (seller_id, created_at desc);
create index payment_intents_buyer_created_idx on public.payment_intents (buyer_id, created_at desc);
create index wallet_ledger_user_created_idx on public.wallet_ledger_entries (user_id, created_at desc);
create index handoff_codes_order_type_idx on public.handoff_codes (order_id, code_type, expires_at);
create index disputes_status_deadline_idx on public.disputes (status, seller_deadline);
create index dispute_messages_dispute_created_idx on public.dispute_messages (dispute_id, created_at);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	new.updated_at = now();
	return new;
end;
$$;

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.profiles (id, account_type, display_name)
	values (
		new.id,
		case when new.raw_user_meta_data ->> 'account_type' = 'seller'
			then 'seller'::public.account_type else 'buyer'::public.account_type end,
		coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'Kobe user')
	);
	return new;
end;
$$;

create trigger on_auth_user_created
	after insert on auth.users
	for each row execute function public.handle_new_user();

create trigger profiles_set_updated_at before update on public.profiles
	for each row execute function public.set_updated_at();
create trigger seller_profiles_set_updated_at before update on public.seller_profiles
	for each row execute function public.set_updated_at();
create trigger products_set_updated_at before update on public.products
	for each row execute function public.set_updated_at();
create trigger live_sessions_set_updated_at before update on public.live_sessions
	for each row execute function public.set_updated_at();
create trigger orders_set_updated_at before update on public.orders
	for each row execute function public.set_updated_at();
create trigger payment_intents_set_updated_at before update on public.payment_intents
	for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.seller_profiles enable row level security;
alter table public.products enable row level security;
alter table public.live_sessions enable row level security;
alter table public.live_session_products enable row level security;
alter table public.orders enable row level security;
alter table public.payment_intents enable row level security;
alter table public.wallet_ledger_entries enable row level security;
alter table public.handoff_codes enable row level security;
alter table public.disputes enable row level security;
alter table public.dispute_messages enable row level security;
alter table public.reviews enable row level security;
alter table public.internal_user_roles enable row level security;

revoke all on public.profiles, public.seller_profiles, public.products, public.live_sessions,
	public.live_session_products, public.orders, public.payment_intents, public.wallet_ledger_entries,
	public.handoff_codes, public.disputes, public.dispute_messages, public.reviews,
	public.internal_user_roles from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name, phone_e164) on public.profiles to authenticated;
grant select on public.seller_profiles, public.products, public.live_sessions,
	public.live_session_products, public.reviews to anon, authenticated;
grant insert (user_id, shop_slug, shop_name, bio, region, public_contact) on public.seller_profiles to authenticated;
grant delete on public.seller_profiles to authenticated;
grant update (shop_slug, shop_name, bio, region, public_contact) on public.seller_profiles to authenticated;
grant insert, update, delete on public.products, public.live_sessions, public.live_session_products to authenticated;
grant select on public.orders, public.payment_intents, public.wallet_ledger_entries,
	public.disputes, public.dispute_messages to authenticated;
grant select, insert on public.reviews to authenticated;
grant insert on public.dispute_messages to authenticated;

create policy profiles_select_own on public.profiles for select to authenticated
	using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated
	using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy seller_profiles_read_public_or_own on public.seller_profiles for select to anon, authenticated
	using (verification_status = 'verified' or user_id = (select auth.uid()));
create policy seller_profiles_insert_own_seller on public.seller_profiles for insert to authenticated
	with check (user_id = (select auth.uid()) and exists (
		select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_type = 'seller'));
create policy seller_profiles_update_own_seller on public.seller_profiles for update to authenticated
	using (user_id = (select auth.uid()) and exists (
		select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_type = 'seller'))
	with check (user_id = (select auth.uid()) and exists (
		select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_type = 'seller'));
create policy seller_profiles_delete_own_seller on public.seller_profiles for delete to authenticated
	using (user_id = (select auth.uid()) and verification_status <> 'verified');

create policy products_read_published on public.products for select to anon, authenticated
	using (
		(status = 'active' and exists (select 1 from public.seller_profiles s
			where s.user_id = seller_id and s.verification_status = 'verified'))
		or seller_id = (select auth.uid())
	);
create policy products_insert_own on public.products for insert to authenticated
	with check (seller_id = (select auth.uid()) and exists (
		select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_type = 'seller'));
create policy products_update_own on public.products for update to authenticated
	using (seller_id = (select auth.uid())) with check (seller_id = (select auth.uid()));
create policy products_delete_own on public.products for delete to authenticated
	using (seller_id = (select auth.uid()));

create policy live_sessions_read_public_or_own on public.live_sessions for select to anon, authenticated
	using (
		(status in ('scheduled', 'live') and exists (select 1 from public.seller_profiles s
			where s.user_id = seller_id and s.verification_status = 'verified'))
		or seller_id = (select auth.uid())
	);
create policy live_sessions_insert_own on public.live_sessions for insert to authenticated
	with check (seller_id = (select auth.uid()) and exists (
		select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_type = 'seller'));
create policy live_sessions_update_own on public.live_sessions for update to authenticated
	using (seller_id = (select auth.uid())) with check (seller_id = (select auth.uid()));
create policy live_sessions_delete_own on public.live_sessions for delete to authenticated
	using (seller_id = (select auth.uid()));

create policy live_session_products_read_public_or_own on public.live_session_products for select to anon, authenticated
	using (exists (select 1 from public.live_sessions l where l.id = session_id));
create policy live_session_products_insert_own on public.live_session_products for insert to authenticated
	with check (exists (select 1 from public.live_sessions l where l.id = session_id and l.seller_id = (select auth.uid()))
		and exists (select 1 from public.products p where p.id = product_id and p.seller_id = (select auth.uid())));
create policy live_session_products_update_own on public.live_session_products for update to authenticated
	using (exists (select 1 from public.live_sessions l where l.id = session_id and l.seller_id = (select auth.uid())))
	with check (exists (select 1 from public.live_sessions l where l.id = session_id and l.seller_id = (select auth.uid()))
		and exists (select 1 from public.products p where p.id = product_id and p.seller_id = (select auth.uid())));
create policy live_session_products_delete_own on public.live_session_products for delete to authenticated
	using (exists (select 1 from public.live_sessions l where l.id = session_id and l.seller_id = (select auth.uid())));

create policy orders_select_participant on public.orders for select to authenticated
	using (buyer_id = (select auth.uid()) or seller_id = (select auth.uid()));
create policy payment_intents_select_buyer on public.payment_intents for select to authenticated
	using (buyer_id = (select auth.uid()));
create policy wallet_ledger_select_owner on public.wallet_ledger_entries for select to authenticated
	using (user_id = (select auth.uid()));
create policy handoff_codes_no_client_access on public.handoff_codes for select to authenticated using (false);

create policy disputes_select_participant on public.disputes for select to authenticated
	using (exists (select 1 from public.orders o where o.id = order_id
		and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))));
create policy dispute_messages_select_participant on public.dispute_messages for select to authenticated
	using (exists (select 1 from public.disputes d join public.orders o on o.id = d.order_id
		where d.id = dispute_id and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))));
create policy dispute_messages_insert_participant on public.dispute_messages for insert to authenticated
	with check (sender_id = (select auth.uid()) and exists (
		select 1 from public.disputes d join public.orders o on o.id = d.order_id
		where d.id = dispute_id and d.status <> 'resolved'
			and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))));

create policy reviews_read_public on public.reviews for select to anon, authenticated using (true);
create policy reviews_insert_completed_buyer_order on public.reviews for insert to authenticated
	with check (buyer_id = (select auth.uid()) and exists (
		select 1 from public.orders o where o.id = order_id and o.buyer_id = (select auth.uid())
			and o.seller_id = reviews.seller_id and o.status = 'completed'));
