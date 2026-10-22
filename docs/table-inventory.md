# Table inventory

Generated from `supabase/migrations/` by `node supabase/tests/gen_inventory.mjs`.
Do not edit by hand: regenerate instead.

83 tables, 10 views, 183 functions.

## Baseline

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `activity_events` | yes | 8 | 1 |
| `chat_messages` | yes | 6 | 1 |
| `chat_threads` | yes | 7 | 1 |
| `dispute_evidence` | yes | 5 | 1 |
| `dispute_messages` | yes | 5 | 2 |
| `disputes` | yes | 11 | 1 |
| `email_provider_config` | yes | 7 | 1 |
| `email_suppressions` | yes | 5 | 1 |
| `handoff_codes` | yes | 9 | 1 |
| `internal_user_roles` | yes | 3 | 0 |
| `kyc_review_audit` | yes | 8 | 0 |
| `live_session_products` | yes | 4 | 4 |
| `live_sessions` | yes | 12 | 5 |
| `notification_rules` | no | 9 | 0 |
| `notification_unsubscribe_tokens` | yes | 5 | 0 |
| `notifications` | yes | 10 | 2 |
| `orders` | yes | 16 | 1 |
| `payment_intents` | yes | 10 | 1 |
| `products` | yes | 10 | 5 |
| `profiles` | yes | 7 | 2 |
| `push_subscriptions` | yes | 6 | 1 |
| `rate_limit_counters` | yes | 4 | 0 |
| `reviews` | yes | 8 | 2 |
| `seller_kyc_submissions` | yes | 21 | 4 |
| `seller_profiles` | yes | 10 | 4 |
| `support_requests` | yes | 9 | 2 |
| `transaction_pins` | yes | 3 | 0 |
| `wallet_ledger_entries` | yes | 8 | 1 |

## Reconciliation

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `delivery_agents` | yes | 7 | 1 |
| `delivery_assignments` | yes | 7 | 1 |
| `handoff_events` | yes | 7 | 2 |
| `kobe_id_registry` | yes | 4 | 1 |
| `order_delivery_workflows` | yes | 9 | 1 |
| `pin_throttle` | yes | 5 | 0 |
| `support_request_audit` | yes | 6 | 1 |
| `wallets` | yes | 4 | 0 |

## A. Identity and access

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `account_security_events` | yes | 8 | 1 |
| `user_consents` | yes | 8 | 2 |
| `user_devices` | yes | 10 | 1 |
| `user_settings` | yes | 11 | 1 |

## C. Wallets, escrow and payments

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `escrow_transactions` | yes | 19 | 1 |
| `financial_adjustments` | yes | 14 | 0 |
| `payment_provider_events` | yes | 12 | 1 |
| `payout_requests` | yes | 14 | 1 |
| `platform_fees` | yes | 7 | 0 |
| `provider_settlements` | yes | 12 | 0 |
| `reconciliation_runs` | yes | 14 | 0 |
| `refunds` | yes | 14 | 1 |

## D. Live business and social

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `seller_business_hours` | yes | 7 | 2 |
| `seller_social_accounts` | yes | 10 | 4 |

## E. Chat and realtime

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `chat_thread_members` | yes | 6 | 1 |
| `message_attachments` | yes | 6 | 1 |
| `message_read_receipts` | yes | 3 | 1 |
| `user_presence` | yes | 4 | 2 |

## F. Notifications and devices

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `notification_deliveries` | yes | 13 | 0 |
| `notification_preferences` | yes | 7 | 1 |

## G. Orders, delivery and escrow release

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `app_settings` | yes | 6 | 1 |
| `hub_operating_hours` | yes | 7 | 2 |
| `hubs` | yes | 10 | 2 |
| `pickup_events` | yes | 7 | 1 |

## H. Disputes and resolution

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `dispute_decisions` | yes | 10 | 1 |
| `dispute_timeline` | yes | 6 | 1 |

