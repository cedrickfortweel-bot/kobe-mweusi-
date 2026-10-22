/* Self-test for the semantic checks in sql_lint.mjs.

   A check that never fires is worse than no check, so this proves the
   return-type and accidental-overload detectors actually catch the
   mistakes they exist to catch.

   Usage:  node supabase/tests/sql_lint_selftest.mjs
*/

import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");
const probeName = "99999999999999_selftest_probe.sql";

/* A file that reproduces the two defect classes. */
const PROBE = `
create or replace function public.selftest_probe(a uuid)
returns void
language plpgsql
as $$ begin return; end; $$;

create or replace function public.selftest_probe(a uuid)
returns jsonb
language plpgsql
as $$ begin return '{}'::jsonb; end; $$;

create or replace function public.selftest_probe(a uuid, b text)
returns void
language plpgsql
as $$ begin return; end; $$;
`;

writeFileSync(join(migrationsDir, probeName), PROBE);

let output = "";
let exitCode = 0;
try {
  output = execFileSync(process.execPath, [join(here, "sql_lint.mjs")], {
    encoding: "utf8",
  });
} catch (err) {
  output = err.stdout || "";
  exitCode = err.status ?? 1;
} finally {
  rmSync(join(migrationsDir, probeName), { force: true });
}

let failures = 0;
function expect(label, condition) {
  if (condition) {
    console.log("OK    " + label);
  } else {
    failures++;
    console.log("FAIL  " + label);
  }
}

expect("the lint exits non-zero on a semantic defect", exitCode !== 0);
expect("it reports the changed return type", /RETURN TYPE CHANGED/.test(output));
expect("it reports the accidental overload", /ACCIDENTAL OVERLOAD/.test(output));

console.log("");
if (failures) {
  console.log(`sql_lint self-test: ${failures} failure(s)`);
  process.exit(1);
}
console.log("sql_lint self-test: all checks fire as expected.");
