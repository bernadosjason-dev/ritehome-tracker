// Attendance: supabase/migrations/20261116000013_attendance.sql (and the punches table from portal_core)
// on a real local PostgreSQL.   node --test tests/attendance.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const vec = (base, bump = 0) => '{' + Array.from({ length: 128 }, (_, i) => (((i * 37) % 11) / 40 * base + (i === 0 ? bump : 0)).toFixed(4)).join(',') + '}';
const ME = vec(1), SAME = vec(1, 0.3), OTHER = vec(-1);   // 0.3 away: the same person; OTHER is far off
const OFFICE = [8.500563, 124.622937], SITE = [8.4542, 124.6319];   // a client's house, ~5 km away

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.purchaser}', 'pia@example.com', '{"full_name":"Pia"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'purchaser', active = true, full_name = 'Pia' where id = '${U.purchaser}';`);
});
test.after(() => db && db.stop());

const punch = (who, kind, at, descriptor, acc = 12) =>
  `select public.attendance_punch('${kind}', ${at[0]}, ${at[1]}, ${acc}, '${db.U[who]}/2026-11-16-${kind}.jpg'${descriptor ? `, '${descriptor}'::real[]` : ''})`;

test('consent first, then one reference photo that only the admin can reset', () => {
  const { U, must, refused } = db;
  refused('designer', punch('designer', 'am_in', OFFICE), /accept the attendance notice/);
  refused('designer', `select public.attendance_enroll('${ME}'::real[], '${U.designer}/enroll.jpg')`, /accept the attendance notice/);
  must('designer', 'select public.accept_attendance_notice()');
  let me = JSON.parse(must('designer', 'select public.attendance_me()'));
  assert.deepEqual([me.name, me.enrolled, me.punches.length, me.office.radius_m], ['Dina', false, 0, 150]);
  refused('designer', `select public.attendance_enroll('{1,2,3}'::real[], '${U.designer}/enroll.jpg')`, /clear face/);
  refused('designer', `select public.attendance_enroll('${ME}'::real[], '${U.admin}/enroll.jpg')`, /your own folder/);
  must('designer', `select public.attendance_enroll('${ME}'::real[], '${U.designer}/enroll.jpg')`);
  refused('designer', `select public.attendance_enroll('${OTHER}'::real[], '${U.designer}/enroll2.jpg')`, /already set/);
  me = JSON.parse(must('designer', 'select public.attendance_me()'));
  assert.equal(me.enrolled, true);
  assert.doesNotMatch(JSON.stringify(me), /descriptor/, 'the face template never goes back to the phone');
  refused('designer', `select public.attendance_face_reset('${U.designer}')`, /Only an admin/);
});

test('a punch: the face score is worked out in the database, the distance from the office too', () => {
  const { U, must, refused } = db;
  const a = JSON.parse(must('designer', punch('designer', 'am_in', OFFICE, SAME)));
  assert.equal(a.kind, 'am_in');
  assert.ok(Math.abs(a.face_match - 0.7) < 0.01, 'similarity = 1 − distance (0.3): ' + a.face_match);
  assert.ok(a.office_distance_m < 5, 'at the office');
  assert.ok(!a.flags.includes('face_mismatch') && !a.flags.includes('no_face_check') && !a.flags.includes('off_site'), a.flags.join());
  refused('designer', punch('designer', 'am_in', OFFICE, SAME), /already recorded for today/);
  // Someone else's face, from a client's site, on a weak GPS fix: it goes through, flagged.
  const b = JSON.parse(must('designer', punch('designer', 'am_out', SITE, OTHER, 250)));
  assert.ok(b.face_match < 0.45 && b.flags.includes('face_mismatch'), 'flagged: ' + b.face_match);
  assert.ok(b.flags.includes('off_site') && b.flags.includes('low_gps_accuracy'));
  assert.ok(b.office_distance_m > 4500 && b.office_distance_m < 6000, 'about 5 km: ' + b.office_distance_m);
  // No template sent (no face found on the phone), and a row written straight to the table claiming a perfect score.
  const c = JSON.parse(must('designer', punch('designer', 'pm_in', OFFICE)));
  assert.ok(c.face_match === null && c.flags.includes('no_face_check'));
  must('designer', `insert into public.attendance_punches (kind, lat, lng, accuracy_m, selfie_path, face_match, flags)
    values ('pm_out', ${OFFICE[0]}, ${OFFICE[1]}, 10, '${U.designer}/x.jpg', 1, '{}')`);
  assert.equal(must('super', `select (face_match is null)::text || '|' || ('no_face_check' = any(flags))::text from public.attendance_punches where kind = 'pm_out'`), 'true|true', 'a score from the phone is thrown away');
  refused('designer', `select public.attendance_punch('lunch', 8.5, 124.6, 10, '${U.designer}/y.jpg')`, /which punch/);
  refused('purchaser', punch('purchaser', 'am_in', OFFICE), /accept the attendance notice/);
  db.sql('designer', `update public.attendance_punches set lat = 0`);   // staff have no update rights: nothing changes
  assert.equal(must('super', `select count(*) from public.attendance_punches where lat = 0`), '0');
  refused('admin', `update public.attendance_punches set lat = 0`, /can't be edited/);
});

test('everyone sees their own; the admin sees the day, reviews, and the month adds up', () => {
  const { U, must, refused } = db;
  const me = JSON.parse(must('designer', 'select public.attendance_me()'));
  assert.deepEqual(me.punches.map((p) => p.kind), ['am_in', 'am_out', 'pm_in', 'pm_out']);
  assert.ok(!('lat' in me.punches[0]) && !('face_match' in me.punches[0]), "the person's own view carries no coordinates or scores");
  assert.equal(JSON.parse(must('purchaser', 'select public.attendance_me()')).punches.length, 0, "not Dina's");
  assert.equal(must('purchaser', 'select count(*) from public.attendance_punches'), '0');
  refused('designer', `select public.attendance_day('${me.today}')`, /Only the admin and the bookkeeper/);
  refused('designer', `select public.attendance_month('${me.today}')`, /Only the admin and the bookkeeper/);
  const day = JSON.parse(must('admin', `select public.attendance_day('${me.today}')`));
  assert.deepEqual(day.people.map((p) => [p.name, p.enrolled, p.punches.length]), [['Dina', true, 4], ['Jason', false, 0], ['Pia', false, 0]]);
  const flagged = day.people[0].punches.find((p) => p.kind === 'am_out');
  assert.ok(flagged.selfie_path.startsWith(U.designer) && flagged.lat === SITE[0] && flagged.reviewed_at === null);
  refused('designer', `select public.attendance_review('${flagged.id}', 'fine')`, /Only an admin/);
  must('admin', `select public.attendance_review('${flagged.id}', ' Was at the Navales site with Jane ')`);
  const again = JSON.parse(must('admin', `select public.attendance_day('${me.today}')`)).people[0].punches.find((p) => p.kind === 'am_out');
  assert.ok(again.reviewed_at && again.admin_note === 'Was at the Navales site with Jane');
  const month = JSON.parse(must('admin', `select public.attendance_month('${me.today}')`));
  const dina = month.find((m) => m.name === 'Dina');
  assert.deepEqual([dina.days, dina.incomplete_days, dina.to_review], [1, 0, 2], 'pm_in and pm_out still wait for a look');
  assert.deepEqual([month.find((m) => m.name === 'Pia').days, month.length], [0, 3]);
  // Reset: the reference photo goes, and Dina can take a new one.
  must('admin', `select public.attendance_face_reset('${U.designer}')`);
  assert.equal(JSON.parse(must('designer', 'select public.attendance_me()')).enrolled, false);
  must('designer', `select public.attendance_enroll('${OTHER}'::real[], '${U.designer}/enroll3.jpg')`);
  // Retention: nothing is old yet; an aged punch is listed and then marked.
  assert.equal(must('admin', 'select public.attendance_old_selfies(90)'), '[]');
  must('super', `alter table public.attendance_punches disable trigger attendance_guard;
    update public.attendance_punches set punched_at = now() - interval '100 days' where kind = 'am_in';
    alter table public.attendance_punches enable trigger attendance_guard;`);
  const old = JSON.parse(must('admin', 'select public.attendance_old_selfies(90)'));
  assert.equal(old.length, 1);
  assert.equal(must('admin', `select public.attendance_selfies_cleared(array['${old[0].id}']::uuid[])`), '1');
  assert.equal(must('admin', 'select public.attendance_old_selfies(90)'), '[]');
  refused('designer', 'select public.attendance_old_selfies(90)', /Only an admin/);
  refused('anon', 'select public.attendance_me()', /permission denied/);
});
