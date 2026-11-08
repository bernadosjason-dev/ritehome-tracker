// Differential test: every request goes to the real Code.gs (in the emulator) and to
// supabase-backend.js over its in-memory store, and the replies must match, after
// replacing generated ids and timestamps with placeholders. If Code.gs gains or
// changes a rule, this fails until the Supabase port matches.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCodeGs} = require('./fixtures/code-gs.cjs');
require('../procurement.js');
require('../supabase-backend.js');
const {makeActions, makeMemoryStore} = globalThis.RitehomeSupabaseBackend;
const {normalize} = globalThis.ProcurementLogic;

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII=';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Messages that name the storage service ("Google Drive" vs "Supabase") are allowed to differ; codes may not.
const SERVICE_SPECIFIC = new Set(['receipt_storage_unavailable', 'ai_not_configured']);

function side(name, send) {
  const ids = new Map();   // real id -> placeholder, shared by both sides through `refs`
  return {name, send, ids, refs: {}};
}
function scrub(value, s) {
  if (Array.isArray(value)) return value.map(v => scrub(v, s));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = scrub(value[k], s);
    return out;
  }
  if (typeof value === 'string') {
    if (ISO.test(value)) return '<time>';
    if (s.ids.has(value)) return s.ids.get(value);
    if (/^[pe]_[0-9a-f]{16}$/.test(value)) return '<generated ' + value[0] + '>';
  }
  return value;
}

// Runs one scripted scenario on both backends. Each step is a function of `refs`
// (that side's own ids, by name) returning a request, plus an optional name under
// which to remember the reply's id.
async function compare(steps) {
  const gs = createCodeGs();
  const call = makeActions(makeMemoryStore(), globalThis.ProcurementLogic);
  const sides = [side('Code.gs', async req => gs.request(req)), side('Supabase', req => call(req.action, req))];
  for (const [i, step] of steps.entries()) {
    const replies = [];
    for (const s of sides) {
      const req = step.req(s.refs);
      const reply = await s.send(JSON.parse(JSON.stringify(req)));
      if (step.save && reply.id) { s.refs[step.save] = reply.id; s.ids.set(reply.id, '<' + step.save + '>'); }
      replies.push(scrub(reply, s));
    }
    const [a, b] = replies;
    if (SERVICE_SPECIFIC.has(a.code) || SERVICE_SPECIFIC.has(a.aiError)) { delete a.error; delete b.error; delete a.aiMessage; delete b.aiMessage; }
    if (step.ignoreMessage) { delete a.message; delete b.message; }
    assert.deepEqual(b, a, `step ${i + 1} (${JSON.stringify(step.req(sides[0].refs)).slice(0, 120)})`);
  }
}
const r = (req, save, extra) => Object.assign({req: typeof req === 'function' ? req : () => req, save}, extra);

