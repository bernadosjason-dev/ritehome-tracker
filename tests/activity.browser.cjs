// activity.html end to end against the real SQL (tests/fixtures/local-pg.cjs + pg-rpc.cjs): staff are
// turned away, the admin sees who changed what with before/after, filters by person and workspace,
// opens a record's history, and a refusal reported by a page lands in the log.
// Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
const q = s => String(s).replace(/'/g, "''");
const j = v => `'${q(JSON.stringify(v))}'::jsonb`;

(async () => {
  const {U, must} = db;
  U.sales = '00000000-0000-4000-8000-000000000005';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.sales}', 'sam@example.com', '{"full_name":"Sam"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'sales', active = true, full_name = 'Sam' where id = '${U.sales}';`);
  // A day's work: Jason opens a project, Sam adds a lead and moves it on.
  must('admin', `insert into public.tracker_docs (collection, id, data) values ('projects', 'p_k', '{"name":"Kitchen – Ana Reyes","price":250000,"status":"active"}')`);
  const lead = must('sales', `select public.lead_save(${j({source: 'walk-in', name: 'Carlo Diaz', phone: '0917 000 1111'})})`);
  must('sales', `select public.lead_save(${j({id: lead, stage: 'quoted', expected_value: 180000})})`);

  const sb = createFakeSupabase({rpc: pgRpc(db, {'u-admin': 'admin', 'u-designer': 'designer', 'u-sales': 'sales'}),
    users: [{id: 'u-sales', email: 'sales@ritehome.test', password: 'sales-pass', role: 'sales', active: true}]});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const setSession = id => page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
    const ready = () => page.waitForFunction(() => !document.getElementById('app').hidden);

    // 1. Staff are turned away, and the menu doesn't offer the page.
    await page.goto('http://127.0.0.1:8000/activity', {waitUntil: 'domcontentloaded'});
    await setSession('u-designer'); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('gateTitle').textContent === 'The activity log is for admins');
    assert.ok(await page.locator('#bellBtn').isHidden(), 'staff have no bell');
    // A refusal a page reports lands in the log under the person's name.
    await page.evaluate(() => window.RitehomeRefused(window.supabase.createClient('https://laxavfldivkhufeubgmb.supabase.co', 'k'),
      'Leads', 'lead_save', {code: '42501', message: 'Only sales or an admin can change leads.'}));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(must('super', `select actor_name || '|' || label || '|' || source from public.audit_log where action = 'refused'`), 'Dina|lead_save|page');

    // 2. The admin: the refusal is the first figure, and every change is listed with who did it.
    await setSession('u-admin'); await page.reload({waitUntil: 'domcontentloaded'}); await ready();
    assert.match(await page.locator('#actKpis .kpi').first().innerText(), /Refused today\s+1/i);
    assert.match(await page.locator('#actTitle').innerText(), /changes today · 1 refused/);
    const list = await page.locator('#actList').innerText();
    assert.match(list, /Sam · Sales\s+changed lead Carlo Diaz: .*Stage contacted → quoted/s);
    assert.match(list, /Jason · Admin\s+added project Kitchen – Ana Reyes/);
    assert.match(list, /Dina · Designer\s+was refused: lead_save \(Only sales or an admin can change leads\.\)/);
    assert.ok(await page.locator('a.side-link', {hasText: 'Activity'}).isVisible());

    // 2b. The bell: Sam's new lead, his stage change and Dina's refusal are waiting, newest first.
    const unread = Number(must('super', 'select count(*) from public.notify_events'));
    assert.ok(unread >= 3, 'events: ' + unread);
    await page.waitForFunction(n => document.getElementById('bellCount').textContent === String(n), unread);
    await page.locator('#bellBtn').click();
    await page.locator('#bellPanel .bell-item').first().waitFor();
    const first = await page.locator('#bellPanel .bell-item').first().innerText();
    assert.match(first, /Dina was refused: lead_save\s+Only sales or an admin can change leads\.\s+just now · Leads/);
    assert.ok(await page.locator('#bellPanel .bell-item.alert.unread').count() >= 1);
    assert.match(await page.locator('#bellPanel').innerText(), /New lead: Carlo Diaz/);
    assert.equal(await page.locator('#bellPanel select').inputValue(), 'important');
    await page.locator('#bellPanel select').selectOption('alerts');
    await page.waitForFunction(() => !document.querySelector('#bellPanel select').disabled);
    assert.equal(must('super', 'select telegram from public.notify_settings'), 'alerts');
    await page.locator('#bellPanel select').selectOption('important');
    await page.waitForFunction(() => !document.querySelector('#bellPanel select').disabled);
    await page.screenshot({path: '/tmp/ritehome-bell.png'});
    await page.locator('#bellPanel .bell-all').click();
    await page.waitForFunction(() => document.getElementById('bellCount').hidden);
    assert.equal(await page.locator('#bellPanel .bell-item.unread').count(), 0);
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('#bellPanel').isHidden());

    // 3. Open a change: before and after, field by field.
    const change = page.locator('.act-row', {hasText: 'changed lead Carlo Diaz'}).first();
    await change.click();
    const diff = page.locator('.act-diff').first();
    await diff.waitFor();
    assert.match(await diff.innerText(), /Stage\s+contacted\s+quoted/);
    assert.match(await diff.innerText(), /Expected value\s+—\s+180000/);

    // 4. That lead's whole history, then back.
    await page.locator('.act-detail button', {hasText: 'History of this record'}).click();
    await page.waitForFunction(() => /Showing the history of lead Carlo Diaz/.test(document.getElementById('recordNote').textContent));
    const hist = await page.locator('.act-row').evaluateAll(a => a.map(x => x.querySelector('.act-what').textContent));
    assert.ok(hist.length >= 2 && hist.every(t => /lead Carlo Diaz/.test(t)), 'only that lead: ' + hist.join(' / '));
    await page.locator('#recordNote button').click();
    await page.waitForFunction(() => document.getElementById('recordNote').hidden);

    // 5. Filters: one person, one workspace, refusals only.
    await page.locator('#fActor').selectOption(U.sales);
    await page.waitForFunction(() => [...document.querySelectorAll('.act-who strong')].every(e => e.textContent === 'Sam'));
    await page.locator('#fActor').selectOption('');
    await page.locator('#fModule').selectOption('Projects');
    await page.waitForFunction(() => [...document.querySelectorAll('.act-where')].every(e => /^Projects/.test(e.textContent)));
    await page.locator('#fClear').click();
    await page.locator('#fAction').selectOption('refused');
    await page.waitForFunction(() => document.querySelectorAll('.act-row').length === 1);
    await page.locator('#fClear').click();

    // 6. Phone width.
    await page.setViewportSize({width: 390, height: 844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    await page.screenshot({path: '/tmp/ritehome-activity-mobile.png', fullPage: true});
    await page.setViewportSize({width: 1280, height: 900});
    await page.screenshot({path: '/tmp/ritehome-activity-desktop.png', fullPage: true});

    assert.deepEqual(errors, []);
    console.log('PASS activity: staff gate (no bell), page-reported refusal logged, refused first, bell (unread count, newest first, Telegram setting, mark all read), who/what/before-after, record history, filters, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
