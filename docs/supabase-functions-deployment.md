# Wallet and escrow function deployment

## Source files

The deployable code lives in the repository; the GitHub workflow uses these
files directly rather than copying or maintaining a second bundled version:

- [`wallet/index.ts`](../supabase/functions/wallet/index.ts)
- [`escrow/index.ts`](../supabase/functions/escrow/index.ts)
- [`_shared/`](../supabase/functions/_shared/) — shared authentication and
  HTTP helpers imported by the functions

## Configure GitHub once

1. In GitHub, open **Settings → Secrets and variables → Actions → New
   repository secret**.
2. Name the secret `SUPABASE_ACCESS_TOKEN` and paste a newly created Supabase
   personal access token. Do not put the token in source code or commit it.
3. Ensure the repository allows GitHub Actions to run.

The project reference is set in
[`deploy-wallet-escrow.yml`](../.github/workflows/deploy-wallet-escrow.yml).
The `kobe_mpya_ss` value in the local Supabase CLI config is not a valid
project reference; this workflow targets `spoylutxxxfovcuflyts`.

## Deploy

After the secret is configured, either:

- Push a change to `main` under `supabase/functions/wallet/`,
  `supabase/functions/escrow/`, or `supabase/functions/_shared/`; or
- Open **Actions → Deploy wallet and escrow functions → Run workflow**.

The workflow deploys `wallet` and then `escrow`. Check the run in the Actions
tab; a green run confirms that both deployments completed. It does not deploy
database migrations or the Cloudflare Pages website.

For a local deployment instead, authenticate the Supabase CLI and run:

```powershell
npx --yes supabase@latest functions deploy wallet --project-ref spoylutxxxfovcuflyts --yes
npx --yes supabase@latest functions deploy escrow --project-ref spoylutxxxfovcuflyts --yes
```
