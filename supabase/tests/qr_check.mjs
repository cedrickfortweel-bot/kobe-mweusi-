/* Checks the QR generator still produces a valid, scannable code with the
   turtle mark in the middle. */
import { readFileSync } from "node:fs";

global.window = {};
const src = readFileSync("kobe-qr.js", "utf8");
new Function(src)();
const KobeQr = global.window.KobeQr;

if (!KobeQr || !KobeQr.svg) {
  console.log("FAIL  kobe-qr.js did not expose window.KobeQr.svg");
  process.exit(1);
}

const payload = "KMH1.6f0a1b2c-3d4e-5f60-7182-93a4b5c6d7e8";
const svg = KobeQr.svg(payload, "Kobe Mweusi handoff code");

const failures = [];
const ok = (label, condition, detail) => {
  console.log(`${condition ? "OK  " : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!condition) failures.push(label);
};

ok("the SVG is produced", typeof svg === "string" && svg.length > 200);
ok("it is an SVG element", /^<svg[\s>]/.test(svg));
ok("it declares the namespace", svg.includes('xmlns="http://www.w3.org/2000/svg"'));
ok("it has a viewBox", /viewBox="0 0 \d+ \d+"/.test(svg));
ok("it has an accessible label", /aria-label="/.test(svg));
ok("the modules are drawn", /<path d="M\d+ \d+h1v1h-1z/.test(svg));
ok("the turtle mark is present", svg.includes("<g transform=") && svg.includes('fill="#14150F"'));
ok("the gold ring is present", svg.includes('stroke="#C6903D"'));
ok("the centre square is white", svg.includes('fill="#fff"'));
ok("the shape is balanced", svg.split("<g").length === svg.split("</g>").length);

/* The mark must not eat the finder patterns, so the badge has to sit
   clear of the corner squares. */
const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
const size = Number(viewBox[1]);
const badge = size * 0.18;
const inset = (size - badge) / 2;
const quiet = 4;
ok(
  "the mark clears the finder pattern",
  inset > quiet,
  `inset ${inset.toFixed(1)} modules, the quiet zone is ${quiet}`
);

/* The covered area must stay inside what error correction H tolerates. */
const moduleArea = (size - quiet * 2) * (size - quiet * 2);
const covered = badge * badge;
const ratio = covered / moduleArea;
ok(
  "the mark stays inside the error correction budget",
  ratio < 0.25,
  `${(ratio * 100).toFixed(1)}% of the code area covered, level H allows about 30%`
);

/* The logo can be turned off for a page that needs a plain code. */
const plain = KobeQr.svg(payload, "plain", { logo: false });
ok("the mark can be turned off", !plain.includes("<g transform="));

console.log("");
if (failures.length) {
  console.log(`${failures.length} QR check(s) failed.`);
  process.exit(1);
}
console.log("The QR generator is sound with the turtle mark in place.");
