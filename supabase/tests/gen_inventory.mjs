/* Generates the table, function and policy inventory from the migrations.

   The docs are derived from the real SQL rather than typed by hand, so they
   cannot drift away from the schema.

   Usage:  node supabase/tests/gen_inventory.mjs
*/

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");
const docsDir = join(here, "..", "..", "docs");

const { parse } = await import("libpg-query");

const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

const tables = new Map(); // name -> { module, file, columns:Set, rls, policies:[] }
const functions = new Map(); // signature -> { module, file, returns, volatility, security }
const policies = new Map(); // table -> [{ name, cmd, roles, using, withCheck }]
const enums = new Map();
const buckets = new Set();
const views = new Map();

/* Map a migration file to its blueprint module. */
function moduleOf(file) {
  if (file.includes("reconciliation")) return "Reconciliation";
  if (file.includes("platform_constraints")) return "Reconciliation";
  const m = file.match(/module_([a-z])_/);
  if (m) {
    return {
      a: "A. Identity and access",
      b: "B. Kobe IDs and seller identity",
      c: "C. Wallets, escrow and payments",
      d: "D. Live business and social",
      e: "E. Chat and realtime",
      f: "F. Notifications and devices",
      g: "G. Orders, delivery and escrow release",
      h: "H. Disputes and resolution",
      i: "I. Storage and files",
      j: "J. KYC and verification",
      k: "K. Admin, employees and audit",
      l: "L. Security, fraud and rate limits",
      m: "M. Analytics and reports",
      n: "N. System configuration and integrations",
      o: "O. Realtime and scheduled jobs",
    }[m[1]] || "Unknown";
  }
  return "Baseline";
}

function typeToString(typeNode) {
  if (!typeNode) return "";
  const t = typeNode;
  if (t.setof) return `${typeToString(t.elems)}[]`;
  if (Array.isArray(t.names) && t.names.length) {
    const parts = t.names.map((n) => n.String?.sval).filter(Boolean);
    while (parts.length > 1 && parts[0] === "pg_catalog") parts.shift();
    return parts.join(".");
  }
  return "";
}

for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), "utf8").replace(/^\uFEFF/, "");
  const { stmts } = await parse(sql);
  const mod = moduleOf(file);

  for (const raw of stmts) {
    const stmt = raw.stmt ?? raw;
    if (!stmt) continue;

    if (stmt.CreateStmt) {
      /* CreateStmt covers CREATE TABLE. The raw parser does not serialise
         objtype, and CREATE INDEX / CREATE VIEW have their own nodes. */
      const relname = stmt.CreateStmt.relation?.relname;
      if (!relname) continue;
      if (!tables.has(relname)) {
        tables.set(relname, { module: mod, file, columns: new Set(), rls: false, policies: [], kind: "table" });
      }
    }

    if (stmt.ViewStmt) {
      const name = stmt.ViewStmt.view?.relname;
      if (name) views.set(name, { module: mod, file });
    }

    if (stmt.CreateEnumStmt) {
      const name = stmt.CreateEnumStmt.typeName?.map((p) => p.String?.sval).filter(Boolean).join(".");
      const values = (stmt.CreateEnumStmt.vals || []).map((v) => v.String?.sval);
      if (name) enums.set(name, { module: mod, file, values });
    }

    if (stmt.AlterTableStmt) {
      const a = stmt.AlterTableStmt;
      const relname = a.relation?.relname;
      if (!relname) continue;
      if (!tables.has(relname) && !views.has(relname)) {
        tables.set(relname, { module: mod, file, columns: new Set(), rls: false, policies: [], kind: "table" });
      }
      for (const cmd of a.cmds || []) {
        const c = cmd.AlterTableCmd;
        if (!c) continue;
        if (c.subtype === "AT_AddColumn" && c.def) {
          const t = tables.get(relname);
          if (t) t.columns.add(`${c.name} ${typeToString(c.def.type)}`.trim());
        }
        if (c.subtype === "AT_EnableRowSecurity") {
          const t = tables.get(relname);
          if (t) t.rls = true;
        }
        if (c.subtype === "AT_DropConstraint" || c.subtype === "AT_AddConstraint") {
          const t = tables.get(relname);
          if (t && c.name) t.columns.add(`[constraint ${c.name}]`);
        }
      }
    }

    if (stmt.CreateFunctionStmt) {
      const f = stmt.CreateFunctionStmt;
      const name = f.funcname?.map((p) => p.String?.sval).filter(Boolean).join(".");
      const params = (f.parameters || [])
        .filter((p) => {
          const m = p.FunctionParameter?.mode;
          return m !== "FUNC_PARAM_OUT" && m !== "FUNC_PARAM_TABLE" && m !== "FUNC_PARAM_INOUT";
        })
        .map((p) => typeToString(p.FunctionParameter?.argType));
      const sig = `${name}(${params.join(", ")})`;
      functions.set(sig, {
        module: mod,
        file,
        returns: typeToString(f.rettype),
        language: f.language || "sql",
        security: f.securityDefiner ? "definer" : "invoker",
        replace: f.replace === true,
      });
    }

    if (stmt.CreatePolicyStmt) {
      const p = stmt.CreatePolicyStmt;
      const table = p.table?.relname;
      if (!table) continue;
      if (!policies.has(table)) policies.set(table, []);
      const roles = (p.roles || []).map((r) => r.RoleSpec?.rolename).filter(Boolean);
      policies.get(table).push({
        name: p.policy_name,
        cmd: p.cmd_name || "ALL",
        roles: roles.length ? roles.join(", ") : "public",
        using: p.qual ? "yes" : "",
        withCheck: p.with_check ? "yes" : "",
        permissive: p.permissive !== false,
      });
    }

    if (stmt.InsertStmt) {
      const s = JSON.stringify(stmt.InsertStmt);
      if (s.includes("storage.buckets") || s.includes("\"storage\"")) {
        const m = s.match(/values\s*\(\s*'([a-z0-9-]+)'/);
        if (m) buckets.add(m[1]);
      }
    }
  }
}

