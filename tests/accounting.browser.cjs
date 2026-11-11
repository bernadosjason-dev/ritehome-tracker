// accounting.html end to end in a real browser, with every database call answered by the real
// SQL (supabase/migrations on a throwaway local PostgreSQL, tests/fixtures/local-pg.cjs) and
// sign-in by tests/fixtures/fake-supabase.cjs. Covers the admin gate, the statements, posting
// and voiding a journal entry, VAT tags flowing into the VAT figures, settings, CSV export, and
// phone width. Needs the local server: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');

const db = startLocalPg();
const ACTOR = {'u-admin': 'admin', 'u-designer': 'designer'};
const literal = v => v === null || v === undefined ? 'null'
  : "'" + String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/'/g, "''") + "'";
const kind = {};
// What PostgREST does for supabase.rpc(name, args): call by named arguments, as the signed-in user.
function rpc(name, args, user) {
  if (!/^[a-z_]+$/.test(name)) return {data: null, error: {message: 'bad name'}};
  if (!kind[name]) kind[name] = db.must('super', `select case when proretset then 'set' when prorettype = 'void'::regtype then 'void' else 'one' end
    from pg_proc where proname = '${name}' and pronamespace = 'public'::regnamespace`);
  const call = `public.${name}(${Object.keys(args).map(k => `${k} => ${literal(args[k])}`).join(', ')})`;
  const q = kind[name] === 'set' ? `select coalesce(json_agg(t), '[]'::json) from ${call} t`
    : kind[name] === 'void' ? `select ${call}` : `select to_json(${call})`;
  const r = db.sql(user && ACTOR[user.id] ? ACTOR[user.id] : 'anon', q);
  if (!r.ok) return {data: null, error: {message: r.err.split('\n')[0].replace(/^ERROR:\s+/, '')}};
  return {data: kind[name] === 'void' ? null : JSON.parse(r.out), error: null};
}

