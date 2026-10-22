# Backend architecture

Kobe Mweusi is an escrow platform for social commerce in Tanzania. A buyer
pays into escrow, the seller delivers, the buyer confirms, and only then
does the money reach the seller.

This document explains how the backend is put together and why.

## 1. The shape of the system

```
  Browser (buyer.html / seller.html / admin.html)
        |  Supabase JS, publishable key
        v
  Supabase Data API  (PostgREST + RLS)   ---- reads and simple writes
        |
        |  JWT
        v
  Supabase Edge Functions (Deno)  --------- writes, money, provider calls
        |  service role
        v
  PostgreSQL (public schema)  ------------- the rules and the ledger
        |
        v
  Supabase Storage  --------------------- private files, signed URLs
```

Three rules follow from this shape.

1. **The browser never holds a privileged key.** The publishable key is
   public by design; access is controlled by RLS.
2. **Money only moves through the database.** A client can never update a
   balance, because balances are derived from an append-only ledger and
   every ledger write goes through a `SECURITY DEFINER` function that is
   revoked from `anon` and `authenticated`.
3. **Every write that matters is a function, not a table insert.** The
   Edge Functions call Postgres functions; the functions enforce the
   business rules; the tables store the results.

## 2. The modules

| Module | Migration | Responsibility |
|---|---|---|
| Reconciliation | `20261020090000`, `20261020090100` | close the drift between the live database and the migration history |
| A. Identity | `20261020100000` | profiles, settings, devices, consents, security events, account closure and suspension |
| B. Seller identity | `20261020101000` | seller Kobe ID registry, buyer Wallet IDs, seller capability |
| C. Money | `20261020102000` | escrow, ledger, payment intents, refunds, payouts, adjustments, reconciliation |
| D. Live business | `20261020103000` | live sessions, social accounts, business hours |
| E. Chat | `20261020104000` | threads, members, attachments, read receipts, presence |
| F. Notifications | `20261020105000` | inbox, preferences, delivery queue, push subscriptions |
| G. Delivery | `20261020106000` | hubs, handoff QR, the three-hour release window |
| H. Disputes | `20261020107000` | dispute lifecycle, evidence, decisions, financial outcome |
| I. Storage | `20261020108000` | buckets, object policies, short-lived signed URLs |
| J. KYC | `20261020109000` | submissions, business profiles, restrictions, access logging |
| K. Admin | `20261020110000` | permissions, employees, invitations, audit log, dual approval |
| L. Security | `20261020111000` | PIN throttling, rate limits, risk events, webhook receipts |
| M. Analytics | `20261020112000` | metrics views, daily aggregates, financial reports |
| N. Configuration | `20261020113000` | settings, provider config, integration health, job runs |
| O. Jobs | `20261020114000` | realtime publication, pg_cron schedules |
| Wallet model | `20261020115000` | top-up intents, wallet-funded purchases, the balance lock |
| Seller capability | `20261020116000` | seller capability is a `seller_profiles` row, not the account type |
| Seller payouts | `20261020117000` | withdrawal requests, one outstanding per seller, the fee, approval |
| Public identity | `20261020119000` | the canonical Seller Kobe ID, and resolving either format |
| Readable ids | `20261020120000` | pronounceable Wallet IDs, a more robust Seller ID generator |
| Wider seller id | `20261020121000` | three-digit Seller Kobe IDs, both shapes resolving, a two-index-hit lookup |
| Wallet id at sign-up | `20261020122000` | the wallet row is created when the account is, and backfilled for older accounts |
| Word wallet id | `20261020123000` | the Wallet ID is a real English word, so it can be read out loud |

The exact contents are in `docs/table-inventory.md`,
`docs/function-inventory.md` and `docs/rls-policy-matrix.md`, all
generated from the SQL.

## 3. Identity

Supabase Auth owns passwords, sessions, email and phone verification, and
password recovery. There is no `passwords` table, no custom OTP store and
no token column anywhere in `public`.

`profiles` holds the shared account identity. `profiles.account_type`
records how a person registered, but it is **not** the permission gate,
because one account may buy and sell at the same time. The real seller
capability is "does a `seller_profiles` row exist for this user", exposed
as `is_seller()` and `is_verified_seller()`.

## 3a. The three identifiers

