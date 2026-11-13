// Moving between workspaces (each a page load) on the Supabase backend: once this tab has signed in as an
// admin, the next page draws from the data this tab last read before its first paint, then re-checks the
// sign-in and reloads behind it. Runs with every backend answer held back 800 ms, so only the warm start
// can show content within 100 ms. Also: a revoked role still ends at the gate and drops the saved copy,
// sign-out drops it, and a new tab starts cold. Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');

(async () => {
  const sb = createFakeSupabase({delayMs: 800});
  sb.seed('projects', 'p_seeded000000001', {name: 'Uy residence kitchen', status: 'active', budget: 120000, updatedAt: '2026-11-01T00:00:00.000Z'});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 900}});
    const page = await ctx.newPage(), errors = require('./fixtures/page-errors.cjs').collectErrors(page);
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const warm = () => page.evaluate(() => sessionStorage.getItem('ritehome_warm_v1'));
    // Signed in: the shim's session plus supabase-js's own storage entry, which the warm start checks.
    await page.addInitScript(() => {
      localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-u-admin', user: {id: 'u-admin', email: 'admin@ritehome.test'}}));
      localStorage.setItem('sb-laxavfldivkhufeubgmb-auth-token', JSON.stringify({user: {id: 'u-admin', email: 'admin@ritehome.test'}}));
    });

    // 1. First visit in this tab: cold. The skeleton shows while it connects, then the data.
    await page.goto('http://127.0.0.1:8000/tracker.html', {waitUntil: 'domcontentloaded'});
    assert(await page.evaluate(() => document.body.classList.contains('connecting')), 'cold start shows the loading state');
    await page.waitForFunction(() => !document.body.classList.contains('gated') && document.body.innerText.includes('Uy residence kitchen'));
    await page.waitForFunction(() => { const w = JSON.parse(sessionStorage.getItem('ritehome_warm_v1') || 'null'); return w && w.user === 'u-admin' && w.cache && w.cache.list; });

    // 2. Menu click: content on screen at once, never the loading state, despite the 800 ms backend.
    for (const name of ['Company fuel', 'Dashboard']) {
      await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('.side-link', {hasText: name}).click()]);
      const t0 = Date.now();
      await page.waitForFunction(() => !document.body.classList.contains('gated') && !document.body.classList.contains('connecting'), null, {timeout: 100, polling: 'raf'});
      assert(Date.now() - t0 < 100, name + ': content within 100 ms');
      assert(!await page.locator('#gateScreen').isVisible(), name + ': no gate card');
    }
    assert(await page.locator('body').innerText().then(t => t.includes('Uy residence kitchen')), 'saved data shown on the dashboard');

    // 3. Fresh data still arrives behind the saved copy.
    sb.seed('projects', 'p_seeded000000002', {name: 'Office partitions', status: 'active', updatedAt: '2026-11-02T00:00:00.000Z'});
    await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('.side-link', {hasText: 'Dashboard'}).click()]);
    await page.waitForFunction(() => document.body.innerText.includes('Office partitions'), null, {timeout: 5000});

    // 4. Role taken away: the saved copy may show for a moment, but the check ends at the gate and drops it.
    sb.users.find(u => u.id === 'u-admin').role = 'designer';
    await Promise.all([page.waitForEvent('domcontentloaded'), page.locator('.side-link', {hasText: 'Company fuel'}).click()]);
    await page.waitForFunction(() => !document.getElementById('gateAccount').hidden, null, {timeout: 5000});
    assert.match(await page.locator('#gateMsg').innerText(), /your projects and their stages are on the Schedule/);
    assert.equal(await warm(), null, 'saved copy dropped');
    await page.reload({waitUntil: 'domcontentloaded'});
    assert(await page.evaluate(() => document.body.classList.contains('gated')), 'next load starts cold, at the gate');
    await page.waitForFunction(() => !document.getElementById('gateAccount').hidden, null, {timeout: 5000});

    // 5. Admin again; sign-out drops the saved copy.
    sb.users.find(u => u.id === 'u-admin').role = 'admin';
    await page.goto('http://127.0.0.1:8000/tracker.html', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.body.classList.contains('gated') && document.body.innerText.includes('Uy residence kitchen'), null, {timeout: 5000});
    await page.waitForFunction(() => !!sessionStorage.getItem('ritehome_warm_v1'));
    const other = await ctx.newPage();
    await sb.attach(other); await other.route('https://fonts.googleapis.com/**', r => r.abort());
    await other.goto('http://127.0.0.1:8000/tracker.html', {waitUntil: 'domcontentloaded'});
    assert(await other.evaluate(() => document.body.classList.contains('connecting')), 'a new tab starts cold: nothing is shared between tabs');
    await other.close();
    await page.locator('#forgetKeyBtn').evaluate(b => b.click());
    await page.waitForEvent('load');
    assert.equal(await warm(), null, 'sign-out drops the saved copy');

    assert.deepEqual(errors, []);
    console.log('PASS warm start: cold first load, instant workspace switches on an 800 ms backend, fresh data behind, revoked role ends at the gate, new tab cold, sign-out clears.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
