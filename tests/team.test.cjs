// Team accounts: supabase/migrations/20261114000010_team.sql on a real local PostgreSQL, and the
// team-admin Edge Function (supabase/functions/team-admin/core.js) run under Node against a
// stand-in for Supabase's auth and REST APIs that reads and writes that same database.
//   node --test tests/team.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startLocalPg } = require('./fixtures/local-pg.cjs');

let db, handle, calls = [];
const SERVICE = 'service-role-key-for-tests';
const q = (s) => String(s).replace(/'/g, "''");
const TOKENS = {};

// What the function talks to: /auth/v1/user, /auth/v1/admin/users, /rest/v1/profiles.
function fakeSupabase(url, init = {}) {
  const u = new URL(url), method = init.method || 'GET', h = init.headers || {};
  calls.push(method + ' ' + u.pathname);
  const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  if (u.pathname === '/auth/v1/user') {
    const id = TOKENS[String(h.Authorization || '').replace('Bearer ', '')];
    return id ? json(200, { id }) : json(401, { msg: 'invalid JWT' });
  }
  if (h.apikey !== SERVICE || h.Authorization !== 'Bearer ' + SERVICE) return json(401, { msg: 'not the service role' });
  if (u.pathname === '/rest/v1/profiles' && method === 'GET') {
    const id = u.searchParams.get('id').replace('eq.', '');
    return json(200, JSON.parse(db.must('super', `select coalesce(json_agg(json_build_object('role', role, 'active', active)), '[]') from public.profiles where id = '${q(id)}'`)));
  }
  if (u.pathname === '/rest/v1/profiles' && method === 'PATCH') {
    const id = u.searchParams.get('id').replace('eq.', ''), b = JSON.parse(init.body);
    db.must('super', `update public.profiles set full_name = '${q(b.full_name)}', role = '${b.role}', active = ${b.active} where id = '${q(id)}'`);
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  if (u.pathname === '/auth/v1/admin/users' && method === 'POST') {
    const b = JSON.parse(init.body);
    if (db.must('super', `select count(*) from auth.users where email = '${q(b.email)}'`) !== '0') return json(422, { msg: 'A user with this email address has already been registered' });
    assert.equal(b.email_confirm, true);
    const id = crypto.randomUUID();
    db.must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${id}', '${q(b.email)}', '${q(JSON.stringify(b.user_metadata))}')`);
    return json(200, { id, email: b.email });
  }
  const m = /^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/.exec(u.pathname);
  if (m && method === 'PUT') {
    const b = JSON.parse(init.body);
    db.must('super', `update auth.users set raw_user_meta_data = raw_user_meta_data || '${q(JSON.stringify(b.user_metadata))}' where id = '${m[1]}'`);
    return json(200, { id: m[1] });
  }
  return json(404, { msg: 'unexpected ' + method + ' ' + u.pathname });
}
function call(token, body, origin = 'https://portal.ritehomemodular.com') {
  const headers = { 'content-type': 'application/json', origin };
  if (token) headers.authorization = 'Bearer ' + token;
  return handle(new Request('https://x.supabase.co/functions/v1/team-admin', { method: 'POST', headers, body: JSON.stringify(body) }))
    .then(async (r) => ({ status: r.status, body: await r.json(), cors: r.headers.get('access-control-allow-origin') }));
}

test.before(async () => {
  db = startLocalPg();
  const { U, must } = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}');
    update public.profiles set role = 'admin', active = true where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';`);
  TOKENS['tok-admin'] = U.admin; TOKENS['tok-designer'] = U.designer;
  const { makeHandler } = await import('../supabase/functions/team-admin/core.js');
  handle = makeHandler({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SERVICE }, fetch: fakeSupabase });
});
test.after(() => db && db.stop());

test('only a signed-in, active admin can call the function', async () => {
  let r = await call(null, { action: 'create' });
  assert.deepEqual([r.status, r.body.error], [401, 'Sign in first.']);
  r = await call('tok-forged', { action: 'create' });
  assert.equal(r.status, 401);
  r = await call('tok-designer', { action: 'create', email: 'x@example.com', full_name: 'X', role: 'admin', password: 'long-enough-1' });
  assert.deepEqual([r.status, r.body.error], [403, 'Only an admin can manage team accounts.']);
  assert.equal(db.must('super', `select count(*) from auth.users where email = 'x@example.com'`), '0', 'a designer made nobody');
  // CORS answers only the portal's own addresses.
  assert.equal(r.cors, 'https://portal.ritehomemodular.com');
  assert.equal((await call('tok-admin', {}, 'https://evil.example')).cors, 'https://portal.ritehomemodular.com');
  assert.equal((await call('tok-admin', {}, 'https://ritehome-portal-abc123-ritehome.vercel.app')).cors, 'https://ritehome-portal-abc123-ritehome.vercel.app');
});