test('projects and expenses: add, merge-update, list order, import dedupe, cascade delete', () => compare([
  r({action: 'ping'}),
  r({action: 'listProjects'}),
  r({action: 'addProject', data: {id: 'ignored', name: 'Kitchen — Uy residence', status: 'active', price: 180000, budget: 120000, updatedAt: '2026-11-01T00:00:00.000Z', billing: {down: 90000, items: [1, 2]}}}, 'p1'),
  r({action: 'addProject', data: {name: 'Wardrobe', updatedAt: '2026-11-03T00:00:00.000Z'}}, 'p2'),
  r({action: 'listProjects'}),
  r(x => ({action: 'updateProject', id: x.p1, patch: {billing: {balance: 90000, items: [3]}, status: 'done', updatedAt: '2026-11-05T00:00:00.000Z', id: 'nope'}})),
  r(x => ({action: 'getProject', id: x.p1})),
  r({action: 'listProjects'}),
  r({action: 'updateProject', id: 'p_missing', patch: {a: 1}}),
  r({action: 'updateProject', id: 'whatever', patch: [1]}),
  r({action: 'addProject', data: 'not an object'}),
  r(x => ({action: 'addExpense', projectId: x.p1, data: {date: '2026-11-02', item: 'Plywood', amount: 5400, receipt: null}}), 'e1'),
  r(x => ({action: 'addExpense', projectId: x.p1, data: {date: '2026-11-04', item: 'Hinges', amount: 900}}), 'e2'),
  r({action: 'addExpense', projectId: 'p_missing', data: {date: '2026-11-04'}}),
  r(x => ({action: 'updateExpense', id: x.e1, patch: {amount: 5600, noReceipt: true}})),
  r({action: 'updateExpense', id: 'e_missing', patch: {amount: 1}}),
  r(x => ({action: 'getProject', id: x.p1})),
  r(x => ({action: 'deleteExpense', id: x.e2})),
  r({action: 'deleteExpense', id: 'e_missing'}),
  r({action: 'importProject', data: {name: 'Imported', importedFrom: 'src-1'}, expenses: [{date: '2026-10-01', item: 'Old'}, {date: '2026-10-02', item: 'Older', id: 'x'}]}, 'p3'),
  r({action: 'importProject', data: {name: 'Imported again', importedFrom: 'src-1'}, expenses: [{date: '2026-10-03'}]}),
  r(x => ({action: 'getProject', id: x.p3})),
  r(x => ({action: 'deleteProject', id: x.p1})),
  r(x => ({action: 'getProject', id: x.p1})),
  r({action: 'deleteProject', id: 'p_missing'}),
  r({action: 'listProjects'}),
  r({action: 'getProject', id: ''}),
  r({action: 'noSuchAction'})
]));

test('receipts: type and size checks, upload, scan without AI keeps the photo, delete', () => compare([
  r({action: 'uploadReceipt', mimeType: 'application/pdf', data: PNG}),
  r({action: 'uploadReceipt', mimeType: 'image/png', data: ''}),
  r({action: 'uploadReceipt', mimeType: 'image/png', data: PNG}, 'r1'),
  r({action: 'scanReceipt', mimeType: 'image/heic', data: PNG}),
  r({action: 'scanReceipt', mimeType: 'image/png', data: PNG}, 'r2'),
  r(x => ({action: 'deleteReceipt', id: x.r1})),
  r({action: 'deleteReceipt', id: ''})
]));

const fuel = {date: '2026-10-06', vehicle: 'Truck ABC 123', fuelType: 'diesel', liters: 20.5, amount: 1230, driver: 'Juan', odometer: 12000, vendor: 'Station', notes: ''};
const fid = 'fuel-00000000-0000-4000-8000-000000000001';
const vid = 'vehicle-00000000-0000-4000-8000-000000000001';

