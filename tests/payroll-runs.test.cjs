// v4.1 payroll runs (supabase/migrations/20261128000025_payroll_runs.sql) on a real local PostgreSQL.
// Every peso was worked out by hand: keep it that way.
//
//   October 2026, Sundays 4, 11, 18, 25; Oct 30 (Fri) a regular holiday. Contributions on the 16-end cutoff.
//   Dina, daily 600 (minute 1.25), allowance 50. Bea, monthly 50,000 (daily equivalent 50,000 x 12 / 313 = 1,916.93).
//   Oct 1-15 (13 working days):
//     Dina works all 13, in 08:20 on Oct 1 (late 20 = 25.00): basic 7,800 - 25 = 7,775; allowance 650; gross 8,425;
//       tax on 8,425 = 0 (under 10,417); net 8,425.
//     Bea works 12, absent Oct 7: basic 25,000 - 1,916.93 = 23,083.07; tax 937.50 + 20% x (23,083.07 - 16,667)
//       = 937.50 + 1,283.214 = 2,220.71; net 20,862.36.
//   Oct 16-31 (14 working days, Oct 30 a holiday):
//     Dina works 13, not Oct 30 (present Oct 29: holiday pay 600): basic 8,400; allowance 650; bonus 1,000 (taxable,
//       approved); cash advance 500 (deduction, approved); gross 10,050.
//       Month SSS basis 8,425 + 10,050 = 18,475 -> MSC 18,500: EE 925, ER 1,850 + EC 30.
//       PhilHealth on basic 7,775 + 8,400 = 16,175 -> 808.75: EE 404.38, ER 404.37. Pag-IBIG 200 / 200.
//       EE 1,529.38; taxable 10,050 - 1,529.38 = 8,520.62 -> tax 0; net 10,050 - 1,529.38 - 500 = 8,020.62.
//     Bea works 13 (the holiday is inside the monthly rate): basic 25,000.
//       SSS on 48,083.07 -> MSC 35,000: EE 1,750, ER 3,500 + 30. PhilHealth 48,083.07 x 5% = 2,404.15: EE 1,202.08, ER 1,202.07.
//       Pag-IBIG 200 / 200. EE 3,152.08; taxable 21,847.92 -> 937.50 + 20% x 5,180.92 = 1,973.68; net 19,874.24.
//   Split (Jan 1-15 2027, Dina): half a month at 15,650: SSS EE 387.50, ER 775.00, EC 15.00; PhilHealth 195.63 / 195.63;
//     Pag-IBIG 100 / 100.
//   node --test tests/payroll-runs.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db, run1, run2;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const J = (who, sql) => JSON.parse(db.must(who, `select ${sql}`));
const line = (run, name) => run.lines.find((l) => l.name === name);

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
  const day = (who, d, ai = '08:00') => { const dd = String(d).padStart(2, '0');
    for (const [k, hm] of [['am_in', ai], ['am_out', '12:00'], ['pm_in', '13:00'], ['pm_out', '17:00']])
      rows.push(`('${who}', '${k}', '2026-10-${dd} ${hm}+08', '2026-10-${dd}', 8.48, 124.65, 5, 'x.jpg', '{}')`); };
  for (let d = 1; d <= 31; d++) {
    if ([4, 11, 18, 25, 30].includes(d)) continue;
    day(U.designer, d, d === 1 ? '08:20' : '08:00');
    if (d !== 7) day(U.book, d);
  }
  must('super', `set session_replication_role = replica;
    insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values ${rows.join(',')};
    insert into public.project_events (kind, title, starts_at, ends_at, holiday_type) values ('holiday', 'Test regular holiday', '2026-10-30 00:00+08', '2026-10-30 23:59+08', 'regular');`);
  must('admin', `select public.attendance_record_add(${j({ user_id: U.book, date: '2026-10-07', kind: 'absent' })})`);
  must('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '600', daily_allowance: '50' })})`);
  must('admin', `select public.salary_rate_add(${j({ user_id: U.book, effective_from: '2026-10-01', salary_type: 'monthly', rate: '50000' })})`);
  must('book', `select public.salary_rate_add(${j({ user_id: U.sales, effective_from: '2026-10-01', salary_type: 'daily', rate: '550' })})`);
});
test.after(() => db && db.stop());

