# Escrow release rules

This is the specification for when buyer money leaves escrow and reaches
the seller. It is the single most sensitive rule set in Kobe Mweusi, so
it is written out in full here and implemented in exactly one place:
`supabase/migrations/20261020106000_module_g_orders_delivery_handoff_escrow_release.sql`
and `supabase/migrations/20261020118000_buyer_qr_fast_release.sql`.

## 0. Where the money comes from

The buyer tops up the Kobe Mweusi wallet through the payment provider
(AzamPay). The money then sits in the wallet. A purchase moves it from
the wallet into escrow.

```
    top up (AzamPay)  ->  wallet balance  ->  escrow  ->  seller
```

The provider is only involved at the top-up step. A purchase never
leaves the platform's own wallet, which is what makes the escrow
guarantee meaningful: the money is already here when the buyer commits.

The two steps are separate functions and separate ledger entries:

| Step | Function | Ledger entry |
|---|---|---|
| top up | `record_wallet_topup()` | `top_up` +amount |
| buy | `place_funds_in_escrow()` | `order_funding` −amount |
| release | `release_escrow()` | `escrow_release` +net to the seller |

The client never states a price. The server reads the price from
`products.price_tzs`, applies the fee, and checks the wallet balance
before it debits anything. A tampered client cannot change what is
charged.

## 1. The two codes and who scans them

Each order gets two codes, and they mean opposite things.

| Code | Scanned by | What it proves |
|---|---|---|
| the **seller's** code | the **buyer** | the buyer has engaged. This is the buyer's qualifying scan. It opens the three-hour window. |
| the **buyer's** code | the **seller**, or an **agent** assigned to the order | the goods were handed over. This releases the escrow immediately. |

An agent may scan either code. Internal staff may scan either code.

The direction matters: the buyer's code is the physical proof of
delivery, because the buyer handed it over with the parcel.

## 2. The outcomes

| # | Condition | Result |
|---|---|---|
| 1 | The buyer confirmed receipt | **release now** |
| 2 | **The buyer's code was scanned** (seller or agent) | **release now** |
| 3 | The buyer scanned the seller's code, and three hours have passed | **release now** |
| 4 | The buyer scanned the seller's code, three hours not yet up | no release, counting down |
| 5 | An open dispute, or an escrow hold | no release, ever |

Outcome 2 is the fast path, and it is the one that carries the handoff.
The buyer does not have to scan anything for the money to move: the
seller or the agent scans the buyer's code and the escrow is released in
the same transaction.

Outcome 3 is the fallback for the case where nobody scanned the buyer's
code at all, for example a parcel left at the door with no handover
scan. The buyer must have engaged first, so the money can never be
released to a seller while the buyer is still waiting for the parcel.

## 3. The clock belongs to the server

`release_scheduled_for` is written by PostgreSQL when the buyer's
qualifying scan is recorded. It is never computed from a phone's clock and
never accepted from a client.

The scheduled job `process_due_escrow_releases()` runs every two minutes
and, for each candidate order, calls `evaluate_escrow_release()`. That
function re-reads the order status, the escrow status, the dispute table
and the hold flag **at the moment of release**. A timer alone therefore
never releases money: the timer only makes the release *eligible*, and
the release still has to pass every other condition.

## 4. Ordering of checks in `evaluate_escrow_release()`

```
already released?        -> no, already done
escrow closed?           -> no, refunded / split / cancelled
escrow on hold?          -> no, a hold is active
order not in escrow?     -> no, wrong order status
open dispute?            -> no, frozen
buyer confirmed?         -> YES, release
the buyer's code scanned?-> YES, release
buyer scanned the seller -> waiting, count down
window elapsed?         -> YES, release
nothing recorded yet?    -> no, no handoff
```

## 5. The policy is configuration, not code

The rules live in the `escrow_policy` row of `app_settings`, so they can
be adjusted without a migration:

