create function public.can_upload_kyc_document(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
	select p_owner = (select auth.uid())
		and (select count(*) from storage.objects o
			where o.bucket_id = 'kyc-documents'
				and (storage.foldername(o.name))[1] = p_owner::text
				and o.created_at > now() - interval '24 hours') < 18;
$$;
revoke all on function public.can_upload_kyc_document(uuid) from public, anon;
grant execute on function public.can_upload_kyc_document(uuid) to authenticated;

drop policy if exists kyc_documents_upload_own on storage.objects;
create policy kyc_documents_upload_own on storage.objects for insert to authenticated
	with check (
		bucket_id = 'kyc-documents'
		and (storage.foldername(name))[1] = (select auth.uid())::text
		and public.can_upload_kyc_document((select auth.uid()))
	);
