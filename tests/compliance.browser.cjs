// v4.3 Compliance tab (accounting.html#compliance) against the real SQL. Same seed and figures as
// tests/compliance.test.cjs: October 1601-C 4,194.39 due Nov 10; PhilHealth due Nov 15, Nov 20 with a PEN ending in 7.
// Needs `node tests/fixtures/serve.cjs`.  node tests/compliance.browser.cjs
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
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.compliance_settings set tracking_from = '2026-10-01';`);
  const L = (run, who, name, v) => `('${run}', '${who}', '${name}', 'x', 'regular', 'daily', 600, 13, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ${v.slice(0, 7).join(', ')}, false, ${v[7]}, 0, '{}', '[]')`;
  must('super', `set session_replication_role = replica;
    insert into public.payroll_runs (id, period_start, period_end, release_date, status, contributions_timing, prepared_by) values
      ('00000000-0000-4000-8000-0000000000a1', '2026-10-01', '2026-10-15', '2026-10-15', 'released', 'second', '${U.book}'),
      ('00000000-0000-4000-8000-0000000000a2', '2026-10-16', '2026-10-31', '2026-10-29', 'approved', 'second', '${U.book}');
    insert into public.payroll_lines (run_id, user_id, name, role, employment_type, salary_type, daily_rate, days_worked, worked_minutes, deducted_minutes,
      unaccounted_days, basic_pay, premium, overtime_pay, allowance, adj_taxable, adj_nontaxable, adj_deductions, gross, taxable,
      sss_ee, sss_er, sss_ec, ph_ee, ph_er, pi_ee, pi_er, mwe, tax, net, basis, days) values
      ${L('00000000-0000-4000-8000-0000000000a1', U.book, 'Bea', [0, 0, 0, 0, 0, 0, 0, 2220.71])},
      ${L('00000000-0000-4000-8000-0000000000a2', U.designer, 'Dina', [925, 1850, 30, 404.38, 404.37, 200, 200, 0])},
      ${L('00000000-0000-4000-8000-0000000000a2', U.book, 'Bea', [1750, 3500, 30, 1202.08, 1202.07, 200, 200, 1973.68])};`);
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
      await page.reload({waitUntil: 'domcontentloaded'}); };
    const msg = t => page.waitForFunction(t => new RegExp(t).test(document.getElementById('acctMsg').textContent), t, {timeout: 10000})
      .catch(async () => { throw new Error('waiting for "' + t + '", page says: ' + await page.locator('#acctMsg').innerText()); });
    const item = c => page.locator('#compList [data-comp="' + c + '"]');
    const month = async d => { await page.locator('#compFrom').fill(d); await page.locator('#compFrom').dispatchEvent('change'); };

    // 1. Bea: November's deadlines for October, with the amount from approved payroll.
    await page.goto('http://127.0.0.1:8000/accounting.html#compliance', {waitUntil: 'domcontentloaded'});
    await as('u-book');
    await page.locator('#compList').waitFor();
    await month('2026-11-01');
    await item('deadline_1601c@2026-10').waitFor();
    assert.match(await item('deadline_1601c@2026-10').innerText(), /Due Nov 10, 2026[\s\S]*Amount: ₱4,194\.39/);
    assert.match(await item('deadline_sss@2026-10').innerText(), /Due Nov 30, 2026[\s\S]*₱8,085\.00/);
    assert.match(await item('deadline_philhealth@2026-10').innerText(), /Due Nov 15, 2026[\s\S]*weekend or holiday/);
    // 2. Recording a payment needs the reference; the form survives a refusal.
    await item('deadline_1601c@2026-10').getByRole('button', {name: 'Record payment…'}).click();
    await item('deadline_1601c@2026-10').getByRole('button', {name: 'Record payment', exact: true}).click();
    await page.waitForFunction(() => /reference number[\s\S]*Nothing you entered was lost/.test(document.querySelector('[data-comp="deadline_1601c@2026-10"] .form-error').textContent));
    await item('deadline_1601c@2026-10').getByLabel('Reference number').fill('LBP 778812');
    await item('deadline_1601c@2026-10').getByLabel('Date done').fill('2026-11-09');
    await item('deadline_1601c@2026-10').getByRole('button', {name: 'Record payment', exact: true}).click();
    await msg('payment recorded');
    await page.waitForFunction(() => /Done[\s\S]*Paid ₱4,194\.39 on Nov 9, 2026 · ref LBP 778812/.test(document.querySelector('[data-comp="deadline_1601c@2026-10"]').textContent));
    assert.equal(await item('deadline_1601c@2026-10').getByRole('button', {name: /^Void/}).count(), 0, 'the bookkeeper cannot void');
    // 3. The PEN moves PhilHealth; only the admin sets when tracking starts.
    assert.equal(await page.getByLabel('Track from').isDisabled(), true);
    await page.getByLabel('PhilHealth PEN').fill('12-345678901-7');
    await page.locator('#compSettings').getByRole('button', {name: 'Save'}).click();
    await msg('Employer registrations saved');
    await page.waitForFunction(() => /Due Nov 20, 2026/.test(document.querySelector('[data-comp="deadline_philhealth@2026-10"]').textContent));
    // 4. The admin voids a wrong record (a reason is required).
    await as('u-admin');
    await page.locator('#compList').waitFor(); await month('2026-11-01');
    await item('deadline_1601c@2026-10').waitFor();
    answers.push('Wrong bank reference');
    await item('deadline_1601c@2026-10').getByRole('button', {name: 'Void LBP 778812'}).click();
    await msg('Record voided');
    assert.doesNotMatch(await item('deadline_1601c@2026-10').innerText(), /^Done/);
    await page.screenshot({path: '/tmp/ritehome-compliance.png', fullPage: true});
    // 5. Staff can't open it; phone width.
    await as('u-designer');
    await page.waitForFunction(() => /Accounting is for the admin and the bookkeeper/.test(document.getElementById('gateTitle').textContent));
    await as('u-book'); await page.setViewportSize({width: 390, height: 844});
    await page.locator('#compList').waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    assert.deepEqual(errors, []);
    console.log('PASS compliance: deadlines by rule with the payroll amount, recording needs a reference (form kept), done only once paid, PEN moves PhilHealth, only the admin voids and sets tracking, staff refused, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
