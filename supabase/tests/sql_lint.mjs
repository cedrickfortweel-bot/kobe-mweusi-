/* Static SQL validation for the Supabase migrations.

   Parses every file in supabase/migrations with the real PostgreSQL
   parser (libpg-query), so a syntax error is caught here instead of
   halfway through a `supabase db push`.

   Checks:
     * Every migration parses as valid PostgreSQL.
     * Every GRANT EXECUTE targets a function that is actually defined in
       the migration set or already present in the baseline.
     * A migration never creates the same function twice with different
       signatures.

   Usage:  npm run lint:sql
           node supabase/tests/sql_lint.mjs
*/

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

let parse;
try {
  const mod = await import("libpg-query");
  parse = mod.parse || mod.default?.parse;
} catch {
  console.error("libpg-query is not installed. Run: npm install libpg-query");
  process.exit(2);
}
if (!parse) {
  console.error("libpg-query does not expose parse().");
  process.exit(2);
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (!files.length) {
  console.error("No migrations found.");
  process.exit(2);
}

/* Functions that already exist in the deployed database, taken from the
   live schema inventory. */
const baselineFunctions = new Set([
  "public.set_updated_at()",
  "public.handle_new_user()",
  "public.wallet_balance(uuid)",
  "public.seller_stats(uuid)",
  "public.held_escrow(uuid)",
  "public.finalize_order(uuid)",
  "public.restore_expired_orders()",
  "public.reserve_stock(uuid,integer)",
  "public.restore_stock(uuid,integer)",
  "public.set_transaction_pin(uuid,text)",
  "public.verify_transaction_pin(uuid,text)",
  "public.record_handoff(uuid,public.handoff_code_type,uuid)",
  "public.consume_rate_limit(text,text,integer,integer)",
  "public.is_internal_staff()",
  "public.can_upload_kyc_document(uuid)",
  "public.review_seller_kyc(uuid,uuid,text,text)",
  "public.notify_seller_kyc_decision(uuid,uuid,text,text,text)",
  "public.enforce_app_write_rate_limit()",
  "public.mark_seller_kyc_pending()",
  "public.assign_kobe_id()",
  "public.protect_seller_locked_fields()",
  "public.prevent_self_verification()",
  "public.prevent_self_role_change()",
  "public.block_ledger_mutation()",
  "public.force_server_fields()",
  "public.guard_order_changes()",
  "public.guard_live_session()",
  "public.check_order_live_session()",
  "public.guard_chat_thread_update()",
  "public.guard_chat_thread_initiator()",
  "public.on_chat_message_insert()",
  "public.on_dispute_message_insert()",
]);

/* PostgreSQL renders some built-in types with their internal catalog
   names in GRANT statements and with their SQL names in CREATE FUNCTION.
   Normalise both sides so the two can be compared. */
const TYPE_ALIASES = new Map([
  ["int4", "integer"],
  ["int2", "smallint"],
  ["int8", "bigint"],
  ["bool", "boolean"],
  ["float4", "real"],
  ["float8", "double precision"],
  ["timestamptz", "timestamp with time zone"],
  ["timetz", "time with time zone"],
  ["timestamp", "timestamp without time zone"],
  ["time", "time without time zone"],
]);

/* Render a libpg-query TypeName node as a signature fragment. */
function typeToString(typeNode) {
  if (!typeNode) return "unknown";
  const t = typeNode;

  if (t.setof) return `${typeToString(t.elems)}[]`;

  if (Array.isArray(t.names) && t.names.length) {
    const parts = t.names.map((n) => n.String?.sval).filter(Boolean);
    /* Drop the pg_catalog prefix that PostgreSQL adds in GRANT statements. */
    while (parts.length > 1 && parts[0] === "pg_catalog") parts.shift();
    const base = parts.join(".");
    const mods = Array.isArray(t.typmods) ? t.typmods : [];
    if (base === "numeric" && mods.length) {
      return `numeric(${mods.map((m) => m.Integer?.ival ?? m.String?.sval).join(",")})`;
    }
    return TYPE_ALIASES.get(base) || base;
  }

  if (t.typmods) {
    return "text";
  }

  return "unknown";
}

function functionSignature(node) {
  const name = node.funcname?.map((p) => p.String?.sval).filter(Boolean).join(".");
  /* OUT and TABLE parameters are not part of the call signature, so a
     GRANT EXECUTE names only the input parameters. */
  const params = (node.parameters || [])
    .filter((p) => {
      const mode = p.FunctionParameter?.mode;
      return mode !== "FUNC_PARAM_OUT"
        && mode !== "FUNC_PARAM_TABLE"
        && mode !== "FUNC_PARAM_INOUT";
    })
    .map((p) => typeToString(p.FunctionParameter?.argType));
  return `${name}(${params.join(",")})`;
}

function grantSignature(obj) {
  const withArgs = obj.ObjectWithArgs;
  if (!withArgs) return null;
  const name = withArgs.objname?.map((p) => p.String?.sval).filter(Boolean).join(".");
  const params = (withArgs.objargs || []).map((a) => typeToString(a.TypeName));
  return `${name}(${params.join(",")})`;
}

/* The raw parser does not serialise a function's return type, so it is
   read from the SQL text. Every function definition is matched, its
   parameter list is skipped, and the RETURN clause is captured up to
   the next LANGUAGE / AS keyword.

   Dollar-quoted regions are skipped so a "create function" inside a
   function body is not mistaken for a definition. */
function scanReturnTypes(sql) {
  const out = [];
  const masked = sql.replace(/\$([a-zA-Z_]*)\$[\s\S]*?\$\1\$/g, (m) => " ".repeat(m.length));

  const re = /create\s+(?:or\s+replace\s+)?function\s+[a-z_0-9.]+\s*\(/gi;
  let m;
  while ((m = re.exec(masked)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < masked.length && depth > 0) {
      const ch = masked[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    const after = sql.slice(i);
    const rm = /^\s*returns\s+([\s\S]*?)\s+(?:language\s|as\s|begin\b|window\s|leakproof|set\b)/i.exec(after);
    if (rm) {
      out.push(rm[1].replace(/\s+/g, " ").trim().toLowerCase());
    } else {
      out.push("unknown");
    }
  }
  return out;
}

let errors = 0;
let warnings = 0;
let statementTotal = 0;

const definedFunctions = new Map(); // signature -> file
const grantTargets = [];

/* Return types, so a CREATE OR REPLACE that changes a return type can be
   caught. PostgreSQL refuses that at apply time with "cannot change
   return type of existing function", which is a confusing way to find
   out about it. */
const returnTypes = new Map(); // signature -> returns clause
/* Every signature a name has ever had, to spot accidental overloads. */
const signaturesByName = new Map();
/* Signatures dropped by a DROP FUNCTION, so an overload is only flagged
   when the old one was left behind. */
const droppedSignatures = new Set();
/* Signatures currently live. */
const liveSignatures = new Set();

for (const file of files) {
  const path = join(migrationsDir, file);
  const raw = readFileSync(path, "utf8");
  /* Strip a UTF-8 BOM: some editors add one and it breaks strict parsers. */
  const sql = raw.replace(/^\uFEFF/, "");

  let result;
  try {
    result = await parse(sql);
  } catch (err) {
    errors++;
    const message = err?.message || String(err);
    console.error(`\nFAIL  ${file}`);
    console.error(`      ${message.split("\n").slice(0, 8).join("\n      ")}`);
    continue;
  }

  const stmts = result.stmts || [];
  statementTotal += stmts.length;

  /* The return types, in source order, so each parsed function can be
     paired with its RETURN clause. */
  const scannedReturns = scanReturnTypes(sql);
  let scannedIndex = 0;

  for (const raw of stmts) {
    const stmt = raw.stmt ?? raw;
    if (!stmt) continue;

    if (stmt.CreateFunctionStmt) {
      const sig = functionSignature(stmt.CreateFunctionStmt);
      const replaced = stmt.CreateFunctionStmt.replace === true;
      const name = stmt.CreateFunctionStmt.funcname
        ?.map((p) => p.String?.sval).filter(Boolean).join(".");
      const returns = scannedReturns[scannedIndex++] ?? "unknown";

      if (definedFunctions.has(sig) && !replaced) {
        warnings++;
        console.log(`      duplicate function signature: ${sig}`);
      }

      /* A replaced function may not change its return type. */
      const previous = returnTypes.get(sig);
      if (replaced && previous && previous !== "unknown" && returns !== "unknown"
          && previous !== returns) {
        errors++;
        console.log(
          `      RETURN TYPE CHANGED: ${sig} was "${previous}", now "${returns}".` +
            ` PostgreSQL rejects this: drop the function first.`
        );
      }
      returnTypes.set(sig, returns);

      /* Overloads are legal in PostgreSQL, but in this schema they are
         almost always an accident: a function whose parameter list
         changed and was not dropped first leaves a stale overload
         behind, and calls then resolve to the wrong one. */
      if (!signaturesByName.has(name)) signaturesByName.set(name, new Set());
      const known = signaturesByName.get(name);
      for (const other of known) {
        if (other === sig) continue;
        if (droppedSignatures.has(other)) continue;
        errors++;
        console.log(
          `      ACCIDENTAL OVERLOAD: ${name} now has both ${other} and ${sig}.` +
            ` Drop the old signature before redefining it.`
        );
      }
      known.add(sig);
      liveSignatures.add(sig);

      definedFunctions.set(sig, file);
    }

    if (stmt.DropStmt) {
      const d = stmt.DropStmt;
      if (d.removeType === "OBJECT_FUNCTION" || d.removeType === "FUNCTION") {
        for (const obj of d.objects || []) {
          const withArgs = obj.ObjectWithArgs;
          if (!withArgs) continue;
          const name = withArgs.objname?.map((p) => p.String?.sval).filter(Boolean).join(".");
          const params = (withArgs.objargs || []).map((a) => typeToString(a.TypeName));
          const sig = `${name}(${params.join(",")})`;
          returnTypes.delete(sig);
          droppedSignatures.add(sig);
          liveSignatures.delete(sig);
        }
      }
    }

    if (stmt.GrantStmt) {
      const objtype = stmt.GrantStmt.objtype || "";
      if (objtype !== "OBJECT_FUNCTION") continue;
      for (const obj of stmt.GrantStmt.objects || []) {
        const sig = grantSignature(obj);
        if (sig) grantTargets.push({ sig, file });
      }
    }
  }

  console.log(` OK   ${file.padEnd(64)} ${String(stmts.length).padStart(4)} statements`);
}

console.log("=".repeat(72));
console.log(`migrations: ${files.length}   statements: ${statementTotal}`);

/* Verify every GRANT EXECUTE target exists. */
const missing = [];
for (const { sig, file } of grantTargets) {
  if (definedFunctions.has(sig)) continue;
  if (baselineFunctions.has(sig)) continue;
  missing.push({ sig, file });
}

for (const { sig, file } of missing) {
  warnings++;
  console.log(`WARN  ${file}\n      GRANT EXECUTE on undefined function: ${sig}`);
}

console.log(`errors: ${errors}   warnings: ${warnings}`);

if (errors > 0) {
  console.log("\nFAILED: at least one migration does not parse.");
  process.exit(1);
}
if (missing.length > 0) {
  console.log("\nFAILED: GRANT EXECUTE targets that do not exist.");
  process.exit(1);
}

console.log("All migrations parse cleanly and every GRANT EXECUTE target exists.");
