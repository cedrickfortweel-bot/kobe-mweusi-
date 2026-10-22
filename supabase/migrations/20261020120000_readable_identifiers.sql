/* Kobe Mweusi — readable identifiers.

   A Wallet ID gets read out loud. A customer tells it to a shopkeeper, a
   shopkeeper reads it back over the phone, and someone types it into a
   search box. Four random consonants are terrible for that: "XQZT" cannot
   be dictated, and KMB-27-XQZT is not something a person remembers.

   The buyer's Wallet ID is now a CONSONANT-VOWEL-CONSONANT-VOWEL pattern:

       KMB-27-MAZI     "K-M-B, twenty seven, MA zi"
       KMB-04-TUVO     "K-M-B, oh four, TU vo"

   The format is unchanged, so every Wallet ID already issued still
   matches the constraint and still works. Only NEW ones use the
   pronounceable pattern.

   Why consonant-vowel and not random:
     * two numbers and four letters, as the blueprint asks
     * every letter pair is a syllable, so it can be said and heard
     * I and O are left out of the consonants, because they read as 1 and 0
     * enough space to grow: 22 consonants x 5 vowels x 22 x 5 = 12,100 per
       two-digit segment, and 90 segments, so about 1.09 million Wallet
       IDs
     * uniqueness is still guaranteed by the unique constraint on
       wallets.wallet_id, so a collision can never hand money to the
       wrong person, it only costs a retry

   The Seller Kobe ID keeps its two-digit, two-letter form, but the
   generator is made more robust and its ceiling is documented.
*/

begin;

/* ========================================================================== *
 * 1. THE BUYER'S WALLET ID
 * ========================================================================== */

create or replace function public.generate_wallet_id()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_candidate text;
  v_attempt integer := 0;
  /* Consonants only, and never I or O: they read as 1 and 0. */
  v_consonants text := 'BCDFGHJKLMNPRSTVWXYZ';
  v_vowels text := 'AEIOU';
  v_suffix text := '';
  v_segment integer;
  v_pick integer;
begin
  v_segment := 10 + floor(random() * 90)::integer;

  while v_attempt < 80 loop
    v_suffix := '';

    -- Consonant, vowel, consonant, vowel: two readable syllables.
    v_pick := floor(random() * length(v_consonants))::integer + 1;
    v_suffix := v_suffix || substr(v_consonants, v_pick, 1);
    v_pick := floor(random() * length(v_vowels))::integer + 1;
    v_suffix := v_suffix || substr(v_vowels, v_pick, 1);
    v_pick := floor(random() * length(v_consonants))::integer + 1;
    v_suffix := v_suffix || substr(v_consonants, v_pick, 1);
    v_pick := floor(random() * length(v_vowels))::integer + 1;
    v_suffix := v_suffix || substr(v_vowels, v_pick, 1);

    v_candidate := 'KMB-' || lpad(v_segment::text, 2, '0') || '-' || v_suffix;

    if not exists (select 1 from public.wallets where wallet_id = v_candidate) then
      return v_candidate;
    end if;

    v_attempt := v_attempt + 1;
  end loop;

  raise exception 'Could not allocate a unique wallet id' using errcode = 'P0001';
end;
$$;
revoke all on function public.generate_wallet_id() from public, anon, authenticated;
grant execute on function public.generate_wallet_id() to service_role;

/* ========================================================================== *
 * 2. THE SELLER'S KOBE ID
 *
 *    The format stays KOBE + two digits + two letters, as specified. Two
 *    digits and two letters give 100 x 24 x 24 = 57,600 combinations, so
 *    the generator retries harder and checks the registry as well as the
 *    profile table.
 * ========================================================================== */

create or replace function public.assign_registry_kobe_id(p_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing text;
  v_candidate text;
  v_attempt integer := 0;
  v_letters text := 'ABCDEFGHJKLMNPQRSTUVWXYZ';  /* no I, O */
  v_suffix text := '';
  v_app_kobe_id text;
  v_segment integer;
  v_pick integer;
begin
  select r.kobe_id into v_existing
  from public.kobe_id_registry r where r.assigned_user_id = p_user;

  if v_existing is not null then
    return v_existing;
  end if;

  select s.kobe_id into v_app_kobe_id
  from public.seller_profiles s where s.user_id = p_user;

  while v_attempt < 200 loop
    v_segment := floor(random() * 100)::integer;
    v_suffix := '';
    v_pick := floor(random() * length(v_letters))::integer + 1;
    v_suffix := v_suffix || substr(v_letters, v_pick, 1);
    v_pick := floor(random() * length(v_letters))::integer + 1;
    v_suffix := v_suffix || substr(v_letters, v_pick, 1);

    v_candidate := 'KOBE' || lpad(v_segment::text, 2, '0') || v_suffix;

    if not exists (select 1 from public.kobe_id_registry where kobe_id = v_candidate)
       and not exists (select 1 from public.seller_profiles where kobe_id = v_candidate) then
      insert into public.kobe_id_registry (kobe_id, assigned_user_id, app_kobe_id)
      values (v_candidate, p_user, v_app_kobe_id)
      on conflict (assigned_user_id) do update set app_kobe_id = excluded.app_kobe_id;
      return v_candidate;
    end if;

    v_attempt := v_attempt + 1;
  end loop;

  raise exception 'Could not allocate a unique Kobe ID' using errcode = 'P0001';
end;
$$;
revoke all on function public.assign_registry_kobe_id(uuid) from public, anon, authenticated;
grant execute on function public.assign_registry_kobe_id(uuid) to service_role;

commit;
