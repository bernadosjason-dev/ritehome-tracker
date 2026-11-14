// v4.6 year-end tax on the Attendance page's Pay tab, against the real SQL. Figures by hand (made-up rate):
//   Dina, daily 1,500, December 2025, all 27 working days. Dec 1-15 approved: 19,500, tax 1,504.10.
//   Earlier pay (this employer, Jan-Nov): taxable 300,000, tax withheld 10,000.
//   Before December's second run: taxable 300,000 + 19,500 = 319,500 -> 15% x 69,500 = 10,425; withheld 11,504.10 -> refund 1,079.10.
//   Dec 16-31: 21,000 less SSS 1,750, PhilHealth 1,012.50, Pag-IBIG 200 = 18,037.50 taxable.
//   Year 337,537.50 -> 15% x 87,537.50 = 13,130.63; less 11,504.10 withheld = 1,626.53 withheld now; net 21,000 - 2,962.50 - 1,626.53 = 16,410.97.
// Needs `node tests/fixtures/serve.cjs`.  node tests/annual-tax.browser.cjs
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
  for (let d = 1; d <= 31; d++) {
    if ([7, 14, 21, 28].includes(d)) continue;
    const dd = String(d).padStart(2, '0');
    for (const [k, hm] of [['am_in', '08:00'], ['am_out', '12:00'], ['pm_in', '13:00'], ['pm_out', '17:00']])
      rows.push(`('${U.designer}', '${k}', '2025-12-${dd} ${hm}+08', '2025-12-${dd}', 8.48, 124.65, 5, 'x.jpg', '{}')`);
  }
  must('super', `set session_replication_role = replica; insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values ${rows.join(',')};`);
  must('book', `select public.salary_rate_add(${j({user_id: U.designer, effective_from: '2025-12-01', salary_type: 'daily', rate: '1500'})})`);
  const r1 = JSON.parse(must('book', `select public.payroll_run_prepare('2025-12-05')`));
  must('book', `select public.payroll_run_submit('${r1.id}')`);
  must('admin', `select public.payroll_run_decide('${r1.id}', 'approved', '')`);
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
    const year2025 = async () => { await page.locator('#yeCard').waitFor(); await page.locator('#yeYear').fill('2025'); await page.locator('#yeYear').dispatchEvent('change');
      await page.locator('#yeCard tr[data-ye="Dina"]').waitFor(); };

    // 1. Bea prepares Dec 16-31; submitting is refused until Dina's earlier pay is in.
    await page.goto('http://127.0.0.1:8000/attendance', {waitUntil: 'domcontentloaded'});
    await as('u-book');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.locator('#runsCard').waitFor();
    await page.locator('#runDate').fill('2025-12-20');
    await page.locator('#runPrepare').click();
    await msg('Payroll prepared');
    await page.getByRole('button', {name: 'Submit for approval'}).first().click();
    await msg('Year-end tax needs the pay before the portal for: Dina');
    await year2025();
    assert.match(await page.locator('#yeBox').innerText(), /Pay before the portal is missing for Dina/);

    // 2. The form keeps what was typed when refused; saved, the card shows the year so far.
    await page.getByRole('button', {name: 'Add earlier pay…'}).click();
    await page.getByLabel('Taxable pay').fill('300,000');
    await page.getByLabel('Tax withheld').fill('10000');
    await page.locator('#lookBox').getByRole('button', {name: 'Save'}).click();
    assert.match(await page.locator('#lookBox .form-error').innerText(), /where the figures come from[\s\S]*Nothing you entered was lost/);
    assert.equal(await page.getByLabel('Taxable pay').inputValue(), '300,000');
    await page.getByLabel('Where the figures come from').fill('Old payroll Jan-Nov 2025');
    await page.locator('#lookBox').getByRole('button', {name: 'Save'}).click();
    await msg('Earlier pay saved');
    await page.locator('#yeYear').fill('2025'); await page.locator('#yeYear').dispatchEvent('change');
    await page.waitForFunction(() => /Refund ₱1,079\.10/.test(document.querySelector('#yeCard tr[data-ye="Dina"]').textContent));
    assert.match(await page.locator('#yeCard tr[data-ye="Dina"]').innerText(), /₱319,500\.00[\s\S]*₱10,425\.00[\s\S]*₱11,504\.10[\s\S]*Refund ₱1,079\.10/);
    assert.doesNotMatch(await page.locator('#yeBox').innerText(), /missing for Dina/);
    assert.equal(await page.getByRole('button', {name: 'Void earlier pay for Dina'}).count(), 0, 'only the admin voids');

    // 3. Recompute: the year-end adjustment replaces the ordinary tax; submit goes through.
    await page.getByRole('button', {name: 'Open payroll 2025-12-16'}).click();
    await page.getByRole('button', {name: 'Recompute'}).click();
    await msg('Recomputed');
    await page.getByRole('button', {name: 'Open payroll 2025-12-16'}).click();
    await page.waitForFunction(() => /₱1,626\.53[\s\S]*₱16,410\.97/.test(document.querySelector('#runBox tr[data-line="Dina"]').textContent));
    await page.getByRole('button', {name: 'Submit for approval'}).first().click();
    await msg('Submitted to the admin');

    // 4. Jason approves; Dina's payslip names the year-end line.
    await as('u-admin');
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.getByRole('button', {name: 'Open payroll 2025-12-16'}).click();
    answers.push('');
    await page.getByRole('button', {name: 'Approve payroll'}).click();
    await msg('Payroll approved');
    assert.equal(await page.getByLabel('Year-end tax adjustment').inputValue(), 'true');
    await year2025();
    assert.match(await page.locator('#yeCard tr[data-ye="Dina"]').innerText(), /₱13,130\.63[\s\S]*₱13,130\.63[\s\S]*—/);
    await page.screenshot({path: '/tmp/ritehome-year-end.png', fullPage: true});
    await as('u-designer');
    await page.locator('#slipsCard').waitFor();
    assert.match(await page.locator('#slipsList .slip').first().innerText(), /Withholding tax, year-end adjustment\s*− ₱1,626\.53[\s\S]*Net pay\s*₱16,410\.97/);
    assert.equal(await page.locator('#yeCard').isHidden(), true);

    // 5. Phone width.
    await as('u-admin');
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#attTabs [data-tab="pay"]').click();
    await year2025();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    assert.deepEqual(errors, []);
    console.log('PASS year-end tax: December run refused without earlier pay, form keeps input on a refusal, hand-worked year so far, recompute applies the adjustment, admin approves, payslip names it, setting shown, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