/* Column extraction from CREATE TABLE (the ALTER path only sees added
   columns, so read the definitions too). */
for (const file of files) {
  const sql = readFileSync(join(migrationsDir, file), "utf8").replace(/^\uFEFF/, "");
  const { stmts } = await parse(sql);
  for (const raw of stmts) {
    const stmt = raw.stmt ?? raw;
    if (!stmt?.CreateStmt) continue;
    const relname = stmt.CreateStmt.relation?.relname;
    if (!relname) continue;
    const t = tables.get(relname);
    if (!t) continue;
    for (const col of stmt.CreateStmt.tableElts || []) {
      const c = col.ColumnDef;
      if (!c) continue;
      /* Every ColumnDef is a real column, even when it also carries a
         primary key or a foreign key. Table-level constraints arrive as a
         different node and are skipped here. */
      t.columns.add(`${c.colname} ${typeToString(c.typeName)}`.trim());
    }
  }
}

/* ---------------------------------------------------------------- table doc */
const byModule = new Map();
for (const [name, meta] of tables) {
  if (!byModule.has(meta.module)) byModule.set(meta.module, []);
  byModule.get(meta.module).push({ name, ...meta });
}

let tableDoc = `# Table inventory

Generated from \`supabase/migrations/\` by \`node supabase/tests/gen_inventory.mjs\`.
Do not edit by hand: regenerate instead.

${tables.size} tables, ${views.size} views, ${functions.size} functions.

`;

for (const [mod, list] of byModule) {
  tableDoc += `## ${mod}\n\n`;
  tableDoc += `| Table | RLS | Columns | Policies |\n|---|---|---|---|\n`;
  for (const t of list.sort((a, b) => a.name.localeCompare(b.name))) {
    const pol = policies.get(t.name) || [];
    const cols = [...t.columns].filter((c) => !c.startsWith("[constraint")).sort();
    tableDoc += `| \`${t.name}\` | ${t.rls ? "yes" : "no"} | ${cols.length} | ${pol.length} |\n`;
  }
  tableDoc += `\n`;
}