| Identifier | Format | Lives in | Who sees it |
|---|---|---|---|
| Seller Kobe ID | `KOBE12XL` | `kobe_id_registry` | the customer, on the seller's page, in a public link, in a search |
| App-facing seller id | `KM-` + 15 hex | `seller_profiles.kobe_id` | the existing PWAs; still resolves everywhere |
| Buyer Wallet ID | `KMB-27-MAZI` | `wallets` | the buyer, and the seller of an order with that buyer, and staff |

**The canonical Seller Kobe ID is the customer-facing one.** It is
assigned once and never changes. The app-facing id is kept because the
existing PWAs were built around it, and `public_seller_identity_by_kid()`
resolves **either** form to the canonical one, so an old link or a
printed QR code still finds the seller.

**A buyer never sees a list of Wallet IDs.** `reveal_wallet_id()` returns
a Wallet ID only to its owner, to staff, or to the seller of an order with
that buyer. The buyer app shows only their own.

Where they appear on the frontend:

| Where | Identifier | Source |
|---|---|---|
| Buyer wallet card | the buyer's Wallet ID | the wallet summary, which only ever returns it to its owner |
| Buyer, account settings | the buyer's Wallet ID | the same |
| Buyer, seller page | the Seller Kobe ID, with a copy button | the seller directory and the live-session list |
| Seller, account settings | the Seller Kobe ID, with a copy button | the seller's own profile |
| Seller, shop preview and protected info | the Seller Kobe ID | the seller's own profile |
| Seller, live caption and public link | the Seller Kobe ID | the same |

The IDs are read from the server, never typed in by the page.

### The Wallet ID exists from sign-up

The sign-up trigger creates the wallet row alongside the profile, so a new
buyer sees their `KMB-27-MAZI` on the first screen after registering,
not on some later visit. The insert is wrapped, so **a wallet failure can
never block the registration**; if the row is missing for any reason,
`ensure_my_wallet()` creates it on first use and the app says "not
assigned yet" until then.

Accounts that registered before this change are given a Wallet ID by the
same migration, so nobody is left without one.

### The shapes, and why

**The buyer's Wallet ID** is `KMB-` + four digits + a real English word:

```
KMB-2291-MILK     "K-M-B, two two nine one, MILK"
```

A Wallet ID gets read out loud, so it has to be sayable. Four random
letters cannot be dictated, and a consonant-vowel pattern like MAZI is
only a little better, because the reader still has to spell it out. A
real word is the only version of this that works when it is spoken.

The words come from a list of 88 common, short, unambiguous ones, and
**no two of them sound alike** — a pair sharing its first three letters
would be indistinguishable when read out. The flow check enforces that.

The digits never start with a zero, so an ID is always four digits that
read as a number.

The space is 10,000 numbers x 88 words = **880,000**. The prefix stays
`KMB` so it reads with the seller's `KOBE` ID.

The constraint accepts two to four digits, so the Wallet IDs already
issued still work:

```
KMB-27-MAZI     an ID issued before this change, still valid
KMB-2291-MILK   a new one
```

If the word space is ever exhausted, the generator falls back to the
consonant-vowel form rather than looping forever, so it can never hang a
sign-up. Uniqueness is guaranteed by the unique constraint on
`wallets.wallet_id`, so a collision can never hand money to the wrong
person, it only costs a retry.

**The seller's Kobe ID** is `KOBE` + three digits + two letters, for
example `KOBE123XL`. It was two digits, which gave only 57,600
combinations — comfortable for a few thousand sellers and exhausted for a
national platform. Three digits gives 900 x 24 x 24 = **518,400**.

**IDs already in circulation keep their two-digit shape.** A Seller Kobe
ID is printed on shop pages, put in public links, read out at a hub and
saved by buyers, so changing an existing one would break all of that. The
constraint accepts both forms, `^KOBE[0-9]{2,3}[A-Z]{2}$`, and
`public_seller_identity_by_kid()` resolves either.

That lookup is also two index hits rather than a join with an `OR` across
two tables, which PostgreSQL cannot serve from a single index. It looks the
ID up in the registry by its primary key, then by the profile's unique
index. Both are O(log n) and neither scans.

## 4. Money

The money subsystem is a separate, auditable subsystem.

**The flow.** The buyer tops up the wallet through the payment provider
(AzamPay). The money sits in the wallet. A purchase moves it from the
wallet into escrow, and the delivery rules release it to the seller.

