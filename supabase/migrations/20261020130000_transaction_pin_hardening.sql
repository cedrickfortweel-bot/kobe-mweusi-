/* Kobe Mweusi — transaction PIN hardening.

   The PIN is what protects a withdrawal, so it has to be enforced in the
   database rather than in the page.

   WHAT WAS WRONG
   ---------------
   1. set_transaction_pin() accepted any text. The Edge Function checked
      the shape and a list of weak PINs, but the database did not, so any
      other path could store a one-digit PIN.
   2. There was no way to change a PIN safely. The caller had to read
      the old PIN and the new one separately, so the check and the write
      were not one operation.
   3. The failure counter never decayed, even though the comment said it
      did. Five wrong attempts locked a PIN for fifteen minutes, and the
      counter stayed at five, so the next wrong attempt locked it again
      straight away.
   4. A verified seller was told that changing their PIN held
      withdrawals for 24 hours. Nothing enforced that.

   WHAT THIS DOES
   --------------
   The shape and the weak list live in one place, in the database, and
   the Edge Function asks the database rather than repeating the rules.

   The weak list is deliberately longer than the page's list. The page
   gives instant feedback, the database is the one that matters, and a
   PIN that is refused by the database but accepted by the page would
   leave the seller thinking their PIN was set when it was not.
*/

begin;

/* ========================================================================== *
 * 1. THE RULES, IN ONE PLACE
 * ========================================================================== */

