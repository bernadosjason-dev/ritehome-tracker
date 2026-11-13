// Roles (supabase/migrations/20261117000015_multi_role.sql) on a real local PostgreSQL: one person
// with several roles, the sales and bookkeeper roles, and the site visit stage. Every rule has its
// refused side.
//   node --test tests/roles.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => s.replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const roles = (actor) => db.must(actor, `select array_to_string(public.my_roles(), ',')`);
const board = (actor) => JSON.parse(db.must(actor, 'select public.schedule_board()'));

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.sales = '00000000-0000-4000-8000-000000000005';
  U.books = '00000000-0000-4000-8000-000000000006';
  U.multi = '00000000-0000-4000-8000-000000000007';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'designer@example.com', '{"full_name":"Dina"}'), ('${U.sales}', 'sales@example.com', '{"full_name":"Sam"}'),
    ('${U.books}', 'books@example.com', '{"full_name":"Bea"}'), ('${U.multi}', 'multi@example.com', '{"full_name":"Mia"}'),
    ('${U.inactive}', 'off@example.com', '{}');
    update public.profiles set role = 'admin', active = true where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true where id = '${U.sales}';
    update public.profiles set role = 'bookkeeper', active = true where id = '${U.books}';
    update public.profiles set role = 'sales', active = true where id = '${U.multi}';`);
  must('admin', `insert into public.tracker_docs (collection, id, data) values
    ('projects', 'p_k', '{"name":"Kitchen – Ana Reyes","clientName":"Ana Reyes","clientEmail":"ana@example.com","price":250000,"budget":160000,"status":"active"}'),
    ('procurementJobs', 'j_1', '{"name":"Job 1"}')`);
});
test.after(() => db && db.stop());

test('every project gets a site visit stage between consultation and design', () => {
  assert.equal(db.must('super', `select string_agg(stage::text, ',' order by stage) from public.project_stages where project_id = 'p_k'`),
    'consultation,site_visit,design,cutlist,bom,final_cutlist,procurement,fabrication,installation,handover');
});

test('the admin gives one person several roles; admin is only ever a main role', () => {
  const { U, must, refused } = db;
  assert.equal(roles('multi'), 'sales');
  const r = JSON.parse(must('admin', `select public.team_update('${U.multi}', ${j({ extra_roles: ['bookkeeper', 'purchaser', 'sales', 'purchaser'] })})`));
  assert.deepEqual([r.role, r.extra_roles], ['sales', ['bookkeeper', 'purchaser']], 'the main role and repeats are dropped from the extras');
  assert.equal(roles('multi'), 'sales,bookkeeper,purchaser');
  refused('admin', `select public.team_update('${U.multi}', ${j({ extra_roles: ['admin'] })})`, /Admin is a main role/);
  refused('admin', `select public.team_update('${U.multi}', ${j({ extra_roles: 'sales' })})`, /as a list/);
  refused('admin', `select public.team_update('${U.multi}', ${j({ extra_roles: ['owner'] })})`, /invalid input value for enum/);
  refused('super', `update public.profiles set extra_roles = '{admin}' where id = '${U.multi}'`, /profiles_extra_roles_not_admin/);
  // Changing the main role to one of the extras drops it from the extras.
  const r2 = JSON.parse(must('admin', `select public.team_update('${U.multi}', ${j({ role: 'purchaser' })})`));
  assert.deepEqual([r2.role, r2.extra_roles], ['purchaser', ['bookkeeper']]);
  must('admin', `select public.team_update('${U.multi}', ${j({ role: 'sales', extra_roles: ['bookkeeper', 'purchaser'] })})`);
  // Nobody but an admin hands out roles, not even to themselves.
  refused('multi', `select public.team_update('${U.multi}', ${j({ extra_roles: ['designer'] })})`, /Only an admin/);
  assert.equal(must('multi', `update public.profiles set extra_roles = '{designer}' where id = '${U.multi}' returning id`), '', 'row-level security hides the row');
  assert.equal(roles('multi'), 'sales,bookkeeper,purchaser');
  // An inactive account holds no roles at all.
  must('super', `update public.profiles set extra_roles = '{sales}' where id = '${U.inactive}'`);
  assert.equal(roles('inactive'), '');
  assert.equal(must('inactive', `select public.has_role('sales')`), 'f');
  assert.deepEqual(JSON.parse(must('admin', 'select public.team_list()')).find((p) => p.id === U.multi).extra_roles, ['bookkeeper', 'purchaser']);
});

test('making someone admin clears their extra roles', () => {
  const { U, must } = db;
  U.temp = '00000000-0000-4000-8000-000000000008';
  must('super', `insert into auth.users (id, email) values ('${U.temp}', 't@example.com');
    update public.profiles set role = 'designer', extra_roles = '{sales}', active = true where id = '${U.temp}';`);
  const r = JSON.parse(must('admin', `select public.team_update('${U.temp}', ${j({ role: 'admin' })})`));
  assert.deepEqual([r.role, r.extra_roles], ['admin', []]);
  must('admin', `select public.team_update('${U.temp}', ${j({ active: false })})`);
});

test('sales works the leads; converting a lead into a project stays with the admin', () => {
  const { must, refused } = db;
  const id = must('sales', `select public.lead_save(${j({ source: 'walk-in', name: 'Carlo Diaz', phone: '0917 000 1111', expected_value: 180000 })})`);
  must('sales', `select public.lead_log('${id}', 'call', 'Asked for a quote', 'Send quote', '2026-11-20')`);
  must('sales', `select public.lead_save(${j({ id, stage: 'quoted' })})`);
  const got = JSON.parse(must('sales', `select public.lead_get('${id}')`));
  assert.equal(got.lead.stage, 'quoted');
  assert.equal(got.activity[0].by_name, 'Sam', 'sales sees who logged the contact');
  assert.equal(JSON.parse(must('sales', 'select public.leads_list()')).length, 1);
  refused('sales', `select public.lead_convert('${id}', 180000, 120000)`, /Only an admin/);
  // The person holding sales as an extra role gets the same.
  assert.equal(JSON.parse(must('multi', 'select public.leads_list()')).length, 1);
  // Everyone else: no leads, not even an empty list.
  for (const who of ['designer', 'books', 'inactive']) {
    assert.equal(JSON.parse(must(who, 'select public.leads_list()')).length, 0, `${who} sees no leads`);
    refused(who, `select public.lead_save(${j({ name: 'X', phone: '1' })})`, /Only sales or an admin/);
    refused(who, `select public.lead_log('${id}', 'note', 'x')`, /Only sales or an admin/);
  }
  assert.equal(must('designer', `select count(*) from public.lead_activity`), '0');
  // The calendar's lead follow-ups reach sales, not other staff.
  assert.equal(JSON.parse(must('sales', `select public.schedule_events('2026-11-01', '2026-11-30')`)).leads.length, 1);
  assert.equal(JSON.parse(must('designer', `select public.schedule_events('2026-11-01', '2026-11-30')`)).leads.length, 0);
  // Converting by the admin still works.
  assert.match(must('admin', `select public.lead_convert('${id}', 180000, 120000)`), /^p_/);
});

test('sales works consultation and site visit on assigned projects, and nothing else', () => {
  const { U, must, refused } = db;
  refused('sales', `select public.stage_save('p_k', 'site_visit', ${j({ status: 'in_progress' })})`, /isn't yours to change/);   // not assigned
  must('admin', `select public.stage_save('p_k', 'site_visit', ${j({ assignee: U.sales })})`);
  const b = board('sales');
  assert.deepEqual(b.roles, ['sales']);
  const can = Object.fromEntries(b.projects[0].stages.map((s) => [s.stage, s.can_edit]));
  assert.deepEqual(can, { consultation: true, site_visit: true, design: false, cutlist: false, bom: false, final_cutlist: false,
    procurement: false, fabrication: false, installation: false, handover: false });
  must('sales', `select public.stage_save('p_k', 'site_visit', ${j({ status: 'done', notes: 'Measured 4.2 m wall' })})`);
  assert.equal(must('super', `select status from public.project_stages where project_id = 'p_k' and stage = 'site_visit'`), 'done');
  refused('sales', `select public.stage_save('p_k', 'design', ${j({ status: 'in_progress' })})`, /isn't yours to change/);
  refused('sales', `select public.stage_save('p_k', 'site_visit', ${j({ planned_end: '2026-12-01' })})`, /Only an admin can change planned dates/);
  for (const secret of ['250000', '160000', 'ana@example.com']) assert.ok(!JSON.stringify(b).includes(secret), `sales board leaks ${secret}`);
  // The designer still can't touch the sales stages.
  must('admin', `select public.stage_save('p_k', 'design', ${j({ assignee: U.designer })})`);
  refused('designer', `select public.stage_save('p_k', 'consultation', ${j({ status: 'done' })})`, /isn't yours to change/);
});

test('an extra role gives exactly that role\'s access: purchaser stock and procurement; projects only read, never written', () => {
  const { must, refused } = db;
  assert.equal(must('multi', 'select public.can_stock()'), 't');
  must('multi', `select public.inventory_item_save(${j({ name: 'Plywood 18mm', category: 'board', unit: 'sheet' })})`);
  assert.equal(must('multi', `select count(*) from public.tracker_docs where collection = 'procurementJobs'`), '1');
  // Their bookkeeper extra role reads the books' sources (projects) since v3.1, read only.
  assert.equal(must('multi', `select count(*) from public.tracker_docs where collection = 'projects'`),
    must('super', `select count(*) from public.tracker_docs where collection = 'projects'`));
  refused('multi', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_x', '{}')`, /row-level security/);
  // Without the purchaser role: no stock, no procurement documents.
  for (const who of ['sales', 'books', 'designer']) {
    assert.equal(must(who, 'select public.can_stock()'), 'f');
    refused(who, 'select public.inventory_board()', /purchaser and the admin/);
    assert.equal(must(who, `select count(*) from public.tracker_docs where collection in ('procurementJobs', 'procurement')`), '0');
  }
  assert.equal(must('sales', `select count(*) from public.tracker_docs`), '0');
  assert.equal(must('designer', `select count(*) from public.tracker_docs`), '0');
});

test('the bookkeeper: the books and the company profile (phase 5), no stages, no team, their own attendance', () => {
  const { must, refused } = db;
  assert.equal(roles('books'), 'bookkeeper');
  assert.equal(must('super', `select count(*) from unnest(enum_range(null::public.stage_key)) s where public.role_owns_stage('bookkeeper', s::text)`), '0');
  assert.deepEqual(board('books').projects, []);
  // The books are theirs since v3.1 (tests/bookkeeper.test.cjs has the details).
  const books = JSON.parse(must('books', 'select public.acct_config()'));
  assert.notEqual(books.settings, null); assert(books.accounts.length > 0);
  assert.equal(must('books', 'select public.can_keep_books()'), 't');
  refused('books', 'select public.team_list()', /Only an admin/);
  must('books', 'select public.attendance_me()');
});
