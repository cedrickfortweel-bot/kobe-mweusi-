/* Navigation verification for the buyer and seller apps.

   A dead nav item or a link to a screen that does not exist is a dead
   end for the customer, and it is invisible in a static review because
   the screen names are strings scattered across the markup and the
   scripts.

   Checks:
     * every nav entry points at a screen that exists
     * every screen in the app is reachable from the nav or from a
       navigation call
     * every go()/showScreen()/tab() target exists
     * every inline onclick handler names a function that is defined
     * every internal link to #screen-... names a screen that exists

   Usage:  node supabase/tests/nav_check.js
*/

"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const read = (f) => {
  try {
    return fs.readFileSync(path.join(root, f), "utf8");
  } catch {
    return "";
  }
};

let problems = 0;
const fail = (msg) => {
  problems++;
  console.log("  FAIL  " + msg);
};

/* The inline script of an HTML file, without the src ones. */
function inlineScript(source) {
  const blocks = source.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
  return blocks.map((b) => b.replace(/<\/?script[^>]*>/gi, "")).join("\n");
}

/* Screen names declared in the markup.

   The buyer uses id="screen-home" and the seller uses id="home", so the
   id is normalised by dropping a leading "screen-". */
function declaredScreens(source) {
  const ids = new Set();
  const re = /<section[^>]*class="[^"]*\bscreen\b[^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const id = /\bid=["']([a-zA-Z0-9_-]+)["']/.exec(m[0]);
    if (!id) continue;
    ids.add(id[1].replace(/^screen-/, ""));
  }
  return ids;
}

/* Functions defined anywhere in the file. The apps are heavily minified,
   so the definitions are not anchored to a line start. */
