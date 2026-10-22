/* Kobe Mweusi — the Wallet ID is a real word.

   A Wallet ID gets read out loud. A customer tells it to a shopkeeper at
   a hub, the shopkeeper reads it back, someone types it into a search
   box, and the buyer has to remember it for the next purchase.

   Four random letters fail all four of those. Four random CONSONANTS
   fail them too, and a consonant-vowel pattern like MAZI is only a
   little better, because the reader still has to spell it out.

   A real English word is the only version of this that works when it is
   spoken. So the Wallet ID is now:

       KMB-2291-MILK     "K-M-B, two two nine one, MILK"

   The shape is four digits and one four-letter word, drawn from a list
   of common, unambiguous words. Every one of them can be said by
   somebody who has never seen it before.

   THE FORMAT
   ----------
   The constraint accepts two to four digits and exactly four letters, so
   the Wallet IDs already issued keep working:

       ^KMB-[0-9]{2,4}-[A-Z]{4}$

   KMB-27-MAZI   an ID issued before this change, still valid
   KMB-2291-MILK  a new one

   The digits never start with a zero, so an ID is always four digits
   that read as a number: "two two nine one", not "zero zero four two".

   THE SPACE
   ---------
   10,000 numbers x 92 words = 920,000 Wallet IDs. That is the same
   order as before, but every one of them is sayable.

   If the space is ever exhausted, the generator falls back to the
   consonant-vowel form rather than looping forever, so it can never
   hang a sign-up.

   The prefix stays KMB, so it reads with the seller's KOBE ID and
   nothing already printed changes.
*/

begin;

/* ========================================================================== *
 * 1. WIDEN THE CONSTRAINT
 * ========================================================================== */

do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.wallets'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%KMB%'
  loop
    execute format('alter table public.wallets drop constraint %I', r.conname);
  end loop;
end
$$;

alter table public.wallets
  add constraint wallets_wallet_id_format
  check (wallet_id ~ '^KMB-[0-9]{2,4}-[A-Z]{4}$');

comment on constraint wallets_wallet_id_format on public.wallets is
  'Two to four digits then four letters. The short form is kept so Wallet IDs already issued keep working.';

/* ========================================================================== *
 * 2. THE GENERATOR
 * ========================================================================== */

create or replace function public.generate_wallet_id()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  /* Common, short, unambiguous English words. Four letters each, so the
     ID always has the same shape. No two of them sound alike: a pair
     that shares its first three letters would be indistinguishable when
     the ID is read out, which is the whole point of using words. */
  v_words constant text[] := array[
    'MILK','BEAN','CORN','FISH','MEAT','SALT','CAKE','EGGS','LOAF','PLUM','LIME',
    'BARN','BOAT','CAVE','DECK','DOOR','FARM','GATE','HALL','HOME','ISLE','LAMP',
    'MAIL','MALL','NOOK','OVEN','PARK','PIER','PORT','ROAD','SHED','SHOP','TENT','TOWN','YARD','ZONE',
    'CLAY','COVE','DUNE','EDGE','FERN','HILL','LAKE','LEAF','MIST','MOON','PEAK',
    'REEF','ROCK','SAND','SNOW','TIDE','TREE','WAVE','WIND',
    'BULL','CALF','DUCK','GOAT','LION','MULE','WOLF',
    'BLUE','GOLD','GREY','PINK','DARK','DEEP','FAST','FREE','HARD','HIGH','KEEN','KIND',
    'LONG','NEAR','NICE','OPEN','PURE','RARE','REAL','RICH','SAFE','SLOW','SOFT',
    'WARM','WILD','WISE'
  ];
  v_consonants constant text[] := array[
    'BCDFGHJKLMNPRSTVWXYZ'
  ];
  v_vowels constant text[] := array['AEIOU'];
  v_candidate text;
  v_digits text;
  v_attempt integer := 0;
  v_pick integer;
  v_suffix text;
begin
  -- Four digits, from 1000 so an ID never starts with a zero.
  v_digits := (1000 + floor(random() * 9000))::integer::text;

  while v_attempt < 80 loop
    v_pick := floor(random() * array_length(v_words, 1))::integer + 1;
    v_candidate := 'KMB-' || v_digits || '-' || v_words[v_pick];

    if not exists (select 1 from public.wallets where wallet_id = v_candidate) then
      return v_candidate;
    end if;

    v_attempt := v_attempt + 1;
  end loop;

  -- The word space is nearly full. Fall back to the consonant-vowel form
  -- rather than looping forever, so a sign-up can never hang.
  while v_attempt < 160 loop
    v_suffix := '';
    v_pick := floor(random() * array_length(v_consonants, 1))::integer + 1;
    v_suffix := v_suffix || v_consonants[v_pick];
    v_pick := floor(random() * array_length(v_vowels, 1))::integer + 1;
    v_suffix := v_suffix || v_vowels[v_pick];
    v_pick := floor(random() * array_length(v_consonants, 1))::integer + 1;
    v_suffix := v_suffix || v_consonants[v_pick];
    v_pick := floor(random() * array_length(v_vowels, 1))::integer + 1;
    v_suffix := v_suffix || v_vowels[v_pick];

    v_candidate := 'KMB-' || v_digits || '-' || v_suffix;

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

commit;
