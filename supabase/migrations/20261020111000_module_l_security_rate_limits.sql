/* Kobe Mweusi — Module L: fraud prevention, rate limiting and security.

   Secrets are never logged. Passwords, access tokens and full payment
   credentials never reach an application table, an audit row or a log
   line. PINs are stored as a bcrypt hash and compared with a throttled,
   timing-safe path.

   The existing pin_throttle, transaction_pins and rate_limit_counters
   tables stay. This module adds the risk and receipt layer on top.

   Tables added here
     risk_events               suspicious activity and risk signals
     webhook_event_receipts    idempotent tracking of external processing
     security_events           important security event records
     idempotency_keys          generic claim-once keys

   Functions added here
     check_transaction_pin(), record_failed_pin_attempt(), enforce_rate_limit(),
     record_security_event(), record_risk_event(), verify_payment_webhook(),
     claim_idempotency_key(), release_idempotency_key()
*/

/* ========================================================================== *
 * 1. TABLES
 * ========================================================================== */

create table if not exists public.security_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete cascade,
  event_type text not null
    check (event_type in (
      'login', 'logout', 'signup', 'password_change', 'password_reset',
      'email_change', 'phone_change', 'pin_set', 'pin_changed', 'pin_failed',
      'pin_locked', 'token_refresh', 'session_revoked', 'mfa_enrolled',
      'mfa_failed', 'api_key_used', 'unusual_ip', 'impossible_travel',
      'rate_limit_exceeded', 'webhook_signature_failed'
    )),
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  ip_hash text,
  user_agent text,
  device_label text,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists security_events_user_idx
  on public.security_events (user_id, created_at desc);
create index if not exists security_events_type_idx
  on public.security_events (event_type, created_at desc);

alter table public.security_events enable row level security;
revoke all on public.security_events from anon, authenticated;
grant select on public.security_events to authenticated;

drop policy if exists security_events_select_own on public.security_events;
create policy security_events_select_own on public.security_events
  for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.risk_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete cascade,
  order_id uuid references public.orders (id) on delete cascade,
  signal text not null check (char_length(signal) between 2 and 80),
  score smallint not null default 0 check (score between 0 and 100),
  severity text not null default 'low'
    check (severity in ('low', 'medium', 'high', 'critical')),
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'dismissed', 'actioned')),
  reviewed_by uuid references public.profiles (id),
  review_note text check (review_note is null or char_length(review_note) <= 1000),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists risk_events_open_idx
  on public.risk_events (severity, created_at desc)
  where status in ('open', 'reviewing');

alter table public.risk_events enable row level security;
revoke all on public.risk_events from anon, authenticated;

create table if not exists public.webhook_event_receipts (
  id uuid primary key default gen_random_uuid(),
  source text not null check (char_length(source) between 2 and 60),
  external_id text not null,
  event_type text,
  signature_verified boolean not null default false,
  status text not null default 'received'
    check (status in ('received', 'processed', 'ignored', 'failed', 'duplicate')),
  attempts integer not null default 0 check (attempts >= 0),
  payload jsonb not null default '{}'::jsonb,
  error text check (error is null or char_length(error) <= 1000),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (source, external_id)
);

create index if not exists webhook_event_receipts_status_idx
  on public.webhook_event_receipts (status, received_at desc);

alter table public.webhook_event_receipts enable row level security;
revoke all on public.webhook_event_receipts from anon, authenticated;

