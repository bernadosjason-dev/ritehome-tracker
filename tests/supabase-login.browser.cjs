// The tracker page on its Supabase backend, end to end in a real browser: the email/password
// gate, role routing (admin in; staff and unactivated accounts held at the gate), sign-out,
// a remembered session, and real saves through supabase-backend.js and its Supabase store
// (projects, expenses, vehicles, fuel, receipt photos in the receipts bucket).
// The project itself is replaced by tests/fixtures/fake-supabase.cjs.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII=', 'base64');

(async () => {
  const sb = createFakeSupabase();
  sb.seed('projects', 'p_seeded000000001', {name: 'Uy residence kitchen', status: 'active', budget: 120000, updatedAt: '2026-11-01T00:00:00.000Z'});
  sb.seed('expenses', 'e_seeded000000001', {date: '2026-11-02', item: 'Marine plywood', category: 'materials', amount: 5400, noReceipt: true}, 'p_seeded000000001');
  sb.seed('projects', 'p_seeded000000002', {name: 'Office partitions', status: 'active', updatedAt: '2026-10-01T00:00:00.000Z'});
  sb.seed('expenses', 'e_seeded000000002', {date: '2026-10-02', item: 'Aluminum frames', category: 'materials', amount: 9000, noReceipt: true}, 'p_seeded000000002');
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    await page.addInitScript(() => { try { sessionStorage.setItem('ritehome_ptab', 'expenses'); } catch (e) {} });   // these tests work in the Expenses tab
    page.on('pageerror', e => errors.push(e.message));
    let appsScriptCalls = 0;
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await page.route('https://script.google.com/**', r => { appsScriptCalls++; return r.abort(); });
    await sb.attach(page);
    const gateText = () => page.locator('#gateMsg').innerText();
    const signIn = async (email, password) => {
      await page.locator('#gateEmail').fill(email); await page.locator('#gatePassword').fill(password);
      await page.locator('#gateLogin').evaluate(f => f.requestSubmit());
    };

    // 1. Signed out, arriving from an old share link: the email/password form, never the old access-key
    //    form, and the old key is dropped from the address bar without being kept.
    await page.goto('http://127.0.0.1:8000/tracker.html?portal=projects#key=old-shared-key', {waitUntil: 'domcontentloaded'});
    await page.locator('#gateLogin').waitFor();
    assert(!page.url().includes('key='), page.url());
    assert.equal(await page.evaluate(() => localStorage.getItem('ritehome_tracker_key')), null);
    assert(await page.locator('#gateEmail').isVisible());
    assert(!await page.locator('#gateForm').isVisible(), 'no access-key form');
    assert.match(await gateText(), /email and password/);

    // 2. A wrong password is refused at the gate.
    await signIn('admin@ritehome.test', 'nope');
    await page.waitForFunction(() => document.getElementById('gateError').textContent !== '');
    assert.equal(await page.locator('#gateError').innerText(), 'Wrong email or password.');
    assert.equal(await page.locator('#gatePassword').inputValue(), '', 'password cleared');

    // 3. Staff and unactivated accounts stay at the gate, see why, and can sign out. No tracker data is read.
    await signIn('designer@ritehome.test', 'designer-pass');
    await page.waitForFunction(() => !document.getElementById('gateAccount').hidden);
    assert.match(await gateText(), /your projects and their stages are on the Schedule/);
    assert.equal(await page.locator('#gateSchedule').getAttribute('href'), '/schedule');
    assert.equal(await page.locator('#gateWho').innerText(), 'Signed in as designer@ritehome.test');
    assert(await page.locator('body').evaluate(b => b.classList.contains('gated')));
    assert.equal(sb.log.length, 0, 'a staff sign-in reads no tracker documents');
    await page.locator('#gateSignOut').click();
    await page.locator('#gateLogin').waitFor();
    await signIn('new@ritehome.test', 'new-pass');
    await page.waitForFunction(() => !document.getElementById('gateAccount').hidden);
    assert.match(await gateText(), /hasn’t been activated/);
    await page.locator('#gateSignOut').click();
    await page.locator('#gateLogin').waitFor();

    // 4. The admin gets in and sees the data already in Supabase.
    await signIn('admin@ritehome.test', 'admin-pass');
    await page.waitForFunction(() => !document.body.classList.contains('gated'));
    await page.waitForFunction(() => document.body.innerText.includes('Uy residence kitchen'));
    assert.equal(await page.locator('#forgetKeyBtn').innerText(), 'Sign out');

    // 5. A reload keeps the session: straight back in, no form.
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.body.innerText.includes('Uy residence kitchen') && !document.body.classList.contains('gated'));

    // 6. Expenses save into tracker_docs under their project.
    await page.goto('http://127.0.0.1:8000/tracker.html?portal=projects#p=p_seeded000000001', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('projectNameText').textContent === 'Uy residence kitchen');
    await page.waitForFunction(() => !document.getElementById('expenseSubmit').disabled && document.body.innerText.includes('Marine plywood'));
    assert(!await page.locator('#dashboardScreen, #projectScreen').last().innerText().then(t => t.includes('Aluminum frames')), "another project's expense must not show");
    await page.locator('#f-category').selectOption('food');
    await page.locator('#f-item').fill('Crew lunch');
    await page.locator('#f-amount').fill('845');
    await page.locator('#f-date').fill('2026-11-05');
    const noReceipt = page.locator('#f-noReceipt, #noReceipt, [name="noReceipt"]').first();
    if (await noReceipt.count() && await noReceipt.isVisible()) await noReceipt.check();
    await page.locator('#expenseSubmit').click();
    await page.waitForFunction(() => document.body.innerText.includes('Crew lunch'));
    const lunch = sb.rows.find(r => r.collection === 'expenses' && r.data.item === 'Crew lunch');
    assert(lunch, 'expense row written');
    assert.equal(lunch.parent_id, 'p_seeded000000001');
    assert.equal(lunch.data.amount, 845);
    assert.match(lunch.id, /^e_[0-9a-f]{16}$/);

    // 7. Vehicles and a fuel purchase with a receipt photo: the photo lands in the receipts bucket and
    //    the ledger shows it from the bucket's public URL.
    await page.goto('http://127.0.0.1:8000/tracker.html?portal=fuel', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('cf-fields').disabled);
    await page.locator('#companyVehiclesPanel summary').click();
    await page.waitForFunction(() => !document.getElementById('cv-fields').disabled);
    await page.locator('#cv-name').fill('Van'); await page.locator('#cv-type').selectOption('diesel'); await page.locator('#cv-save').click();
    await page.waitForFunction(() => document.getElementById('cv-rows').textContent.includes('Van') && !document.getElementById('cv-fields').disabled);
    assert(sb.rows.some(r => r.collection === 'companyVehicles' && r.data.name === 'Van' && r.data.fuelType === 'diesel'));
    const chooser = page.waitForEvent('filechooser'); await page.locator('#cf-photo-choose').click();
    await (await chooser).setFiles({name: 'receipt.png', mimeType: 'image/png', buffer: PNG});
    await page.locator('#cf-date').fill('2026-11-06'); await page.locator('#cf-vehicle').fill('Van'); await page.locator('#cf-vehicle').dispatchEvent('change');
    await page.locator('#cf-liters').fill('30'); await page.locator('#cf-amount').fill('1950'); await page.locator('#cf-driver').fill('Juan');
    await page.locator('#cf-submit').click();
    await page.waitForFunction(() => document.getElementById('cf-rows').textContent.includes('Juan') && !document.getElementById('cf-fields').disabled);
    const fuel = sb.rows.find(r => r.collection === 'companyFuel');
    assert(fuel, 'fuel row written');
    assert.equal(fuel.data.liters, 30);
    assert.match(fuel.data.receipt, /^sb_fuelphoto-/);
    assert(sb.files.has(fuel.data.receipt), 'photo stored under the id the purchase points to');
    assert.deepEqual(sb.files.get(fuel.data.receipt).bytes, PNG);
    const publicUrl = 'https://laxavfldivkhufeubgmb.supabase.co/storage/v1/object/public/receipts/' + fuel.data.receipt;
    await page.locator('[data-fuel-receipt]').first().click();
    await page.waitForFunction(() => { const i = document.getElementById('cf-receipt-image'); return i.complete && i.naturalWidth > 0; });
    assert.equal(await page.locator('#cf-receipt-image').getAttribute('src'), publicUrl, 'photo shown from the receipts bucket');
    assert.equal(await page.locator('#cf-receipt-full').getAttribute('href'), publicUrl);
    await page.locator('#cf-receipt-close').click();

    // 8. Editing bumps the stored revision (optimistic locking is in play), and sign-out returns to the form.
    const before = fuel.revision;
    await page.locator('[data-fuel-edit]').first().click(); await page.locator('#cf-liters').fill('32'); await page.locator('#cf-submit').click();
    await page.waitForFunction(() => document.getElementById('cf-summary').textContent.includes('32'));
    assert.equal(sb.rows.find(r => r.collection === 'companyFuel').revision, before + 1);
    await page.locator('#forgetKeyBtn').evaluate(b => b.click());
    await page.waitForEvent('load');
    await page.locator('#gateLogin').waitFor({state: 'visible'});

    assert.equal(appsScriptCalls, 0, 'nothing goes to Apps Script in Supabase mode');
    assert.deepEqual(errors, []);
    console.log('PASS Supabase login: gate, wrong password, staff/inactive held with sign-out, admin in, session kept on reload, expense/vehicle/fuel saves, receipt photo in bucket, revision bump, sign-out.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
