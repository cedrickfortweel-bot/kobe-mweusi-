# End-to-end journey simulation

What actually happens when a person signs up as a buyer, and when one
signs up as a seller. Every step below is traced against the code and
the migrations, not against what the screens suggest.

The business objective: **a buyer pays into escrow, the seller delivers,
and the money only moves when the handover is proven.** The platform's
value is that the money is safe while it is in between, so every step
that touches money is a server decision.

Legend: **WORKS** — wired to the backend and correct. **REFUSES** — the
app correctly declines and says so. **BLOCKED** — cannot complete until
the payment provider is connected.

---

## The buyer journey

### 1. Sign up

`handle_new_user()` fires on `auth.users` and creates the profile **and
the wallet row**, so the account has a Wallet ID from the first second.

```
KMB-2291-MILK
```

Four digits and a real English word, so it can be read out loud at a
hub. **WORKS.**

A wallet failure inside the trigger is caught, so it can never block the
registration. Accounts that registered earlier are given a Wallet ID by
the same migration.

### 2. Land on the buyer app

The wallet summary returns the balance, the held escrow, the Wallet ID
and whether the sandbox is on. The Wallet ID appears in **two** places:
the wallet card and account settings.

**WORKS.**

### 3. Top up the wallet

`payments` → `request_wallet_topup()` creates the intent, and the
provider would take the money.

**REFUSES** — the provider is not connected, so the app says:

> Mobile money top-up is not connected yet. Top-ups are being connected.
> No money has been taken and your balance has not changed.

That is the honest answer. A sandbox credit is offered instead, but only
while the provider is configured for the sandbox, and the button is
hidden when it is not.

**BLOCKED** for real money.

### 4. Find a seller

The live list comes from `listPublicLiveSessions()`, so it is the
platform's own data, not the browser's local storage. The seller
directory comes from the `seller` function.

A seller's public page now has a **Shop tab** that lists that seller's
active products, each with its own **Buy safely** button.

**WORKS.**

### 5. Buy

The buyer taps **Buy safely**. The product travels with the request:

```
KobeApi.createOrder({ product_id, quantity: 1, source, live_session_id })
```

The client never sends an amount. The server:

1. reads the price from `products.price_tzs`
2. applies the 1% fee
3. checks the buyer's **released wallet balance** under an advisory lock
4. debits the wallet and funds the escrow
5. reserves stock
6. creates the order as `in_escrow`

If the balance is short, the order is rolled back completely — stock
returned, order cancelled — and the buyer is told the exact shortfall
and sent to the top-up screen.

**WORKS**, and the money is never decided by the browser.

### 6. The seller is told

The order appears in the seller's list, the activity feed records it, and
the seller gets a push notification: *"A buyer ordered X for TSh Y. The
money is held in escrow."*

**WORKS.**

### 7. The handover

The seller taps **Handoff code** and the server issues **two** single-use
codes: the seller's and the buyer's.

| Who scans what | What it means | What happens |
|---|---|---|
| Buyer scans the **seller's** code | the buyer has engaged | the three-hour window starts, shown as a countdown on the tracking card |
| Seller scans the **buyer's** code | the goods were handed over | **the escrow is released immediately** |
| Agent scans the **buyer's** code | the goods reached the hub | **the escrow is released immediately** |

The scan is consumed atomically, so two phones racing cannot both win.
The release happens inside the same transaction as the scan.

**WORKS.**

### 8. Confirm

The buyer can tap **I received it** at any time and the escrow releases
immediately, without waiting for the window.

**WORKS.**

### 9. After the release

The seller is credited `subtotal` minus their 1% fee. The buyer's wallet
shows the amount as spent. The platform fee is recorded separately, so
revenue is never confused with a customer's balance.

The buyer can review, chat, or open a dispute. A dispute **freezes** the
escrow: `open_dispute()` places a hold, and the release is refused while
it is open.

**WORKS.**

---

## The seller journey

### 1. Sign up

The profile, the wallet, the `seller_profiles` row and the **Kobe ID**
are all created.

```
KOBE123XL
```

Three digits, so there is room for a national platform. IDs already in
circulation keep their two-digit shape, so printed QR codes and public
links keep working.

**WORKS.**

### 2. Shop details

`saveShopDetails()` saves the name, description, region, opening hours,
delivery details, logo and cover.

A **verified** seller's details are locked, because they were part of
what the review checked. The app says so plainly rather than letting the
save fail silently.

**WORKS.**

### 3. Verification

The seller uploads documents to a private bucket and submits. The status
goes `pending` → `under review` → `approved` or `rejected`. A rejection
must carry a reason. The seller cannot set their own badge, and the
reviewer's reads of the documents are logged.

**WORKS.**

### 4. The catalogue

`saveSellerProduct()` creates and edits products, with the photo uploaded
to storage and only the path stored. Stock is decremented by the server
when an order is created, not by the app.

**WORKS.**

### 5. Live Business

The seller starts a session with a title, a link and featured products.
The session is a real `live_sessions` row with `live_session_products`,
so the buyer's live list shows it. The seller's live caption says *"search
seller ID KOBE123XL"*, and that ID now resolves.

**WORKS.**

### 6. A buyer orders

The order appears in the seller's list, with the buyer's name, the
amount, the fee and the net.

**WORKS.**

### 7. The handover

The seller shows the QR, or scans the buyer's. Either path is recorded,
and scanning the buyer's code releases the money there and then.

**WORKS.**

### 8. Withdraw

`request_seller_payout()` creates the request. The amount is checked
against the **released** balance, so escrow money cannot be withdrawn.
One request at a time. Staff approve from the admin console's payout
queue, and the approval debits the ledger once.

**BLOCKED** for the actual transfer — the mobile-money payout needs the
provider. The request, the approval and the ledger are all real.

---

## Where the flow still stops

| Step | State | What is needed |
|---|---|---|
| Buyer top-up | REFUSES honestly | the AzamPay account and webhook |
| Seller payout transfer | BLOCKED | the AzamPay payout call |
| Everything else | WORKS | — |

Both are the same missing piece: **the payment provider**. Until it is
connected, the wallet can only be funded with a sandbox credit, so the
flow can be walked end to end but cannot move real money.

## The rules that are enforced in the database, not in the app

* The client never states a price. The server reads it from the product.
* A buyer can only withdraw money that has been **released**; escrow
  money has never entered their balance.
* A seller can only withdraw money that has been **released**; the
  balance check is against the ledger, not a number in the app.
* The ledger is append-only. A correction is an adjustment, with a
  reason and an approval.
* A scan is consumed once. A replay cannot release twice.
* A dispute freezes the escrow, and the timer cannot override it.
* The server owns the clock. The countdown is a display.
* The client cannot change its own account type to become a seller.
* A seller cannot list buyer Wallet IDs.