function definedFunctions(source) {
  const names = new Set();
  const re = /(?:^|[^\w$.])(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) names.add(m[1]);
  const win = /(?:^|[^\w$.])window\.([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g;
  while ((m = win.exec(source)) !== null) names.add(m[1]);
  const arrow = /(?:^|[^\w$.])window\.([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|[a-zA-Z_$][\w$]*\s*=>)/g;
  while ((m = arrow.exec(source)) !== null) names.add(m[1]);
  return names;
}

/* The name of a screen a navigation call refers to. Navigation calls
   appear both in the inline script and in markup attributes such as
   onclick="go('ntf')", so the whole file is scanned. */
function navTargets(source) {
  const targets = new Set();
  const patterns = [
    /\bshowScreen\(\s*\\?['"]([a-zA-Z0-9_-]+)\\?['"]/g,
    /\bgo\(\s*\\?['"]([a-zA-Z0-9_-]+)\\?['"]/g,
    /\btab\(\s*\\?['"]([a-zA-Z0-9_-]+)\\?['"]/g,
    /* The profile menu navigates through pfGo(), which calls tab(). */
    /\bpfGo\(\s*\\?['"]([a-zA-Z0-9_-]+)\\?['"]/g,
    /* A whole stack is replaced at once, for example
       stack=['home','done']. */
    /\bstack\s*=\s*\[([^\]]*)\]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      if (re.source.includes("stack")) {
        const inner = /['"]([a-zA-Z0-9_-]+)['"]/g;
        let im;
        while ((im = inner.exec(m[1])) !== null) targets.add(im[1]);
      } else {
        targets.add(m[1]);
      }
    }
  }
  return targets;
}

/* The screens the nav bar lists.

   The seller nav is a list of [screenId, label] pairs, so only the first
   element of each pair is a screen. The buyer lists bare names.

   Some entries are group headings rather than screens: the seller nav
   renders 'sl' as a heading, so it has no screen of its own. */
function navScreens(source) {
  const screens = new Set();
  const headings = new Set();
  const headingMatch = /n\[0\]\s*===?\s*['"]([a-zA-Z0-9_-]+)['"]/.exec(source);
  if (headingMatch) headings.add(headingMatch[1]);

  const pairs = /const\s+nav\s*=\s*\[([\s\S]*?)\]\s*;/.exec(source);
  if (pairs) {
    const re = /\[\s*['"]([a-zA-Z0-9_-]+)['"]/g;
    let m;
    while ((m = re.exec(pairs[1])) !== null) screens.add(m[1]);
  }

  const list = /const\s+allScreens\s*=\s*\[([^\]]*)\]/.exec(source);
  if (list) {
    const re = /['"]([a-zA-Z0-9_-]+)['"]/g;
    let m;
    while ((m = re.exec(list[1])) !== null) screens.add(m[1]);
  }

  for (const h of headings) screens.delete(h);
  return screens;
}

/* Whether a screen opens with a back button. */
function screenHasBackButton(source, name) {
  const re = new RegExp(
    '<section class="screen[^"]*" id="' + name + '">([\\s\\S]{0,300})'
  );
  const m = re.exec(source);
  if (!m) return false;
  return /class="bk"/.test(m[1]);
}

for (const file of ["buyer.html", "seller.html"]) {
  const source = read(file);
  if (!source) {
    console.log(`SKIP  ${file}`);
    continue;
  }
  const script = inlineScript(source);
  const screens = declaredScreens(source);
  /* Handlers may live in the app file or in the shared workflow module. */
  const functions = new Set([
    ...definedFunctions(source),
    ...definedFunctions(read("kobe-app-workflows.js")),
    ...definedFunctions(read("kobe-qr.js")),
    ...definedFunctions(read("kobe-camera.js")),
  ]);
  const targets = navTargets(source);
  const nav = navScreens(source);

  console.log(`${file}: ${screens.size} screens, ${nav.size} in the nav, ${targets.size} navigation targets`);

  /* Every screen the nav lists must exist. */
  for (const name of nav) {
    if (!screens.has(name)) fail(`nav lists "${name}" but there is no screen-${name}`);
  }

  /* Every navigation call must reach a screen that exists. */
  for (const name of targets) {
    if (!screens.has(name)) fail(`a navigation call targets "${name}" but there is no screen-${name}`);
  }

  /* Every screen must be reachable. */
  for (const name of screens) {
    if (!nav.has(name) && !targets.has(name)) {
      fail(`screen-${name} is not reachable from the nav or from any navigation call`);
    }
  }

  /* A back button must always land somewhere. A top-level nav
     destination is reached with tab(), which resets the stack to one
     entry, so back() needs a fallback or the button would do nothing
     at all. */
  const backAt = source.indexOf("function back(");
  const backBody = backAt >= 0 ? source.slice(backAt, backAt + 600) : "";
  const hasFallback = /stack\s*=\s*\[\s*['"]home['"]/.test(backBody);

  for (const name of screens) {
    if (!screenHasBackButton(source, name)) continue;
    if (!hasFallback) {
      fail(
        `screen-${name} has a back button, but back() has no fallback, so on a` +
          ` top-level screen it would do nothing`
      );
    }
  }

  /* Every inline onclick handler must name a function that exists. */
  const handlerRe = /on(?:click|change|input|submit)=["'][^"']*?\b([a-zA-Z_$][\w$]*)\s*\(/g;
  let hm;
  const seen = new Set();
  const BUILTIN = [
    "if", "for", "while", "return", "event", "e", "getElementById", "querySelector",
    "stopPropagation", "preventDefault", "alert", "confirm", "prompt", "parseInt",
    "parseFloat", "Number", "String", "Boolean", "setTimeout", "setInterval",
    "require", "Date", "Math", "JSON", "Object", "Array", "encodeURIComponent",
  ];
  while ((hm = handlerRe.exec(source)) !== null) {
    const fn = hm[1];
    if (BUILTIN.includes(fn)) continue;
    if (seen.has(fn)) continue;
    seen.add(fn);
    if (!functions.has(fn)) fail(`an inline handler calls ${fn}(...) but no such function is defined`);
  }

  /* Every internal #screen- link must name a screen that exists. */
  const linkRe = /#screen-([a-zA-Z0-9_-]+)/g;
  let lm;
  const seenLinks = new Set();
  while ((lm = linkRe.exec(source)) !== null) {
    const name = lm[1];
    if (seenLinks.has(name)) continue;
    seenLinks.add(name);
    if (!screens.has(name)) fail(`a link points at #screen-${name} but there is no such screen`);
  }
}

console.log("");
if (problems) {
  console.log(`${problems} navigation problem(s).`);
  process.exit(1);
}
console.log("Every screen is reachable and every navigation target exists.");
