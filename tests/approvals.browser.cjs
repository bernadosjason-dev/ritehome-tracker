// Phase 4 end to end (approvals.html and the Schedule's hand-off), every database call answered by the
// real SQL on a throwaway local PostgreSQL (local-pg.cjs + pg-rpc.cjs), sign-in by fake-supabase.cjs.
// The designer submits Design from the whiteboard, the admin sends it back with remarks, the designer
// resubmits, the admin approves; both versions stay. Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();

(async () => {
  const {U, must} = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'designer@example.com', '{"full_name":"Dina Designer"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina Designer' where id = '${U.designer}';`);
  must('admin', `insert into public.tracker_docs (collection, id, data) values
    ('projects', 'p_k', '{"name":"Kitchen – Ana Reyes","clientName":"Ana Reyes","price":250000,"status":"active","system":"kitchen"}')`);
  for (const s of ['design', 'cutlist', 'bom', 'final_cutlist']) must('admin', `select public.stage_save('p_k', '${s}', '{"assignee":"${U.designer}"}'::jsonb)`);
  const stage = (s) => must('super', `select status from public.project_stages where project_id = 'p_k' and stage = '${s}'`);
  const subs = () => must('super', `select string_agg(version || ':' || decision, ',' order by version) from public.stage_submissions where stage = 'design'`);

  const sb = createFakeSupabase({rpc: pgRpc(db)});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [], answers = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.type() === 'prompt' ? d.accept(answers.length ? answers.shift() : '') : d.accept());
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const as = async (id, url) => {
      await page.goto('http://127.0.0.1:8000' + url, {waitUntil: 'domcontentloaded'});
      await page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
      await page.reload({waitUntil: 'domcontentloaded'});
      await page.waitForFunction(() => !document.getElementById('app').hidden);
    };
    const designCell = () => page.locator('.wb tbody tr[data-project="p_k"] select[aria-label="Ana Reyes Design"]');

    // 1. The designer can't mark Design approved; "Submit for review…" asks for a note and a link.
    await as('u-designer', '/schedule');
    await page.locator('[data-stab="board"]').click();
    const opts = await designCell().locator('option').evaluateAll(o => o.map(x => x.textContent));
    assert(opts.includes('Submit for review…'), opts.join());
    assert(!opts.includes('Approved'), 'the designer can\'t approve their own design: ' + opts.join());
    answers.push('Layout A with island', 'https://drive.google.com/file/d/layout-a');
    await designCell().selectOption('submitted');
    await page.waitForFunction(() => /Design v1 submitted for review/.test(document.getElementById('acctMsg').textContent));
    assert.equal(stage('design'), 'submitted'); assert.equal(subs(), '1:pending');
    // While it waits, the cell is not the designer's to change (once the board has reloaded).
    await page.waitForFunction(() => !document.querySelector('.wb tbody tr[data-project="p_k"] select[aria-label="Ana Reyes Design"]'));
    assert.deepEqual(await page.locator('a.side-link:visible').evaluateAll(a => a.map(x => x.textContent)), ['Approvals', 'Schedule', 'Attendance']);

    // 2. On Approvals the designer sees it with the admin, and can't decide it.
    await page.locator('a.side-link', {hasText: 'Approvals'}).click();
    await page.waitForFunction(() => !document.getElementById('app').hidden && document.getElementById('apTitle').textContent === '1 submission with the admin');
    assert.equal(await page.locator('#queue button').count(), 0);
    assert.equal(await page.locator('#rulesCard').isHidden(), true);
    assert.equal(await page.locator('#queue .ap-link').getAttribute('href'), 'https://drive.google.com/file/d/layout-a');

    // 3. The admin: sending back needs remarks; then it's decided, the stage reopens, the remarks are kept.
    await as('u-admin', '/approvals');
    assert.equal(await page.locator('#apTitle').innerText(), '1 stage waiting for you');
    assert.match(await page.locator('#queue .ap-item').innerText(), /Kitchen – Ana Reyes · Design v1[\s\S]*Dina Designer · submitted[\s\S]*Layout A with island/);
    await page.locator('#queue button', {hasText: 'Send back for revision'}).click();
    await page.waitForFunction(() => /Say what needs changing/.test(document.getElementById('acctMsg').textContent));
    assert.equal(subs(), '1:pending', 'nothing sent without remarks');
    await page.locator('#queue textarea').fill('Move the fridge to the left wall');
    await page.locator('#queue button', {hasText: 'Send back for revision'}).click();
    await page.waitForFunction(() => document.getElementById('apTitle').textContent === 'Nothing waiting for you');
    assert.equal(subs(), '1:revise'); assert.equal(stage('design'), 'in_progress');
    assert.match(await page.locator('#history .ap-item').innerText(), /Revise[\s\S]*Remarks: Move the fridge to the left wall|Move the fridge to the left wall/);

    // 4. The designer sees why on Approvals, resubmits from the Schedule (v2), the admin approves.
    await as('u-designer', '/approvals');
    assert.match(await page.locator('#history').innerText(), /Move the fridge to the left wall/);
    await as('u-designer', '/schedule');
    await page.locator('[data-stab="board"]').click();
    answers.push('Layout B: fridge on the left wall', '');
    await designCell().selectOption('submitted');
    await page.waitForFunction(() => /Design v2 submitted for review/.test(document.getElementById('acctMsg').textContent));
    await as('u-admin', '/approvals');
    assert.match(await page.locator('#queue .ap-item').innerText(), /Design v2[\s\S]*1 earlier version/);
    await page.locator('#queue button', {hasText: 'Approve'}).click();
    await page.waitForFunction(() => /approved\. The next stage can start\./.test(document.getElementById('acctMsg').textContent));
    assert.equal(subs(), '1:revise,2:approved'); assert.equal(stage('design'), 'done');
    assert.equal(await page.locator('#history .ap-item').count(), 2, 'both versions kept');

    // 5. The admin's rules: untick Initial cutlist.
    await page.locator('#rules input[data-stage="cutlist"]').uncheck();
    await page.waitForFunction(() => /Initial cutlist no longer needs approval/.test(document.getElementById('acctMsg').textContent));
    assert.equal(must('super', `select required from public.approval_rules where stage = 'cutlist'`), 'f');
    assert.match(await page.locator('#portalVersion').innerText(), /^Portal v\d+\.\d+$/);

    // 6. Phone width: no sideways scroll.
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS approvals: designer submits from the whiteboard (no self-approval), sees it waiting; admin needs remarks to send back, the stage reopens; v2 approved, both versions kept; rules toggle; phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
