// v4.1 payroll runs on the Attendance page's Pay tab, against the real SQL. Figures match
// tests/payroll-runs.test.cjs (by hand): Dina, daily 600 + 50 allowance, 13 days Oct 1-15, 20 min late:
// basic 7,775, allowance 650, gross 8,425; a 500 cash advance (approved) -> net 7,925.
// Needs `node tests/fixtures/serve.cjs`.  node tests/payroll-runs.browser.cjs
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
  const rows = [];
  for (let d = 1; d <= 15; d++) {
    if ([4, 11].includes(d)) continue;
    const dd = String(d).padStart(2, '0');
    for (const [k, hm] of [['am_in', d === 1 ? '08:20' : '08:00'], ['am_out', '12:00'], ['pm_in', '13:00'], ['pm_out', '17:00']])
      rows.push(`('${U.designer}', '${k}', '2026-10-${dd} ${hm}+08', '2026-10-${dd}', 8.48, 124.65, 5, 'x.jpg', '{}')`);
  }
  must('super', `set session_replication_role = replica; insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values ${rows.join(',')};`);
  must('book', `select public.salary_rate_add(${j({user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '600', daily_allowance: '50'})})`);
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
    const lineText = () => page.locator('#runBox tr[data-line="Dina"]').innerText();

    // 1. Bea prepares Oct 1-15, adds a cash advance (it waits for the admin), submits only once it's decided.
    await page.goto('http://127.0.0.1:8000/attendance', {waitUntil: 'domcontentloaded'});
    await as('u-book');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.locator('#runsCard').waitFor();
    await page.locator('#runDate').fill('2026-10-05');
    await page.locator('#runPrepare').click();
    await msg('Payroll prepared');
    await page.locator('#runBox tr[data-line="Dina"]').waitFor();
    assert.match(await lineText(), /13[\s\S]*₱7,775\.00[\s\S]*₱650\.00[\s\S]*₱8,425\.00/);
    await page.getByLabel('Adjustment amount').fill('500');
    await page.getByLabel('Kind of adjustment').selectOption('deduction');
    await page.getByRole('button', {name: 'Add adjustment'}).click();
    assert.match(await page.locator('#runBox .form-error').innerText(), /needs the person, the kind, an amount and the reason[\s\S]*Nothing you entered was lost/);
    await page.getByLabel('Adjustment reason').fill('Cash advance Oct 3');
    await page.getByRole('button', {name: 'Add adjustment'}).click();
    await msg('waits for the admin');
    await page.locator('#runBox [data-adj="Cash advance Oct 3"]').waitFor();
    assert.equal(await page.getByRole('button', {name: 'Approve Cash advance Oct 3'}).count(), 0, 'the bookkeeper cannot approve');
    await page.getByRole('button', {name: 'Submit for approval'}).click();
    await page.waitForFunction(() => /waiting for the admin/.test(document.getElementById('acctMsg').textContent));

    // 2. Jason approves the adjustment and, once submitted, the payroll.
    await as('u-admin');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.getByRole('button', {name: 'Open payroll 2026-10-01'}).click();
    await page.getByRole('button', {name: 'Approve Cash advance Oct 3'}).click();
    await msg('Adjustment approved');
    await page.waitForFunction(() => /₱7,925\.00/.test(document.querySelector('#runBox tr[data-line="Dina"]').textContent));
    await as('u-book');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.getByRole('button', {name: 'Open payroll 2026-10-01'}).click();
    await page.getByRole('button', {name: 'Submit for approval'}).click();
    await msg('Submitted to the admin');
    assert.equal(await page.getByRole('button', {name: 'Approve payroll'}).count(), 0);
    await as('u-admin');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.getByRole('button', {name: 'Open payroll 2026-10-01'}).click();
    answers.push('Matches the old sheet');
    await page.getByRole('button', {name: 'Approve payroll'}).click();
    await msg('Payroll approved');
    await page.screenshot({path: '/tmp/ritehome-payroll-run.png', fullPage: true});

    // 3. Bea records the release (a reference is required).
    await as('u-book');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.getByRole('button', {name: 'Open payroll 2026-10-01'}).click();
    answers.push('');
    await page.getByRole('button', {name: 'Record release…'}).click();
    await page.waitForFunction(() => /release reference/.test(document.getElementById('acctMsg').textContent));
    answers.push('Cash, signed payroll sheet #1');
    await page.getByRole('button', {name: 'Record release…'}).click();
    await msg('Release recorded');
    assert.equal(must('super', `select status || ' ' || release_ref from public.payroll_runs`), 'released Cash, signed payroll sheet #1');

    // 4. Dina sees her payslip, and only hers.
    await as('u-designer');
    await page.locator('#slipsCard').waitFor();
    const slip = await page.locator('#slipsList .slip').first().innerText();
    assert.match(slip, /Gross pay\s*₱8,425\.00[\s\S]*Cash advance Oct 3\s*− ₱500\.00[\s\S]*Net pay\s*₱7,925\.00/);
    assert.equal(await page.locator('#runsCard').isHidden(), true);
    await page.screenshot({path: '/tmp/ritehome-payslip.png', fullPage: true});

    // 5. Phone width.
    await page.setViewportSize({width: 390, height: 844}); await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('#slipsCard').waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    assert.deepEqual(errors, []);
    console.log('PASS payroll runs: bookkeeper prepares (hand-worked line), adjustment needs a reason and waits for the admin, submit blocked until decided, admin approves the payroll, release needs a reference, payslip shows only to its owner with gross, deductions and net, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