## J. KYC and verification

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `account_restrictions` | yes | 11 | 1 |
| `business_profiles` | yes | 15 | 3 |
| `business_verification_events` | yes | 7 | 1 |
| `identity_verification_attempts` | yes | 7 | 1 |
| `kyc_access_log` | yes | 6 | 0 |

## K. Admin, employees and audit

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `admin_approval_requests` | yes | 14 | 1 |
| `admin_invitations` | yes | 10 | 0 |
| `admin_mfa_requirements` | yes | 3 | 0 |
| `admin_permissions` | yes | 5 | 0 |
| `audit_logs` | yes | 11 | 1 |
| `employee_profiles` | yes | 9 | 1 |
| `internal_role_permissions` | yes | 4 | 0 |

## L. Security, fraud and rate limits

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `idempotency_keys` | yes | 8 | 0 |
| `risk_events` | yes | 12 | 0 |
| `security_events` | yes | 9 | 1 |
| `webhook_event_receipts` | yes | 11 | 0 |

## M. Analytics and reports

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `daily_business_metrics` | yes | 14 | 1 |
| `financial_reports` | yes | 9 | 1 |

## N. System configuration and integrations

| Table | RLS | Columns | Policies |
|---|---|---|---|
| `integration_health_checks` | yes | 8 | 1 |
| `payment_provider_config` | yes | 10 | 2 |
| `scheduled_job_runs` | yes | 9 | 1 |

## Storage buckets


## Column detail

### Baseline

**`activity_events`** (RLS on)

- `created_at timestamptz`
- `dispute_id uuid`
- `id uuid`
- `kind text`
- `order_id uuid`
- `payload jsonb`
- `undefined`
- `user_id uuid`

**`chat_messages`** (RLS on)

- `body text`
- `created_at timestamptz`
- `id uuid`
- `sender_id uuid`
- `thread_buyer uuid`
- `thread_seller uuid`

**`chat_threads`** (RLS on)

- `buyer_id uuid`
- `buyer_seen_at timestamptz`
- `created_at timestamptz`
- `seller_id uuid`
- `seller_seen_at timestamptz`
- `undefined`
- `updated_at timestamptz`

**`dispute_evidence`** (RLS on)

- `created_at timestamptz`
- `dispute_id uuid`
- `id uuid`
- `sender_id uuid`
- `storage_path text`

**`dispute_messages`** (RLS on)

- `body text`
- `created_at timestamptz`
- `dispute_id uuid`
- `id uuid`
- `sender_id uuid`

**`disputes`** (RLS on)

- `created_at timestamptz`
- `description text`
- `id uuid`
- `opened_by uuid`
- `order_id uuid`
- `outcome public.dispute_outcome`
- `reason text`
- `resolved_at timestamptz`
- `seller_deadline timestamptz`
- `status public.dispute_status`
- `undefined`

**`email_provider_config`** (RLS on)

- `from_email text`
- `from_name text`
- `is_enabled bool`
- `provider text`
- `reply_to text`
- `updated_at timestamptz`
- `updated_by uuid`

**`email_suppressions`** (RLS on)

- `created_at timestamptz`
- `detail text`
- `email text`
- `provider text`
- `reason text`

**`handoff_codes`** (RLS on)

- `code_type public.handoff_code_type`
- `created_at timestamptz`
- `expires_at timestamptz`
- `id uuid`
- `issued_to uuid`
- `order_id uuid`
- `token_hash text`
- `undefined`
- `used_at timestamptz`

**`internal_user_roles`** (RLS on)

- `created_at timestamptz`
- `role text`
- `user_id uuid`

**`kyc_review_audit`** (RLS on)

- `created_at timestamptz`
- `decision text`
- `id uuid`
- `previous_status text`
- `review_note text`
- `reviewer_id uuid`
- `seller_id uuid`
- `submission_id uuid`

**`live_session_products`** (RLS on)

- `pinned bool`
- `product_id uuid`
- `session_id uuid`
- `sort_order int4`

