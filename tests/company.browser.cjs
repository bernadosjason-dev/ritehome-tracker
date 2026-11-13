// Company profile end to end (company.html): every database call answered by the real SQL on a throwaway
// local PostgreSQL, and every upload checked against the real storage policies there (bucket
// company-files). Sign-in by fake-supabase.cjs. Covers the storage rules in AGENTS.md: success, a refused
// upload, an oversized file, a failed save retried without uploading twice, entries kept on failure.
// It does not prove the live bucket: see MEMORY.md / AGENTS.md for the live storage check.
// Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

(async () => {
  const {U, must} = db;
  U.book = '00000000-0000-4000-8000-000000000007';
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.book}', 'bea@example.com', '{"full_name":"Bea Bookkeeper"}'), ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'bookkeeper', active = true, full_name = 'Bea Bookkeeper' where id = '${U.book}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';`);
  const actors = {'u-admin': 'admin', 'u-designer': 'designer', 'u-book': 'book'};
  const real = pgRpc(db, actors);
  let failNextSave = false, refuseNextUpload = false, uploads = 0;
  const rpc = (name, args, u) => {
    if (name === 'company_document_save' && failNextSave) { failNextSave = false; return {data: null, error: {message: 'Failed to fetch'}}; }
    return real(name, args, u);
  };
  const upload = (bucket, path, u, bytes, type) => {
    if (bucket !== 'company-files') return null;
    uploads++;
    if (refuseNextUpload) { refuseNextUpload = false; return {data: null, error: {statusCode: '403', message: 'new row violates row-level security policy'}}; }
    if (bytes.length > 10485760) return {data: null, error: {statusCode: '413', message: 'The object exceeded the maximum allowed size'}};
    const r = db.sql(u && actors[u.id] ? actors[u.id] : 'anon', `insert into storage.objects (bucket_id, name) values ('company-files', '${path.replace(/'/g, "''")}')`);
    return r.ok ? {data: {path}, error: null} : {data: null, error: {statusCode: '403', message: 'new row violates row-level security policy'}};
  };
  const sb = createFakeSupabase({rpc, upload, users: [{id: 'u-book', email: 'book@ritehome.test', password: 'x', role: 'bookkeeper', active: true}]});
  const objects = () => Number(must('super', `select count(*) from storage.objects where bucket_id = 'company-files'`));
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    // Signed links: on this tab (ahead of the stand-in's catch-all) and on tabs it opens.
    const signedFile = r => r.fulfill({contentType: 'image/png', body: PNG});
    await page.context().route('https://laxavfldivkhufeubgmb.supabase.co/storage/v1/object/sign/company-files/**', signedFile);
    await sb.attach(page);
    await page.route('https://laxavfldivkhufeubgmb.supabase.co/storage/v1/object/sign/company-files/**', signedFile);
    const as = async (id, url, ready = true) => {
      await page.goto('http://127.0.0.1:8000' + url, {waitUntil: 'domcontentloaded'});
      await page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
      await page.reload({waitUntil: 'domcontentloaded'});
      if (ready) await page.waitForFunction(() => !document.getElementById('app').hidden);
    };
    const error = () => page.locator('#docError').innerText();

    // 1. The bookkeeper: "/" sends them to the company profile; the menu has it under Office and finance.
    await as('u-book', '/', false);
    await page.waitForURL('**/company'); await page.waitForFunction(() => !document.getElementById('app').hidden);
    assert.deepEqual(await page.locator('a.side-link:visible').evaluateAll(a => a.map(x => x.textContent)), ['Approvals', 'Schedule', 'Company profile', 'Attendance']);
    assert.equal(await page.locator('[data-f="legal_name"]').inputValue(), 'Ritehome Modular Systems');
    assert.equal(await page.locator('#profSave').isDisabled(), true, 'Save is quiet until something changes');

    // 2. Details and an authorised person; a bad email is refused and nothing typed is lost.
    await page.locator('[data-f="address"]').fill('Cagayan de Oro City');
    await page.locator('[data-f="email"]').fill('not-an-email');
    await page.locator('#authAdd').click();
    await page.locator('.co-auth-row [data-a="name"]').fill('Owner Name'); await page.locator('.co-auth-row [data-a="position"]').fill('Proprietor');
    await page.locator('#profSave').click();
    await page.waitForFunction(() => /Check the email/.test(document.getElementById('profError').textContent));
    assert.equal(await page.locator('[data-f="address"]').inputValue(), 'Cagayan de Oro City', 'entries kept');
    await page.locator('[data-f="email"]').fill('hello@example.com');
    await page.locator('#profSave').click();
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Company details saved.');
    assert.equal(must('super', `select address || '|' || email || '|' || (authorized -> 0 ->> 'name') from public.company_profile`), 'Cagayan de Oro City|hello@example.com|Owner Name');

    // 3. Documents: an oversized file never leaves the browser; a refused upload and a failed save keep the form.
    await page.locator('#docAddBtn').click();
    await page.locator('#dFile').setInputFiles({name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(10485761)});
    await page.locator('#dTitle').fill("Mayor's permit 2026");
    const before = uploads;
    await page.locator('#docSave').click();
    await page.waitForFunction(() => /the limit is 10 MB/.test(document.getElementById('docError').textContent));
    assert.equal(uploads, before, 'not uploaded');
    await page.locator('#dFile').setInputFiles({name: 'mayors-permit.pdf', mimeType: 'application/pdf', buffer: PDF});
    const soon = must('super', `select ((now() at time zone 'Asia/Manila')::date + 10)::text`);
    await page.locator('#dExpires').fill(soon);
    refuseNextUpload = true;
    await page.locator('#docSave').click();
    await page.waitForFunction(() => /can't upload company files/.test(document.getElementById('docError').textContent));
    assert.match(await error(), /Nothing you entered was lost/);
    assert.equal(await page.locator('#dTitle').inputValue(), "Mayor's permit 2026"); assert.equal(objects(), 0);
    failNextSave = true;
    await page.locator('#docSave').click();
    await page.waitForFunction(() => /Failed to fetch/.test(document.getElementById('docError').textContent));
    assert.equal(objects(), 1, 'the file arrived; the register entry did not');
    await page.locator('#docSave').click();
    await page.waitForFunction(() => /added to the register/.test(document.getElementById('acctMsg').textContent));
    assert.equal(objects(), 1, 'the retry reused the uploaded file');
    assert.match(await page.locator('.co-doc').innerText(), /Mayor's permit 2026[\s\S]*Expires in 10 days[\s\S]*Mayor's \/ business permit · mayors-permit\.pdf · added by Bea Bookkeeper/);
    assert.equal(await page.locator('#coTitle').innerText(), '1 document expires within 30 days');
    assert.equal(await page.locator('.co-doc button', {hasText: 'Remove'}).count(), 0, 'only the admin removes');
    // Edit the expiry; open the file through a signed link.
    await page.locator('.co-doc button', {hasText: 'Edit'}).click();
    await page.locator('.co-doc.editing input[type="date"]').fill('2027-12-31');
    await page.locator('.co-doc.editing button', {hasText: 'Save'}).click();
    await page.waitForFunction(() => /Valid until Dec 31, 2027/.test(document.querySelector('.co-doc').textContent));
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.co-doc button', {hasText: 'Open'}).click()]);
    await popup.waitForURL(/\/storage\/v1\/object\/sign\/company-files\/documents\/[0-9a-f-]{36}\.pdf/); await popup.close();

    // 4. The logo: uploaded, saved on the profile, shown from its signed link.
    await page.locator('#logoFile').setInputFiles({name: 'logo.png', mimeType: 'image/png', buffer: PNG});
    await page.waitForFunction(() => document.getElementById('acctMsg').textContent === 'Logo saved.');
    await page.waitForFunction(() => { const i = document.querySelector('#logoBox img'); return i && i.complete && i.naturalWidth > 0; });
    assert.match(must('super', `select logo_path from public.company_profile`), /^logo\/[0-9a-f-]{36}\.png$/);

    // 5. The admin removes the document (archived, file kept); the designer is turned away.
    await as('u-admin', '/company');
    await page.locator('.co-doc button', {hasText: 'Remove'}).click();
    await page.waitForFunction(() => /removed\./.test(document.getElementById('acctMsg').textContent));
    assert.equal(await page.locator('.co-doc').count(), 0);
    assert.equal(must('super', `select count(*) from public.company_documents where archived_at is not null`), '1'); assert.equal(objects(), 2);
    await as('u-designer', '/company', false);
    await page.waitForFunction(() => !document.getElementById('gate').hidden && /for the admin and the bookkeeper/.test(document.getElementById('gateTitle').textContent));
    assert.equal(await page.locator('a.side-link', {hasText: 'Company profile'}).isHidden(), true);

    // 6. Phone width: no sideways scroll.
    await as('u-book', '/company');
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS company: bookkeeper lands on it, details + authorised people saved, bad email refused with entries kept; documents: oversized file stopped in the browser, refused upload and failed save keep the form, retry reuses the file, expiry shown, edit, signed open; logo; admin archives; designer turned away; phone width.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