test('the admin creates a working account in one step; the person must replace the password', async () => {
  const { must } = db;
  for (const [bad, msg] of [[{ email: 'nope', full_name: 'Jane', role: 'designer', password: 'long-enough-1' }, /email address/],
    [{ email: 'jane@example.com', full_name: '', role: 'designer', password: 'long-enough-1' }, /name/],
    [{ email: 'jane@example.com', full_name: 'Jane', role: 'boss', password: 'long-enough-1' }, /role/],
    [{ email: 'jane@example.com', full_name: 'Jane', role: 'designer', password: 'short' }, /10 to 72/]]) {
    const r = await call('tok-admin', { action: 'create', ...bad });
    assert.equal(r.status, 400); assert.match(r.body.error, msg);
  }
  const r = await call('tok-admin', { action: 'create', email: ' Jane@Example.com ', full_name: 'Jane Dela Cruz', role: 'designer', password: 'river-cabinet-42' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(must('super', `select full_name || '|' || role || '|' || active from public.profiles where id = '${r.body.id}'`), 'Jane Dela Cruz|designer|true');
  assert.equal(must('super', `select email || '|' || (raw_user_meta_data ->> 'must_change_password') from auth.users where id = '${r.body.id}'`), 'jane@example.com|true');
  const again = await call('tok-admin', { action: 'create', email: 'jane@example.com', full_name: 'Jane', role: 'designer', password: 'river-cabinet-42' });
  assert.deepEqual([again.status, again.body.error], [409, 'That email already has an account.']);
  // A forgotten password: the admin sets a new temporary one, and the flag comes back.
  must('super', `update auth.users set raw_user_meta_data = raw_user_meta_data || '{"must_change_password": false}' where id = '${r.body.id}'`);
  const reset = await call('tok-admin', { action: 'reset_password', user_id: r.body.id, password: 'oak-hinge-drawer-7' });
  assert.equal(reset.status, 200);
  assert.equal(must('super', `select raw_user_meta_data ->> 'must_change_password' from auth.users where id = '${r.body.id}'`), 'true');
  assert.equal((await call('tok-admin', { action: 'reset_password', user_id: 'not-an-id', password: 'oak-hinge-drawer-7' })).status, 400);
  assert.equal((await call('tok-admin', { action: 'promote', password: 'oak-hinge-drawer-7' })).status, 400);
});

test('team_list: admin only, with emails and the password flag; team_update guards the admin\'s own account', () => {
  const { U, must, refused } = db;
  const list = JSON.parse(must('admin', 'select public.team_list()'));
  assert.deepEqual(list.map((p) => [p.full_name, p.email, p.role, p.active, p.me]),
    [['Dina', 'dina@example.com', 'designer', true, false], ['Jane Dela Cruz', 'jane@example.com', 'designer', true, false], ['Jason', 'owner@example.com', 'admin', true, true]]);
  assert.equal(list.find((p) => p.full_name === 'Jane Dela Cruz').must_change_password, true);
  refused('designer', 'select public.team_list()', /Only an admin/);
  refused('anon', 'select public.team_list()', /permission denied/);
  must('admin', `select public.team_update('${U.designer}', '{"role":"installer","full_name":"Dina Santos"}'::jsonb)`);
  assert.equal(must('super', `select full_name || '|' || role from public.profiles where id = '${U.designer}'`), 'Dina Santos|installer');
  must('admin', `select public.team_update('${U.designer}', '{"active":false}'::jsonb)`);
  assert.equal(must('designer', 'select public.my_role()'), '', 'a switched-off account has no role');
  assert.deepEqual(JSON.parse(must('designer', 'select public.schedule_board()')).projects, [], 'and sees nothing');
  refused('admin', `select public.team_update('${U.admin}', '{"active":false}'::jsonb)`, /own account/);
  refused('admin', `select public.team_update('${U.admin}', '{"role":"designer"}'::jsonb)`, /own account/);
  refused('designer', `select public.team_update('${U.designer}', '{"active":true}'::jsonb)`, /Only an admin/);
  must('admin', `select public.team_update('${U.designer}', '{"active":true,"role":"designer"}'::jsonb)`);
});

test('team_assign_in_charge hands a designer their whiteboard rows and only their stages', () => {
  const { U, must, refused } = db;
  must('admin', `select public.board_project_save('{"clientName":"Navales","projectType":"Kitchen","inCharge":"Dina"}'::jsonb),
    public.board_project_save('{"clientName":"Cobero","projectType":"Kitchen","inCharge":" dina "}'::jsonb),
    public.board_project_save('{"clientName":"Lazaro","projectType":"Kitchen","inCharge":"Paula"}'::jsonb)`);
  const done = must('admin', `select public.board_project_save('{"clientName":"Old job","projectType":"Kitchen","inCharge":"Dina"}'::jsonb)`);
  must('super', `update public.tracker_docs set data = data || '{"status":"completed"}' where id = '${done}'`);
  assert.equal(must('admin', `select public.team_assign_in_charge('${U.designer}', 'DINA')`), '2', "Navales and Cobero; not Paula's, not the finished one");
  const b = JSON.parse(must('designer', 'select public.schedule_board()'));
  assert.deepEqual(b.projects.map((p) => p.client).sort(), ['Cobero', 'Navales']);
  const nav = b.projects.find((p) => p.client === 'Navales');
  assert.deepEqual(nav.stages.filter((s) => s.assignee === U.designer).map((s) => s.stage), ['design', 'cutlist', 'bom', 'final_cutlist']);
  assert.equal(must('admin', `select public.team_assign_in_charge('${U.designer}', 'Dina')`), '2', 'running it again changes nothing');
  refused('designer', `select public.team_assign_in_charge('${U.designer}', 'Dina')`, /Only an admin/);
  refused('admin', `select public.team_assign_in_charge('${U.designer}', '  ')`, /name written on the board/);
});
