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

## Run locally

Any static server works:

```
npx wrangler pages dev .
python -m http.server 8000
```

Then open the root URL for the homepage, or open `buyer.html` and `seller.html` directly.
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

## Handoff QR rules

- Each order gets separate buyer and seller QR codes. Production codes are opaque, order-specific, single-use, and expire.
- All app QR codes include the Kobe Mweusi center mark and use high error correction. The mark is branding only; scanner authorization still comes from server verification.
- The buyer who paid for an order may scan that order's seller QR. Only the seller assigned to that order may scan its buyer QR.
- An authenticated, authorized Kobe Mweusi system agent may scan either code. Other accounts must be rejected, even if they have a copy of a QR.
- The server verifies the signed-in scanner, order membership, code expiry and use, and escrow status. Browser checks are not authorization.
- A scan records handoff only. The buyer explicitly confirms release; an agent may resolve a dispute through the audited support workflow.
- The current QR screens and generated codes are preview UI only. Do not treat their QR values or scan results as secure until server verification is connected.
