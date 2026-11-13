// v3.3, daily salary from attendance (supabase/migrations/20261126000023_salary.sql) on a real local
// PostgreSQL. Every peso below was worked out by hand from what is seeded here: keep it that way.
//
//   Dina: daily rate 600 (minute rate 600 / 480 = 1.25), allowance 50 a day, from 2026-10-01.
//   October 2026 (Sundays 4, 11, 18, 25). Holidays: 9 regular, 12 regular, 13 special, 14 special, 15 regular.
//   Oct 1 Thu  8:00-12:00, 13:00-17:00                 worked 480            600 + 50                    = 650.00
//   Oct 2 Fri  in 08:17 (late 17 min)                  worked 463            600 - 17 x 1.25 + 50        = 628.75
//   Oct 3 Sat  out 16:30 (undertime 30)                worked 450            600 - 30 x 1.25 + 50        = 612.50
//   Oct 4 Sun  rest day, no work                                                                         =   0
//   Oct 5 Mon  clock-in only (08:00)                   incomplete: not paid  600 - 480 x 1.25            =   0
//   Oct 6 Tue  absent                                                                                    =   0
//   Oct 7 Wed  sick leave, paid                                              600 + 50                    = 650.00
//   Oct 8 Thu  vacation, unpaid                                                                          =   0
//   Oct 9 Fri  regular holiday, not worked; the working day before (Oct 8) was unpaid leave: no holiday pay =   0
//   Oct 10 Sat full day, out 18:45; overtime approved 90 min (most allowed: 105 -> 90)
//                                                      600 + 50 + 90 x 1.25 x 1.25 (140.625 -> 140.63)   = 790.63
//   Oct 11 Sun rest day worked 8-12                    240 x 1.25 x 1.30 = 390 + 50                       = 440.00
//   Oct 12 Mon regular holiday, not worked; day before = Oct 10 (Sunday skipped), present: 600 x 1.00   = 600.00
//   Oct 13 Tue special day worked 8-17                 480 x 1.25 x 1.30 = 780 + 50                       = 830.00
//   Oct 14 Wed special day, not worked                                                                   =   0
//   Oct 15 Thu regular holiday worked 8-17; day before: 14, 13, 12 holidays, 11 Sunday -> Oct 10, present
//                                                      600 x 1.00 + 480 x 1.25 x (2.00 - 1.00) + 50       = 1250.00
//   Cutoff Oct 1-15: 650 + 628.75 + 612.50 + 650 + 790.63 + 440 + 600 + 830 + 1250 = 6451.88
//   Oct 16 Fri no punch, no record: unaccounted, 0.
//   New rate from Oct 16: monthly 18,000 (a mistake), then 18,780 with the same date (the newest wins):
//     daily equivalent 18,780 x 12 / 313 = 720.00, minute 1.50, no allowance.
//   Oct 17 Sat in 08:10 (late 10)                      720 - 10 x 1.50 = 705.00 (Oct 1-15 keep the 600 rate)
//
//   Release dates ('earlier'): Oct 1-15 -> the 15th, 14th, 13th, 12th are holidays, 11th a Sunday -> Oct 10.
//   Nov 1-15 -> Nov 15 is a Sunday -> Nov 14. Nov 16-30 -> Nov 30 holiday, 29 Sunday -> Nov 28.
//   Feb 2027 16-28 -> the 28th is a Sunday -> Feb 27. With 'later': Nov 1-15 -> Nov 16.
//   node --test tests/salary.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const days = (who, from, to, user) => JSON.parse(db.must(who, `select public.pay_days(${j({ from, to, user_id: user })})`));

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina', created_at = '2026-10-01 09:00+08' where id = '${U.designer}';`);
  const P = (day, kind, hm) => `('${U.designer}', '${kind}', '2026-10-${day} ${hm}+08', '2026-10-${day}', 8.48, 124.65, 5, '${U.designer}/2026-10-${day}-${kind}.jpg', '{}')`;
  const full = (day, ai = '08:00', po = '17:00') => [P(day, 'am_in', ai), P(day, 'am_out', '12:00'), P(day, 'pm_in', '13:00'), P(day, 'pm_out', po)].join(', ');
  const H = (day, type) => `('holiday', 'Test holiday', '2026-${day} 00:00+08', '2026-${day} 23:59+08', '${type}')`;
  must('super', `set session_replication_role = replica;
    insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values
      ${full('01')}, ${full('02', '08:17')}, ${full('03', '08:00', '16:30')}, ${P('05', 'am_in', '08:00')},
      ${full('10', '08:00', '18:45')}, ${P('11', 'am_in', '08:00')}, ${P('11', 'am_out', '12:00')},
      ${full('13')}, ${full('15')}, ${full('17', '08:10')};
    insert into public.project_events (kind, title, starts_at, ends_at, holiday_type) values
      ${H('10-09', 'regular')}, ${H('10-12', 'regular')}, ${H('10-13', 'special')}, ${H('10-14', 'special')}, ${H('10-15', 'regular')}, ${H('11-30', 'regular')};`);
  const rec = (p) => must('book', `select public.attendance_record_add(${j({ user_id: U.designer, ...p })})`);
  rec({ date: '2026-10-06', kind: 'absent' });
  rec({ date: '2026-10-07', kind: 'leave', leave_type: 'sick', paid: true });
  rec({ date: '2026-10-08', kind: 'leave', leave_type: 'vacation', paid: false });
});
test.after(() => db && db.stop());