(async () => {
  const {U, must} = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'designer@example.com', '{}');
    update public.profiles set role = 'admin', active = true where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';`);
  const y = new Date().getFullYear();
  must('admin', `insert into public.tracker_docs (collection, id, parent_id, data) values
    ('projects', 'P1', null, '{"name":"Ana kitchen","price":112000,"status":"active","billing":{"dp":{"received":56000,"receivedDate":"${y}-01-10"}}}'),
    ('projects', 'P2', null, '{"name":"Clinic partitions","price":40000,"status":"completed","billing":{"dp":{"received":40000,"receivedDate":"${y}-01-12"}}}'),
    ('expenses', 'E1', 'P1', '{"date":"${y}-01-12","item":"Marine plywood","category":"materials","amount":11200}'),
    ('expenses', 'E2', 'P1', '{"date":"${y}-01-15","item":"Crew lunch","category":"food","amount":800}');
    update public.acct_settings set books_start = '${y}-01-01';`);

  const sb = createFakeSupabase({rpc});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 900}, acceptDownloads: true});
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    if (process.env.DEBUG) page.on('console', m => console.log('console:', m.text()));
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const text = id => page.locator('#' + id).innerText();

    // 1. Signed out: sent to sign in, no figures. A designer is turned away.
    await page.goto('http://127.0.0.1:8000/accounting.html', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('gateTitle').textContent === 'Sign in first');
    assert(!await page.locator('#app').isVisible());
    await page.evaluate(() => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-u-designer', user: {id: 'u-designer', email: 'designer@ritehome.test'}})));
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('gateTitle').textContent === 'Accounting is for admins');

    // 2. The admin sees the status page with the tracker already in the books.
    //    P1 down payment 56,000 VATable (sales 50,000 + output 6,000); P2 40,000 VATable until tagged
    //    (35,714.29 + 4,285.71); costs 11,200 + 800 with no VAT invoices yet.
    await page.evaluate(() => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-u-admin', user: {id: 'u-admin', email: 'admin@ritehome.test'}})));
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('app').hidden && document.getElementById('statusKpis').textContent.includes('₱'));
    const kpis = await text('statusKpis');
    assert.match(kpis, /Cash and bank\s+₱84,000\.00/i, '56,000 + 40,000 - 11,200 - 800');
    assert.match(kpis, /Owed by clients\s+₱56,000\.00/i);
    assert.match(kpis, /₱85,714\.29/, 'sales to date, net of VAT');
    assert.match(await text('issueList'), /Ana kitchen is treated as VATable by default/);
    assert.equal(await page.locator('.side-link[aria-current="page"]').innerText(), 'Accounting', 'menu marks Accounting');

    // 3. Tag P2 non-VAT and the plywood as a VAT invoice: the VAT figures follow.
    await page.locator('.acct-tabs button[data-tab="tags"]').click();
    await page.locator('#tagProjects select').nth(1).selectOption('non_vat');   // sorted: Ana kitchen, Clinic partitions
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent.includes('Clinic partitions: Non-VAT'));
    await page.locator('#tagPurchases input[type="checkbox"]').nth(1).check();   // newest first: Crew lunch, Marine plywood
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent.includes('Marine plywood: VAT invoice'));
    assert.equal(must('admin', "select count(*) from public.acct_purchase_vat where doc_id = 'E1'"), '1');
    await page.locator('.acct-tabs button[data-tab="vat"]').click();
    await page.waitForFunction(() => document.getElementById('vatTable').textContent.includes('Q1'));
    const q1 = await page.locator('#vatTable tbody tr').first().innerText();
    assert.match(q1, /50,000\.00\s+40,000\.00\s+6,000\.00\s+1,200\.00\s+4,800\.00/, 'VATable 50,000, non-VAT 40,000, output 6,000, input 1,200, due 4,800');
    assert.match(await text('taxBox'), /Itemized deductions/);

    // 4. "Prepare entry" fills the settlement; posting it balances; it shows in the journal and can be voided.
    await page.locator('#vatTable button', {hasText: 'Prepare entry'}).first().click();
    await page.waitForFunction(() => location.hash === '#journal' && document.getElementById('entryMemo').value.startsWith('VAT settlement Q1'));
    assert.equal(await text('entryDiff'), 'Balanced');
    await page.locator('#postEntry').click();
    await page.waitForFunction(() => /Entry #\d+ posted/.test(document.getElementById('acctMsg').textContent));
    assert.match(await text('journalList'), /VAT settlement Q1/);
    assert.equal(must('admin', "select string_agg(account_code || ':' || debit || ':' || credit, ' ' order by id) from public.acct_lines"), '2100:6000.00:0.00 1300:0.00:1200.00 2110:0.00:4800.00');

    // 5. A hand entry: unbalanced can't post; balanced posts; void asks why and keeps it.
    await page.locator('#entryMemo').fill('January rent');
    await page.locator('#entryLines select').nth(0).selectOption('6030');
    await page.locator('#entryLines input.amt').nth(0).fill('15000');
    await page.locator('#entryLines select').nth(1).selectOption('1010');
    await page.locator('#entryLines input.amt').nth(3).fill('14000');
    assert.match(await text('entryDiff'), /Out by ₱1,000\.00/);
    assert(await page.locator('#postEntry').isDisabled());
    await page.locator('#entryLines input.amt').nth(3).fill('15000');
    await page.locator('#postEntry').click();
    await page.waitForFunction(() => document.getElementById('journalList').textContent.includes('January rent'));
    page.once('dialog', d => d.accept('Paid by the owner personally'));
    await page.locator('.acct-entry', {hasText: 'January rent'}).getByRole('button', {name: 'Void'}).click();
    await page.waitForFunction(() => document.getElementById('journalList').textContent.includes('Void: Paid by the owner personally'));

    // 6. Statements: trial balance balanced, balance sheet balanced, with CSV out.
    await page.locator('.acct-tabs button[data-tab="tb"]').click();
    await page.waitForFunction(() => document.getElementById('tbCheck').textContent === 'Balanced');
    const dl = page.waitForEvent('download');
    await page.locator('[data-csv="tb"]').click();
    const csv = fs.readFileSync(await (await dl).path(), 'utf8');
    assert.match(csv, /^﻿Ritehome Modular Systems/);
    assert.match(csv, /1010,Cash on hand,Asset,84000\.00,0\.00/);
    await page.locator('.acct-tabs button[data-tab="bs"]').click();
    await page.waitForFunction(() => document.getElementById('bsCheck').textContent === 'Assets = liabilities + equity');
    await page.locator('.acct-tabs button[data-tab="is"]').click();
    await page.waitForFunction(() => document.getElementById('isTable').textContent.includes('Net income'));
    assert.match(await text('isTable'), /Total revenue\s+90,000\.00/, '50,000 VATable + 40,000 non-VAT');

    // 7. Ledger with running balance; settings lock the period.
    await page.locator('.acct-tabs button[data-tab="ledger"]').click();
    await page.locator('#ledAccount').selectOption('1010');
    await page.waitForFunction(() => document.getElementById('ledTable').textContent.includes('Closing balance'));
    assert.match(await text('ledTable'), /Closing balance\s+84,000\.00/);
    await page.locator('.acct-tabs button[data-tab="settings"]').click();
    await page.locator('#sLocked').fill(y + '-03-31');
    await page.locator('#settingsForm button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Settings saved.');
    assert.equal(must('admin', 'select locked_through from public.acct_settings'), y + '-03-31');

    // 8. Phone width: no sideways scroll on the page itself.
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('.app-top button').click();
    await page.locator('.side-link', {hasText: 'Accounting'}).waitFor({state: 'visible'});
    await page.keyboard.press('Escape');
    for (const tab of ['status', 'tb', 'journal', 'tags']) {
      await page.evaluate(t => { location.hash = t; }, tab);
      await page.waitForTimeout(250);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no page overflow on ' + tab);
    }
    await page.evaluate(() => { location.hash = 'status'; });
    await page.waitForTimeout(300);
    await page.screenshot({path: '/tmp/ritehome-accounting-mobile.png', fullPage: true});
    await page.setViewportSize({width: 1280, height: 900});
    await page.screenshot({path: '/tmp/ritehome-accounting-desktop.png', fullPage: true});

    assert.deepEqual(errors, []);
    console.log('PASS accounting page: admin gate, status from tracker data, VAT tags -> VAT figures, settlement entry, post/void, TB/BS/IS balanced, CSV, ledger, settings lock, phone width.');
  } catch (e) {
    const p = browser.contexts()[0] && browser.contexts()[0].pages()[0];
    if (p) console.error('page state:', await p.evaluate(() => ({gate: document.getElementById('gateTitle').textContent + ' / ' + document.getElementById('gateText').textContent,
      msg: document.getElementById('acctMsg').textContent, hash: location.hash})).catch(() => null));
    throw e;
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