**`live_sessions`** (RLS on)

- `created_at timestamptz`
- `description text`
- `ends_at timestamptz`
- `external_url text`
- `id uuid`
- `platform public.live_platform`
- `seller_id uuid`
- `starts_at timestamptz`
- `status public.live_status`
- `title text`
- `undefined`
- `updated_at timestamptz`

**`notification_rules`** (RLS off)

- `body text`
- `category text`
- `channels text`
- `enabled bool`
- `kind text`
- `link text`
- `priority text`
- `title text`
- `updated_at timestamptz`

**`notification_unsubscribe_tokens`** (RLS on)

- `category text`
- `created_at timestamptz`
- `id uuid`
- `used_at timestamptz`
- `user_id uuid`

**`notifications`** (RLS on)

- `body text`
- `created_at timestamptz`
- `id uuid`
- `kind text`
- `link text`
- `payload jsonb`
- `read_at timestamptz`
- `title text`
- `undefined`
- `user_id uuid`

**`orders`** (RLS on)

- `buyer_fee_tzs int8`
- `buyer_id uuid`
- `created_at timestamptz`
- `id uuid`
- `item_name text`
- `live_session_id uuid`
- `product_id uuid`
- `quantity int4`
- `seller_fee_tzs int8`
- `seller_id uuid`
- `status public.order_status`
- `subtotal_tzs int8`
- `total_due_tzs int8`
- `undefined`
- `unit_price_tzs int8`
- `updated_at timestamptz`

**`payment_intents`** (RLS on)

- `amount_tzs int8`
- `buyer_id uuid`
- `created_at timestamptz`
- `id uuid`
- `idempotency_key text`
- `order_id uuid`
- `provider text`
- `provider_reference text`
- `status public.payment_status`
- `updated_at timestamptz`

**`products`** (RLS on)

- `created_at timestamptz`
- `description text`
- `id uuid`
- `image_path text`
- `name text`
- `price_tzs int8`
- `seller_id uuid`
- `status public.product_status`
- `stock_quantity int4`
- `updated_at timestamptz`

**`profiles`** (RLS on)

- `account_type public.account_type`
- `created_at timestamptz`
- `display_name text`
- `id uuid`
- `phone_e164 text`
- `undefined`
- `updated_at timestamptz`

**`push_subscriptions`** (RLS on)

- `auth text`
- `created_at timestamptz`
- `endpoint text`
- `p256dh text`
- `updated_at timestamptz`
- `user_id uuid`

**`rate_limit_counters`** (RLS on)

- `hit_count int4`
- `scope text`
- `subject_hash text`
- `window_started_at timestamptz`

**`reviews`** (RLS on)

- `buyer_id uuid`
- `comment text`
- `created_at timestamptz`
- `id uuid`
- `order_id uuid`
- `seller_id uuid`
- `stars int2`
- `undefined`

**`seller_kyc_submissions`** (RLS on)

- `attested_at timestamptz`
- `business_name text`
- `business_type text`
- `document_paths text`
- `entity_type text`
- `id uuid`
- `id_last4 text`
- `id_type text`
- `legal_name text`
- `region text`
- `registration_number text`
- `representative_role text`
- `review_note text`
- `reviewed_at timestamptz`
- `reviewed_by uuid`
- `seller_id uuid`
- `social_links jsonb`
- `status text`
- `submitted_at timestamptz`
- `tax_id_last4 text`
- `undefined`

**`seller_profiles`** (RLS on)

- `bio text`
- `created_at timestamptz`
- `public_contact text`
- `region text`
- `shop_name text`
- `shop_slug text`
- `undefined`
- `updated_at timestamptz`
- `user_id uuid`
- `verification_status public.seller_verification_status`

**`support_requests`** (RLS on)

- `created_at timestamptz`
- `current_info text`
- `id uuid`
- `proposed text`
- `reason text`
- `status text`
- `topic text`
- `updated_at timestamptz`
- `user_id uuid`