test('rates: the admin and the bookkeeper set them, never their own (bar the admin); kept, never edited', () => {
  const { U, must, refused } = db;
  const add = (who, p) => db.sql(who, `select public.salary_rate_add(${j(p)})`);
  const r = add('book', { user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '600', daily_allowance: '50', employment_type: 'probationary' });
  assert.ok(r.ok, r.err);
  assert.equal(JSON.parse(r.out).daily_equivalent, 600);
  refused('book', `select public.salary_rate_add(${j({ user_id: U.book, effective_from: '2026-10-01', salary_type: 'daily', rate: '500' })})`, /Only the admin sets your own salary/);
  must('admin', `select public.salary_rate_add(${j({ user_id: U.book, effective_from: '2026-10-01', salary_type: 'monthly', rate: '25000' })})`);
  must('admin', `select public.salary_rate_add(${j({ user_id: U.admin, effective_from: '2026-10-01', salary_type: 'monthly', rate: '1' })})`);
  refused('designer', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '9000' })})`, /Only the admin and the bookkeeper set salaries/);
  refused('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2026-10-01', salary_type: 'hourly', rate: '600' })})`, /Check the rate/);
  refused('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2026-10-01', salary_type: 'daily', rate: '-5' })})`, /pesos with up to two decimals/);
  refused('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2019-12-31', salary_type: 'daily', rate: '600' })})`, /Check the rate/);
  refused('book', `insert into public.salary_rates (user_id, effective_from, salary_type, rate) values ('${U.designer}', '2026-10-01', 'daily', 1)`, /permission denied/);
  refused('super', `update public.salary_rates set rate = 1 where user_id = '${U.designer}'`, /Rates are kept/);
  refused('super', `delete from public.salary_rates where user_id = '${U.designer}'`, /Rates are kept/);
  // Each person reads only their own rate; the admin and bookkeeper read all.
  assert.equal(must('designer', `select count(*) from public.salary_rates`), '1');
  assert.equal(must('book', `select count(*) from public.salary_rates`), '3');
  refused('designer', `select public.salary_rates_list()`, /Only the admin and the bookkeeper see salaries/);
  const list = JSON.parse(must('book', `select public.salary_rates_list()`));
  assert.equal(list.find((p) => p.name === 'Dina').current.rate, 600);
  // Internal pieces aren't callable from a browser.
  refused('designer', `select public.pay_day_calc('${U.designer}', '2026-10-01')`, /permission denied/);
  refused('book', `select public.salary_rate_on('${U.designer}', '2026-10-01')`, /permission denied/);
});

