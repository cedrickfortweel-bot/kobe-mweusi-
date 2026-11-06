# Kobe Mweusi

Escrow payments for social commerce in Tanzania (WhatsApp / Instagram / TikTok).
Buyer pays into escrow → seller delivers → buyer confirms → funds released.
Kobe takes a 1% fee from each side. Currency: TSh. Payments: M-Pesa, Tigo Pesa (Yas), Airtel Money, HaloPesa.

## Files

| File | Purpose |
|---|---|
| `index.html` | Cloudflare Pages root entry; forwards to the landing page below |
| `Kobe_Mweusi_homepage_v7_static.html` | Landing page: sign up / sign in (buyer or seller), EN/Swahili |
| `buyer.html` | Buyer PWA: escrow checkout, wallet top-up, order tracking, handoff QR verify, disputes, chat, receipts |
| `seller.html` | Seller PWA: orders & receipts, payouts, disputes, products, Live Business, analytics, profile |
| `reset-password.html` | Password reset (already shaped for Supabase recovery tokens) |
| `sw.js` | Shared service worker: offline shell, SKIP_WAITING updates, push plumbing |
| `buyer.webmanifest` + `icon.svg` | PWA install metadata |
| `_headers` | Cloudflare Pages headers (no-cache for sw.js/manifest + security headers) |
| `kobe-qr.js` | Shared high-error-correction QR generator with the Kobe mark |
| `jsQR.js` + `LICENSE-jsQR.txt` | Local QR decoder and its MIT license |
| `kobe-camera.js` | Shared camera scanner used by buyer and seller apps |
| `supabase-js.js` + `LICENSE-Supabase-js.txt` | Pinned Supabase browser SDK and its MIT license |
| `kobe-supabase.js` | Browser auth, role routing, and Supabase API adapter (all Edge Functions) |
| `kobe-app-workflows.js` | Buyer and seller app workflows wired to the Edge Functions |
| `verify_check.js` | Static backend verification: syntax, RLS, grants, buckets, secrets (`node verify_check.js`) |
| `flow_check.js` | Cross-layer flow verification: every RPC and table the Edge Functions use must exist in the migrations, and the money path must be wired correctly (316 checks) |
| `api_surface_check.js` | Every `KobeApi` method the apps call must exist on the real API boundary, and must not exist only in the demo fallback |
| `supabase/tests/nav_check.js` | Every screen in the buyer and seller apps is reachable, every navigation target exists, and every inline handler names a function that is defined |
| `supabase/tests/css_vars_check.js` | Every `var()` in the apps resolves to a defined custom property, so no colour declaration is silently dropped |
| `supabase/tests/encoding_check.js` | Every file is clean UTF-8. Detects and repairs a Windows-1252 mis-decode, which turns an em dash into three junk characters |
| `js_shape.js` | Shared helper that reads the browser-side JavaScript properly, skipping comments and strings |
| `supabase/config.toml` + `supabase/migrations/` | Local Supabase config and deployed schema/RLS history |
| `supabase/functions/` | Edge Functions: orders, wallet, disputes, handoff, chat, reviews, seller, security, push, kyc-review, escrow, payments, **agent**, **admin** |
| `supabase/seed.sql` | Development seed data (five test accounts, a catalogue and a live order in escrow) |
| `supabase/tests/` | SQL lint, inventory generator and the escrow release test |
| `docs/` | Backend architecture, escrow release rules, schema reconciliation, deployment guide, generated inventories |
| `admin.html` + `kobe-admin.js` | Staff-only operations console: seller verification, payouts, the agent network, the platform overview, the order search, the dispute queue and the audit trail |
| `agent.html` + `agent.css` + `agent-sw.js` | The delivery agent hub: sign in, scan a package receipt, see the orders you carry |

## Run locally

Any static server works:

```
npx wrangler pages dev .
python -m http.server 8000
```

Then open the root URL for the homepage, or open `buyer.html` and `seller.html` directly.
Camera QR scanning, push and install only work over HTTPS (or localhost).

## Supabase setup

