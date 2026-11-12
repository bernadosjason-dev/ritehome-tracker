// Notifications (supabase/migrations/20261120000017_notifications.sql) on a real local PostgreSQL,
// and the notify-telegram Edge Function (supabase/functions/notify-telegram/core.js) under Node
// against that database and a stand-in for Telegram.
//   node --test tests/notify.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db;
const q = (s) => String(s).replace(/'/g, "''");
const j = (v) => `'${q(JSON.stringify(v))}'::jsonb`;
const events = () => JSON.parse(db.must('super', `select coalesce(json_agg(json_build_object('id', id, 'level', level, 'title', title,
  'body', body, 'link', link, 'telegram', telegram) order by id), '[]') from public.notify_events`));
const lastEvent = () => events().slice(-1)[0];
const count = () => Number(db.must('super', 'select count(*) from public.notify_events'));

test.before(() => {
  db = startLocalPg();
  const { U, must } = db;
  U.sales = '00000000-0000-4000-8000-000000000005';
  U.admin2 = '00000000-0000-4000-8000-00000000000c';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.admin2}', 'mom@example.com', '{"full_name":"Maria"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}'),
    ('${U.purchaser}', 'pia@example.com', '{"full_name":"Pia"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'admin', active = true, full_name = 'Maria' where id = '${U.admin2}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';
    update public.profiles set role = 'purchaser', active = true, full_name = 'Pia' where id = '${U.purchaser}';
    delete from public.notify_events; delete from net.http_requests;`);
});
test.after(() => db && db.stop());

test("the admin's own actions notify nobody", () => {
  const { U, must } = db;
  must('admin', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_k', '{"name":"Kitchen – Ana Reyes","price":250000}')`);
  must('admin', `select public.stage_save('p_k', 'design', ${j({ assignee: U.designer })})`);
  must('admin', `select public.stage_save('p_k', 'site_visit', ${j({ assignee: U.sales })})`);
  assert.equal(count(), 0);
});