test('overtime: the admin alone approves it, in 30-minute blocks, never more than the clock-out allows', () => {
  const { U, must, refused } = db;
  const ot = (p) => `select public.attendance_record_add(${j({ user_id: U.designer, kind: 'overtime', ...p })})`;
  refused('book', ot({ date: '2026-10-10', minutes: '90' }), /Only the admin approves overtime/);
  refused('admin', ot({ date: '2026-10-10', minutes: '45' }), /30-minute blocks/);
  refused('admin', ot({ date: '2026-10-10', minutes: '120' }), /clocked out at 18:45: at most 90 minutes/);
  refused('admin', ot({ date: '2026-10-01', minutes: '30' }), /clocked out at 17:00: at most 0 minutes/);
  refused('admin', ot({ date: '2026-10-16', minutes: '30' }), /no clock-out that day/);
  const id = JSON.parse(must('admin', ot({ date: '2026-10-10', minutes: '60', remarks: 'wrong' }))).id;
  refused('admin', ot({ date: '2026-10-10', minutes: '90' }), /already has approved overtime/);
  must('admin', `select public.attendance_record_void('${id}', 'Approved 90, not 60')`);
  must('admin', ot({ date: '2026-10-10', minutes: '90', remarks: 'Rush install prep' }));
});

test('each day is paid by the hand-worked rules (late and undertime per minute, never a whole day)', () => {
  const { U } = db;
  const rows = days('book', '2026-10-01', '2026-10-16', U.designer);
  const by = Object.fromEntries(rows.map((r) => [r.date, r]));
  const want = {
    '2026-10-01': ['present', 650], '2026-10-02': ['present', 628.75], '2026-10-03': ['present', 612.5], '2026-10-04': ['rest_day', 0],
    '2026-10-05': ['incomplete', 0], '2026-10-06': ['absent', 0], '2026-10-07': ['leave_paid', 650], '2026-10-08': ['leave_unpaid', 0],
    '2026-10-09': ['holiday', 0], '2026-10-10': ['present', 790.63], '2026-10-11': ['present', 440], '2026-10-12': ['holiday', 600],
    '2026-10-13': ['present', 830], '2026-10-14': ['holiday', 0], '2026-10-15': ['present', 1250], '2026-10-16': ['unaccounted', 0]
  };
  for (const [d, [status, total]] of Object.entries(want)) {
    assert.equal(by[d].status, status, d + ' status');
    assert.equal(by[d].total, total, d + ' total');
  }
  assert.deepEqual([by['2026-10-02'].late_minutes, by['2026-10-02'].deductions], [17, 21.25]);
  assert.deepEqual([by['2026-10-03'].undertime_minutes, by['2026-10-03'].deductions], [30, 37.5]);
  assert.deepEqual([by['2026-10-05'].unworked_minutes, by['2026-10-05'].allowance], [480, 0]);
  assert.equal(by['2026-10-09'].holiday_pay_eligible, false);
  assert.equal(by['2026-10-12'].holiday_pay_eligible, true);
  assert.deepEqual([by['2026-10-10'].overtime_minutes, by['2026-10-10'].overtime_pay], [90, 140.63]);
  assert.deepEqual([by['2026-10-15'].basic, by['2026-10-15'].premium], [600, 600]);
  assert.equal(by['2026-10-13'].holiday, 'special');
  const cutoff = rows.filter((r) => r.date <= '2026-10-15').reduce((s, r) => s + r.total, 0);
  assert.equal(Math.round(cutoff * 100) / 100, 6451.88);
});

