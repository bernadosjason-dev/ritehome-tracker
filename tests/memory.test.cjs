// MEMORY.md is the portal's change history: its newest version must be the one the portal shows
// (PORTAL_VERSION in shell.js), and every version entry must say whether it is live or pending.
//   node --test tests/memory.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('the newest MEMORY.md version is the version the portal shows', () => {
  const memory = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8');
  const shell = fs.readFileSync(path.join(root, 'shell.js'), 'utf8');
  const versions = [...memory.matchAll(/^### (\d+\.\d+) — /gm)].map((m) => m[1]);
  assert(versions.length > 0, 'MEMORY.md has a version history');
  const shown = /var PORTAL_VERSION = '(\d+\.\d+)'/.exec(shell);
  assert(shown, 'shell.js sets PORTAL_VERSION');
  assert.equal(shown[1], versions[0], 'bump PORTAL_VERSION in shell.js to the newest MEMORY.md entry');
  // Newest first, never repeated.
  const num = (v) => v.split('.').map(Number);
  for (let i = 1; i < versions.length; i++) {
    const [a, b] = [num(versions[i - 1]), num(versions[i])];
    assert(a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]), `version ${versions[i - 1]} must come before ${versions[i]}`);
  }
});

test('every Supabase-era version says whether it is live or pending', () => {
  const memory = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf8');
  for (const m of memory.matchAll(/^### ((\d+)\.\d+) — .*$/gm)) {
    if (Number(m[2]) >= 1) assert.match(m[0], /\((live|pending\b[^)]*)\)/, `${m[1]}: say "(live)" or "(pending: why)"`);
  }
});
