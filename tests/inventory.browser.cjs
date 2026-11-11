// inventory.html end to end as the purchaser, on a throwaway local PostgreSQL (tests/fixtures/local-pg.cjs
// + pg-rpc.cjs), plus the purchaser's way into the Procurement workspace and out of the money pages.
// Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
(async () => {
  const {U, must} = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}'), ('${U.purchaser}', 'pia@example.com', '{"full_name":"Pia"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';
    update public.profiles set role = 'purchaser', active = true, full_name = 'Pia' where id = '${U.purchaser}';`);
  must('admin', `select public.board_project_save('{"clientName":"Navales","projectType":"Kitchen"}'::jsonb)`);

  const sb = createFakeSupabase({rpc: pgRpc(db), users: [{id: 'u-purchaser', email: 'pia@ritehome.test', password: 'purchaser-pass', role: 'purchaser', active: true}]});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    const setSession = id => page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
    const msg = t => page.waitForFunction(t => document.getElementById('acctMsg').textContent.includes(t), t, {timeout: 8000}).catch(async e => { throw new Error('waiting for "' + t + '", page says: ' + await page.locator('#acctMsg').innerText()); });
    const row = name => page.locator(`.stock tr[data-item="${name}"]`);

    // 1. A designer is turned away.
    await page.goto('http://127.0.0.1:8000/inventory', {waitUntil: 'domcontentloaded'});
    await setSession('u-designer'); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('gateTitle').textContent === 'Inventory is for the purchaser and the admin');

    // 2. The purchaser: empty list, then the first item with opening stock.
    await setSession('u-purchaser'); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('app').hidden);
    assert.equal(await page.locator('.side-link[aria-current="page"]').innerText(), 'Inventory');
    assert.match(await page.locator('#stockTable').innerText(), /Nothing on the list yet/);
    await page.locator('#addItemBtn').click();
    await page.locator('#iName').fill('Marine plywood'); await page.locator('#iSpec').fill('18 mm');
    await page.locator('#iCategory').selectOption('board'); await page.locator('#iUnit').fill('sheet');
    await page.locator('#iLocation').fill('Rack A'); await page.locator('#iReorder').fill('5'); await page.locator('#iStart').fill('10');
    await page.locator('#iSave').click();
    await msg('Marine plywood added to the list.');
    await row('Marine plywood 18 mm').waitFor();
    assert.match(await row('Marine plywood 18 mm').innerText(), /10\s*sheet[\s\S]*In stock[\s\S]*Rack A/);

    // 3. Minus: 6 sheets out to a job; the preview shows what will be left, then the row says Low.
    await row('Marine plywood 18 mm').getByRole('button', {name: /Minus stock/}).click();
    await page.getByLabel('Quantity').fill('6');
    assert.match(await page.locator('.move-now').innerText(), /On hand now: 10 sheet\s*After: 4 sheet/);
    assert.equal(await page.locator('#mJobs option').evaluateAll(o => o.map(x => x.value).join()), 'Navales');
    await page.getByLabel('For which job').fill('Navales');
    await page.locator('#moveCard button[type=submit]').click();
    await msg('Used 6 sheet of Marine plywood 18 mm for Navales. 4 on hand.');
    await page.waitForFunction(() => /Low · reorder at 5/.test(document.querySelector('.stock tbody').textContent));
    assert.match(await page.locator('#invKpis').innerText(), /Low or out of stock\s+1\s+1 low/i);

    // 4. More than there is: refused, in plain words, and nothing changes.
    await row('Marine plywood 18 mm').getByRole('button', {name: /Minus stock/}).click();
    await page.getByLabel('Quantity').fill('9');
    assert.match(await page.locator('.move-now .after').innerText(), /Only 4 sheet on hand/);
    await page.locator('#moveCard button[type=submit]').click();
    await msg('Only 4 sheet of Marine plywood on hand.');
    assert.equal(must('super', 'select sum(qty) from public.inventory_moves'), '4.00');

    // 5. Add: a delivery of 20.
    await page.locator('#moveCard').getByRole('button', {name: 'Cancel'}).click();
    await row('Marine plywood 18 mm').getByRole('button', {name: /Add stock/}).click();
    await page.getByLabel('Quantity').fill('20'); await page.getByLabel('Note').fill('DR 1182');
    await page.locator('#moveCard button[type=submit]').click();
    await msg('Added 20 sheet of Marine plywood 18 mm. 24 on hand.');
    await page.waitForFunction(() => /In stock/.test(document.querySelector('.stock tbody').textContent));

    // 6. The history: newest first, who did it, what for.
    const hist = await page.locator('.moves tbody tr').evaluateAll(r => r.map(x => [...x.cells].slice(1).map(c => c.textContent.trim()).join(' | ')));
    assert.deepEqual(hist, ['Marine plywood 18 mm | +20 sheet | DR 1182 | Pia', 'Marine plywood 18 mm | −6 sheet | Navales | Pia', 'Marine plywood 18 mm | +10 sheet | Opening stock | Pia']);

    // 7. A count that finds 23 writes the difference; a second item; the category filter.
    await row('Marine plywood 18 mm').getByRole('button', {name: /Minus stock/}).click();
    await page.locator('#moveCard').getByRole('button', {name: 'Count instead'}).click();
    await page.getByLabel('Quantity').fill('23');
    await page.locator('#moveCard button[type=submit]').click();
    await msg('counted: 23 sheet on hand.');
    await page.locator('#addItemBtn').click();
    await page.locator('#iName').fill('Soft-close hinge'); await page.locator('#iCategory').selectOption('hardware'); await page.locator('#iUnit').fill('pc');
    await page.locator('#iSave').click();
    await msg('Soft-close hinge added to the list.');
    assert.equal(await row('Soft-close hinge').getByRole('button', {name: /Minus stock/}).isDisabled(), true, 'nothing to take from an empty shelf');
    await page.locator('#catBar [data-cat="hardware"]').click();
    assert.deepEqual(await page.locator('.stock tbody tr').evaluateAll(r => r.map(x => x.dataset.item)), ['Soft-close hinge']);
    await page.locator('#catBar [data-cat="all"]').click();

    // 8. Phone width.
    await page.setViewportSize({width: 390, height: 844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    await page.screenshot({path: '/tmp/ritehome-inventory-phone.png', fullPage: true});
    await page.setViewportSize({width: 1280, height: 900});
    await row('Marine plywood 18 mm').getByRole('button', {name: /Minus stock/}).click();
    await page.getByLabel('Quantity').fill('3');
    await page.screenshot({path: '/tmp/ritehome-inventory.png', fullPage: true});

    // 9. Elsewhere: the purchaser gets into Procurement, and is sent to Inventory from the money pages.
    await page.goto('http://127.0.0.1:8000/procurement', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('gateScreen').hidden && !document.body.classList.contains('connecting'), null, {timeout: 15000});
    assert(await page.locator('#procurementJobsSection').isVisible(), 'procurement jobs are open to the purchaser');
    await page.goto('http://127.0.0.1:8000/', {waitUntil: 'domcontentloaded'});
    await page.waitForURL('**/inventory', {timeout: 15000});
    await page.waitForFunction(() => !document.getElementById('app').hidden);
    await page.goto('http://127.0.0.1:8000/accounting', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('gate').hidden && /admin/i.test(document.getElementById('gateTitle').textContent));

    assert.deepEqual(errors, []);
    console.log('PASS inventory: designer turned away, purchaser adds an item with opening stock, minus to a job with preview, over-use refused, delivery added, history with names, count, category filter, phone width, Procurement open, sent home from the money pages.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
