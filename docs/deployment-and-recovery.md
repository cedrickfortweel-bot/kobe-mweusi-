# Deployment and recovery

## 1. Prerequisites

* Supabase CLI 2.x (`supabase --version`)
* Node 20 or newer
* Docker, only if you want a local stack (`supabase start`)
* A linked Supabase project with the CLI already authenticated

```bash
supabase link --project-ref <your-ref>
```

## 2. What the repository contains

| Path | What it is |
|---|---|
| `supabase/migrations/` | the schema, in order. Never edit a migration that has already been applied. |
| `supabase/functions/` | the Edge Functions |
| `supabase/tests/` | the SQL lint, the inventory generator, the escrow tests |
| `supabase/seed.sql` | development seed data |

## 3. The order of work

### 3.1 Validate before you push

```bash
npm install                 # installs libpg-query for the SQL lint
npm run lint:sql            # every migration parses; every GRANT EXECUTE resolves
```

A parse error here is a parse error you would otherwise meet halfway
through `db push`, with the transaction already rolled back.

### 3.2 Rebuild from scratch and prove the schema is complete

```bash
supabase db reset
```

This drops the local database, replays every migration, and loads
`supabase/seed.sql`. If it completes, the migration history is
self-sufficient. If it fails, a migration has a bug that production does
not yet have.

### 3.3 Prove the schema matches production

```bash
supabase db diff --schema public --linked
```

This is the check that matters after the reconciliation work. It compares
the schema rebuilt from the migrations with the linked project. **It
should report no differences.** If it reports any, the migrations are
not yet a faithful description of production and the difference must be
closed before pushing.

### 3.4 Run the release-rule tests

```bash
psql "$SUPABASE_DB_URL" -f supabase/tests/escrow_release_test.sql
```

### 3.5 Push

```bash
supabase db push
```

Migrations run in order, each in its own transaction. A failure leaves the
database at the last successful migration, so the fix is a new migration
rather than an edit.

### 3.6 Deploy the functions

```bash
supabase functions deploy escrow
supabase functions deploy payments
supabase functions deploy handoff
supabase functions deploy orders
supabase functions deploy wallet
supabase functions deploy disputes
supabase functions deploy chat
supabase functions deploy reviews
supabase functions deploy seller
supabase functions deploy security
supabase functions deploy agent
supabase functions deploy admin
supabase functions deploy push
supabase functions deploy kyc-review
```

The `handoff` function changed in this release: it now delegates the scan
rules to the database. Deploy it together with the migrations, not
before.

The `agent` function is new. It serves the delivery agent hub
(`agent.html`), and it shares the scan rules with `handoff` through
`supabase/functions/_shared/handoff.ts`, so the two must be deployed
together.

The `admin` function is new. It serves the operations console and only
reads: the dashboard, the order list, the dispute queue and the audit
trail. Everything that moves money stays behind the functions that
already own it.

### The CLI has to be signed in again

`supabase db push` and `supabase functions deploy` both need a working
CLI session. The saved login role on this machine has been removed on
the Supabase side, so every command fails with:

```
unexpected login role status 404: {"message":"Resource has been removed"}
```

Sign in again before deploying:

```bash
supabase login          # or: supabase login --token <personal access token>
supabase db push        # applies the migrations that are not yet live
supabase functions deploy agent admin handoff seller
```

The project is already linked: `arnbsijvnxnoqybumkys`.

### 3.7 Secrets

Set these with `supabase secrets set`. **Never commit them.**

| Secret | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | yes | already provided by the platform |
| `SUPABASE_ANON_KEY` | yes | already provided by the platform |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | already provided by the platform |
| `PAYMENT_PROVIDER_WEBHOOK_SECRET` | only for real payments | verifies the provider callback signature |
| `VAPID_PUBLIC_KEY` | only for push | browser push |
| `VAPID_PRIVATE_KEY` | only for push | browser push |
| `VAPID_SUBJECT` | only for push | browser push contact |

### 3.8 Scheduled jobs

`pg_cron` schedules are created by the Module O migration. Confirm they
exist:

```sql
select jobname, schedule, active from cron.job where jobname like 'kobe-%';
```

If `pg_cron` is not available on the project, the migration logs a notice
and the job functions still exist. Call `select public.run_due_jobs();`
from any external scheduler instead.

## 4. Enabling real payments

Real money movement stays off until all of the following are true:

1. The AzamPay account is connected and the webhook secret is set.
2. `payment_provider_config` is enabled for the right environment:
   ```sql
   update public.payment_provider_config
     set is_enabled = true, environment = 'sandbox', merchant_identifier = '<id>'
     where provider = 'azampay';
   ```
3. The provider callback URL points at the `payments` function with
   `action = "callback"`, and the callback body carries the
   `intent_id` of the top-up intent. A capture with no order and no
   intent is refused.
4. The sandbox capture has been observed end to end: top-up, wallet
   balance up, purchase, escrow funded, delivery, release.
5. `supabase/functions/payments/index.ts` has been checked against the
   provider's real signature scheme.

Until then the `payments` function returns an honest refusal. It never
reports a payment as successful that has not happened.

## 5. Enabling web push

1. Generate a VAPID key pair and set the three `VAPID_*` secrets.
2. Deploy the `push` function.
3. The service worker must be registered and permission granted by the
   browser. A database row is not enough.

## 6. The first admin

```sql
insert into public.internal_user_roles (user_id, role)
select id, 'admin' from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL')
on conflict (user_id, role) do nothing;
```

Then create the employee record and grant the permissions:

```sql
insert into public.employee_profiles (user_id, employment_status)
select id, 'active' from auth.users where lower(email) = lower('YOUR_ADMIN_EMAIL')
on conflict (user_id) do nothing;
```

The `admin` role already has every permission in the catalogue.

## 7. Recovery

### 7.1 A migration failed

Nothing was applied: each migration runs in its own transaction. Read the
error, add a **new** migration with the fix, and push again. Do not edit
the failed migration if it partially applied.

### 7.2 A function is misbehaving

```bash
supabase functions logs <name> --tail
```

The function deploys separately from the schema, so a bad function deploy
can be rolled back without touching the database.

### 7.3 The schema and the app disagree

```bash
supabase db diff --schema public --linked
supabase db pull --linked        # writes a snapshot into supabase/migrations
```

`db pull` is a last resort: it generates a migration from the current
remote state and can capture manual changes you did not intend. Review
whatever it writes before pushing it.

### 7.4 A money operation looks wrong

The ledger is the source of truth and it is append-only, so it can be
read but not edited. To correct a balance, insert a
`financial_adjustment` row with a reason code, have an admin approve it,
and apply it. The correction is visible in the ledger like everything
else.

```sql
insert into public.financial_adjustments
  (user_id, entry_type, amount_tzs, reason_code, reason, requested_by, idempotency_key)
values
  ('<user>', 'adjustment', 5000, 'support_credit', 'Goodwill credit for a delayed delivery', '<admin>', 'adj:case-1234');
```

### 7.5 Restoring from a backup

```bash
supabase db dump --linked -f backup.sql
psql "$SUPABASE_DB_URL" -f backup.sql
```

A restore replaces the schema and the data together, so it is a
whole-database operation. Take one before any risky change.

## 8. What is still manual

| Task | Why it is manual |
|---|---|
| AzamPay signature scheme | depends on the account configuration |
| Production SMTP | needs a real provider and verified domain |
| Google OAuth | needs Google credentials in Supabase |
| KYC document requirements | depends on the Tanzania legal review |
| Live cross-user RLS tests | need crafted requests against a real project |
| Concurrency tests under load | need a load harness |
