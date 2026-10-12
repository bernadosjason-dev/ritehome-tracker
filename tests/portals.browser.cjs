const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createBackend}=require('./fuel.test.cjs');
(async()=>{
 const b=createBackend(),project=b.request({action:'addProject',data:{name:'Client portal project',clientName:'Test Client'}}).id;
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());await page.route('https://script.google.com/**',r=>r.fulfill({json:b.request(r.request().postDataJSON())}));
  await page.goto('http://127.0.0.1:8000/',{waitUntil:'domcontentloaded'});assert.equal(await page.locator('.portal-card').count(),3);assert(!await page.locator('body').innerText().then(s=>s.includes('Client portal project')));
  await page.screenshot({path:'/tmp/ritehome-directory-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/ritehome-directory-mobile.png',fullPage:true});
  await page.getByRole('link',{name:'Open fuel portal'}).click();await page.locator('#gateKey').waitFor();assert.equal(await page.locator('#gateScreen h1').innerText(),'Fuel tracker');
  await page.locator('#gateKey').fill('test-only-key');await page.locator('#gateForm').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>!document.getElementById('cf-fields').disabled);
  assert(await page.locator('#companyFuelCard').isVisible());assert(!await page.locator('#projectGrid').isVisible());assert(!await page.locator('#arSection').isVisible());assert(!await page.locator('#exportBtn').isVisible());assert(await page.locator('#cf-photo-choose').isVisible());
  await page.getByRole('link',{name:'All portals'}).click();await page.getByRole('link',{name:'Open project portal'}).click();await page.waitForFunction(()=>document.getElementById('projectGrid').textContent.includes('Client portal project'));
  assert(!await page.locator('#gateScreen').isVisible(),'access key remembered across portals');assert(!await page.locator('#companyFuelCard').isVisible());assert(await page.locator('#arSection').isVisible());
  await page.locator('#projectGrid .project-card').click();await page.waitForFunction(()=>document.getElementById('projectNameText').textContent==='Client portal project');assert(await page.locator('#expenseCard').isVisible());assert(!await page.locator('#procurementCard').isVisible());
  await page.getByRole('link',{name:'All portals'}).click();await page.getByRole('link',{name:'Open procurement portal'}).click();await page.waitForFunction(()=>document.getElementById('projectGrid').textContent.includes('Client portal project'));assert(!await page.locator('#arSection').isVisible());
  await page.locator('#projectGrid .project-card').click();await page.waitForFunction(()=>!document.getElementById('pr-fields-bom').disabled);assert(await page.locator('#procurementCard').isVisible());assert(!await page.locator('#expenseCard').isVisible());assert(!await page.locator('#figBudget').isVisible());assert(!await page.locator('#printBtn').isVisible());
  assert(page.url().includes('portal=procurement'));
  await page.route('**/tracker.html?check=*',r=>r.fulfill({contentType:'text/html',body:'<script>var PAGE_VERSION = "portal-update-test";</script>'}));
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('#updateReloadBtn').waitFor();await page.unroute('**/tracker.html?check=*');await page.locator('#updateReloadBtn').click();await page.waitForURL('**/tracker.html?portal=procurement&v=portal-update-test#p=*');assert(page.url().includes('portal=procurement'),'version reload preserves portal');
  await page.goto('http://127.0.0.1:8000/#key=test-only-key&p='+project,{waitUntil:'domcontentloaded'});await page.waitForURL('**/tracker.html?portal=projects*');await page.waitForFunction(()=>!location.hash.includes('key='));assert.equal(await page.locator('#projectNameText').innerText(),'Client portal project');
  assert.deepEqual(errors,[]);console.log('PASS portals: directory, phone layout, separate fuel/project/procurement views, shared key, client project selection, legacy share links, key removal and portal-preserving version reload.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