**`transaction_pins`** (RLS on)

- `changed_at timestamptz`
- `pin_hash text`
- `user_id uuid`

**`wallet_ledger_entries`** (RLS on)

- `amount_tzs int8`
- `created_at timestamptz`
- `entry_type public.wallet_entry_type`
- `id uuid`
- `idempotency_key text`
- `order_id uuid`
- `payment_intent_id uuid`
- `user_id uuid`

### Reconciliation

**`delivery_agents`** (RLS on)

- `created_at timestamptz`
- `undefined`
- `updated_at timestamptz`
- `user_id uuid`
- `verification_status text`
- `verified_at timestamptz`
- `verified_by uuid`

**`delivery_assignments`** (RLS on)

- `agent_user_id uuid`
- `assigned_by uuid`
- `created_at timestamptz`
- `id uuid`
- `order_id uuid`
- `status text`
- `updated_at timestamptz`

**`handoff_events`** (RLS on)

- `created_at timestamptz`
- `details jsonb`
- `id uuid`
- `order_id uuid`
- `qr_code_id uuid`
- `scanned_by uuid`
- `stage text`

**`kobe_id_registry`** (RLS on)

- `assigned_at timestamptz`
- `assigned_user_id uuid`
- `kobe_id text`
- `undefined`

**`order_delivery_workflows`** (RLS on)

- `agent_user_id uuid`
- `created_at timestamptz`
- `delivery_mode text`
- `first_direct_code_type public.handoff_code_type`
- `first_scanned_by uuid`
- `order_id uuid`
- `stage text`
- `undefined`
- `updated_at timestamptz`

**`pin_throttle`** (RLS on)

- `failed_attempts int4`
- `locked_until timestamptz`
- `undefined`
- `updated_at timestamptz`
- `user_id uuid`

**`support_request_audit`** (RLS on)

- `action text`
- `created_at timestamptz`
- `id uuid`
- `note text`
- `request_id uuid`
- `staff_id uuid`

**`wallets`** (RLS on)

- `created_at timestamptz`
- `id uuid`
- `user_id uuid`
- `wallet_id text`

### A. Identity and access

**`account_security_events`** (RLS on)

- `created_at timestamptz`
- `detail jsonb`
- `device_label text`
- `event_type text`
- `id uuid`
- `ip_hash text`
- `severity text`
- `user_id uuid`

**`user_consents`** (RLS on)

- `accepted bool`
- `accepted_at timestamptz`
- `consent_type text`
- `id uuid`
- `ip_hash text`
- `user_agent text`
- `user_id uuid`
- `version text`

**`user_devices`** (RLS on)

- `created_at timestamptz`
- `device_fingerprint text`
- `device_label text`
- `id uuid`
- `last_seen_at timestamptz`
- `platform text`
- `push_endpoint text`
- `revoked_at timestamptz`
- `trusted bool`
- `user_id uuid`

**`user_settings`** (RLS on)

- `chat_updates bool`
- `email_enabled bool`
- `language text`
- `marketing_updates bool`
- `order_updates bool`
- `push_enabled bool`
- `sms_enabled bool`
- `theme text`
- `two_factor_required bool`
- `updated_at timestamptz`
- `user_id uuid`

### C. Wallets, escrow and payments

**`escrow_transactions`** (RLS on)

- `amount_tzs int8`
- `buyer_fee_tzs int8`
- `buyer_id uuid`
- `created_at timestamptz`
- `funded_at timestamptz`
- `hold_reason text`
- `id uuid`
- `order_id uuid`
- `payment_intent_id uuid`
- `platform_fee_tzs int8`
- `refunded_at timestamptz`
- `release_reason text`
- `release_requested_at timestamptz`
- `release_scheduled_for timestamptz`
- `released_at timestamptz`
- `seller_fee_tzs int8`
- `seller_id uuid`
- `status public.escrow_status`
- `updated_at timestamptz`

**`financial_adjustments`** (RLS on)

