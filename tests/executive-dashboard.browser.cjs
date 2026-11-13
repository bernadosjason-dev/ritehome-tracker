// v4.2 executive dashboard on "/" against the real SQL (local PostgreSQL through pg-rpc). Same seed and
// hand-worked figures as tests/executive-dashboard.test.cjs: cash 105,000; still to collect 210,000; we owe
// 2,000; no forecast (1 month of books); Dina below minimum wage (critical); Ana kitchen design blocked.
// Also proves the page only reads: every database call it makes is on a read-only list.
// Needs `node tests/fixtures/serve.cjs`.  node tests/executive-dashboard.browser.cjs
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
const READS = new Set(['executive_overview', 'compliance_list', 'executive_calendar', 'schedule_board', 'dashboard_overview', 'my_roles', 'my_role', 'notify_list', 'acct_receivables', 'audit_refused']);
(async () => {
  const {U, must} = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  const j = v => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  const post = (date, memo, lines) => `select public.acct_post_entry('${date}', '${memo}', '${JSON.stringify(lines)}'::jsonb, '')`;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}');
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';`);
  must('admin', `insert into public.tracker_docs (collection, id, parent_id, data) values
    ('projects', 'P1', null, '{"name":"Ana kitchen","price":180000,"status":"active"}'),
    ('projects', 'P2', null, '{"name":"Office partitions","price":50000,"status":"completed","billing":{"dp":{"received":20000,"receivedDate":"2026-10-10"}}}');
    insert into public.acct_project_vat (project_id, treatment) values ('P2', 'non_vat');`);
  must('admin', post('2026-10-01', 'Opening balance', [{account: '1020', debit: 100000}, {account: '3010', credit: 100000}]));
  must('admin', post('2026-10-05', 'October rent', [{account: '6030', debit: 15000}, {account: '1020', credit: 15000}]));
  must('admin', post('2026-10-06', 'Internet bill', [{account: '6050', debit: 2000}, {account: '2010', credit: 2000}]));
  must('super', `set session_replication_role = replica;
    update public.project_stages set status = 'blocked', planned_start = (now() at time zone 'Asia/Manila')::date - 5, planned_end = (now() at time zone 'Asia/Manila')::date + 3 where project_id = 'P1' and stage = 'design';
    update public.project_stages set status = 'in_progress', planned_start = (now() at time zone 'Asia/Manila')::date - 20, planned_end = (now() at time zone 'Asia/Manila')::date - 10 where project_id = 'P1' and stage = 'cutlist';`);
  must('book', `select public.salary_rate_add(${j({user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '480'})})`);
  must('admin', `select public.salary_rate_add(${j({user_id: U.book, effective_from: '2026-10-01', salary_type: 'monthly', rate: '25000'})})`);
  const calls = [], real = pgRpc(db, {'u-admin': 'admin', 'u-designer': 'designer', 'u-book': 'book'});
  const sb = createFakeSupabase({rpc: (name, args, u) => { calls.push(name); return real(name, args, u); }});
  sb.seed('projects', 'P1', {name: 'Ana kitchen', status: 'active', price: 180000, updatedAt: '2026-11-01T00:00:00.000Z'});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    await page.addInitScript(() => {
      localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-u-admin', user: {id: 'u-admin', email: 'admin@ritehome.test'}}));
      localStorage.setItem('sb-laxavfldivkhufeubgmb-auth-token', JSON.stringify({user: {id: 'u-admin', email: 'admin@ritehome.test'}}));
    });
    await page.goto('http://127.0.0.1:8000/tracker.html', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('execDash').hidden, null, {timeout: 20000});
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-exec'));
    assert(await page.locator('#overviewSection').isHidden(), 'the old overview steps aside');

    // 1. Headline and money boxes, kept apart.
    assert.match(await page.locator('#dashTitle').innerText(), /critical risk.*₱105,000 cash in the books.*pay day/);
    assert.match(await page.locator('#exFinance .ex-actual').innerText(), /Actual · the books\s*₱105,000[\s\S]*In bank\s*₱85,000/);
    assert.match(await page.locator('#exFinance .ex-owed').innerText(), /₱210,000[\s\S]*2 contracts/);
    assert.match(await page.locator('#exFinance .ex-weowe').innerText(), /₱2,000[\s\S]*Supplier bills\s*₱2,000/);
    assert.match(await page.locator('#exCash .ex-forecast').innerText(), /No forecast yet[\s\S]*at least 6 full months/);
    assert.match(await page.locator('#exPayroll').innerText(), /This cutoff so far\s*Estimate[\s\S]*Rest of the cutoff\s*Forecast/);

    // 2. Risks: ranked, each with its reason.
    const crit = page.locator('.ex-sev-critical');
    assert.match(await crit.innerText(), /Dina is paid below the minimum wage/);
    await crit.locator('summary').first().click();
    assert.match(await crit.innerText(), /480\.00 against the 500\.00 minimum/);
    assert.match(await page.locator('.ex-sev-high').innerText(), /Ana kitchen · Design is blocked[\s\S]*Initial cutlist is 10 days late|Ana kitchen · Initial cutlist is 10 days late[\s\S]*Design is blocked/);

    // 3. Calendar: year view, then October; money in on Oct 10; the chip hides it.
    await page.locator('#exCalViews [data-view="year"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#exCalBody .ex-ymonth').length === 12);
    await page.locator('#exCalBody .ex-ymonth').nth(9).click();
    await page.waitForFunction(() => /Received ₱20,000/.test((document.querySelector('#exCalBody [data-day="2026-10-10"]') || {}).textContent || ''));
    assert.match(await page.locator('#exCalBody [data-day="2026-10-15"]').innerText(), /Pay day/);
    await page.locator('#exCalendar .ex-chip.cat-money_in').click();
    assert.doesNotMatch(await page.locator('#exCalBody [data-day="2026-10-10"]').innerText(), /Received/);
    await page.locator('#exCalViews [data-view="week"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#exCalBody .ex-day').length === 7);

    // 4. Gantt from the Schedule, read-only, with filters.
    await page.locator('#exGantt [data-stage="Ana kitchen/design"]').waitFor();
    assert.match(await page.locator('#exGantt [data-stage="Ana kitchen/design"]').innerText(), /Design\s*Blocked/);
    await page.locator('#exGantt select[aria-label="Status"]').selectOption('late');
    await page.waitForFunction(() => document.querySelectorAll('#exGantt .ex-g-row').length === 1);
    assert.match(await page.locator('#exGantt .ex-g-row').innerText(), /Initial cutlist\s*Late/);

    // 5. Read-only: no form inside the dashboard; every call it made reads.
    assert.equal(await page.locator('#execDash form, #execDash textarea').count(), 0);
    const writes = [...new Set(calls)].filter(n => !READS.has(n));
    assert.deepEqual(writes, [], 'the dashboard only reads');
    await page.screenshot({path: '/tmp/ritehome-exec.png', fullPage: true});

    // 6. Phone width.
    await page.setViewportSize({width: 390, height: 844}); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('execDash').hidden, null, {timeout: 20000});
    const wide = await page.evaluate(() => [document.documentElement.scrollWidth + ' vs ' + innerWidth].concat([...document.querySelectorAll('body *')]
      .filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.querySelector('*')).slice(0, 6)
      .map(e => e.tagName + '#' + e.id + '.' + String(e.className).slice(0, 40) + ' ' + Math.round(e.getBoundingClientRect().right))));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone: ' + wide.join(' | '));
    await page.screenshot({path: '/tmp/ritehome-exec-phone.png', fullPage: true});
    assert.deepEqual(errors, []);
    console.log('PASS executive dashboard: headline computed, actual / owed / we owe kept apart, no forecast without history, estimate and forecast labelled, risks ranked with reasons, calendar year/month/week with category filter, Gantt from the Schedule with filters, only reads, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
