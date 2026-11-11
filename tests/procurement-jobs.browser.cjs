const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createBackend}=require('./fuel.test.cjs');
(async()=>{
 const b=createBackend(),general=b.request({action:'addProject',data:{name:'General project that must not appear',status:'completed',price:100000,totalSpent:104172}}).id;
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],actions=[];let loseJobReply=true;page.on('pageerror',e=>errors.push(e.message));
  await require('./fixtures/sheet-mode.cjs').useSheetBackend(page);
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.route('https://script.google.com/**',async r=>{const req=r.request().postDataJSON();actions.push(req.action);const res=b.request(req);if(req.action==='saveProcurementJob'&&loseJobReply){loseJobReply=false;return r.abort();}return r.fulfill({json:res});});
  await page.goto('http://127.0.0.1:8000/tracker.html?portal=procurement',{waitUntil:'domcontentloaded'});await page.locator('#gateKey').fill('test-only-key');await page.locator('#gateForm').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>!document.getElementById('pj-start').disabled);
  assert(!actions.includes('listProjects'),'procurement does not request general projects');assert(!await page.locator('#dashboardScreen').innerText().then(s=>s.includes('General project that must not appear')));assert(!await page.locator('#newProjectToggle').isVisible());
  await page.locator('#procurementJobsSection').screenshot({path:'/tmp/independent-procurement-empty.png'});
  await page.locator('#pj-start').click();await page.locator('#pj-name').fill('Banisilan materials');await page.locator('#pj-client').fill('Client purchasing');await page.locator('#pj-submit').click();await page.waitForFunction(()=>!document.getElementById('pr-fields-bom').disabled&&document.getElementById('projectNameText').textContent==='Banisilan materials');
  const job=b.request({action:'listProcurementJobs'}).jobs[0];assert.equal(b.request({action:'listProcurementJobs'}).jobs.length,1,'lost response retry creates one job');assert.equal(b.request({action:'listProjects'}).projects.length,1);
  await page.locator('[data-pr-start="bom"]').click();assert(await page.locator('#pr-bom-name').isVisible());await page.locator('#pr-bom-name').fill('BOM 01');await page.locator('#pr-paste').fill('Plywood\t18mm\tsheets\t24');await page.locator('#pr-paste-add').click();await page.locator('#pr-bom-form').evaluate(f=>f.requestSubmit());await page.locator('[data-pr-start="po"]').waitFor();
  await page.locator('[data-pr-start="po"]').click();await page.locator('#pr-po-ref').fill('PO-001');await page.locator('#pr-po-supplier').fill('Supplier A');await page.locator('#pr-po-state').selectOption('confirmed');await page.locator('#pr-po-add-row').click();const item=b.request({action:'getProcurement',projectId:job.id}).data.boms[0].items[0].id;await page.locator('#pr-po-items [data-field="itemId"]').selectOption(item);await page.locator('#pr-po-items [data-field="quantity"]').fill('16');await page.locator('#pr-po-form').evaluate(f=>f.requestSubmit());await page.locator('[data-pr-start="summary"]').waitFor();
  assert.equal((await page.locator('#pr-summary tr td').allTextContents())[7],'8');assert.equal(b.request({action:'getProject',id:general}).project.price,100000);
  await page.locator('#backBtn').click();await page.waitForFunction(()=>!document.getElementById('dashboardScreen').hidden);assert(await page.locator('[data-pj-open]').isVisible());assert(!await page.locator('#dashboardScreen').innerText().then(s=>s.includes('Profit')));
  await page.locator('[data-pj-edit]').click();await page.locator('#pj-state').selectOption('completed');await page.locator('#pj-submit').click();await page.waitForFunction(()=>document.getElementById('pj-list').textContent.includes('Closed')&&!document.getElementById('pj-fields').disabled);
  assert.equal(b.request({action:'getProject',id:general}).project.name,'General project that must not appear');assert.equal(b.request({action:'getProcurementJob',id:job.id}).project.status,'completed');
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.getElementById('pj-list').textContent.includes('Banisilan materials'));
  assert(!await page.locator('#pj-steps').isVisible(),'first-time instructions collapse once jobs exist');
  
  // Delete: a plain job goes with its BOMs and POs after a confirmation; a job with deliveries is refused with the reason.
  const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());d.accept();});
  const waitDialogs=async n=>{for(let i=0;i<100&&dialogs.length<n;i++)await page.waitForTimeout(100);assert(dialogs.length>=n,'expected '+n+' dialogs, got '+JSON.stringify(dialogs));};
  await page.locator('#pj-start').click();await page.locator('#pj-name').fill('Example');await page.locator('#pj-client').fill('Oliver');await page.locator('#pj-submit').click();
  await page.waitForFunction(()=>!document.getElementById('projectScreen').hidden);await page.locator('#backBtn').click();
  await page.waitForFunction(()=>document.getElementById('pj-list').textContent.includes('Example')&&!document.getElementById('pj-fields').disabled);
  const example=b.request({action:'listProcurementJobs'}).jobs.find(j=>j.name==='Example');assert(example,'Example job created');
  await page.locator('[data-pj-delete="'+example.id+'"]').click();await waitDialogs(1);assert.match(dialogs[0],/Delete the procurement job “Example”\?/);
  await page.waitForFunction(()=>!document.getElementById('pj-list').textContent.includes('Example')&&!document.getElementById('pj-fields').disabled);
  assert(!b.request({action:'listProcurementJobs'}).jobs.some(j=>j.id===example.id),'Example deleted on the server');
  const delivered=b.request({action:'getProcurement',projectId:job.id}).data.orders.some(o=>o.lines.some(l=>l.received>0));
  if(!delivered)b.request({action:'saveProcurement',projectId:job.id,revision:b.request({action:'getProcurement',projectId:job.id}).revision,mutationId:'pr-delete-test-0001',data:(d=>{d.orders[0].lines[0].received=1;return d;})(b.request({action:'getProcurement',projectId:job.id}).data)});
  await page.locator('[data-pj-delete="'+job.id+'"]').click();await waitDialogs(3);assert.match(dialogs[2],/deliveries recorded/);
  assert(b.request({action:'getProcurementJob',id:job.id}).project,'a job with deliveries is kept');
  await page.waitForFunction(()=>document.getElementById('pj-list').textContent.includes('Banisilan materials')&&!document.getElementById('pj-fields').disabled);
  await page.locator('#procurementJobsSection').screenshot({path:'/tmp/independent-procurement-list.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  console.log('PASS independent procurement: no general-project reads/cards, guided job creation, lost-response deduplication, first BOM/PO actions, 8 remaining sheets, independent closing and reload persistence.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
