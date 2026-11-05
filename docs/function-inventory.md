# Function inventory

Generated from `supabase/migrations/` by `node supabase/tests/gen_inventory.mjs`.

A function marked **definer** runs with the privileges of its owner. A
function marked **invoker** runs with the privileges of the caller. Every
money-moving function is a definer and is revoked from `anon` and
`authenticated` unless it is explicitly a customer-facing action.

## Baseline

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.admin_dispute_queue(int4)` | void | sql | invoker |
| `public.admin_order_queue(text, int4)` | void | sql | invoker |
| `public.admin_overview()` | void | sql | invoker |
| `public.agent_hub_snapshot(uuid, int4)` | void | sql | invoker |
| `public.approve_payout(uuid, uuid, text)` | void | sql | invoker |
| `public.assign_delivery_agent(uuid, uuid, uuid)` | void | sql | invoker |
| `public.assign_registry_kobe_id(uuid)` | void | sql | invoker |
| `public.audit_admin_payout_completion()` | void | sql | invoker |
| `public.audit_log_page(int4, int4, text)` | void | sql | invoker |
| `public.can_afford_order(uuid)` | void | sql | invoker |
| `public.can_upload_kyc_document(uuid)` | void | sql | invoker |
| `public.change_transaction_pin(uuid, text, text)` | void | sql | invoker |
| `public.check_transaction_pin(uuid, text)` | void | sql | invoker |
| `public.consume_rate_limit(text, text, int4, int4)` | void | sql | invoker |
| `public.consume_unsubscribe_token(uuid)` | void | sql | invoker |
| `public.create_payment_intent(uuid, uuid, int8, text, text)` | void | sql | invoker |
| `public.display_phone_for(uuid)` | void | sql | invoker |
| `public.email_address_for(uuid)` | void | sql | invoker |
| `public.enforce_app_write_rate_limit()` | void | sql | invoker |
| `public.evaluate_escrow_release(uuid)` | void | sql | invoker |
| `public.generate_wallet_id()` | void | sql | invoker |
| `public.handle_new_user()` | void | sql | invoker |
| `public.held_escrow(uuid)` | void | sql | invoker |
| `public.is_internal_staff()` | void | sql | invoker |
| `public.issue_handoff_codes(uuid, text, text, timestamptz)` | void | sql | invoker |
| `public.list_my_payout_requests(uuid)` | void | sql | invoker |
| `public.list_pending_payout_requests()` | void | sql | invoker |
| `public.mark_phone_verified(uuid, text)` | void | sql | invoker |
| `public.mark_seller_kyc_pending()` | void | sql | invoker |
| `public.my_escrow_timers()` | void | sql | invoker |
| `public.notify_seller_kyc_decision(uuid, uuid, text, text, text)` | void | sql | invoker |
| `public.pin_is_acceptable(text)` | void | sql | invoker |
| `public.pin_rejection_reason(text)` | void | sql | invoker |
| `public.pin_state(uuid)` | void | sql | invoker |
| `public.place_funds_in_escrow(uuid, uuid, text)` | void | sql | invoker |
| `public.project_activity_event()` | void | sql | invoker |
| `public.public_seller_identity_by_kid(text)` | void | sql | invoker |
| `public.record_failed_pin_attempt(uuid)` | void | sql | invoker |
| `public.record_handoff_scan(text, uuid, text)` | void | sql | invoker |
| `public.record_handoff(uuid, public.handoff_code_type, uuid)` | void | sql | invoker |
| `public.record_verified_payment(text, text, text, int8, uuid, uuid, uuid, jsonb)` | void | sql | invoker |
| `public.record_wallet_topup(text, text, text, int8, uuid, jsonb)` | void | sql | invoker |
| `public.render_notification_email(uuid)` | void | sql | invoker |
| `public.request_admin_approval(text, text, uuid, uuid, int8, jsonb)` | void | sql | invoker |
| `public.request_seller_payout(uuid, int8, text, text, uuid, text)` | void | sql | invoker |
| `public.request_wallet_topup(uuid, int8, text, text)` | void | sql | invoker |
| `public.require_dispute_dual_approval()` | void | sql | invoker |
| `public.require_payout_dual_approval()` | void | sql | invoker |
| `public.reserve_stock(uuid, int4)` | void | sql | invoker |
| `public.restore_expired_orders()` | void | sql | invoker |
| `public.restore_stock(uuid, int4)` | void | sql | invoker |
| `public.review_seller_kyc(uuid, uuid, text, text)` | void | sql | invoker |
| `public.sandbox_wallet_credit(uuid, int8, text)` | void | sql | invoker |
| `public.seller_payout_capacity(uuid)` | void | sql | invoker |
| `public.seller_stats(uuid)` | void | sql | invoker |
| `public.set_agent_verification(uuid, bool, uuid)` | void | sql | invoker |
| `public.set_agent_worker_identity(uuid, text, text, uuid)` | void | sql | invoker |
| `public.set_transaction_pin(uuid, text)` | void | sql | invoker |
| `public.set_updated_at()` | void | sql | invoker |
| `public.suppress_email(text, text, text, text)` | void | sql | invoker |
| `public.unsubscribe_token_for(uuid, text)` | void | sql | invoker |
| `public.validate_dispute_decision_amounts()` | void | sql | invoker |
| `public.validate_handoff_scan(text, uuid)` | void | sql | invoker |
| `public.verify_transaction_pin(uuid, text)` | void | sql | invoker |
| `public.wallet_available_balance(uuid)` | void | sql | invoker |
| `public.wallet_topup_allowed(uuid)` | void | sql | invoker |

## C. Wallets, escrow and payments

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.apply_financial_adjustment(uuid, uuid)` | void | sql | invoker |
| `public.approve_refund(uuid, uuid, text)` | void | sql | invoker |
| `public.escrow_position(uuid)` | void | sql | invoker |
| `public.finalize_order(uuid)` | void | sql | invoker |
| `public.place_escrow_hold(uuid, text)` | void | sql | invoker |
| `public.place_funds_in_escrow(uuid, uuid)` | void | sql | invoker |
| `public.post_ledger_transaction(uuid, int8, public.wallet_entry_type, text, uuid, uuid)` | void | sql | invoker |
| `public.reconcile_provider_settlement(text, text, date, int8, int8, int8, int4, uuid)` | void | sql | invoker |
| `public.record_verified_payment(text, text, text, int8, uuid, uuid, jsonb)` | void | sql | invoker |
| `public.release_escrow(uuid, text)` | void | sql | invoker |
| `public.request_refund(uuid, int8, text, uuid, text)` | void | sql | invoker |
| `public.wallet_balance(uuid)` | void | sql | invoker |

