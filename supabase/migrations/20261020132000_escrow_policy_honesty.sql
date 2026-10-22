/* ========================================================================== *
 * THE ESCROW POLICY IS HONEST
 *
 * The policy row in app_settings carried two switches that no code read,
 * and one of them contradicted the release rules the platform actually
 * implements:
 *
 *   agent_scan_can_release: false
 *       said an agent scan could never move the money, while
 *       record_handoff_scan and evaluate_escrow_release both release the
 *       escrow when the buyer's code is scanned, whoever scanned it.
 *       Outcome 2 of the release rules says the agent scan IS the fast
 *       path, so the stored value was the thing that was wrong: it had
 *       never been read, so no behaviour changes when it becomes true.
 *
 *   require_both_scans_for_fast_release: true
 *       said both codes had to be scanned, while the rules say the buyer
 *       never has to scan anything: the seller or the agent scans the
 *       buyer's code and the money moves in the same transaction. The
 *       key is removed rather than left as a trap for whoever reads the
 *       policy next.
 *
 * The agent switch is now read by evaluate_escrow_release, which every
 * release path funnels through, so operations can freeze agent-driven
 * releases by changing one setting and no migration. It defaults to
 * true, which is the documented behaviour.
 * ========================================================================== */

begin;

/* --------------------------------------------------------------------------
 * The release decision, with the agent switch honoured.
 * -------------------------------------------------------------------------- */
