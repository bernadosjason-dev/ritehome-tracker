// v4.7 Pag-IBIG remittance file: Government numbers form (names, program, MP2, chosen share) on the Attendance page, and
// Accounting → Compliance → "Download Pag-IBIG file", against the real SQL. The downloaded .xlsx is opened and read back.
// Made-up people, numbers and rates. October 2026, Sundays 4, 11, 18, 25, everyone works every working day.
//   Dina daily 600 and Sam daily 550: a month's pay is over 10,000, so Pag-IBIG EE 200 and ER 200 each (Circular 460).
// Needs `node tests/fixtures/serve.cjs`.  node tests/pagibig-file.browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('playwright');
const fflate = require('../vendor/fflate-0.8.2.js');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
(async () => {
  const {U, must} = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  U.sales = '00000000-0000-4000-8000-000000000005';
  const j = v => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}');
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';
    update public.compliance_settings set tracking_from = '2026-10-01';
    update public.company_profile set address = 'Test address, Cagayan de Oro City', phones = '0900 000 0000', email = 'office@example.com';`);
  const rows = [];
  for (let d = 1; d <= 31; d++) {
    if ([4, 11, 18, 25].includes(d)) continue;
    const dd = String(d).padStart(2, '0');
    for (const who of [U.designer, U.sales])
      for (const [k, hm] of [['am_in', '08:00'], ['am_out', '12:00'], ['pm_in', '13:00'], ['pm_out', '17:00']])
        rows.push(`('${who}', '${k}', '2026-10-${dd} ${hm}+08', '2026-10-${dd}', 8.48, 124.65, 5, 'x.jpg', '{}')`);
  }
  must('super', `set session_replication_role = replica; insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values ${rows.join(',')};`);
  must('book', `select public.salary_rate_add(${j({user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '600'})})`);
  must('book', `select public.salary_rate_add(${j({user_id: U.sales, effective_from: '2026-10-01', salary_type: 'daily', rate: '550'})})`);
  const approve = d => { const r = JSON.parse(must('book', `select public.payroll_run_prepare('${d}')`));
    must('book', `select public.payroll_run_submit('${r.id}')`); must('admin', `select public.payroll_run_decide('${r.id}', 'approved', '')`); };
  approve('2026-10-05');
  const sb = createFakeSupabase({rpc: pgRpc(db, {'u-admin': 'admin', 'u-designer': 'designer', 'u-book': 'book'}),
    users: [{id: 'u-book', email: 'book@ritehome.test', password: 'x', role: 'bookkeeper', active: true}]});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 900}, acceptDownloads: true});
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const as = async id => { await page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
      await page.reload({waitUntil: 'domcontentloaded'}); };
    const msg = t => page.waitForFunction(t => new RegExp(t).test(document.getElementById('acctMsg').textContent), t, {timeout: 10000})
      .catch(async () => { throw new Error('waiting for "' + t + '", page says: ' + await page.locator('#acctMsg').innerText()); });

    // 1. Bea enters Dina's names, MID and program in Government numbers.
    await page.goto('http://127.0.0.1:8000/attendance', {waitUntil: 'domcontentloaded'});
    await as('u-book');
    await page.waitForFunction(() => !document.getElementById('app').hidden);
    await page.locator('#attTabs [data-tab="pay"]').click();
    await page.getByRole('button', {name: 'Government numbers for Dina'}).click();
    await page.getByLabel('Last name').fill('Reyes');
    await page.getByLabel('First name').fill('Dina');
    await page.getByLabel('Middle name').fill('Lopez');
    await page.getByLabel('Pag-IBIG MID number').fill('121300001111');
    await page.getByLabel('Chosen Pag-IBIG monthly share').fill('150');
    await page.locator('#lookBox').getByRole('button', {name: 'Save'}).click();
    assert.match(await page.locator('#lookBox .form-error').innerText(), /at least 200[\s\S]*Nothing you entered was lost/);
    assert.equal(await page.getByLabel('Last name').inputValue(), 'Reyes');
    await page.getByLabel('Chosen Pag-IBIG monthly share').fill('');
    await page.locator('#lookBox').getByRole('button', {name: 'Save'}).click();
    await msg('Dina: government numbers saved');
    assert.equal(must('super', `select last_name || '|' || middle_name || '|' || pagibig_no || '|' || pagibig_program from public.employee_statutory where user_id = '${U.designer}'`), 'Reyes|Lopez|1213-0000-1111|pagibig1');

    // 2. Compliance → Pag-IBIG for October: refused until both payrolls are approved, the employer ID is in, and every member is complete.
    await page.goto('http://127.0.0.1:8000/accounting.html#compliance', {waitUntil: 'domcontentloaded'});
    await page.locator('#compList').waitFor();
    await page.locator('#compFrom').fill('2026-11-01'); await page.locator('#compFrom').dispatchEvent('change');
    const btn = () => page.getByRole('button', {name: 'Download Pag-IBIG file 2026-10'});
    await btn().waitFor();
    await btn().click();
    await msg('needs both payrolls of the month approved \\(1 of 2 so far\\)');
    approve('2026-10-20');
    await btn().click();
    await msg('Enter the Pag-IBIG employer ID');
    must('super', `update public.compliance_settings set pagibig_employer_id = '200000000001'`);
    await btn().click();
    await msg('Sam \\(no Pag-IBIG MID number, last and first name not entered\\)');
    must('admin', `select public.employee_statutory_save(${j({user_id: U.sales, last_name: 'Santos', first_name: 'Sam', name_ext: 'Jr', pagibig_no: '1214-2222-3333', hired_on: '2026-10-05'})})`);

    // 3. The file: Ritehome's layout, IDs kept as text, amounts as numbers, remarks only for this month's change.
    const [dl] = await Promise.all([page.waitForEvent('download'), btn().click()]);
    await msg('Pag-IBIG file for 2026-10: 2 members, EE ₱400\\.00, ER ₱400\\.00');
    assert.equal(dl.suggestedFilename(), 'PAGIBIG-200000000001-202610.xlsx');
    const files = fflate.unzipSync(new Uint8Array(fs.readFileSync(await dl.path())));
    assert.ok(files['[Content_Types].xml'] && files['xl/workbook.xml'] && files['xl/styles.xml']);
    const xml = fflate.strFromU8(files['xl/worksheets/sheet1.xml']);
    const cells = {};
    for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(?:<is><t[^>]*>([^<]*)<\/t><\/is>|<v>([^<]*)<\/v>)<\/c>/g)) cells[m[1]] = m[2] != null ? m[2] : Number(m[3]);
    assert.deepEqual([cells.A1, cells.B1, cells.B2, cells.B3, cells.B5], ['Employer ID No.', '200000000001', 'RITEHOME MODULAR SYSTEMS', 'TEST ADDRESS, CAGAYAN DE ORO CITY', 'office@example.com']);
    assert.deepEqual(['A8', 'C8', 'H8', 'I8', 'J8', 'K8'].map(c => cells[c]), ['Pag-IBIG MID NO.', 'MEMBERSHIP PROGRAM', 'PERCOV', 'EE SHARE', 'ER SHARE', 'REMARKS']);
    assert.deepEqual(['A9', 'C9', 'D9', 'E9', 'G9', 'H9', 'I9', 'J9', 'K9'].map(c => cells[c]), ['1213-0000-1111', 'F1-Pag-IBIG 1', 'REYES', 'DINA', 'LOPEZ', '202610', 200, 200, undefined]);
    assert.deepEqual(['A10', 'D10', 'F10', 'I10', 'J10', 'K10'].map(c => cells[c]), ['1214-2222-3333', 'SANTOS', 'JR', 200, 200, 'N 10/05/26']);
    assert.match(xml, /<c r="A9" t="inlineStr">/, 'the MID is a text cell');
    assert.deepEqual([cells.A12, cells.I12, cells.J12], ['TOTAL', 400, 400]);

    // 4. Staff can't open it; phone width.
    await as('u-designer');
    assert.equal(await page.getByRole('button', {name: /Download Pag-IBIG file/}).count(), 0);
    await as('u-book');
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#compFrom').fill('2026-11-01'); await page.locator('#compFrom').dispatchEvent('change');
    await btn().waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    assert.deepEqual(errors, []);
    console.log('PASS Pag-IBIG file: names/MID/program saved from Government numbers (form keeps input on a refusal), download refused until both payrolls approved, employer ID entered and members complete, .xlsx in Ritehome\'s layout with text IDs, numeric shares, this month\'s remark and totals, staff blocked, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