## Reconciliation

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.assign_kobe_id()` | void | sql | invoker |
| `public.block_ledger_mutation()` | void | sql | invoker |
| `public.check_order_live_session()` | void | sql | invoker |
| `public.force_server_fields()` | void | sql | invoker |
| `public.guard_chat_thread_initiator()` | void | sql | invoker |
| `public.guard_chat_thread_update()` | void | sql | invoker |
| `public.guard_live_session()` | void | sql | invoker |
| `public.guard_order_changes()` | void | sql | invoker |
| `public.on_chat_message_insert()` | void | sql | invoker |
| `public.on_dispute_message_insert()` | void | sql | invoker |
| `public.prevent_self_verification()` | void | sql | invoker |
| `public.protect_seller_locked_fields()` | void | sql | invoker |

## A. Identity and access

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.admin_reinstate_account(uuid, text, uuid)` | void | sql | invoker |
| `public.admin_suspend_account(uuid, text, uuid)` | void | sql | invoker |
| `public.close_my_account(text)` | void | sql | invoker |
| `public.get_my_preferences()` | void | sql | invoker |
| `public.is_account_active(uuid)` | void | sql | invoker |
| `public.record_account_security_event(uuid, text, text, text, text, jsonb)` | void | sql | invoker |
| `public.update_my_profile(text, text, text, text)` | void | sql | invoker |

