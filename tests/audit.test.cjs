// Activity log (supabase/migrations/20261118000016_audit_log.sql) on a real local PostgreSQL:
// who changed what, before and after, nothing secret copied, nobody can edit or delete the log.
//   node --test tests/audit.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => s.replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const search = (actor, p = {}) => JSON.parse(db.must(actor, `select public.audit_search(${j(p)})`));
const last = (p) => search('admin', Object.assign({ limit: 1 }, p))[0];

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.sales = '00000000-0000-4000-8000-000000000005';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'designer@example.com', '{"full_name":"Dina"}'), ('${U.sales}', 'sales@example.com', '{"full_name":"Sam"}'),
    ('${U.inactive}', 'off@example.com', '{}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'sales', extra_roles = '{bookkeeper}', active = true, full_name = 'Sam' where id = '${U.sales}';`);
});
test.after(() => db && db.stop());

test('a project change is logged with who, the changed fields only, before and after, and the project', () => {
  const { must } = db;
  must('admin', `insert into public.tracker_docs (collection, id, data) values
    ('projects', 'p_k', '{"name":"Kitchen – Ana Reyes","price":250000,"status":"active","updatedAt":"2026-11-17T01:00:00Z"}')`);
  let row = last({ table: 'tracker_docs', action: 'insert' });
  assert.deepEqual([row.actor_name, row.actor_roles, row.module, row.record_id, row.project_id, row.label],
    ['Jason', ['admin'], 'Projects', 'projects/p_k', 'p_k', 'Kitchen – Ana Reyes']);
  assert.equal(row.new['data.price'], 250000);
  assert.equal(row.project_name, 'Kitchen – Ana Reyes');

  must('admin', `update public.tracker_docs set data = data || '{"price":265000,"updatedAt":"2026-11-17T02:00:00Z"}' where id = 'p_k'`);
  row = last({ table: 'tracker_docs', action: 'update' });
  assert.deepEqual(row.changed, ['data.price'], 'updatedAt and revision are noise');
  assert.deepEqual([row.old, row.new], [{ 'data.price': 250000 }, { 'data.price': 265000 }]);

  // A save that changes only the timestamp is not logged.
  const before = search('admin').length;
  must('admin', `update public.tracker_docs set data = data || '{"updatedAt":"2026-11-17T03:00:00Z"}' where id = 'p_k'`);
  assert.equal(search('admin').length, before);

  // An expense belongs to its project.
  must('admin', `insert into public.tracker_docs (collection, id, parent_id, data) values ('expenses', 'e_1', 'p_k', '{"amount":12000,"description":"Marine plywood"}')`);
  row = last({ table: 'tracker_docs' });
  assert.deepEqual([row.project_id, row.label, row.module], ['p_k', 'Marine plywood', 'Projects']);

  // The ten stages the project got from a trigger are not logged: the project's own row says it all.
  assert.equal(search('admin', { project: 'p_k', table: 'project_stages' }).length, 0);
  assert.equal(search('admin', { project: 'p_k' }).length, 3, 'the project, its price change and its expense');

  must('admin', `delete from public.tracker_docs where id = 'e_1'`);
  row = last({ table: 'tracker_docs', action: 'delete' });
  assert.equal(row.old['data.amount'], 12000);
});

test('staff changes are logged under their own name and roles', () => {
  const { U, must } = db;
  must('admin', `select public.stage_save('p_k', 'site_visit', ${j({ assignee: U.sales })})`);
  must('sales', `select public.stage_save('p_k', 'site_visit', ${j({ status: 'done', notes: 'Wall is 4.2 m' })})`);
  const row = last({ actor: U.sales, table: 'project_stages' });
  assert.deepEqual([row.actor_name, row.actor_roles, row.module, row.record_id], ['Sam', ['sales', 'bookkeeper'], 'Schedule', 'p_k/site_visit']);
  assert.deepEqual(row.changed, ['actual_end', 'actual_start', 'notes', 'status']);
  assert.equal(row.new.status, 'done');
  must('sales', `select public.lead_save(${j({ source: 'phone', name: 'Carlo Diaz', phone: '0917 000 1111' })})`);
  const lead = last({ actor: U.sales, table: 'leads', action: 'insert' });
  assert.deepEqual([lead.module, lead.label, lead.action], ['Leads', 'Carlo Diaz', 'insert']);
  // Filters: person, module, action, text, dates.
  assert.ok(search('admin', { actor: U.sales }).every((r) => r.actor === U.sales));
  assert.ok(search('admin', { module: 'Leads' }).every((r) => r.module === 'Leads'));
  assert.ok(search('admin', { q: 'carlo' }).some((r) => r.label === 'Carlo Diaz'));
  const today = must('super', `select (now() at time zone 'Asia/Manila')::date`);
  assert.ok(search('admin', { from: today, to: today }).length > 0);
  assert.equal(search('admin', { to: '2020-01-01' }).length, 0);
  // Paging: "before" continues from the last row shown.
  const page1 = search('admin', { limit: 2 });
  const page2 = search('admin', { limit: 2, before: page1[1].id });
  assert.ok(page2[0].id < page1[1].id);
});

