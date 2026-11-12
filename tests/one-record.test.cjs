// One record per fact (supabase/migrations/20261121000018_one_record.sql) on a real local
// PostgreSQL: site-visit events set the stage, one guard against duplicate projects, PO deliveries
// reach Inventory, procurement jobs name their project, and the dashboard's own figures.
//   node --test tests/one-record.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const stage = (id, s) => db.must('super', `select status || '|' || coalesce(planned_start::text, '-') || '|' || coalesce(planned_end::text, '-')
  from public.project_stages where project_id = '${id}' and stage = '${s}'`);

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.sales = '00000000-0000-4000-8000-000000000005';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.purchaser}', 'pia@example.com', '{"full_name":"Pia"}'),
    ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'purchaser', active = true, full_name = 'Pia' where id = '${U.purchaser}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';`);
  must('admin', `insert into public.tracker_docs (collection, id, data) values
    ('projects', 'p_k', '{"name":"Kitchen – Ana Reyes","clientName":"Ana Reyes","clientPhone":"0917 555 0142","status":"active","price":250000}')`);
});
test.after(() => db && db.stop());

test('5. a site visit booked on the calendar sets the Site visit stage, moves with it, and leaves a finished stage alone', () => {
  const { must, refused } = db;
  const ev = must('admin', `select public.event_save(${j({ project_id: 'p_k', kind: 'site_visit', title: 'Measure', starts_at: '2026-11-20T09:00:00+08:00', ends_at: '2026-11-20T10:00:00+08:00' })})`);
  assert.equal(stage('p_k', 'site_visit'), 'not_started|2026-11-20|2026-11-20');
  must('admin', `select public.event_save(${j({ id: ev, project_id: 'p_k', kind: 'site_visit', title: 'Measure', starts_at: '2026-11-23T23:30:00+08:00', ends_at: '2026-11-23T23:59:00+08:00' })})`);
  assert.equal(stage('p_k', 'site_visit'), 'not_started|2026-11-23|2026-11-23', 'Manila day, not UTC');
  // A meeting is not a site visit; a company-wide event has no project.
  must('admin', `select public.event_save(${j({ project_id: 'p_k', kind: 'meeting', title: 'Call', starts_at: '2026-11-25T09:00:00+08:00' })})`);
  assert.equal(stage('p_k', 'site_visit'), 'not_started|2026-11-23|2026-11-23');
  must('admin', `select public.stage_save('p_k', 'site_visit', ${j({ status: 'done' })})`);
  must('admin', `select public.event_save(${j({ id: ev, project_id: 'p_k', kind: 'site_visit', title: 'Measure', starts_at: '2026-11-27T09:00:00+08:00' })})`);
  assert.equal(stage('p_k', 'site_visit').split('|')[1], '2026-11-23', 'a finished visit keeps its dates');
  refused('designer', `select public.event_save(${j({ project_id: 'p_k', kind: 'site_visit', title: 'x', starts_at: '2026-11-28T09:00:00+08:00' })})`, /Only an admin/);
});