## B. Kobe IDs and seller identity

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.become_seller(text, text, text)` | void | sql | invoker |
| `public.ensure_my_wallet()` | void | sql | invoker |
| `public.ensure_wallet_for(uuid)` | void | sql | invoker |
| `public.get_my_wallet_id()` | void | sql | invoker |
| `public.is_seller(uuid)` | void | sql | invoker |
| `public.is_verified_seller(uuid)` | void | sql | invoker |
| `public.public_seller_identity(uuid)` | void | sql | invoker |
| `public.reveal_wallet_id(uuid, uuid)` | void | sql | invoker |
| `public.sync_registry_kobe_id()` | void | sql | invoker |

## D. Live business and social

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.create_live_session(text, text, public.live_platform, text, timestamptz, timestamptz)` | void | sql | invoker |
| `public.end_live_session(uuid)` | void | sql | invoker |
| `public.list_public_live_sessions(int4)` | void | sql | invoker |
| `public.prevent_self_social_verification()` | void | sql | invoker |
| `public.update_live_session_status(uuid, public.live_status)` | void | sql | invoker |
| `public.verify_seller_social_link(uuid, bool, uuid)` | void | sql | invoker |

## E. Chat and realtime

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.list_my_threads(int4)` | void | sql | invoker |
| `public.mark_chat_thread_read(uuid)` | void | sql | invoker |
| `public.send_chat_message(uuid, text, uuid)` | void | sql | invoker |
| `public.set_presence(bool)` | void | sql | invoker |
| `public.start_chat_thread(uuid, uuid)` | void | sql | invoker |
| `public.unread_message_count()` | void | sql | invoker |

## F. Notifications and devices

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.claim_notification_deliveries(int4)` | void | sql | invoker |
| `public.complete_notification_delivery(uuid, bool, text, text)` | void | sql | invoker |
| `public.create_notification(uuid, text, text, text, text, jsonb, text, text, uuid)` | void | sql | invoker |
| `public.list_my_notifications(int4)` | void | sql | invoker |
| `public.mark_all_notifications_read()` | void | sql | invoker |
| `public.mark_notification_read(uuid)` | void | sql | invoker |
| `public.prune_notification_queue(int4)` | void | sql | invoker |
| `public.register_push_subscription(text, text, text)` | void | sql | invoker |
| `public.remove_push_subscription(text)` | void | sql | invoker |
| `public.unread_notification_count()` | void | sql | invoker |

## G. Orders, delivery and escrow release

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.confirm_receipt(uuid)` | void | sql | invoker |
| `public.escrow_policy(text, jsonb)` | void | sql | invoker |
| `public.is_assigned_agent(uuid, uuid)` | void | sql | invoker |
| `public.process_due_escrow_releases(int4)` | void | sql | invoker |
| `public.release_escrow_funds(uuid, text)` | void | sql | invoker |
| `public.start_escrow_release_window(uuid)` | void | sql | invoker |

## H. Disputes and resolution

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.assign_dispute_reviewer(uuid, uuid, uuid)` | void | sql | invoker |
| `public.execute_dispute_financial_outcome(uuid, uuid)` | void | sql | invoker |
| `public.log_dispute_timeline(uuid, text, jsonb, uuid)` | void | sql | invoker |
| `public.my_disputes()` | void | sql | invoker |
| `public.open_dispute(uuid, text, text, uuid)` | void | sql | invoker |
| `public.reopen_dispute(uuid, text, uuid)` | void | sql | invoker |
| `public.request_more_dispute_evidence(uuid, text, uuid)` | void | sql | invoker |
| `public.resolve_dispute(uuid, text, text, int8, int8, uuid)` | void | sql | invoker |
| `public.send_dispute_message(uuid, text, uuid)` | void | sql | invoker |
| `public.submit_dispute_evidence(uuid, text, uuid)` | void | sql | invoker |

