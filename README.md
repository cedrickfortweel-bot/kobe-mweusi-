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
| `flow_check.js` | Static end-to-end flow verification: signup → KYC → order → handoff → release → review → dispute → chat (`node flow_check.js`) |
| `supabase/config.toml` + `supabase/migrations/` | Local Supabase config and deployed schema/RLS history |
| `supabase/functions/` | Edge Functions: orders, wallet, disputes, handoff, chat, reviews, seller, security, push, kyc-review |
| `admin.html` + `kobe-admin.js` | Staff-only seller verification review console (calls the kyc-review Edge Function) |

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
- Supabase schema migrations are already applied to the linked project. Deploy every function in `supabase/functions/` (orders, wallet, disputes, handoff, chat, reviews, seller, security, push, kyc-review) before the apps work.
- To grant the first admin, create and confirm that user's Auth account, then run this once in the SQL Editor after replacing the email:

	```sql
	insert into public.internal_user_roles (user_id, role)
	select id, 'admin' from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL')
	on conflict (user_id, role) do nothing;
	```

- `admin.html` requires an existing `admin` or `support_agent` role. It cannot grant access to itself.
- Required function secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`), `SUPABASE_SERVICE_ROLE_KEY`. Optional until push is enabled: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- Storage buckets: `kyc-documents` (private, 10 MB, JPEG/PNG/PDF, own-folder only), `dispute-evidence` (private, 10 MB, participants of the dispute's order only), `shop-media` (public, 5 MB, images, own-folder upload).
- The 1% buyer and seller fees are computed at order creation. Escrow release (`finalize_order`) is a database function callable by service_role only; it is meant to run from the AzamPay payment callback once the provider is connected. It is idempotent via `wallet_ledger_entries.idempotency_key`.
- Database write limits are 20 seller-profile writes/hour, 30 product writes/minute, 10 live-listing writes/hour, and 3 KYC submissions/day per user. Private KYC storage allows at most 18 documents per seller per 24 hours. The admin queue is limited to 30 requests/minute and review decisions to 10/minute. Order creation is 20/minute, dispute replies and chat messages 30/minute, handoff issues 30/minute and scans 60/hour, PIN changes 10/hour, password changes 5/hour, review submissions 10/hour. Supabase Auth also applies its configured signup/sign-in throttles.
- Seller Kobe IDs are generated by Postgres as `KM-` plus 15 uppercase hex characters (60 random bits), with a unique constraint and collision retry. Existing IDs are permanent and are not rewritten.
- Real payments remain disabled until AzamPay sandbox/production integration is implemented and tested. All money-moving UI returns an honest refusal (`{ok:false}`) — nothing is simulated as successful.

## Deploy (Cloudflare Pages)

- **Dashboard:** Pages → Create project → *Direct upload* → this folder. `_headers` is picked up automatically.
- **CLI:** `npx wrangler pages deploy . --project-name kobemweusi`

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
- [x] Static verification: `node verify_check.js` (107 checks) and `node flow_check.js` (64 checks)
- [ ] End-to-end signup/email confirmation and product/live-listing test with a real account
- [ ] Configure production Auth redirect URLs and SMTP; configure Google OAuth if it will be offered
- [ ] Bootstrap the first admin and test private KYC upload, signed document review, and approval/rejection end-to-end
- [ ] Confirm Tanzania KYC/legal document requirements before collecting identity documents from real sellers
- [ ] Live-database RLS tests with crafted cross-user requests
- [ ] Concurrency tests for reserve_stock / finalize_order under load
- [ ] Real web-push delivery test with VAPID keys
- [ ] AzamPay sandbox and production integration for wallet top-up, escrow funding, refunds, and payouts (payment callback calls finalize_order; webhook signature verification required)
- [ ] Scheduled job (pg_cron) for `restore_expired_orders()` to cancel unpaid orders after 24h
- [ ] Custom domain (placeholder in seller.html `LIVE_BASE`)

**Rule:** money-moving operations must never simulate success — they return `{ok:false}` until a secure backend exists.

## Handoff QR rules

- Each order gets separate buyer and seller QR codes. Production codes are opaque, order-specific, single-use, and expire.
- All app QR codes include the Kobe Mweusi center mark and use high error correction. The mark is branding only; scanner authorization still comes from server verification.
- The buyer who paid for an order may scan that order's seller QR. Only the seller assigned to that order may scan its buyer QR.
- An authenticated, authorized Kobe Mweusi system agent may scan either code. Other accounts must be rejected, even if they have a copy of a QR.
- The server verifies the signed-in scanner, order membership, code expiry and use, and escrow status. Browser checks are not authorization.
- A scan records handoff only. The buyer explicitly confirms release; an agent may resolve a dispute through the audited support workflow.
- The current QR screens and generated codes are preview UI only. Do not treat their QR values or scan results as secure until server verification is connected.
