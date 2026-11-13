// v3.3 pay on the Attendance page, against the real SQL (local PostgreSQL through pg-rpc).
// Figures match tests/salary.test.cjs (worked by hand): daily 600 (minute 1.25), allowance 50.
//   Oct 1 full day 650.00 · Oct 2 in 08:17 -> 600 - 21.25 + 50 = 628.75 · Oct 1-2 = 1,278.75
//   Oct 10 out 18:45, overtime 90 approved -> 650 + 140.63 = 790.63
// Needs `node tests/fixtures/serve.cjs` running.  node tests/salary.browser.cjs
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
(async () => {
  const {U, must} = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}');
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina', attendance_consent_at = now() where id = '${U.designer}';`);
  const P = (day, kind, hm) => `('${U.designer}', '${kind}', '2026-10-${day} ${hm}+08', '2026-10-${day}', 8.48, 124.65, 5, '${U.designer}/2026-10-${day}-${kind}.jpg', '{}')`;
  const full = (day, ai = '08:00', po = '17:00') => [P(day, 'am_in', ai), P(day, 'am_out', '12:00'), P(day, 'pm_in', '13:00'), P(day, 'pm_out', po)].join(', ');
  must('super', `set session_replication_role = replica;
    insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values
      ${full('01')}, ${full('02', '08:17')}, ${full('10', '08:00', '18:45')};`);
  const sb = createFakeSupabase({rpc: pgRpc(db, {'u-admin': 'admin', 'u-designer': 'designer', 'u-book': 'book'}),
    users: [{id: 'u-book', email: 'book@ritehome.test', password: 'x', role: 'bookkeeper', active: true}]});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await (await browser.newContext({viewport: {width: 1280, height: 900}})).newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const as = async id => { await page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
      await page.reload({waitUntil: 'domcontentloaded'}); await page.waitForFunction(() => !document.getElementById('app').hidden); };
    const msg = t => page.waitForFunction(t => new RegExp(t).test(document.getElementById('acctMsg').textContent), t, {timeout: 10000})
      .catch(async () => { throw new Error('waiting for "' + t + '", page says: ' + await page.locator('#acctMsg').innerText()); });
    const range = async (a, z) => { await page.locator('#payFrom').fill(a); await page.locator('#payFrom').dispatchEvent('change');
      await page.locator('#payTo').fill(z); await page.locator('#payTo').dispatchEvent('change'); };

    // 1. Bea (bookkeeper) sets Dina's rate; a bad amount keeps the form; her own rate is the admin's.
    await page.goto('http://127.0.0.1:8000/attendance', {waitUntil: 'domcontentloaded'});
    await as('u-book');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.locator('#ratesTable tr[data-rate="Dina"]').waitFor();
    assert.match(await page.locator('#ratesTable tr[data-rate="Bea"]').innerText(), /The admin sets yours/);
    await page.getByRole('button', {name: 'Rate for Dina'}).click();
    await page.getByLabel('Starts on').fill('2026-10-01');
    await page.getByLabel('Rate in pesos').fill('six hundred');
    await page.getByLabel('Allowance a day').fill('50');
    await page.getByRole('button', {name: 'Save rate'}).click();
    assert.match(await page.locator('#lookBox .form-error').innerText(), /Enter the rate in pesos/);
    await page.getByLabel('Rate in pesos').fill('600');
    await page.getByRole('button', {name: 'Save rate'}).click();
    await msg('Dina: new rate from');
    await page.waitForFunction(() => /₱600\.00 a day/.test(document.querySelector('#ratesTable tr[data-rate="Dina"]').textContent));
    // The settings are the admin's: the bookkeeper reads them.
    assert.equal(await page.getByLabel('Regular holiday, worked').isDisabled(), true);
    assert.equal(await page.getByRole('button', {name: 'Save settings'}).count(), 0);

    // 2. The hand-worked totals, with the late minutes deducted per minute.
    await range('2026-10-01', '2026-10-02');
    await page.waitForFunction(() => /₱1,278\.75/.test(document.querySelector('#payTable [data-person="Dina"] .amt').textContent));
    await page.locator('#payTable [data-person="Dina"] summary').click();
    assert.match(await page.locator('#payTable [data-person="Dina"] tr[data-day="2026-10-02"]').innerText(), /17 min[\s\S]*− ₱21\.25[\s\S]*₱628\.75/);
    assert.match(await page.locator('#payKpis').innerText(), /Deducted[\s\S]*₱21\.25/);
    await page.locator('#payStatus').selectOption('unaccounted');
    await page.waitForFunction(() => !document.querySelector('#payTable [data-person="Dina"]'));
    await page.locator('#payStatus').selectOption('');
    // Bea can't approve overtime.
    await page.locator('#attTabs [data-tab="team"]').click();
    await page.locator('#teamDate').fill('2026-10-10'); await page.locator('#teamDate').dispatchEvent('change');
    await page.waitForFunction(() => /₱650\.00/.test(document.querySelector('#teamTable tr[data-person="Dina"]').textContent));
    await page.getByRole('button', {name: 'Record for Dina'}).click();
    assert.equal(await page.locator('#lookBox select[aria-label="Kind of record"] option[value="overtime"]').count(), 0);
    await page.locator('#lookBox').getByRole('button', {name: 'Cancel'}).click();

    // 3. Jason approves 90 minutes of overtime; more than the clock-out allows is refused.
    await as('u-admin');
    await page.locator('#attTabs [data-tab="team"]').click();
    await page.locator('#teamDate').fill('2026-10-10'); await page.locator('#teamDate').dispatchEvent('change');
    await page.waitForFunction(() => /₱650\.00/.test(document.querySelector('#teamTable tr[data-person="Dina"]').textContent));
    await page.getByRole('button', {name: 'Record for Dina'}).click();
    await page.getByLabel('Kind of record').selectOption('overtime');
    await page.getByLabel('Overtime', {exact: true}).selectOption('120');
    await page.locator('#lookBox').getByRole('button', {name: 'Save record'}).click();
    await page.waitForFunction(() => /at most 90 minutes[\s\S]*Nothing you entered was lost/.test(document.querySelector('#lookBox .form-error').textContent));
    await page.getByLabel('Overtime', {exact: true}).selectOption('90');
    await page.locator('#lookBox').getByRole('button', {name: 'Save record'}).click();
    await msg('Dina: recorded for');
    await page.waitForFunction(() => /₱790\.63[\s\S]*\+ ₱140\.63 overtime/.test(document.querySelector('#teamTable tr[data-person="Dina"]').textContent));
    assert.match(await page.locator('#teamTable tr[data-person="Dina"]').innerText(), /Overtime approved: 1 h 30 min/);
    // The admin's settings: Save stays quiet until something changes.
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.getByLabel('Pay day on a Sunday or holiday').waitFor();
    assert.equal(await page.getByRole('button', {name: 'Save settings'}).isDisabled(), true);
    await page.getByLabel('Pay day on a Sunday or holiday').selectOption('later');
    await page.getByRole('button', {name: 'Save settings'}).click();
    await msg('Payroll settings saved');
    assert.equal(must('super', `select payday_rule from public.payroll_settings`), 'later');
    await page.screenshot({path: '/tmp/ritehome-pay.png', fullPage: true});

    // 4. Dina sees her own pay on her page, and no Pay tab.
    await as('u-designer');
    await page.locator('#myPayCard').waitFor();
    assert.match(await page.locator('#myPayKpis').innerText(), /This cutoff so far[\s\S]*Release[\s\S]*₱600\.00 a day/);
    assert.equal(await page.locator('#attTabs').isHidden(), true);

    // 5. Phone width: the Pay tab doesn't scroll sideways.
    await as('u-book'); await page.setViewportSize({width: 390, height: 844});
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.locator('#ratesTable tr[data-rate="Dina"]').waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    await page.screenshot({path: '/tmp/ritehome-pay-phone.png', fullPage: true});
    assert.deepEqual(errors, []);
    console.log('PASS salary: bookkeeper sets a rate (bad amount keeps the form, own rate is the admin\'s), hand-worked totals and per-minute deductions, filters, only the admin approves overtime (refused past the clock-out), settings quiet until changed, staff see their own pay, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
