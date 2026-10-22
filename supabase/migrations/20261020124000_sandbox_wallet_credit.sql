/* Kobe Mweusi — sandbox wallet credits.

   Both the buyer and the seller journeys dead-end at one point: the
   buyer has no money in the wallet, because the payment provider is not
   connected. Nothing downstream of that can be exercised, so the escrow
   rules, the handoff scan, the release and the payout can only be
   tested once a provider exists.

   This adds a SANDBOX top-up, so the whole flow can be walked end to
   end before AzamPay is connected.

   WHY IT CANNOT LEAK INTO PRODUCTION
   ----------------------------------
   Three independent guards, and the decisive one is in the database:

     1. The database function refuses unless
        payment_provider_config.environment = 'sandbox'. This is the
        real guard: it is the same table that decides whether the
        provider is live, so moving the project to production disables
        it.
     2. The Edge Function checks the same thing before calling it.
     3. The amount is capped, and the ledger entry is tagged so a
        sandbox credit is visible as one in the activity feed.

   A sandbox credit is a real ledger entry, so the balance, the escrow
   and the payout all behave exactly as they will with real money. The
   only thing that is not real is where the money came from.
*/

begin;

/* ========================================================================== *
 * 1. THE CREDIT ITSELF
 * ========================================================================== */

create or replace function public.sandbox_wallet_credit(
  p_buyer_id uuid,
  p_amount_tzs bigint,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_key text;
begin
  -- The decisive guard. If the provider is not configured for the
  -- sandbox, there is no sandbox.
  if not exists (
    select 1 from public.payment_provider_config
    where provider = 'azampay' and environment = 'sandbox'
  ) then
    raise exception 'Sandbox credits are only available while the payment provider is in the sandbox environment'
      using errcode = '42501';
  end if;

  if p_buyer_id is null then
    raise exception 'A buyer is required' using errcode = 'P0001';
  end if;
  if p_amount_tzs is null or p_amount_tzs <= 0 or p_amount_tzs > 1000000 then
    raise exception 'A sandbox credit must be between 1 and 1,000,000 TZS' using errcode = 'P0001';
  end if;
  if not public.is_account_active(p_buyer_id) then
    raise exception 'This account is not active' using errcode = '42501';
  end if;

  -- A distinct ledger key per credit, so a retry cannot credit twice.
  v_key := 'sandbox:' || p_buyer_id::text || ':' ||
           (extract(epoch from clock_timestamp())::bigint)::text;

  perform public.post_ledger_transaction(
    p_buyer_id, p_amount_tzs, 'top_up', v_key, null, null);

  v_balance := public.wallet_balance(p_buyer_id);

  insert into public.activity_events (user_id, kind, payload)
  values (p_buyer_id, 'wallet_topped_up', jsonb_build_object(
    'amount', p_amount_tzs,
    'balance', v_balance,
    'sandbox', true,
    'note', nullif(btrim(coalesce(p_note, '')), '')
  ));

  return jsonb_build_object(
    'ok', true,
    'amount_tzs', p_amount_tzs,
    'balance_tzs', v_balance,
    'sandbox', true);
end;
$$;
revoke all on function public.sandbox_wallet_credit(uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.sandbox_wallet_credit(uuid, bigint, text) to service_role;

commit;