- `amount_tzs int8`
- `applied_at timestamptz`
- `approved_by uuid`
- `created_at timestamptz`
- `entry_type public.wallet_entry_type`
- `id uuid`
- `idempotency_key text`
- `order_id uuid`
- `reason text`
- `reason_code text`
- `requested_by uuid`
- `status public.adjustment_status`
- `updated_at timestamptz`
- `user_id uuid`

**`payment_provider_events`** (RLS on)

- `amount_tzs int8`
- `created_at timestamptz`
- `event_type text`
- `id uuid`
- `order_id uuid`
- `payment_intent_id uuid`
- `processed_at timestamptz`
- `processing_error text`
- `provider text`
- `provider_event_id text`
- `raw_payload jsonb`
- `signature_verified bool`

**`payout_requests`** (RLS on)

- `amount_tzs int8`
- `approved_by uuid`
- `created_at timestamptz`
- `decided_at timestamptz`
- `destination text`
- `fee_tzs int8`
- `id uuid`
- `idempotency_key text`
- `method text`
- `provider_reference text`
- `requested_by uuid`
- `seller_id uuid`
- `status public.payout_status`
- `updated_at timestamptz`

**`platform_fees`** (RLS on)

- `amount_tzs int8`
- `created_at timestamptz`
- `fee_type text`
- `id uuid`
- `ledger_entry_id uuid`
- `order_id uuid`
- `user_id uuid`

**`provider_settlements`** (RLS on)

- `created_at timestamptz`
- `detail jsonb`
- `fees_tzs int8`
- `gross_tzs int8`
- `id uuid`
- `net_tzs int8`
- `provider text`
- `provider_batch_id text`
- `settlement_date date`
- `status public.settlement_status`
- `transaction_count int4`
- `updated_at timestamptz`

**`reconciliation_runs`** (RLS on)

- `detail jsonb`
- `difference_tzs int8`
- `finished_at timestamptz`
- `id uuid`
- `internal_total_tzs int8`
- `matched_count int4`
- `mismatched_count int4`
- `period_end timestamptz`
- `period_start timestamptz`
- `provider text`
- `provider_total_tzs int8`
- `settlement_id uuid`
- `started_at timestamptz`
- `status public.settlement_status`

**`refunds`** (RLS on)

- `amount_tzs int8`
- `approved_by uuid`
- `created_at timestamptz`
- `decided_at timestamptz`
- `escrow_transaction_id uuid`
- `id uuid`
- `idempotency_key text`
- `order_id uuid`
- `provider text`
- `provider_reference text`
- `reason text`
- `requested_by uuid`
- `status public.refund_status`
- `updated_at timestamptz`

### D. Live business and social

**`seller_business_hours`** (RLS on)

- `closes_at time`
- `id uuid`
- `is_closed bool`
- `note text`
- `opens_at time`
- `seller_id uuid`
- `weekday int2`

**`seller_social_accounts`** (RLS on)

- `created_at timestamptz`
- `handle text`
- `id uuid`
- `platform public.social_platform`
- `seller_id uuid`
- `updated_at timestamptz`
- `url text`
- `verification_status public.social_verification_status`
- `verified_at timestamptz`
- `verified_by uuid`

### E. Chat and realtime

**`chat_thread_members`** (RLS on)

- `joined_at timestamptz`
- `last_read_at timestamptz`
- `role text`
- `thread_buyer uuid`
- `thread_seller uuid`
- `user_id uuid`

**`message_attachments`** (RLS on)

- `created_at timestamptz`
- `id uuid`
- `message_id uuid`
- `mime_type text`
- `size_bytes int8`
- `storage_path text`

**`message_read_receipts`** (RLS on)

- `message_id uuid`
- `read_at timestamptz`
- `user_id uuid`

**`user_presence`** (RLS on)

- `is_online bool`
- `last_seen_at timestamptz`
- `updated_at timestamptz`
- `user_id uuid`

