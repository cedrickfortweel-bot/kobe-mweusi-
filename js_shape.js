/* Shared helpers for reading the shape of the browser-side JavaScript.

   The API boundary and the apps are plain scripts, not modules, so the
   only way to know which methods the boundary really exposes is to read
   it. A regular expression is not enough: a naive brace counter stops
   at the first nested "});", and an apostrophe inside a comment opens a
   string and swallows the braces after it.

   This module walks the source properly, skipping line comments, block
   comments and string literals, and returns the real object blocks.
*/

"use strict";

/* Find the object literal bodies of "const api = { ... }" and
   "Object.assign(api, { ... })". */
function objectBlocks(source) {
  const blocks = [];
  const openers = /Object\.assign\(\s*api\s*,\s*\{|const\s+api\s*=\s*\{/g;
  let match;

  while ((match = openers.exec(source)) !== null) {
    const start = source.indexOf("{", match.index);
    let depth = 0;
    let i = start;
    let inString = null;

    while (i < source.length) {
      const ch = source[i];

      if (inString) {
        if (ch === "\\") i++;
        else if (ch === inString) inString = null;
      } else if (ch === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i++;
        continue;
      } else if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 1;
      } else if (ch === "'" || ch === '"' || ch === "`") {
        inString = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }

    blocks.push(source.slice(start + 1, i));
  }

  return blocks;
}

const RESERVED = ["if", "for", "while", "switch", "catch", "return", "function", "const"];

/* The method names an object literal declares. A method is written as
   "async name(", "name:" or a shorthand "name," at the start of a line. */
function methodNames(body) {
  const names = new Set();
  const pattern = /(?:^|\n)\s*(?:async\s+)?([a-zA-Z_$][\w$]*)\s*[:(,]/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    if (RESERVED.includes(match[1])) continue;
    names.add(match[1]);
  }
  return names;
}

/* Every method the given sources expose through the API boundary. */
function apiMethodNames(sources) {
  const names = new Set();
  for (const source of sources) {
    if (!source) continue;
    for (const body of objectBlocks(source)) {
      for (const name of methodNames(body)) names.add(name);
    }
    /* Anything assigned straight onto the api object. */
    const assign = /api\.([a-zA-Z_$][\w$]*)\s*=/g;
    let match;
    while ((match = assign.exec(source)) !== null) names.add(match[1]);
  }
  return names;
}

module.exports = { objectBlocks, methodNames, apiMethodNames };
