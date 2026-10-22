/* Compares the KobeApi surface the apps call against the surface the
   backend boundary actually defines.

   A missing method is a runtime TypeError at the moment a customer taps
   a button, so it is worth catching before that happens.

   It also reports methods that exist only in the buyer page's demo
   fallback. The real boundary REPLACES the fallback when it loads, so a
   method that lives only there disappears at runtime, which is a silent
   failure worth knowing about.

   Usage:  node api_surface_check.js
*/

"use strict";

const fs = require("fs");
const path = require("path");
const { objectBlocks, methodNames } = require("./js_shape.js");

const root = __dirname;

/* The files that call the API. */
const consumers = [
  "buyer.html",
  "seller.html",
  "admin.html",
  "agent.html",
  "kobe-app-workflows.js",
  "kobe-admin.js",
  "kobe-qr.js",
  "kobe-camera.js",
];

/* The files that define it. */
const providers = ["kobe-supabase.js"];

const readSafe = (f) => {
  try {
    return fs.readFileSync(path.join(root, f), "utf8");
  } catch {
    return "";
  }
};

/* The methods the real boundary defines. */
const defined = new Set();
for (const file of providers) {
  const source = readSafe(file);
  for (const body of objectBlocks(source)) {
    for (const name of methodNames(body)) defined.add(name);
  }
  const assign = /api\.([a-zA-Z_$][\w$]*)\s*=/g;
  let m;
  while ((m = assign.exec(source)) !== null) defined.add(m[1]);
}

/* The methods the buyer page ships as a demo fallback. */
const previewDefined = new Set();
{
  const source = readSafe("buyer.html");
  const marker = "const KobePreviewApi = {";
  const start = source.indexOf(marker);
  if (start >= 0) {
    const body = source.slice(start + marker.length);
    for (const name of methodNames(body)) previewDefined.add(name);
  }
}

/* The methods the apps call. */
const used = new Map();
const callPattern = /KobeApi\.([a-zA-Z_$][\w$]*)/g;

for (const file of consumers) {
  const source = readSafe(file);
  if (!source) continue;
  let m;
  const re = new RegExp(callPattern.source, "g");
  while ((m = re.exec(source)) !== null) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(file);
  }
}

const missing = [];
const previewOnly = [];
for (const [name, files] of used) {
  if (defined.has(name)) continue;
  if (previewDefined.has(name)) {
    previewOnly.push({ name, files: [...files] });
    continue;
  }
  missing.push({ name, files: [...files] });
}

console.log("Kobe Mweusi — API surface check");
console.log("=".repeat(60));
console.log(`defined methods: ${defined.size}`);
console.log(`preview methods: ${previewDefined.size}`);
console.log(`called methods : ${used.size}`);

if (previewOnly.length) {
  console.log("");
  for (const m of previewOnly) {
    console.log(
      `PREVIEW ONLY  KobeApi.${m.name}  — used in ${m.files.join(", ")}.` +
        ` It exists only in the demo fallback, so it disappears when the` +
        ` real backend loads.`
    );
  }
}

if (missing.length) {
  console.log("");
  for (const m of missing) {
    console.log(`MISSING  KobeApi.${m.name}  — used in ${m.files.join(", ")}`);
  }
  console.log("");
  console.log(`${missing.length} called method(s) are not defined by kobe-supabase.js.`);
  process.exit(1);
}

if (previewOnly.length) {
  console.log("");
  console.log(`${previewOnly.length} called method(s) would fall back to the preview stub.`);
  process.exit(1);
}

console.log("Every method the apps call is defined by the real API boundary.");
