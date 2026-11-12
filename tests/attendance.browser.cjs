// attendance.html end to end on a throwaway local PostgreSQL: notice, reference photo, clock-in with the
// (fake) camera and a GPS fix, an off-site punch with no face, then the admin's review, reset and month.
// The face template is a stand-in here (a headless browser has no face); the last step loads the real
// vendored library and models to prove they run. Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');
const {startLocalPg} = require('./fixtures/local-pg.cjs');
const {pgRpc} = require('./fixtures/pg-rpc.cjs');

const db = startLocalPg();
const OFFICE = {latitude: 8.500563, longitude: 124.622937, accuracy: 12}, SITE = {latitude: 8.4542, longitude: 124.6319, accuracy: 18};
const FACE = Array.from({length: 128}, (_, i) => ((i * 37) % 11) / 40);
(async () => {
  const {U, must} = db;
  must('super', `insert into auth.users (id, email, raw_user_meta_data) values ('${U.admin}', 'owner@example.com', '{"full_name":"Jason"}'),
    ('${U.designer}', 'dina@example.com', '{"full_name":"Dina"}');
    update public.profiles set role = 'admin', active = true, full_name = 'Jason' where id = '${U.admin}';
    update public.profiles set role = 'designer', active = true, full_name = 'Dina' where id = '${U.designer}';`);
  const sb = createFakeSupabase({rpc: pgRpc(db)});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']});
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}, permissions: ['camera', 'geolocation'], geolocation: OFFICE});
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await page.addInitScript(() => { window.__face = null; window.RitehomeFaceStub = {describe: async () => window.__face}; });
    await sb.attach(page);
    const setSession = id => page.evaluate(id => localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-' + id, user: {id, email: id + '@ritehome.test'}})), id);
    const msg = t => page.waitForFunction(t => new RegExp(t).test(document.getElementById('acctMsg').textContent), t, {timeout: 10000}).catch(async e => { throw new Error('waiting for "' + t + '", page says: ' + await page.locator('#acctMsg').innerText()); });
    const shoot = async () => { await page.waitForFunction(() => document.getElementById('camVideo').videoWidth > 0); await page.locator('#camShoot').click(); };
    const status = () => page.locator('#camStatus').innerText();

    // 1. Dina: the notice first, then a reference photo that needs a face.
    await page.goto('http://127.0.0.1:8000/attendance', {waitUntil: 'domcontentloaded'});
    await setSession('u-designer'); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('app').hidden);
    assert.equal(await page.locator('.side-link[aria-current="page"]').innerText(), 'Attendance');
    assert(await page.locator('#noticeCard').isVisible() && await page.locator('#todayCard').isHidden() && await page.locator('#attTabs').isHidden());
    assert.match(await page.locator('#noticeCard').innerText(), /never followed between punches[\s\S]*deleted after 90 days/);
    await page.locator('#noticeAccept').click();
    await page.locator('#enrollCard').waitFor();
    await page.locator('#enrollBtn').click();
    await shoot();
    await page.waitForFunction(() => /No face found/.test(document.getElementById('camStatus').textContent));
    assert.equal(await page.locator('#camUse').isDisabled(), true, 'a reference photo needs a face');
    await page.locator('#camRetake').click();
    await page.evaluate(f => { window.__face = f; }, FACE);
    await shoot();
    await page.waitForFunction(() => /Face found/.test(document.getElementById('camStatus').textContent));
    await page.locator('#camUse').click();
    await msg('Reference photo saved');
    await page.locator('#todayCard').waitFor();

    // 2. Clock in at the office: photo, location, time from the server.
    const first = await page.locator('#punchKind').inputValue();
    await page.locator('#punchBtn').click();
    await page.waitForFunction(() => /Location found, within 12 m/.test(document.getElementById('camStatus').textContent));
    await shoot();
    await page.waitForFunction(() => /Face found/.test(document.getElementById('camStatus').textContent));
    await page.locator('#camUse').click();
    await msg('recorded at \\d');
    await page.waitForFunction(k => /\d/.test(document.querySelector(`.slot[data-kind="${k}"] .t`).textContent), first);
    const p1 = JSON.parse(must('super', `select row_to_json(p) from public.attendance_punches p where kind = '${first}'`));
    assert.ok(p1.face_match > 0.99 && p1.office_distance_m < 5 && !p1.flags.includes('off_site') && !p1.flags.includes('no_face_check'), JSON.stringify(p1.flags));
    assert.ok(sb.files.has('selfie:' + p1.selfie_path) && sb.files.get('selfie:' + p1.selfie_path).bytes.length > 500, 'the photo was stored');

    // 3. Next punch from a client's site, face not found: it still goes through, and says what was flagged.
    await context.setGeolocation(SITE);
    await page.evaluate(() => { window.__face = null; });
    const second = await page.locator('#punchKind').inputValue();
    assert.notEqual(second, first);
    await page.locator('#punchBtn').click();
    await page.waitForFunction(() => /Location found/.test(document.getElementById('camStatus').textContent));
    await shoot();
    await page.waitForFunction(() => /the admin will check this photo/.test(document.getElementById('camStatus').textContent));
    await page.locator('#camUse').click();
    await msg('5\\.\\d km from the office, the admin will check the photo');
    assert.match(await page.locator(`.slot[data-kind="${second}"]`).innerText(), /Off site · 5\.\d km[\s\S]*Photo to be checked/);

    // 4. The admin: the day, the photo beside the reference, checked with a note.
    await setSession('u-admin'); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('app').hidden && !document.getElementById('attTabs').hidden);
    await page.locator('#attTabs [data-tab="team"]').click();
    await page.locator('#teamTable tr[data-person="Dina"]').waitFor();
    assert.match(await page.locator('#teamKpis').innerText(), /Photos to check\s+1[\s\S]*Clocked in\s+1 of 2[\s\S]*Off site\s+1/i);
    assert.match(await page.locator('#teamTable tr[data-person="Dina"]').innerText(), /Face not checked/);
    await page.getByRole('button', {name: /Dina .* photo/}).filter({hasText: 'Check photo'}).click();
    await page.waitForFunction(() => { const i = document.querySelectorAll('#lookBox img'); return i.length === 2 && [...i].every(x => x.naturalWidth > 0); });
    assert.match(await page.locator('#lookBox').innerText(), /Face\s+Not checked[\s\S]*5\.\d km from the office, GPS within 18 m/);
    await page.getByLabel('Review note').fill('At the Navales site');
    await page.locator('#lookBox').getByRole('button', {name: 'Mark as checked'}).click();
    await msg("Dina's .* is checked");
    await page.waitForFunction(() => /Photos to check\s*0/i.test(document.getElementById('teamKpis').textContent));
    assert.equal(must('super', `select admin_note from public.attendance_punches where kind = '${second}'`), 'At the Navales site');

    // 5. The month, and resetting a reference photo.
    await page.locator('#attTabs [data-tab="month"]').click();
    await page.waitForFunction(() => /Dina/.test(document.getElementById('monthTable').textContent), null, {timeout: 8000}).catch(async e => { throw new Error('month: ' + await page.locator('#acctMsg').innerText() + ' / ' + await page.locator('#monthPick').inputValue()); });
    assert.match(await page.locator('#monthTable tbody tr', {hasText: 'Dina'}).innerText(), /Dina · Designer\s+1\s+\d+\.\d\d/);
    await page.locator('#attTabs [data-tab="team"]').click();
    await page.getByRole('button', {name: "Reset Dina's reference photo"}).click();
    await msg("Dina's reference photo is reset");
    assert.equal(must('super', `select (face_descriptor is null)::text from public.profiles where id = '${U.designer}'`), 'true');

    // 6. Phone width.
    await page.screenshot({path: '/tmp/ritehome-attendance-team.png', fullPage: true});
    await setSession('u-designer'); await page.setViewportSize({width: 390, height: 844}); await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('app').hidden);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll on a phone');
    await page.evaluate(f => { window.__face = f; }, FACE);
    await page.locator('#enrollBtn').click(); await shoot();
    await page.waitForFunction(() => /Face found/.test(document.getElementById('camStatus').textContent));
    await page.locator('#camUse').click(); await msg('Reference photo saved');
    await page.screenshot({path: '/tmp/ritehome-attendance-phone.png', fullPage: true});
    assert.deepEqual(errors, []);

    // 7. The real face library and its models load and run (no face on a blank canvas: null, not an error).
    const real = await context.newPage(); const realErrors = [];
    real.on('pageerror', e => realErrors.push(e.message));
    await real.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(real);
    await real.goto('http://127.0.0.1:8000/attendance', {waitUntil: 'domcontentloaded'});
    await real.waitForFunction(() => !document.getElementById('app').hidden);
    const found = await real.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 240; const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, 320, 240);
      const d = await window.RitehomeAttendance.describe(c);
      return {d, nets: ['tinyFaceDetector', 'faceLandmark68TinyNet', 'faceRecognitionNet'].map(n => window.faceapi.nets[n].isLoaded)};
    });
    assert.deepEqual(found, {d: null, nets: [true, true, true]});
    assert.deepEqual(realErrors, []);

    console.log('PASS attendance: notice, reference photo needs a face, clock-in with photo + GPS scored in the database, off-site punch without a face flagged, admin checks the photo beside the reference, month, reset, phone width, real face library loads and runs.');
  } finally { await browser.close(); db.stop(); }
})().catch(e => { console.error(e); db.stop(); process.exit(1); });
