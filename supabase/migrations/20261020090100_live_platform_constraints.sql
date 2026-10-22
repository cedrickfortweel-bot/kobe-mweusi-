/* Kobe Mweusi — live platform constraints.

   Runs in its own transaction AFTER 20261020090000_live_schema_reconciliation.sql
   so the new live_platform values (instagram, facebook, whatsapp) are already
   committed and may legally appear in a CHECK constraint.

   The original constraint only recognised TikTok and YouTube. The buyer and
   seller PWAs already offer WhatsApp, Instagram, TikTok and Facebook, so the
   live database must accept all five.
*/

alter table public.live_sessions
  drop constraint if exists live_session_external_url;

alter table public.live_sessions
  add constraint live_session_external_url
  check (
    (platform = 'tiktok' and external_url ~* '^https://([a-z0-9-]+\.)*tiktok\.com/') or
    (platform = 'youtube' and external_url ~* '^https://(www\.)?youtube\.com/|^https://youtu\.be/') or
    (platform = 'instagram' and external_url ~* '^https://([a-z0-9-]+\.)*instagram\.com/') or
    (platform = 'facebook' and external_url ~* '^https://([a-z0-9-]+\.)*facebook\.com/|^https://fb\.me/|^https://m\.facebook\.com/') or
    (platform = 'whatsapp' and external_url ~* '^https://(www\.)?whatsapp\.com/|^https://wa\.me/|^https://chat\.whatsapp\.com/')
  ) not valid;

/* Validate once the historical rows are known to be clean. Kept as a
   commented, explicit step so it is never run implicitly against live data. */
/* alter table public.live_sessions validate constraint live_session_external_url; */
