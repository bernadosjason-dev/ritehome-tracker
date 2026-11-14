// v4.6 year-end tax adjustment (supabase/migrations/20261202000029_annual_tax.sql) on a real local PostgreSQL.
// Every peso was worked out by hand from RR 11-2018 Sec. 2.79(B)(5)(b): keep it that way. Rates are made up.
//
//   Annual table, 2023 onwards: 610,000 -> 22,500 + 20% x 210,000 = 64,500 (RR 11-2018 Illustration 15's income);
//   275,000 -> 15% x 25,000 = 3,750 (its Mr. Gerry); 250,000 -> 0; 8,500,000 -> 2,202,500 + 35% x 500,000 = 2,377,500.
//
//   December 2025 (Sundays 7, 14, 21, 28; no holidays in this database): Dec 1-15 has 13 working days, Dec 16-31 has 14.
//   Everyone works every working day 8-12 and 1-5. Contributions on the 16-31 cutoff (the default).
//   Bea, monthly 50,000. Jan-Nov (old payroll): taxable 520,000, 13th month and other benefits 80,000, tax withheld 60,000.
//     2025 13th month approved: 50,000. Benefits 130,000 - cap 90,000 = 40,000 taxable.
//     Dec 1-15: 25,000 taxable, semi-monthly tax 937.50 + 20% x 8,333 = 2,604.10.
//     Dec 16-31: 25,000; SSS on 50,000 -> MSC 35,000 -> 1,750; PhilHealth 50,000 x 5% / 2 = 1,250; Pag-IBIG 200: 3,200.
//       This cutoff's taxable 21,800. Year: 520,000 + 25,000 + 21,800 + 40,000 = 606,800 -> 22,500 + 20% x 206,800 = 63,860.
//       Withheld before: 60,000 + 2,604.10 = 62,604.10. Adjustment withheld now: 1,255.90. Net 25,000 - 3,200 - 1,255.90 = 20,544.10.
//       (Without the adjustment: semi-monthly on 21,800 = 937.50 + 20% x 5,133 = 1,964.10.)
//   Dina, daily 1,500, hired Dec 1 2025 (no earlier pay needed).
//     Dec 1-15: 13 x 1,500 = 19,500, tax 937.50 + 20% x 2,833 = 1,504.10.
//     Dec 16-31: 14 x 1,500 = 21,000; SSS on 40,500 -> 1,750; PhilHealth 40,500 x 5% / 2 = 1,012.50; Pag-IBIG 200: 2,962.50.
//       Year 19,500 + 18,037.50 = 37,537.50 -> 0 tax. Refund 1,504.10 with this pay: net 21,000 - 2,962.50 + 1,504.10 = 19,541.60.
//   Sam, daily 800, no hire date and no earlier pay: the 16-31 run can't be submitted until it's entered.
//   node --test tests/annual-tax.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db, run2;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const J = (who, sql) => JSON.parse(db.must(who, `select ${sql}`));
const line = (run, name) => run.lines.find((l) => l.name === name);
const person = (o, name) => o.people.find((p) => p.name === name);

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  U.sales = '00000000-0000-4000-8000-000000000005';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';`);
  const rows = [];
  for (let d = 1; d <= 31; d++) {
    if ([7, 14, 21, 28].includes(d)) continue;
    const dd = String(d).padStart(2, '0');
    for (const who of [U.book, U.designer, U.sales])
      for (const [k, hm] of [['am_in', '08:00'], ['am_out', '12:00'], ['pm_in', '13:00'], ['pm_out', '17:00']])
        rows.push(`('${who}', '${k}', '2025-12-${dd} ${hm}+08', '2025-12-${dd}', 8.48, 124.65, 5, 'x.jpg', '{}')`);
  }
  must('super', `set session_replication_role = replica;
    insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values ${rows.join(',')};`);
  must('admin', `select public.salary_rate_add(${j({ user_id: U.book, effective_from: '2025-12-01', salary_type: 'monthly', rate: '50000' })})`);
  must('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2025-12-01', salary_type: 'daily', rate: '1500' })})`);
  must('book', `select public.salary_rate_add(${j({ user_id: U.sales, effective_from: '2025-12-01', salary_type: 'daily', rate: '800' })})`);
  must('book', `select public.employee_statutory_save(${j({ user_id: U.designer, hired_on: '2025-12-01' })})`);
  // The 2025 13th month, approved (seeded directly: its own workflow is tested in thirteenth.test.cjs).
  must('super', `set session_replication_role = replica;
    insert into public.thirteenth_runs (id, year, status, prepared_by, approved_by, approved_at) values ('11111111-1111-4111-8111-111111111111', 2025, 'approved', '${U.book}', '${U.admin}', now());
    insert into public.thirteenth_lines values ('11111111-1111-4111-8111-111111111111', '${U.book}', 'Bea', 0, 0, 0, 50000, 50000, 90000, 0, '2025-12-31');`);
  const r1 = J('book', `public.payroll_run_prepare('2025-12-05')`);
  assert.deepEqual([line(r1, 'Bea').tax, line(r1, 'Dina').tax, line(r1, 'Sam').tax], [2604.10, 1504.10, 0]);
  must('book', `select public.payroll_run_submit('${r1.id}')`);
  must('admin', `select public.payroll_run_decide('${r1.id}', 'approved', '')`);
});
test.after(() => db && db.stop());

test('the annual table, by hand from RR 11-2018', () => {
  const tax = (x) => J('super', `public.stat_annual_tax(${x}, '2025-12-31')`).tax;
  assert.deepEqual([tax(610000), tax(275000), tax(250000), tax(8500000), tax(0)], [64500, 3750, 0, 2377500, 0]);
  const r = J('super', `public.stat_annual_tax(606800, '2025-12-31')`);
  assert.deepEqual([r.tax, r.bracket_from, r.rule_status], [63860, 400000, 'pending_review']);
  assert.equal(J('super', `public.stat_annual_tax(1000000, '2022-06-30')`).error, 'No annual tax table in force on 2022-06-30');
  db.refused('book', `select public.stat_annual_tax(1, current_date)`, /permission denied/);
});

test('earlier pay: kept by the books, never their own, void-only by the admin', () => {
  const { U, must, refused } = db;
  const bea = { user_id: U.book, year: 2025, source: 'this_employer', taxable: '520000', benefits: '80000', tax_withheld: '60000', reference: 'Old payroll Jan-Nov 2025' };
  refused('designer', `select public.tax_year_earlier_add(${j(bea)})`, /Only the admin and the bookkeeper/);
  refused('book', `select public.tax_year_earlier_add(${j(bea)})`, /Only the admin enters your own pay/);
  refused('admin', `select public.tax_year_earlier_add(${j({ ...bea, reference: '' })})`, /where the figures come from/);
  refused('admin', `select public.tax_year_earlier_add(${j({ ...bea, taxable: '520,000' })})`, /pesos/);
  refused('admin', `select public.tax_year_earlier_add(${j({ ...bea, source: 'previous_employer' })})`, /employer's name/);
  const wrong = J('admin', `public.tax_year_earlier_add(${j({ ...bea, taxable: '502000' })})`);
  refused('book', `select public.tax_year_earlier_void('${wrong.id}', 'typo')`, /Only the admin voids/);
  refused('super', `update public.tax_year_earlier set taxable = 520000 where id = '${wrong.id}'`, /isn't edited/);
  refused('super', `delete from public.tax_year_earlier where id = '${wrong.id}'`, /void the entry/);
  refused('book', `insert into public.tax_year_earlier (user_id, year, source, reference) values ('${U.sales}', 2025, 'this_employer', 'x x x')`, /permission denied/);
  must('admin', `select public.tax_year_earlier_void('${wrong.id}', 'Typed 502,000 for 520,000')`);
  must('admin', `select public.tax_year_earlier_add(${j(bea)})`);
  assert.equal(db.must('designer', `select count(*) from public.tax_year_earlier`), '0');
});

test('December 16-31: the year-end adjustment, by hand; a missing history blocks the submit; the setting turns it off', () => {
  const { U, must, refused } = db;
  run2 = J('book', `public.payroll_run_prepare('2025-12-20')`);
  const b = line(run2, 'Bea'), d = line(run2, 'Dina'), s = line(run2, 'Sam');
  assert.deepEqual([b.sss_ee, b.ph_ee, b.pi_ee], [1750, 1250, 200]);
  const bw = b.basis.withholding;
  assert.deepEqual([bw.year_end, bw.this_cutoff, bw.annual_taxable, bw.annual_tax, bw.withheld_before, bw.adjustment, bw.unwithheld],
    ['adjusted', 21800, 606800, 63860, 62604.10, 1255.90, 0]);
  assert.deepEqual([b.tax, b.net], [1255.90, 20544.10]);
  assert.deepEqual([d.sss_ee, d.ph_ee, d.pi_ee, d.basis.withholding.annual_taxable, d.basis.withholding.annual_tax, d.tax, d.net],
    [1750, 1012.50, 200, 37537.50, 0, -1504.10, 19541.60]);
  assert.equal(s.basis.withholding.year_end, 'missing_history');
  refused('book', `select public.payroll_run_submit('${run2.id}')`, /Year-end tax needs the pay before the portal for: Sam\./);

  // Off: the ordinary semi-monthly table.
  refused('book', `select public.payroll_settings_save(${j({ year_end_adjustment: false })})`, /Only the admin changes the payroll settings/);
  must('admin', `select public.payroll_settings_save(${j({ year_end_adjustment: false })})`);
  let r = J('book', `public.payroll_run_recompute('${run2.id}')`);
  assert.deepEqual([line(r, 'Bea').tax, line(r, 'Bea').basis.withholding.year_end], [1964.10, undefined]);
  must('admin', `select public.payroll_settings_save(${j({ year_end_adjustment: true })})`);

  must('book', `select public.tax_year_earlier_add(${j({ user_id: U.sales, year: 2025, source: 'this_employer', reference: 'No pay before December 2025' })})`);
  r = J('book', `public.payroll_run_submit('${run2.id}')`);
  assert.deepEqual([line(r, 'Bea').tax, line(r, 'Dina').tax, line(r, 'Sam').tax, line(r, 'Sam').basis.withholding.year_end], [1255.90, -1504.10, 0, 'adjusted']);
  must('admin', `select public.payroll_run_decide('${run2.id}', 'approved', '')`);
});

test('the 2316 figures for the year: everything withheld equals the tax due once December is approved', () => {
  const { refused } = db;
  refused('designer', `select public.annual_tax_list(2025)`, /admin and the bookkeeper/);
  refused('book', `select public.annual_tax_person('00000000-0000-4000-8000-000000000007', 2025, null, null)`, /permission denied/);
  const o = J('book', `public.annual_tax_list(2025)`);
  assert.deepEqual(o.people.map((p) => p.name), ['Bea', 'Dina', 'Sam'], 'the admin has no pay, so no 2316');
  const b = person(o, 'Bea'), d = person(o, 'Dina');
  assert.deepEqual([b.taxable, b.annual_tax, b.withheld, b.difference, b.benefits, b.benefits_excess, b.thirteenth],
    [606800, 63860, 63860, 0, 130000, 40000, 50000]);
  assert.deepEqual([b.earlier.gross, b.portal.gross, b.gross], [600000, 50000, 700000]);   // 520,000 + 80,000 earlier; 25,000 x 2; + 50,000 13th
  assert.deepEqual([d.taxable, d.annual_tax, d.withheld, d.difference, d.history_complete], [37537.50, 0, 0, 0, true]);
  assert.deepEqual([b.december.tax, d.december.tax], [1255.90, -1504.10]);
  assert.equal(o.december_run.status, 'approved');
  assert.equal(o.rule.code, 'bir_annual_income_tax');
  assert.equal(o.earlier.length, 2);
  const mods = db.must('super', `select string_agg(distinct module, ',') from public.audit_log where table_name = 'tax_year_earlier'`);
  assert.equal(mods, 'Payroll');
});

test('payslips: each person sees the year-end line as theirs, a refund as a refund', () => {
  const slips = JSON.parse(db.must('designer', `select public.payslips_mine()`));
  const dec = slips.find((s) => s.period_start === '2025-12-16');
  assert.deepEqual([dec.year_end, dec.tax, dec.net, dec.basis], ['adjusted', -1504.10, 19541.60, undefined]);
  assert.equal(slips.find((s) => s.period_start === '2025-12-01').year_end, null);
  assert.ok(slips.every((s) => s.name === 'Dina'));
});
