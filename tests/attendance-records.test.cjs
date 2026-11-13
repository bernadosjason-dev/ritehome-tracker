// Phase 5c, attendance management (supabase/migrations/20261125000022_attendance_records.sql) on a real
// local PostgreSQL. Every figure in the month test was worked out by hand from what's seeded here:
//
//   Dina (designer), account made 2026-10-01. October 2026: 31 days, Sundays 4, 11, 18, 25; holiday Oct 9.
//   Oct 1 Thu  in 08:00 · out 12:00 · in 13:00 · out 17:00            -> 4h + 4h = 8h, on time
//   Oct 2 Fri  in 08:30 (late) · 12:00 · 13:00 · 17:00                -> 3.5h + 4h = 7.5h, 1 late
//   Oct 3 Sat  in 08:00 · 12:00 · (no pm in) · 17:00; correction pm in 13:00 -> 4h + 4h = 8h, complete
//   Oct 5 Mon  in 09:00 (late punch), corrected to 08:00 · 12:00 · 13:00 · out 16:00 (early)
//                                                                      -> 4h + 3h = 7h, 0 late, 1 early out
//   Oct 6 sick leave (paid) · Oct 7 absent · Oct 8 vacation (unpaid) · Oct 10 a remark only
//   => days 4, hours 8 + 7.5 + 8 + 7 = 30.5, late 1, early out 1, incomplete 0, corrections 2,
//      absences 1, paid leave 1, unpaid leave 1.
//   Working days: 31 - 4 Sundays - 1 holiday = 26; accounted: Oct 1, 2, 3, 5 (punches), 6, 7, 8 (records)
//   = 7; a remark doesn't account for a day => 26 - 7 = 19. The void test then adds emergency leave
//   (paid) on Oct 12 after voiding a wrong absence there: paid leave 2, absences 1, unaccounted 18.
//   node --test tests/attendance-records.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const add = (who, p) => db.must(who, `select public.attendance_record_add(${j(p)})`);
const month = (who) => JSON.parse(db.must(who, `select public.attendance_month('2026-10-01')`));

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  U.sales = '00000000-0000-4000-8000-000000000005';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'),
    ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina', created_at = '2026-10-01 09:00+08' where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';`);
  // Past punches, as they were made (the server stamps new ones with the current time).
  const P = (day, kind, hm, flags = '{}') => `('${U.designer}', '${kind}', '2026-10-${day} ${hm}+08', '2026-10-${day}', 8.48, 124.65, 5, '${U.designer}/2026-10-${day}-${kind}.jpg', '${flags}')`;
  must('super', `set session_replication_role = replica;
    insert into public.attendance_punches (user_id, kind, punched_at, work_date, lat, lng, accuracy_m, selfie_path, flags) values
      ${P('01', 'am_in', '08:00')}, ${P('01', 'am_out', '12:00')}, ${P('01', 'pm_in', '13:00')}, ${P('01', 'pm_out', '17:00')},
      ${P('02', 'am_in', '08:30', '{late}')}, ${P('02', 'am_out', '12:00')}, ${P('02', 'pm_in', '13:00')}, ${P('02', 'pm_out', '17:00')},
      ${P('03', 'am_in', '08:00')}, ${P('03', 'am_out', '12:00')}, ${P('03', 'pm_out', '17:00')},
      ${P('05', 'am_in', '09:00', '{late}')}, ${P('05', 'am_out', '12:00')}, ${P('05', 'pm_in', '13:00')}, ${P('05', 'pm_out', '16:00', '{early_out}')};
    insert into public.project_events (kind, title, starts_at, ends_at) values ('holiday', 'Test holiday', '2026-10-09 00:00+08', '2026-10-09 23:59+08');`);
});
test.after(() => db && db.stop());

test('the bookkeeper records corrections, leave, absences and remarks; every rule refused from the other side', () => {
  const { U, refused } = db;
  const D = U.designer;
  add('book', { user_id: D, date: '2026-10-03', kind: 'correction', punch_kind: 'pm_in', time: '13:00', remarks: 'Forgot to clock in after lunch' });
  add('book', { user_id: D, date: '2026-10-05', kind: 'correction', punch_kind: 'am_in', time: '08:00', remarks: 'GPS failed at 8; in the office, seen by Jason' });
  add('book', { user_id: D, date: '2026-10-06', kind: 'leave', leave_type: 'sick', paid: true, remarks: 'Medical certificate' });
  add('book', { user_id: D, date: '2026-10-07', kind: 'absent' });
  add('book', { user_id: D, date: '2026-10-08', kind: 'leave', leave_type: 'vacation', paid: false });
  add('book', { user_id: D, date: '2026-10-10', kind: 'remark', remarks: 'Said they were at a client site; no punch' });
  const r = (p, re) => refused('book', `select public.attendance_record_add(${j(p)})`, re);
  r({ user_id: D, date: '2026-10-03', kind: 'correction', punch_kind: 'pm_in', time: '13:05', remarks: 'again' }, /already has a correction/);
  r({ user_id: D, date: '2026-10-06', kind: 'absent' }, /already has an absence or leave/);
  r({ user_id: D, date: '2026-10-02', kind: 'absent' }, /They clocked in that day/);
  r({ user_id: D, date: '2026-10-12', kind: 'correction', punch_kind: 'am_in', time: '08:00' }, /needs the punch, the time and the reason/);
  r({ user_id: D, date: '2026-10-12', kind: 'correction', punch_kind: 'am_in', time: '8am', remarks: 'x' }, /HH:MM/);
  r({ user_id: D, date: '2026-10-12', kind: 'leave' }, /kind of leave/);
  r({ user_id: D, date: '2026-10-12', kind: 'remark' }, /Write the remark/);
  r({ user_id: D, date: '2026-10-12', kind: 'holiday' }, /absent, leave, correction, overtime or remark/);
  // Nobody but the admin records their own attendance.
  r({ user_id: U.book, date: '2026-10-12', kind: 'leave', leave_type: 'vacation', paid: true }, /Only the admin records your own/);
  add('admin', { user_id: U.book, date: '2026-10-12', kind: 'leave', leave_type: 'vacation', paid: true });
  for (const who of ['designer', 'sales']) refused(who, `select public.attendance_record_add(${j({ user_id: U.sales, date: '2026-10-12', kind: 'absent' })})`, /for the admin and the bookkeeper/);
  refused('book', `insert into public.attendance_records (user_id, work_date, kind) values ('${D}', '2026-10-13', 'absent')`, /permission denied/);
});

test('records are never edited or deleted: a wrong one is voided with a reason (and the bookkeeper can\'t void their own)', () => {
  const { U, must, refused } = db;
  const id = must('super', `select id from public.attendance_records where kind = 'remark'`);
  refused('super', `update public.attendance_records set remarks = 'rewritten' where id = '${id}'`, /aren't edited/);
  refused('super', `delete from public.attendance_records where id = '${id}'`, /void it instead/);
  refused('book', `select public.attendance_record_void('${id}', '  ')`, /Say why/);
  const own = must('super', `select id from public.attendance_records where user_id = '${U.book}'`);
  refused('book', `select public.attendance_record_void('${own}', 'not mine to void')`, /Only the admin records your own/);
  refused('designer', `select public.attendance_record_void('${id}', 'x')`, /for the admin and the bookkeeper/);
  // A wrong absence: void it, add the right record.
  add('book', { user_id: U.designer, date: '2026-10-12', kind: 'absent' });
  const wrong = must('super', `select id from public.attendance_records where work_date = '2026-10-12' and user_id = '${U.designer}'`);
  must('book', `select public.attendance_record_void('${wrong}', 'Was on approved leave')`);
  refused('book', `select public.attendance_record_void('${wrong}', 'again')`, /isn't open any more/);
  refused('super', `update public.attendance_records set void_reason = 'changed' where id = '${wrong}'`, /voided record can't be changed/);
  add('book', { user_id: U.designer, date: '2026-10-12', kind: 'leave', leave_type: 'emergency', paid: true });
  assert.equal(must('super', `select count(*) from public.attendance_records where work_date = '2026-10-12' and user_id = '${U.designer}'`), '2', 'both kept');
});

test('the month for payroll: corrections replace punches, leave and absences counted, unaccounted days found (figures by hand)', () => {
  const dina = month('book').find((m) => m.name === 'Dina');
  const got = ['days', 'hours', 'lates', 'early_outs', 'incomplete_days', 'corrections', 'absences', 'leave_paid', 'leave_unpaid', 'to_review'].map((k) => [k, Number(dina[k])]);
  assert.deepEqual(Object.fromEntries(got), { days: 4, hours: 30.5, lates: 1, early_outs: 1, incomplete_days: 0, corrections: 2,
    absences: 0 + 1, leave_paid: 1 + 1, leave_unpaid: 1, to_review: 0 });
  // (Oct 12: the voided absence doesn't count; the emergency leave that replaced it is the 2nd paid leave, and
  // Oct 12 is then accounted for: 19 - 1 = 18 unaccounted.)
  assert.equal(dina.unaccounted, 18);
  assert.deepEqual(month('admin'), month('book'), 'the admin and the bookkeeper see the same month');
  assert.equal(month('book').find((m) => m.name === 'Sam').unaccounted, 0, 'no days before the account existed');
  db.refused('designer', `select public.attendance_month('2026-10-01')`, /Only the admin and the bookkeeper/);
});

test('the day: the bookkeeper sees times, flags and records but no selfies, GPS or face scores; the admin sees everything', () => {
  const { refused } = db;
  const day = (who) => JSON.parse(db.must(who, `select public.attendance_day('2026-10-05')`)).people.find((p) => p.name === 'Dina');
  const b = day('book'), a = day('admin');
  assert.equal(b.punches.length, 4); assert.equal(b.records[0].kind, 'correction'); assert.equal(b.records[0].by, 'Bea');
  assert(!('selfie_path' in b.punches[0]) && !('lat' in b.punches[0]) && !('face_match' in b.punches[0]), 'no biometrics for the bookkeeper');
  assert.equal(b.face_selfie_path, null);
  assert.match(a.punches[0].selfie_path, /\.jpg$/); assert.equal(a.punches[0].lat, 8.48);
  assert.equal(JSON.parse(db.must('book', `select public.attendance_day('2026-10-05')`)).can_review, false);
  refused('book', `select public.attendance_review((select id from public.attendance_punches limit 1), 'x')`, /Only an admin/);
  refused('designer', `select public.attendance_day('2026-10-05')`, /Only the admin and the bookkeeper/);
});

test('people see what was recorded about them, and nobody else\'s; every record is in the activity log', () => {
  const { U, must } = db;
  const today = must('super', `select (now() at time zone 'Asia/Manila')::date::text`);
  add('book', { user_id: U.designer, date: today, kind: 'remark', remarks: 'Client meeting all morning' });
  const me = JSON.parse(must('designer', `select public.attendance_me()`));
  assert.deepEqual(me.records.map((r) => r.remarks), ['Client meeting all morning'], 'last 31 days only');
  assert.equal(must('designer', `select count(*) from public.attendance_records where user_id <> '${U.designer}'`), '0');
  assert.equal(must('sales', `select count(*) from public.attendance_records`), '0');
  assert(Number(must('super', `select count(*) from public.audit_log where module = 'Attendance' and table_name = 'attendance_records'`)) >= 10);
  assert.equal(must('super', `select count(*) from public.audit_log where table_name = 'attendance_records' and action = 'update' and 'void_reason' = any (changed)`), '1');
});
