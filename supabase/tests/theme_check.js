const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const pages = [
  'Kobe_Mweusi_homepage_v7_static.html',
  'buyer.html',
  'seller.html',
  'admin.html',
  'agent.html',
  'reset-password.html'
];

for (const page of pages) {
  const content = fs.readFileSync(path.join(root, page), 'utf8');
  assert.match(content, /href="kobe-oled\.css"/, `${page} must load the shared theme styles`);
  assert.match(content, /src="kobe-theme\.js"/, `${page} must load the shared theme control`);
}

const themeScript = fs.readFileSync(path.join(root, 'kobe-theme.js'), 'utf8');
const themeStyles = fs.readFileSync(path.join(root, 'kobe-oled.css'), 'utf8');
const appWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const agentWorker = fs.readFileSync(path.join(root, 'agent-sw.js'), 'utf8');

assert.match(themeScript, /localStorage\.setItem\(preferenceKey, theme\)/, 'theme choice must persist');
assert.match(themeScript, /clearLegacyLightOverrides/, 'legacy forced-light overrides must be cleared');
assert.match(themeStyles, /html\[data-theme="oled"\][\s\S]*--bg:\s*#000000/, 'OLED theme must use a true-black background');
assert.match(themeStyles, /--text-muted:\s*#b7b7bd/, 'OLED theme must retain readable muted text');
for (const asset of ['kobe-theme.css', 'kobe-theme.js', 'kobe-oled.css']) {
  assert.ok(appWorker.includes(`'${asset}'`), `buyer/seller offline shell must cache ${asset}`);
  assert.ok(agentWorker.includes(`'${asset}'`), `agent offline shell must cache ${asset}`);
}

console.log(`Theme coverage passed for ${pages.length} pages.`);
