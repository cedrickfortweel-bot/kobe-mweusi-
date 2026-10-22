/* Kobe Mweusi — schedule the notification worker.

   The worker (supabase/functions/notify) drains the delivery queue. It
   has to run on a schedule, and pg_cron cannot call an Edge Function
   directly, so it goes through pg_net.

   THE SERVICE KEY STAYS IN VAULT
   -------------------------------
   The worker endpoint is protected by the service role key, so the cron
   job needs it. It is read from Supabase Vault, which is encrypted at
   rest, and is never written into a table in public.

   Two secrets are needed:

     insert into vault.secrets (name, secret)
     values
       ('kobe_functions_url', 'https://<project-ref>.supabase.co'),
       ('kobe_service_key',  '<service-role-key>');

   If Vault is not available on the project, the schedule is skipped
   rather than failing, and the worker can be called by any external
   scheduler instead:

     curl -X POST "<project-ref>.supabase.co/functions/v1/notify" \
       -H "Authorization: Bearer <service-role-key>" \
       -H "Content-Type: application/json" -d '{}'
*/

begin;

do $$
declare
  v_has_vault boolean := false;
  v_has_net boolean := false;
  v_url text;
  v_key text;
begin
  select exists (select 1 from pg_extension where extname = 'supabase_vault') into v_has_vault;
  select exists (select 1 from pg_extension where extname = 'pg_net') into v_has_net;

  if not (v_has_vault and v_has_net) then
    raise notice 'Vault or pg_net is not available; the notification worker is not scheduled.';
    return;
  end if;

  select decrypted_secret into v_url
  from vault.decrypted_secrets where name = 'kobe_functions_url';
  select decrypted_secret into v_key
  from vault.decrypted_secrets where name = 'kobe_service_key';

  if v_url is null or v_key is null then
    raise notice 'The worker secrets are not in Vault; the notification worker is not scheduled.';
    return;
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'kobe-notify-worker';

  perform cron.schedule(
    'kobe-notify-worker',
    '* * * * *',
    format(
      $q$select net.http_post(
        url := %L || '/functions/v1/notify',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || %L
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 20000
      )$q$,
      v_url,
      v_key
    )
  );
end
$$;

commit;