```
    top up (AzamPay)  ->  wallet balance  ->  escrow  ->  seller
```

**The ledger is append-only.** `wallet_ledger_entries` has a trigger that
raises on any UPDATE or DELETE. Every entry carries a unique
`idempotency_key`, so a repeated provider callback cannot credit the same
payment twice.

**A balance is derived, never stored.** `wallet_balance(user)` is the sum
of that user's ledger entries. Money already committed to escrow left the
wallet when the order was created and is tracked separately by
`held_escrow()`, which reads the escrow ledger rather than the order list.

**The client never states a price.** The order is created from a
`product_id`; the server reads `products.price_tzs`, applies the fee and
checks the wallet balance. A tampered client cannot change what is
charged.

**A purchase is checked under a lock.** The balance check and the debit
run inside `pg_advisory_xact_lock` scoped to the buyer, so two concurrent
purchases from one wallet cannot both pass the check.

**Capture and release are different events.** `place_funds_in_escrow()`
moves the buyer's money into escrow. `release_escrow()` pays the seller.
The delivery and confirmation flow calls the second. This separation is
the whole point: a captured payment is not a released payment.

**Customer money and platform revenue are distinct.** The buyer is
charged `subtotal + buyer_fee`. The fee is recorded in `platform_fees`
and is not credited back to the buyer.

**Adjustments need authorisation and a reason.** `financial_adjustments`
must be approved by an admin before they can be applied, and each one
carries a reason code.

**Concurrent money operations are locked.** The functions take a
`FOR UPDATE` row lock on the order and the escrow row before they change
anything.

## 5. The escrow release rule

Fully specified in `docs/escrow-release-rules.md`. In short:

* the buyer's scan opens a three-hour window
* both scans present means an immediate release
* the buyer confirming receipt means an immediate release
* a dispute or a hold freezes the escrow permanently
* the server owns the clock, and the timer only makes a release
  *eligible*: every other condition is re-checked at the moment of release

## 6. Communication

Chat is participant-only. `chat_threads` has one row per buyer/seller
pair, and the RLS policies expose a thread only to the two people in it.
Messages, attachments, read receipts and presence all hang off that
membership.

### The thread role is decided by the pair

A thread row has a buyer and a seller, so **both sides have to agree
which one is which**, or a message lands in a thread the other side
cannot find. The rule is derived from the pair, not from the caller's
account type, because one account may both buy and sell:

| The pair | The result |
|---|---|
| the counterparty has a shop and the caller does not | the caller is buying, so the caller is the buyer |
| the caller has a shop and the counterparty does not | the counterparty is the buyer |
| both have shops | the pair is ordered by id, so both sides reach the same row |

### A seller can answer a first inquiry

A buyer may ask any verified seller a question **before** they have
ordered. The seller must then be able to answer it, even though there is
still no order. So **once a thread exists, both parties may always
continue it**; the order requirement only gates starting a conversation
with a buyer.

The earlier code checked "does this buyer have an order from me" on
every message, which meant **a seller could not reply to a first
inquiry** — the most common message in the product.

### Marking read cannot create a conversation

The read action used to upsert, so simply calling it created a thread
with anybody. It now marks a conversation that already exists.

### The list is not one query per thread

The thread list used to run three queries for every conversation, so a
seller with fifty chats ran a hundred and fifty. It now fetches every
thread's messages in **one** query and counts the unread ones in
memory.

Notifications have two layers: a persistent inbox (`notifications`) that
the app reads, and a delivery queue (`notification_deliveries`) that the
push worker drains with retries. A database row alone does not make a
notification appear on a phone; the push worker, the service worker and
the VAPID keys are what do that.

Realtime is used for a small set of tables only, and the existing RLS
policies decide who can receive a change. Realtime does not replace
database authorization.

## 7. Delivery

An order moves through `order_delivery_workflows`:

```
not_started
  -> direct_pending            the buyer scanned the seller's code
  -> direct_delivered          the seller scanned the buyer's code
  -> seller_to_agent_complete  an agent handled the handover
  -> delivered_pending_confirmation
```

Handoff codes are per order, per side, single use and expiring. Only the
SHA-256 hash is stored, so a database leak cannot be replayed as a live
code. Every scan is written to `handoff_events`.

### The delivery agent hub

