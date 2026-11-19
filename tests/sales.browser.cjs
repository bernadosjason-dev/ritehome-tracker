// v4.8 Sales summary page (/sales) against the real SQL: the admin imports a made-up year from a workbook laid out like
// the office's SALES SUMMARY (built here with xlsx-write.js; never the real file), sets a quota, fixes a salesperson;
// sales add their own; the bookkeeper changes only status; other staff are turned away.
//   2025 (made up): Jan 301 Client A 100,000 · 302 Client B 50,000 "Paid/completed" · Feb 304 Client C 20,000 (no date)
//   · 305 cancelled 0. January 150,000; February 20,000; year 170,000. SC 303 missing.
// Needs `node tests/fixtures/serve.cjs`.  node tests/sales.browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {chromium} = require('playwright');
globalThis.fflate = require('../vendor/fflate-0.8.2.js');
const X = require('../xlsx-write.js');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-'));
const book = path.join(dir, 'SALES_SUMMARY_2025.xlsx');
fs.writeFileSync(book, X.build({sheet: 'MNTHLY SALES', rows: [
  ['SALES SUMMARY 2025'], [], ['500,000.00 INDIVIDUAL QUOTA PER MONTH'], [],
  ['JANUARY'], ['DATE', 'SC NO.', 'CUSTOMER', 'PROJECT', 'AMOUNT'],
  ['01.06.25', '301', 'Client A', 'Kitchen cabinet', {n: 100000}],
  ['1.20.25', '302', 'Client B', 'TV console', {n: 50000}, null, null, 'Paid/completed'],
  ['FEBRUARY'], ['DATE', 'SC NO.', 'CUSTOMER', 'PROJECT', 'AMOUNT'],
  [null, '304', 'Client C', 'Shoe rack', {n: 20000}],
  ['02.11.25', '305', 'cancelled', null, {n: 0}]]}));