test('vehicles and fuel: validation, idempotent create, receipt rules, admin confirmation', () => compare([
  r({action: 'listVehicles'}),
  r({action: 'saveVehicle', id: 'bad', data: {name: 'Truck', fuelType: 'diesel'}, create: true}),
  r({action: 'saveVehicle', id: vid, data: {name: ' ', fuelType: 'diesel'}, create: true}),
  r({action: 'saveVehicle', id: vid, data: {name: 'Truck', fuelType: 'kerosene'}, create: true}),
  r({action: 'saveVehicle', id: vid, data: {name: 'Truck', fuelType: 'diesel', plate: 'ABC 123'}, create: true}),
  r({action: 'saveVehicle', id: vid, data: {name: 'Truck', fuelType: 'diesel', plate: 'ABC 123'}, create: true}),
  r({action: 'saveVehicle', id: vid, data: {name: 'Truck 2', fuelType: 'diesel', plate: 'ABC 123'}, create: true}),
  r({action: 'saveVehicle', id: 'vehicle-00000000-0000-4000-8000-000000000002', data: {name: 'truck', fuelType: 'gasoline'}, create: true}),
  r({action: 'saveVehicle', id: 'vehicle-00000000-0000-4000-8000-000000000003', data: {name: 'Van', fuelType: 'gasoline'}}),
  r({action: 'saveVehicle', id: vid, data: {name: 'Truck (blue)', fuelType: 'diesel', plate: 'ABC 123'}}),
  r({action: 'listVehicles'}),
  r({action: 'saveFuel', id: fid, data: fuel, create: true}),
  r({action: 'saveFuel', id: fid, data: fuel, create: true}),
  r({action: 'saveFuel', id: fid, data: {...fuel, liters: 99}, create: true}),
  r({action: 'saveFuel', id: fid, data: {...fuel, liters: 30, amount: 1800}}),
  ...[{date: '2026-02-30'}, {fuelType: 'kerosene'}, {liters: 0}, {liters: '20'}, {amount: 0}, {odometer: -1}, {vehicle: '  '}, {notes: 'a'.repeat(501)}, {receipt: 'bad id!'},
      {receipt: 'abc', noReceipt: true}, {adminConfirmed: true}, {noReceipt: true, adminConfirmed: true, adminName: ' '}]
    .map(patch => r({action: 'saveFuel', id: 'fuel-00000000-0000-4000-8000-000000000002', data: {...fuel, ...patch}, create: true})),
  r({action: 'saveFuel', id: 'fuel-00000000-0000-4000-8000-000000000003', data: {...fuel, noReceipt: true, adminConfirmed: true, adminName: 'Cecel'}, create: true}),
  r({action: 'saveFuel', id: 'fuel-00000000-0000-4000-8000-000000000003', data: {notes: 'checked', date: fuel.date, vehicle: fuel.vehicle, fuelType: 'diesel', liters: 20.5, amount: 1230}}),
  r({action: 'saveFuel', id: 'invalid', data: fuel, create: true}),
  r({action: 'saveFuel', id: 'fuel-00000000-0000-4000-8000-000000000009', data: fuel}),
  r({action: 'listFuel'}),
  r({action: 'uploadFuelReceipt', uploadId: 'bad', mimeType: 'image/png', data: PNG}),
  r({action: 'uploadFuelReceipt', uploadId: 'fuelphoto-00000000-0000-4000', mimeType: 'image/tiff', data: PNG}),
  r({action: 'uploadFuelReceipt', uploadId: 'fuelphoto-00000000-0000-4000', mimeType: 'image/png', data: ''}),
  r({action: 'uploadFuelReceipt', uploadId: 'fuelphoto-00000000-0000-4000', mimeType: 'image/png', data: PNG}, 'fr'),
  r({action: 'uploadFuelReceipt', uploadId: 'fuelphoto-00000000-0000-4000', mimeType: 'image/png', data: PNG}),
  r(x => ({action: 'saveFuel', id: fid, data: {...fuel, receipt: x.fr}})),
  r({action: 'checkFuelReceiptStorage'}, null, {ignoreMessage: false}),
  r({action: 'deleteFuel', id: fid}),
  r({action: 'deleteFuel', id: fid}),
  r({action: 'listFuel'})
]));

const bom = {id: 'bom1', name: 'BOM 01', date: '2026-10-08', draftsman: 'Draftsman', items: [{id: 'sheets', material: 'Plywood', spec: '18mm 4x8', unit: 'sheets', quantity: 24}]};
const order = (id, quantity, status = 'confirmed', received = 0) => ({id, reference: 'PO-' + id, supplier: 'Supplier ' + id, date: '2026-10-08', status, notes: '', lines: [{itemId: 'sheets', quantity, received, unitPrice: 1000}]});
const state = (orders = [], boms = [bom]) => normalize({boms, orders});
const mid = n => 'pr-00000000-0000-4000-8000-00000000000' + n;
const pj = 'pj-00000000-0000-4000-8000-000000000001';