## I. Storage and files

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.is_dispute_participant(uuid)` | void | sql | invoker |
| `public.is_dispute_reviewer()` | void | sql | invoker |
| `public.is_order_participant(uuid)` | void | sql | invoker |
| `public.signed_url_for(text, text, int4)` | void | sql | invoker |

## J. KYC and verification

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.active_restriction(uuid)` | void | sql | invoker |
| `public.decide_kyc(uuid, text, text, uuid)` | void | sql | invoker |
| `public.lift_restriction(uuid, uuid)` | void | sql | invoker |
| `public.list_kyc_queue(int4)` | void | sql | invoker |
| `public.log_kyc_document_access(uuid, uuid, text, uuid)` | void | sql | invoker |
| `public.restrict_account(uuid, text, text, uuid, timestamptz)` | void | sql | invoker |
| `public.resubmit_kyc(text, timestamptz)` | void | sql | invoker |
| `public.start_kyc_review(uuid, uuid)` | void | sql | invoker |
| `public.submit_kyc(text, text, text, text, text, text, text, text, text, text, jsonb, text, timestamptz)` | void | sql | invoker |

## K. Admin, employees and audit

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.accept_invitation(text)` | void | sql | invoker |
| `public.approve_admin_request(uuid, uuid, text)` | void | sql | invoker |
| `public.grant_permission(text, text, uuid)` | void | sql | invoker |
| `public.has_permission(uuid, text)` | void | sql | invoker |
| `public.i_have_permission(text)` | void | sql | invoker |
| `public.invite_employee(text, text, text, text, timestamptz)` | void | sql | invoker |
| `public.log_audit(text, text, uuid, uuid, text, jsonb, uuid)` | void | sql | invoker |
| `public.reject_admin_request(uuid, uuid, text)` | void | sql | invoker |
| `public.remove_admin_role(uuid, text, text, uuid)` | void | sql | invoker |
| `public.revoke_permission(text, text, uuid)` | void | sql | invoker |
| `public.set_admin_role(uuid, text, text, uuid)` | void | sql | invoker |

## L. Security, fraud and rate limits

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.claim_idempotency_key(text, text, uuid, text, int4)` | void | sql | invoker |
| `public.complete_idempotency_key(text, jsonb, bool)` | void | sql | invoker |
| `public.complete_webhook_receipt(uuid, text, text)` | void | sql | invoker |
| `public.enforce_rate_limit(text, text, int4, int4)` | void | sql | invoker |
| `public.prune_idempotency_keys()` | void | sql | invoker |
| `public.record_risk_event(uuid, text, int2, text, uuid, jsonb)` | void | sql | invoker |
| `public.record_security_event(uuid, text, text, text, text, text, jsonb)` | void | sql | invoker |
| `public.verify_payment_webhook(text, text, text, bool, jsonb)` | void | sql | invoker |

## M. Analytics and reports

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.compute_daily_metrics(date)` | void | sql | invoker |
| `public.compute_recent_metrics(int4)` | void | sql | invoker |
| `public.generate_financial_report(text, date, date, uuid)` | void | sql | invoker |

## N. System configuration and integrations

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.get_escrow_policy()` | void | sql | invoker |
| `public.record_integration_health(text, text, int4, text, jsonb)` | void | sql | invoker |
| `public.run_scheduled_job(text, text, jsonb)` | void | sql | invoker |
| `public.set_app_setting(text, jsonb, text, uuid)` | void | sql | invoker |

## O. Realtime and scheduled jobs

| Function | Returns | Lang | Security |
|---|---|---|---|
| `public.expire_handoff_codes()` | void | sql | invoker |
| `public.mark_overdue_pickups(int4)` | void | sql | invoker |
| `public.run_due_jobs()` | void | sql | invoker |

