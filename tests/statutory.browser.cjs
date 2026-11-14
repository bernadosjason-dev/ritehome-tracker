// v4.0 government contributions and statutory rules on the Pay tab, against the real SQL.
// Figures match tests/statutory.test.cjs (by hand): Dina 480 a day -> 12,520 a month, below the 500
// minimum (warned; minimum wage earner, no tax). SSS on 12,520 -> band 12,250-12,749.99 -> MSC 12,500:
// EE 625, ER 1,250 + 10 = 1,260. Needs `node tests/fixtures/serve.cjs`.  node tests/statutory.browser.cjs
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
(async () => {
  const {U, must} = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  const j = v => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}');
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina', attendance_consent_at = now() where id = '${U.designer}';`);
  must('book', `select public.salary_rate_add(${j({user_id: U.designer, effective_from: '2026-01-01', salary_type: 'daily', rate: '480'})})`);
  const sb = createFakeSupabase({rpc: pgRpc(db, {'u-admin': 'admin', 'u-designer': 'designer', 'u-book': 'book'}),
    users: [{id: 'u-book', email: 'book@ritehome.test', password: 'x', role: 'bookkeeper', active: true}]});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await (await browser.newContext({viewport: {width: 1280, height: 900}})).newPage(), errors = [], answers = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.type() === 'prompt' ? d.accept(answers.length ? answers.shift() : '') : d.accept());
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const as = async id => { await page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
      await page.reload({waitUntil: 'domcontentloaded'}); await page.waitForFunction(() => !document.getElementById('app').hidden); };
    const msg = t => page.waitForFunction(t => new RegExp(t).test(document.getElementById('acctMsg').textContent), t, {timeout: 10000})
      .catch(async () => { throw new Error('waiting for "' + t + '", page says: ' + await page.locator('#acctMsg').innerText()); });

    // 1. Bea: the minimum-wage warning, hand-worked SSS, rules waiting for review (no approve button for her).
    await page.goto('http://127.0.0.1:8000/attendance', {waitUntil: 'domcontentloaded'});
    await as('u-book');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.locator('#govTable tr[data-gov="Dina"]').waitFor();
    assert.match(await page.locator('#govTable .gov-warn').innerText(), /Dina is paid below the ₱500\.00 daily minimum wage/);
    const row = await page.locator('#govTable tr[data-gov="Dina"]').innerText();
    assert.match(row, /₱12,520\.00[\s\S]*₱625\.00 \/ ₱1,260\.00[\s\S]*None \(minimum wage earner\)/);
    assert.match(await page.locator('#rulesTable').innerText(), /18 rules are waiting for review/);
    assert.equal(await page.getByRole('button', {name: /^Approve /}).count(), 0);
    // Government numbers: a bad SSS number keeps the form; digits are formatted.
    await page.getByRole('button', {name: 'Government numbers for Dina'}).click();
    await page.getByLabel('SSS number').fill('12345');
    await page.locator('#lookBox').getByRole('button', {name: 'Save'}).click();
    await page.waitForFunction(() => /Check the numbers[\s\S]*Nothing you entered was lost/.test(document.querySelector('#lookBox .form-error').textContent));
    await page.getByLabel('SSS number').fill('3412345678');
    await page.getByLabel('TIN').fill('123456789');
    await page.locator('#lookBox').getByRole('button', {name: 'Save'}).click();
    await msg('Dina: government numbers saved');
    assert.equal(must('super', `select sss_no || ' ' || tin from public.employee_statutory where user_id = '${U.designer}'`), '34-1234567-8 123-456-789');
    await page.waitForFunction(() => /2 of 4/.test(document.querySelector('#govTable tr[data-gov="Dina"]').textContent));

    // 2. Jason approves the SSS rule, naming who checked it; an empty name is refused.
    await as('u-admin');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.locator('#rulesTable').getByRole('button', {name: /^Approve SSS contributions/}).waitFor();
    answers.push('');
    await page.locator('#rulesTable').getByRole('button', {name: /^Approve SSS contributions/}).click();
    await page.waitForFunction(() => /who checked it/.test(document.getElementById('acctMsg').textContent));
    answers.push('A. Cruz, CPA, 2026-11-20');
    await page.locator('#rulesTable').getByRole('button', {name: /^Approve SSS contributions/}).click();
    await msg('Rule approved');
    await page.waitForFunction(() => /Approved[\s\S]*Jason: A\. Cruz, CPA/.test(document.querySelector('#rulesTable tr[data-rule^="sss_contribution"]').textContent));
    assert.equal(must('super', `select status from public.statutory_rules where code = 'sss_contribution'`), 'approved');
    await page.screenshot({path: '/tmp/ritehome-statutory.png', fullPage: true});

    // 3. Dina has no Pay tab, and the API refuses her the overview.
    await as('u-designer');
    assert.equal(await page.locator('#attTabs').isHidden(), true);
    const r = await page.evaluate(async () => { const c = window.supabase.createClient('https://laxavfldivkhufeubgmb.supabase.co', 'x'); return (await c.rpc('statutory_overview', {p_date: '2026-11-13'})).error; });
    assert.match(String(r && r.message), /Only the admin and the bookkeeper/);

    // 4. Phone width.
    await as('u-book'); await page.setViewportSize({width: 390, height: 844});
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.locator('#govTable tr[data-gov="Dina"]').waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    assert.deepEqual(errors, []);
    console.log('PASS statutory: minimum-wage warning, hand-worked SSS on the Pay tab, MWE no tax, government numbers checked and formatted (form kept on error), only the admin approves a rule and must name who checked it, staff refused by the API, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