`agent.html` is the workspace an authorised delivery agent uses on the
road. It is a normal account: the agent signs in with the email and
password Kobe Mweusi operations gave them, and the server decides
whether that account is an agent by looking for a `delivery_agents` row.

| Piece | Where it lives |
|---|---|
| the agent's identity | `delivery_agents` (`worker_id`, `region`, `verification_status`) |
| the work they carry | `delivery_assignments` |
| the handover they recorded | `handoff_events` where `scanned_by` is the agent |
| the dashboard | `agent_hub_snapshot()`, one call |
| the endpoint | `supabase/functions/agent/index.ts` |

The rules are the same as for the buyer and the seller. A scan is handed
to `record_handoff_scan()`, which decides whether this agent is the one
assigned to this order, consumes the code atomically, writes the audit
row and applies the release rules. The page never decides any of it.

The scan rules are shared with the `handoff` function through
`supabase/functions/_shared/handoff.ts`, so a buyer, a seller and an
agent are refused in exactly the same way, with the same wording and the
same machine-readable reason.

The agent can read their own assignments, their own delivery workflow and
their own handoff events. They cannot read another agent's work, and they
cannot read a buyer's wallet or a seller's ledger.

## 8. Disputes

A dispute has a lifecycle of its own, private evidence, an assigned
reviewer and a recorded decision. The decision and the money movement
that follows it are separate steps:

```
open_dispute()                    -> escrow held, money frozen
  ... evidence, messages ...
resolve_dispute()                 -> a decision is recorded
execute_dispute_financial_outcome() -> the money moves
```

A frontend can never set `disputes.status = 'resolved'` and thereby move
money. Only `execute_dispute_financial_outcome()` can, and it requires a
staff identity.

## 9. Administration

`internal_user_roles` holds the coarse role (`support_agent`, `admin`,
`agent`). On top of it, `admin_permissions` and
`internal_role_permissions` hold the fine-grained permission, and
`has_permission()` is the check every sensitive action performs.

High-impact actions are marked `requires_dual_approval`:
`disputes.resolve`, `escrow.release`, `payouts.approve` and
`wallets.adjust`. They go through `admin_approval_requests`, where the
approver must be a different person from the requester.

`audit_logs` records every sensitive action with the actor, the reason and
the payload.

## 10. Security posture

* RLS is enabled on every table in `public`. Tables that no customer may
  read have RLS on and no policy, which makes them unreachable through
  the Data API.
* Sensitive tables are revoked from `anon` and `authenticated` entirely.
* Money functions are `SECURITY DEFINER` with `SET search_path = ''`.
* Passwords, OTPs, recovery tokens and access tokens are never stored in
  application tables.
* KYC documents, dispute evidence, chat attachments and order evidence
  live in private buckets and are served through short-lived signed URLs.
* Every KYC document read by a reviewer is logged in `kyc_access_log`.
* Rate limits exist at three layers: Supabase Auth, the shared
  `consume_rate_limit()` helper, and the `enforce_app_write_rate_limit()`
  trigger.
* The transaction PIN is a bcrypt hash, and five failures lock it for
  fifteen minutes.

## 11. Seller capability

A user is a seller when a `seller_profiles` row exists for them. The
`profiles.account_type` column records how the account registered; it is
**not** the permission gate, because one account may buy and sell at the
same time.

The policies on `products`, `live_sessions` and `seller_kyc_submissions`
therefore test for the `seller_profiles` row, not the account type. A
buyer who later becomes a seller can list a product and publish a live
session without a new account.

## 12. What the seller app reads and writes

The seller app holds no local copy of the seller's own business data.
Everything it shows comes from the server:

| Screen | Reads | Writes |
|---|---|---|
| Orders & receipts | `listSellerOrders()` — the `orders` Edge Function, mapped for the seller | `cancel` on the order |
| Products | `sellerProducts()` | `saveSellerProduct()` — the product row plus a `shop-media` upload for the photo |
| Live Business | `sellerLiveSessions()` | `saveSellerLiveSession()` to start, `endLiveSession()` to end |
| Verification | `sellerVerification()` — the submission and the review status | `submitKyc()` |
| Shop | `sellerProfile()` | `saveShopDetails()` |
| Disputes | `listDisputes()` | `addDisputeMessage()` and `uploadDisputeEvidence()` |
| Activity | `sellerOverview()` | — |
| Money | `sellerOverview()` — the wallet balance and the held escrow | withdrawals are refused until the provider is connected |

