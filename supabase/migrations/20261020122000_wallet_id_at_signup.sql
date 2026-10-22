/* Kobe Mweusi — the Wallet ID exists from the moment of sign-up.

   A buyer who signs up should see their Wallet ID straight away, not on
   their second visit after something else happened to create the wallet
   row. The Wallet ID is their identity on the platform, so it is part of
   the account, not something the app has to remember to ask for.

   The sign-up trigger now creates the wallet row alongside the profile.

   WHY IT MUST NOT BLOCK SIGN-UP
   ------------------------------
   The wallet insert is wrapped, so a failure inside it can never stop
   somebody from registering. If the wallet row is missing for any reason,
   ensure_my_wallet() creates it on the buyer's first use, and the app
   says "not assigned yet" until then rather than showing a blank.

   The Wallet ID itself is unchanged in shape. It is two digits and four
   letters, and the letters are a consonant-vowel-consonant-vowel pattern
   so it can be read out loud at a hub.
*/

begin;

/* ========================================================================== *
 * 1. SIGN-UP CREATES THE WALLET
 * ========================================================================== */

create or replace function public.handle_new_user()
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

  -- Give the account its Wallet ID straight away, so the buyer sees it
  -- on the first screen after signing up.
  begin
    insert into public.wallets (user_id, wallet_id)
    values (new.id, public.generate_wallet_id())
    on conflict (user_id) do nothing;
  exception when others then
    -- Never block the registration over a wallet row. The row is created
    -- on first use instead.
    null;
  end;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon;
grant execute on function public.handle_new_user() to service_role;

/* ========================================================================== *
 * 2. EXISTING ACCOUNTS GET ONE TOO
 *
 *    An account that signed up before this change has no wallet row, so
 *    it has no Wallet ID. Creating the missing rows is safe: the id is
 *    unique, and an account that already has one keeps it.
 * ========================================================================== */

do $$
declare
  r record;
  v_wallet_id text;
  v_created integer := 0;
begin
  for r in
    select p.id
    from public.profiles p
    where not exists (select 1 from public.wallets w where w.user_id = p.id)
  loop
    begin
      v_wallet_id := public.generate_wallet_id();
      insert into public.wallets (user_id, wallet_id)
      values (r.id, v_wallet_id)
      on conflict (user_id) do nothing;
      v_created := v_created + 1;
    exception when others then
      null;
    end;
  end loop;

  raise notice 'Created % missing wallet rows.', v_created;
end
$$;

commit;
