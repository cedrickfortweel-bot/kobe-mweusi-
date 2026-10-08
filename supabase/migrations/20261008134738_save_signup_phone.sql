create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
	insert into public.profiles (id, account_type, display_name, phone_e164)
	values (
		new.id,
		case when new.raw_user_meta_data ->> 'account_type' = 'seller'
			then 'seller'::public.account_type else 'buyer'::public.account_type end,
		coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'Kobe user'),
		nullif(btrim(new.raw_user_meta_data ->> 'phone_e164'), '')
	);
	return new;
end;
$$;