### F. Notifications and devices

**`notification_deliveries`** (RLS on)

- `attempts int4`
- `channel text`
- `created_at timestamptz`
- `id uuid`
- `last_error text`
- `max_attempts int4`
- `next_attempt_at timestamptz`
- `notification_id uuid`
- `provider_message_id text`
- `sent_at timestamptz`
- `status text`
- `updated_at timestamptz`
- `user_id uuid`

**`notification_preferences`** (RLS on)

- `category text`
- `email bool`
- `in_app bool`
- `push bool`
- `sms bool`
- `updated_at timestamptz`
- `user_id uuid`

### G. Orders, delivery and escrow release

**`app_settings`** (RLS on)

- `description text`
- `is_secret bool`
- `key text`
- `updated_at timestamptz`
- `updated_by uuid`
- `value jsonb`

**`hub_operating_hours`** (RLS on)

- `closes_at time`
- `hub_id uuid`
- `id uuid`
- `is_closed bool`
- `note text`
- `opens_at time`
- `weekday int2`

**`hubs`** (RLS on)

- `address text`
- `city text`
- `code text`
- `created_at timestamptz`
- `id uuid`
- `is_active bool`
- `name text`
- `phone_e164 text`
- `region text`
- `updated_at timestamptz`

**`pickup_events`** (RLS on)

- `actor_id uuid`
- `created_at timestamptz`
- `event_type text`
- `hub_id uuid`
- `id uuid`
- `notes text`
- `order_id uuid`

### H. Disputes and resolution

**`dispute_decisions`** (RLS on)

- `buyer_amount_tzs int8`
- `created_at timestamptz`
- `decision text`
- `dispute_id uuid`
- `financial_action text`
- `financial_reference text`
- `id uuid`
- `reason text`
- `reviewer_id uuid`
- `seller_amount_tzs int8`

**`dispute_timeline`** (RLS on)

- `actor_id uuid`
- `created_at timestamptz`
- `detail jsonb`
- `dispute_id uuid`
- `event text`
- `id uuid`

### J. KYC and verification

**`account_restrictions`** (RLS on)

- `created_at timestamptz`
- `ends_at timestamptz`
- `id uuid`
- `imposed_by uuid`
- `is_active bool`
- `lifted_at timestamptz`
- `lifted_by uuid`
- `reason text`
- `restriction_type text`
- `starts_at timestamptz`
- `user_id uuid`

**`business_profiles`** (RLS on)

- `business_name text`
- `business_type text`
- `country_code text`
- `created_at timestamptz`
- `id uuid`
- `legal_name text`
- `region text`
- `registered_address text`
- `registration_number text`
- `representative_name text`
- `representative_phone_e164 text`
- `representative_role text`
- `seller_id uuid`
- `tax_id text`
- `updated_at timestamptz`

**`business_verification_events`** (RLS on)

- `business_id uuid`
- `created_at timestamptz`
- `event_type text`
- `id uuid`
- `note text`
- `reviewer_id uuid`
- `seller_id uuid`

**`identity_verification_attempts`** (RLS on)

- `created_at timestamptz`
- `id uuid`
- `method text`
- `outcome text`
- `reason text`
- `subject_hash text`
- `user_id uuid`

**`kyc_access_log`** (RLS on)

- `created_at timestamptz`
- `document_path text`
- `id uuid`
- `reviewer_id uuid`
- `seller_id uuid`
- `submission_id uuid`

### K. Admin, employees and audit

**`admin_approval_requests`** (RLS on)

- `action text`
- `amount_tzs int8`
- `approved_by uuid`
- `created_at timestamptz`
- `decided_at timestamptz`
- `executed_at timestamptz`
- `expires_at timestamptz`
- `id uuid`
- `payload jsonb`
- `reason text`
- `requested_by uuid`
- `status text`
- `target_id uuid`
- `target_user_id uuid`

**`admin_invitations`** (RLS on)

