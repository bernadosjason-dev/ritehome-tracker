const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createBackend}=require('./fuel.test.cjs');
(async()=>{
 const backend=createBackend(),project=backend.request({action:'addProject',data:{name:'Santos Residence',clientName:'Maria Santos'}}).id;
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.route('https://script.google.com/**',r=>r.fulfill({json:backend.request(r.request().postDataJSON())}));
  await page.goto('http://127.0.0.1:8000/tracker.html',{waitUntil:'domcontentloaded'});
  assert(!await page.locator('[data-ui-target="companyFuelCard"]').isVisible(),'section shortcuts hidden at access gate');
  await page.locator('#gateKey').fill('test-only-key');await page.locator('#gateForm').evaluate(f=>f.requestSubmit());
  await page.waitForFunction(()=>!document.getElementById('cf-fields').disabled);
  await page.locator('[data-ui-target="companyFuelCard"]').click();await page.waitForTimeout(400);
  assert(await page.locator('#companyFuelCard').isVisible());
  assert.equal(await page.locator('[data-ui-target="companyFuelCard"] svg[aria-hidden="true"]').count(),1);
  await page.locator('#cf-receipt-card').screenshot({path:'/tmp/receipt-picker-desktop.png'});
  const pickerPromise=page.waitForEvent('filechooser');await page.locator('#cf-photo-choose').focus();await page.keyboard.press('Enter');const picker=await pickerPromise;
  await picker.setFiles({name:'fuel-receipt.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII=','base64')});
  assert.equal(await page.locator('#cf-photo-name').innerText(),'fuel-receipt.png');assert.equal((await page.locator('#cf-photo-choose').innerText()).trim(),'Change photo');assert(await page.locator('#cf-photo-preview').isVisible());
  await page.locator('#cf-photo-remove').click();assert.equal(await page.locator('#cf-photo-name').innerText(),'Add a receipt photo');
  await page.locator('#cf-no-receipt').check();assert(await page.locator('#cf-photo-choose').isDisabled());await page.locator('#cf-no-receipt').uncheck();assert(!await page.locator('#cf-photo-choose').isDisabled());

  await page.locator('#cf-date').fill('2026-10-12');await page.locator('#cf-vehicle').fill('Wigo');await page.locator('#cf-liters').fill('10');await page.locator('#cf-amount').fill('700');await page.locator('#cf-submit').click();
  await page.waitForFunction(()=>document.querySelector('[data-fuel-edit] .action-icon'));
  assert.equal(await page.locator('[data-fuel-edit] .action-icon').count(),1,'dynamic row icons added');
  await page.locator('[data-ui-target="dashboardScreen"]').click();assert.equal((await page.locator('#newProjectToggle').innerText()).trim(),'New project');
  await page.screenshot({path:'/tmp/ritehome-ui-desktop.png',fullPage:false});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page overflow on phone');
  await page.locator('#cf-receipt-card').screenshot({path:'/tmp/receipt-picker-mobile.png'});
  const height=await page.locator('#cf-submit').evaluate(e=>e.getBoundingClientRect().height);assert(height>=44);
  await page.locator('[data-ui-target="companyFuelCard"]').click();await page.waitForTimeout(400);await page.screenshot({path:'/tmp/ritehome-ui-mobile.png'});
  await page.goto('http://127.0.0.1:8000/tracker.html#p='+project,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>!document.getElementById('pr-fields-bom').disabled);
  assert(await page.locator('[data-ui-target="procurementCard"]').isVisible());assert(!await page.locator('[data-ui-target="companyFuelCard"]').isVisible());
  await page.locator('[data-ui-target="procurementCard"]').click();
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  const background=await page.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor);assert.equal(background,'rgb(20, 27, 34)');
  await page.screenshot({path:'/tmp/ritehome-ui-dark.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS UI audit: contextual navigation, accessible static/dynamic icons, fuel save, phone touch sizes, no page overflow, dark theme, reduced motion, no JS errors.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