test('a new rate applies from its date; a mistake is fixed by a newer row with the same date', () => {
  const { U, must } = db;
  must('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2026-10-16', salary_type: 'monthly', rate: '18000' })})`);
  must('book', `select public.salary_rate_add(${j({ user_id: U.designer, effective_from: '2026-10-16', salary_type: 'monthly', rate: '18780', notes: 'Corrected' })})`);
  const by = Object.fromEntries(days('book', '2026-10-15', '2026-10-17', U.designer).map((r) => [r.date, r]));
  assert.equal(by['2026-10-15'].daily_rate, 600);
  assert.equal(by['2026-10-17'].daily_rate, 720);
  assert.deepEqual([by['2026-10-17'].late_minutes, by['2026-10-17'].total], [10, 705]);
  assert.equal(by['2026-10-15'].total, 1250);
});

test('release dates move off Sundays and holidays; only the admin changes the rule', () => {
  const { must, refused } = db;
  const per = (d) => JSON.parse(must('designer', `select public.pay_period('${d}')`));
  assert.deepEqual(per('2026-10-10'), { start: '2026-10-01', end: '2026-10-15', release: '2026-10-10' });
  assert.deepEqual(per('2026-11-03'), { start: '2026-11-01', end: '2026-11-15', release: '2026-11-14' });
  assert.deepEqual(per('2026-11-20'), { start: '2026-11-16', end: '2026-11-30', release: '2026-11-28' });
  assert.deepEqual(per('2027-02-20'), { start: '2027-02-16', end: '2027-02-28', release: '2027-02-27' });
  assert.deepEqual(per('2026-12-31'), { start: '2026-12-16', end: '2026-12-31', release: '2026-12-30' });
  refused('book', `select public.payroll_settings_save('{"payday_rule":"later"}')`, /Only the admin changes the payroll settings/);
  refused('admin', `select public.payroll_settings_save('{"payday_rule":"whenever"}')`, /outside what the law allows/);
  refused('admin', `select public.payroll_settings_save('{"regular_worked":0.5}')`, /outside what the law allows/);
  must('admin', `select public.payroll_settings_save('{"payday_rule":"later"}')`);
  assert.equal(per('2026-11-03').release, '2026-11-16');
  must('admin', `select public.payroll_settings_save('{"payday_rule":"earlier"}')`);
  assert.equal(JSON.parse(must('book', `select public.payroll_settings_get()`)).divisor, 313);
  refused('designer', `select public.payroll_settings_get()`, /Only the admin and the bookkeeper/);
});

test('holiday types: the admin marks a holiday regular or special; nothing else carries a type', () => {
  const { U, must, refused } = db;
  must('admin', `select public.event_save('{"kind":"holiday","title":"Special day","starts_at":"2026-12-08 00:00+08","ends_at":"2026-12-08 23:59+08","holiday_type":"special"}')`);
  assert.equal(must('designer', `select public.holiday_on('2026-12-08')`), 'special');
  must('admin', `select public.event_save('{"kind":"holiday","title":"Rizal Day","starts_at":"2026-12-30 00:00+08","ends_at":"2026-12-30 23:59+08"}')`);
  assert.equal(must('designer', `select public.holiday_on('2026-12-30')`), 'regular');
  assert.equal(must('designer', `select coalesce(public.holiday_on('2026-12-29'), 'none')`), 'none');
  refused('super', `insert into public.project_events (kind, title, starts_at, ends_at, holiday_type) values ('meeting', 'x', now(), now(), 'regular')`, /holiday_type_check/);
  const p = JSON.parse(must('designer', `select public.pay_period('2026-12-20')`));
  assert.equal(p.release, '2026-12-29');
  assert.ok(U);
});

test('everyone sees their own pay and nobody else\'s', () => {
  const { U, must, refused } = db;
  refused('designer', `select public.pay_days(${j({ from: '2026-10-01', to: '2026-10-15' })})`, /Only the admin and the bookkeeper see everyone/);
  refused('book', `select public.pay_days(${j({ from: '2026-10-01', to: '2026-12-31' })})`, /Up to 62 days/);
  const me = JSON.parse(must('designer', `select public.pay_me()`));
  assert.ok(me.period.start <= me.today && me.today <= me.period.end);
  assert.equal(me.rate.daily_equivalent, 720);
  assert.ok(me.days.every((d) => d.user_id === U.designer));
  assert.equal(me.days.length, (Date.parse(me.today) - Date.parse(me.period.start)) / 864e5 + 1);
  // Both the admin and the bookkeeper see the whole team; the table is in the activity log as Payroll.
  assert.equal(days('admin', '2026-10-01', '2026-10-01').length, 3);
  assert.equal(must('super', `select count(*) > 0 from public.audit_log where module = 'Payroll'`), 't');
});
