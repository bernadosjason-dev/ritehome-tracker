// schedule.html end to end: every database call answered by the real SQL on a throwaway local PostgreSQL
// (tests/fixtures/local-pg.cjs + pg-rpc.cjs), sign-in by tests/fixtures/fake-supabase.cjs.
// Dates are relative to the real Manila today, so the test runs on any day.
// Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');
const S = require('../schedule-plan.js');

const db = startLocalPg();

(async () => {
  const {U, must} = db;
  const today = must('super', `select (now() at time zone 'Asia/Manila')::date`);
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'designer@example.com', '{"full_name":"Dina Designer"}');
    update public.profiles set role = 'admin', active = true where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true where id = '${U.designer}';`);
  const target = S.addDays(today, 75);
  must('admin', `insert into public.tracker_docs (collection, id, data) values
    ('projects', 'p_k', '{"name":"Kitchen – Ana Reyes","clientName":"Ana Reyes","clientPhone":"0917 555 0142","price":250000,"status":"active","system":"kitchen","targetDate":"${target}"}'),
    ('projects', 'p_w', '{"name":"Wardrobe – Ben Cruz","clientName":"Ben Cruz","price":90000,"status":"active","system":"storage"}'),
    ('projects', 'p_old', '{"name":"Banisilan","status":"completed"}')`);

  const sb = createFakeSupabase({rpc: pgRpc(db)});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const setSession = id => page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
    const ready = () => page.waitForFunction(() => !document.getElementById('app').hidden);
    const row = s => page.locator(`#projCard .stage-row[data-stage="${s}"]`);
    const stageDb = s => must('super', `select status || '|' || coalesce(actual_start::text, '-') || '|' || coalesce(actual_end::text, '-') from public.project_stages where project_id = 'p_k' and stage = '${s}'`);

    // 1. The admin opens on the whiteboard: one row per active project, the finished one hidden.
    await page.goto('http://127.0.0.1:8000/schedule', {waitUntil: 'domcontentloaded'});
    await setSession('u-admin'); await page.reload({waitUntil: 'domcontentloaded'}); await ready();
    assert.equal(await page.locator('.side-link[aria-current="page"]').innerText(), 'Schedule');
    assert.equal(await page.locator('[data-stab][aria-current="page"]').innerText(), 'Whiteboard');
    assert.deepEqual((await page.locator('.wb thead th').allInnerTexts()).map(x => x.trim()),
      ['#', "CLIENT'S NAME", 'PROJECT TYPE', 'IN CHARGE', 'DESIGN', 'INITIAL CUTLIST', 'BILL OF MATERIALS', 'FINAL CUTLIST', 'FABRICATION', 'INSTALLATION']);
    assert.equal(await page.locator('.wb tbody tr[data-project]').count(), 2);
    // Broken down by system: Kitchen (the kitchen) and Storage (the wardrobe), each under its own heading.
    assert.deepEqual(await page.locator('.wb tbody tr.wb-group').evaluateAll(r => r.map(x => x.getAttribute('data-group'))), ['kitchen', 'storage']);
    assert.match(await page.locator('.wb-systems').innerText(), /All systems\s+2[\s\S]*Kitchen system\s+1[\s\S]*Storage system\s+1[\s\S]*Partition system\s+0[\s\S]*Workstation system\s+0/);
    await page.locator('.wb-systems button[data-system="storage"]').click();
    assert.deepEqual(await page.locator('.wb tbody tr[data-project]').evaluateAll(r => r.map(x => x.getAttribute('data-project'))), ['p_w']);
    await page.locator('.wb-systems button', {hasText: 'All systems'}).click();

    // A new row, the way the office writes one on the board, then a status tapped straight into its cell.
    await page.locator('.wb-add input[aria-label="New row client\'s name"]').fill('R. Sanchez');
    await page.locator('.wb-add select[aria-label="New row system"]').selectOption('storage');
    await page.locator('.wb-add input[aria-label="New row project type"]').fill('Cabinet');
    await page.locator('.wb-add input[aria-label="New row in charge"]').fill('Jane');
    await page.locator('.wb-add button', {hasText: 'Add row'}).click();
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Row added for R. Sanchez under Storage.');
    const sanchez = page.locator('.wb tbody tr', {has: page.locator('.wb-name', {hasText: 'R. Sanchez'})});
    assert.deepEqual(await sanchez.locator('td').evaluateAll(t => t.slice(1, 4).map(x => x.textContent)), ['R. Sanchez', 'Cabinet', 'Jane']);
    await sanchez.locator('select[aria-label="R. Sanchez Initial cutlist"]').selectOption('in_progress');
    await page.waitForFunction(() => /R\. Sanchez: initial cutlist in progress\./.test(document.getElementById('acctMsg').textContent));
    const sid = must('admin', `select id from public.tracker_docs where data->>'clientName' = 'R. Sanchez'`);
    assert.equal(must('admin', `select data->>'system' from public.tracker_docs where id = '${sid}'`), 'storage');
    assert.equal(must('super', `select status || '|' || actual_start from public.project_stages where project_id = '${sid}' and stage = 'cutlist'`), `in_progress|${today}`);
    await page.waitForFunction(() => /ink-moving/.test(document.querySelector('select[aria-label="R. Sanchez Initial cutlist"]').className));
    await sanchez.locator('select[aria-label="R. Sanchez Bill of materials"]').selectOption('submitted');
    await page.waitForFunction(() => /bill of materials submitted/.test(document.getElementById('acctMsg').textContent));
    assert.equal(await page.locator('.wb tbody tr', {has: page.locator('.wb-name', {hasText: 'R. Sanchez'})}).locator('select[aria-label="R. Sanchez Bill of materials"] option:checked').innerText(), 'Submitted');
    must('admin', `select public.board_project_save('{"id":"${sid}"}'::jsonb)`);   // a no-op save keeps the row
    must('super', `delete from public.tracker_docs where id = '${sid}'`);            // back to the two seeded projects
    await page.reload({waitUntil: 'domcontentloaded'}); await ready();

    // The pipeline: both active projects wait in Consultation.
    await page.locator('[data-stab="pipeline"]').click();
    assert.match(await page.locator('#schedKpis').innerText(), /Active projects\s+2\s+2 not planned yet/i);
    const consult = page.locator('.pipe-col').first();
    assert.match(await consult.innerText(), /Consultation\s+2/);
    assert.equal(await page.locator('.pcard').count(), 2);
    assert.ok(!(await page.locator('#pipeBoard').innerText()).includes('Banisilan'));

    // 2. Plan the kitchen from the next working day: the preview is the standard plan, and saving stores it.
    await page.locator('.pcard[data-project="p_k"]').click();
    await page.waitForFunction(() => !document.getElementById('projCard').hidden);
    await page.locator('#projCard button', {hasText: 'Plan dates'}).click();
    const start = S.nextWorkday(today);
    assert.equal(await page.locator('#projCard input[aria-label="Plan start date"]').inputValue(), start);
    await page.locator('#projCard button', {hasText: 'Save this plan'}).click();
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Planned 9 stages.');
    const expected = S.plan(start).map(r => `${r.stage}|${r.planned_start}|${r.planned_end}`).join('\n');
    assert.equal(must('super', `select string_agg(stage || '|' || planned_start || '|' || planned_end, E'\\n' order by stage) from public.project_stages where project_id = 'p_k'`), expected);
    assert.match(await page.locator('#projCard h2 .pill').innerText(), /On track|Planned/);

    // 3. Hand design to the designer; finish consultation with one status change.
    await row('design').locator('select[data-k="assignee"]').selectOption(U.designer);
    await row('design').locator('button.save').click();
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Design saved.');
    assert.equal(must('super', `select count(*) from public.project_assignments where project_id = 'p_k'`), '1');
    await row('consultation').locator('select[data-k="status"]').selectOption('done');
    await row('consultation').locator('button.save').click();
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Consultation saved.');
    assert.equal(stageDb('consultation'), `done|${today}|${today}`);
    await page.waitForFunction(() => /Design\s+1/.test(document.querySelectorAll('.pipe-col')[1].innerText));

    // 4. Timeline: the kitchen has its eight bars, the wardrobe says it isn't planned, the workshop row is there.
    await page.locator('[data-stab="timeline"]').click();
    const kRow = page.locator('.g-row', {has: page.locator('button', {hasText: 'Kitchen – Ana Reyes'})});
    await kRow.waitFor();
    assert.equal(await kRow.locator('.g-bar').count(), 9);
    assert.equal(await kRow.locator('.g-bar.done').count(), 1);
    assert.equal(await kRow.locator('.g-target').count(), 1);
    assert.match(await page.locator('.g-row', {has: page.locator('button', {hasText: 'Wardrobe'})}).innerText(), /Not planned yet/);
    assert.equal(await page.locator('.g-load .cell').count(), 13);

    // 5. Calendar: add a site visit three days out; it shows on its day with the project's name.
    await page.locator('[data-stab="calendar"]').click();
    const visitDay = S.addDays(today, 3);
    await page.locator('#addEventBtn').click();
    await page.locator('#evProject').selectOption('p_k');
    await page.locator('#evTitle').fill('Measure kitchen');
    await page.locator('#evDate').fill(visitDay);
    await page.locator('#evStart').fill('09:00'); await page.locator('#evEnd').fill('10:30');
    await page.locator('#eventCard button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Event added.');
    await page.waitForFunction(d => document.querySelector(`.cal-cell[data-day="${d}"]`) && document.querySelector(`.cal-cell[data-day="${d}"]`).textContent.includes('Measure kitchen'), visitDay);
    assert.match(await page.locator('#calDay').innerText(), /Measure kitchen\s+Site visit · 9:00\s?AM–10:30\s?AM · Kitchen – Ana Reyes/i);
    assert.equal(must('super', `select to_char(starts_at at time zone 'Asia/Manila', 'YYYY-MM-DD HH24:MI') from public.project_events`), visitDay + ' 09:00');
    // Stage due dates are on the calendar too.
    const designEnd = S.plan(start)[1].planned_end;
    await page.evaluate(() => { document.getElementById('calToday').click(); });
    if (designEnd.slice(0, 7) !== today.slice(0, 7)) await page.locator('#calNext').click();
    await page.waitForFunction(d => (document.querySelector(`.cal-cell[data-day="${d}"]`) || {}).textContent.includes('Design due'), designEnd);

    // 6. Phone width: nothing scrolls the page sideways (the board and timeline scroll inside their cards).
    await page.setViewportSize({width: 390, height: 844});
    for (const tab of ['board', 'pipeline', 'timeline', 'calendar']) {
      await page.locator(`[data-stab="${tab}"]`).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone: ' + tab);
    }
    await page.screenshot({path: '/tmp/ritehome-schedule-phone.png', fullPage: true});
    await page.setViewportSize({width: 1280, height: 900});
    for (const tab of ['board', 'pipeline', 'timeline', 'calendar']) {
      await page.locator(`[data-stab="${tab}"]`).click();
      await page.screenshot({path: `/tmp/ritehome-schedule-${tab}.png`, fullPage: true});
    }

    // 7. The designer: only the kitchen, only Schedule in the menu, no planning, and only their own stages open.
    await page.evaluate(() => { history.replaceState(null, '', '/schedule'); });
    await setSession('u-designer'); await page.reload({waitUntil: 'domcontentloaded'}); await ready();
    // On the whiteboard the designer can tap only their own stages.
    await page.locator('[data-stab="board"]').click();
    const kb = page.locator('.wb tbody tr[data-project="p_k"]');
    assert.equal(await page.locator('.wb tbody tr[data-project]').count(), 1);
    assert.deepEqual(await kb.locator('select').evaluateAll(a => a.map(x => x.getAttribute('aria-label'))),
      ['Ana Reyes Design', 'Ana Reyes Initial cutlist', 'Ana Reyes Bill of materials', 'Ana Reyes Final cutlist']);
    assert.equal(await page.locator('.wb-add').count(), 0, 'only the admin adds rows');
    await page.locator('[data-stab="pipeline"]').click();
    assert.deepEqual(await page.locator('.pcard').evaluateAll(a => a.map(x => x.getAttribute('data-project'))), ['p_k']);
    assert.deepEqual(await page.locator('a.side-link:visible').evaluateAll(a => a.map(x => x.textContent)), ['Schedule']);
    assert.equal(await page.locator('#addEventBtn').isHidden(), true);
    assert.ok(!(await page.locator('body').innerText()).includes('250,000'));
    await page.locator('.pcard[data-project="p_k"]').click();
    await page.waitForFunction(() => !document.getElementById('projCard').hidden);
    assert.equal(await page.locator('#projCard button', {hasText: 'Plan dates'}).count(), 0);
    assert.equal(await row('fabrication').locator('select').count(), 0, 'fabrication is not the designer\'s');
    assert.equal(await row('design').locator('input[data-k="planned_start"]').count(), 0, 'planned dates are read-only for staff');
    await row('design').locator('select[data-k="status"]').selectOption('in_progress');
    await row('design').locator('input[data-k="notes"]').fill('Client chose oak laminate');
    await row('design').locator('button.save').click();
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Design saved.');
    assert.equal(stageDb('design'), `in_progress|${today}|-`);
    await page.locator('[data-stab="calendar"]').click();
    await page.evaluate(() => { document.getElementById('calToday').click(); });
    if (visitDay.slice(0, 7) !== today.slice(0, 7)) await page.locator('#calNext').click();
    await page.waitForFunction(d => (document.querySelector(`.cal-cell[data-day="${d}"]`) || {}).textContent.includes('Measure kitchen'), visitDay);

    assert.deepEqual(errors, []);
    console.log('PASS schedule: admin pipeline, plan from template saved, assign + status -> actual dates, timeline bars/target/load, calendar event + stage due dates, phone width, designer sees only assigned project, own stages, no planning, no money.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
