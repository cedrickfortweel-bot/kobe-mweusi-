/* Kobe Mweusi — seller capability is a seller_profiles row, not the
   account type.

   The agreed account model is that one account may be both a buyer and a
   seller. `profiles.account_type` records how the account registered; it
   is not a permission gate. A buyer who later becomes a seller owns a
   `seller_profiles` row, and that row is what makes the seller
   capabilities available.

   Four policies still used `account_type = 'seller'`, so a buyer who
   became a seller could not list a product or publish a live session.
   They now test for the seller_profiles row instead.

   The RLS policies on orders, disputes, chat, handoff codes, ledger
   entries and the wallet are unaffected: they are about participation in
   a transaction, not about the account type.
*/

begin;

/* ---------- products ---------- */
drop policy if exists products_insert_own on public.products;
create policy products_insert_own on public.products
  for insert to authenticated
  with check (
    seller_id = (select auth.uid())
    and exists (
      select 1 from public.seller_profiles s
      where s.user_id = (select auth.uid())
    )
  );

/* ---------- live sessions ---------- */
drop policy if exists live_sessions_insert_own on public.live_sessions;
create policy live_sessions_insert_own on public.live_sessions
  for insert to authenticated
  with check (
    seller_id = (select auth.uid())
    and exists (
      select 1 from public.seller_profiles s
      where s.user_id = (select auth.uid())
    )
  );

/* ---------- KYC submissions ---------- */
drop policy if exists seller_kyc_insert_own_seller on public.seller_kyc_submissions;
create policy seller_kyc_insert_own_seller on public.seller_kyc_submissions
  for insert to authenticated
  with check (
    seller_id = (select auth.uid())
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and cardinality(document_paths) between 1 and 6
    and exists (
      select 1 from public.seller_profiles s
      where s.user_id = (select auth.uid())
    )
  );

commit;
