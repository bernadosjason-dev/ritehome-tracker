// v4.7 Pag-IBIG remittance file and a member's chosen higher share (supabase/migrations/20261203000030_pagibig_file.sql),
// on a real local PostgreSQL. Figures by hand; names, numbers and rates are made up (never put real members here).
//
//   Pag-IBIG (Circular 460): EE 2%, ER 2% of pay up to 10,000 -> 200 / 200 for everyone below.
//   Bea (monthly 50,000) chose a 400 monthly share: 200 voluntary on top of the mandatory 200. ER stays 200.
//   November 2025, contributions split (half each cutoff): Bea 1-15 = 100 mandatory + 100 voluntary = 200, ER 100;
//     16-30 = (200 - 100) mandatory + (200 - 100) voluntary = 200, ER 100. Month: EE 400, ER 200.
//   December 2025, contributions on the 16-31 cutoff (the default), year-end adjustment off for this test:
//     Bea 16-31: SSS 1,750, PhilHealth 1,250, Pag-IBIG 200 + 200 voluntary = 400.
//     Withholding on 25,000 - 1,750 - 1,250 - 200 (only the mandatory share is excluded) = 21,800
//       -> 937.50 + 20% x 5,133 = 1,964.10. Net 25,000 - 1,750 - 1,250 - 400 - 1,964.10 = 19,635.90.
//   Remarks (MCRF): Dina hired Nov 1 2025 -> "N 11/01/25" in November only; Sam separated Dec 31 2025 -> "RS 12/31/25".
//   node --test tests/pagibig-file.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const J = (who, sql) => JSON.parse(db.must(who, `select ${sql}`));
const line = (run, name) => run.lines.find((l) => l.name === name);
const runMonth = (date) => {
  const r = J('book', `public.payroll_run_prepare('${date}')`);
  db.must('book', `select public.payroll_run_submit('${r.id}')`);
  db.must('admin', `select public.payroll_run_decide('${r.id}', 'approved', '')`);
  return J('book', `public.payroll_run_get('${r.id}')`);
};

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
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';
    update public.compliance_settings set pagibig_employer_id = '200000000001';
    update public.company_profile set address = 'Test address, Cagayan de Oro City', phones = '0900 000 0000', email = 'office@example.com';`);
  const rows = [];
  for (const [mm, days, sundays] of [['11', 30, [2, 9, 16, 23, 30]], ['12', 31, [7, 14, 21, 28]]])
    for (let d = 1; d <= days; d++) {
      if (sundays.includes(d)) continue;
      const dd = String(d).padStart(2, '0');
      for (const who of [U.book, U.designer, U.sales])
        for (const [k, hm] of [['am_in', '08:00'], ['am_out', '12:00'], ['pm_in', '13:00'], ['pm_out', '17:00']])
          rows.push(`('${who}', '${k}', '2025-${mm}-${dd} ${hm}+08', '2025-${mm}-${dd}', 8.48, 124.65, 5, 'x.jpg', '{}')`);
    }
  must('super', `set session_replication_role = replica;
    insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values ${rows.join(',')};`);
  must('admin', `select public.salary_rate_add(${j({ user_id: U.book, effective_from: '2025-11-01', salary_type: 'monthly', rate: '50000' })})`);
  must('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2025-11-01', salary_type: 'daily', rate: '1500' })})`);
  must('book', `select public.salary_rate_add(${j({ user_id: U.sales, effective_from: '2025-11-01', salary_type: 'daily', rate: '800' })})`);
  must('admin', `select public.payroll_settings_save(${j({ contributions_timing: 'split', year_end_adjustment: false })})`);
});
test.after(() => db && db.stop());

test('names, program, MP2 and a chosen share: kept in Government numbers, checked', () => {
  const { U, must, refused } = db;
  refused('admin', `select public.employee_statutory_save(${j({ user_id: U.book, pagibig_ee_monthly: '150' })})`, /at least 200/);
  refused('admin', `select public.employee_statutory_save(${j({ user_id: U.book, pagibig_ee_monthly: 'four hundred' })})`, /pesos, e\.g\. 400/);
  refused('admin', `select public.employee_statutory_save(${j({ user_id: U.book, mp2_account: '1234' })})`, /MP2 12/);
  refused('book', `select public.employee_statutory_save(${j({ user_id: U.book, pagibig_ee_monthly: '400' })})`, /Only the admin changes your own records/);
  const bea = J('admin', `public.employee_statutory_save(${j({ user_id: U.book, last_name: ' Cruz ', first_name: 'Bea', middle_name: 'Santos', pagibig_no: '121234567890',
    pagibig_program: 'pagibig2', mp2_account: '111122223333', pagibig_ee_monthly: '400' })})`);
  assert.deepEqual([bea.last_name, bea.pagibig_no, bea.mp2_account, bea.pagibig_program, bea.pagibig_ee_monthly], ['Cruz', '1212-3456-7890', '1111-2222-3333', 'pagibig2', 400]);
  must('book', `select public.employee_statutory_save(${j({ user_id: U.designer, last_name: 'Reyes', first_name: 'Dina', name_ext: 'Jr', pagibig_no: '1213-0000-1111', hired_on: '2025-11-01' })})`);
  must('book', `select public.employee_statutory_save(${j({ user_id: U.sales, separated_on: '2025-12-31' })})`);
});

