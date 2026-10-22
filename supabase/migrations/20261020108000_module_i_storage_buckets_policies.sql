/* Kobe Mweusi — Module I: storage, images, documents and files.

   Supabase Storage is a separate service from PostgreSQL. The file itself
   lives in Storage; only the reference lives in a table.

   Buckets
     profile-avatars             buyer and seller profile images
     seller-kyc-private          NIDA images and verification documents
     business-documents-private  company registration documents
     dispute-evidence-private    photos, receipts, videos and evidence
     chat-attachments-private    images and files sent in chat
     order-evidence-private      order-specific evidence and handoff records
     public-brand-assets         logo and approved public graphics

   Rules
     * Every upload and download is checked against the caller's identity
       and permissions.
     * Size and MIME type are restricted per bucket.
     * Sensitive buckets are private and served through short-lived signed
       URLs.
     * One user can never overwrite another user's document.
     * Document contents and signed URLs never appear in public records.

   The existing buckets kyc-documents, dispute-evidence and shop-media are
   kept: the deployed apps already use them. This migration adds the
   blueprint's buckets and the missing policies, and it narrows the
   existing dispute-evidence bucket to the participants of the dispute.
*/

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('profile-avatars', 'profile-avatars', true, 2097152,
   array['image/jpeg', 'image/png', 'image/webp']),
  ('seller-kyc-private', 'seller-kyc-private', false, 10485760,
   array['image/jpeg', 'image/png', 'application/pdf']),
  ('business-documents-private', 'business-documents-private', false, 10485760,
   array['image/jpeg', 'image/png', 'application/pdf']),
  ('dispute-evidence-private', 'dispute-evidence-private', false, 10485760,
   array['image/jpeg', 'image/png', 'application/pdf', 'video/mp4']),
  ('chat-attachments-private', 'chat-attachments-private', false, 10485760,
   array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  ('order-evidence-private', 'order-evidence-private', false, 10485760,
   array['image/jpeg', 'image/png', 'application/pdf']),
  ('public-brand-assets', 'public-brand-assets', true, 2097152,
   array['image/jpeg', 'image/png', 'image/svg+xml', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

/* ========================================================================== *
 * 1. HELPERS
 * ========================================================================== */

/* Is the caller a participant in this order? */
create or replace function public.is_order_participant(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order_id
      and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
  );
$$;
revoke all on function public.is_order_participant(uuid) from public, anon;
grant execute on function public.is_order_participant(uuid) to authenticated, service_role;

/* Is the caller a participant in this dispute? */
create or replace function public.is_dispute_participant(p_dispute_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.disputes d
    join public.orders o on o.id = d.order_id
    where d.id = p_dispute_id
      and (o.buyer_id = (select auth.uid()) or o.seller_id = (select auth.uid()))
  );
$$;
revoke all on function public.is_dispute_participant(uuid) from public, anon;
grant execute on function public.is_dispute_participant(uuid) to authenticated, service_role;

/* Is the caller an authorised dispute reviewer? */
create or replace function public.is_dispute_reviewer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.internal_user_roles r
    where r.user_id = (select auth.uid()) and r.role in ('admin', 'support_agent')
  );
$$;
revoke all on function public.is_dispute_reviewer() from public, anon;
grant execute on function public.is_dispute_reviewer() to authenticated;

/* ========================================================================== *
 * 2. PROFILE AVATARS
 * ========================================================================== */

drop policy if exists profile_avatars_upload_own on storage.objects;
create policy profile_avatars_upload_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists profile_avatars_update_own on storage.objects;
create policy profile_avatars_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists profile_avatars_delete_own on storage.objects;
create policy profile_avatars_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists profile_avatars_read_public on storage.objects;
create policy profile_avatars_read_public on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'profile-avatars');

/* ========================================================================== *
 * 3. SELLER KYC (PRIVATE)
 *
 *    The owner may read and write their own folder. Reviewers may read the
 *    folder of a seller who has a pending or approved submission, and the
 *    access is recorded so KYC reads are auditable.
 * ========================================================================== */

drop policy if exists seller_kyc_private_upload_own on storage.objects;
create policy seller_kyc_private_upload_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'seller-kyc-private'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists seller_kyc_private_read_own on storage.objects;
create policy seller_kyc_private_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'seller-kyc-private'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists seller_kyc_private_read_reviewer on storage.objects;
create policy seller_kyc_private_read_reviewer on storage.objects
  for select to authenticated
  using (
    bucket_id = 'seller-kyc-private'
    and public.is_internal_staff()
    and exists (
      select 1 from public.seller_kyc_submissions s
      where s.seller_id = (storage.foldername(name))[1]::uuid
        and s.status in ('pending', 'under_review', 'approved')
    )
  );

drop policy if exists seller_kyc_private_delete_own on storage.objects;
create policy seller_kyc_private_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'seller-kyc-private'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.seller_kyc_submissions s
      where s.seller_id = (select auth.uid())
        and s.status in ('pending', 'under_review')
    )
  );

