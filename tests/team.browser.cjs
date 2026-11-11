// team.html end to end, plus the first sign-in with a temporary password on the portal's front page.
// Database calls run on a throwaway local PostgreSQL (tests/fixtures/local-pg.cjs + pg-rpc.cjs); the
// team-admin Edge Function (supabase/functions/team-admin/core.js) runs in Node, against a stand-in
// for Supabase's auth and REST APIs backed by that same database.
// Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
const SERVICE = 'service-key';
const q = s => String(s).replace(/'/g, "''");

(async () => {
  const {U, must} = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';`);
  for (const [client, inCharge] of [['Navales', 'Jane'], ['Cobero', 'Jane'], ['Lazaro', 'Paula']])
    must('admin', `select public.board_project_save('{"clientName":"${client}","projectType":"Kitchen","inCharge":"${inCharge}"}'::jsonb)`);

  // The Edge Function, with Supabase's auth/REST answered from the local database.
  const {makeHandler} = await import('../supabase/functions/team-admin/core.js');
  const tokens = {'token-u-admin': U.admin, 'token-u-designer': U.designer};
  const fake = (url, init = {}) => {
    const u = new URL(url), m = init.method || 'GET', hd = init.headers || {};
    const json = (status, body) => Promise.resolve(new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}}));
    if (u.pathname === '/auth/v1/user') { const id = tokens[String(hd.Authorization).replace('Bearer ', '')]; return id ? json(200, {id}) : json(401, {}); }
    if (hd.apikey !== SERVICE) return json(401, {});
    if (u.pathname === '/rest/v1/profiles' && m === 'GET')
      return json(200, JSON.parse(must('super', `select coalesce(json_agg(json_build_object('role', role, 'active', active)), '[]') from public.profiles where id = '${q(u.searchParams.get('id').slice(3))}'`)));
    if (u.pathname === '/rest/v1/profiles' && m === 'PATCH') {
      const b = JSON.parse(init.body);
      must('super', `update public.profiles set full_name = '${q(b.full_name)}', role = '${b.role}', active = ${b.active} where id = '${q(u.searchParams.get('id').slice(3))}'`);
      return Promise.resolve(new Response(null, {status: 204}));
    }
    if (u.pathname === '/auth/v1/admin/users' && m === 'POST') {
      const b = JSON.parse(init.body), id = crypto.randomUUID();
      must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${id}', '${q(b.email)}', '${q(JSON.stringify(b.user_metadata))}')`);
      return json(200, {id});
    }
    const r = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(u.pathname);
    if (r && m === 'PUT') {
      must('super', `update auth.users set raw_user_meta_data = raw_user_meta_data || '${q(JSON.stringify(JSON.parse(init.body).user_metadata))}' where id = '${q(r[1])}'`);
      return json(200, {id: r[1]});
    }
    return json(404, {});
  };
  const handle = makeHandler({env: {SUPABASE_URL: 'https://laxavfldivkhufeubgmb.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SERVICE}, fetch: fake});

  const sb = createFakeSupabase({rpc: pgRpc(db), users: [{id: 'u-temp', email: 'yhna@ritehome.test', password: 'maple-hinge-river-42', role: 'designer', active: true, meta: {must_change_password: true}}]});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    // Registered after the shim: Playwright gives the newest matching route priority.
    await page.route('https://laxavfldivkhufeubgmb.supabase.co/functions/v1/team-admin', async route => {
      const req = route.request();
      const res = await handle(new Request(req.url(), {method: req.method(), headers: req.headers(), body: req.postData()}));
      await route.fulfill({status: res.status, headers: Object.fromEntries(res.headers), body: await res.text()});
    });
    const setSession = id => page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
    const msg = t => page.waitForFunction(t => document.getElementById('acctMsg').textContent.includes(t), t, {timeout: 8000}).catch(async e => { throw new Error('waiting for "' + t + '", page says: ' + await page.locator('#acctMsg').innerText()); });
    const row = email => page.locator(`.people tr[data-person="${email}"]`);

    // 1. Staff are turned away from the page.
    await page.goto('http://127.0.0.1:8000/team', {waitUntil: 'domcontentloaded'});
    await setSession('u-designer'); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('gateTitle').textContent === 'Team accounts are for admins');

    // 2. The admin sees the team; their own account can't be switched off or demoted.
    await setSession('u-admin'); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('app').hidden);
    assert.equal(await page.locator('.side-link[aria-current="page"]').innerText(), 'Team');
    assert.match(await page.locator('#teamKpis').innerText(), /Active accounts\s+2\s+1 staff, 1 admin/i);
    assert.equal(await row('owner@example.com').locator('select').isDisabled(), true);
    assert.equal(await row('owner@example.com').getByRole('button', {name: 'Switch off'}).count(), 0);

    // 3. Add Jane: a temporary password is suggested; the account is made and handed over.
    await page.locator('#addPersonBtn').click();
    const temp = await page.locator('#pPassword').inputValue();
    assert.match(temp, /^[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
    await page.locator('#pName').fill('Jane Dela Cruz'); await page.locator('#pEmail').fill('jane@example.com');
    await page.locator('#pRole').selectOption('designer');
    await page.locator('#pSave').click();
    await msg('Account created for Jane Dela Cruz.');
    await page.locator('#handover').waitFor();
    assert.equal(await page.locator('#handover [data-temp-password]').innerText(), temp);
    assert.match(await page.locator('#handover').innerText(), /2 whiteboard rows under “Jane”/);
    const jane = must('super', `select id from auth.users where email = 'jane@example.com'`);
    assert.equal(must('super', `select role || '|' || active from public.profiles where id = '${jane}'`), 'designer|true');
    assert.match(await row('jane@example.com').innerText(), /Temporary password/);

    // 4. Hand Jane her whiteboard rows: Navales and Cobero, not Paula's.
    await row('jane@example.com').getByRole('button', {name: /Give 2 board rows/}).click();
    await msg('Jane Dela Cruz now has 2 projects from the whiteboard');
    assert.equal(must('super', `select string_agg(d.data->>'clientName', ',' order by d.data->>'clientName') from public.project_assignments a join public.tracker_docs d on d.id = a.project_id where a.user_id = '${jane}'`), 'Cobero,Navales');
    await page.waitForFunction(() => !document.querySelector('.people tr[data-person="jane@example.com"]').textContent.includes('Give 2'));

    // 5. Reset Jane's password; switch Dina off and on.
    await row('jane@example.com').getByRole('button', {name: 'Reset password'}).click();
    await msg('New temporary password set for Jane Dela Cruz.');
    assert.notEqual(await page.locator('#handover [data-temp-password]').innerText(), temp);
    await row('dina@example.com').getByRole('button', {name: 'Switch off'}).click();
    await msg('Dina is switched off.');
    assert.equal(must('super', `select active from public.profiles where id = '${U.designer}'`), 'f');
    await row('dina@example.com').getByRole('button', {name: 'Switch on'}).click();
    await msg('Dina can sign in again.');
    await row('dina@example.com').locator('select').selectOption('installer');
    await msg('Dina is now Installer.');
    assert.equal(must('super', `select role from public.profiles where id = '${U.designer}'`), 'installer');

    // 6. Phone width.
    await page.setViewportSize({width: 390, height: 844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    await page.screenshot({path: '/tmp/ritehome-team-phone.png', fullPage: true});
    await page.setViewportSize({width: 1280, height: 900});
    await page.screenshot({path: '/tmp/ritehome-team.png', fullPage: true});

    // 7. First sign-in with a temporary password: choose your own before anything else.
    await page.evaluate(() => localStorage.removeItem('fake-sb-session'));
    await page.goto('http://127.0.0.1:8000/', {waitUntil: 'domcontentloaded'});
    await page.locator('#gateLogin').waitFor();
    await page.locator('#gateEmail').fill('yhna@ritehome.test'); await page.locator('#gatePassword').fill('maple-hinge-river-42');
    await page.locator('#gateLoginBtn').click();
    await page.locator('#gateNewPw').waitFor();
    assert.match(await page.locator('#gateMsg').innerText(), /Choose your own password/);
    assert.equal(await page.locator('#gateLogin').isHidden(), true);
    await page.locator('#gateNewPw1').fill('my-own-pass-1'); await page.locator('#gateNewPw2').fill('my-own-pass-2');
    await page.locator('#gateNewPwBtn').click();
    assert.equal(await page.locator('#gateError').innerText(), 'The two passwords don’t match.');
    await page.locator('#gateNewPw2').fill('my-own-pass-1');
    await page.locator('#gateNewPwBtn').click();
    await page.waitForFunction(() => /on the Schedule/.test(document.getElementById('gateMsg').textContent));
    const temp2 = sb.users.find(u => u.id === 'u-temp');
    assert.deepEqual([temp2.password, temp2.meta.must_change_password], ['my-own-pass-1', false]);

    assert.deepEqual(errors, []);
    console.log('PASS team: staff turned away, own account protected, create with temporary password + handover, whiteboard rows assigned, reset password, switch off/on, role change, phone width, first sign-in forces a new password.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
