/* ========================================================================== *
 * THE ADMIN CONSOLE READS
 *
 * The operations console could only see three things: the seller
 * verification queue, the payout queue and, since the agent work, the
 * agent network. Everything else on the page was a placeholder with a
 * label and no numbers behind it.
 *
 * These functions give staff the rest of the picture: what the platform
 * holds, what is moving, what is stuck and who did what. They read
 * only. Anything that moves money stays behind the procedures that
 * already exist, which are audited and, where it matters, need a second
 * person.
 *
 * All of them are granted to service_role alone, and the admin Edge
 * Function refuses a caller who is not staff.
 * ========================================================================== */

begin;

/* --------------------------------------------------------------------------
 * The dashboard.
 * -------------------------------------------------------------------------- */
create or replace function public.admin_overview()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'orders', jsonb_build_object(
      'total', (select count(*) from public.orders),
      'in_escrow', (select count(*) from public.orders where status = 'in_escrow'),
      'delivered', (select count(*) from public.orders where status = 'delivered'),
      'disputed', (select count(*) from public.orders where status = 'disputed'),
      'completed', (select count(*) from public.orders where status = 'completed'),
      'cancelled', (select count(*) from public.orders where status = 'cancelled')
    ),
    'money', jsonb_build_object(
      /* The money the platform is holding for a buyer. This is the
         number that matters most, because it is money that has left a
         buyer and not yet reached a seller. */
      'held_in_escrow', (select coalesce(sum(amount_tzs), 0) from public.escrow_transactions where status = 'funded'),
      'on_hold', (select coalesce(sum(amount_tzs), 0) from public.escrow_transactions where status = 'held'),
      'released_to_sellers', (select coalesce(sum(amount_tzs), 0) from public.escrow_transactions where status = 'released'),
      'platform_fees', (select coalesce(sum(platform_fee_tzs), 0) from public.escrow_transactions where status = 'released'),
      'pending_payouts', (select coalesce(sum(amount_tzs), 0) from public.payout_requests where status = 'requested')
    ),
    'queues', jsonb_build_object(
      'kyc', (select count(*) from public.seller_kyc_submissions where status in ('pending', 'under_review')),
      'payouts', (select count(*) from public.payout_requests where status = 'requested'),
      'disputes', (select count(*) from public.disputes where status <> 'resolved'),
      'agents', (select count(*) from public.delivery_agents)
    ),
    'people', jsonb_build_object(
      'buyers', (select count(*) from public.profiles where account_type = 'buyer'),
      'sellers', (select count(*) from public.seller_profiles),
      'verified_sellers', (select count(*) from public.seller_profiles where verification_status = 'verified')
    ),
    'activity', jsonb_build_object(
      'orders_24h', (select count(*) from public.orders where created_at >= now() - interval '24 hours'),
      'orders_7d', (select count(*) from public.orders where created_at >= now() - interval '7 days'),
      'released_7d', (select count(*) from public.escrow_transactions where status = 'released' and released_at >= now() - interval '7 days')
    )
  );
$$;
revoke all on function public.admin_overview() from public, anon, authenticated;
grant execute on function public.admin_overview() to service_role;

/* --------------------------------------------------------------------------
 * The order list. Staff search by reference, item or name.
 * -------------------------------------------------------------------------- */
create or replace function public.admin_order_queue(
  p_query text default null,
  p_limit integer default 50
)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with q as (
    select nullif(btrim(p_query), '') as needle
  )
  select jsonb_build_object(
    'id', o.id,
    'ref', o.ref,
    'item_name', o.item_name,
    'quantity', o.quantity,
    'total_due_tzs', o.total_due_tzs,
    'status', o.status,
    'created_at', o.created_at,
    'buyer_name', bp.display_name,
    'buyer_phone', bp.phone_e164,
    'seller_name', sp.shop_name,
    'seller_kobe_id', sp.kobe_id,
    'escrow_status', e.status,
    'escrow_amount_tzs', e.amount_tzs,
    'escrow_funded_at', e.funded_at,
    'escrow_released_at', e.released_at,
    'open_dispute', exists (
      select 1 from public.disputes d
      where d.order_id = o.id and d.status <> 'resolved'
    )
  )
  from public.orders o
  join public.profiles bp on bp.id = o.buyer_id
  join public.seller_profiles sp on sp.user_id = o.seller_id
  left join public.escrow_transactions e on e.order_id = o.id
  cross join q
  where (q.needle is null
         or o.ref ilike '%' || q.needle || '%'
         or o.item_name ilike '%' || q.needle || '%'
         or bp.display_name ilike '%' || q.needle || '%'
         or sp.shop_name ilike '%' || q.needle || '%')
  order by o.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke all on function public.admin_order_queue(text, integer) from public, anon, authenticated;
grant execute on function public.admin_order_queue(text, integer) to service_role;

/* --------------------------------------------------------------------------
 * The dispute queue. A dispute that is past its seller deadline is the
 * one that needs a person, so it is marked.
 * -------------------------------------------------------------------------- */
create or replace function public.admin_dispute_queue(p_limit integer default 50)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id,
    'order_ref', o.ref,
    'order_id', o.id,
    'item_name', o.item_name,
    'total_due_tzs', o.total_due_tzs,
    'reason', d.reason,
    'status', d.status,
    'outcome', d.outcome,
    'opened_at', d.created_at,
    'seller_deadline', d.seller_deadline,
    'overdue', d.status <> 'resolved' and d.seller_deadline < now(),
    'buyer_name', bp.display_name,
    'seller_name', sp.shop_name,
    'escrow_status', e.status
  )
  from public.disputes d
  join public.orders o on o.id = d.order_id
  join public.profiles bp on bp.id = d.opened_by
  join public.seller_profiles sp on sp.user_id = o.seller_id
  left join public.escrow_transactions e on e.order_id = o.id
  order by (d.status <> 'resolved' and d.seller_deadline < now()) desc, d.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;
revoke all on function public.admin_dispute_queue(integer) from public, anon, authenticated;
grant execute on function public.admin_dispute_queue(integer) to service_role;

commit;
