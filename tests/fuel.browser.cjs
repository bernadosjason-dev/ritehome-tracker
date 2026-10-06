const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createBackend}=require('./fuel.test.cjs');
(async()=>{
 const b=createBackend(); let failWrites=0; let loseResponse=false; let loseUploadResponse=false;
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try {
 const page=await browser.newPage();const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());
 await page.route('https://drive.google.com/**', async r=>{ const id=new URL(r.request().url()).searchParams.get('id');const f=[...b.storage.files.values()].find(f=>f.id===id);await r.fulfill(f?{contentType:f.blob.type,body:Buffer.from(f.blob.bytes)}:{status:404}); });
 await page.route('https://script.google.com/**',async r=>{
  const req=r.request().postDataJSON();
  let result;
  if(req.action==='saveFuel' && failWrites>0){failWrites--;result={ok:false,code:'unavailable'};}
  else result=req.action==='listProjects'?{ok:true,projects:[]}:b.request(req);
  if(req.action==='uploadFuelReceipt' && loseUploadResponse){loseUploadResponse=false;return r.abort();}
  if(req.action==='saveFuel' && loseResponse){loseResponse=false;return r.abort();}
  await r.fulfill({json:result});
 });
 await page.goto('http://127.0.0.1:8000/',{waitUntil:'domcontentloaded'});
 assert(await page.locator('#gateKey').isVisible());
 await page.locator('#gateKey').fill('test-only-key');await page.locator('#gateForm').evaluate(f=>f.requestSubmit());
 await page.locator('#cf-fields').waitFor();
 await page.waitForFunction(()=>!document.getElementById('cf-fields').disabled);
 await page.locator('#companyVehiclesPanel summary').click();
 await page.waitForFunction(()=>!document.getElementById('cv-fields').disabled);
 for(const [name,type] of [['Wigo','gasoline'],['Van','diesel']]) {
  await page.locator('#cv-name').fill(name);await page.locator('#cv-type').selectOption(type);await page.locator('#cv-save').click();
  await page.waitForFunction(name=>document.getElementById('cv-rows').textContent.includes(name)&&!document.getElementById('cv-fields').disabled,name);
 }
 await page.locator('#cf-vehicle').fill('Van');await page.locator('#cf-vehicle').dispatchEvent('change');assert.equal(await page.locator('#cf-type').inputValue(),'diesel');
 await page.locator('#cf-vehicle').fill('Wigo');await page.locator('#cf-vehicle').dispatchEvent('change');assert.equal(await page.locator('#cf-type').inputValue(),'gasoline');
 await page.locator('#cf-date').fill('2026-10-06');await page.locator('#cf-vehicle').fill('Truck ABC');await page.locator('#cf-type').selectOption('diesel');await page.locator('#cf-liters').fill('20.5');await page.locator('#cf-amount').fill('1230');await page.locator('#cf-driver').fill('Juan');
 loseResponse=true;
 await page.locator('#cf-submit').click();
 await page.waitForFunction(()=>document.getElementById('cf-rows').textContent.includes('Truck ABC') && !document.getElementById('cf-fields').disabled);
 assert.equal(b.request({action:'listFuel'}).entries.length,1,'lost response retried without duplication');
 assert.match(await page.locator('#cf-summary').innerText(),/Diesel: 20.5 L/);
 await page.locator('[data-fuel-edit]').click();await page.locator('#cf-liters').fill('25');await page.locator('#cf-submit').click();
 await page.waitForFunction(()=>document.getElementById('cf-summary').textContent.includes('Diesel: 25 L'));
 await page.locator('#cf-date').fill('2026-09-30');await page.locator('#cf-vehicle').fill('Generator');await page.locator('#cf-type').selectOption('gasoline');await page.locator('#cf-liters').fill('10');await page.locator('#cf-amount').fill('650');
 failWrites=2;
 await page.locator('#cf-submit').click();await page.locator('[data-sb="retry"]').waitFor();
 assert.equal(await page.locator('#cf-vehicle').inputValue(),'Generator','failed save preserves input');
 await page.locator('[data-sb="retry"]').click();
 await page.waitForFunction(()=>document.getElementById('cf-summary').textContent.includes('Gasoline: 10 L'));
 await page.locator('#cf-month').fill('2026-10');assert.match(await page.locator('#cf-summary').innerText(),/Gasoline: 0 L/);
 await page.locator('#cf-month').fill('');assert.match(await page.locator('#cf-summary').innerText(),/2 purchases/);
 await page.locator('#cf-vehicle-filter').selectOption('Truck ABC');assert.match(await page.locator('#cf-summary').innerText(),/1 purchase/);
 const downloadPromise=page.waitForEvent('download');await page.locator('#cf-export').click();const download=await downloadPromise;const fs=require('fs');const csv=fs.readFileSync(await download.path(),'utf8');assert(csv.includes('Truck ABC'));assert(!csv.includes('Generator'));
 page.on('dialog',d=>d.accept());await page.locator('[data-fuel-delete]').click();await page.waitForFunction(()=>document.getElementById('cf-rows').textContent.includes('Generator'));
 await page.setViewportSize({width:390,height:844});assert(await page.locator('#cf-rows').isVisible());
 const vanId=b.request({action:'listVehicles'}).vehicles.find(v=>v.name==='Van').id;
 await page.locator('[data-vehicle-edit="'+vanId+'"]').click();await page.locator('#cv-name').fill('Company Van');await page.locator('#cv-plate').fill('XYZ 456');await page.locator('#cv-type').selectOption('gasoline');await page.locator('#cv-save').click();
 await page.waitForFunction(()=>document.getElementById('cv-rows').textContent.includes('Company Van')&&!document.getElementById('cv-fields').disabled);
 await page.locator('#cf-vehicle').fill('Company Van');await page.locator('#cf-vehicle').dispatchEvent('change');assert.equal(await page.locator('#cf-type').inputValue(),'gasoline');
 await page.locator('#cf-cancel').click();await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('#companyVehiclesPanel summary').click();await page.waitForFunction(()=>document.getElementById('cv-rows').textContent.includes('Company Van'));
 assert.match(await page.locator('#cv-rows').innerText(),/XYZ 456/);
 await page.locator('#cf-date').fill('2026-10-06');await page.locator('#cf-vehicle').fill('Wigo');await page.locator('#cf-liters').fill('15');await page.locator('#cf-amount').fill('900');
 await page.locator('#cf-no-receipt').check();await page.locator('#cf-admin-confirmed').check();await page.locator('#cf-admin-name').fill('Jason');
 assert.equal(await page.locator('#cf-photo').isDisabled(),true);
 await page.locator('#cf-submit').click();
 await page.waitForFunction(()=>document.getElementById('cf-rows').textContent.includes('Admin confirmed: Jason'));
 let receiptEntry=b.request({action:'listFuel'}).entries.find(e=>e.vehicle==='Wigo');assert.equal(receiptEntry.adminConfirmed,true);assert(receiptEntry.adminConfirmedAt);
 await page.locator('[data-fuel-edit="'+receiptEntry.id+'"]').click();assert.equal(await page.locator('#cf-admin-name').inputValue(),'Jason');await page.locator('#cf-admin-confirmed').uncheck();await page.locator('#cf-submit').click();await page.waitForFunction(()=>document.getElementById('cf-rows').textContent.includes('Awaiting admin confirmation'));
 await page.locator('#cf-date').fill('2026-10-06');await page.locator('#cf-vehicle').fill('Van receipt');await page.locator('#cf-liters').fill('10');await page.locator('#cf-amount').fill('650');
 const photo={name:'receipt.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII=','base64')};
 await page.locator('#cf-photo').setInputFiles(photo);assert(await page.locator('#cf-photo-preview').isVisible());assert(await page.locator('#cf-no-receipt').isDisabled());
 b.storage.failure='write';await page.locator('#cf-submit').click();await page.waitForFunction(()=>document.getElementById('cf-error').textContent.includes('Google Drive'));
 assert.equal(await page.locator('#cf-vehicle').inputValue(),'Van receipt');assert(await page.locator('#cf-photo-preview').isVisible());
 assert(!b.request({action:'listFuel'}).entries.some(e=>e.vehicle==='Van receipt'),'failed upload must not save purchase');
 b.storage.failure=null;loseUploadResponse=true;await page.locator('[data-sb="retry"]').click();
 await page.waitForFunction(()=>document.querySelector('#cf-rows [data-fuel-receipt]'));
 receiptEntry=b.request({action:'listFuel'}).entries.find(e=>e.vehicle==='Van receipt');assert(receiptEntry.receipt);assert.equal(b.storage.files.size,1,'lost upload response does not create duplicate files');
 await page.locator('[data-fuel-receipt]').click();assert(await page.locator('#cf-receipt-dialog').isVisible());await page.waitForFunction(()=>document.getElementById('cf-receipt-image').naturalWidth>0);await page.locator('#cf-receipt-close').click();
 await page.locator('[data-fuel-edit="'+receiptEntry.id+'"]').click();assert(await page.locator('#cf-photo-preview').isVisible());await page.locator('#cf-photo-remove').click();await page.locator('#cf-no-receipt').check();await page.locator('#cf-submit').click();
 await page.waitForFunction(()=>!document.querySelector('#cf-rows [data-fuel-receipt]'));
 receiptEntry=b.request({action:'listFuel'}).entries.find(e=>e.vehicle==='Van receipt');assert.equal(receiptEntry.receipt,null);assert.equal(receiptEntry.noReceipt,true);assert.equal(receiptEntry.adminConfirmed,false);
 const receiptDownload=page.waitForEvent('download');await page.locator('#cf-export').click();const receiptCsv=fs.readFileSync(await (await receiptDownload).path(),'utf8');assert(receiptCsv.includes('Admin confirmed'));assert(receiptCsv.includes('No photo'));
 b.storage.failure='read';await page.locator('#cf-check-storage').click();await page.waitForFunction(()=>document.getElementById('cf-storage-status').textContent.includes('Google Drive')&&!document.getElementById('cf-fields').disabled);
 b.storage.failure=null;await page.locator('#cf-check-storage').click();await page.waitForFunction(()=>document.getElementById('cf-storage-status').textContent.includes('check passed'));
 assert([...b.storage.files.values()].some(f=>f.trashed),'diagnostic probe cleaned up');
 assert.deepEqual(errors,[]);
 console.log('PASS browser: receipt preview/upload/view/remove, Drive failure recovery, upload retry deduplication, no-photo admin confirmation, receipt CSV, vehicle add/edit, fuel defaults, reload persistence, gate, add, lost-response retry, edit, failed-save retry, monthly/vehicle filters, CSV export, delete, mobile rendering; no JS errors.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
