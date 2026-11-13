// Inventory and the purchaser role: supabase/migrations/20261115000011 and …12 on a real local PostgreSQL.
//   node --test tests/inventory.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db, ply;
test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.purchaser}', 'pia@example.com', '{"full_name":"Pia"}');
    update public.profiles set role = 'admin', active = true where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';
    update public.profiles set role = 'purchaser', active = true, full_name = 'Pia' where id = '${U.purchaser}';`);
});
test.after(() => db && db.stop());

test('the purchaser keeps the list: add an item, no duplicates, others refused', () => {
  const { must, refused } = db;
  ply = must('purchaser', `select public.inventory_item_save('{"name":" Marine plywood ","spec":"18 mm","category":"board","unit":"sheet","reorder_level":"5","location":"Rack A"}'::jsonb)`);
  assert.match(ply, /^[0-9a-f-]{36}$/);
  refused('purchaser', `select public.inventory_item_save('{"name":"marine plywood","spec":"18 MM"}'::jsonb)`, /already on the list/);
  refused('purchaser', `select public.inventory_item_save('{"name":"  "}'::jsonb)`, /name/);
  refused('designer', `select public.inventory_item_save('{"name":"Hinges"}'::jsonb)`, /purchaser and the admin/);
  refused('designer', 'select public.inventory_board()', /purchaser and the admin/);
  refused('anon', 'select public.inventory_board()', /permission denied/);
  assert.equal(must('designer', 'select count(*) from public.inventory_items'), '0', 'row-level security hides the table too');
});

test('add and minus: every change is a movement, and stock never goes below zero', () => {
  const { must, refused } = db;
  assert.equal(must('purchaser', `select public.inventory_move('${ply}', 'receive', 10, '', 'Delivery from supplier')`), '10.00');
  assert.equal(must('purchaser', `select public.inventory_move('${ply}', 'issue', 3, 'Navales', 'Base cabinets')`), '7.00');
  assert.equal(must('admin', `select public.inventory_move('${ply}', 'issue', -2.5, 'Cobero')`), '4.50', 'a minus typed as a minus is still a minus');
  refused('purchaser', `select public.inventory_move('${ply}', 'issue', 5)`, /Only 4.5 sheet of Marine plywood on hand/);
  refused('purchaser', `select public.inventory_move('${ply}', 'issue', 0)`, /quantity/);
  refused('purchaser', `select public.inventory_move('${ply}', 'steal', 1)`, /add, use or count/);
  // A stock count sets the figure by writing the difference, so the history stays whole.
  assert.equal(must('purchaser', `select public.inventory_move('${ply}', 'count', 4, '', 'Month-end count')`), '4.00');
  assert.equal(must('super', `select qty || '|' || kind from public.inventory_moves order by id desc limit 1`), '-0.50|adjust');
  // The guard holds for rows written straight to the table, and movements can't be edited or deleted.
  refused('purchaser', `insert into public.inventory_moves (item_id, qty, kind) values ('${ply}', -99, 'issue')`, /Only 4 sheet/);
  refused('purchaser', `insert into public.inventory_moves (item_id, qty, kind) values ('${ply}', -1, 'receive')`, /is a plus/);
  refused('purchaser', `update public.inventory_moves set qty = 999`, /permission denied/);
  refused('purchaser', `delete from public.inventory_moves`, /permission denied/);
  refused('designer', `insert into public.inventory_moves (item_id, qty, kind) values ('${ply}', 1, 'receive')`, /row-level security|No such item/);
  refused('purchaser', `select public.inventory_item_save('{"id":"${ply}","name":"Marine plywood","active":false}'::jsonb)`, /zero before removing/);
});

test('inventory_board: stock, who moved it, open jobs by name only', () => {
  const { must } = db;
  must('admin', `select public.board_project_save('{"clientName":"Navales","projectType":"Kitchen"}'::jsonb)`);
  must('super', `update public.tracker_docs set data = data || '{"price": 250000}' where collection = 'projects'`);
  const b = JSON.parse(must('purchaser', 'select public.inventory_board()'));
  assert.equal(b.role, 'purchaser');
  assert.deepEqual(b.items.map((i) => [i.name, i.spec, i.unit, i.on_hand, i.reorder_level]), [['Marine plywood', '18 mm', 'sheet', 4, 5]]);
  assert.deepEqual(b.moves.map((m) => [m.qty, m.kind, m.job, m.by]),
    [[-0.5, 'adjust', '', 'Pia'], [-2.5, 'issue', 'Cobero', 'Jason'], [-3, 'issue', 'Navales', 'Pia'], [10, 'receive', '', 'Pia']]);
  assert.deepEqual(b.jobs, ['Navales']);
  assert.doesNotMatch(JSON.stringify(b), /250000|price/, 'no money leaves with the job names');
});

test('the purchaser role elsewhere: procurement documents and the procurement stage, nothing more', () => {
  const { U, must, refused } = db;
  must('purchaser', `insert into public.tracker_docs (collection, id, data) values ('procurementJobs', 'pj_test', '{"name":"Hinges order"}')`);
  must('purchaser', `insert into public.tracker_docs (collection, id, parent_id, data) values ('procurement', 'pr_test', 'pj_test', '{}')`);
  assert.equal(must('purchaser', `select string_agg(distinct collection, ',' order by collection) from public.tracker_docs`), 'procurement,procurementJobs', 'projects stay invisible');
  refused('purchaser', `insert into public.tracker_docs (collection, id, data) values ('expenses', 'e_test', '{}')`, /row-level security/);
  refused('purchaser', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_test', '{}')`, /row-level security/);
  assert.equal(must('designer', `select count(*) from public.tracker_docs`), '0');
  assert.equal(must('super', `select public.role_owns_stage('purchaser', 'procurement') || '|' || public.role_owns_stage('purchaser', 'design') || '|' || public.role_owns_stage('designer', 'procurement')`), 'true|false|false');
  // On the Schedule: assigned the procurement stage, the purchaser can move it and nothing else.
  const pid = must('super', `select id from public.tracker_docs where collection = 'projects' limit 1`);
  must('admin', `select public.stage_save('${pid}', 'procurement', '{"assignee":"${U.purchaser}"}'::jsonb)`);
  // Buying waits for the approved BOM (Phase 4: tests/approvals.test.cjs).
  refused('purchaser', `select public.stage_save('${pid}', 'procurement', '{"status":"in_progress"}'::jsonb)`, /Procurement can't start until BOM is approved/);
  must('admin', `select public.stage_save('${pid}', 'bom', '{"status":"done"}'::jsonb)`);
  must('purchaser', `select public.stage_save('${pid}', 'procurement', '{"status":"in_progress"}'::jsonb)`);
  refused('purchaser', `select public.stage_save('${pid}', 'design', '{"status":"done"}'::jsonb)`);
  const board = JSON.parse(must('purchaser', 'select public.schedule_board()'));
  assert.deepEqual(board.projects.map((p) => p.client), ['Navales']);
  assert.doesNotMatch(JSON.stringify(board), /250000/);
});
