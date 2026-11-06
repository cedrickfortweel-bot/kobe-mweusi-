/* Kobe Mweusi — cross-layer flow verification.

   The SQL lint proves the migrations parse. This script proves the layers
   agree with each other: that every database function the Edge Functions
   call actually exists in the migrations, that the money path is wired
   the way the blueprint requires, and that the apps do not reach around
   the backend to move money.

   Usage:  node flow_check.js
*/

const fs = require("fs");
const path = require("path");

const root = __dirname;
const migrationsDir = path.join(root, "supabase", "migrations");
const functionsDir = path.join(root, "supabase", "functions");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(name + (detail ? " — " + detail : ""));
  }
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/* The files that ship to the browser. */
const appFiles = ["buyer.html", "seller.html", "admin.html", "agent.html", "kobe-supabase.js", "kobe-app-workflows.js"];

/* ------------------------------------- the API surface the apps rely on */

/* Every KobeApi method the apps call must exist on the API boundary. A
   missing method is a TypeError at the moment a customer taps a button,
   so it is checked here as well as in api_surface_check.js. */
const { apiMethodNames } = require("./js_shape.js");

const apiMethods = apiMethodNames([readFileSafe(path.join(root, "kobe-supabase.js"))]);

let apiSurfaceOk = true;
const apiCallPattern = /KobeApi\.([a-zA-Z_$][\w$]*)/g;
for (const file of appFiles.concat(["kobe-app-workflows.js", "kobe-admin.js"])) {
  const source = readFileSafe(path.join(root, file));
  if (!source) continue;
  let m;
  const re = new RegExp(apiCallPattern.source, "g");
  while ((m = re.exec(source)) !== null) {
    if (!apiMethods.has(m[1])) {
      apiSurfaceOk = false;
      console.log(`      KobeApi.${m[1]} is called in ${file} but not defined by the API boundary`);
    }
  }
}

/* ------------------------------------------------------------------ SQL */
const migrationFiles = readDirSafe(migrationsDir)
  .filter((e) => e.isFile() && e.name.endsWith(".sql"))
  .map((e) => e.name)
  .sort();

const sql = migrationFiles.map((f) => readFileSafe(path.join(migrationsDir, f))).join("\n");

/* The set of public functions the migrations define. */
const definedFunctions = new Set();
const functionPattern =
  /create\s+(?:or\s+replace\s+)?function\s+(public\.[a-z_0-9]+)\s*\(([^)]*)\)/gi;
let match;
while ((match = functionPattern.exec(sql)) !== null) {
  definedFunctions.add(match[1].toLowerCase());
}

/* The set of public tables the migrations define. */
const definedTables = new Set();
const tablePattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?(public\.[a-z_0-9]+)/gi;
while ((match = tablePattern.exec(sql)) !== null) {
  definedTables.add(match[1].toLowerCase());
}

/* ------------------------------------------------------------------ TS */
const functionFiles = [];
(function walk(dir) {
  for (const entry of readDirSafe(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".ts")) functionFiles.push(full);
  }
})(functionsDir);

const functionSource = new Map();
for (const file of functionFiles) {
  functionSource.set(path.relative(root, file), readFileSafe(file));
}