A **verified** seller's public details are locked, because they were part
of what the review checked. The app says so plainly rather than letting
the save fail silently.

The buyer app reads live sessions from the backend, so a seller session
that existed only on the seller's page was never visible to a buyer. It
is now created on the server.

## 13. The transaction PIN and the password

The PIN is what protects a withdrawal, so the rules live in the database
and the page only asks.

**The PIN rules are in one place.** `pin_is_acceptable()` decides whether
a PIN is good enough, and `pin_rejection_reason()` says why not. The
Edge Function asks the database rather than repeating the rules, so the
page and the server cannot drift apart. The weak list is deliberately
longer than the page's: a PIN the page accepts but the database refuses
would leave the seller thinking their PIN was set when it was not.

**Setting and changing a PIN is one operation.**
`change_transaction_pin()` verifies the current PIN and writes the new one
in the same transaction, and a wrong current PIN counts towards the
lockout exactly like a wrong check does.

**A PIN check is locked.** `check_transaction_pin()` is the only path a
check may take. Five wrong attempts inside a fifteen-minute window lock
the PIN for fifteen minutes, and a correct one clears the counter. The
counter **decays**: an attempt more than fifteen minutes after the last
one starts a fresh count, so a stray wrong try from last week does not
count towards the next lock.

**A forgotten PIN needs two proofs.** The account password, and a phone
code the server can see Supabase Auth confirmed. The page confirms the
code with Auth first; the server then checks Auth's own record, so a
page cannot claim a phone it never proved.

**A password change re-authenticates.** The server signs in with the old
password before applying the new one, and the change is rate limited to
five an hour.

**The apps hold no PIN.** The seller used to keep the PIN in a variable
and count wrong guesses in the browser. It now reads the state from the
server, so the Security screen and the withdraw gate agree with what is
actually stored.

## 14. Payouts

A seller withdraws money that has **already been released from escrow**.
The rule falls out of the ledger design rather than being checked
separately: the seller's ledger is credited only inside
`release_escrow()`, so money still in escrow has never entered the
seller's balance.

```
    escrow released  ->  seller's ledger  ->  payout request  ->  staff approve
```

`request_seller_payout()` checks the released balance, refuses a second
outstanding request, and computes the fee on the server.
`approve_payout()` debits the seller's ledger once and records the fee
as platform revenue. Staff approve from the admin console's payout
queue.

The mobile-money transfer happens when the provider is connected. Until
then the request is real and tracked, and the seller is told it will be
sent once approved.

## 15. Scheduled work

| Job | Every | What it does |
|---|---|---|
| `expire_handoff_codes` | 5 min | revokes codes past their expiry |
| `restore_expired_orders` | 10 min | cancels unpaid orders and returns stock |
| `process_due_escrow_releases` | 2 min | releases escrow whose window elapsed |
| `mark_overdue_pickups` | 30 min | flags parcels nobody collected |
| `compute_recent_metrics` | daily | refreshes the daily aggregates |
| `prune_notification_queue` | daily | removes old deliveries and read notifications |
| `prune_idempotency_keys` | 15 min | removes expired keys |

Each run is recorded in `scheduled_job_runs`, whether it succeeded or
failed, with a duration and an error message.

## 16. Repository layout

```
kobe-mweusi/
├── buyer.html, seller.html, admin.html, index.html   the PWAs
├── kobe-supabase.js, kobe-app-workflows.js            the browser boundary
├── supabase/
│   ├── config.toml
│   ├── migrations/       the schema, in order
│   ├── functions/        the Edge Functions
│   ├── tests/            SQL lint, inventory generator, escrow tests
│   └── seed.sql
├── docs/                 architecture and inventories
└── package.json
```

## 17. Testing

```bash
npm run lint:sql     # every migration parses; every GRANT EXECUTE resolves
npm run flow         # the Edge Functions and the migrations agree
npm run api          # every KobeApi method the apps call exists
npm run docs         # regenerate the inventories from the SQL
```

`npm run verify` runs all of them. Two of these have their own self-test:
`npm run lint:sql:selftest` proves the SQL lint's return-type and
overload detectors actually fire.

`supabase/tests/escrow_release_test.sql` exercises the release rules
against a real database.
