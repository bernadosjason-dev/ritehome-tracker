// Leads (supabase/migrations/20261112000006_leads.sql) on a real local PostgreSQL.
//   node --test tests/leads.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

const KEY = 'test-ingest-key-0123456789abcdef';
let db;
const q = (s) => s.replace(/'/g, "''");
const ingest = (p, key = KEY) => `select public.ingest_lead('${q(JSON.stringify(p))}'::jsonb, '${key}')`;

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'designer@example.com', '{}');
    update public.profiles set role = 'admin', active = true where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';
    insert into public.app_secrets (name, sha256) values ('lead_ingest', '${crypto.createHash('sha256').update(KEY).digest('hex')}');`);
});
test.after(() => db && db.stop());

test('the website Worker files leads with its key, and only with it', () => {
  const { must, refused } = db;
  refused('anon', ingest({ name: 'Spammer', phone: '0917' }, 'wrong-key'), /Not allowed/);
  refused('anon', ingest({ name: 'No contact' }), /phone or email are required/);
  const r = JSON.parse(must('anon', ingest({ source: 'site-visit', name: 'Ana Reyes', phone: '0917 555 0142', line: 'Kitchen system',
    address: 'Carmen, Cagayan de Oro', visitDate: '2026-11-20', visitTime: '9:00 AM', notes: 'L-shape 4m by 3m', page: '/schedule/' })));
  assert.equal(r.duplicate, false);
  assert.equal(must('admin', `select source || '|' || system || '|' || location || '|' || visit_requested || '|' || stage from public.leads where id = '${r.id}'`),
    'site-visit|kitchen|Carmen, Cagayan de Oro|2026-11-20 9:00 AM|new');
  assert.equal(must('admin', `select kind || ':' || body from public.lead_activity where lead_id = '${r.id}'`), 'inquiry:Via site-visit: L-shape 4m by 3m');
  refused('anon', 'select count(*) from public.leads', /permission denied/);
  refused('anon', 'select public.leads_list()', /permission denied/);
  refused('anon', 'select count(*) from public.app_secrets', /permission denied/);
  refused('admin', 'select count(*) from public.app_secrets', /permission denied/);   // not even an admin reads the key hash
});

test('a repeat inquiry joins the open lead: same phone written differently, Hannah name replaced', () => {
  const { must } = db;
  const h = JSON.parse(must('anon', ingest({ source: 'hannah', name: 'Hannah lead (+63 918 222 3344)', phone: '+63 918 222 3344', notes: 'Visitor: wardrobe price?' })));
  const again = JSON.parse(must('anon', ingest({ source: 'inquiry', name: 'Ben Cruz', phone: '0918-222-3344', email: 'ben@example.com', line: 'Storage / wardrobe', notes: 'Two wardrobes' })));
  assert.equal(again.duplicate, true);
  assert.equal(again.id, h.id);
  assert.equal(must('admin', `select name || '|' || email || '|' || system from public.leads where id = '${h.id}'`), 'Ben Cruz|ben@example.com|storage');
  assert.equal(must('admin', `select count(*) from public.lead_activity where lead_id = '${h.id}' and kind = 'inquiry'`), '2');
  assert.equal(must('admin', 'select count(*) from public.leads'), '2');
});

test('contact moves the clock: first reply timed, stage follows, history kept', () => {
  const { must } = db;
  const id = must('admin', `select id from public.leads where name = 'Ana Reyes'`);
  assert.equal(must('admin', `select first_response_at is null from public.leads where id = '${id}'`), 't');
  must('admin', `select public.lead_log('${id}', 'note', 'Looked at the layout photo')`);
  assert.equal(must('admin', `select (first_response_at is null) || '|' || stage from public.leads where id = '${id}'`), 'true|new', 'a note is not a reply');
  must('admin', `select public.lead_log('${id}', 'call', 'Confirmed Nov 20 visit', 'Bring sample doors', '2026-11-20')`);
  assert.equal(must('admin', `select (first_response_at is not null) || '|' || (last_contact_at is not null) || '|' || stage || '|' || next_action || '|' || next_action_at from public.leads where id = '${id}'`),
    'true|true|contacted|Bring sample doors|2026-11-20');
  assert.equal(must('admin', `select string_agg(kind || ':' || body, ' / ' order by id) from public.lead_activity where lead_id = '${id}' and kind = 'stage'`), 'stage:new → contacted');
  const g = JSON.parse(must('admin', `select public.lead_get('${id}')`));
  assert.equal(g.activity[0].kind, 'stage', 'newest first');
  assert.equal(g.activity.find((a) => a.kind === 'call').by_name, 'Jason');
  const list = JSON.parse(must('admin', 'select public.leads_list()'));
  assert.equal(list.length, 2);
  assert(list.every((l) => l.activity_count >= 2 && l.last_activity));
});

test('by hand, lost with a reason, won into a tracker project', () => {
  const { must, refused } = db;
  const walkIn = must('admin', `select public.lead_save('{"source":"walk-in","name":"Clinic owner","location":"Opol","system":"partition","budget":"180000","timeline":"asap","message":"Clinic partitions"}')`);
  assert.equal(must('admin', `select source || '|' || budget || '|' || timeline from public.leads where id = '${walkIn}'`), 'walk-in|180000.00|asap');
  assert.equal(must('admin', `select stage || '|' || (first_response_at is not null) from public.leads where id = '${walkIn}'`), 'contacted|true',
    'a walk-in is already a conversation, not a lead waiting for a reply');
  const fb = must('admin', `select public.lead_save('{"source":"facebook","name":"FB lead","phone":"0905"}')`);
  assert.equal(must('admin', `select stage || '|' || (first_response_at is null) from public.leads where id = '${fb}'`), 'new|true', 'a Facebook message still needs a reply');
  refused('admin', `select public.lead_save('{"source":"website","name":"No contact"}')`, /check constraint/);
  const ben = must('admin', `select id from public.leads where name = 'Ben Cruz'`);
  must('admin', `select public.lead_save('{"id":"${ben}","stage":"lost","lost_reason":"Went with a cheaper carpenter"}')`);
  assert.equal(must('admin', `select body from public.lead_activity where lead_id = '${ben}' and kind = 'stage'`), 'new → lost: Went with a cheaper carpenter');

  const pid = must('admin', `select public.lead_convert('${walkIn}', 210000, 160000)`);
  assert.match(pid, /^p_[0-9a-f]{16}$/, 'the tracker id format');
  assert.equal(must('admin', `select public.lead_convert('${walkIn}', 999)`), pid, 'converting twice keeps the one project');
  const doc = JSON.parse(must('admin', `select data from public.tracker_docs where collection = 'projects' and id = '${pid}'`));
  assert.equal(doc.name, 'Partition – Clinic owner');
  assert.equal(doc.address, 'Opol');
  assert.equal(doc.price, 210000);
  assert.equal(doc.budget, 160000);
  assert.equal(doc.leadId, walkIn);
  assert.equal(must('admin', `select stage || '|' || project_id || '|' || expected_value from public.leads where id = '${walkIn}'`), `won|${pid}|210000.00`);
  assert.equal(must('admin', `select count(*) from public.project_stages where project_id = '${pid}'`), '8', 'the pipeline starts');
});

test('staff never see leads', () => {
  const { must, refused } = db;
  assert.equal(must('designer', 'select count(*) from public.leads'), '0');
  assert.equal(must('designer', 'select public.leads_list()'), '[]');
  refused('designer', `select public.lead_save('{"name":"x","phone":"1"}')`, /Only an admin/);
  refused('designer', `select public.lead_log(gen_random_uuid(), 'call', 'x')`, /Only an admin/);
  const someLead = must('super', 'select id from public.leads limit 1');
  refused('designer', `insert into public.lead_activity (lead_id, kind) values ('${someLead}', 'note')`, /row-level security/);
  assert.equal(must('designer', "update public.leads set stage = 'won' returning id"), '');
});