test('procurement: revisions, idempotent retries, PO history rules, independent jobs', () => compare([
  r({action: 'addProject', data: {name: 'Procurement test'}}, 'p'),
  r(x => ({action: 'getProcurement', projectId: x.p})),
  r({action: 'getProcurement', projectId: 'missing'}),
  r(x => ({action: 'saveProcurement', projectId: x.p, revision: 0, mutationId: 'short', data: state()})),
  r(x => ({action: 'saveProcurement', projectId: x.p, revision: 0, mutationId: mid(1), data: {boms: [bom], orders: [order('a', 25)]}})),
  r(x => ({action: 'saveProcurement', projectId: x.p, revision: 0, mutationId: mid(1), data: state([order('a', 16, 'confirmed', 8)])})),
  r(x => ({action: 'saveProcurement', projectId: x.p, revision: 0, mutationId: mid(1), data: state([order('a', 16, 'confirmed', 8)])})),
  r(x => ({action: 'saveProcurement', projectId: x.p, revision: 0, mutationId: mid(1), data: state()})),
  r(x => ({action: 'saveProcurement', projectId: x.p, revision: 0, mutationId: mid(2), data: state()})),
  r(x => ({action: 'saveProcurement', projectId: x.p, revision: 1, mutationId: mid(2), data: state([], [{...bom, items: [{...bom.items[0], spec: 'different'}]}])})),
  r(x => ({action: 'saveProcurement', projectId: x.p, revision: 1, mutationId: mid(2), data: state([order('a', 16, 'cancelled')])})),
  r(x => ({action: 'saveProcurement', projectId: x.p, revision: 1, mutationId: mid(3), data: state([order('a', 16, 'confirmed', 16)])})),
  r(x => ({action: 'getProcurement', projectId: x.p})),
  r({action: 'listProcurementJobs'}),
  r({action: 'saveProcurementJob', id: 'pj-bad', data: {name: 'Job'}, create: true}),
  r({action: 'saveProcurementJob', id: pj, data: {name: '', clientName: 'X'}, create: true}),
  r({action: 'saveProcurementJob', id: pj, data: {name: 'Mall kiosk', clientName: 'SM CDO', status: 'paused'}, create: true}),
  r({action: 'saveProcurementJob', id: pj, data: {name: 'Mall kiosk', clientName: 'SM CDO'}}),
  r({action: 'saveProcurementJob', id: pj, data: {name: 'Mall kiosk', clientName: 'SM CDO'}, create: true}),
  r({action: 'saveProcurementJob', id: pj, data: {name: 'Mall kiosk', clientName: 'SM CDO'}, create: true}),
  r({action: 'saveProcurementJob', id: pj, data: {name: 'Mall kiosk 2'}, create: true}),
  r({action: 'saveProcurementJob', id: pj, data: {status: 'completed'}}),
  r({action: 'getProcurementJob', id: pj}),
  r({action: 'getProcurementJob', id: 'nope'}),
  r({action: 'getProcurementJob', id: 'pj-00000000-0000-4000-8000-000000000009'}),
  r({action: 'getProcurement', projectId: pj}),
  r({action: 'saveProcurement', projectId: pj, revision: 0, mutationId: mid(4), data: state()}),
  r({action: 'getProcurement', projectId: 'pj-00000000-0000-4000-8000-000000000009'}),
  r({action: 'listProcurementJobs'})
]));

test('a save that loses a race retries on fresh data instead of overwriting', async () => {
  const store = makeMemoryStore();
  const call = makeActions(store, globalThis.ProcurementLogic);
  const {id} = await call('addProject', {data: {name: 'Race', tags: {a: 1}}});
  // Another tab saves between this save's read and its write.
  const realUpdate = store.update;
  let raced = false;
  store.update = function (c, docId, data, rev) {
    if (!raced) { raced = true; return realUpdate.call(store, c, docId, {name: 'Race', tags: {a: 1, other: 2}}, rev).then(() => realUpdate.call(store, c, docId, data, rev)); }
    return realUpdate.call(store, c, docId, data, rev);
  };
  assert.equal((await call('updateProject', {id, patch: {tags: {b: 3}}})).ok, true);
  const {project} = await call('getProject', {id});
  assert.deepEqual(project.tags, {a: 1, other: 2, b: 3}, 'both saves survive');
});

