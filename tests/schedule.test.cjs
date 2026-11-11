// Schedule (supabase/migrations/20261113000008_schedule.sql) on a real local PostgreSQL:
// who sees which project, who may move which stage, planned dates, events and the calendar feed.
//   node --test tests/schedule.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => s.replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const board = (actor) => JSON.parse(db.must(actor, 'select public.schedule_board()'));
const events = (actor, from, to) => JSON.parse(db.must(actor, `select public.schedule_events('${from}', '${to}')`));
const stage = (id, s) => db.must('super', `select status || '|' || coalesce(actual_start::text, '-') || '|' || coalesce(actual_end::text, '-')
  || '|' || coalesce(planned_start::text, '-') || '|' || coalesce(planned_end::text, '-') from public.project_stages where project_id = '${id}' and stage = '${s}'`);
let today;

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.fab = '00000000-0000-4000-8000-00000000000f';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'designer@example.com', '{"full_name":"Dina Designer"}'), ('${U.fab}', 'fab@example.com', '{"full_name":"Rudy"}');
    update public.profiles set role = 'admin', active = true where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';
    update public.profiles set role = 'fabrication', active = true where id = '${U.fab}';`);
  must('admin', `insert into public.tracker_docs (collection, id, data) values
    ('projects', 'p_k', '{"name":"Kitchen – Ana Reyes","clientName":"Ana Reyes","clientPhone":"0917 555 0142","clientEmail":"ana@example.com","price":250000,"budget":160000,"status":"active","system":"kitchen","targetDate":"2026-12-20"}'),
    ('projects', 'p_w', '{"name":"Wardrobe – Ben Cruz","clientName":"Ben Cruz","price":90000,"status":"active","system":"storage"}')`);
  today = must('super', `select (now() at time zone 'Asia/Manila')::date`);
});
test.after(() => db && db.stop());

test('every project gets all nine stages, and only an admin plans dates, all or nothing', () => {
  const { must, refused } = db;
  assert.equal(must('super', `select string_agg(stage::text, ',' order by stage) from public.project_stages where project_id = 'p_k'`),
    'consultation,design,cutlist,bom,final_cutlist,procurement,fabrication,installation,handover');
  assert.equal(must('admin', `select public.stage_plan('p_k', ${j([
    { stage: 'design', planned_start: '2026-11-16', planned_end: '2026-11-23' },
    { stage: 'cutlist', planned_start: '2026-11-24', planned_end: '2026-11-25' },
    { stage: 'fabrication', planned_start: '2026-12-01', planned_end: '2026-12-16' }])})`), '3');
  assert.equal(stage('p_k', 'design'), 'not_started|-|-|2026-11-16|2026-11-23');
  refused('designer', `select public.stage_plan('p_k', ${j([{ stage: 'design', planned_start: '2026-11-17', planned_end: '2026-11-24' }])})`, /Only an admin can plan/);
  // An end before its start fails the whole batch: the good row before it is not kept.
  refused('admin', `select public.stage_plan('p_k', ${j([{ stage: 'design', planned_start: '2026-11-18', planned_end: '2026-11-25' },
    { stage: 'bom', planned_start: '2026-11-30', planned_end: '2026-11-26' }])})`, /check constraint/);
  assert.equal(stage('p_k', 'design'), 'not_started|-|-|2026-11-16|2026-11-23');
  refused('admin', `select public.stage_plan('p_k', ${j([{ stage: 'painting', planned_start: '2026-11-18' }])})`, /invalid input value for enum/);
  refused('admin', `select public.stage_plan('nope', ${j([{ stage: 'design', planned_start: '2026-11-18' }])})`, /Planned 0 of 1/);
});

test('staff see only the projects they are assigned to, and never the money or the client email', () => {
  const { U, must, refused } = db;
  assert.deepEqual(board('designer').projects, [], 'nothing assigned yet');
  assert.equal(board('designer').role, 'designer');
  refused('designer', `select public.stage_save('p_k', 'design', ${j({ status: 'in_progress' })})`, /isn't yours to change/);
  // Assigning a stage hands over the project.
  must('admin', `select public.stage_save('p_k', 'design', ${j({ assignee: U.designer })})`);
  assert.equal(must('super', `select count(*) from public.project_assignments where project_id = 'p_k' and user_id = '${U.designer}'`), '1');
  const b = board('designer');
  assert.deepEqual(b.projects.map((p) => p.id), ['p_k']);
  const text = JSON.stringify(b);
  for (const secret of ['250000', '160000', 'ana@example.com', 'price', 'budget']) assert.ok(!text.includes(secret), `staff board leaks ${secret}`);
  const can = Object.fromEntries(b.projects[0].stages.map((s) => [s.stage, s.can_edit]));
  assert.deepEqual(can, { consultation: false, design: true, cutlist: true, bom: true, final_cutlist: true, procurement: false, fabrication: false, installation: false, handover: false });
  assert.deepEqual(b.projects[0].stages.map((s) => s.stage), ['consultation', 'design', 'cutlist', 'bom', 'final_cutlist', 'procurement', 'fabrication', 'installation', 'handover']);
  assert.equal(board('admin').projects.length, 2);
  assert.deepEqual(board('admin').staff.map((s) => s.full_name), ['Dina Designer', 'Jason', 'Rudy']);
  refused('fab', `select public.stage_save('p_k', 'fabrication', ${j({ status: 'in_progress' })})`, /isn't yours to change/);   // not assigned
  refused('anon', 'select public.schedule_board()', /permission denied/);
  refused('anon', `select public.stage_save('p_k', 'design', ${j({ status: 'done' })})`, /permission denied/);
});

test('a status tap fills in the actual dates; only an admin moves planned dates or the assignee', () => {
  const { U, must, refused } = db;
  must('designer', `select public.stage_save('p_k', 'design', ${j({ status: 'in_progress', notes: 'Client chose oak laminate' })})`);
  assert.equal(stage('p_k', 'design'), `in_progress|${today}|-|2026-11-16|2026-11-23`);
  must('designer', `select public.stage_save('p_k', 'design', ${j({ status: 'done' })})`);
  assert.equal(stage('p_k', 'design'), `done|${today}|${today}|2026-11-16|2026-11-23`);
  // Reopened: the finish date goes, the start stays.
  must('designer', `select public.stage_save('p_k', 'design', ${j({ status: 'in_progress' })})`);
  assert.equal(stage('p_k', 'design'), `in_progress|${today}|-|2026-11-16|2026-11-23`);
  // A finish date typed by hand is kept.
  must('designer', `select public.stage_save('p_k', 'design', ${j({ status: 'done', actual_end: today })})`);
  assert.equal(stage('p_k', 'design').split('|')[2], today);
  refused('designer', `select public.stage_save('p_k', 'design', ${j({ planned_end: '2026-11-30' })})`, /Only an admin can change planned dates/);
  refused('designer', `select public.stage_save('p_k', 'design', ${j({ assignee: U.fab })})`, /Only an admin can change planned dates or the assignee/);
  refused('designer', `select public.stage_save('p_k', 'fabrication', ${j({ status: 'in_progress' })})`, /isn't yours to change/);
  // Sending the planned dates unchanged is fine (the page sends the whole row).
  must('designer', `select public.stage_save('p_k', 'cutlist', ${j({ status: 'in_progress', planned_start: '2026-11-24', planned_end: '2026-11-25' })})`);
  refused('designer', `select public.stage_save('p_k', 'cutlist', ${j({ actual_start: '2026-11-30', actual_end: '2026-11-20' })})`, /check constraint/);
  assert.equal(must('super', `select notes from public.project_stages where project_id = 'p_k' and stage = 'design'`), 'Client chose oak laminate');
});

test('events: admin writes, staff see their projects and company-wide ones, Manila day edges', () => {
  const { must, refused } = db;
  const save = (e) => must('admin', `select public.event_save(${j(e)})`);
  const visit = save({ project_id: 'p_k', kind: 'site_visit', title: 'Measure kitchen', starts_at: '2026-11-30T23:30:00+08:00', ends_at: '2026-11-30T23:59:00+08:00' });
  save({ kind: 'holiday', title: 'Bonifacio Day', starts_at: '2026-11-30T00:00:00+08:00', ends_at: '2026-11-30T23:59:00+08:00' });
  save({ project_id: 'p_w', kind: 'delivery', title: 'Deliver wardrobe', starts_at: '2026-11-30T09:00:00+08:00' });
  assert.deepEqual(events('admin', '2026-11-30', '2026-11-30').events.map((e) => e.title).sort(), ['Bonifacio Day', 'Deliver wardrobe', 'Measure kitchen']);
  assert.deepEqual(events('admin', '2026-12-01', '2026-12-31').events, [], '23:30 Manila on the 30th is not December');
  assert.deepEqual(events('designer', '2026-11-01', '2026-11-30').events.map((e) => e.title).sort(), ['Bonifacio Day', 'Measure kitchen']);
  refused('designer', `select public.event_save(${j({ kind: 'meeting', title: 'x', starts_at: '2026-11-20T09:00:00+08:00' })})`, /Only an admin/);
  refused('designer', `select public.event_delete('${visit}')`, /Only an admin/);
  must('admin', `select public.event_save(${j({ id: visit, project_id: 'p_k', kind: 'site_visit', title: 'Measure kitchen (moved)', starts_at: '2026-12-02T09:00:00+08:00', ends_at: '2026-12-02T10:00:00+08:00' })})`);
  assert.deepEqual(events('designer', '2026-12-01', '2026-12-31').events.map((e) => e.title), ['Measure kitchen (moved)']);
  refused('admin', `select public.event_save(${j({ kind: 'party', title: 'x', starts_at: '2026-11-20T09:00:00+08:00' })})`, /check constraint/);
  refused('admin', `select public.event_save(${j({ kind: 'meeting', title: 'x', starts_at: '2026-11-20T10:00:00+08:00', ends_at: '2026-11-20T09:00:00+08:00' })})`, /check constraint/);
  must('admin', `select public.event_delete('${visit}')`);
  refused('admin', `select public.event_delete('${visit}')`, /No event/);
  refused('anon', `select public.schedule_events('2026-11-01', '2026-11-30')`, /permission denied/);
});

test('the calendar shows the admin open leads\' follow-ups and requested visits; staff get none', () => {
  const { must } = db;
  must('admin', `insert into public.leads (source, name, phone, next_action, next_action_at, visit_requested) values
    ('website', 'Carla', '0917 111 2222', 'Send quote', '2026-11-18', '2026-11-21 Morning'),
    ('website', 'Won already', '0917 333 4444', 'Nothing', '2026-11-18', '2026-11-21 Morning'),
    ('website', 'No date', '0917 555 6666', '', null, 'next week sometime')`);
  must('admin', `update public.leads set stage = 'won' where name = 'Won already'`);
  const leads = events('admin', '2026-11-01', '2026-11-30').leads;
  assert.deepEqual(leads.map((l) => `${l.date} ${l.kind} ${l.name} ${l.text}`),
    ['2026-11-18 follow_up Carla Send quote', '2026-11-21 visit_request Carla Morning']);
  assert.deepEqual(events('designer', '2026-11-01', '2026-11-30').leads, []);
  assert.deepEqual(events('fab', '2026-11-01', '2026-11-30').leads, []);
});

test('the whiteboard: rows added by the admin, the office\'s own words, "submitted" and "no feedback yet"', () => {
  const { U, must, refused } = db;
  const id = must('admin', `select public.board_project_save(${j({ clientName: 'Dr. Dy', projectType: 'TV console', inCharge: 'Jane' })})`);
  assert.match(id, /^p_[0-9a-f]{16}$/);
  const doc = JSON.parse(must('admin', `select data from public.tracker_docs where id = '${id}'`));
  assert.deepEqual([doc.name, doc.clientName, doc.projectType, doc.inCharge, doc.system, doc.status], ['TV console – Dr. Dy', 'Dr. Dy', 'TV console', 'Jane', 'storage', 'active']);
  assert.equal(must('super', `select count(*) from public.project_stages where project_id = '${id}'`), '9');
  const pantry = must('admin', `select public.board_project_save(${j({ clientName: 'Ar. Amerol', projectType: 'Walk-in pantry', inCharge: 'Yhna' })})`);
  assert.equal(JSON.parse(must('admin', `select data from public.tracker_docs where id = '${pantry}'`)).system, 'kitchen');
  // Changing the person in charge leaves the price and everything else alone.
  must('admin', `select public.board_project_save(${j({ id: 'p_k', inCharge: 'Paula', projectType: 'Kitchen' })})`);
  const k = JSON.parse(must('admin', `select data from public.tracker_docs where id = 'p_k'`));
  assert.deepEqual([k.inCharge, k.projectType, k.price, k.clientName], ['Paula', 'Kitchen', 250000, 'Ana Reyes']);
  refused('designer', `select public.board_project_save(${j({ clientName: 'X' })})`, /Only an admin/);
  refused('admin', `select public.board_project_save(${j({ clientName: '' })})`, /client's name/);
  refused('admin', `select public.board_project_save(${j({ id: 'nope', inCharge: 'X' })})`, /No project/);
  // Staff see the type and the person in charge of their own projects, not of others.
  const mine = board('designer').projects;
  assert.deepEqual(mine.map((p) => [p.id, p.type, p.in_charge]), [['p_k', 'Kitchen', 'Paula']]);
  assert.equal(board('admin').projects.find((p) => p.id === id).in_charge, 'Jane');
  // The whiteboard's in-between states count as started, and are the designer's to set on their stages.
  must('designer', `select public.stage_save('p_k', 'bom', ${j({ status: 'submitted' })})`);
  assert.equal(stage('p_k', 'bom').split('|').slice(0, 3).join('|'), `submitted|${today}|-`);
  must('designer', `select public.stage_save('p_k', 'final_cutlist', ${j({ status: 'submitted', notes: 'For review' })})`);
  must('admin', `select public.stage_save('${pantry}', 'design', ${j({ status: 'waiting_client', notes: 'Design proposal sent' })})`);
  assert.equal(stage(pantry, 'design').split('|').slice(0, 3).join('|'), `waiting_client|${today}|-`);
  refused('designer', `select public.stage_save('p_k', 'fabrication', ${j({ status: 'in_progress' })})`, /isn't yours/);
  refused('anon', `select public.board_project_save(${j({ clientName: 'X' })})`, /permission denied/);
  refused('anon', 'select * from public.project_labels()', /permission denied/);
});
