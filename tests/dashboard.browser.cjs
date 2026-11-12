// The Dashboard ("/", Supabase): the company at a glance from dashboard_overview(), not the Projects and
// Fuel pages stacked. Figures link to the workspace that acts on them; the full project lists and fuel
// stay on /projects and /fuel. If the figures can't load, the dashboard falls back to the project lists.
// The SQL itself is tested in tests/one-record.test.cjs. Needs: node tests/fixtures/serve.cjs
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {createFakeSupabase} = require('./fixtures/fake-supabase.cjs');

const OVERVIEW = {
  leads: {open: 6, unanswered: 2, followups_due: 1},
  stages: {submitted: 1, blocked: 1, overdue: 3},
  stock: {out: 1, low: 2},
  attendance: {in_today: 4, staff: 5, to_check: 1},
  needs_you: [
    {project_id: 'p_seeded000000001', project: 'Uy residence kitchen', stage: 'design', status: 'submitted', who: 'Dina', since: '2026-11-10'},
    {project_id: 'p_seeded000000001', project: 'Uy residence kitchen', stage: 'bom', status: 'blocked', who: '', since: '2026-11-11'}
  ]
};

(async () => {
  let answer = true;
  const sb = createFakeSupabase({rpc: (name, args, u) => name === 'dashboard_overview'
    ? (answer && u && u.role === 'admin' ? {data: OVERVIEW, error: null} : {data: null, error: {code: '42501', message: 'The dashboard is for the admin.'}})
    : {data: null, error: {message: 'unknown function'}}});
  sb.seed('projects', 'p_seeded000000001', {name: 'Uy residence kitchen', status: 'active', budget: 120000, updatedAt: '2026-11-01T00:00:00.000Z'});
  const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    await sb.attach(page);
    await page.addInitScript(() => {
      localStorage.setItem('fake-sb-session', JSON.stringify({access_token: 'token-u-admin', user: {id: 'u-admin', email: 'admin@ritehome.test'}}));
      localStorage.setItem('sb-laxavfldivkhufeubgmb-auth-token', JSON.stringify({user: {id: 'u-admin', email: 'admin@ritehome.test'}}));
    });

    // 1. The overview: one tile per workspace, each linked; what's waiting on the admin listed by project.
    await page.goto('http://127.0.0.1:8000/tracker.html', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !document.getElementById('overviewSection').hidden);
    const tiles = await page.locator('#ovKpis .ov-tile').evaluateAll(a => a.map(t => [t.querySelector('.label').textContent, t.querySelector('.val').textContent, t.querySelector('.sub-line').textContent, t.getAttribute('href')]));
    assert.deepEqual(tiles, [
      ['Leads', '2', 'not answered yet · 6 open', '/leads'],
      ['Schedule', '2', '1 submitted · 1 blocked · 3 late', '/schedule'],
      ['Stock', '3', '1 out · 2 low', '/inventory'],
      ['Attendance today', '4 / 5', '1 punch to check', '/attendance']
    ]);
    assert.equal(await page.locator('#ovKpis .ov-tile.alert').count(), 4, 'each tile with something wrong is marked');
    assert.deepEqual((await page.locator('#ovNeedsList li').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim()), ['Uy residence kitchen · Design Submitted Dina', 'Uy residence kitchen · BOM Blocked']);
    // 2. Not the other pages stacked: the project lists and fuel are on their own pages.
    assert(!await page.locator('#projectGrid').isVisible(), 'project list lives on /projects');
    assert(!await page.locator('#companyFuelCard').isVisible(), 'fuel lives on /fuel');
    assert(!await page.locator('#procurementJobsSection').isVisible());
    assert(await page.locator('#healthSection').isVisible(), 'jobs needing attention stay');
    assert(await page.locator('#arSection').isVisible(), 'who owes us stays');
    assert(!await page.locator('.workspace-actions[data-ui-view="dashboard"]').isVisible(), 'no jump buttons to sections that moved away');
    // 3. Opening a project from "/" still works, and coming back shows the overview again.
    await page.goto('http://127.0.0.1:8000/tracker.html#p=p_seeded000000001', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('projectNameText').textContent === 'Uy residence kitchen');
    // 4. No figures (the call failed): the dashboard keeps the project lists rather than going blank.
    answer = false;
    await page.goto('http://127.0.0.1:8000/tracker.html', {waitUntil: 'domcontentloaded'});
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('projectGrid').textContent.includes('Uy residence kitchen'));
    await page.waitForTimeout(300);
    assert(await page.locator('#overviewSection').isHidden(), 'no empty overview');
    assert(await page.locator('#projectGrid').isVisible(), 'falls back to the project list');
    // 5. The other workspaces don't ask for it.
    answer = true;
    await page.goto('http://127.0.0.1:8000/tracker.html?portal=projects', {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('projectGrid').textContent.includes('Uy residence kitchen'));
    assert(await page.locator('#overviewSection').isHidden());
    assert(await page.locator('#projectGrid').isVisible());
    assert.deepEqual(errors, []);
    console.log('PASS dashboard: overview tiles linked to their workspaces, waiting-on-you list, project lists and fuel moved off "/", falls back to the lists when the figures fail, other workspaces unchanged.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
