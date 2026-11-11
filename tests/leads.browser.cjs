// leads.html end to end: every database call answered by the real SQL on a throwaway local PostgreSQL
// (tests/fixtures/local-pg.cjs + pg-rpc.cjs), sign-in by tests/fixtures/fake-supabase.cjs.
// Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
const KEY = 'browser-test-ingest-key';
const ingest = p => db.must('anon', `select public.ingest_lead('${JSON.stringify(p).replace(/'/g, "''")}'::jsonb, '${KEY}')`);

(async () => {
  const {U, must} = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'designer@example.com', '{}');
    update public.profiles set role = 'admin', active = true where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';
    insert into public.app_secrets (name, sha256) values ('lead_ingest', '${crypto.createHash('sha256').update(KEY).digest('hex')}');`);
  // Two website leads through the Worker's door. Ana came in a week ago and nobody has replied.
  const ana = JSON.parse(ingest({source: 'site-visit', name: 'Ana Reyes', phone: '0917 555 0142', line: 'Kitchen', address: 'Carmen, Cagayan de Oro',
    visitDate: '2026-11-20', visitTime: '9:00 AM', notes: 'L-shape 4m by 3m, laminated'})).id;
  ingest({source: 'hannah', name: 'Hannah lead (0918 222 3344)', phone: '0918 222 3344', notes: 'Visitor: how much for a wardrobe?'});
  must('super', `update public.leads set created_at = now() - interval '7 days' where id = '${ana}'`);

  const sb = createFakeSupabase({rpc: pgRpc(db)});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept(dialogs.answers ? dialogs.answers.shift() : ''); });
    const setSession = id => page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);

    // 1. Staff are turned away.
    await page.goto('http://127.0.0.1:8000/leads', {waitUntil: 'domcontentloaded'});
    await setSession('u-designer'); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('gateTitle').textContent === 'Leads are for admins');

    // 2. The admin: Ana is waiting past the 2-hour promise, at the top of "Reply now".
    await setSession('u-admin'); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('app').hidden && document.getElementById('waitList').textContent.includes('Ana Reyes'));
    assert.match(await page.locator('#leadKpis').innerText(), /Waiting for a reply\s+2\s+1 past the 2-hour promise/i);
    assert.equal(await page.locator('#waitList .lead-row-name').first().innerText(), 'Ana Reyes', 'oldest first');
    assert.equal(await page.locator('#waitList .wait-row').first().locator('a', {hasText: 'WhatsApp'}).getAttribute('href'), 'https://wa.me/639175550142');
    assert.equal(await page.locator('.side-link[aria-current="page"]').innerText(), 'Leads');

    // 3. Log the reply: the lead moves to Contacted, leaves the queue, and the next step is set.
    await page.locator('#waitList .wait-row').first().getByRole('link', {name: 'Log reply'}).click();
    await page.waitForFunction(() => !document.getElementById('leadCard').hidden && document.getElementById('leadCard').textContent.includes('Ana Reyes'));
    assert.equal(await page.locator('#leadCard select[aria-label="What happened"]').inputValue(), 'call');
    await page.locator('#leadCard input[aria-label="Note"]').fill('Confirmed the Nov 20 visit');
    await page.locator('#leadCard input[aria-label="Next step"]').fill('Bring sample doors');
    await page.locator('#leadCard input[aria-label="Next step date"]').fill('2026-11-20');
    await page.locator('#leadCard button', {hasText: 'Log it'}).click();
    await page.waitForFunction(() => document.getElementById('leadCard').textContent.includes('new → contacted'));
    assert.equal(must('admin', `select stage || '|' || (first_response_at is not null) || '|' || next_action from public.leads where id = '${ana}'`), 'contacted|true|Bring sample doors');
    await page.waitForFunction(() => !document.getElementById('waitList').textContent.includes('Ana Reyes'));

    // 4. Asking the questions moves the score: ASAP + ₱180k turns her Hot (30 + 20 + 15 + 15 + 15 = 95).
    assert.match(await page.locator('#leadCard h2 .score').innerText(), /^Warm 63$/);
    await page.locator('#leadCard select[data-key="timeline"]').selectOption('asap');
    await page.locator('#leadCard input[data-key="budget"]').fill('180000');
    await page.locator('#leadCard button', {hasText: 'Save details'}).click();
    await page.waitForFunction(() => /Hot 95/.test(document.querySelector('#leadCard h2 .score').textContent));
    assert.equal(await page.locator('#boardTable tbody tr').first().locator('.lead-row-name').innerText(), 'Ana Reyes', 'hottest first');

    // 5. A walk-in, added by hand.
    await page.locator('#addLeadBtn').click();
    await page.locator('#nName').fill('Clinic owner'); await page.locator('#nSource').selectOption('walk-in');
    await page.locator('#nSystem').selectOption('partition'); await page.locator('#nLocation').fill('Opol, Misamis Oriental');
    await page.locator('#nMessage').fill('Clinic partitions, 3 rooms');
    await page.locator('#addForm button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('leadCard').textContent.includes('Clinic owner'));

    // 6. Won: the tracker project is created with the client's details and linked.
    dialogs.answers = ['210000', '160000'];
    await page.locator('#leadCard .stage-btns button', {hasText: 'Won'}).click();
    await page.waitForFunction(() => document.getElementById('leadCard').textContent.includes('open the project in the tracker'));
    const pid = must('admin', `select project_id from public.leads where name = 'Clinic owner'`);
    assert.match(pid, /^p_[0-9a-f]{16}$/);
    assert.equal(await page.locator('#leadCard a', {hasText: 'open the project'}).getAttribute('href'), '/projects#p=' + pid);
    assert.equal(JSON.parse(must('admin', `select data from public.tracker_docs where id = '${pid}'`)).price, 210000);

    // 7. Lost, with the reason kept in the history.
    await page.goto('http://127.0.0.1:8000/leads#lead=' + must('admin', `select id from public.leads where phone = '0918 222 3344'`), {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('leadCard').hidden);
    dialogs.answers = ['Price: went with a carpenter'];
    await page.locator('#leadCard .stage-btns button', {hasText: 'Lost'}).click();
    await page.waitForFunction(() => document.getElementById('leadCard').textContent.includes('new → lost: Price: went with a carpenter'));
    assert.match(await page.locator('#leadKpis').innerText(), /Win rate, 90 days\s+50%/i);

    // 8. Phone width.
    await page.setViewportSize({width: 390, height: 844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    await page.screenshot({path: '/tmp/ritehome-leads-mobile.png', fullPage: true});
    await page.setViewportSize({width: 1280, height: 900});
    await page.evaluate(() => { history.replaceState(null, '', '/leads'); });
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('app').hidden);
    await page.screenshot({path: '/tmp/ritehome-leads-desktop.png', fullPage: true});

    assert.deepEqual(errors, []);
    console.log('PASS leads: staff gate, Worker leads in the reply queue past 2 h, WhatsApp link, log reply -> contacted, score from answers, walk-in by hand, won -> tracker project, lost with reason, win rate, phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