test('secrets never reach the log: the face template, a punch\'s GPS fix and selfie path', () => {
  const { U, must } = db;
  const desc = '{' + Array(128).fill('0.1').join(',') + '}';
  must('super', `update public.profiles set face_descriptor = '${desc}' where id = '${U.designer}'`);
  let row = last({ table: 'profiles', record: U.designer });
  assert.deepEqual(row.changed, ['face_descriptor']);
  assert.deepEqual([row.old.face_descriptor, row.new.face_descriptor], ['(hidden)', '(hidden)']);
  must('designer', 'select public.accept_attendance_notice()');
  must('designer', `insert into public.attendance_punches (user_id, kind, lat, lng, accuracy_m, selfie_path)
    values ('${U.designer}', 'am_in', 8.5005, 124.6229, 12, '${U.designer}/2026-11-17-am_in.jpg')`);
  row = last({ table: 'attendance_punches' });
  const text = JSON.stringify(row);
  for (const secret of ['8.5005', '124.6229', '2026-11-17-am_in.jpg', 'accuracy_m']) assert.ok(!text.includes(secret), `log keeps ${secret}`);
  assert.equal(row.module, 'Attendance');
  assert.ok(!JSON.stringify(search('admin', { table: 'profiles' })).includes('0.1,0.1'));
});

test('nobody edits or deletes the log, and only an admin reads it', () => {
  const { refused, must } = db;
  for (const who of ['admin', 'sales', 'designer']) {
    refused(who, `insert into public.audit_log (module, table_name, action) values ('x', 'x', 'insert')`, /permission denied/);
    refused(who, `update public.audit_log set label = 'nothing happened'`, /permission denied/);
    refused(who, `delete from public.audit_log`, /permission denied/);
  }
  refused('anon', `select count(*) from public.audit_log`, /permission denied/);
  for (const who of ['sales', 'designer', 'inactive']) {
    assert.equal(must(who, `select count(*) from public.audit_log`), '0', `${who} reads no log rows`);
    refused(who, `select public.audit_search()`, /Only an admin/);
  }
  refused('anon', `select public.audit_search()`, /permission denied/);
  refused('sales', `select public.audit_row()`, /permission denied/);
});

test('pages report refused actions, from active accounts only, at most 30 an hour', () => {
  const { U, must } = db;
  must('designer', `select public.audit_refused('Leads', 'lead_save', 'Only sales or an admin can change leads.')`);
  const row = last({ action: 'refused' });
  assert.deepEqual([row.actor_name, row.module, row.label, row.source, row.new.detail],
    ['Dina', 'Leads', 'lead_save', 'page', 'Only sales or an admin can change leads.']);
  must('inactive', `select public.audit_refused('Leads', 'lead_save', 'x')`);
  assert.equal(search('admin', { action: 'refused' }).length, 1, 'an inactive account reports nothing');
  for (let i = 0; i < 40; i++) must('designer', `select public.audit_refused('Leads', 'try ${i}', '')`);
  assert.equal(search('admin', { action: 'refused', actor: U.designer }).length, 30);
});

test('the IP and browser come from the API request headers', () => {
  const { must } = db;
  must('admin', `set request.headers = '{"x-forwarded-for":"203.0.113.7, 10.0.0.1","user-agent":"Mozilla/5.0 Test"}';
    update public.tracker_docs set data = data || '{"status":"on_hold"}' where id = 'p_k'`);
  const row = last({ table: 'tracker_docs', action: 'update' });
  assert.deepEqual([row.ip, row.user_agent], ['203.0.113.7', 'Mozilla/5.0 Test']);
});
