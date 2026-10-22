# Live schema reconciliation

The deployed Supabase project contains objects that the migration history
in this repository could not reproduce. Anyone who ran `supabase db reset`
before this reconciliation would have ended up with a **different
database** from production, and the difference was not cosmetic: the live
database has the delivery, handoff and wallet tables, and it has the
trigger functions that keep the ledger immutable and the Kobe IDs
permanent.

This document records exactly what had drifted and how it was closed.

## 1. How the drift was found

The live schema was inspected directly (tables, columns, constraints,
triggers and functions) and compared against the result of applying the
migration history to an empty database. The trigger inventory from the
live project was used as the reference for which guard functions must
exist.

## 2. Tables that existed live but in no migration

| Table | Why it matters |
|---|---|
| `wallets` | owns the buyer Wallet ID (`KMB-27-MAZI`). Without it there is no buyer-facing wallet identifier. |
| `kobe_id_registry` | reserves the canonical seller Kobe ID (`KOBE12XL`). |
| `delivery_agents` | registered delivery agents and their verification state. |
| `delivery_assignments` | links an agent to an order. |
| `order_delivery_workflows` | the per-order delivery state machine. |
| `handoff_events` | the audit trail for every handoff scan. |
| `pin_throttle` | the transaction PIN lockout counter. |
| `support_request_audit` | the history of support-case actions. |

## 3. Columns that existed live but in no migration

| Table | Column |
|---|---|
| `orders` | `delivered_at`, `confirm_by` |
| `chat_threads` | `initiated_by` |
| `activity_events` | `read_at` |
| `handoff_codes` | `revoked_at`, `scanned_by` |
| `activity_events` | ten additional event kinds |

The `activity_events.kind` CHECK constraint had to be dropped and
recreated to allow the extra kinds. It is added `NOT VALID` so existing
rows are not rejected; validate it once the historical rows are known to
be clean.

## 4. Trigger functions that existed live but in no migration

Every one of these is now recreated in
`supabase/migrations/20261020090000_live_schema_reconciliation.sql`:

| Function | Guard it provides |
|---|---|
| `assign_kobe_id()` | the seller Kobe ID is assigned once and never changes |
| `protect_seller_locked_fields()` | a seller cannot change the fields the review process owns |
| `prevent_self_verification()` | a seller cannot grant themselves the verified badge |
| `prevent_self_role_change()` | a user cannot change their own internal role |
| `block_ledger_mutation()` | the wallet ledger is append-only |
| `force_server_fields()` | server-owned columns on client inserts |
| `guard_order_changes()` | order amounts and parties are immutable after creation |
| `guard_live_session()` | live sessions only move forward through the lifecycle |
| `check_order_live_session()` | an order may only reference its own seller's live session |
| `guard_chat_thread_update()` | chat participants cannot be changed |
| `guard_chat_thread_initiator()` | only the signed-in user can start a thread |
| `on_chat_message_insert()` | bumps the thread and notifies the counterparty |
| `on_dispute_message_insert()` | marks the dispute replied and notifies both parties |

## 5. Enum drift

`live_platform` only had `tiktok` and `youtube` in the migration, but the
buyer and seller apps already offer WhatsApp, Instagram, TikTok and
Facebook. The enum now carries all five, and the
`live_session_external_url` constraint accepts all five URL shapes.

`dispute_status` gained `escalated`.

`ALTER TYPE ... ADD VALUE` cannot use the new value in the same
transaction, so the enum widening lives in
`20261020090000_live_schema_reconciliation.sql` and the constraint that
uses the new platforms lives in
`20261020090100_live_platform_constraints.sql`, one transaction later.

## 6. The three identifier formats

The live project carries three different identifier formats. They are
deliberate and must not be merged:

| Identifier | Format | Owner | Purpose |
|---|---|---|---|
| Seller Kobe ID | `KOBE12XL` | `kobe_id_registry` | the public seller identity |
| App-facing seller ID | `KM-` + 15 hex | `seller_profiles.kobe_id` | what the existing PWAs already display |
| Buyer Wallet ID | `KMB-27-MAZI` | `wallets` | the memorable buyer wallet identifier |

`sync_registry_kobe_id()` keeps the registry row and the
`seller_profiles` row in step, so the canonical blueprint format is
reserved exactly once per seller.

## 7. The one behaviour change

`finalize_order(order_id)` used to **release escrow to the seller**. It now
performs the **capture** step, because that is what a payment-provider
callback means by "the payment is finalised".

| Operation | Function |
|---|---|
| buyer's money captured, order moves to `in_escrow` | `place_funds_in_escrow()` |
| escrow paid out to the seller | `release_escrow()` |

`finalize_order()` is kept as a compatibility wrapper that dispatches on
the order status.

No live payment had been captured at the time of this change (AzamPay is
not connected), so there was no in-flight transaction to migrate. The
payment callback Edge Function is updated to call the capture function
explicitly.

## 8. How to verify the reconciliation

```bash
# 1. Rebuild the schema from the migrations alone
supabase db reset

# 2. Every migration must parse and every GRANT EXECUTE must resolve
npm run lint:sql

# 3. Compare the rebuilt schema with production
supabase db diff --schema public --linked
```

`supabase db diff` should report no differences. If it reports any, the
reconciliation is incomplete.