test('Oct 1-15: prepared by the bookkeeper, figures by hand; unaccounted days block it; the admin approves; the release is recorded', () => {
  const { U, must, refused } = db;
  refused('designer', `select public.payroll_run_prepare('2026-10-05')`, /Only the admin and the bookkeeper prepare payroll/);
  run1 = J('book', `public.payroll_run_prepare('2026-10-05')`);
  assert.deepEqual([run1.period_start, run1.period_end, run1.status], ['2026-10-01', '2026-10-15', 'draft']);
  refused('book', `select public.payroll_run_prepare('2026-10-09')`, /already prepared/);
  const d = line(run1, 'Dina'), b = line(run1, 'Bea');
  assert.deepEqual([d.days_worked, d.deducted_minutes, d.basic_pay, d.allowance, d.gross, d.sss_ee, d.tax, d.net], [13, 20, 7775, 650, 8425, 0, 0, 8425]);
  assert.deepEqual([b.basic_pay, b.tax, b.net, b.mwe], [23083.07, 2220.71, 20862.36, false]);
  // Sam has a rate and no records: the run can't go to the admin.
  refused('book', `select public.payroll_run_submit('${run1.id}')`, /Days not accounted for: Sam \(13\)/);
  must('super', `update public.profiles set active = false where id = '${U.sales}'`);
  const sub = J('book', `public.payroll_run_submit('${run1.id}')`);
  assert.equal(sub.status, 'submitted');
  assert.equal(sub.lines.length, 2);
  refused('book', `select public.payroll_run_decide('${run1.id}', 'approved', '')`, /Only the admin approves payroll/);
  refused('book', `select public.payroll_run_release('${run1.id}', 'BDO batch 1')`, /Only an approved payroll is released/);
  refused('admin', `select public.payroll_run_decide('${run1.id}', 'returned', '')`, /what needs fixing/);
  must('admin', `select public.payroll_run_decide('${run1.id}', 'approved', 'Checked against the old sheet')`);
  refused('super', `update public.payroll_lines set net = 1 where run_id = '${run1.id}'`, /aren't edited/);
  refused('super', `delete from public.payroll_lines where run_id = '${run1.id}'`, /Only a draft payroll/);
  refused('super', `delete from public.payroll_runs where id = '${run1.id}'`, /void it instead/);
  refused('book', `select public.payroll_run_recompute('${run1.id}')`, /Only a draft payroll is recomputed/);
  refused('book', `select public.payroll_run_release('${run1.id}', '')`, /release reference/);
  assert.equal(J('book', `public.payroll_run_release('${run1.id}', 'Cash, signed payroll sheet #1')`).status, 'released');
  refused('admin', `select public.payroll_run_void('${run1.id}', 'oops')`, /released payroll stays/);
});

test('payslips: each person sees only their own, and only once approved', () => {
  const { refused, must } = db;
  const dina = J('designer', 'public.payslips_mine()');
  assert.equal(dina.length, 1);
  assert.deepEqual([dina[0].name, dina[0].net, dina[0].period_start], ['Dina', 8425, '2026-10-01']);
  assert.equal(J('book', 'public.payslips_mine()')[0].name, 'Bea');
  refused('designer', `select public.payroll_runs_list()`, /Payroll is for the admin and the bookkeeper/);
  refused('designer', `select public.payroll_run_get('${run1.id}')`, /Payroll is for the admin and the bookkeeper/);
  assert.equal(must('designer', `select count(*) from public.payroll_lines`), '0');
  assert.equal(must('designer', `select count(*) from public.payroll_runs`), '0');
  refused('designer', `select public.payroll_person_period('${db.U.designer}', '2026-10-01', '2026-10-15')`, /permission denied/);
});

test('Oct 16-31: adjustments wait for the admin; the month\'s contributions and tax by hand', () => {
  const { U, must, refused } = db;
  run2 = J('book', `public.payroll_run_prepare('2026-10-20')`);
  const adj = (who, p) => `select public.payroll_adjustment_add(${j({ run_id: run2.id, ...p })})`;
  refused('designer', adj('designer', { user_id: U.designer, kind: 'taxable_earning', amount: '1000', reason: 'Bonus' }), /Only the admin and the bookkeeper adjust/);
  refused('book', adj('book', { user_id: U.book, kind: 'taxable_earning', amount: '1000', reason: 'Bonus' }), /Only the admin adjusts your own/);
  refused('book', adj('book', { user_id: U.designer, kind: 'taxable_earning', amount: '1000', reason: '' }), /needs the person, the kind, an amount and the reason/);
  refused('book', `select public.payroll_adjustment_add(${j({ run_id: run1.id, user_id: U.designer, kind: 'deduction', amount: '1', reason: 'late' })})`, /draft payroll only/);
  must('book', adj('book', { user_id: U.designer, kind: 'taxable_earning', amount: '1000', reason: 'October sales bonus' }));
  must('book', adj('book', { user_id: U.designer, kind: 'deduction', amount: '500', reason: 'Cash advance Oct 20', reference: 'CA-0012' }));
  // A pending adjustment holds the run; only the admin decides, and the line moves only once approved.
  refused('book', `select public.payroll_run_submit('${run2.id}')`, /waiting for the admin/);
  let r = J('book', `public.payroll_run_get('${run2.id}')`);
  assert.equal(line(r, 'Dina').gross, 9050);
  for (const a of r.adjustments) {
    refused('book', `select public.payroll_adjustment_decide('${a.id}', 'approved', '')`, /Only the admin approves payroll adjustments/);
    r = J('admin', `public.payroll_adjustment_decide('${a.id}', 'approved', 'OK')`);
  }
  refused('super', `update public.payroll_adjustments set amount = 1 where run_id = '${run2.id}'`, /already decided/);
  const d = line(r, 'Dina'), b = line(r, 'Bea');
  assert.deepEqual([d.basic_pay, d.allowance, d.adj_taxable, d.adj_deductions, d.gross], [8400, 650, 1000, 500, 10050]);
  assert.deepEqual([d.sss_ee, d.sss_er, d.sss_ec, d.ph_ee, d.ph_er, d.pi_ee, d.pi_er, d.tax, d.net], [925, 1850, 30, 404.38, 404.37, 200, 200, 0, 8020.62]);
  assert.deepEqual([b.basic_pay, b.sss_ee, b.sss_er, b.sss_ec, b.ph_ee, b.ph_er, b.pi_ee, b.tax, b.net], [25000, 1750, 3500, 30, 1202.08, 1202.07, 200, 1973.68, 19874.24]);
  assert.equal(d.basis.sss.msc, 18500);
  assert.equal(d.basis.sss.rule_status, 'pending_review');
  assert.equal(r.totals.net, 27894.86);
  // Returned with a reason, resubmitted, approved.
  must('book', `select public.payroll_run_submit('${run2.id}')`);
  assert.equal(J('admin', `public.payroll_run_decide('${run2.id}', 'returned', 'Check Bea''s Oct 22')`).returned_note, "Check Bea's Oct 22");
  must('book', `select public.payroll_run_submit('${run2.id}')`);
  must('admin', `select public.payroll_run_decide('${run2.id}', 'approved', '')`);
  assert.equal(J('designer', 'public.payslips_mine()').length, 2);
});

test('split timing, unfinished cutoffs, void, settings, activity log', () => {
  const { must, refused } = db;
  refused('book', `select public.payroll_settings_save('{"contributions_timing":"split"}')`, /Only the admin changes the payroll settings/);
  must('admin', `select public.payroll_settings_save('{"contributions_timing":"split"}')`);
  const r = J('book', `public.payroll_run_prepare('2027-01-05')`);
  const d = line(r, 'Dina');
  assert.deepEqual([d.sss_ee, d.sss_er, d.sss_ec, d.ph_ee, d.ph_er, d.pi_ee, d.pi_er], [387.5, 775, 15, 195.63, 195.63, 100, 100]);
  assert.equal(r.contributions_timing, 'split');
  refused('book', `select public.payroll_run_submit('${r.id}')`, /cutoff isn't over yet/);
  refused('book', `select public.payroll_run_void('${r.id}', 'test')`, /Only the admin voids/);
  refused('admin', `select public.payroll_run_void('${r.id}', '')`, /why it's void/);
  assert.equal(J('admin', `public.payroll_run_void('${r.id}', 'Prepared too early')`).status, 'void');
  assert.equal(J('book', `public.payroll_run_prepare('2027-01-05')`).status, 'draft');   // a void run frees the period
  must('admin', `select public.payroll_settings_save('{"contributions_timing":"second"}')`);
  const list = J('book', 'public.payroll_runs_list()');
  assert.equal(list.runs.length, 4);
  assert.equal(list.can_approve, false);
  assert.equal(must('super', `select count(*) > 0 from public.audit_log where module = 'Payroll' and table_name = 'payroll_runs'`), 't');
  assert.equal(must('super', `select count(*) > 0 from public.audit_log where module = 'Payroll' and table_name = 'payroll_adjustments'`), 't');
});