tableDoc += `## Storage buckets\n\n`;
for (const b of [...buckets].sort()) tableDoc += `- \`${b}\`\n`;

tableDoc += `\n## Column detail\n\n`;
for (const [mod, list] of byModule) {
  tableDoc += `### ${mod}\n\n`;
  for (const t of list.sort((a, b) => a.name.localeCompare(b.name))) {
    const cols = [...t.columns].filter((c) => !c.startsWith("[constraint")).sort();
    tableDoc += `**\`${t.name}\`**${t.rls ? " (RLS on)" : " (RLS off)"}\n\n`;
    tableDoc += cols.length ? cols.map((c) => `- \`${c}\``).join("\n") + "\n\n" : "_no columns recorded_\n\n";
  }
}

/* ------------------------------------------------------------ function doc */
const fnByModule = new Map();
for (const [sig, meta] of functions) {
  if (!fnByModule.has(meta.module)) fnByModule.set(meta.module, []);
  fnByModule.get(meta.module).push({ sig, ...meta });
}

let fnDoc = `# Function inventory

Generated from \`supabase/migrations/\` by \`node supabase/tests/gen_inventory.mjs\`.

A function marked **definer** runs with the privileges of its owner. A
function marked **invoker** runs with the privileges of the caller. Every
money-moving function is a definer and is revoked from \`anon\` and
\`authenticated\` unless it is explicitly a customer-facing action.

`;

for (const [mod, list] of fnByModule) {
  fnDoc += `## ${mod}\n\n`;
  fnDoc += `| Function | Returns | Lang | Security |\n|---|---|---|---|\n`;
  for (const f of list.sort((a, b) => a.sig.localeCompare(b.sig))) {
    fnDoc += `| \`${f.sig}\` | ${f.returns || "void"} | ${f.language} | ${f.security} |\n`;
  }
  fnDoc += `\n`;
}

/* ---------------------------------------------------------------- policy doc */
let polDoc = `# RLS policy matrix

Generated from \`supabase/migrations/\` by \`node supabase/tests/gen_inventory.mjs\`.

Every table listed here has row level security enabled. A table with no
policy is reachable by nobody through the Data API, which is the intended
state for service-role-only tables such as the money ledger.

| Table | Policy | Command | Roles | USING | WITH CHECK |
|---|---|---|---|---|---|
`;

for (const [table, list] of [...policies].sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const p of list.sort((a, b) => a.name.localeCompare(b.name))) {
    polDoc += `| \`${table}\` | \`${p.name}\` | ${p.cmd} | ${p.roles} | ${p.using || "-"} | ${p.withCheck || "-"} |\n`;
  }
}

polDoc += `\n## Tables with RLS enabled and no policy\n\n`;
const noPolicy = [...tables].filter(([name, meta]) => meta.rls && !(policies.get(name) || []).length);
if (!noPolicy.length) polDoc += "None.\n";
else for (const [name] of noPolicy) polDoc += `- \`${name}\`\n`;

/* ------------------------------------------------------------------- enum */
let enumDoc = `# Enum inventory\n\nGenerated from \`supabase/migrations/\`.\n\n`;
enumDoc += `| Enum | Values | Module |\n|---|---|---|\n`;
for (const [name, meta] of [...enums].sort((a, b) => a[0].localeCompare(b[0]))) {
  enumDoc += `| \`${name}\` | ${meta.values.map((v) => `\`${v}\``).join(", ")} | ${meta.module} |\n`;
}

mkdirSync(docsDir, { recursive: true });
writeFileSync(join(docsDir, "table-inventory.md"), tableDoc);
writeFileSync(join(docsDir, "function-inventory.md"), fnDoc);
writeFileSync(join(docsDir, "rls-policy-matrix.md"), polDoc);
writeFileSync(join(docsDir, "enum-inventory.md"), enumDoc);

console.log(`tables: ${tables.size}  views: ${views.size}  functions: ${functions.size}  policies: ${[...policies.values()].flat().length}  enums: ${enums.size}`);
console.log(`wrote docs/table-inventory.md, docs/function-inventory.md, docs/rls-policy-matrix.md, docs/enum-inventory.md`);