test('procurement saved from two tabs at once: the second gets a conflict, not a silent overwrite', async () => {
  const store = makeMemoryStore();
  const call = makeActions(store, globalThis.ProcurementLogic);
  const {id} = await call('addProject', {data: {name: 'Race'}});
  await call('saveProcurement', {projectId: id, revision: 0, mutationId: mid(1), data: state()});
  const realUpdate = store.update;
  store.update = function (c, docId, data, rev) {
    store.update = realUpdate;
    return realUpdate.call(store, c, docId, {mutationId: mid(9), data: state([order('z', 1)])}, rev).then(() => realUpdate.call(store, c, docId, data, rev));
  };
  assert.equal((await call('saveProcurement', {projectId: id, revision: 1, mutationId: mid(2), data: state([order('a', 2)])})).code, 'conflict');
  assert.equal((await call('getProcurement', {projectId: id})).data.orders[0].id, 'z');
});

test('only files this backend created are ever deleted from storage', async () => {
  const store = makeMemoryStore();
  const call = makeActions(store, globalThis.ProcurementLogic);
  const removed = [];
  store.removeFile = p => { removed.push(p); return Promise.resolve(); };
  await call('deleteReceipt', {id: '1AbCdEfGhIjKlMnOpQrStUvWxYz'});   // a Google Drive id from before the move
  const {id} = await call('uploadReceipt', {mimeType: 'image/png', data: PNG});
  await call('deleteReceipt', {id});
  assert.deepEqual(removed, [id]);
  assert.match(id, /^sb_[0-9a-f]{32}$/);
});

test('receipt reading, when switched on, fills the fields and keeps the photo on failure', async () => {
  const ok = makeActions(makeMemoryStore(), globalThis.ProcurementLogic, {readReceipt: (b64, type) => ({vendor: 'Wilcon', total: 1200, b64len: b64.length, type})});
  const res = await ok('scanReceipt', {mimeType: 'image/png', data: PNG});
  assert.deepEqual(res.fields, {vendor: 'Wilcon', total: 1200, b64len: PNG.length, type: 'image/png'});
  const failing = makeActions(makeMemoryStore(), globalThis.ProcurementLogic, {readReceipt: () => { const e = Error('Gemini: 429'); e.code = 'ai_busy'; throw e; }});
  const res2 = await failing('scanReceipt', {mimeType: 'image/png', data: PNG});
  assert.equal(res2.ok, true); assert.match(res2.id, /^sb_/); assert.equal(res2.fields, null); assert.equal(res2.aiError, 'ai_busy');
});

// Deliberate difference: Code.gs appends the project row before it checks the expenses,
// so a malformed expense leaves a half-imported project behind. The port checks first.
test('a rejected import writes nothing (Code.gs leaves the project row behind)', async () => {
  const store = makeMemoryStore();
  const call = makeActions(store, globalThis.ProcurementLogic);
  const res = await call('importProject', {data: {name: 'Bad'}, expenses: [{date: '2026-10-01'}, 'x']});
  assert.equal(res.code, 'invalid_argument');
  assert.equal(store.rows.length, 0);
  const gs = createCodeGs();
  assert.equal(gs.request({action: 'importProject', data: {name: 'Bad'}, expenses: ['x']}).code, 'invalid_argument');
  assert.equal(gs.request({action: 'listProjects'}).projects.length, 1, 'if this starts failing, Code.gs was fixed: fold the case back into the differential test');
});
