// v4.5 13th-month pay (supabase/migrations/20261201000028_thirteenth_month.sql) on a real local PostgreSQL.
// Every peso was worked out by hand: keep it that way. Rates are made up.
//
//   October 2026: Sundays 4, 11, 18, 25; Oct 30 (Fri) a regular holiday. Both cutoffs run through real payroll runs.
//   Dina, daily 600 (minute 1.25), allowance 50.
//     Oct 1-15 (13 ordinary days): works 12, in 08:20 on Oct 1 (late 20 = 25.00); Oct 7 paid sick leave (left out).
//       Basic for the 13th month: 12 x 600 - 25 = 7,175.
//     Oct 16-31 (13 ordinary days without the holiday): works all 13 = 7,800. Left out: Oct 30 holiday pay,
//       Sunday Oct 25 worked 08:00-12:00 (rest-day pay), 60 min overtime on Oct 20, the allowance.
//     Portal basic 7,175 + 7,800 = 14,975. Earlier (Jan-Sep, old payroll) 54,000. To date 68,975 / 12 = 5,747.92.
//     Rest of the year: Nov 2026 has 25 Mon-Sat days, Dec 27 (no holidays in this database after Oct) = 52 x 600 = 31,200.
//     Projected (68,975 + 31,200) / 12 = 100,175 / 12 = 8,347.92.
//   Bea, monthly 50,000: Oct basic 25,000 + 25,000 = 50,000; earlier 450,000. To date 500,000 / 12 = 41,666.67.
//     Rest of the year: cutoffs starting Nov 1, Nov 16, Dec 1, Dec 16 = 4 x 25,000. Projected 600,000 / 12 = 50,000.00.
//   Run (prepared before the year ends, so it pays the projected figure): 8,347.92 + 50,000.00 = 58,347.92; no excess
//   over the 90,000 tax-free cap. Jason (admin) is not covered.
//   node --test tests/thirteenth.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const J = (who, sql) => JSON.parse(db.must(who, `select ${sql}`));
const person = (o, name) => o.people.find((p) => p.name === name);
const line = (o, name) => o.run.lines.find((l) => l.name === name);
const yearOver = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) > '2026-12-31';

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';`);
  const rows = [];
  const punch = (who, d, k, hm) => { const dd = String(d).padStart(2, '0');
    rows.push(`('${who}', '${k}', '2026-10-${dd} ${hm}+08', '2026-10-${dd}', 8.48, 124.65, 5, 'x.jpg', '{}')`); };
  const day = (who, d, ai = '08:00', po = '17:00') => {
    for (const [k, hm] of [['am_in', ai], ['am_out', '12:00'], ['pm_in', '13:00'], ['pm_out', po]]) punch(who, d, k, hm); };
  for (let d = 1; d <= 31; d++) {
    if ([4, 11, 18, 25, 30].includes(d)) continue;
    if (d !== 7) day(U.designer, d, d === 1 ? '08:20' : '08:00', d === 20 ? '18:00' : '17:00');
    day(U.book, d);
  }
  punch(U.designer, 25, 'am_in', '08:00'); punch(U.designer, 25, 'am_out', '12:00');
  must('super', `set session_replication_role = replica;
    insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values ${rows.join(',')};
    insert into public.project_events (kind, title, starts_at, ends_at, holiday_type) values ('holiday', 'Test regular holiday', '2026-10-30 00:00+08', '2026-10-30 23:59+08', 'regular');`);
  must('admin', `select public.attendance_record_add(${j({ user_id: U.designer, date: '2026-10-07', kind: 'leave', leave_type: 'sick', paid: 'true' })})`);
  must('admin', `select public.attendance_record_add(${j({ user_id: U.designer, date: '2026-10-20', kind: 'overtime', minutes: '60' })})`);
  must('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '600', daily_allowance: '50' })})`);
  must('admin', `select public.salary_rate_add(${j({ user_id: U.book, effective_from: '2026-10-01', salary_type: 'monthly', rate: '50000' })})`);
  for (const d of ['2026-10-05', '2026-10-20']) {
    const r = J('book', `public.payroll_run_prepare('${d}')`);
    must('book', `select public.payroll_run_submit('${r.id}')`);
    must('admin', `select public.payroll_run_decide('${r.id}', 'approved', '')`);
  }
});
test.after(() => db && db.stop());

