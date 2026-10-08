const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createBackend}=require('./fuel.test.cjs');
(async()=>{
 const b=createBackend(),project=b.request({action:'addProject',data:{name:'Procurement test client'}}).id;
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage();const errors=[];let loseSave=false;let loseSaveCount=0;page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.route('https://script.google.com/**',async r=>{const req=r.request().postDataJSON();const result=b.request(req);if(req.action==='saveProcurement'&&loseSaveCount>0){loseSaveCount--;return r.abort();}if(req.action==='saveProcurement'&&loseSave){loseSave=false;return r.abort();}await r.fulfill({json:result});});
  await page.goto('http://127.0.0.1:8000/#p='+project,{waitUntil:'domcontentloaded'});
  await page.locator('#gateKey').fill('test-only-key');await page.locator('#gateForm').evaluate(f=>f.requestSubmit());
  await page.waitForFunction(()=>!document.getElementById('pr-fields-bom').disabled);
  async function addBom(name,text){await page.locator('#pr-bom-details').evaluate(e=>e.open=true);await page.locator('#pr-bom-name').fill(name);await page.locator('#pr-bom-draftsman').fill('Draftsman');await page.locator('#pr-paste').fill(text);await page.locator('#pr-paste-add').click();await page.locator('#pr-bom-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(name=>document.getElementById('pr-boms').textContent.includes(name)&&!document.getElementById('pr-fields-bom').disabled,name);}
  loseSave=true;await addBom('BOM 01','Plywood\t18mm 4x8\tsheets\t24');
  assert.equal(b.request({action:'getProcurement',projectId:project}).revision,1,'lost response retry is idempotent');
  await addBom('BOM 02','Plywood\t18mm 4x8\tsheets\t10');
  for(let n=3;n<=5;n++)await addBom('BOM 0'+n,'Hardware '+n+'\tHinge\tpcs\t2');
  let snapshot=b.request({action:'getProcurement',projectId:project});assert.equal(snapshot.data.boms.length,5);
  const first=snapshot.data.boms[0],itemId=first.items[0].id;
  assert.equal(await page.locator('#pr-summary tr').count(),4,'same material combined across BOMs');
  assert.match(await page.locator('#pr-summary tr').first().innerText(),/34/);
  await page.locator('#pr-filter').selectOption(first.id);assert.equal(await page.locator('#pr-summary tr').count(),1);
  async function po(reference,supplier,quantity,status,received=0){await page.locator('#pr-po-details').evaluate(e=>e.open=true);await page.locator('#pr-po-ref').fill(reference);await page.locator('#pr-po-supplier').fill(supplier);await page.locator('#pr-po-state').selectOption(status);await page.locator('#pr-po-add-row').click();await page.locator('#pr-po-items [data-field="itemId"]').selectOption(itemId);await page.locator('#pr-po-items [data-field="quantity"]').fill(String(quantity));await page.locator('#pr-po-items [data-field="received"]').fill(String(received));await page.locator('#pr-po-items [data-field="unitPrice"]').fill('1000');await page.locator('#pr-po-form').evaluate(f=>f.requestSubmit());}
  await po('PO-A','Supplier A',16,'confirmed');await page.waitForFunction(()=>document.getElementById('pr-orders').textContent.includes('Supplier A')&&!document.getElementById('pr-fields-po').disabled);
  let cells=await page.locator('#pr-summary tr td').allTextContents();assert.equal(cells[7],'8');assert.equal(cells[8],'8');
  await po('PO-B','Supplier B',9,'requested');await page.waitForFunction(()=>document.getElementById('pr-status').textContent.includes('exceed'));
  assert.equal(await page.locator('#pr-po-ref').inputValue(),'PO-B','invalid PO form retained');await page.locator('#pr-po-items [data-field="quantity"]').fill('8');await page.locator('#pr-po-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>document.getElementById('pr-orders').textContent.includes('Supplier B')&&!document.getElementById('pr-fields-po').disabled);
  cells=await page.locator('#pr-summary tr td').allTextContents();assert.equal(cells[4],'8');assert.equal(cells[7],'8');assert.equal(cells[8],'0');
  snapshot=b.request({action:'getProcurement',projectId:project});const secondPO=snapshot.data.orders[1];
  await page.locator('[data-pr-po="'+secondPO.id+'"]').click();await page.locator('#pr-po-state').selectOption('confirmed');await page.locator('#pr-po-items [data-field="received"]').fill('8');await page.locator('#pr-po-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>document.getElementById('pr-fields-po').disabled===false&&!document.getElementById('pr-po-ref').value);
  cells=await page.locator('#pr-summary tr td').allTextContents();assert.equal(cells[5],'24');assert.equal(cells[6],'8');assert.equal(cells[7],'0');assert.equal(cells[9],'16');
  await page.locator('[data-pr-po="'+secondPO.id+'"]').click();await page.locator('#pr-po-state').selectOption('cancelled');await page.locator('#pr-po-items [data-field="received"]').fill('0');await page.locator('#pr-po-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>document.getElementById('pr-status').textContent.includes('cannot be removed or cancelled'));
  await page.locator('#pr-po-state').selectOption('confirmed');await page.locator('#pr-po-items [data-field="received"]').fill('8');
  snapshot=b.request({action:'getProcurement',projectId:project});snapshot.data.orders[0].notes='Changed by officer two';assert.equal(b.request({action:'saveProcurement',projectId:project,revision:snapshot.revision,mutationId:'pr-00000000-0000-4000-8000-000000000099',data:snapshot.data}).ok,true);
  await page.locator('#pr-po-notes').fill('Delivery Friday');await page.locator('#pr-po-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>document.getElementById('pr-status').textContent.includes('Another officer'));
  assert.equal(await page.locator('#pr-po-notes').inputValue(),'Delivery Friday');await page.locator('#pr-refresh').click();await page.waitForFunction(()=>document.getElementById('pr-status').textContent==='Procurement synced.');await page.locator('#pr-po-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>!document.getElementById('pr-fields-po').disabled&&!document.getElementById('pr-po-ref').value);
  snapshot=b.request({action:'getProcurement',projectId:project});assert.equal(snapshot.data.orders[0].notes,'Changed by officer two');assert.equal(snapshot.data.orders[1].notes,'Delivery Friday');
  const download=page.waitForEvent('download');await page.locator('#pr-export').click();const file=await download;const csv=require('fs').readFileSync(await file.path(),'utf8');assert(csv.includes('Still to procure'));assert(csv.includes('BOM 01'));assert(!csv.includes('BOM 02'));
  const backupPromise=page.waitForEvent('download');await page.locator('#pr-backup').click();const backupFile=await backupPromise;const backup=JSON.parse(require('fs').readFileSync(await backupFile.path(),'utf8'));assert.equal(backup.data.boms.length,5);assert.equal(backup.data.orders.length,2);assert.equal(backup.projectId,project);
  const popup=page.waitForEvent('popup');await page.locator('[data-pr-print]').first().click();const printed=await popup;await printed.waitForLoadState('domcontentloaded');assert.match(await printed.locator('body').innerText(),/Supplier A/);assert.match(await printed.locator('body').innerText(),/16 sheets/);await printed.close();
  await page.setViewportSize({width:390,height:844});assert(await page.locator('#pr-summary').isVisible());await page.locator('#procurementCard').screenshot({path:'/tmp/procurement-mobile.png'});
  await page.locator('#pr-bom-details').evaluate(e=>e.open=true);await page.locator('#pr-bom-name').fill('BOM response-loss');await page.locator('#pr-paste').fill('Paint\tWhite\tliters\t3');await page.locator('#pr-paste-add').click();loseSaveCount=2;await page.locator('#pr-bom-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>document.getElementById('pr-status').textContent.includes('cannot reach')&&!document.getElementById('pr-fields-bom').disabled);
  await page.locator('#pr-bom-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>document.getElementById('pr-boms').textContent.includes('BOM response-loss')&&!document.getElementById('pr-fields-bom').disabled);assert.equal(b.request({action:'getProcurement',projectId:project}).data.boms.length,6,'manual retry after lost responses creates one BOM');
  assert.deepEqual(errors,[]);console.log('PASS procurement browser: five BOMs, Excel paste, split supplier POs, consolidation, remaining quantities, deliveries, over-order blocking, conflict recovery, idempotent retries, CSV, printed PO and mobile rendering.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