```json
{
  "release_window_minutes": 180,
  "buyer_qr_scan_releases_immediately": true,
  "buyer_confirmation_releases_immediately": true,
  "agent_scan_can_release": true,
  "dispute_blocks_release": true,
  "auto_release_enabled": true
}
```

Read it with `select public.get_escrow_policy();`

Every key above is read by the code:

| Key | Read by | Effect when false |
|---|---|---|
| `release_window_minutes` | `evaluate_escrow_release()` | the buyer's window is longer |
| `buyer_qr_scan_releases_immediately` | `evaluate_escrow_release()` | the fast path stops; only the timed path releases |
| `buyer_confirmation_releases_immediately` | `evaluate_escrow_release()` | an explicit buyer confirmation no longer releases at once |
| `agent_scan_can_release` | `evaluate_escrow_release()` | an agent scan records the handover but never moves the money |
| `auto_release_enabled` | `evaluate_escrow_release()` | the timed job never releases by itself |

`dispute_blocks_release` is enforced structurally rather than by a
switch: `open_dispute()` places an escrow hold, and a held escrow is
refused by `release_escrow()` itself, so the money cannot move while the
dispute is open whatever the policy says.

`agent_scan_can_release` is read by `evaluate_escrow_release()`, which
every release path funnels through, so one setting freezes or unfreezes
agent-driven releases for the whole platform.

## 6. What a scan does and does not do

A scan **does**:

* consume the one-time code (atomic claim, so two concurrent scans cannot both win)
* write a `handoff_events` audit row with who, when and which code
* advance `order_delivery_workflows`
* record which CODE was scanned, not just who scanned it
* open the release window, if the buyer scanned the seller's code
* release the escrow at once, if the buyer's code was scanned
* notify the counterparty

A scan of the **seller's** code does **not** move money. The buyer has
engaged, and the three-hour window starts.

## 6a. The wallet balance check

Before the buyer's money is debited into escrow, the balance is checked
and the debit happens under a lock:

```sql
perform pg_advisory_xact_lock(hashtextextended(v_order.buyer_id::text, 0));
v_available := public.wallet_available_balance(v_order.buyer_id);
if v_available < v_order.total_due_tzs then
  raise exception 'INSUFFICIENT_WALLET_BALANCE' ...;
end if;
```

The advisory lock serialises purchases from the same wallet, so two
concurrent buys cannot both pass the check and overdraw the wallet.

`wallet_available_balance()` is the sum of **every** ledger entry for the
buyer. An earlier version excluded `order_funding` entries, which are
debits, so the available balance came out *larger* than the real balance
and a buyer could have spent money that was already in escrow. That is
fixed.

When the balance is short, the order is not created: the stock is
returned and the order is cancelled, and the buyer is told the exact
shortfall so the app can open the top-up screen.

## 6b. The buyer fee

The buyer is charged `subtotal + buyer_fee`. The fee is platform
revenue, recorded in `platform_fees`. It is **not** credited back to the
buyer: doing so would make the net charge only the subtotal and the
platform fee would vanish.

## 7. Disputes freeze the escrow

`open_dispute()` calls `place_escrow_hold()`, which moves the escrow row
to `held`. A held escrow is refused by `release_escrow()` and by
`evaluate_escrow_release()`, so a dispute that is open at the moment the
timer expires still keeps the money frozen. The job skips the order and
records it as blocked.

`resolve_dispute()` records a decision. `execute_dispute_financial_outcome()`
performs the money movement, separately and audibly. A frontend update of
`disputes.status` never moves money by itself.

## 8. The two identities that matter

* **Seller Kobe ID** `KOBE12XL` — public seller identity, assigned once, permanent.
* **Buyer Wallet ID** `KMB-27-MAZI` — memorable wallet identifier, not a password,
  not a balance, not a payment credential.

A seller never sees a list of buyer Wallet IDs. `reveal_wallet_id()` only
returns a Wallet ID to that buyer, to staff, or to the seller of an order
with that buyer.

## 9. Handoff codes

