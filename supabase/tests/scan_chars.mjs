/* Lists every non-ASCII character in a file with its context, so each one
   can be judged: a mangled character, a stray symbol, or something the
   design intends.

   Usage:  node supabase/tests/scan_chars.mjs buyer.html
*/

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const file = process.argv[2] || "buyer.html";

const text = readFileSync(join(root, file), "utf8");
const lines = text.split("\n");

/* Group by character so a character used in many places is listed once
   with a count and the first few places. */
const seen = new Map();

lines.forEach((line, i) => {
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (cp < 128) continue;
    if (!seen.has(ch)) seen.set(ch, []);
    const list = seen.get(ch);
    if (list.length < 3) {
      const at = line.indexOf(ch);
      list.push({
        line: i + 1,
        around: line.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, " "),
      });
    } else {
      list.push({ line: i + 1, around: "" });
    }
  }
});

console.log(`${file}: ${seen.size} distinct non-ASCII characters`);
console.log("=".repeat(70));

for (const [ch, places] of seen) {
  const cp = ch.codePointAt(0);
  const name =
    cp >= 0x1f300 ? "emoji" :
    cp >= 0x2000 && cp <= 0x206f ? "general punctuation" :
    cp >= 0x00a0 && cp <= 0x00ff ? "latin-1 supplement" :
    cp >= 0x0100 && cp <= 0x024f ? "latin extended-A" :
    cp >= 0x2000 && cp <= 0x2bff ? "symbols" :
    "other";
  console.log(`\n${ch}   U+${cp.toString(16).toUpperCase().padStart(4, "0")}   ${name}   (${places.length} use(s))`);
  for (const p of places) {
    console.log(`   L${p.line}  ${p.around}`);
  }
}