/* Every rpc("name") call in the Edge Functions must resolve. */
const rpcPattern = /\.rpc\(\s*["']([a-z_0-9]+)["']/gi;
const knownRpcs = new Set([
  /* Supabase PostgREST built-ins, not application functions. */
  "rpc",
]);

for (const [rel, source] of functionSource) {
  let rpcMatch;
  const re = new RegExp(rpcPattern.source, "gi");
  while ((rpcMatch = re.exec(source)) !== null) {
    const name = rpcMatch[1].toLowerCase();
    knownRpcs.add(name);
    check(
      rel + " calls rpc(" + rpcMatch[1] + ")",
      definedFunctions.has("public." + name) || definedFunctions.has(name),
      "not defined in the migrations"
    );
  }
}

/* Every from("table") call must resolve to a table or a view. */
const fromPattern = /\.from\(\s*["']([a-z_0-9]+)["']/gi;
const viewPattern = /create\s+(?:or\s+replace\s+)?view\s+(public\.[a-z_0-9]+)/gi;
const definedViews = new Set();
while ((match = viewPattern.exec(sql)) !== null) {
  definedViews.add(match[1].toLowerCase());
}
for (const [rel, source] of functionSource) {
  let fromMatch;
  const re = new RegExp(fromPattern.source, "gi");
  while ((fromMatch = re.exec(source)) !== null) {
    const name = fromMatch[1].toLowerCase();
    if (name === "storage" || name === "auth") continue;
    check(
      rel + " reads " + fromMatch[1],
      definedTables.has("public." + name) || definedViews.has("public." + name),
      "no table or view with that name in the migrations"
    );
  }
}

/* ------------------------------------------------- the escrow money path */

/* The three events that can lead to a release. */
check(
  "the buyer scan opens the release window",
  /buyer_scanned_at/.test(sql) && /release_scheduled_for/.test(sql)
);
check(
  "the release window is three hours by default",
  /release_window_minutes['"]?\s*,\s*180/.test(sql)
);
check(
  "both scans trigger the fast release path",
  /both_scans/.test(sql)
);
check(
  "an explicit buyer confirmation releases immediately",
  /buyer_confirmed/.test(sql) && /buyer_confirmation_releases_immediately/.test(sql)
);
check(
  "an open dispute blocks the release",
  /open_dispute/.test(sql) && /dispute_blocks_release/.test(sql)
);
check(
  "an escrow hold blocks the release",
  /on_hold/.test(sql) && /place_escrow_hold/.test(sql)
);
check(
  "an agent scan alone does not release",
  /agent_scan_can_release['"]?\s*,\s*false/.test(sql)
);
check(
  "the release decision is separate from the money movement",
  definedFunctions.has("public.evaluate_escrow_release")
    && definedFunctions.has("public.release_escrow")
    && definedFunctions.has("public.release_escrow_funds")
);
check(
  "the timed job re-checks every condition before releasing",
  /process_due_escrow_releases/.test(sql) && /evaluate_escrow_release/.test(sql)
);

/* ------------------------------------------- capture and release are apart */
check(
  "capturing the buyer's money is its own function",
  definedFunctions.has("public.place_funds_in_escrow")
);
check(
  "paying the seller is its own function",
  definedFunctions.has("public.release_escrow")
);
check(
  "the provider callback captures rather than releases",
  /record_verified_payment/.test(sql)
);

/* --------------------------------------------------------- money safety */
check(
  "the wallet ledger is append-only",
  /block_ledger_mutation/.test(sql)
);
check(
  "the ledger carries a unique idempotency key",
  /idempotency_key\s+text\s+not\s+null\s+unique/.test(sql)
);
check(
  "money functions are revoked from anon and authenticated",
  /revoke all on function public\.(release_escrow|place_funds_in_escrow|post_ledger_transaction|approve_payout|approve_refund)/i.test(sql)
);
check(
  "no password or token column is stored in the application schema",
  !/create table[^;]*\b(password_hash|plain_password|access_token|refresh_token|otp)\b/i.test(sql)
);
check(
  "the ledger is never granted to authenticated",
  /revoke all on[^;]*wallet_ledger_entries[^;]*from anon, authenticated/i.test(sql)
);

/* ------------------------------------------------------- dispute safety */
check(
  "a dispute decision and the money movement are separate steps",
  definedFunctions.has("public.resolve_dispute")
    && definedFunctions.has("public.execute_dispute_financial_outcome")
);
check(
  "reopening a dispute needs an admin",
  /reopen_dispute/.test(sql) && /role = 'admin'/.test(sql)
);

/* --------------------------------------------------- handoff QR wiring */
const handoffSource = functionSource.get(path.join("supabase", "functions", "handoff", "index.ts")) || "";
check(
  "the handoff function delegates the scan rules to the database",
  /record_handoff_scan/.test(handoffSource)
);
check(
  "the handoff function issues codes through the database",
  /issue_handoff_codes/.test(handoffSource)
);
check(
  "the handoff function no longer trusts a client-supplied scan result",
  !/codeRow\.used_at/.test(handoffSource)
);

/* --------------------------------------------------- the wallet model --- */
/* The buyer tops up through the provider, the money sits in the wallet,
   and a purchase moves it from the wallet into escrow. */

check(
  "a wallet top-up is recorded as its own payment intent",
  definedFunctions.has("public.request_wallet_topup")
    && definedFunctions.has("public.record_wallet_topup")
);
check(
  "a top-up credits the wallet without touching escrow",
  /'top_up'/.test(sql)
);
check(
  "a purchase funds escrow from the wallet balance",
  /p_funding_source/.test(sql) && /'wallet'/.test(sql)
);
check(
  "the wallet balance is checked under a lock before the debit",
  /pg_advisory_xact_lock/.test(sql) && /INSUFFICIENT_WALLET_BALANCE/.test(sql)
);
check(
  "the buyer fee is platform revenue and is not credited back",
  !/buyer_fee_tzs\s*,\s*'fee'/.test(sql)
);
check(
  "held escrow is derived from the escrow ledger",
  /held_escrow[\s\S]{0,500}?from public\.escrow_transactions/.test(sql)
);
check(
  "an order carries its own idempotency key",
  /orders_idempotency_key_idx/.test(sql)
);

/* The client must never state a price. */
for (const app of appFiles) {
  const source = readFileSafe(path.join(root, app));
  if (!source) continue;
  check(
    app + " never sends an amount when creating an order",
    !/KobeApi\.createOrder\([\s\S]{0,300}?\bamount\s*:/i.test(source)
  );
  check(
    app + " never sends a fee when creating an order",
    !/KobeApi\.createOrder\([\s\S]{0,300}?\bfee\s*:/i.test(source)
  );
}

/* The buyer must reach the real backend, not a preview stub. */
const buyerAppSource = readFileSafe(path.join(root, "buyer.html"));
check("the buyer app creates a real order", /KobeApi\.createOrder/.test(buyerAppSource));
check("the buyer app tops up the wallet", /KobeApi\.topUp/.test(buyerAppSource));
check(
  "the buyer app confirms receipt through the server",
  /KobeApi\.confirmReceipt/.test(buyerAppSource)
);
check(
  "the buyer app reads the escrow timers from the server",
  /KobeApi\.escrowTimers/.test(buyerAppSource)
);
check(
  "the buyer app does not compute its own escrow countdown",
  !/3\s*\*\s*60\s*\*\s*60|180\s*\*\s*60/.test(buyerAppSource)
);
check(
  "no app calls a method the API boundary does not define",
  apiSurfaceOk
);

/* The buyer page ships a preview API as a demo fallback. The real
   boundary must REPLACE it, not merge into it: a merge lets a preview
   method and a real method collide, and which one answers depends on
   load order. */
const boundarySource = readFileSafe(path.join(root, "kobe-supabase.js"));
check(
  "the real boundary replaces the preview rather than merging into it",
  !/window\.KobeApi\s*=\s*Object\.assign\(window\.KobeApi/.test(boundarySource)
);
check(
  "the real boundary is installed on the page's own binding",
  /KobeApi\s*=\s*api/.test(boundarySource)
);
check(
  "the preview API has its own name so it cannot shadow the boundary",
  /const KobePreviewApi\s*=\s*\{/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the request guards are installed on the real boundary",
  /kobeWrapApi/.test(boundarySource) && /kobeWrapApi/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the guarded methods are the real ones",
  /API_GUARDED\s*=\s*\[[^\]]*createOrder/.test(readFileSafe(path.join(root, "buyer.html")))
    && /API_GUARDED\s*=\s*\[[^\]]*confirmReceipt/.test(readFileSafe(path.join(root, "buyer.html")))
);

/* ------------------------------------------------- escrow Edge Function */
const escrowSource = functionSource.get(path.join("supabase", "functions", "escrow", "index.ts")) || "";
check("the escrow Edge Function exists", escrowSource.length > 0);
check(
  "the escrow Edge Function exposes the release decision",
  /evaluate_escrow_release/.test(escrowSource)
);
check(
  "the escrow Edge Function exposes the buyer confirmation",
  /confirm_receipt/.test(escrowSource)
);

/* ------------------------------------------------ payments Edge Function */
const paymentsSource = functionSource.get(path.join("supabase", "functions", "payments", "index.ts")) || "";
check("the payments Edge Function exists", paymentsSource.length > 0);
check(
  "the provider callback verifies the signature before recording",
  /verifyProviderSignature/.test(paymentsSource)
    && paymentsSource.indexOf("verifyProviderSignature") < paymentsSource.indexOf("record_verified_payment")
);
check(
  "a replayed callback is answered without crediting twice",
  /duplicate/.test(paymentsSource)
);

/* ------------------------------------------------ the browser is not the bank */
for (const app of appFiles) {
  const source = readFileSafe(path.join(root, app));
  if (!source) continue;
  check(
    app + " never writes a ledger row",
    !/from\(\s*["']wallet_ledger_entries["']\s*\)\s*\.(insert|update|delete|upsert)/i.test(source)
  );
  check(
    app + " never writes a balance directly",
    !/from\(\s*["']wallets["']\s*\)\s*\.(update|upsert)/i.test(source)
  );
  /* A write is an assignment into the payload, or a column inside an
     inline object literal. A .eq() filter on the column is a read. */
  check(
    app + " never sets a dispute to resolved itself",
    !/payload\.status\s*=\s*["']resolved["']/.test(source)
      && !/update\(\s*\{[^}]*status\s*:\s*["']resolved["']/is.test(source)
  );
  check(
    app + " never sets a seller verification status itself",
    !/payload\.verification_status\s*=/.test(source)
      && !/update\(\s*\{[^}]*verification_status\s*:/is.test(source)
  );
}

/* ------------------------------------------------------- RLS coverage */
const rlsTables = new Set();
const rlsPattern = /alter table (public\.[a-z_0-9]+) enable row level security/gi;
while ((match = rlsPattern.exec(sql)) !== null) {
  rlsTables.add(match[1].toLowerCase());
}
const policyPattern = /create policy\s+\w+\s+on\s+(public\.[a-z_0-9]+)/gi;
const policyTables = new Set();
while ((match = policyPattern.exec(sql)) !== null) {
  policyTables.add(match[1].toLowerCase());
}
for (const table of policyTables) {
  check(
    table + " has row level security enabled",
    rlsTables.has(table),
    "a policy exists but RLS is not enabled"
  );
}

/* ----------------------------------------------- the app and the schema */
const buyerSource = readFileSafe(path.join(root, "buyer.html"));
const sellerSource = readFileSafe(path.join(root, "seller.html"));check(
  "the buyer app and the seller app exist",
  buyerSource.length > 0 && sellerSource.length > 0
);
check(
  "the escrow rules are documented next to the code",
  fs.existsSync(path.join(root, "docs", "escrow-release-rules.md"))
);
check(
  "the schema drift is documented",
  fs.existsSync(path.join(root, "docs", "live-schema-reconciliation.md"))
);

/* ------------------------------------------------------- the seller app */
const sellerAppSource = readFileSafe(path.join(root, "seller.html"));
check(
  "the seller app loads its orders from the server",
  /KobeApi\.listSellerOrders/.test(sellerAppSource)
);
check(
  "the seller app loads its catalogue from the server",
  /KobeApi\.sellerProducts/.test(sellerAppSource)
);
check(
  "the seller app saves catalogue items through the server",
  /KobeApi\.saveSellerProduct/.test(sellerAppSource)
);
check(
  "the seller app reads its verification state from the server",
  /KobeApi\.sellerVerification/.test(sellerAppSource)
);
check(
  "the seller app saves its shop details through the server",
  /KobeApi\.saveShopDetails/.test(sellerAppSource)
);
check(
  "the seller app creates live sessions on the server",
  /KobeApi\.saveSellerLiveSession/.test(sellerAppSource)
    && /KobeApi\.endLiveSession/.test(sellerAppSource)
);
check(
  "the seller app refreshes from the server on demand",
  /window\.kobeRefresh\s*=\s*async/.test(sellerAppSource)
);
check(
  "the seller app does not keep a local-only catalogue",
  !/prods\.push\(q\)/.test(sellerAppSource)
);
check(
  "the seller app no longer claims to save locally only",
  !/local preview only; not submitted or synced/.test(sellerAppSource)
);
check(
  "a seller whose account is verified is told the details are locked",
  /verification_status === 'verified'/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
);
check(
  "the buyer loads verified live sessions from the public server API",
  /KobeApi\.listPublicLiveSessions\(\)/.test(readFileSafe(path.join(root, "buyer.html")))
    && /sellerVerified===true/.test(readFileSafe(path.join(root, "buyer.html")))
    && /listPublicLiveSessions/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
);
check(
  "the seller app loads its disputes from the server",
  /KobeApi\.listDisputes/.test(sellerAppSource)
);
check(
  "the seller app sends dispute replies through the server",
  /KobeApi\.addDisputeMessage/.test(sellerAppSource)
);
check(
  "the seller app survives an order status it has no label for",
  /SL\[o\.s\]\|\|/.test(sellerAppSource)
);
check(
  "the seller app no longer keeps a local-only dispute list",
  !/disputes\.unshift\(\{field:/.test(sellerAppSource)
);
check(
  "a verified seller is told their shop details are locked",
  /details are locked/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
);

/* ---------------------------------------------------------- the payouts */
/* A seller withdraws money that has ALREADY been released from escrow.
   The rule is enforced by the ledger: the seller's ledger is credited
   only inside release_escrow(), so money still in escrow has never
   entered the seller's balance. */
check(
  "the seller's ledger is credited only when the escrow is released",
  /escrow_release[\s\S]{0,200}?v_order\.seller_id/.test(sql)
    && /post_ledger_transaction\(\s*v_order\.seller_id/.test(sql)
);
check(
  "a payout is limited to the released balance",
  /v_available := public\.wallet_available_balance\(p_seller_id\)/.test(sql)
    && /Requested amount exceeds the available balance/.test(sql)
);
check(
  "the available balance is the whole ledger, so escrow money is excluded",
  /wallet_available_balance[\s\S]{0,400}?where e\.user_id = p_user;\s*\$\$/.test(sql)
);
check(
  "a seller has one outstanding withdrawal at a time",
  /You already have a withdrawal waiting to be paid/.test(sql)
);
check(
  "the payout fee is computed on the server, not supplied by the client",
  /v_fee := round\(p_amount_tzs \* 0\.01\)/.test(sql)
);
check(
  "approving a payout debits the amount once",
  /-v_payout\.amount_tzs, 'withdrawal'/.test(sql)
);
check(
  "the seller app requests a real withdrawal",
  /KobeApi\.requestPayout/.test(sellerAppSource)
);
check(
  "the seller app verifies the transaction PIN before withdrawing",
  /KobeApi\.pinVerify/.test(sellerAppSource)
);
check(
  "the seller app shows available and held as separate figures",
  /id="wHeld"/.test(sellerAppSource)
);
check(
  "the seller app no longer refuses withdrawals outright",
  !/Withdrawal unavailable: no payment backend is connected/.test(sellerAppSource)
    && !/Withdrawals are disabled until the secure wallet API/.test(sellerAppSource)
);
check(
  "payout approval requires a second administrator",
  /action: 'request-payout-approval'/.test(readFileSafe(path.join(root, "kobe-admin.js")))
    && /action: 'approve-admin-request'/.test(readFileSafe(path.join(root, "kobe-admin.js")))
    && /separate administrator/.test(
      functionSource.get(path.join("supabase", "functions", "seller", "index.ts")) || ""
    )
);
check(
  "the payout queue is staff only",
  /requireStaffPermission\(request, auth, service, "payouts\.view"\)/.test(
    functionSource.get(path.join("supabase", "functions", "seller", "index.ts")) || ""
  )
);

/* ------------------------------------------------- the release fast path */
/* The BUYER's code being scanned releases the escrow at once, whoever
   scans it: the seller or an agent. The SELLER's code being scanned by
   the buyer opens the three-hour window. */
check(
  "the buyer's code being scanned is the fast release path",
  /buyer_code_scanned_at/.test(sql)
    && /buyer_qr_scanned/.test(sql)
);
check(
  "the seller's code being scanned opens the three-hour window",
  /seller_code_scanned_at/.test(sql)
    && /release_window_started_at/.test(sql)
);
check(
  "scanning the buyer's code releases at once, inside the scan",
  /record_handoff_scan[\s\S]{0,9000}?release_escrow_funds/.test(sql)
);
check(
  "the policy names the buyer's QR as the fast path",
  /buyer_qr_scan_releases_immediately/.test(sql)
);
check(
  "an agent scan releases the escrow too",
  /is_assigned_agent/.test(sql)
    && /buyer_code_scanned_role = v_role/.test(sql)
);
check(
  "the handoff function reports whether the money was released",
  /released:/.test(
    functionSource.get(path.join("supabase", "functions", "handoff", "index.ts")) || ""
  )
);

/* ------------------------------------------------------------- the ids */
/* Three identifiers, three different jobs. The customer-facing ones are
   the canonical Seller Kobe ID (KOBE12XL) and the buyer Wallet ID
   (KMB-27-MAZI). The older app-facing seller id still resolves. */
check(
  "the canonical Seller Kobe ID can be resolved from either format",
  /public_seller_identity_by_kid/.test(sql)
);
check(
  "the seller directory serves the canonical Seller Kobe ID",
  /kobe_id_registry\(kobe_id\)/.test(
    functionSource.get(path.join("supabase", "functions", "seller", "index.ts")) || ""
  )
);
check(
  "the live sessions carry the canonical Seller Kobe ID",
  /kobe_id_registry/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
);
check(
  "the buyer app shows the buyer's own Wallet ID",
  /id="wId"/.test(readFileSafe(path.join(root, "buyer.html")))
    && /KobeApi\.myWalletId\(\)/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the escrow wallet endpoint resolves the verified user's wallet",
  /service\.rpc\("ensure_wallet_for",\s*\{\s*p_user:\s*auth\.user\.id/.test(
    readFileSafe(path.join(root, "supabase", "functions", "escrow", "index.ts"))
  )
);
check(
  "the buyer Wallet ID lookup surfaces backend failures",
  /async myWalletId\(\)\s*\{\s*const res = await invoke\('escrow', \{ action: 'wallet' \}\);/.test(
    readFileSafe(path.join(root, "kobe-supabase.js"))
  )
);
check(
  "the buyer app displays the Wallet ID on the home and account screens",
  /walletEl\.textContent = walletId/.test(readFileSafe(path.join(root, "buyer.html")))
    && /homeWalletEl\.textContent = walletId/.test(readFileSafe(path.join(root, "buyer.html")))
    && /KobeApi\.walletSummary\(\)/.test(readFileSafe(path.join(root, "buyer.html")))
    && /Promise\.allSettled\(\s*\[\s*profileRequest,\s*walletRequest,\s*createdAtRequest/.test(readFileSafe(path.join(root, "buyer.html")))
    && /async function resolveBuyerWalletId\(summary\)/.test(readFileSafe(path.join(root, "buyer.html")))
    && /const value\s*=\s*await resolveBuyerWalletId\(summary\)/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the buyer account creation date falls back to trusted auth user data",
  /getMyAccountCreatedAt\(\)/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
    && /created_at:\s*data\.created_at\s*\|\|\s*auth\.user\.created_at/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
    && /createdAtResult\.status\s*===\s*'fulfilled'/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the wallet summary returns the Wallet ID to its owner",
  /ensure_wallet_for/.test(functionSource.get(path.join("supabase", "functions", "wallet", "index.ts")) || "")
    && /wallet_id: wallet\?\.wallet_id/.test(functionSource.get(path.join("supabase", "functions", "wallet", "index.ts")) || "")
);
check(
  "buyer checkout ensures a wallet exists before checking its balance",
  /ensure_wallet_for/.test(functionSource.get(path.join("supabase", "functions", "orders", "index.ts")) || "")
    && /wallet_available_balance/.test(functionSource.get(path.join("supabase", "functions", "orders", "index.ts")) || "")
);
check(
  "the buyer app shows the seller's Seller ID on the seller page",
  /id="sp-kid"/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "a buyer can copy the Seller ID",
  /function copySellerKid\(/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the live search accepts either seller ID format",
  /sellerKidApp/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the seller app shows its own Seller ID",
  /store\.kid/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "a buyer cannot list every buyer's Wallet ID",
  /reveal_wallet_id/.test(sql)
);

/* The two identifiers on the account screens. */
check(
  "the buyer's account settings show the Wallet ID",
  /id="accountWalletId"/.test(readFileSafe(path.join(root, "buyer.html")))
    && /KobeApi\.myWalletId\(\)/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the seller's account settings show the Seller ID",
  /id="setKid"/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "the seller's account settings can copy the Seller ID",
  /function copySellerKid\(/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "the Wallet ID letters are pronounceable, not random",
  /consonant, vowel, consonant, vowel/i.test(sql)
    && /v_consonants/.test(sql)
);
check(
  "the Wallet ID keeps the two-number, four-letter shape",
  /KMB-' \|\| lpad\(v_segment/.test(sql)
);
check(
  "the Seller ID keeps the two-number, two-letter shape",
  /'KOBE' \|\| lpad\(v_segment/.test(sql)
);

/* The generators are redefined over time, so the check has to look at the
   last definition, not the first. The body ends at the dollar-quote close
   that terminates it, so the slice is bounded there. */
function lastFunctionBody(name) {
  const re = new RegExp("create or replace function " + name + "\\(", "g");
  let m;
  let at = -1;
  while ((m = re.exec(sql)) !== null) at = m.index;
  if (at < 0) return "";
  const end = sql.indexOf("$$;", at);
  return end < 0 ? sql.slice(at, at + 3000) : sql.slice(at, end + 3);
}
const walletIdGenerator = lastFunctionBody("public.generate_wallet_id");
const kobeIdGenerator = lastFunctionBody("public.assign_registry_kobe_id");

check(
  "the Wallet ID is a real word, so it can be read out loud",
  /v_words constant text\[\] := array\[/.test(walletIdGenerator)
    && /'KMB-' \|\| v_digits \|\| '-' \|\| v_words\[/.test(walletIdGenerator)
);
check(
  "the Wallet ID is four digits and one four-letter word",
  /1000 \+ floor\(random\(\) \* 9000\)/.test(walletIdGenerator)
    && /v_words constant text\[\]/.test(walletIdGenerator)
);
check(
  "the word list has no words that sound alike",
  (() => {
    const list = /v_words constant text\[\] := array\[([\s\S]*?)\];/.exec(walletIdGenerator);
    if (!list) return false;
    const words = [...list[1].matchAll(/'([A-Z]{4})'/g)].map((m) => m[1]);
    if (words.length < 50) return false;
    /* Every word must be four letters, and no two may share their first
       three letters, which is where spoken confusion starts. */
    if (words.some((w) => w.length !== 4)) return false;
    const prefixes = new Set(words.map((w) => w.slice(0, 3)));
    return prefixes.size === words.length;
  })()
);
check(
  "the Wallet ID constraint keeps the short IDs working",
  /\^KMB-\[0-9\]\{2,4\}-\[A-Z\]\{4\}\$/.test(sql)
);
check(
  "the generator can never hang if the word space fills",
  /fall back to the consonant-vowel form/i.test(walletIdGenerator)
);
check(
  "the Seller ID generator now uses three digits",
  /v_segment := 100 \+ floor\(random\(\) \* 900\)/.test(kobeIdGenerator)
);
check(
  "the Seller ID constraint accepts the old and the new shape",
  /\^KOBE\[0-9\]\{2,3\}\[A-Z\]\{2\}\$/.test(sql)
);
check(
  "the Seller ID lookup is two index hits, not a join with an OR",
  !/where r\.kobe_id = v_kid\s*\n\s*or s\.kobe_id = v_kid/.test(
    lastFunctionBody("public.public_seller_identity_by_kid")
  )
);
check(
  "an ID that is not assigned is never shown as a real one",
  !/'KOBE00'/.test(readFileSafe(path.join(root, "buyer.html")))
);

/* A buyer sees their Wallet ID on the first screen after signing up. */
const signupTrigger = lastFunctionBody("public.handle_new_user");
check(
  "the sign-up trigger creates the wallet row",
  /insert into public\.wallets/.test(signupTrigger)
);
check(
  "a wallet failure can never block the registration",
  /exception when others then[\s\S]{0,200}?null;/.test(signupTrigger)
);
check(
  "the buyer loads the wallet summary from the backend",
  /walletSummary\(\)/.test(readFileSafe(path.join(root, "buyer.html")))
    && /window\.kobeRefresh\s*=\s*async/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "a wallet load problem stays in the wallet UI instead of showing a page-level retry banner",
  /walletSummaryFailed=true/.test(readFileSafe(path.join(root, "buyer.html")))
    && /walletId\.textContent='Unavailable'/.test(readFileSafe(path.join(root, "buyer.html")))
    && !/window\.kobeError\(error&&error\.message\|\|'Your wallet could not be loaded\./.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "wallet errors are surfaced instead of leaving a false zero balance",
  /window\.kobeError\(error&&error\.message/.test(readFileSafe(path.join(root, "buyer.html")))
    && /Your wallet could not be loaded/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "global error messages are dismissible and preserve their request error on retry",
  /aria-label="Dismiss error message"/.test(readFileSafe(path.join(root, "buyer.html")))
    && /window\.kobeErrorDismiss=/.test(readFileSafe(path.join(root, "buyer.html")))
    && /message!==dismissedError/.test(readFileSafe(path.join(root, "buyer.html")))
    && /aria-label="Dismiss error message"/.test(readFileSafe(path.join(root, "seller.html")))
    && /function kErrDismiss\(\)/.test(readFileSafe(path.join(root, "seller.html")))
    && /message!==kErrDismissed/.test(readFileSafe(path.join(root, "seller.html")))
    && /e\.userMessage\|\|e\.message/.test(readFileSafe(path.join(root, "buyer.html")))
    && /e\.userMessage\|\|e\.message/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "accounts that signed up earlier are given a Wallet ID too",
  /Created % missing wallet rows/.test(sql)
);

/* ------------------------------------------------- the purchase journey */
/* A buyer must buy the product the screen is showing, from the seller
   the screen is showing. */
check(
  "the buyer's seller page lists the seller's products",
  /id="sp-shop-list"/.test(readFileSafe(path.join(root, "buyer.html")))
    && /listPublicProducts/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "each product on the seller's page has its own buy button",
  /openBuySafely\(\\'/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the buy flow uses the product it was given, not the last one browsed",
  /const productId = buyProductId \|\| '';/.test(
    readFileSafe(path.join(root, "buyer.html"))
  )
);
check(
  "the live path records which seller is being bought from",
  /currentSellerKid=session\.sellerKid/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "a live product is only used for the seller it belongs to",
  /activeBuyerLiveSession\.sellerKid === currentSellerKid/.test(
    readFileSafe(path.join(root, "buyer.html"))
  )
);
check(
  "the home banner does not open a buy screen with no product",
  !/function showBuyIntro\(\)\{ openBuySafely\(\); \}/.test(
    readFileSafe(path.join(root, "buyer.html"))
  )
);

/* ------------------------------------------------- the sandbox credit */
/* It creates money, so it must be impossible outside the sandbox. */
check(
  "the sandbox credit is refused unless the provider is in the sandbox",
  /environment = 'sandbox'/.test(sql)
);
check(
  "the sandbox credit is capped",
  /p_amount_tzs > 1000000/.test(sql)
);
check(
  "the sandbox credit is a real ledger entry",
  /'top_up'/.test(lastFunctionBody("public.sandbox_wallet_credit"))
);
check(
  "the test-credit button is hidden unless the server says the sandbox is on",
  /sandbox_available/.test(
    functionSource.get(path.join("supabase", "functions", "wallet", "index.ts")) || ""
  )
    && /summary\.sandbox_available===true/.test(readFileSafe(path.join(root, "buyer.html")))
    && /sandboxTopUp/.test(readFileSafe(path.join(root, "buyer.html")))
);

/* ------------------------------------------------- the release message */
check(
  "the agent scan distinguishes a release from a scheduled release",
  /heading\.textContent = res\.released/.test(readFileSafe(path.join(root, "agent.html")))
    && /res\.release_scheduled_for/.test(readFileSafe(path.join(root, "agent.html")))
);

/* ------------------------------------------------- the notification flow */
/* The bell used to be a localStorage array, so a notification that
   arrived while the app was closed was lost. */
check(
  "an activity event is projected into a notification",
  /insert into public\.notifications/.test(
    lastFunctionBody("public.project_activity_event")
  )
);
check(
  "the projection creates one delivery record per channel",
  /insert into public\.notification_deliveries/.test(
    lastFunctionBody("public.project_activity_event")
  )
);
check(
  "the projection is driven by the activity event",
  /create trigger activity_events_project[\s\S]{0,120}after insert on public\.activity_events/.test(sql)
);
check(
  "the rules are data, so the copy and the channels can be changed",
  /create table if not exists public\.notification_rules/.test(sql)
);
check(
  "money reaches every channel, including email",
  /'money'[\s\S]{0,200}?array\['in_app','push','email','sms'\]/.test(sql)
);
check(
  "a chat message never sends an email",
  /\('message_received'[\s\S]{0,300}?array\['in_app','push'\]/.test(sql)
    && !/\('message_received'[\s\S]{0,300}?'email'/.test(sql)
);
check(
  "the user's own channel switches are honoured",
  /v_settings\.push_enabled/.test(lastFunctionBody("public.project_activity_event"))
    && /v_settings\.email_enabled/.test(lastFunctionBody("public.project_activity_event"))
);
check(
  "the inbox is read from the server, not from local storage",
  /from\('my_notifications'\)/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
    && /KobeApi\.listNotifications\(60\)/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "a new notification arrives live",
  /table: 'notifications'/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
);
check(
  "marking the bell as read reaches the server",
  /kobeMarkServerNotificationsRead/.test(readFileSafe(path.join(root, "buyer.html")))
    && /mark_notification_read/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
    && /mark_all_notifications_read/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
);

/* --------------------------------------------------------- the email channel */
check(
  "the email provider key is an Edge Function secret, not a table column",
  !/api_key\s+text/.test(sql)
    && /RESEND_API_KEY/.test(
      functionSource.get(path.join("supabase", "functions", "notify", "index.ts")) || ""
    )
);
check(
  "an email is never sent to an unconfirmed address",
  /email_confirmed_at is not null/.test(sql)
);
check(
  "every email uses one template",
  /render_notification_email/.test(sql)
);
check(
  "the worker claims deliveries without taking the same one twice",
  /for update skip locked/.test(sql)
);
check(
  "a failed delivery is retried and then given up on",
  /attempts < d\.max_attempts/.test(sql)
);

/* ------------------------------------------ the phone and the email */
/* The phone number is only trusted once it is confirmed, and an
   unconfirmed number must never reach another party. */
check(
  "a profile records when the phone was confirmed",
  /phone_verified_at/.test(sql)
);
check(
  "an unconfirmed phone is not shown to the other party",
  /phone_verified_at \? row\.buyer_profile\?\.phone_e164/.test(
    functionSource.get(path.join("supabase", "functions", "orders", "index.ts")) || ""
  )
);
check(
  "the confirmation is recorded from Auth's own state, not the browser's",
  /phone_confirmed_at/.test(
    functionSource.get(path.join("supabase", "functions", "security", "index.ts")) || ""
  )
);

/* A hard bounce must not be retried, and the address must not be used
   again. */
check(
  "a permanent email failure is told from a temporary one",
  /response\.status >= 400 && response\.status < 500 && response\.status !== 429/.test(
    functionSource.get(path.join("supabase", "functions", "notify", "index.ts")) || ""
  )
);
check(
  "a permanent failure suppresses the address",
  /suppress_email/.test(
    functionSource.get(path.join("supabase", "functions", "notify", "index.ts")) || ""
  )
);
check(
  "a suppressed address is never mailed again",
  /email_suppressions/.test(lastFunctionBody("public.email_address_for"))
);

/* The unsubscribe link. */
check(
  "every email carries an unsubscribe link",
  /unsubscribe_url/.test(lastFunctionBody("public.render_notification_email"))
);
check(
  "the unsubscribe link uses a token, not a guessable id",
  /notification_unsubscribe_tokens/.test(sql)
);
check(
  "the unsubscribe works without signing in",
  /grant execute on function public\.consume_unsubscribe_token\(uuid\) to anon/.test(sql)
);
check(
  "unsubscribing turns the email preference off",
  /on conflict \(user_id, category\) do update set email = false/.test(sql)
);
check(
  "there is a page for the unsubscribe link to land on",
  fs.existsSync(path.join(root, "unsubscribe.html"))
);

/* ------------------------------------------------------- the QR and avatar */
/* The QR carries a brand mark, and it has to stay scannable. */
check(
  "the QR draws the brand mark",
  /KobeQr\.turtle|turtle\s*\(/.test(readFileSafe(path.join(root, "kobe-qr.js")))
);
check(
  "the QR uses the highest error correction",
  /qrcode\(0,\s*'H'\)/.test(readFileSafe(path.join(root, "kobe-qr.js")))
);
check(
  "the QR mark can be turned off for a plain code",
  /opts\.logo === false/.test(readFileSafe(path.join(root, "kobe-qr.js")))
);

/* The avatar must follow the account, not live in one browser. */
check(
  "the avatar is uploaded to storage, not kept in the browser",
  /storage\.from\('profile-avatars'\)\.upload/.test(
    readFileSafe(path.join(root, "kobe-supabase.js"))
  )
);
check(
  "the stored avatar path is saved on the profile",
  /avatar_path/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
    && /grant update \(display_name, phone_e164, avatar_path\)/.test(sql)
);
check(
  "the avatar loads from the server, with the local copy only as a cache",
  /KobeApi\.avatarUrl/.test(readFileSafe(path.join(root, "buyer.html")))
);

/* ------------------------------------------------- the handoff receipts */
/* Both parties get a receipt, and each receipt carries the code the
   OTHER party scans. The codes come from the server, because the server
   keeps only a hash and cannot hand one back later. */
check(
  "the buyer's receipt asks the server for the buyer's code",
  /handoffIssue/.test(readFileSafe(path.join(root, "buyer.html")))
    && /res\.buyer_code/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the seller's receipt asks the server for the seller's code",
  /handoffIssue/.test(readFileSafe(path.join(root, "seller.html")))
    && /res\.seller_code/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "no receipt renders a locally computed code",
  !/function scode\(/.test(readFileSafe(path.join(root, "seller.html")))
    && !/function qrSvg\(/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "a code is only issued while the money is in escrow",
  /o\.s!=='In escrow'/.test(readFileSafe(path.join(root, "seller.html")))
    && /status !== 'In escrow'/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "a handoff code is single use and bounded in time",
  /used_at is null/.test(sql)
    && /expire_handoff_codes/.test(sql)
);
check(
  "a handoff code is not on a clock at all",
  /CODE_LIFETIME_MS = 0/.test(
    functionSource.get(path.join("supabase", "functions", "handoff", "index.ts")) || ""
  )
);
check(
  "the handoff screen tells the truth about when money is released",
  !/Scanning alone never releases funds/.test(readFileSafe(path.join(root, "buyer.html")))
);

/* ------------------------------------------- the code lifetime and words */
/* A handoff code has no clock. It dies when it is scanned, when it is
   replaced, or when the order closes. */
check(
  "a handoff code has no time limit",
  /alter column expires_at drop not null/.test(sql)
    && /CODE_LIFETIME_MS = 0/.test(
      functionSource.get(path.join("supabase", "functions", "handoff", "index.ts")) || ""
    )
);
check(
  "a code with no expiry is still honoured as a live code",
  /expires_at is not null and v_code\.expires_at <= now\(\)/.test(sql)
);
check(
  "the expiry job leaves a code with no clock alone",
  /expire_handoff_codes/.test(sql)
    /* A NULL expiry compares as NULL, so "<= now()" never matches it. */
    && /expires_at <= now\(\)/.test(sql)
);

/* Every way a scan can fail says what happened. */
for (const [label, pattern] of [
  ["already scanned", /This code was already scanned/],
  ["the handover is already done", /This handover is already done/],
  ["the code was replaced", /This code was replaced by a newer one/],
  ["the wrong person scanned", /Only the buyer of this order can scan it/],
  ["the agent-only case", /or an assigned Kobe Mweusi agent, can scan it/],
]) {
  check("the scan failure says: " + label, pattern.test(sql));
}
check(
  "the app shows the server's message, not a generic one",
  /check\.error \|\| check\.reason/.test(readFileSafe(path.join(root, "buyer.html")))
    && /if \(payload && payload\.error\) message = payload\.error/.test(
      readFileSafe(path.join(root, "kobe-supabase.js"))
    )
);
check(
  "the failure carries a machine-readable reason",
  /reason: api\.reason \|\| null/.test(
    functionSource.get(path.join("supabase", "functions", "handoff", "index.ts")) || ""
  )
);

/* --------------------------------------------------------- the PIN and the
   password. The PIN is what protects a withdrawal, so it has to be
   enforced by the server rather than by the page. */
const securityFn = functionSource.get(path.join("supabase", "functions", "security", "index.ts")) || "";
const apiBoundary = readFileSafe(path.join(root, "kobe-supabase.js"));

check(
  "the action the page sends is one the server handles",
  /action: 'set-pin'/.test(apiBoundary)
    && /action === "set-pin"/.test(securityFn)
);
check(
  "PIN status errors are not mistaken for an unset PIN",
  /async pinStatus\(\)\s*\{\s*return invoke\('security', \{ action: 'pin-status' \}\);/.test(apiBoundary)
    && /function populateBuyerPinSettings\(\)/.test(readFileSafe(path.join(root, "buyer.html")))
    && /secSt\.pinLoaded=false/.test(readFileSafe(path.join(root, "seller.html")))
    && /if\(!st\|\|st\.ok===false\)throw/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "buyer transaction PIN changes require the current PIN and confirmation",
  /pinStatus\.hasPin && !cur/.test(readFileSafe(path.join(root, "buyer.html")))
    && /nw !== confirmPin/.test(readFileSafe(path.join(root, "buyer.html")))
    && /id="tpconfirm"/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "buyer payment settings report real wallet status instead of a hardcoded ready state",
  /populatePaymentWalletStatus\(\)/.test(readFileSafe(path.join(root, "buyer.html")))
    && /KobeApi\.walletSummary\(\)/.test(readFileSafe(path.join(root, "buyer.html")))
    && !/Kobe Mweusi Wallet<\/span><\/div><div class="sr-right">Active/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "a PIN check goes through the locked path, not the raw one",
  /check_transaction_pin/.test(securityFn)
    && !/action === "pin-verify"[\s\S]{0,400}?verify_transaction_pin/.test(securityFn)
);
check(
  "a PIN guess is rate limited",
  /security_pin_verify/.test(securityFn)
);
check(
  "the database rejects a malformed or weak PIN",
  /pin_rejection_reason/.test(sql)
    && /pin_is_acceptable/.test(sql)
);
check(
  "setting and changing a PIN is one operation",
  /change_transaction_pin/.test(sql)
    && /change_transaction_pin/.test(securityFn)
);
check(
  "a wrong current PIN counts towards the lockout",
  /record_failed_pin_attempt/.test(
    /create or replace function public\.change_transaction_pin[\s\S]{0,3000}/.exec(sql)
      ? /create or replace function public\.change_transaction_pin[\s\S]{0,3000}/.exec(sql)[0]
      : ""
  )
);
check(
  "the failure counter decays, as the comment claims",
  /last_attempt_at/.test(sql)
    && /now\(\) - interval '15 minutes'/.test(sql)
);
check(
  "the seller no longer keeps the PIN in the page",
  !/let secSt=\{pin:false,bio:false,bad:0,lock:0\}/.test(readFileSafe(path.join(root, "seller.html")))
    && !/_pin=o\.a;/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "the seller's PIN state comes from the server",
  /secRefresh/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "the buyer's password change goes through the rate limited server path",
  /KobeApi\.passwordChange\(/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "a forgotten PIN needs the password and a phone the server can see was confirmed",
  /action === "pin-reset"/.test(securityFn)
    && /phone_confirmed_at/.test(securityFn)
    && /signInWithPassword/.test(securityFn)
);
check(
  "the withdrawal PIN check reports the lock",
  /pv\.reason==='locked'/.test(readFileSafe(path.join(root, "seller.html")))
);

/* ------------------------------------------------------------- the chat */
/* A thread is between one buyer and one seller. Both sides have to agree
   which is which, or a message lands in a thread the other side cannot
   find. And a seller must be able to answer a first inquiry, which
   happens before there is an order. */
const chatFn = functionSource.get(path.join("supabase", "functions", "chat", "index.ts")) || "";
const buyerApp = readFileSafe(path.join(root, "buyer.html"));
const sellerApp = readFileSafe(path.join(root, "seller.html"));

check(
  "the thread role is decided by the pair, not by the caller's account type",
  /resolveThread/.test(chatFn)
    && /withHasShop && !callerHasShop/.test(chatFn)
    && /callerHasShop && !withHasShop/.test(chatFn)
);
check(
  "a seller can reply in a conversation that already exists",
  /threadExists/.test(chatFn)
    && /!order && !existing/.test(chatFn)
);
check(
  "marking a conversation read cannot create one",
  /if \(!existing\) return json\(\{ ok: true, note: "No conversation to mark" \}\)/.test(chatFn)
);
check(
  "the thread list is not one query per thread",
  /\.or\(pairs\.join\(","\)\)/.test(chatFn)
);
check(
  "the message renderer reads the fields the server sends",
  /m\.body\s*!=\s*null\s*\?\s*m\.body/.test(buyerApp)
    && /m\.from\s*===\s*'me'\s*\?\s*'s'\s*:\s*'b'/.test(sellerApp)
    && /m\.from\s*===\s*'me'/.test(buyerApp)
);
check(
  "the seller passes the buyer's id when opening a conversation",
  /msgBuyer\(this\.dataset\.who, this\.dataset\.uid\)/.test(sellerApp)
    && /data-uid=/.test(sellerApp)
);
check(
  "no removed helper is still called",
  !/qrSvg\(/.test(sellerApp)
);
check(
  "the message is length checked and rate limited",
  /chat_send/.test(chatFn)
    && /text\.length < 1 \|\| text\.length > 5000/.test(chatFn)
);
check(
  "a Wallet ID collision can never hand money to the wrong person",
  /unique index if not exists wallets_user_idx/.test(sql)
    || /wallet_id text not null unique/.test(sql)
);

/* Seller capability is a seller_profiles row, not the account type: one
   account may be both a buyer and a seller.

   The check reads the LAST definition of each policy, because that is
   the one PostgreSQL keeps: an earlier migration may still contain the
   old text, and the replacement migration drops and recreates it. */
function lastPolicyText(policyName) {
  const re = new RegExp("create policy\\s+" + policyName + "\\b[\\s\\S]*?;", "gi");
  let m;
  let last = "";
  while ((m = re.exec(sql)) !== null) last = m[0];
  return last;
}

for (const policy of [
  "products_insert_own",
  "live_sessions_insert_own",
  "seller_kyc_insert_own_seller",
]) {
  check(
    policy + " no longer requires account_type = seller",
    !/account_type\s*=\s*'seller'/.test(lastPolicyText(policy)),
    "the last definition still gates on the account type"
  );
}
check(
  "seller capability is checked through seller_profiles",
  /exists \(\s*select 1 from public\.seller_profiles s/.test(sql)
);

/* ------------------------------------------------- the delivery agent hub

   The agent workspace used to be a local demo: its own password in the
   browser, scans in an array, and no request to the server at all. These
   checks keep it on the real backend. */
const agentHtml = readFileSafe(path.join(root, "agent.html"));
const agentFunction =
  functionSource.get(path.join("supabase", "functions", "agent", "index.ts")) || "";

check(
  "the agent page loads the real API boundary",
  /<script src="kobe-supabase\.js"><\/script>/.test(agentHtml)
    && /<script src="supabase-js\.js"><\/script>/.test(agentHtml)
);
check(
  "the agent page does not keep a password in the browser",
  !/kobe-agent-password/.test(agentHtml) && !/hashPassword/.test(agentHtml)
);
check(
  "the agent page signs in through the server",
  /agentSignIn/.test(agentHtml) && /agentSignIn/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
);
check(
  "the agent page records a scan through the server",
  /agentScan/.test(agentHtml) && /action: 'scan'/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
);
check(
  "the agent function hands the scan to the database",
  /record_handoff_scan/.test(agentFunction)
);
check(
  "the agent function refuses an account that is not an agent",
  /This account is not a delivery agent/.test(agentFunction)
);
check(
  "the agent dashboard is read from the server, not from the browser",
  /agentSnapshot/.test(agentHtml) && /agent_hub_snapshot/.test(sql)
);
check(
  "the agent can read the orders assigned to them",
  /delivery_assignments_select_own/.test(sql)
    && /agent_user_id = \(select auth\.uid\(\)\)/.test(sql)
);
check(
  "the agent can read their own handoff history",
  /scanned_by = \(select auth\.uid\(\)\)/.test(sql)
);
check(
  "an agent worker ID has a place in the schema",
  /worker_id/.test(sql) && /KMW-\[0-9\]\{2\}/.test(sql)
);
check(
  "the handoff code rules are shared by every entry point",
  /scanFailure/.test(agentFunction)
    && /scanFailure/.test(functionSource.get(path.join("supabase", "functions", "handoff", "index.ts")) || "")
);
check(
  "a refusal keeps the reason the server gave",
  /context\.json\(\)/.test(readFileSafe(path.join(root, "kobe-supabase.js")))
);

/* ------------------------------------------------------------ the console
   The operations console used to be a page of labels. It now reads the
   platform, and it must keep reading it rather than showing a number
   the page made up. */
const adminFunction =
  functionSource.get(path.join("supabase", "functions", "admin", "index.ts")) || "";
const adminJs = readFileSafe(path.join(root, "kobe-admin.js"));
const adminHtml = readFileSafe(path.join(root, "admin.html"));

check(
  "the console reads the platform from the server",
  /admin_overview/.test(adminFunction) && /admin_overview/.test(sql)
);
check(
  "the console refuses a caller who is not staff",
  /requireStaffPermission\(request, auth, service, permission\)/.test(adminFunction)
    && /if \(!role\) throw new ApiError\(403, "Staff access required\."\)/.test(
      readFileSafe(path.join(root, "supabase", "functions", "_shared", "auth.ts"))
    )
);
check(
  "the console panels are filled from the server, not from placeholders",
  /loadOverview/.test(adminJs) && /loadOrders/.test(adminJs)
    && /loadDisputes/.test(adminJs) && /loadAudit/.test(adminJs)
);
check(
  "the console searches the orders it lists",
  /order-search/.test(adminHtml) && /admin_order_queue/.test(sql)
);
check(
  "the staff read functions are closed to the public",
  /revoke all on function public\.admin_overview\(\) from public, anon, authenticated/.test(sql)
    && /grant execute on function public\.admin_overview\(\) to service_role/.test(sql)
);

/* ------------------------------------------------------- the sidebars
   The sidebar is the only navigation, and it is opened with a thumb.
   The items had 3px between them, the sign-out was buried in a popup,
   and the console footer was pinned on top of its own links. */
check(
  "the buyer sidebar spaces its items and shows the sign-out",
  /nav\.side-nav\{gap:6px\}/.test(readFileSafe(path.join(root, "buyer.html")))
    && /side-logout/.test(readFileSafe(path.join(root, "buyer.html")))
);
check(
  "the seller sidebar shows the sign-out",
  /\.plog\{/.test(readFileSafe(path.join(root, "seller.html")))
);
check(
  "the console footer no longer covers the navigation",
  /\.side-footer\{position:static/.test(adminHtml)
    && /\.admin-nav\{flex:1;min-height:0;overflow-y:auto/.test(adminHtml)
);

/* ------------------------------------------------------------------ out */
console.log("Kobe Mweusi — flow verification");console.log("=".repeat(60));console.log(`checks: ${passed + failed}   passed: ${passed}   failed: ${failed}`);
if (failures.length) {
  console.log("");
  for (const f of failures) console.log("FAIL  " + f);
  process.exit(1);
}
console.log("All cross-layer flow checks passed.");
