// portal.ritehomemodular.com routing, served by tests/fixtures/serve.cjs with the live vercel.json rules:
// "/" opens the tracker itself (sign-in when needed, no directory page), the menu moves between short
// addresses (/fuel, /projects, /procurement) with separate views, old long links and bookmarks tidy
// themselves to the short form, share links still open their project, and a version reload keeps the page.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createBackend}=require('./fuel.test.cjs');
const BASE='http://127.0.0.1:8000';
(async()=>{
 const b=createBackend(),project=b.request({action:'addProject',data:{name:'Client portal project',clientName:'Test Client'}}).id;
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await require('./fixtures/sheet-mode.cjs').useSheetBackend(page);
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://script.google.com/**',r=>r.fulfill({json:b.request(r.request().postDataJSON())}));
  const path=()=>new URL(page.url()).pathname+new URL(page.url()).search;
  const go=async name=>{await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('.side-link',{hasText:name}).click()]);};

  // 1. The bare address is the tracker: straight to sign-in, no directory of portals.
  await page.goto(BASE+'/',{waitUntil:'domcontentloaded'});
  await page.locator('#gateKey').waitFor();
  assert.equal(await page.locator('.portal-card').count(),0,'no directory page');
  assert.equal(path(),'/');
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/ritehome-root-mobile.png'});await page.setViewportSize({width:1440,height:1000});
  await page.locator('#gateKey').fill('test-only-key');await page.locator('#gateForm').evaluate(f=>f.requestSubmit());
  await page.waitForFunction(()=>((document.getElementById('projectGrid')||{}).textContent||'').includes('Client portal project'));
  assert.equal(await page.locator('.side-link[aria-current="page"]').innerText(),'Dashboard');
  assert.deepEqual(await page.locator('a.side-link').evaluateAll(a=>a.map(x=>x.getAttribute('href'))),['/','/leads','/projects','/schedule','/attendance','/procurement','/inventory','/fuel','/accounting','/team']);

  // 2. Fuel, by the menu: short address, fuel only.
  await go('Company fuel');assert.equal(path(),'/fuel');
  await page.waitForFunction(()=>!(document.getElementById('cf-fields')||{disabled:true}).disabled);
  assert.equal(await page.title(),'Fuel tracker · Ritehome');
  assert(await page.locator('#companyFuelCard').isVisible());assert(!await page.locator('#projectGrid').isVisible());assert(!await page.locator('#arSection').isVisible());assert(!await page.locator('#exportBtn').isVisible());assert(await page.locator('#cf-photo-choose').isVisible());
  assert(!await page.locator('#gateScreen').isVisible(),'access key remembered across workspaces');

  // 3. Projects.
  await go('Projects');assert.equal(path(),'/projects');
  await page.waitForFunction(()=>((document.getElementById('projectGrid')||{}).textContent||'').includes('Client portal project'));
  assert(!await page.locator('#companyFuelCard').isVisible());assert(await page.locator('#arSection').isVisible());
  await page.locator('#projectGrid .project-card').click();await page.waitForFunction(()=>document.getElementById('projectNameText').textContent==='Client portal project');
  // The project opens on Overview (health header + tabs); each tab shows one section.
  assert(await page.locator('#figProjected').isVisible());assert(await page.locator('#recentCard').isVisible());assert(!await page.locator('#expenseCard').isVisible());
  assert.deepEqual(await page.locator('#projectTabs button:visible').allInnerTexts(),['Overview','Expenses','Billing','Labor','Details'],'no Procurement tab in the projects workspace');
  await page.locator('[data-ptab-btn="expenses"]').click();assert(await page.locator('#expenseCard').isVisible());assert(!await page.locator('#recentCard').isVisible());
  await page.locator('[data-ptab-btn="billing"]').click();assert(await page.locator('#billingBody').isVisible());assert(!await page.locator('#expenseCard').isVisible());
  await page.locator('[data-ptab-btn="overview"]').click();await page.locator('#addExpenseBtn').click();assert(await page.locator('#expenseCard').isVisible());assert.equal(await page.evaluate(()=>document.activeElement.id),'f-item');
  assert(!await page.locator('#procurementCard').isVisible());

  // 4. Procurement: its own jobs, never general projects.
  await go('Procurement');assert.equal(path(),'/procurement');
  await page.waitForFunction(()=>!(document.getElementById('pj-start')||{disabled:true}).disabled);assert(!await page.locator('#arSection').isVisible());assert(!await page.locator('#projectGrid').isVisible());assert(!await page.locator('#procurementJobsSection').innerText().then(s=>s.includes('Client portal project')));assert.match(await page.locator('#pj-list').innerText(),/Start your first procurement job/);
  await page.locator('#pj-start').click();await page.locator('#pj-name').fill('Kitchen procurement job');await page.locator('#pj-client').fill('Procurement client');await page.locator('#pj-submit').click();await page.waitForFunction(()=>!(document.getElementById('pr-fields-bom')||{disabled:true}).disabled);
  assert.equal(b.request({action:'listProjects'}).projects.length,1,'creating a procurement job does not create a general project');
  assert.equal(b.request({action:'listProcurementJobs'}).jobs.length,1);assert(await page.locator('#procurementCard').isVisible());assert(!await page.locator('#expenseCard').isVisible());assert(!await page.locator('#figBudget').isVisible());assert(!await page.locator('#printBtn').isVisible());
  assert.equal(new URL(page.url()).pathname,'/procurement');assert.match(await page.locator('#pr-next-step').innerText(),/Add your first BOM/);

  // 5. A new version: the reload stays on this page and this job, and the address stays short.
  await page.route(/[?]check=/,r=>r.fulfill({contentType:'text/html',body:'<script>var PAGE_VERSION = "portal-update-test";</script>'}));
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('#updateReloadBtn').waitFor();await page.unroute(/[?]check=/);
  await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('#updateReloadBtn').click()]);
  await page.waitForFunction(()=>location.pathname==='/procurement'&&!location.search&&/^#p=/.test(location.hash));

  // 6. Old long links and bookmarks (like tracker.html?portal=fuel&v=...) open the same page and tidy themselves.
  await page.goto(BASE+'/tracker.html?portal=fuel&v=2026-11-11.5',{waitUntil:'domcontentloaded'});
  assert.equal(path(),'/fuel');await page.waitForFunction(()=>!(document.getElementById('cf-fields')||{disabled:true}).disabled);
  await page.goto(BASE+'/index.html',{waitUntil:'domcontentloaded'});assert.equal(path(),'/');
  await page.goto(BASE+'/fuel/',{waitUntil:'domcontentloaded'});assert.equal(path(),'/fuel');

  // 7. An old share link with a key and a project still opens that project, and the key leaves the address.
  await page.goto(BASE+'/#key=test-only-key&p='+project,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!location.hash.includes('key='));await page.waitForFunction(()=>document.getElementById('projectNameText').textContent==='Client portal project');

  assert.deepEqual(errors,[]);console.log('PASS portals: "/" is the tracker (no directory), short addresses per workspace, separate views, shared key, long links and bookmarks tidied, share links, version reload keeps the page.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