- The browser uses the project's publishable key. This key is public by design; table access is controlled by RLS. Never put a service-role or secret key in these files.
- In Supabase **Authentication → URL Configuration**, set the production Site URL and allow the exact Cloudflare Pages URLs for the homepage, buyer, seller, and password-reset pages. For local testing, allow `http://127.0.0.1:8000/**` and `http://localhost:8000/**`.
- Email/password signup requires email confirmation. Configure production SMTP before relying on confirmation and password-reset emails; the default test mailer is not for production use.
- Phone numbers are stored in E.164 format, but SMS verification is not connected. Google sign-in also requires Google OAuth credentials in Supabase.
- Supabase schema migrations are already applied to the linked project. Deploy every function in `supabase/functions/` (orders, wallet, disputes, handoff, chat, reviews, seller, security, push, kyc-review, escrow, payments) before the apps work.
- To grant the first admin, create and confirm that user's Auth account, then run this once in the SQL Editor after replacing the email:

	```sql
	insert into public.internal_user_roles (user_id, role)
	select id, 'admin' from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL')
	on conflict (user_id, role) do nothing;
	```

- `admin.html` requires an existing `admin` or `support_agent` role. It cannot grant access to itself.
- Required function secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`), `SUPABASE_SERVICE_ROLE_KEY`. Optional until push is enabled: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`. Only needed for real payments: `PAYMENT_PROVIDER_WEBHOOK_SECRET`.
- Storage buckets: `kyc-documents` (private, 10 MB, JPEG/PNG/PDF, own-folder only), `dispute-evidence` (private, 10 MB, participants of the dispute's order only), `shop-media` (public, 5 MB, images, own-folder upload), plus `profile-avatars`, `seller-kyc-private`, `business-documents-private`, `dispute-evidence-private`, `chat-attachments-private`, `order-evidence-private` and `public-brand-assets`.
- The 1% buyer and seller fees are computed at order creation. **Capturing** the buyer's money (`place_funds_in_escrow`) and **releasing** it to the seller (`release_escrow`) are separate database functions, both callable by `service_role` only. Both are idempotent via `wallet_ledger_entries.idempotency_key`.
- **The money model:** the buyer tops up the wallet through the payment provider (AzamPay). The money then sits in the wallet, and a purchase moves it from the wallet into escrow, where the delivery rules hold it until the seller is paid. The provider is only involved at the top-up step.
- **The client never states a price.** An order is created from a `product_id`; the server reads `products.price_tzs`, applies the fee and checks the wallet balance under a lock. A tampered client cannot change what is charged. If the wallet is short, the order is rolled back and the buyer is told the exact shortfall so the app can open the top-up screen.
- Database write limits are 20 seller-profile writes/hour, 30 product writes/minute, 10 live-listing writes/hour, and 3 KYC submissions/day per user. Private KYC storage allows at most 18 documents per seller per 24 hours. The admin queue is limited to 30 requests/minute and review decisions to 10/minute. Order creation is 20/minute, dispute replies and chat messages 30/minute, handoff issues 30/minute and scans 60/hour, PIN changes 10/hour, password changes 5/hour, review submissions 10/hour. Supabase Auth also applies its configured signup/sign-in throttles.
- Three identifiers, kept apart on purpose. The **seller Kobe ID** (`KOBE12XL`) lives in `kobe_id_registry` and is permanent. The app-facing seller ID (`KM-` plus 15 uppercase hex characters) lives in `seller_profiles.kobe_id` and is what the PWAs display. The **buyer Wallet ID** (`KMB-27-MAZI`) lives in `wallets`; it is a memorable identifier, never a password, balance or payment credential, and a seller cannot list buyers' Wallet IDs.
- Real payments remain disabled until AzamPay sandbox/production integration is implemented and tested. All money-moving UI returns an honest refusal (`{ok:false}`) — nothing is simulated as successful.

## Verify the backend

```
npm install
npm run lint:sql            # every migration parses; every GRANT EXECUTE resolves
npm run lint:sql:selftest   # proves the lint's semantic checks actually fire
npm run lint:css            # every CSS var() resolves, so no colour is dropped
npm run lint:nav            # every screen is reachable and every handler exists
npm run lint:encoding       # every file is clean UTF-8
npm run flow                # the Edge Functions and the migrations agree
npm run api                 # every KobeApi method the apps call exists
npm run docs                # regenerate docs/*-inventory.md from the SQL```

`supabase db diff --schema public --linked` must report no differences after the
reconciliation described in `docs/live-schema-reconciliation.md`.

## Deploy

Two separate things are deployed, and pushing to GitHub does neither of them.

**GitHub** is the history and the second copy of the source. The Pages
project was created with a direct upload, so it is not watching the
repository: a `git push` does not publish the site.

**Supabase** holds the schema and the Edge Functions:

```bash
supabase login          # the saved CLI session on this machine has been revoked
supabase db push        # the migrations that are not live yet
supabase functions deploy agent admin handoff seller
```

For automatic GitHub Actions deployment of the wallet and escrow functions,
see [Wallet and escrow function deployment](docs/supabase-functions-deployment.md).

**Cloudflare Pages** serves the static site:

```bash
npx wrangler pages deploy . --project-name kobemweusi
```

- **Dashboard:** Pages → Create project → *Direct upload* → this folder. `_headers` is picked up automatically.
- **CLI:** `npx wrangler pages deploy . --project-name kobemweusi`

The order matters. Deploy the migrations first, then the functions that
call them, then the site. The site can be uploaded at any time, but a
page that calls a function which is not deployed yet will fail.

## Status / roadmap

- [x] Full frontend preview (all UI, EN/Swahili, themes, a11y)
- [x] PWA plumbing (`sw.js`, manifest, install & update flows, push notification click handling)
- [x] `KobeApi` frontend boundary — money methods refuse honestly in preview
- [x] Supabase project linked; schema, RLS, private KYC storage, rate limits, and review RPC deployed
- [x] Email/password auth adapter, role routing, seller product and external live-listing adapters
- [x] Private KYC submissions, staff-only review dashboard, audit trail, and server-controlled seller verification
- [x] Edge Functions: orders (create/list/lookup/cancel with idempotency + stock reservation), wallet summary, disputes (open/reply/evidence with signed URLs), handoff QR (issue/verify with one-time claim), chat (threads/messages/read), reviews (submit/seller/mine), seller overview/directory/activity, security (PIN bcrypt + password re-auth), push (VAPID config/subscribe/unsubscribe)
- [x] Chat threads and messages with participant-only RLS, dispute evidence in private storage, activity feed, push subscriptions, transaction PINs (bcrypt, service-only), support requests
- [x] Realtime channel per user (`kobe-private-<userId>`) with debounced in-app refresh
- [x] **Seller app wired to the real backend**: orders, catalogue, verification, shop details, live sessions, disputes and activity all read from and write to the server
- [x] **Seller capability fixed**: listing a product or publishing a live session no longer requires `account_type = 'seller'`, so a buyer who becomes a seller is not locked out
- [x] **Seller payouts**: a seller withdraws only money that has already been released from escrow, one request at a time, approved by staff from the admin console. The fee is computed server-side and debited once.
- [x] **Backend blueprint implemented**: 18 modules, 79 tables, 8 views, 164 functions, 117 RLS policies, 11 enums
- [x] **Wallet-funded purchases**: the buyer tops up through the provider, the money sits in the wallet, and a purchase moves it into escrow under a balance lock. The client never states a price.
- [x] **Buyer app wired to the real backend**: order creation, wallet top-up, escrow timers and confirm-receipt all call the server
- [x] **Schema reconciliation**: the live database's delivery, handoff, wallet and Kobe-ID tables and its 13 guard trigger functions are now reproducible from the migration history (`docs/live-schema-reconciliation.md`)
- [x] **Escrow release rule**: scanning the **buyer's** QR (by the seller or an agent) releases the escrow at once. The buyer scanning the **seller's** QR opens a three-hour window, which is the fallback. An explicit confirmation also releases at once. A dispute or a hold freezes the money (`docs/escrow-release-rules.md`).
- [x] **Seller Money screen**: available (released and withdrawable) and held (in escrow) shown as two separate figures, both from the server, plus the withdrawal list
- [x] **Theme colours fixed**: every `var()` now resolves, so the text follows the theme — white in the dark theme, black in the light one. Undefined variables were silently dropping colour declarations, which is why some words read near-black on a phone.
- [x] **Identifiers on the frontend**: the buyer's Wallet ID (`KMB-27-MAZI`) shows in the designed wallet card and in account settings, and the Seller Kobe ID (`KOBE12XL`) shows on the buyer's seller page and in the seller's account settings, both with a copy button. The older app-facing seller id still resolves, so old links and printed QR codes keep working.
- [x] **Readable Wallet IDs**: the ID is four digits and a real English word (`KMB-2291-MILK`), so it can be read out loud at a hub — "K-M-B, two two nine one, MILK". No two words in the list sound alike. The constraint keeps the short IDs already issued working, and the generator can never hang a sign-up.
- [x] **Encoding repaired**: the buyer app had 477 double-encoded characters (a Windows-1252 mis-decode), so em dashes and separators rendered as three junk characters. Fixed, with `npm run lint:encoding` to stop it coming back.
- [x] **Wider Seller Kobe ID**: new sellers get `KOBE123XL` (three digits), which is 518,400 combinations instead of 57,600. IDs already in circulation keep their two-digit shape, so printed QR codes and public links keep working, and the lookup is two index hits rather than a join with an OR.
- [x] **Wallet ID from sign-up**: the wallet row is created with the account, so a new buyer sees their `KMB-27-MAZI` on the first screen after registering. A wallet failure can never block the registration, and accounts that registered earlier are given one by the same migration.
- [x] **Notification pipeline**: every event becomes a durable server inbox row plus one delivery record per channel. The bell reads from the server and updates live over realtime, so a notification is no longer lost when the app is closed.
- [x] **Email channel**: a worker drains the queue and sends transactional email through a configured provider. The API key is an Edge Function secret, never a table column, and unconfirmed addresses are never mailed.
- [x] **Phone verification**: a phone number is only trusted once the account holder proves they own it, and an unconfirmed number is never shown to another party. The buyer's number used to appear on the seller's order receipt with nothing checking it.
- [x] **Unsubscribe link and bounce handling**: every email carries a working unsubscribe link, a hard-bounced address is suppressed rather than retried, and a permanent failure is told from a temporary one.
- [x] **Turtle in the QR**: the handoff code carries a bold turtle mark inside the gold ring. It is drawn as a vector rather than using the logo file, because the logo is a near-black 768px image with no transparency and a mean luminance of 29 — it would black out the modules and be invisible itself. The mark covers 4.8% of the code area, well inside what error correction level H tolerates.
- [x] **The avatar follows the account**: the buyer's photo is uploaded to the `profile-avatars` bucket and the path is saved on the profile, instead of living only in this browser's local storage.
- [x] **The handoff code on both receipts is real**: the buyer's receipt carries the code the seller or agent scans, and the seller's receipt carries the code the buyer scans. Both are issued by the server, because the server keeps only a hash and cannot hand a code back later. The previous versions rendered the order reference and a locally computed code, and the server would have refused both.
- [x] **A handoff code lasts as long as the order**: single use, and up to 24 hours rather than 15 minutes, so a slow handover at a hub cannot strand the order. It still never outlives the order itself.
- [x] **A handoff code has no clock**: it is valid until it is scanned, until a newer code replaces it, or until the order closes. A time limit would have expired a code mid-handover at a hub and stranded the order.
- [x] **Every failed scan says what happened**: already scanned, the handover is already done, the wrong person, replaced by a newer code, order closed — each with a machine-readable reason, and the app shows the server's words rather than a generic "could not be verified".
- [x] **The transaction PIN and password work for real**: the PIN rules live in the database, a PIN check goes through the locked path, five wrong attempts lock it, the counter decays, and a forgotten PIN needs the password plus a phone the server can see was confirmed. The seller no longer keeps a PIN in the browser.
- [x] **Chat works end to end**: the thread role is decided by the pair so both sides find the same conversation, a seller can reply to a first inquiry before there is an order, marking a conversation read can no longer create one, and the thread list is one query instead of three per chat.
- [x] **Chat messages render**: the buyer, seller and shared renderers all read the fields the server actually sends, and the seller's order screen passes the buyer's id so a reply reaches them.
- [x] **The delivery agent hub is on the real backend**: the agent signs in like any other account, the server decides whether the account is an agent, a scan is recorded by `record_handoff_scan()`, and the agent sees their own assignments, their own scans and their own notifications. The page never keeps a password or decides whether a code is good.
- [x] **The console reads the platform**: the operations dashboard, the order search, the dispute queue and the audit trail are read from the database through the `admin` function, which refuses a caller who is not staff. The console footer no longer sits on top of its own navigation.
- [x] **The sidebars can be used with a thumb**: the items are spaced and sized for a finger, the sign-out is its own row instead of being buried in a popup, and the console sidebar scrolls instead of overlapping.
- [x] Static verification: `npm run lint:sql` (45 migrations, 1420 statements) and `npm run lint:css` and `npm run lint:nav` and `npm run lint:encoding` and `npm run lint:chars` and `npm run lint:qr` and `npm run flow` (503 cross-layer checks) and `npm run api` (54 called methods, all defined)
- [x] **Escrow, payments, refunds, payouts and adjustments** as separate, audited, idempotent operations with dual approval for the high-risk ones
- [x] **Admin permission layer** with fine-grained permissions, employee records, invitations, an audit log and two-person approval
- [x] **Storage hardening**: private buckets for KYC, business documents, dispute evidence, chat attachments and order evidence, served through short-lived signed URLs with a KYC access log
- [x] **Analytics**: revenue separated from customer money, operational views, daily aggregates and generated financial reports
- [x] **Scheduled jobs** (pg_cron) for expired codes, unpaid orders, due escrow releases, overdue pickups, metrics and pruning
- [x] Development seed data and an escrow release test suite
- [ ] End-to-end signup/email confirmation and product/live-listing test with a real account
- [ ] Configure production Auth redirect URLs and SMTP; configure Google OAuth if it will be offered
- [ ] Bootstrap the first admin and test private KYC upload, signed document review, and approval/rejection end-to-end
- [ ] Confirm Tanzania KYC/legal document requirements before collecting identity documents from real sellers
- [ ] Live-database RLS tests with crafted cross-user requests
- [ ] Concurrency tests for `reserve_stock` / `place_funds_in_escrow` / `release_escrow` under load
- [ ] Real web-push delivery test with VAPID keys
- [ ] AzamPay sandbox and production integration for wallet top-up, escrow funding, refunds, and payouts (the callback calls `record_wallet_topup` or `record_verified_payment`; webhook signature verification is required). The payout *request* and staff approval already work end to end; only the mobile-money transfer is missing.
- [ ] Custom domain (placeholder in seller.html `LIVE_BASE`)

**Rule:** money-moving operations must never simulate success — they return `{ok:false}` until a secure backend exists.

## Escrow release rules

Full specification in `docs/escrow-release-rules.md`. In short:

- The buyer's scan of the seller's code opens a **three-hour window**. The server owns the clock.
- The **seller's or an assigned agent's scan of the buyer's code** releases the escrow immediately, and so does the buyer **confirming receipt**.
- A **scan of the seller's code by the buyer alone** moves no money until the window closes.
- An **open dispute** or an **escrow hold** freezes the money permanently.
- The timer only makes a release *eligible*: every other condition is re-checked at the moment of release, so a timer alone can never pay out a disputed order.

## Handoff QR rules

- Each order gets separate buyer and seller QR codes. Production codes are opaque, order-specific and single use.
- A code has no clock: it is valid until it is scanned, until a newer code replaces it, or until the order closes. A time limit would expire a code mid-handover at a hub and strand the order.
- The **buyer's** code is the one that moves money: when the seller or an assigned agent scans it, the escrow is released at once. Scanning the **seller's** code opens the three-hour window, which is the fallback.
- The buyer who paid for an order may scan that order's seller QR. Only the seller assigned to that order, or an assigned delivery agent, may scan its buyer QR.
- The server verifies the signed-in scanner, order membership, code use and escrow status. Browser checks are not authorization. The rules live in `record_handoff_scan()` in the database, not in the browser.
- Every refusal has a machine-readable reason, and the app shows the server's own words rather than a generic "could not be verified".
- All app QR codes include the Kobe Mweusi center mark and use high error correction. The mark is branding only; scanner authorization still comes from server verification.
