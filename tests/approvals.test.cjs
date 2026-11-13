// Phase 4, approvals (supabase/migrations/20261122000019_approvals.sql) on a real local PostgreSQL:
// a stage that needs approval is submitted (numbered versions), approved or sent back with remarks by
// the admin, never finished by its own department, and the next stage waits for the approval.
// Every rule is tested from the refused side too.
//   node --test tests/approvals.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const status = (s) => db.must('super', `select status from public.project_stages where project_id = 'p_a' and stage = '${s}'`);
const set = (who, s, st) => `select public.stage_save('p_a', '${s}', ${j({ status: st })})`;
const submit = (s, note, link = '') => `select public.stage_submit('p_a', '${s}', '${q(note)}', '${q(link)}')`;
const list = (who, p = {}) => JSON.parse(db.must(who, `select public.approvals_list(${j(p)})`));

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.sales = '00000000-0000-4000-8000-000000000005';
  U.fab = '00000000-0000-4000-8000-000000000006';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}'),
    ('${U.fab}', 'fe@example.com', '{"full_name":"Fe"}'), ('${U.purchaser}', 'pia@example.com', '{"full_name":"Pia"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';
    update public.profiles set role = 'fabrication', active = true, full_name = 'Fe' where id = '${U.fab}';
    update public.profiles set role = 'purchaser', active = true, full_name = 'Pia' where id = '${U.purchaser}';`);
  must('admin', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_a', '{"name":"Kitchen – Test Client","clientName":"Test Client","status":"active"}')`);
  for (const s of ['design', 'cutlist', 'bom']) must('admin', `select public.stage_save('p_a', '${s}', ${j({ assignee: U.designer })})`);
  must('admin', `select public.stage_save('p_a', 'fabrication', ${j({ assignee: U.fab })})`);
  must('admin', `select public.stage_save('p_a', 'consultation', ${j({ assignee: U.sales })})`);
});
test.after(() => db && db.stop());

test('the admin\'s rules: six hand-offs need approval by default, every account can read them, only the admin changes them', () => {
  const { must, refused } = db;
  const rules = JSON.parse(must('designer', `select public.approval_rules_list()`));
  assert.deepEqual(rules.filter((r) => r.required).map((r) => r.stage), ['design', 'cutlist', 'bom', 'final_cutlist', 'fabrication', 'installation']);
  refused('designer', `select public.approval_rules_save('design', false)`, /Only an admin decides/);
  refused('designer', `update public.approval_rules set required = false`, /permission denied/);
});

