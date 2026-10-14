/* Kobe Mweusi — order refs, chat, dispute evidence, activity feed, push,
   transaction PINs, support requests, shop media. Applied after the KYC migrations. */

/* ---------- orders: public reference, note, source, payment expiry ---------- */
alter table public.orders
  add column ref text,
  add column note text check (note is null or char_length(note) <= 500),
  add column source text check (source is null or source in ('store', 'live', 'manual')),
  add column expires_at timestamptz;

create unique index orders_ref_key on public.orders (ref);
create index orders_expires_idx on public.orders (status, expires_at);

/* ---------- disputes: public reference, seller reply tracking, one open dispute per order ---------- */
alter table public.disputes
  add column ref text,
  add column replied_at timestamptz;

create unique index disputes_ref_key on public.disputes (ref);
create unique index disputes_one_open_idx on public.disputes (order_id) where status <> 'resolved';

/* ---------- handoff codes: remember who scanned ---------- */
alter table public.handoff_codes
  add column scanned_by uuid references public.profiles (id);

/* ---------- reviews: tags ---------- */
alter table public.reviews
  add column tags text[] check (cardinality(tags) is null or cardinality(tags) between 0 and 4);

/* ---------- seller profiles: shop details, socials, media paths ---------- */
alter table public.seller_profiles
  add column details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  add column socials jsonb not null default '{}'::jsonb check (jsonb_typeof(socials) = 'object'),
  add column avatar_path text,
  add column cover_path text;

grant update (shop_slug, shop_name, bio, region, public_contact, details, socials, avatar_path, cover_path)
  on public.seller_profiles to authenticated;

/* ---------- chat threads and messages ---------- */
create table public.chat_threads (
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  seller_id uuid not null references public.profiles (id) on delete cascade,
  buyer_seen_at timestamptz,
  seller_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (buyer_id, seller_id)
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_buyer uuid not null references public.profiles (id) on delete cascade,
  thread_seller uuid not null references public.profiles (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);

create index chat_messages_thread_idx on public.chat_messages (thread_buyer, thread_seller, created_at);

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
revoke all on public.chat_threads, public.chat_messages from anon, authenticated;
grant select on public.chat_threads, public.chat_messages to authenticated;

create policy chat_threads_select_participant on public.chat_threads for select to authenticated
  using (buyer_id = (select auth.uid()) or seller_id = (select auth.uid()));

create policy chat_messages_select_participant on public.chat_messages for select to authenticated
  using (
    thread_buyer = (select auth.uid())
    or thread_seller = (select auth.uid())
  );

create trigger chat_threads_set_updated_at before update on public.chat_threads
  for each row execute function public.set_updated_at();

/* ---------- dispute evidence (metadata; files live in the dispute-evidence bucket) ---------- */
create table public.dispute_evidence (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index dispute_evidence_dispute_idx on public.dispute_evidence (dispute_id, created_at);

alter table public.dispute_evidence enable row level security;
revoke all on public.dispute_evidence from anon, authenticated;
grant select on public.dispute_evidence to authenticated;

create policy dispute_evidence_select_participant on public.dispute_evidence for select to authenticated
  using (exists (
    select 1 from public.disputes d
    join public.orders o on o.id = d.order_id
    where d.id = dispute_id
      and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
  ));

/* ---------- activity feed (orders, disputes, handoff, reviews, messages) ---------- */
create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in (
    'order_created', 'order_cancelled', 'escrow_funded', 'order_completed',
    'order_refunded', 'dispute_opened', 'dispute_reply', 'handoff_verified',
    'review_received', 'message_received', 'payout_requested'
  )),
  order_id uuid references public.orders (id) on delete cascade,
  dispute_id uuid references public.disputes (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activity_events_user_idx on public.activity_events (user_id, created_at desc);

alter table public.activity_events enable row level security;
revoke all on public.activity_events from anon, authenticated;
grant select on public.activity_events to authenticated;

create policy activity_events_select_own on public.activity_events for select to authenticated
  using (user_id = (select auth.uid()));

/* ---------- push subscriptions ---------- */
create table public.push_subscriptions (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

create policy push_subscriptions_own on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

/* ---------- transaction PINs (hashed with pgcrypto; service-role only) ---------- */
create extension if not exists pgcrypto;

create table public.transaction_pins (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  pin_hash text not null,
  changed_at timestamptz not null default now()
);

alter table public.transaction_pins enable row level security;
revoke all on public.transaction_pins from anon, authenticated;

/* ---------- support requests (profile change requests, support tickets) ---------- */
create table public.support_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  topic text not null check (char_length(topic) between 1 and 100),
  current_info text,
  proposed text not null check (char_length(proposed) between 1 and 2000),
  reason text check (reason is null or char_length(reason) <= 2000),
  status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index support_requests_user_idx on public.support_requests (user_id, created_at desc);

alter table public.support_requests enable row level security;
revoke all on public.support_requests from anon, authenticated;
grant select, insert (user_id, topic, current_info, proposed, reason) on public.support_requests to authenticated;

create policy support_requests_own on public.support_requests for select to authenticated
  using (user_id = (select auth.uid()));

create policy support_requests_insert_own on public.support_requests for insert to authenticated
  with check (user_id = (select auth.uid()));

create trigger support_requests_set_updated_at before update on public.support_requests
  for each row execute function public.set_updated_at();

/* ---------- storage: private dispute evidence, public shop media ---------- */
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dispute-evidence', 'dispute-evidence', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-media', 'shop-media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;

create policy dispute_evidence_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'dispute-evidence'
    and (storage.foldername(name))[1] in (
      select d.id::text
      from public.disputes d
      join public.orders o on o.id = d.order_id
      where o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid())
    )
  );

create policy dispute_evidence_read on storage.objects for select to authenticated
  using (
    bucket_id = 'dispute-evidence'
    and (storage.foldername(name))[1] in (
      select d.id::text
      from public.disputes d
      join public.orders o on o.id = d.order_id
      where o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid())
    )
  );

create policy shop_media_upload_own on storage.objects for insert to authenticated
  with check (bucket_id = 'shop-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy shop_media_read_public on storage.objects for select to anon, authenticated
  using (bucket_id = 'shop-media');