A handoff code is an **unguessable bearer capability**, not encrypted
data. There is no key, and nothing to decrypt.

* It is `KMH1.` plus 122 bits of randomness.
* The server stores **only the SHA-256 hash**, so the plaintext exists
  only on the phone that is showing the code.
* The QR carries **no personal data and no order detail**. A photograph
  of it reveals nothing, and the server will refuse it for anyone who is
  not entitled.

### It has no clock

A code is valid from the moment it is issued until:

* **it is scanned** — the scan consumes it, atomically, so two phones
  racing cannot both win
* **it is replaced** — a newer code was issued for the same order
* **the order closes** — the escrow was released, cancelled or refunded

A time limit was never the right instrument. A buyer showing their code
while an agent was delayed would have had it expire mid-handover, and the
scan would be refused, leaving the order stuck in escrow with nobody
able to release it. The order's own state is a better clock than a
timestamp, and the database enforces it.

### Every failure says what happened

The person holding the phone is usually a customer. They need to know
whether to try again or give up, so each case has its own wording and
its own machine-readable reason:

| Case | What they are told |
|---|---|
| The code is already scanned | "This code was already scanned. The handover is recorded and the payment has moved." |
| The seller already scanned the buyer's code, and now the buyer scans the seller's | "This handover is already done. The payment was released when the code was scanned." |
| A stranger scans it | "This is the seller's code. Only the buyer of this order can scan it." |
| The buyer's code, scanned by someone who is neither the seller nor an assigned agent | "This is the buyer's code. Only the seller of this order, or an assigned Kobe Mweusi agent, can scan it." |
| A newer code was issued | "This code was replaced by a newer one. Use the code on the screen." |
| The order is closed | "This order is closed, so there is no handover left to record." |
| It is not a Kobe code at all | "This code does not belong to any order." |

### Both receipts carry a real code

The buyer's receipt shows the code the **seller or agent** scans. The
seller's receipt shows the code the **buyer** scans. Both come from the
server.

Because the server keeps only a hash, it cannot hand a code back later.
So the receipt asks the server for the order's codes when it is opened,
which issues a fresh pair and retires the previous one. **Only the newest
code works**, so opening a receipt on one device can retire a code shown
on another. That is inherent to hashing, not a choice.

## 10. Seller withdrawals

A seller withdraws money that has **already been released from escrow**.

The rule is enforced by the ledger, not by the app. The seller's ledger
is credited only inside `release_escrow()`, so money that is still held
in escrow has never entered the seller's balance. `wallet_available_balance()`
is therefore exactly the money that has been released and is free to
withdraw, and `request_seller_payout()` refuses anything above it.

| Step | Function | Effect |
|---|---|---|
| seller asks to withdraw | `request_seller_payout()` | creates a `payout_requests` row, checks the released balance, computes the fee |
| staff approve | `approve_payout()` | debits the seller's ledger once, records the fee as platform revenue |

Rules:

- The seller enters the amount that **leaves the wallet**. The fee is a
  share of that same amount, computed on the server, and the seller
  receives the remainder. The fee is never debited a second time.
- **One outstanding request per seller.** Two requests could each pass
  the balance check and together exceed the balance.
- A second request while one is waiting is refused.
- Approving a payout twice does not pay twice.
- The money leaves the seller's ledger only when staff approve, not when
  the seller asks.

The withdraw screen shows **two separate figures**: what can be
withdrawn now, and what is still held in escrow. They are not the same
number and must never be shown as one.

The mobile-money transfer itself happens when the provider is connected.
Until then the request is real, tracked and visible to staff, and the
seller is told it will be sent once approved — it is not claimed to have
been sent.

## 11. Tests

`supabase/tests/escrow_release_test.sql` covers the outcome table above
and the payout rules against a real database. Run it after
`supabase db reset`:

```bash
supabase db reset
psql "$SUPABASE_DB_URL" -f supabase/tests/escrow_release_test.sql
```