create table if not exists public.idempotency_keys (
  key text primary key check (char_length(key) between 8 and 200),
  scope text not null default 'general' check (char_length(scope) between 1 and 60),
  user_id uuid references public.profiles (id) on delete cascade,
  request_hash text,
  response jsonb,
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create index if not exists idempotency_keys_expiry_idx on public.idempotency_keys (expires_at);

alter table public.idempotency_keys enable row level security;
revoke all on public.idempotency_keys from anon, authenticated;

/* ========================================================================== *
 * 2. RATE LIMITING
 * ========================================================================== */

/* A rate limit that any Edge Function can call with its own scope. */
create or replace function public.enforce_rate_limit(
  p_scope text,
  p_subject text,
  p_limit integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_result record;
begin
  if p_scope is null or btrim(p_scope) = '' then
    raise exception 'A scope is required' using errcode = 'P0001';
  end if;

  v_hash := md5(p_scope || ':' || coalesce(p_subject, 'anonymous'));

  select r.allowed, r.remaining, r.retry_after_seconds
    into v_result
  from public.consume_rate_limit(p_scope, v_hash, p_limit, p_window_seconds) r;

  if not v_result.allowed then
    insert into public.security_events (user_id, event_type, severity, detail)
    values (null, 'rate_limit_exceeded', 'warning',
      jsonb_build_object('scope', p_scope, 'retry_after', v_result.retry_after_seconds));

    raise exception using
      errcode = 'P0001',
      message = 'RATE_LIMITED',
      detail = v_result.retry_after_seconds::text;
  end if;

  return jsonb_build_object(
    'allowed', true,
    'remaining', v_result.remaining,
    'retry_after_seconds', v_result.retry_after_seconds);
end;
$$;
revoke all on function public.enforce_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.enforce_rate_limit(text, text, integer, integer) to service_role;

/* ========================================================================== *
 * 3. TRANSACTION PIN
 * ========================================================================== */

/* Check a transaction PIN. A locked account is refused even if the PIN is
   correct, and every failure is throttled. */
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
  v_failures integer;
begin
  select t.locked_until, t.failed_attempts into v_locked_until, v_failures
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
    perform public.record_failed_pin_attempt(p_user);
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- A correct PIN clears the failure counter.
  update public.pin_throttle
    set failed_attempts = 0, locked_until = null, updated_at = now()
    where user_id = p_user;

  insert into public.security_events (user_id, event_type, severity)
  values (p_user, 'pin_set', 'info');

  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.check_transaction_pin(uuid, text) from public, anon, authenticated;
grant execute on function public.check_transaction_pin(uuid, text) to service_role;

/* Record a failed PIN attempt and apply the lockout. */
create or replace function public.record_failed_pin_attempt(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_failures integer;
  v_lock_until timestamptz;
begin
  insert into public.pin_throttle (user_id, failed_attempts, locked_until, updated_at)
  values (p_user, 1, null, now())
  on conflict (user_id) do update
    set failed_attempts = public.pin_throttle.failed_attempts + 1,
        updated_at = now()
  returning failed_attempts into v_failures;

  -- 5 failures locks the PIN for 15 minutes; the counter then decays.
  if v_failures >= 5 then
    v_lock_until := now() + interval '15 minutes';

    update public.pin_throttle
    set locked_until = v_lock_until, failed_attempts = 0, updated_at = now()
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

/* ========================================================================== *
 * 4. EVENT RECORDING
 * ========================================================================== */

create or replace function public.record_security_event(
  p_user_id uuid,
  p_event_type text,
  p_severity text default 'info',
  p_ip_hash text default null,
  p_user_agent text default null,
  p_device_label text default null,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.security_events
    (user_id, event_type, severity, ip_hash, user_agent, device_label, detail)
  values
    (p_user_id, p_event_type, coalesce(p_severity, 'info'), p_ip_hash,
     left(coalesce(p_user_agent, ''), 300), left(coalesce(p_device_label, ''), 80),
     coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.record_security_event(uuid, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_security_event(uuid, text, text, text, text, text, jsonb)
  to service_role;

create or replace function public.record_risk_event(
  p_user_id uuid,
  p_signal text,
  p_score smallint default 0,
  p_severity text default 'low',
  p_order_id uuid default null,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.risk_events (user_id, order_id, signal, score, severity, detail)
  values (p_user_id, p_order_id, p_signal, coalesce(p_score, 0),
          coalesce(p_severity, 'low'), coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  if coalesce(p_score, 0) >= 70 then
    perform public.record_account_security_event(
      p_user_id, 'suspicious_login', 'critical', null, null,
      jsonb_build_object('signal', p_signal, 'score', p_score));
  end if;

  return v_id;
end;
$$;
revoke all on function public.record_risk_event(uuid, text, smallint, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_risk_event(uuid, text, smallint, text, uuid, jsonb)
  to service_role;

/* ========================================================================== *
 * 5. WEBHOOK VERIFICATION
 * ========================================================================== */

/* Verify a provider callback and record it exactly once.

   The signature check itself belongs in the Edge Function, which holds the
   provider secret. This function is the second line: it records the event,
   refuses a callback whose signature was not verified, and refuses a second
   processing of the same event. */
create or replace function public.verify_payment_webhook(
  p_source text,
  p_external_id text,
  p_event_type text,
  p_signature_verified boolean,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.webhook_event_receipts%rowtype;
  v_duplicate boolean := false;
begin
  if p_external_id is null or btrim(p_external_id) = '' then
    raise exception 'An external event id is required' using errcode = 'P0001';
  end if;

  if not p_signature_verified then
    insert into public.security_events (user_id, event_type, severity, detail)
    values (null, 'webhook_signature_failed', 'critical',
      jsonb_build_object('source', p_source, 'external_id', p_external_id));

    insert into public.webhook_event_receipts
      (source, external_id, event_type, signature_verified, status, error)
    values (p_source, p_external_id, p_event_type, false, 'failed',
            'Signature verification failed')
    on conflict (source, external_id) do update
      set attempts = public.webhook_event_receipts.attempts + 1,
          error = 'Signature verification failed',
          status = 'failed';

    raise exception 'Signature verification failed' using errcode = '42501';
  end if;

  insert into public.webhook_event_receipts
    (source, external_id, event_type, signature_verified, status, payload, attempts)
  values (p_source, p_external_id, p_event_type, true, 'received', coalesce(p_payload, '{}'::jsonb), 1)
  on conflict (source, external_id) do update
    set attempts = public.webhook_event_receipts.attempts + 1
  returning * into v_receipt;

  if v_receipt.status = 'processed' or v_receipt.attempts > 1 then
    v_duplicate := true;
    update public.webhook_event_receipts
      set status = 'duplicate', processed_at = now()
      where id = v_receipt.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_duplicate,
    'receipt_id', v_receipt.id,
    'attempts', v_receipt.attempts);
end;
$$;
revoke all on function public.verify_payment_webhook(text, text, text, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.verify_payment_webhook(text, text, text, boolean, jsonb)
  to service_role;

/* Mark a webhook receipt as processed. */
create or replace function public.complete_webhook_receipt(
  p_receipt_id uuid,
  p_status text default 'processed',
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.webhook_event_receipts
    set status = coalesce(p_status, 'processed'),
        error = nullif(left(coalesce(p_error, ''), 1000), ''),
        processed_at = now()
    where id = p_receipt_id;
  return found;
end;
$$;
revoke all on function public.complete_webhook_receipt(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_webhook_receipt(uuid, text, text) to service_role;

/* ========================================================================== *
 * 6. GENERIC IDEMPOTENCY
 * ========================================================================== */

/* Claim a key. Returns true when the caller owns the key, false when the
   key is already in use by someone else. */
create or replace function public.claim_idempotency_key(
  p_key text,
  p_scope text default 'general',
  p_user_id uuid default null,
  p_request_hash text default null,
  p_ttl_seconds integer default 86400
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean := false;
begin
  insert into public.idempotency_keys (key, scope, user_id, request_hash, expires_at)
  values (p_key, coalesce(p_scope, 'general'), p_user_id, p_request_hash,
          now() + make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 86400), 604800))))
  on conflict (key) do update
    set expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 86400), 604800)))
    where public.idempotency_keys.status = 'failed'
       or public.idempotency_keys.expires_at <= now()
  returning true into v_claimed;

  if v_claimed is null then
    return false;
  end if;

  return true;
end;
$$;
revoke all on function public.claim_idempotency_key(text, text, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_idempotency_key(text, text, uuid, text, integer) to service_role;

/* Store the result of a claimed key so a retry returns the same answer. */
create or replace function public.complete_idempotency_key(
  p_key text,
  p_response jsonb,
  p_success boolean default true
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.idempotency_keys
    set status = case when coalesce(p_success, true) then 'completed' else 'failed' end,
        response = coalesce(p_response, '{}'::jsonb)
    where key = p_key;
  return found;
end;
$$;
revoke all on function public.complete_idempotency_key(text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.complete_idempotency_key(text, jsonb, boolean) to service_role;

/* Expired keys are removed on a schedule. */
create or replace function public.prune_idempotency_keys()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  delete from public.idempotency_keys where expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.prune_idempotency_keys() from public, anon, authenticated;
grant execute on function public.prune_idempotency_keys() to service_role;
