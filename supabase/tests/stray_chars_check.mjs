/* Finds stray Latin-1 characters in the app files.

   These are almost always a character that was mangled by a bad
   conversion: a legitimate accented word would be in a word, but a
   stray one sits between two ASCII words.

   Usage:  node supabase/tests/stray_chars_check.js
*/

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const files = ["buyer.html", "seller.html", "admin.html", "kobe-supabase.js", "kobe-app-workflows.js", "kobe-admin.js"];

/* Latin-1 supplement and the Latin extended-A block, which are where a
   mangled character usually lands. */
const SUSPECT = /[À-ɏ]/;

/* The symbols the design actually uses. A multiplication sign in "2 ×
   TSh 500" and a close button are not damage. */
const ALLOWED = new Set([
  "×", // multiplication sign
  "·", // middle dot
  "°", // degree
  "©",
  "®",
  "€",
  "£",
  "¥",
  "½",
  "¼",
  "¾",
  "—", // em dash
  "–", // en dash
  "‘",
  "’",
  "“",
  "”",
  "…",
]);

let found = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const hits = [...line].filter((c) => SUSPECT.test(c) && !ALLOWED.has(c));
    if (!hits.length) return;
    for (const c of new Set(hits)) {
      found++;
      const at = line.indexOf(c);
      const around = line.slice(Math.max(0, at - 45), at + 45).replace(/\s+/g, " ");
      console.log(
        `${file}:${i + 1}  ${c}  U+${c.codePointAt(0).toString(16).toUpperCase()}  ...${around}...`
      );
    }
  });
}

console.log("");
console.log(found ? `${found} stray character(s) found.` : "No stray Latin-1 characters.");
if (found) process.exit(1);