test('a department can\'t finish its own approval stage: it submits a numbered version with a note', () => {
  const { must, refused } = db;
  must('designer', set('designer', 'design', 'in_progress'));   // site visit needs no approval, so design can start
  refused('designer', set('designer', 'design', 'done'), /Design needs the admin's approval: submit it for review/);
  refused('designer', set('designer', 'design', 'submitted'), /Submit Design for review with a note/);
  refused('designer', submit('design', '   '), /short note/);
  refused('designer', submit('design', 'Layout A', 'drive.google.com/x'), /must start with http/);
  refused('sales', submit('design', 'Not mine'), /isn't yours to submit/);
  refused('purchaser', submit('design', 'Not mine'), /isn't yours to submit/);
  refused('designer', `select public.stage_submit('p_a', 'consultation', 'x', '')`, /isn't yours|doesn't need approval/);
  const v1 = JSON.parse(must('designer', submit('design', 'Layout A with island', 'https://drive.google.com/file/d/abc')));
  assert.equal(v1.version, 1); assert.equal(v1.decision, 'pending');
  assert.equal(status('design'), 'submitted');
  refused('designer', submit('design', 'Again'), /already waiting for review/);
  refused('designer', set('designer', 'design', 'in_progress'), /waiting for the admin's review/);
  // Only through the functions: no direct writes, and no approving yourself.
  refused('designer', `insert into public.stage_submissions (project_id, stage, version, note) values ('p_a', 'design', 9, 'x')`, /permission denied/);
  refused('designer', `update public.stage_submissions set decision = 'approved'`, /permission denied/);
  refused('designer', `select public.stage_review('${v1.id}', 'approved', '')`, /Only an admin approves/);
});

test('the next stage waits for the approval', () => {
  const { refused } = db;
  refused('designer', set('designer', 'cutlist', 'in_progress'), /Initial cutlist can't start until Design is approved/);
  refused('fab', set('fab', 'fabrication', 'in_progress'), /Fabrication can't start until Final cutlist is approved/);
});

test('a revision needs remarks, keeps the version, and sends the stage back; the next version is approved', () => {
  const { must, refused } = db;
  const [v1] = list('admin', { state: 'pending' });
  assert.equal(v1.submitter, 'Dina'); assert.equal(v1.project, 'Kitchen – Test Client');
  refused('admin', `select public.stage_review('${v1.id}', 'revise', '  ')`, /needs remarks/);
  refused('admin', `select public.stage_review('${v1.id}', 'maybe', 'x')`, /Approve it or ask for a revision/);
  must('admin', `select public.stage_review('${v1.id}', 'revise', 'Move the fridge to the left wall')`);
  assert.equal(status('design'), 'in_progress');
  refused('admin', `select public.stage_review('${v1.id}', 'approved', '')`, /already decided/);
  // The designer sees why.
  const mine = list('designer', { stage: 'design' });
  assert.equal(mine[0].decision, 'revise'); assert.equal(mine[0].remarks, 'Move the fridge to the left wall'); assert.equal(mine[0].decider, 'Jason');
  const v2 = JSON.parse(must('designer', submit('design', 'Layout B: fridge on the left wall')));
  assert.equal(v2.version, 2);
  must('admin', `select public.stage_review('${v2.id}', 'approved', 'Good')`);
  assert.equal(status('design'), 'done');
  // Both versions kept, newest decision first.
  assert.deepEqual(list('admin', { stage: 'design' }).map((x) => x.version + ':' + x.decision).sort(), ['1:revise', '2:approved']);
  must('designer', set('designer', 'cutlist', 'in_progress'));   // now it may start
});

test('submissions are kept: a decided one can\'t be changed or deleted, by anyone', () => {
  const { refused } = db;
  refused('super', `update public.stage_submissions set note = 'rewritten' where version = 1 and stage = 'design'`, /decided submission can't be changed/);
  refused('super', `delete from public.stage_submissions where stage = 'design'`, /kept: they can't be deleted/);
  refused('admin', `delete from public.stage_submissions`, /permission denied/);
});

test('the admin turns a rule off; marking a stage done on the Schedule approves what was waiting', () => {
  const { must, refused } = db;
  must('admin', `select public.approval_rules_save('cutlist', false)`);
  must('designer', set('designer', 'cutlist', 'done'));            // no review needed now
  refused('designer', submit('cutlist', 'x'), /doesn't need approval/);
  must('designer', set('designer', 'bom', 'in_progress'));         // cutlist doesn't gate BOM any more
  const b = JSON.parse(must('designer', submit('bom', 'BOM for the island')));
  must('admin', set('admin', 'bom', 'done'));
  const r = list('admin', { stage: 'bom' })[0];
  assert.equal(r.id, b.id); assert.equal(r.decision, 'approved'); assert.equal(r.remarks, 'Marked done on the Schedule.');
  must('admin', `select public.approval_rules_save('cutlist', true)`);
});

test('people see their own submissions and their stages\' history, nobody else\'s', () => {
  assert.equal(list('fab').length, 0, 'the workshop doesn\'t see design reviews');
  assert.equal(list('sales').length, 0);
  assert(list('designer').length >= 3);
  assert(list('designer').every((x) => ['design', 'bom'].includes(x.stage)));
  db.refused('anon', `select public.approvals_list('{}'::jsonb)`, /permission denied/);
});

test('every step is in the activity log under Approvals, and a submission rings the bell once', () => {
  const { must } = db;
  assert(Number(must('super', `select count(*) from public.audit_log where module = 'Approvals' and table_name = 'stage_submissions' and action = 'insert'`)) >= 3);
  assert(Number(must('super', `select count(*) from public.audit_log where table_name = 'stage_submissions' and action = 'update' and 'decision' = any (changed)`)) >= 2);
  const titles = must('super', `select string_agg(title, '|' order by id) from public.notify_events where title like '%submitted%'`).split('|');
  assert(titles.includes('Dina submitted Design v1 for review · Kitchen – Test Client'), titles.join('\n'));
  assert(titles.every((t) => / v\d+ for review/.test(t)), 'the stage turning "submitted" doesn\'t notify a second time: ' + titles.join('\n'));
  assert.equal(must('super', `select level from public.notify_events where title like 'Dina submitted Design v2%'`), 'handoff');
});
