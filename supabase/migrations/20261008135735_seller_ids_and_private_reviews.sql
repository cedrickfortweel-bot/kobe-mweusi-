alter table public.seller_profiles
	add column kobe_id text not null default (
		'KM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
	);

alter table public.seller_profiles
	add constraint seller_profiles_kobe_id_unique unique (kobe_id);

revoke select on public.reviews from anon, authenticated;
grant select (seller_id, stars, comment, created_at) on public.reviews to anon, authenticated;
revoke insert on public.reviews from authenticated;
grant insert (order_id, buyer_id, seller_id, stars, comment) on public.reviews to authenticated;