test('earlier earnings: kept by the books, never their own, void-only by the admin', () => {
  const { U, must, refused } = db;
  refused('designer', `select public.thirteenth_earlier_add(${j({ user_id: U.designer, year: 2026, amount: '54000', reference: 'old sheets' })})`, /Only the admin and the bookkeeper/);
  refused('book', `select public.thirteenth_earlier_add(${j({ user_id: U.book, year: 2026, amount: '450000', reference: 'old sheets' })})`, /Only the admin enters your own/);
  refused('book', `select public.thirteenth_earlier_add(${j({ user_id: U.designer, year: 2026, amount: '54000', reference: '' })})`, /where it comes from/);
  refused('book', `select public.thirteenth_earlier_add(${j({ user_id: U.designer, year: 2026, amount: '5,400', reference: 'old sheets' })})`, /pesos/);
  const wrong = J('book', `public.thirteenth_earlier_add(${j({ user_id: U.designer, year: 2026, amount: '45000', reference: 'Old payroll sheets Jan-Sep' })})`);
  refused('book', `select public.thirteenth_earlier_void('${wrong.id}', 'typo')`, /Only the admin voids/);
  refused('super', `update public.thirteenth_earlier set amount = 54000 where id = '${wrong.id}'`, /aren't edited/);
  refused('super', `delete from public.thirteenth_earlier where id = '${wrong.id}'`, /void the entry/);
  refused('designer', `insert into public.thirteenth_earlier (user_id, year, amount, reference) values ('${U.designer}', 2026, 1, 'x x x')`, /permission denied/);
  must('admin', `select public.thirteenth_earlier_void('${wrong.id}', 'Typed 45,000 for 54,000')`);
  refused('admin', `select public.thirteenth_earlier_void('${wrong.id}', 'again')`, /isn't open/);
  must('book', `select public.thirteenth_earlier_add(${j({ user_id: U.designer, year: 2026, amount: '54000', reference: 'Old payroll sheets Jan-Sep' })})`);
  must('admin', `select public.thirteenth_earlier_add(${j({ user_id: U.book, year: 2026, amount: '450000', reference: 'Old payroll sheets Jan-Sep' })})`);
  assert.equal(db.must('designer', `select count(*) from public.thirteenth_earlier`), '0');
});

test('the 13th month to date and projected, by hand', () => {
  const { refused } = db;
  refused('designer', `select public.thirteenth_overview(2026)`, /admin and the bookkeeper/);
  refused('designer', `select public.thirteenth_person('00000000-0000-4000-8000-000000000002', 2026)`, /permission denied/);
  const o = J('book', `public.thirteenth_overview(2026)`);
  assert.equal(o.people.length, 2, 'the admin is not covered');
  const d = person(o, 'Dina'), b = person(o, 'Bea');
  assert.deepEqual([d.earlier, d.portal, d.basic_to_date, d.to_date, d.projected_basic, d.projected, d.covered_through],
    [54000, 14975, 68975, 5747.92, 31200, 8347.92, '2026-10-31']);
  assert.deepEqual([b.earlier, b.portal, b.to_date, b.projected_basic, b.projected], [450000, 50000, 41666.67, 100000, 50000]);
  assert.equal(o.rule.code, 'thirteenth_month');
  assert.equal(o.rule.status, 'pending_review', 'the agent never approves a rule');
  assert.equal(o.earlier.length, 2);
  assert.equal(o.run, null);
  assert.equal(o.can_approve, false);
});

test('a run: prepared by the books, approved and voided by the admin only, released with a reference; staff see their own once approved', () => {
  const { U, must, refused } = db;
  refused('designer', `select public.thirteenth_run_prepare(2026)`, /Only the admin and the bookkeeper prepare/);
  let o = J('book', `public.thirteenth_run_prepare(2026)`);
  refused('book', `select public.thirteenth_run_prepare(2026)`, /already prepared/);
  assert.equal(o.run.status, 'draft');
  const pay = yearOver ? { Dina: 5747.92, Bea: 41666.67, total: 47414.59 } : { Dina: 8347.92, Bea: 50000, total: 58347.92 };
  assert.deepEqual([line(o, 'Dina').amount, line(o, 'Bea').amount, o.run.totals.amount, o.run.totals.taxable_excess], [pay.Dina, pay.Bea, pay.total, 0]);
  assert.equal(line(o, 'Dina').to_date, 5747.92);
  // A managerial employee isn't covered: Bea marked not rank-and-file drops out on recompute, and back.
  must('admin', `select public.employee_statutory_save(${j({ user_id: U.book, rank_and_file: 'false' })})`);
  o = J('book', `public.thirteenth_run_act('${o.run.id}', 'recompute', '')`);
  assert.deepEqual(o.run.lines.map((l) => l.name), ['Dina']);
  refused('book', `select public.employee_statutory_save(${j({ user_id: U.book, rank_and_file: 'true' })})`, /Only the admin changes your own/);
  must('admin', `select public.employee_statutory_save(${j({ user_id: U.book, rank_and_file: 'true' })})`);
  const id = o.run.id;
  refused('super', `update public.thirteenth_lines set amount = 1 where run_id = '${id}'`, /aren't edited/);
  o = J('book', `public.thirteenth_run_act('${id}', 'submit', '')`);
  assert.equal(o.run.status, 'submitted');
  assert.equal(o.run.lines.length, 2);
  refused('book', `select public.thirteenth_run_act('${id}', 'approve', '')`, /Only the admin approves/);
  refused('book', `select public.thirteenth_run_act('${id}', 'void', 'no reason')`, /Only the admin/);
  refused('book', `select public.thirteenth_run_act('${id}', 'recompute', '')`, /Only a draft/);
  refused('admin', `select public.thirteenth_run_act('${id}', 'return', '')`, /what needs fixing/);
  assert.equal(J('admin', `public.thirteenth_run_act('${id}', 'return', 'Add Dina''s Jan earnings')`).run.returned_note, "Add Dina's Jan earnings");
  must('book', `select public.thirteenth_run_act('${id}', 'submit', '')`);
  assert.equal(JSON.parse(db.must('designer', `select public.thirteenth_mine()`)).length, 0, 'nothing before approval');
  refused('book', `select public.thirteenth_run_act('${id}', 'release', 'BDO batch 9')`, /Only an approved run/);
  o = J('admin', `public.thirteenth_run_act('${id}', 'approve', 'Checked by the accountant')`);
  assert.equal(o.run.approver, 'Jason');
  refused('super', `update public.thirteenth_runs set year = 2025 where id = '${id}'`, /year is fixed/);
  const mine = JSON.parse(db.must('designer', `select public.thirteenth_mine()`));
  assert.deepEqual([mine.length, mine[0].name, mine[0].amount, mine[0].status], [1, 'Dina', pay.Dina, 'approved']);
  refused('book', `select public.thirteenth_run_act('${id}', 'release', 'x')`, /release reference/);
  assert.equal(J('book', `public.thirteenth_run_act('${id}', 'release', 'Cash, signed sheet #13')`).run.status, 'released');
  refused('admin', `select public.thirteenth_run_act('${id}', 'void', 'Wrong year')`, /released 13th-month run stays/);
  refused('super', `delete from public.thirteenth_runs where id = '${id}'`, /void it instead/);
});

test('a void run frees the year; someone who left is projected only to their last day; the log names the workspace', () => {
  const { U, must } = db;
  const o = J('book', `public.thirteenth_run_prepare(2027)`);
  must('admin', `select public.thirteenth_run_act('${o.run.id}', 'void', 'Prepared too early')`);
  assert.equal(J('book', `public.thirteenth_run_prepare(2027)`).run.status, 'draft');
  // Dina leaves on Sat Nov 14 2026: Nov 1-14 has 12 Mon-Sat days = 7,200; (68,975 + 7,200) / 12 = 6,347.92.
  must('admin', `select public.employee_statutory_save(${j({ user_id: U.designer, separated_on: '2026-11-14' })})`);
  const d = person(J('book', `public.thirteenth_overview(2026)`), 'Dina');
  assert.deepEqual([d.projected_basic, d.projected, d.separated_on], [7200, 6347.92, '2026-11-14']);
  const mods = db.must('super', `select string_agg(distinct module, ',' order by module) from public.audit_log where table_name in ('thirteenth_earlier', 'thirteenth_runs')`);
  assert.equal(mods, 'Payroll');
});