create or replace function public.evaluate_escrow_release(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_workflow public.order_delivery_workflows%rowtype;
  v_escrow public.escrow_transactions%rowtype;
  v_has_dispute boolean;
  v_window_minutes integer;
  v_fast_release boolean;
  v_auto_enabled boolean;
  v_agent_release boolean;
  v_now timestamptz := now();
begin
  select o.* into v_order from public.orders o where o.id = p_order_id;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'order_not_found');
  end if;

  select e.* into v_escrow from public.escrow_transactions e where e.order_id = p_order_id;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'no_escrow');
  end if;
  if v_escrow.status = 'released' then
    return jsonb_build_object('eligible', false, 'reason', 'already_released');
  end if;
  if v_escrow.status in ('refunded', 'split', 'cancelled') then
    return jsonb_build_object('eligible', false, 'reason', 'escrow_closed');
  end if;
  if v_escrow.status = 'held' then
    return jsonb_build_object('eligible', false, 'reason', 'on_hold',
      'hold_reason', v_escrow.hold_reason);
  end if;
  if v_order.status not in ('in_escrow', 'delivered') then
    return jsonb_build_object('eligible', false, 'reason', 'order_status_' || v_order.status::text);
  end if;

  select exists (
    select 1 from public.disputes d where d.order_id = p_order_id and d.status <> 'resolved'
  ) into v_has_dispute;
  if v_has_dispute then
    return jsonb_build_object('eligible', false, 'reason', 'open_dispute');
  end if;

  select w.* into v_workflow from public.order_delivery_workflows w where w.order_id = p_order_id;
  if not found then
    v_workflow.order_id := p_order_id;
  end if;

  v_window_minutes := coalesce(
    (public.escrow_policy('release_window_minutes', '180'::jsonb))::int, 180);
  v_fast_release := coalesce(
    (public.escrow_policy('buyer_qr_scan_releases_immediately', 'true'::jsonb))::boolean, true);
  v_auto_enabled := coalesce(
    (public.escrow_policy('auto_release_enabled', 'true'::jsonb))::boolean, true);
  v_agent_release := coalesce(
    (public.escrow_policy('agent_scan_can_release', 'true'::jsonb))::boolean, true);

  -- 1. The buyer explicitly confirmed receipt.
  if coalesce(public.escrow_policy('buyer_confirmation_releases_immediately', 'true'::jsonb))::boolean, true)
     and v_workflow.buyer_confirmed_at is not null then
    return jsonb_build_object('eligible', true, 'reason', 'buyer_confirmed',
      'path', 'explicit_confirmation', 'evaluated_at', v_now);
  end if;

  -- 2. The BUYER's code was scanned by the seller or an agent. This is
  --    the fast path: the goods were handed over, so release now.
  --    An agent scan only counts when operations allow it. When it does
  --    not, the handover is still recorded and the money waits for the
  --    buyer's own confirmation or for the window.
  if v_fast_release
     and v_workflow.buyer_code_scanned_at is not null
     and (coalesce(v_workflow.buyer_code_scanned_role, '') <> 'agent' or v_agent_release) then
    return jsonb_build_object('eligible', true, 'reason', 'buyer_qr_scanned',
      'path', 'fast_release',
      'scanned_at', v_workflow.buyer_code_scanned_at,
      'scanned_by_role', v_workflow.buyer_code_scanned_role,
      'evaluated_at', v_now);
  end if;

  if v_fast_release
     and v_workflow.buyer_code_scanned_at is not null
     and coalesce(v_workflow.buyer_code_scanned_role, '') = 'agent'
     and not v_agent_release then
    return jsonb_build_object('eligible', false, 'reason', 'agent_release_disabled',
      'scanned_at', v_workflow.buyer_code_scanned_at,
      'scanned_by_role', v_workflow.buyer_code_scanned_role,
      'evaluated_at', v_now);
  end if;

  -- 3. The buyer scanned the seller's code: the three-hour window.
  if v_workflow.seller_code_scanned_at is not null
     and v_workflow.release_scheduled_for is not null then
    if v_now >= v_workflow.release_scheduled_for then
      if not v_auto_enabled then
        return jsonb_build_object('eligible', false, 'reason', 'auto_release_disabled',
          'release_scheduled_for', v_workflow.release_scheduled_for, 'evaluated_at', v_now);
      end if;
      return jsonb_build_object('eligible', true, 'reason', 'window_elapsed',
        'path', 'timed_release',
        'release_scheduled_for', v_workflow.release_scheduled_for,
        'window_minutes', v_window_minutes,
        'evaluated_at', v_now);
    end if;
    return jsonb_build_object('eligible', false, 'reason', 'waiting_for_window',
      'release_scheduled_for', v_workflow.release_scheduled_for,
      'window_minutes', v_window_minutes,
      'seconds_remaining', greatest(0, ceil(extract(epoch from (v_workflow.release_scheduled_for - v_now)))::int),
      'evaluated_at', v_now);
  end if;

  -- 4. Nothing has been recorded yet.
  return jsonb_build_object('eligible', false, 'reason', 'no_handoff_recorded',
    'evaluated_at', v_now);
end;
$$;
revoke all on function public.evaluate_escrow_release(uuid) from public, anon, authenticated;
grant execute on function public.evaluate_escrow_release(uuid) to service_role, authenticated;

/* --------------------------------------------------------------------------
 * The stored policy now says what the code does.

   Only the keys the code reads are kept, and the agent switch takes the
   value the release rules describe. It was never read before, so no
   order changes behaviour: the money still moves on an agent scan,
   exactly as it did, and operations can now turn that off deliberately.
 * -------------------------------------------------------------------------- */
update public.app_settings
set value = jsonb_strip_nulls(
      coalesce(value, '{}'::jsonb)
      || jsonb_build_object(
           'release_window_minutes', coalesce(value -> 'release_window_minutes', '180'::jsonb),
           'buyer_qr_scan_releases_immediately', coalesce(value -> 'buyer_qr_scan_releases_immediately', 'true'::jsonb),
           'buyer_confirmation_releases_immediately', coalesce(value -> 'buyer_confirmation_releases_immediately', 'true'::jsonb),
           'agent_scan_can_release', 'true'::jsonb,
           'auto_release_enabled', coalesce(value -> 'auto_release_enabled', 'true'::jsonb)
         )
    ) - 'require_both_scans_for_fast_release'
where key = 'escrow_policy';

commit;