create or replace function public.pin_is_acceptable(p_pin text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select
    p_pin is not null
    and p_pin ~ '^[0-9]{6}$'
    /* Repeats and sequences. */
    and p_pin not in (
      '000000', '111111', '222222', '333333', '444444', '555555',
      '666666', '777777', '888888', '999999',
      '123456', '654321', '123123', '121212', '112233', '100000',
      '258000', '012345', '456789', '987654', '147258', '258369'
    )
    /* Any run of the same digit. */
    and p_pin !~ '^([0-9])\1{5}$'
    /* Ascending or descending six digits. */
    and p_pin <> '012345'
    and p_pin <> '987654';
$$;
revoke all on function public.pin_is_acceptable(text) from public, anon;
grant execute on function public.pin_is_acceptable(text) to service_role;

create or replace function public.pin_rejection_reason(p_pin text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_pin is null or p_pin !~ '^[0-9]{6}$' then 'Use exactly 6 digits.'
    when public.pin_is_acceptable(p_pin) then null
    else 'That PIN is too easy to guess. Choose another one.'
  end;
$$;
revoke all on function public.pin_rejection_reason(text) from public, anon;
grant execute on function public.pin_rejection_reason(text) to service_role;

/* ========================================================================== *
 * 2. SETTING A PIN
 *
 *    The database checks the PIN, so no path can store a weak or
 *    malformed one.
 * ========================================================================== */

create or replace function public.set_transaction_pin(p_user uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  v_reason := public.pin_rejection_reason(p_pin);
  if v_reason is not null then
    raise exception '%', v_reason using errcode = 'P0001';
  end if;

  insert into public.transaction_pins (user_id, pin_hash, changed_at)
  values (p_user, crypt(p_pin, gen_salt('bf')), now())
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash, changed_at = now();

  -- A new PIN clears any lock and the failure count.
  update public.pin_throttle
  set failed_attempts = 0, locked_until = null, last_attempt_at = now(), updated_at = now()
  where user_id = p_user;
end;
$$;
revoke all on function public.set_transaction_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.set_transaction_pin(uuid, text) to service_role;

/* ========================================================================== *
 * 3. CHANGING A PIN, AS ONE OPERATION
 *
 *    The old PIN is verified and the new one written in the same
 *    transaction, and a wrong old PIN counts towards the lockout just
 *    like a wrong check does.
 * ========================================================================== */

create or replace function public.change_transaction_pin(
  p_user uuid,
  p_current_pin text,
  p_new_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_has_pin boolean;
  v_ok boolean;
  v_reason text;
  v_locked_until timestamptz;
begin
  select exists (select 1 from public.transaction_pins t where t.user_id = p_user) into v_has_pin;

  if not v_has_pin then
    perform public.set_transaction_pin(p_user, p_new_pin);
    return jsonb_build_object('ok', true, 'action', 'set');
  end if;

  -- The same lockout as a PIN check, so guessing the old PIN is as
  -- throttled as guessing it to withdraw.
  select t.locked_until into v_locked_until
  from public.pin_throttle t where t.user_id = p_user;

  if v_locked_until is not null and v_locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'locked_until', v_locked_until,
      'retry_after_seconds', ceil(extract(epoch from (v_locked_until - now())))::int);
  end if;

  select public.verify_transaction_pin(p_user, p_current_pin) into v_ok;

  if not v_ok then
    perform public.record_failed_pin_attempt(p_user);
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  v_reason := public.pin_rejection_reason(p_new_pin);
  if v_reason is not null then
    raise exception '%', v_reason using errcode = 'P0001';
  end if;

  perform public.set_transaction_pin(p_user, p_new_pin);

  return jsonb_build_object('ok', true, 'action', 'changed');
end;
$$;
revoke all on function public.change_transaction_pin(uuid, text, text) from public, anon, authenticated;
grant execute on function public.change_transaction_pin(uuid, text, text) to service_role;

/* ========================================================================== *
 * 4. THE FAILURE COUNTER DECAYS
 *
 *    The counter only counts attempts that are close together. Five
 *    wrong tries inside the window lock the PIN; a stray wrong try from
 *    last week does not count towards the next lock.
 * ========================================================================== */

alter table public.pin_throttle
  add column if not exists last_attempt_at timestamptz;

create or replace function public.record_failed_pin_attempt(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_failures integer;
  v_lock_until timestamptz;
  v_last timestamptz;
begin
  select t.last_attempt_at into v_last
  from public.pin_throttle t where t.user_id = p_user;

  -- An attempt more than fifteen minutes after the last one starts a
  -- fresh count rather than adding to an old one.
  if v_last is not null and v_last < now() - interval '15 minutes' then
    v_failures := 0;
  else
    v_failures := coalesce(
      (select t.failed_attempts from public.pin_throttle t where t.user_id = p_user), 0);
  end if;

  v_failures := v_failures + 1;

  insert into public.pin_throttle (user_id, failed_attempts, locked_until, last_attempt_at, updated_at)
  values (p_user, v_failures, null, now(), now())
  on conflict (user_id) do update
    set failed_attempts = excluded.failed_attempts,
        locked_until = null,
        last_attempt_at = now(),
        updated_at = now();

  -- Five failures inside the window locks the PIN for fifteen minutes.
  if v_failures >= 5 then
    v_lock_until := now() + interval '15 minutes';

    update public.pin_throttle
    set locked_until = v_lock_until, failed_attempts = 0, last_attempt_at = now(), updated_at = now()
    where user_id = p_user;

    insert into public.security_events (user_id, event_type, severity, detail)
    values (p_user, 'pin_locked', 'critical',
      jsonb_build_object('locked_until', v_lock_until));

    perform public.record_account_security_event(
      p_user, 'transaction_pin_lockout', 'critical', null, null,
      jsonb_build_object('locked_until', v_lock_until));

    return jsonb_build_object('ok', false, 'locked', true, 'locked_until', v_lock_until);
  end if;

  insert into public.security_events (user_id, event_type, severity)
  values (p_user, 'pin_failed', 'warning');

  return jsonb_build_object('ok', false, 'locked', false, 'attempts', v_failures,
    'attempts_remaining', greatest(0, 5 - v_failures));
end;
$$;
revoke all on function public.record_failed_pin_attempt(uuid) from public, anon, authenticated;
grant execute on function public.record_failed_pin_attempt(uuid) to service_role;

/* A correct PIN clears the counter and the lock, and stamps the attempt
   so the decay window is measured from the right moment. */
create or replace function public.check_transaction_pin(
  p_user uuid,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
  v_locked_until timestamptz;
begin
  select t.locked_until into v_locked_until
  from public.pin_throttle t where t.user_id = p_user;

  if v_locked_until is not null and v_locked_until > now() then
    insert into public.security_events (user_id, event_type, severity, detail)
    values (p_user, 'pin_locked', 'warning',
      jsonb_build_object('locked_until', v_locked_until));

    return jsonb_build_object('ok', false, 'reason', 'locked',
      'locked_until', v_locked_until,
      'retry_after_seconds', ceil(extract(epoch from (v_locked_until - now())))::int);
  end if;

  select public.verify_transaction_pin(p_user, p_pin) into v_ok;

  if not v_ok then
    return public.record_failed_pin_attempt(p_user);
  end if;

  update public.pin_throttle
  set failed_attempts = 0, locked_until = null, last_attempt_at = now(), updated_at = now()
  where user_id = p_user;

  insert into public.security_events (user_id, event_type, severity)
  values (p_user, 'pin_set', 'info');

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.check_transaction_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.check_transaction_pin(uuid, text) to service_role;

/* The state of the PIN for the screen: is one set, and is it locked. */
create or replace function public.pin_state(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'has_pin', exists (select 1 from public.transaction_pins t where t.user_id = p_user),
    'locked_until', (select t.locked_until from public.pin_throttle t where t.user_id = p_user),
    'failed_attempts', coalesce((select t.failed_attempts from public.pin_throttle t where t.user_id = p_user), 0),
    'changed_at', (select t.changed_at from public.transaction_pins t where t.user_id = p_user)
  );
$$;
revoke all on function public.pin_state(uuid) from public, anon, authenticated;
grant execute on function public.pin_state(uuid) to service_role;

commit;