test('a new lead is a handoff: on the bell and queued for Telegram, which wakes the sender', () => {
  const { must } = db;
  must('sales', `select public.lead_save(${j({ source: 'phone', name: 'Carlo Diaz', phone: '0917 000 1111' })})`);
  const e = events().find((x) => /New lead/.test(x.title));
  assert.deepEqual([e.level, e.title, e.body, e.telegram], ['handoff', 'New lead: Carlo Diaz', 'Added by Sam', 'pending']);
  assert.match(e.link, /^\/leads#lead=[0-9a-f-]{36}$/);
  assert.equal(must('super', `select url from net.http_requests order by id desc limit 1`),
    'https://laxavfldivkhufeubgmb.supabase.co/functions/v1/notify-telegram');
  // The same contact logged by the function itself (first call) is info: on the bell only.
  assert.ok(events().some((x) => x.level === 'info' && /Sam logged call/.test(x.title) && x.telegram === 'none'));
  // A website lead (no one signed in) says so.
  must('super', `insert into public.leads (source, name, phone) values ('website', 'Bea Lim', '0918 111 2222')`);
  assert.deepEqual([lastEvent().title, lastEvent().body], ['New lead: Bea Lim', 'From the website']);
  // Maintenance with nobody signed in (a migration, a fix in the SQL editor) is not news.
  const n = count();
  must('super', `update public.leads set location = 'Carmen' where name = 'Bea Lim'`);
  must('super', `update public.tracker_docs set data = data || '{"status":"active"}' where id = 'p_k'`);
  assert.equal(count(), n);
});

test('stage handoffs and blocks; lead stages; refusals; deletes', () => {
  const { must } = db;
  must('sales', `select public.stage_save('p_k', 'site_visit', ${j({ status: 'done', notes: 'Wall is 4.2 m' })})`);
  assert.deepEqual([lastEvent().level, lastEvent().title, lastEvent().body, lastEvent().telegram],
    ['handoff', 'Sam finished Site visit · Kitchen – Ana Reyes', 'Wall is 4.2 m', 'pending']);
  must('designer', `select public.stage_save('p_k', 'design', ${j({ status: 'blocked', notes: 'No wall measurements' })})`);
  assert.deepEqual([lastEvent().level, lastEvent().title], ['alert', 'Dina is blocked on Design · Kitchen – Ana Reyes']);
  must('designer', `select public.stage_save('p_k', 'design', ${j({ status: 'in_progress' })})`);
  assert.deepEqual([lastEvent().level, lastEvent().telegram], ['info', 'none']);
  const lead = must('super', `select id from public.leads where name = 'Carlo Diaz'`);
  must('sales', `select public.lead_save(${j({ id: lead, stage: 'quoted' })})`);
  assert.deepEqual([lastEvent().level, lastEvent().title], ['info', 'Sam moved lead Carlo Diaz to quoted']);
  must('designer', `select public.audit_refused('Leads', 'lead_save', 'Only sales or an admin can change leads.')`);
  assert.deepEqual([lastEvent().level, lastEvent().title, lastEvent().body], ['alert', 'Dina was refused: lead_save', 'Only sales or an admin can change leads.']);
  must('purchaser', `insert into public.tracker_docs (collection, id, data) values ('procurementJobs', 'j_1', '{"name":"Job 1"}')`);
  assert.deepEqual([lastEvent().level, lastEvent().title], ['info', 'Pia added Job 1']);
  must('purchaser', `delete from public.tracker_docs where id = 'j_1'`);
  assert.deepEqual([lastEvent().level, lastEvent().title, lastEvent().telegram], ['alert', 'Pia deleted Job 1', 'pending']);
});

test('stock: a movement is info, crossing the reorder level is an alert, and out of stock says so', () => {
  const { must } = db;
  const item = must('purchaser', `select public.inventory_item_save(${j({ name: 'Plywood 18mm', category: 'board', unit: 'sheet', reorder_level: 5 })})`);
  must('purchaser', `select public.inventory_move('${item}', 'receive', 10, '', 'opening count')`);
  assert.deepEqual([lastEvent().level, lastEvent().title, lastEvent().body], ['info', 'Pia added 10 sheet Plywood 18mm', '10 sheet left']);
  must('purchaser', `select public.inventory_move('${item}', 'issue', 3, 'Kitchen – Ana Reyes')`);
  assert.equal(lastEvent().level, 'info', '7 left is above 5');
  must('purchaser', `select public.inventory_move('${item}', 'issue', 3, 'Kitchen – Ana Reyes')`);
  assert.deepEqual([lastEvent().level, lastEvent().title], ['alert', 'Plywood 18mm is low: 4 sheet left']);
  must('purchaser', `select public.inventory_move('${item}', 'issue', 1, 'Kitchen – Ana Reyes')`);
  assert.equal(lastEvent().level, 'info', 'already low: no second alert');
  must('purchaser', `select public.inventory_move('${item}', 'receive', 10, '')`);
  must('purchaser', `select public.inventory_move('${item}', 'issue', 13, 'Wardrobe')`);
  assert.deepEqual([lastEvent().level, lastEvent().title], ['alert', 'Plywood 18mm is out']);
});

test("attendance: a selfie that doesn't match is an alert; an ordinary punch is not news", () => {
  const { U, must } = db;
  const before = count();
  const log = (flags) => must('super', `insert into public.audit_log (actor, actor_name, actor_roles, module, table_name, record_id, action, new)
    values ('${U.designer}', 'Dina', '{designer}', 'Attendance', 'attendance_punches', gen_random_uuid()::text, 'insert',
    ${j({ kind: 'am_in', flags })})`);
  log([]);
  assert.equal(count(), before);
  log(['face_mismatch']);
  assert.deepEqual([lastEvent().level, lastEvent().title, lastEvent().link], ['alert', "Dina's selfie doesn't match their reference photo", '/attendance']);
  log(['late']);
  assert.deepEqual([lastEvent().level, lastEvent().title], ['info', 'Dina clocked in late']);
});

test('the bell: each admin has their own unread count; staff get nothing', () => {
  const { must, refused } = db;
  const mine = JSON.parse(must('admin', 'select public.notify_list(5)'));
  assert.equal(mine.unread, count());
  assert.equal(mine.events.length, 5);
  assert.equal(mine.telegram, 'important');
  const older = JSON.parse(must('admin', `select public.notify_list(5, ${mine.events[4].id})`));
  assert.ok(older.events[0].id < mine.events[4].id);
  assert.equal(must('admin', `select public.notify_read(array[${mine.events[0].id}]::bigint[])`), String(count() - 1));
  assert.equal(JSON.parse(must('admin', 'select public.notify_list(1)')).events[0].read, true);
  assert.equal(JSON.parse(must('admin2', 'select public.notify_list(1)')).unread, count(), "Maria's bell is her own");
  assert.equal(must('admin', 'select public.notify_read()'), '0');
  for (const who of ['sales', 'designer', 'purchaser']) {
    refused(who, 'select public.notify_list()', /Only an admin/);
    refused(who, 'select public.notify_read()', /Only an admin/);
    assert.equal(must(who, 'select count(*) from public.notify_events'), '0');
    refused(who, `update public.notify_events set title = 'x'`, /permission denied/);
    refused(who, 'select public.notify_settings_save(\'off\')', /Only an admin/);
  }
  refused('admin', `delete from public.notify_events`, /permission denied/);
  refused('anon', 'select public.notify_list()', /permission denied/);
});

test('Telegram settings decide what goes out', () => {
  const { must, refused } = db;
  assert.equal(must('admin', `select public.notify_settings_save('alerts')`), 'alerts');
  must('sales', `select public.lead_save(${j({ source: 'phone', name: 'Dan Uy', phone: '0917 333 4444' })})`);
  assert.equal(events().find((x) => x.title === 'New lead: Dan Uy').telegram, 'none', 'a handoff stays on the bell');
  must('admin', `select public.notify_settings_save('off')`);
  must('designer', `select public.audit_refused('Leads', 'x', '')`);
  assert.equal(lastEvent().telegram, 'none');
  must('admin', `select public.notify_settings_save('all')`);
  must('designer', `select public.stage_save('p_k', 'design', ${j({ notes: 'Measured' })})`);
  assert.equal(lastEvent().telegram, 'pending');
  refused('admin', `select public.notify_settings_save('loud')`, /Pick off/);
  must('admin', `select public.notify_settings_save('important')`);
  assert.equal(must('super', `select count(*) from public.audit_log where table_name = 'notify_settings'`), '4', 'setting changes are in the activity log');
});

test('the Telegram queue: only the service role claims, a claim is taken once, failures go back, five tries then give up', () => {
  const { must, refused } = db;
  refused('admin', 'select public.notify_claim_telegram()', /permission denied/);
  refused('sales', `select public.notify_telegram_done('{}')`, /permission denied/);
  must('super', `update public.notify_events set telegram = 'none' where telegram = 'pending'`);
  must('designer', `select public.audit_refused('Leads', 'queue test', '')`);
  const id = lastEvent().id;
  const claimed = JSON.parse(must('service', 'select public.notify_claim_telegram(20)'));
  assert.deepEqual(claimed.map((e) => e.id), [id]);
  assert.deepEqual(JSON.parse(must('service', 'select public.notify_claim_telegram(20)')), [], 'claimed once');
  must('service', `select public.notify_telegram_done('{}', array[${id}]::bigint[])`);
  assert.equal(lastEvent().telegram, 'pending', 'failed goes back');
  for (let i = 0; i < 4; i++) {
    must('service', 'select public.notify_claim_telegram(20)');
    must('service', `select public.notify_telegram_done('{}', array[${id}]::bigint[])`);
  }
  assert.equal(lastEvent().telegram, 'failed', 'given up after five tries');
});

test('the notify-telegram function sends the queue, never the token, and waits when Telegram is not set up', async () => {
  const { must } = db;
  const { makeNotifier, message } = await import('../supabase/functions/notify-telegram/core.js');
  const SERVICE = 'service-role-key-for-tests', sentTo = [];
  let telegramUp = true;
  const fetch = async (url, init = {}) => {
    const u = new URL(url), h = init.headers || {};
    if (u.hostname === 'api.telegram.org') {
      sentTo.push({ path: u.pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: telegramUp }), { status: telegramUp ? 200 : 502 });
    }
    assert.equal(h.Authorization, 'Bearer ' + SERVICE);
    const name = u.pathname.replace('/rest/v1/rpc/', ''), b = JSON.parse(init.body);
    const sql = name === 'notify_claim_telegram' ? `select public.notify_claim_telegram(${b.p_limit})`
      : `select public.notify_telegram_done(array[${b.p_sent.join(',')}]::bigint[], array[${b.p_failed.join(',')}]::bigint[])`;
    return new Response(must('service', sql) || 'null', { status: 200 });
  };
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SERVICE };
  const post = (h) => h(new Request('https://x.supabase.co/functions/v1/notify-telegram', { method: 'POST', body: '{}' }));

  must('super', `update public.notify_events set telegram = 'none' where telegram <> 'none'`);
  must('designer', `select public.audit_refused('Leads', 'lead_save', 'Only sales or an admin can change leads.')`);
  // No secrets yet: nothing is claimed, the event keeps waiting.
  let r = await post(makeNotifier({ env, fetch }));
  assert.equal(r.status, 503);
  assert.equal(lastEvent().telegram, 'pending');

  const send = makeNotifier({ env: { ...env, TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '42' }, fetch });
  telegramUp = false;
  r = await post(send);
  assert.deepEqual(await r.json(), { sent: 0, failed: 1 });
  assert.equal(lastEvent().telegram, 'pending', 'Telegram down: back in the queue');
  telegramUp = true;
  r = await post(send);
  assert.deepEqual(await r.json(), { sent: 1, failed: 0 });
  assert.equal(lastEvent().telegram, 'sent');
  const last = sentTo.slice(-1)[0];
  assert.equal(last.path, '/bot123:abc/sendMessage');
  assert.equal(last.body.chat_id, '42');
  assert.equal(last.body.text, '🔴 Dina was refused: lead_save\nOnly sales or an admin can change leads.\nLeads · https://portal.ritehomemodular.com/activity');
  assert.deepEqual(await (await post(send)).json(), { sent: 0, failed: 0 }, 'nothing left');
  assert.equal((await send(new Request('https://x/', { method: 'GET' }))).status, 405);
  assert.match(message({ level: 'handoff', title: 'New lead: Bea', module: 'Leads', link: '/leads#lead=1' }), /^🟢 New lead: Bea\nLeads · https:\/\/portal\.ritehomemodular\.com\/leads#lead=1$/);
});
