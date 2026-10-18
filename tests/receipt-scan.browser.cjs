const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {createScanBackend,geminiReply,PHOTO}=require('./receipt-scan.test.cjs');

// Scan receipt in the Projects portal against the local Apps Script emulator and a fake Gemini.
// No production deployment, Drive folder or Google AI key is touched.
(async()=>{
 const b=createScanBackend();
 const project=b.request({action:'addProject',data:{name:'Scan test job',clientName:'Test Client'}}).id;
 const props=b.context.PropertiesService.getScriptProperties();
 let backendDown=false;const sentToPage=[];
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.route('https://drive.google.com/**',async r=>{const id=new URL(r.request().url()).searchParams.get('id');const f=b.fileById(id);await r.fulfill(f?{contentType:f.blob.type,body:Buffer.from(f.blob.bytes)}:{status:404});});
  await page.route('https://script.google.com/**',async r=>{
   if(backendDown)return r.abort();
   const result=b.request(r.request().postDataJSON());sentToPage.push(JSON.stringify(result));
   await r.fulfill({json:result});
  });
  const form=()=>page.evaluate(()=>{
   const v=id=>document.getElementById(id).value,note=document.getElementById('scanNote');
   return {cat:v('f-category'),item:v('f-item'),amount:v('f-amount'),date:v('f-date'),vendor:v('f-vendor'),ref:v('f-ref'),
    marked:[...document.querySelectorAll('#expenseForm .ai-filled')].map(e=>e.id).sort(),
    note:note.hidden?'':note.textContent,warn:note.classList.contains('warn'),
    photo:!document.getElementById('rcThumbImg').hidden,scanShown:!document.getElementById('scanRow').hidden,
    scanBusy:document.getElementById('scanText').textContent!=='Scan receipt'||document.getElementById('scanFile').disabled};
  });
  const scan=async(p=page)=>{
   await p.setInputFiles('#scanFile',{name:'receipt.png',mimeType:'image/png',buffer:PHOTO});
   await p.waitForFunction(()=>document.getElementById('scanText').textContent==='Scan receipt'&&!document.getElementById('scanNote').hidden);
   return p===page?form():null;
  };
  const expenses=()=>b.request({action:'getProject',id:project}).expenses;

  await page.goto('http://127.0.0.1:8000/tracker.html?portal=projects#p='+project,{waitUntil:'domcontentloaded'});
  await page.locator('#gateKey').fill('test-only-key');await page.locator('#gateForm').evaluate(f=>f.requestSubmit());
  await page.waitForFunction(()=>!document.getElementById('scanRow').hidden&&!document.getElementById('scanFile').disabled);

  // 1. A readable receipt fills the form, highlights what the AI filled and attaches the photo; nothing saves yet.
  let f=await scan();
  assert.deepEqual([f.cat,f.item,f.amount,f.date,f.vendor,f.ref],['materials','18mm marine plywood, 14 sheets','12450.5','2026-09-27','CitiHardware Kauswagan','OR 004512']);
  assert.deepEqual(f.marked,['f-amount','f-category','f-date','f-item','f-ref','f-vendor']);
  assert.match(f.note,/^Filled category, item, amount, date, vendor, OR\/PO no\. from the receipt/);
  assert.equal(f.warn,false);assert.equal(f.photo,true);
  assert.equal(expenses().length,0,'scanning alone must not add an expense');
  const firstPhoto=JSON.parse(sentToPage.findLast(s=>s.includes('"fields"'))).id;

  // 2. Correcting a field drops its highlight; Add to ledger saves the corrected value with the scanned photo.
  await page.locator('#f-amount').fill('12450');
  f=await form();assert(!f.marked.includes('f-amount'));assert(f.marked.includes('f-date'));
  await page.locator('#expenseSubmit').click();
  await page.waitForFunction(()=>document.getElementById('f-item').value===''&&!document.getElementById('expenseSubmit').disabled);
  await page.waitForFunction(()=>!document.getElementById('scanFile').disabled);
  let saved=expenses();
  assert.equal(saved.length,1);
  assert.deepEqual([saved[0].amount,saved[0].date,saved[0].vendor,saved[0].ref,saved[0].receipt],[12450,'2026-09-27','CitiHardware Kauswagan','OR 004512',firstPhoto]);
  assert.equal(b.fileById(firstPhoto).trashed,false,'the saved receipt photo is kept');
  f=await form();assert.deepEqual(f.marked,[]);assert.equal(f.note,'');assert.equal(f.photo,false);

  // 3. OR numbers are only used for materials; a future date is never trusted; a re-scan trashes the replaced photo.
  b.gemini.replies=[geminiReply({is_receipt:true,vendor:'Jollibee Limketkai',date:'2026-09-26',total:845,ref:'SI 88812',item:'Crew lunch, 6 meals',category:'food'})];
  f=await scan();
  assert.deepEqual([f.cat,f.amount,f.ref],['food','845','']);assert(!f.marked.includes('f-ref'));
  const foodPhoto=JSON.parse(sentToPage.findLast(s=>s.includes('"fields"'))).id;
  b.gemini.replies=[geminiReply({is_receipt:true,vendor:'Petron',date:'2099-01-01',total:1500,ref:'',item:'Diesel, 25 liters',category:'transportation'})];
  f=await scan();
  assert.equal(f.date,'2026-09-26','a future date read from the photo leaves the date field as it was');assert(!f.marked.includes('f-date'));
  for(let i=0;i<50&&!b.fileById(foodPhoto).trashed;i++)await page.waitForTimeout(50);
  assert.equal(b.fileById(foodPhoto).trashed,true,'the photo replaced by a re-scan is trashed');

  // 4. Every failure keeps the photo attached and says what to do; nothing is filled in.
  await page.locator('#f-category').selectOption('other');await page.locator('#f-amount').fill('');await page.locator('#f-item').fill('');
  const failures=[
   [()=>{b.gemini.replies=[geminiReply({is_receipt:false,total:0})];},/doesn't look like a receipt/],
   [()=>{props.setProperty('GEMINI_API_KEY','');},/isn't switched on yet/],
   [()=>{props.setProperty('GEMINI_API_KEY','gemini-test-only-key');b.gemini.replies=[{status:429,body:{}}];},/busy right now/],
   [()=>{b.gemini.replies=[{status:500,body:{}}];},/couldn't read it/]
  ];
  for(const [setup,message] of failures){
   setup();f=await scan();
   assert.match(f.note,message);assert.equal(f.warn,true);assert.equal(f.photo,true);
   assert.deepEqual(f.marked,[]);assert.equal(f.amount,'');assert.equal(f.cat,'other');
  }

  // 5. An unreachable backend shows an error and leaves the button usable for another try.
  backendDown=true;
  await page.setInputFiles('#scanFile',{name:'receipt.png',mimeType:'image/png',buffer:PHOTO});
  await page.waitForFunction(()=>!document.getElementById('scanNote').hidden&&!document.getElementById('scanFile').disabled,null,{timeout:15000});
  f=await form();backendDown=false;
  assert.equal(f.warn,true);assert.equal(f.scanBusy,false);assert.ok(f.note.length>0);

  // 6. Editing an existing expense hides Scan receipt and clears AI highlights; Cancel brings it back.
  b.gemini.replies=[geminiReply({is_receipt:true,vendor:'CitiHardware',date:'2026-09-27',total:500,ref:'',item:'Screws',category:'materials'})];
  await scan();
  await page.locator('#tableBody [data-action="edit"]').first().click();
  f=await form();assert.equal(f.scanShown,false);assert.deepEqual(f.marked,[]);assert.equal(f.note,'');
  await page.locator('#expenseCancelBtn').click();
  f=await form();assert.equal(f.scanShown,true);

  // 7. The Gemini key never reaches the browser, and the phone layout does not scroll sideways.
  assert(sentToPage.every(s=>!s.includes('gemini-test-only-key')));
  await page.setViewportSize({width:390,height:844});
  await scan();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#expenseCard').screenshot({path:'/tmp/ritehome-scan-mobile.png'});
  assert.deepEqual(errors,[]);
  await page.close({runBeforeUnload:false});
  console.log('PASS receipt scan: fills and highlights fields, saves only on Add to ledger with the scanned photo, corrected values win, materials-only OR, future dates ignored, replaced photos trashed, not-a-receipt/no-key/quota/AI-error/offline recovery, hidden while editing, key never sent to the page, phone layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