test('November, split: the chosen share half on each cutoff; the file adds the cutoffs and marks the new hire', () => {
  const r1 = runMonth('2025-11-05');
  assert.deepEqual([line(r1, 'Bea').pi_ee, line(r1, 'Bea').pi_er, line(r1, 'Bea').basis.pagibig_voluntary, line(r1, 'Dina').pi_ee], [200, 100, 100, 100]);
  const r2 = runMonth('2025-11-20');
  assert.deepEqual([line(r2, 'Bea').pi_ee, line(r2, 'Bea').pi_er, line(r2, 'Bea').basis.pagibig_voluntary, line(r2, 'Dina').pi_ee], [200, 100, 100, 100]);
  const f = J('book', `public.pagibig_remittance('2025-11-15')`);
  assert.deepEqual([f.percov, f.complete, f.totals.members, f.totals.ee, f.totals.er], ['202511', true, 3, 800, 600]);
  const [b, d] = f.rows;
  assert.deepEqual([b.last_name, b.first_name, b.middle_name, b.mid, b.mp2, b.program, b.ee, b.er, b.remarks], ['Cruz', 'Bea', 'Santos', '1212-3456-7890', '1111-2222-3333', 'F1-Pag-IBIG 2', 400, 200, '']);
  assert.deepEqual([d.last_name, d.name_ext, d.program, d.ee, d.er, d.remarks], ['Reyes', 'Jr', 'F1-Pag-IBIG 1', 200, 200, 'N 11/01/25']);
  assert.deepEqual(f.employer, { id: '200000000001', name: 'Ritehome Modular Systems', address: 'Test address, Cagayan de Oro City', phones: '0900 000 0000', email: 'office@example.com' });
});

test('December, on the 16-31 cutoff: the chosen share is deducted but stays taxable; separation remarked; gaps flagged', () => {
  const { must, refused } = db;
  must('admin', `select public.payroll_settings_save(${j({ contributions_timing: 'second' })})`);
  runMonth('2025-12-05');
  let f = J('book', `public.pagibig_remittance('2025-12-01')`);
  assert.deepEqual([f.complete, f.totals.members], [false, 0], 'contributions come on the 16-31 cutoff, not yet approved');
  const r2 = runMonth('2025-12-20');
  const b = line(r2, 'Bea');
  assert.deepEqual([b.sss_ee, b.ph_ee, b.pi_ee, b.pi_er, b.basis.pagibig_voluntary, b.tax, b.net], [1750, 1250, 400, 200, 200, 1964.10, 19635.90]);
  f = J('book', `public.pagibig_remittance('2025-12-31')`);
  assert.deepEqual([f.percov, f.complete, f.totals.ee, f.totals.er], ['202512', true, 800, 600]);
  assert.deepEqual(f.rows.map((r) => r.name), ['Bea', 'Dina', 'Sam'], 'sorted by last name; Sam has none yet');
  const s = f.rows[2];
  assert.deepEqual([s.remarks, s.mid, s.problems], ['RS 12/31/25', '', ['no Pag-IBIG MID number', 'last and first name not entered']]);
  assert.equal(f.rows[1].remarks, '', 'a new hire is remarked only in the month hired');
  // The 2316 figures: the chosen extra is not a mandatory contribution.
  const y = J('book', `public.annual_tax_list(2025)`).people.find((p) => p.name === 'Bea');
  const sums = JSON.parse(db.must('super', `select json_build_object('contrib', sum(sss_ee + ph_ee + pi_ee), 'vol', sum((basis ->> 'pagibig_voluntary')::numeric))
    from public.payroll_lines where user_id = '${db.U.book}'`));
  assert.equal(sums.vol, 400);
  assert.equal(y.portal.contributions, sums.contrib - 400);
  refused('designer', `select public.pagibig_remittance('2025-12-01')`, /admin and the bookkeeper/);
  refused('anon', `select public.pagibig_remittance('2025-12-01')`, /permission denied/);
});