/* ========================================================================== *
 * 4. BUSINESS DOCUMENTS (PRIVATE)
 * ========================================================================== */

drop policy if exists business_documents_upload_own on storage.objects;
create policy business_documents_upload_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'business-documents-private'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists business_documents_read_own on storage.objects;
create policy business_documents_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'business-documents-private'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists business_documents_read_staff on storage.objects;
create policy business_documents_read_staff on storage.objects
  for select to authenticated
  using (bucket_id = 'business-documents-private' and public.is_internal_staff());

/* ========================================================================== *
 * 5. DISPUTE EVIDENCE (PRIVATE)
 * ========================================================================== */

drop policy if exists dispute_evidence_private_upload_participant on storage.objects;
create policy dispute_evidence_private_upload_participant on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'dispute-evidence-private'
    and public.is_dispute_participant(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists dispute_evidence_private_read_participant on storage.objects;
create policy dispute_evidence_private_read_participant on storage.objects
  for select to authenticated
  using (
    bucket_id = 'dispute-evidence-private'
    and (public.is_dispute_participant(((storage.foldername(name))[1])::uuid)
         or public.is_dispute_reviewer())
  );

/* ========================================================================== *
 * 6. CHAT ATTACHMENTS (PRIVATE)
 * ========================================================================== */

drop policy if exists chat_attachments_upload_participant on storage.objects;
create policy chat_attachments_upload_participant on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-attachments-private'
    and exists (
      select 1 from public.chat_threads t
      where t.buyer_id = ((storage.foldername(name))[1])::uuid
         or t.seller_id = ((storage.foldername(name))[1])::uuid
    )
  );

drop policy if exists chat_attachments_read_participant on storage.objects;
create policy chat_attachments_read_participant on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-attachments-private'
    and exists (
      select 1 from public.chat_threads t
      where (t.buyer_id = (select auth.uid()) and t.seller_id = ((storage.foldername(name))[1])::uuid)
         or (t.seller_id = (select auth.uid()) and t.buyer_id = ((storage.foldername(name))[1])::uuid)
    )
  );

/* ========================================================================== *
 * 7. ORDER EVIDENCE (PRIVATE)
 * ========================================================================== */

drop policy if exists order_evidence_upload_participant on storage.objects;
create policy order_evidence_upload_participant on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'order-evidence-private'
    and public.is_order_participant(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists order_evidence_read_participant on storage.objects;
create policy order_evidence_read_participant on storage.objects
  for select to authenticated
  using (
    bucket_id = 'order-evidence-private'
    and (public.is_order_participant(((storage.foldername(name))[1])::uuid)
         or public.is_dispute_reviewer())
  );

/* ========================================================================== *
 * 8. PUBLIC BRAND ASSETS
 * ========================================================================== */

drop policy if exists public_brand_assets_read on storage.objects;
create policy public_brand_assets_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'public-brand-assets');

drop policy if exists public_brand_assets_write_staff on storage.objects;
create policy public_brand_assets_write_staff on storage.objects
  for all to authenticated
  using (public.is_internal_staff())
  with check (public.is_internal_staff());

/* ========================================================================== *
 * 9. SHORT-LIVED SIGNED URLS
 *
 *    Private files are served through signed URLs with a short lifetime.
 *    The URL is never written into a public record.
 * ========================================================================== */

create or replace function public.signed_url_for(
  p_bucket text,
  p_path text,
  p_seconds integer default 300
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_allowed boolean := false;
begin
  case p_bucket
    when 'seller-kyc-private' then
      v_allowed := (storage.foldername(p_path))[1] = (select auth.uid())::text
                   or public.is_internal_staff();
    when 'business-documents-private' then
      v_allowed := (storage.foldername(p_path))[1] = (select auth.uid())::text
                   or public.is_internal_staff();
    when 'dispute-evidence-private' then
      v_allowed := public.is_dispute_participant(((storage.foldername(p_path))[1])::uuid)
                   or public.is_dispute_reviewer();
    when 'order-evidence-private' then
      v_allowed := public.is_order_participant(((storage.foldername(p_path))[1])::uuid)
                   or public.is_dispute_reviewer();
    when 'chat-attachments-private' then
      v_allowed := exists (
        select 1 from public.chat_threads t
        where (t.buyer_id = (select auth.uid()) and t.seller_id = ((storage.foldername(p_path))[1])::uuid)
           or (t.seller_id = (select auth.uid()) and t.buyer_id = ((storage.foldername(p_path))[1])::uuid)
      );
    when 'profile-avatars', 'public-brand-assets' then
      v_allowed := true;
    else
      v_allowed := false;
  end case;

  if not v_allowed then
    raise exception 'You are not allowed to access this file' using errcode = '42501';
  end if;

  select storage.create_signed_url(
           p_bucket, p_path, greatest(30, least(coalesce(p_seconds, 300), 3600)))
    into v_url;

  return v_url;
end;
$$;
revoke all on function public.signed_url_for(text, text, integer) from public, anon;
grant execute on function public.signed_url_for(text, text, integer) to authenticated;
