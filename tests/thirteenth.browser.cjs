// v4.5 13th-month pay on the Attendance page's Pay tab, against the real SQL. Figures by hand (made-up rate):
//   Dina, daily 600: Oct 1-15 approved payroll, 13 days, 20 min late -> basic 7,775. Earlier (Jan-Sep) 54,000.
//   To date (54,000 + 7,775) / 12 = 61,775 / 12 = 5,147.92.
//   Rest of the year from Oct 16: Oct 14 + Nov 25 + Dec 27 Mon-Sat days (no holidays here) = 66 x 600 = 39,600.
//   Projected (61,775 + 39,600) / 12 = 101,375 / 12 = 8,447.92 (what the run pays before the year ends).
// Needs `node tests/fixtures/serve.cjs`.  node tests/thirteenth.browser.cjs
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
const yearOver = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) > '2026-12-31';
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
  must('book', `select public.salary_rate_add(${j({user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '600'})})`);
  const run = JSON.parse(must('book', `select public.payroll_run_prepare('2026-10-05')`));
  must('book', `select public.payroll_run_submit('${run.id}')`);
  must('admin', `select public.payroll_run_decide('${run.id}', 'approved', '')`);
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
    const payTab = async () => { await page.locator('#attTabs [data-tab="pay"]').click(); await page.locator('#thCard tr[data-th="Dina"]').waitFor(); };
    const row = () => page.locator('#thCard tr[data-th="Dina"]').innerText();

    // 1. Bea: the card warns that earlier earnings are missing; the form keeps what was typed on a refusal.
    await page.goto('http://127.0.0.1:8000/attendance', {waitUntil: 'domcontentloaded'});
    await as('u-book');
    await payTab();
    assert.match(await page.locator('#thBox').innerText(), /No earlier earnings for Dina/);
    assert.match(await row(), /₱7,775\.00[\s\S]*₱39,600\.00[\s\S]*₱647\.92[\s\S]*₱3,947\.92/);
    await page.getByRole('button', {name: 'Add earlier earnings…'}).click();
    await page.getByLabel('Person', {exact: true}).selectOption({label: 'Dina'});
    await page.getByLabel('Basic salary earned').fill('54,000');
    await page.locator('#lookBox').getByRole('button', {name: 'Save'}).click();
    assert.match(await page.locator('#lookBox .form-error').innerText(), /where it comes from[\s\S]*Nothing you entered was lost/);
    assert.equal(await page.getByLabel('Basic salary earned').inputValue(), '54,000');
    await page.getByLabel('Where it comes from').fill('Old payroll sheets Jan-Sep 2026');
    await page.locator('#lookBox').getByRole('button', {name: 'Save'}).click();
    await msg('Earlier earnings saved');
    await page.waitForFunction(() => /₱5,147\.92/.test(document.querySelector('#thCard tr[data-th="Dina"]').textContent));
    assert.match(await row(), /₱54,000\.00[\s\S]*₱7,775\.00[\s\S]*₱39,600\.00[\s\S]*₱5,147\.92[\s\S]*₱8,447\.92/);
    assert.doesNotMatch(await page.locator('#thBox').innerText(), /No earlier earnings/);
    assert.equal(await page.getByRole('button', {name: 'Void earlier earnings for Dina'}).count(), 0, 'only the admin voids');

    // 2. Bea prepares and submits; she can't approve.
    await page.getByRole('button', {name: 'Prepare 2026 13th month'}).click();
    await msg('13th month prepared');
    const pay = yearOver ? '₱5,147.92' : '₱8,447.92';
    await page.waitForFunction(p => document.querySelector('#thCard tr[data-th="Dina"]').textContent.includes(p), pay);
    await page.getByRole('button', {name: 'Submit for approval'}).last().click();
    await msg('Submitted to the admin');
    assert.equal(await page.getByRole('button', {name: 'Approve 13th month'}).count(), 0);

    // 3. Jason approves (the rule is still waiting for the accountant: the card says so).
    await as('u-admin');
    await payTab();
    assert.match(await page.locator('#thBox').innerText(), /waiting for the accountant's review/);
    answers.push('Checked against the old sheets');
    await page.getByRole('button', {name: 'Approve 13th month'}).click();
    await msg('13th month approved');
    assert.match(await page.locator('#thBox').innerText(), /Approved by Jason/);
    await page.screenshot({path: '/tmp/ritehome-13th-month.png', fullPage: true});

    // 4. Dina sees her own 13th month once approved, and no Pay tab.
    await as('u-designer');
    await page.locator('#myThCard').waitFor();
    assert.match(await page.locator('#myThList tr[data-my-th="2026"]').innerText(), new RegExp(pay.replace(/[₱.]/g, '\\$&')));
    assert.equal(await page.locator('#thCard').isHidden(), true);

    // 5. Phone width, Pay tab as the admin.
    await as('u-admin');
    await page.setViewportSize({width: 390, height: 844});
    await payTab();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    assert.deepEqual(errors, []);
    console.log('PASS 13th month: missing earlier earnings flagged, entry refused without a source keeps the form, hand-worked to-date and projected figures, bookkeeper prepares and submits, only the admin approves, pending rule shown as an estimate, staff see their own once approved, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