- `accepted_at timestamptz`
- `created_at timestamptz`
- `email text`
- `expires_at timestamptz`
- `id uuid`
- `invited_by uuid`
- `permissions text`
- `revoked_at timestamptz`
- `role text`
- `token_hash text`

**`admin_mfa_requirements`** (RLS on)

- `enforced_from timestamptz`
- `mfa_required bool`
- `role text`

**`admin_permissions`** (RLS on)

- `created_at timestamptz`
- `description text`
- `is_high_risk bool`
- `permission text`
- `requires_dual_approval bool`

**`audit_logs`** (RLS on)

- `action text`
- `actor_id uuid`
- `actor_role text`
- `created_at timestamptz`
- `detail jsonb`
- `id uuid`
- `ip_hash text`
- `reason text`
- `target_id uuid`
- `target_type text`
- `target_user_id uuid`

**`employee_profiles`** (RLS on)

- `created_at timestamptz`
- `department text`
- `employee_code text`
- `employment_status text`
- `hired_on date`
- `job_title text`
- `manager_user_id uuid`
- `updated_at timestamptz`
- `user_id uuid`

**`internal_role_permissions`** (RLS on)

- `created_at timestamptz`
- `granted_by uuid`
- `permission text`
- `role text`

### L. Security, fraud and rate limits

**`idempotency_keys`** (RLS on)

- `created_at timestamptz`
- `expires_at timestamptz`
- `key text`
- `request_hash text`
- `response jsonb`
- `scope text`
- `status text`
- `user_id uuid`

**`risk_events`** (RLS on)

- `created_at timestamptz`
- `detail jsonb`
- `id uuid`
- `order_id uuid`
- `review_note text`
- `reviewed_at timestamptz`
- `reviewed_by uuid`
- `score int2`
- `severity text`
- `signal text`
- `status text`
- `user_id uuid`

**`security_events`** (RLS on)

- `created_at timestamptz`
- `detail jsonb`
- `device_label text`
- `event_type text`
- `id uuid`
- `ip_hash text`
- `severity text`
- `user_agent text`
- `user_id uuid`

**`webhook_event_receipts`** (RLS on)

- `attempts int4`
- `error text`
- `event_type text`
- `external_id text`
- `id uuid`
- `payload jsonb`
- `processed_at timestamptz`
- `received_at timestamptz`
- `signature_verified bool`
- `source text`
- `status text`

### M. Analytics and reports

**`daily_business_metrics`** (RLS on)

- `computed_at timestamptz`
- `disputes_opened int4`
- `disputes_resolved int4`
- `escrow_held_tzs int8`
- `gross_volume_tzs int8`
- `metric_date date`
- `orders_cancelled int4`
- `orders_completed int4`
- `orders_created int4`
- `orders_disputed int4`
- `payments_failed int4`
- `payments_succeeded int4`
- `platform_revenue_tzs int8`
- `refunds_tzs int8`

**`financial_reports`** (RLS on)

- `created_at timestamptz`
- `generated_by uuid`
- `id uuid`
- `period_end date`
- `period_start date`
- `report_type text`
- `status text`
- `storage_path text`
- `totals jsonb`

### N. System configuration and integrations

**`integration_health_checks`** (RLS on)

- `detail jsonb`
- `error text`
- `id uuid`
- `integration text`
- `last_checked_at timestamptz`
- `last_success_at timestamptz`
- `latency_ms int4`
- `status text`

**`payment_provider_config`** (RLS on)

- `callback_path text`
- `environment text`
- `fee_bps int4`
- `is_enabled bool`
- `limits jsonb`
- `merchant_identifier text`
- `provider text`
- `supported_methods text`
- `updated_at timestamptz`
- `updated_by uuid`

**`scheduled_job_runs`** (RLS on)

- `detail jsonb`
- `duration_ms int4`
- `error text`
- `finished_at timestamptz`
- `id uuid`
- `job_name text`
- `rows_affected int4`
- `started_at timestamptz`
- `status text`