(async () => {
  const {U, must} = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  U.sales = '00000000-0000-4000-8000-000000000005';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}');
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';`);
  const sb = createFakeSupabase({rpc: pgRpc(db, {'u-admin': 'admin', 'u-designer': 'designer', 'u-book': 'book', 'u-sales': 'sales'}),
    users: [{id: 'u-book', email: 'book@ritehome.test', password: 'x', role: 'bookkeeper', active: true},
      {id: 'u-sales', email: 'sales@ritehome.test', password: 'x', role: 'sales', active: true}]});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await (await browser.newContext({viewport: {width: 1280, height: 900}})).newPage(), errors = [], answers = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.type() === 'prompt' ? d.accept(answers.length ? answers.shift() : '') : d.accept());
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const as = async id => { await page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
      await page.reload({waitUntil: 'domcontentloaded'}); };
    const ready = () => page.waitForFunction(() => !document.getElementById('app').hidden || !document.getElementById('gate').hidden).catch(e => { throw new Error('page never opened; errors: ' + JSON.stringify(errors)); });
    const msg = t => page.waitForFunction(t => new RegExp(t).test(document.getElementById('acctMsg').textContent), t, {timeout: 10000})
      .catch(async () => { throw new Error('waiting for "' + t + '", page says: ' + await page.locator('#acctMsg').innerText()); });
    const year = async y => { await page.locator('#slYear').selectOption(String(y)); await page.waitForFunction(y => document.getElementById('slSub').textContent.startsWith(y + ':'), y); };

    // 1. The admin imports 2025 from the workbook: preview first, flags shown, then saved.
    await page.goto('http://127.0.0.1:8000/sales', {waitUntil: 'domcontentloaded'});
    await as('u-admin'); await ready();
    assert.equal(await page.locator('a.side-link[href="/sales"]').count(), 1, 'Sales summary is in the menu');
    await page.locator('#slFile').setInputFiles(book);
    await page.locator('#importBox tr[data-import="304"]').waitFor();
    const pv = await page.locator('#importBox').innerText();
    assert.match(pv, /2025 · sheet "MNTHLY SALES": 4 contracts, ₱170,000\.00/);
    assert.match(pv, /SC numbers missing from the list: 303/);
    assert.match(await page.locator('#importBox tr[data-import="304"]').innerText(), /no date: set to the 1st of february/);
    assert.equal(await page.getByLabel('Status for contracts without a note').inputValue(), 'paid', 'a past year defaults to paid');
    await page.getByRole('button', {name: 'Import 4 contracts for 2025'}).click();
    await msg('2025: 4 contracts imported');
    await page.waitForFunction(() => document.getElementById('slSub').textContent.startsWith('2025: ₱170,000.00 in 3 contracts'));
    assert.match(await page.locator('#monthsBox [data-month="1"] h3').innerText(), /January[\s\S]*₱150,000\.00 · 2 contracts/);
    assert.match(await page.locator('#monthsBox tr[data-sc="305"]').innerText(), /Cancelled/);
    assert.match(await page.locator('#checkBox').innerText(), /skipped in the register: 303[\s\S]*No salesperson: SC 301, 302, 304/);
    // Importing the same workbook again skips everything.
    await page.locator('#slFile').setInputFiles(book);
    await page.getByRole('button', {name: 'Import 4 contracts for 2025'}).click();
    await msg('0 contracts imported; already in the register, skipped: SC 301, 302, 304, 305');

    // 2. Quota and a salesperson.
    await page.getByLabel('Quota starts on').fill('2025-01-01');
    await page.getByLabel('Quota amount').fill('100,000');
    await page.getByRole('button', {name: 'Save quota'}).click();
    await msg('Quota saved');
    await page.getByRole('button', {name: 'Edit SC 301'}).click();
    await page.getByLabel('Salesperson').fill('MAE');
    await page.locator('#formCard').getByRole('button', {name: 'Save'}).click();
    await msg('SC 301 saved');
    await page.locator('#peopleBox tr[data-person="MAE"] td.hit').waitFor();
    assert.match(await page.locator('#peopleBox tr[data-person="MAE"]').innerText(), /100,000\.00[\s\S]*₱100,000\.00[\s\S]*1 of 12/);
    await page.screenshot({path: '/tmp/ritehome-sales.png', fullPage: true});

    // 3. Sam adds his own; he can't edit the imported ones.
    await as('u-sales'); await ready();
    if (!await page.locator('#gate').isHidden()) throw new Error('Sam got the gate: ' + await page.locator('#gate').innerText() + ' / ' + await page.locator('#acctMsg').innerText());
    await page.getByRole('button', {name: 'Add contract'}).click();
    assert.equal(await page.getByLabel('SC number').inputValue(), '306');
    assert.equal(await page.getByLabel('Salesperson').isDisabled(), true);
    await page.getByLabel('Customer').fill('Client D');
    await page.getByLabel('Amount').fill('75,000');
    await page.getByLabel('Project').fill('Wardrobe');
    await page.locator('#formCard').getByRole('button', {name: 'Add contract'}).click();
    await msg('SC 306 added');
    assert.match(await page.locator('#monthsBox tr[data-sc="306"]').innerText(), /Client D[\s\S]*₱75,000\.00[\s\S]*Sam/);
    await year(2025);
    assert.equal(await page.getByRole('button', {name: 'Edit SC 301'}).count(), 0);
    assert.equal(await page.locator('#importCard').isHidden(), true);

    // 4. The bookkeeper: status yes, amount no.
    await as('u-book'); await ready(); await year(2025);
    await page.getByRole('button', {name: 'Edit SC 304'}).click();
    assert.equal(await page.getByLabel('Amount').isDisabled(), true);
    await page.getByLabel('Status note').fill('Balance collected Mar 3');
    await page.locator('#formCard').getByRole('button', {name: 'Save'}).click();
    await msg('SC 304 saved');
    assert.equal(must('super', `select status_note from public.sales_contracts where sc_no = 304`), 'Balance collected Mar 3');

    // 5. Other staff are turned away; phone width.
    await as('u-designer'); await ready();
    assert.match(await page.locator('#gateTitle').innerText(), /for sales, the bookkeeper and the admin/);
    await as('u-admin'); await ready();
    await page.setViewportSize({width: 390, height: 844});
    await year(2025);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    assert.deepEqual(errors, []);
    console.log('PASS sales summary: workbook preview with flags and missing SC numbers, import (and a repeat import skipped), months and checks, quota and salesperson, sales add their own only, bookkeeper status only, others turned away, phone width.');
  } finally { await browser.close(); db.stop(); fs.rmSync(dir, {recursive: true, force: true}); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
