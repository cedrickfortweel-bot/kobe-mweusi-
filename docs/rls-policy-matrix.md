# RLS policy matrix

Generated from `supabase/migrations/` by `node supabase/tests/gen_inventory.mjs`.

Every table listed here has row level security enabled. A table with no
policy is reachable by nobody through the Data API, which is the intended
state for service-role-only tables such as the money ledger.

| Table | Policy | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|---|
| `account_restrictions` | `account_restrictions_select_own` | select | authenticated | yes | - |
| `account_security_events` | `account_security_events_select_own` | select | authenticated | yes | - |
| `activity_events` | `activity_events_select_own` | select | authenticated | yes | - |
| `admin_approval_requests` | `admin_approval_requests_select_staff` | select | authenticated | yes | - |
| `app_settings` | `app_settings_read` | select | authenticated | yes | - |
| `audit_logs` | `audit_logs_select_staff` | select | authenticated | yes | - |
| `business_profiles` | `business_profiles_select_own_or_staff` | select | authenticated | yes | - |
| `business_profiles` | `business_profiles_write_own` | all | authenticated | yes | yes |
| `business_profiles` | `business_profiles_write_staff` | all | authenticated | yes | yes |
| `business_verification_events` | `business_verification_events_select` | select | authenticated | yes | - |
| `chat_messages` | `chat_messages_select_participant` | select | authenticated | yes | - |
| `chat_thread_members` | `chat_thread_members_select_own` | select | authenticated | yes | - |
| `chat_threads` | `chat_threads_select_participant` | select | authenticated | yes | - |
| `daily_business_metrics` | `daily_business_metrics_select_staff` | select | authenticated | yes | - |
| `delivery_agents` | `delivery_agents_select_own` | select | authenticated | yes | - |
| `delivery_assignments` | `delivery_assignments_select_own` | select | authenticated | yes | - |
| `dispute_decisions` | `dispute_decisions_select_participant` | select | authenticated | yes | - |
| `dispute_evidence` | `dispute_evidence_select_participant` | select | authenticated | yes | - |
| `dispute_messages` | `dispute_messages_insert_participant` | insert | authenticated | - | yes |
| `dispute_messages` | `dispute_messages_select_participant` | select | authenticated | yes | - |
| `dispute_timeline` | `dispute_timeline_select_participant` | select | authenticated | yes | - |
| `disputes` | `disputes_select_participant` | select | authenticated | yes | - |
| `email_provider_config` | `email_provider_config_read_staff` | select | authenticated | yes | - |
| `email_suppressions` | `email_suppressions_read_staff` | select | authenticated | yes | - |
| `employee_profiles` | `employee_profiles_select_own_or_staff` | select | authenticated | yes | - |
| `escrow_transactions` | `escrow_transactions_select_participant` | select | authenticated | yes | - |
| `financial_reports` | `financial_reports_select_staff` | select | authenticated | yes | - |
| `handoff_codes` | `handoff_codes_no_client_access` | select | authenticated | yes | - |
| `handoff_events` | `handoff_events_select_participant` | select | authenticated | yes | - |
| `handoff_events` | `handoff_events_select_participant` | select | authenticated | yes | - |
| `hub_operating_hours` | `hub_operating_hours_read` | select | anon, authenticated | yes | - |
| `hub_operating_hours` | `hub_operating_hours_write_staff` | all | authenticated | yes | yes |
| `hubs` | `hubs_read_active` | select | anon, authenticated | yes | - |
| `hubs` | `hubs_write_staff` | all | authenticated | yes | yes |
| `identity_verification_attempts` | `identity_verification_attempts_select_own` | select | authenticated | yes | - |
| `integration_health_checks` | `integration_health_checks_read_staff` | select | authenticated | yes | - |
| `kobe_id_registry` | `v_kobe_id_directory_read_verified` | select | authenticated | yes | - |
| `live_session_products` | `live_session_products_delete_own` | delete | authenticated | yes | - |
| `live_session_products` | `live_session_products_insert_own` | insert | authenticated | - | yes |
| `live_session_products` | `live_session_products_read_public_or_own` | select | anon, authenticated | yes | - |
| `live_session_products` | `live_session_products_update_own` | update | authenticated | yes | yes |
| `live_sessions` | `live_sessions_delete_own` | delete | authenticated | yes | - |
| `live_sessions` | `live_sessions_insert_own` | insert | authenticated | - | yes |
| `live_sessions` | `live_sessions_insert_own` | insert | authenticated | - | yes |
| `live_sessions` | `live_sessions_read_public_or_own` | select | anon, authenticated | yes | - |
| `live_sessions` | `live_sessions_update_own` | update | authenticated | yes | yes |
| `message_attachments` | `message_attachments_select_participant` | select | authenticated | yes | - |
| `message_read_receipts` | `message_read_receipts_select_participant` | select | authenticated | yes | - |
| `notification_preferences` | `notification_preferences_own` | all | authenticated | yes | yes |
| `notifications` | `notifications_mark_own` | update | authenticated | yes | yes |
| `notifications` | `notifications_select_own` | select | authenticated | yes | - |
| `objects` | `business_documents_read_own` | select | authenticated | yes | - |
| `objects` | `business_documents_read_staff` | select | authenticated | yes | - |
| `objects` | `business_documents_upload_own` | insert | authenticated | - | yes |
| `objects` | `chat_attachments_read_participant` | select | authenticated | yes | - |
| `objects` | `chat_attachments_upload_participant` | insert | authenticated | - | yes |
| `objects` | `dispute_evidence_private_read_participant` | select | authenticated | yes | - |
| `objects` | `dispute_evidence_private_upload_participant` | insert | authenticated | - | yes |
| `objects` | `dispute_evidence_read` | select | authenticated | yes | - |
| `objects` | `dispute_evidence_upload` | insert | authenticated | - | yes |
| `objects` | `kyc_documents_read_own` | select | authenticated | yes | - |
| `objects` | `kyc_documents_upload_own` | insert | authenticated | - | yes |
| `objects` | `kyc_documents_upload_own` | insert | authenticated | - | yes |
| `objects` | `order_evidence_read_participant` | select | authenticated | yes | - |
| `objects` | `order_evidence_upload_participant` | insert | authenticated | - | yes |
| `objects` | `profile_avatars_delete_own` | delete | authenticated | yes | - |
| `objects` | `profile_avatars_read_public` | select | anon, authenticated | yes | - |
| `objects` | `profile_avatars_update_own` | update | authenticated | yes | yes |
| `objects` | `profile_avatars_upload_own` | insert | authenticated | - | yes |
| `objects` | `public_brand_assets_read` | select | anon, authenticated | yes | - |
| `objects` | `public_brand_assets_write_staff` | all | authenticated | yes | yes |
| `objects` | `seller_kyc_private_delete_own` | delete | authenticated | yes | - |
| `objects` | `seller_kyc_private_read_own` | select | authenticated | yes | - |
| `objects` | `seller_kyc_private_read_reviewer` | select | authenticated | yes | - |
| `objects` | `seller_kyc_private_upload_own` | insert | authenticated | - | yes |
| `objects` | `shop_media_read_public` | select | anon, authenticated | yes | - |
| `objects` | `shop_media_upload_own` | insert | authenticated | - | yes |
| `order_delivery_workflows` | `order_delivery_workflows_select_participant` | select | authenticated | yes | - |
| `orders` | `orders_select_participant` | select | authenticated | yes | - |
| `payment_intents` | `payment_intents_select_buyer` | select | authenticated | yes | - |
| `payment_provider_config` | `payment_provider_config_read` | select | authenticated | yes | - |
| `payment_provider_config` | `payment_provider_config_write_staff` | all | authenticated | yes | yes |
| `payment_provider_events` | `payment_provider_events_select_own` | select | authenticated | yes | - |
| `payout_requests` | `payout_requests_select_own` | select | authenticated | yes | - |
| `pickup_events` | `pickup_events_select_participant` | select | authenticated | yes | - |
| `products` | `products_delete_own` | delete | authenticated | yes | - |
| `products` | `products_insert_own` | insert | authenticated | - | yes |
| `products` | `products_insert_own` | insert | authenticated | - | yes |
| `products` | `products_read_published` | select | anon, authenticated | yes | - |
| `products` | `products_update_own` | update | authenticated | yes | yes |
| `profiles` | `profiles_select_own` | select | authenticated | yes | - |
| `profiles` | `profiles_update_own` | update | authenticated | yes | yes |
| `push_subscriptions` | `push_subscriptions_own` | all | authenticated | yes | yes |
| `refunds` | `refunds_select_participant` | select | authenticated | yes | - |
| `reviews` | `reviews_insert_completed_buyer_order` | insert | authenticated | - | yes |
| `reviews` | `reviews_read_public` | select | anon, authenticated | yes | - |
| `scheduled_job_runs` | `scheduled_job_runs_read_staff` | select | authenticated | yes | - |
| `security_events` | `security_events_select_own` | select | authenticated | yes | - |
| `seller_business_hours` | `seller_business_hours_read` | select | anon, authenticated | yes | - |
| `seller_business_hours` | `seller_business_hours_write_own` | all | authenticated | yes | yes |
| `seller_kyc_submissions` | `seller_kyc_insert_own_seller` | insert | authenticated | - | yes |
| `seller_kyc_submissions` | `seller_kyc_insert_own_seller` | insert | authenticated | - | yes |
| `seller_kyc_submissions` | `seller_kyc_insert_own_seller` | insert | authenticated | - | yes |
| `seller_kyc_submissions` | `seller_kyc_select_own_or_staff` | select | authenticated | yes | - |
| `seller_profiles` | `seller_profiles_delete_own_seller` | delete | authenticated | yes | - |
| `seller_profiles` | `seller_profiles_insert_own_seller` | insert | authenticated | - | yes |
| `seller_profiles` | `seller_profiles_read_public_or_own` | select | anon, authenticated | yes | - |
| `seller_profiles` | `seller_profiles_update_own_seller` | update | authenticated | yes | yes |
| `seller_social_accounts` | `seller_social_accounts_delete_own` | delete | authenticated | yes | - |
| `seller_social_accounts` | `seller_social_accounts_read` | select | anon, authenticated | yes | - |
| `seller_social_accounts` | `seller_social_accounts_update_own` | update | authenticated | yes | yes |
| `seller_social_accounts` | `seller_social_accounts_write_own` | insert | authenticated | - | yes |
| `support_request_audit` | `support_request_audit_select_own` | select | authenticated | yes | - |
| `support_requests` | `support_requests_insert_own` | insert | authenticated | - | yes |
| `support_requests` | `support_requests_own` | select | authenticated | yes | - |
| `user_consents` | `user_consents_insert_own` | insert | authenticated | - | yes |
| `user_consents` | `user_consents_select_own` | select | authenticated | yes | - |
| `user_devices` | `user_devices_own` | all | authenticated | yes | yes |
| `user_presence` | `user_presence_select_participant` | select | authenticated | yes | - |
| `user_presence` | `user_presence_write_own` | all | authenticated | yes | yes |
| `user_settings` | `user_settings_own` | all | authenticated | yes | yes |
| `wallet_ledger_entries` | `wallet_ledger_select_owner` | select | authenticated | yes | - |

## Tables with RLS enabled and no policy

- `internal_user_roles`
- `rate_limit_counters`
- `kyc_review_audit`
- `transaction_pins`
- `wallets`
- `pin_throttle`
- `financial_adjustments`
- `platform_fees`
- `provider_settlements`
- `reconciliation_runs`
- `notification_deliveries`
- `kyc_access_log`
- `admin_permissions`
- `internal_role_permissions`
- `admin_invitations`
- `admin_mfa_requirements`
- `risk_events`
- `webhook_event_receipts`
- `idempotency_keys`
- `notification_unsubscribe_tokens`
