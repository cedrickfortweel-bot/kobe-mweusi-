/* Finds CSS custom properties that are used but never defined.

   An undefined var() makes the whole declaration invalid, so the
   element keeps whatever it inherited. That is how text ends up dark on
   a dark theme.

   Usage:  node supabase/tests/css_vars_check.js [file.html ...]
*/

"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const files = process.argv.slice(2);
const targets = files.length
  ? files
  : ["buyer.html", "seller.html", "admin.html", "kobe-app-workflows.js"];

let problems = 0;

for (const file of targets) {
  const full = path.join(root, file);
  let source;
  try {
    source = fs.readFileSync(full, "utf8");
  } catch {
    console.log(`SKIP  ${file} (not found)`);
    continue;
  }

  /* Every custom property that is DEFINED: a --name inside a block. */
  const defined = new Set();
  const definePattern = /(--[a-zA-Z0-9-]+)\s*:/g;
  let m;
  while ((m = definePattern.exec(source)) !== null) defined.add(m[1]);

  /* Every custom property that is USED in a var().
     A var() with a fallback (var(--x, red)) always resolves, so only a
     bare var(--x) counts as a possible failure. */
  const used = new Map(); // name -> { line, hasFallback }
  const usePattern = /var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g;
  while ((m = usePattern.exec(source)) !== null) {
    const name = m[1];
    const hasFallback = m[2] === ",";
    const line = source.slice(0, m.index).split("\n").length;
    if (!used.has(name)) used.set(name, { line, hasFallback });
    else if (!hasFallback) used.get(name).hasFallback = false;
  }

  const missing = [...used.entries()]
    .filter(([, info]) => !info.hasFallback)
    .filter(([name]) => !defined.has(name))
    .map(([name, info]) => ({ name, line: info.line }));
  console.log(`${file}: ${defined.size} defined, ${used.size} used`);

  if (!missing.length) {
    console.log("  every var() resolves");
    continue;
  }

  for (const { name, line } of missing) {
    problems++;
    const context = source.split("\n")[line - 1] || "";
    const trimmed = context.trim().replace(/\s+/g, " ").slice(0, 150);
    console.log(`  UNDEFINED  ${name}  first used at line ${line}`);
    console.log(`     ${trimmed}`);
  }
}

console.log("");
if (problems) {
  console.log(`${problems} undefined custom propert${problems === 1 ? "y" : "ies"}.`);
  process.exit(1);
}
console.log("Every var() resolves to a defined custom property.");
