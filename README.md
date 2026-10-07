# Kobe Mweusi

Escrow payments for social commerce in Tanzania (WhatsApp / Instagram / TikTok).
Buyer pays into escrow → seller delivers → buyer confirms → funds released.
Kobe takes a 1% fee from each side. Currency: TSh. Payments: M-Pesa, Tigo Pesa (Yas), Airtel Money, HaloPesa.

## Files

| File | Purpose |
|---|---|
| `Kobe_Mweusi_homepage_v7_static.html` | Landing page: sign up / sign in (buyer or seller), EN/Swahili |
| `buyer.html` | Buyer PWA: escrow checkout, wallet top-up, order tracking, handoff QR verify, disputes, chat, receipts |
| `seller.html` | Seller PWA: orders & receipts, payouts, disputes, products, Live Business, analytics, profile |
| `reset-password.html` | Password reset (already shaped for Supabase recovery tokens) |
| `sw.js` | Shared service worker: offline shell, SKIP_WAITING updates, push plumbing |
| `buyer.webmanifest` + `icon.svg` | PWA install metadata |
| `_headers` | Cloudflare Pages headers (no-cache for sw.js/manifest + security headers) |

## Run locally

Any static server works:

```
npx wrangler pages dev .
python -m http.server 8000
```

Then open `buyer.html`, `seller.html` or the homepage.
Camera QR scanning, push and install only work over HTTPS (or localhost).

## Deploy (Cloudflare Pages)

- **Dashboard:** Pages → Create project → *Direct upload* → this folder. `_headers` is picked up automatically.
- **CLI:** `npx wrangler pages deploy . --project-name kobemweusi`

## Status / roadmap

- [x] Full frontend preview (all UI, EN/Swahili, themes, a11y)
- [x] PWA plumbing (`sw.js`, manifest, install & update flows)
- [x] `KobeApi` frontend boundary — money methods refuse honestly in preview
- [ ] Supabase: auth, profiles (server-issued Kobe ID), orders, disputes, chat, reviews, realtime
- [ ] Edge Functions: create-escrow / release-escrow / withdraw / send-push
- [ ] Mobile-money provider integration (idempotency keys already sent by the frontend)
- [ ] Custom domain (placeholder in seller.html `LIVE_BASE`)

**Rule:** money-moving operations must never simulate success — they return `{ok:false}` until a secure backend exists.