test('2. the same client can\'t get a second open project by accident, whichever way it is made', () => {
  const { must, refused } = db;
  // Projects page (a direct insert): same name, different case and spaces.
  refused('admin', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_dup', '{"name":"Wardrobe","clientName":"  ana REYES "}')`,
    /This client already has an open project: Kitchen – Ana Reyes\./);
  // Same phone, written another way, under another name.
  refused('admin', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_dup', '{"name":"Wardrobe","clientName":"Mrs Reyes","clientPhone":"+63 917-555-0142"}')`,
    /open project: Kitchen – Ana Reyes/);
  const r = db.sql('admin', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_dup', '{"name":"Wardrobe","clientName":"Ana Reyes"}')`);
  assert.match(r.err, /HINT: {2}p_k/, 'the existing project is named for the page');
  // "Create another anyway": the flag is taken off before the row is stored.
  must('admin', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_w', '{"name":"Wardrobe – Ana Reyes","clientName":"Ana Reyes","confirmDuplicate":"true"}')`);
  assert.equal(must('super', `select data ? 'confirmDuplicate' from public.tracker_docs where id = 'p_w'`), 'f');
  // The whiteboard.
  refused('admin', `select public.board_project_save(${j({ clientName: 'Ana Reyes', projectType: 'TV console', system: 'storage' })})`, /already has an open project/);
  const tv = must('admin', `select public.board_project_save(${j({ clientName: 'Ana Reyes', projectType: 'TV console', system: 'storage', confirmDuplicate: 'true' })})`);
  assert.match(tv, /^p_/);
  // A finished job doesn't block a returning client.
  must('admin', `update public.tracker_docs set data = data || '{"status":"completed"}' where id in ('p_w', '${tv}')`);
  must('admin', `select public.board_project_save(${j({ clientName: 'Ben Cruz', projectType: 'Closet', system: 'storage' })})`);
});

test('2. a won lead links to the client\'s open project instead of making a second one', () => {
  const { must, refused } = db;
  const lead = must('sales', `select public.lead_save(${j({ source: 'phone', name: 'Ana Reyes', phone: '0917 555 0142', expected_value: 260000 })})`);
  refused('admin', `select public.lead_convert('${lead}', 260000)`, /already has an open project/);
  assert.equal(must('super', `select stage from public.leads where id = '${lead}'`), 'contacted', 'nothing changed');
  assert.equal(must('admin', `select public.lead_convert('${lead}', 260000, null, 'p_k')`), 'p_k');
  assert.equal(must('super', `select stage || '|' || project_id from public.leads where id = '${lead}'`), 'won|p_k');
  assert.equal(must('super', `select data ->> 'leadId' from public.tracker_docs where id = 'p_k'`), lead);
  assert.equal(must('super', `select count(*) from public.tracker_docs where collection = 'projects' and data ->> 'clientName' = 'Ana Reyes' and coalesce(data ->> 'status', '') <> 'completed'`), '1');
  // Or a new one on purpose.
  const lead2 = must('sales', `select public.lead_save(${j({ source: 'walk-in', name: 'Ana Reyes', phone: '0917 555 0142' })})`);
  assert.match(must('admin', `select public.lead_convert('${lead2}', 90000, null, null, true)`), /^p_/);
  const lead3 = must('sales', `select public.lead_save(${j({ source: 'phone', name: 'Cy Tan', phone: '0918 000 0000' })})`);
  refused('admin', `select public.lead_convert('${lead3}', 1, null, 'p_nope')`, /No project p_nope/);
  refused('sales', `select public.lead_convert('${lead3}', 1)`, /Only an admin/);
  assert.equal(must('super', `select project_id is null from public.leads where id = '${lead3}'`), 't');
});

test('2. the tracker hears a duplicate as its own case, with the existing project to open', async () => {
  require('../procurement.js');
  require('../supabase-backend.js');
  const B = globalThis.RitehomeSupabaseBackend;
  // A supabase-js stand-in whose insert is refused the way PostgREST reports project_duplicate_guard.
  const refusal = { code: 'RH409', message: 'This client already has an open project: Kitchen – Ana Reyes.', hint: 'p_k', details: null };
  const chain = { select() { return chain; }, single() { return Promise.resolve({ data: null, error: refusal }); } };
  const client = { from() { return { insert() { return chain; } }; } };
  const call = B.makeActions(B.makeSupabaseStore(client), globalThis.ProcurementLogic);
  const res = await call('addProject', { data: { name: 'Wardrobe', clientName: 'Ana Reyes' } });
  assert.deepEqual(res, { ok: false, code: 'duplicate_project', error: 'This client already has an open project: Kitchen – Ana Reyes.', existing: 'p_k' });
});

test('1. a PO delivery is the stock received: once, by difference, under the job and PO', () => {
  const { U, must, refused } = db;
  const doc = (received, received2 = 0) => j({
    boms: [{ id: 'b1', name: 'BOM 1', draftsman: 'Dina', date: '2026-11-20', items: [
      { id: 'i1', material: 'Marine plywood', spec: '18mm 4x8', unit: 'sheet', quantity: 20 },
      { id: 'i2', material: 'Soft-close hinge', spec: '', unit: 'pcs', quantity: 12 }] }],
    orders: [{ id: 'o1', reference: 'PO-001', supplier: 'CDO Lumber', status: 'confirmed', date: '2026-11-21',
      lines: [{ itemId: 'i1', quantity: 20, received, unitPrice: 1450 }, { itemId: 'i2', quantity: 12, received: received2, unitPrice: 85 }] }] });
  const moves = () => must('super', `select coalesce(string_agg(i.name || ' ' || trim_scale(m.qty) || ' ' || m.kind || ' [' || m.job || '] ' || m.note, ' / ' order by m.id), '')
    from public.inventory_moves m join public.inventory_items i on i.id = m.item_id`);
  // The hinge is already stocked under another case; the plywood isn't.
  must('purchaser', `select public.inventory_item_save(${j({ name: 'soft-close HINGE', category: 'hardware', unit: 'pcs' })})`);
  must('purchaser', `insert into public.tracker_docs (collection, id, data) values ('procurementJobs', 'j_ana', '{"name":"Ana Reyes kitchen"}')`);
  must('purchaser', `insert into public.tracker_docs (collection, id, data) values ('procurement', 'j_ana', ${doc(0)})`);
  assert.equal(moves(), '', 'nothing delivered yet');
  must('purchaser', `update public.tracker_docs set data = ${doc(10)} where collection = 'procurement' and id = 'j_ana'`);
  assert.equal(moves(), 'Marine plywood 10 receive [Ana Reyes kitchen] PO PO-001 · CDO Lumber');
  assert.equal(must('super', `select category || '|' || unit || '|' || spec from public.inventory_items where name = 'Marine plywood'`), 'board|sheet|18mm 4x8');
  // The rest arrives with the hinges; then a miscount is corrected.
  must('purchaser', `update public.tracker_docs set data = ${doc(20, 12)} where collection = 'procurement' and id = 'j_ana'`);
  must('purchaser', `update public.tracker_docs set data = ${doc(18, 12)} where collection = 'procurement' and id = 'j_ana'`);
  assert.equal(moves().split(' / ').slice(1).join(' / '),
    'Marine plywood 10 receive [Ana Reyes kitchen] PO PO-001 · CDO Lumber / soft-close HINGE 12 receive [Ana Reyes kitchen] PO PO-001 · CDO Lumber'
    + ' / Marine plywood -2 adjust [Ana Reyes kitchen] Delivery corrected on PO PO-001 · CDO Lumber');
  assert.equal(must('super', `select trim_scale(public.inventory_on_hand(id)) from public.inventory_items where name = 'Marine plywood'`), '18');
  assert.equal(must('super', `select count(*) from public.inventory_items where lower(name) like '%hinge%'`), '1', 'matched, not duplicated');
  // A save that changes nothing about deliveries adds nothing; the movements are the purchaser's.
  const n = must('super', 'select count(*) from public.inventory_moves');
  must('purchaser', `update public.tracker_docs set data = data || '{"note":"x"}' where collection = 'procurement' and id = 'j_ana'`);
  assert.equal(must('super', 'select count(*) from public.inventory_moves'), n);
  assert.equal(must('super', `select count(distinct created_by) || '|' || min(created_by::text) from public.inventory_moves`), `1|${U.purchaser}`);
  // A correction never takes the shelf below zero: used stock is left to a count.
  must('purchaser', `select public.inventory_move((select id from public.inventory_items where name = 'Marine plywood'), 'issue', 17, 'Ana Reyes kitchen')`);
  must('purchaser', `update public.tracker_docs set data = ${doc(10, 12)} where collection = 'procurement' and id = 'j_ana'`);
  assert.equal(must('super', `select trim_scale(public.inventory_on_hand(id)) from public.inventory_items where name = 'Marine plywood'`), '0');
  // Nobody without the purchaser role reaches procurement documents, so nobody else moves stock this way.
  refused('sales', `insert into public.tracker_docs (collection, id, data) values ('procurement', 'j_x', ${doc(5)})`, /row-level security/);
});

test('3. procurement offers the open projects to link a job to: names only, purchaser and admin only', () => {
  const { must, refused } = db;
  const list = JSON.parse(must('purchaser', `select public.procurement_project_choices()`));
  const k = list.find((p) => p.id === 'p_k');
  assert.deepEqual(k, { id: 'p_k', name: 'Kitchen – Ana Reyes', client: 'Ana Reyes' }, 'no price, budget or phone');
  assert(!JSON.stringify(list).includes('250000'));
  must('super', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_old', '{"name":"Old job","clientName":"Ben","status":"completed"}')`);
  assert(!JSON.parse(must('admin', `select public.procurement_project_choices()`)).some((p) => p.id === 'p_old'), 'finished jobs are not offered');
  refused('sales', `select public.procurement_project_choices()`, /purchaser and the admin/);
  refused('designer', `select public.procurement_project_choices()`, /purchaser and the admin/);
});

test('4. the dashboard counts what needs acting on across the workspaces, for the admin only', () => {
  const { must, refused } = db;
  const before = JSON.parse(must('admin', `select public.dashboard_overview()`));
  must('admin', `select public.stage_save('p_k', 'design', ${j({ status: 'submitted' })})`);
  must('admin', `select public.stage_save('p_k', 'bom', ${j({ status: 'blocked' })})`);
  must('super', `insert into public.inventory_items (name, unit, reorder_level) values ('Edge band (dash)', 'roll', 5), ('Hinge (dash)', 'pc', 10);
    insert into public.inventory_moves (item_id, kind, qty, created_by) select id, 'receive', 3, '${db.U.purchaser}' from public.inventory_items where name = 'Edge band (dash)';`);
  must('super', `insert into public.leads (source, name, phone) values ('website', 'Dash Lead', '09170000001')`);
  const o = JSON.parse(must('admin', `select public.dashboard_overview()`));
  assert.equal(o.stages.submitted, before.stages.submitted + 1);
  assert.equal(o.stages.blocked, before.stages.blocked + 1);
  assert.equal(o.stock.low, before.stock.low + 1, '3 rolls on hand, reorder at 5');
  assert.equal(o.stock.out, before.stock.out + 1, 'never received: none on hand');
  assert.equal(o.leads.unanswered, before.leads.unanswered + 1);
  const mine = o.needs_you.filter((x) => x.project_id === 'p_k').map((x) => x.stage + ':' + x.status).sort();
  assert.deepEqual(mine, ['bom:blocked', 'design:submitted']);
  assert.equal(o.needs_you[0].project, 'Kitchen – Ana Reyes');
  assert.deepEqual(Object.keys(o.attendance).sort(), ['in_today', 'staff', 'to_check']);
  assert(!JSON.stringify(o).includes('250000'), 'counts, not money');
  for (const who of ['designer', 'purchaser', 'sales']) refused(who, `select public.dashboard_overview()`, /for the admin/);
});
