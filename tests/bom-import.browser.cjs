const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('fs');
const zip=require('../vendor/fflate-0.8.2.js');
const {createBackend}=require('./fuel.test.cjs');
const x=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
function cell(ref,value){return typeof value==='number'?`<c r="${ref}"><v>${value}</v></c>`:value&&typeof value==='object'?`<c r="${ref}">${value.xml}</c>`:`<c r="${ref}" t="inlineStr"><is><t>${x(value)}</t></is></c>`;}
function row(n,values){return `<row r="${n}">${Object.entries(values).map(([col,value])=>cell(col+n,value)).join('')}</row>`;}
const primary=[row(2,{B:'Project Name: Test cabinets',F:'09/28/2026'}),row(6,{A:'A. Sheet Goods'}),row(7,{A:'Material',D:'Thk',E:'Qty',F:'Unit',G:'Price',H:'Amount'}),row(8,{A:1,B:'Oak board',D:'18 mm',E:24,F:'Sheets',G:3000,H:72000}),row(9,{A:2,B:'Unused panel',D:'3 mm',E:0,F:'Sheets'}),row(10,{A:'Total',H:72000}),row(12,{A:'D. Hardware'}),row(13,{A:'Description',C:'Code',D:'Brand',E:'Qty',F:'Unit',G:'Price',H:'Amount'}),row(14,{A:1,B:'Hinge',C:'H-123',D:'Test brand',E:{xml:'<f>2*3</f><v>6</v>'},F:'Pairs',G:100,H:600})].join('');
const flat=(qty=8)=>row(1,{A:'Material',B:'Specification',C:'Unit',D:'Quantity'})+row(2,{A:'Metal rail',B:'3 m',C:'Lgs',D:qty});
function workbook(sheets,extra={}){
 const files={'xl/workbook.xml':`<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${x(s.name)}" sheetId="${i+1}" r:id="rId${i+1}" ${s.hidden?'state="hidden"':''}/>`).join('')}</sheets></workbook>`,'xl/_rels/workbook.xml.rels':`<Relationships>${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Target="worksheets/sheet${i+1}.xml"/>`).join('')}</Relationships>`,...extra};
 sheets.forEach((s,i)=>files[`xl/worksheets/sheet${i+1}.xml`]=`<worksheet><sheetData>${s.rows}</sheetData></worksheet>`);
 return Buffer.from(zip.zipSync(Object.fromEntries(Object.entries(files).map(([p,v])=>[p,zip.strToU8(v)]))));
}
(async()=>{
 const b=createBackend(),job='pj-00000000-0000-4000-8000-000000000001';b.request({action:'saveProcurementJob',id:job,create:true,data:{name:'Upload test',clientName:'',status:'active'}});
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage(),errors=[],actions=[];let failure='';page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**',r=>r.abort());
  await page.route('https://script.google.com/**',async r=>{const req=r.request().postDataJSON();actions.push(req);await r.fulfill({json:req.action==='saveProcurement'&&failure?{ok:false,code:'storage_error',error:failure}:b.request(req)});});
  await page.goto('http://127.0.0.1:8000/tracker.html?portal=procurement#p='+job,{waitUntil:'domcontentloaded'});await page.locator('#gateKey').fill('test-only-key');await page.locator('#gateForm').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>!document.getElementById('pr-fields-bom').disabled);
  const read=async buffer=>page.evaluate(bytes=>{try{const book=BomImport.read(new Uint8Array(bytes).buffer);return {sheets:book.sheets.map(s=>s.name),results:book.sheets.map((_,i)=>book.parse(i))};}catch(e){return {error:e.message};}},Array.from(buffer));
  const source=workbook([{name:'Cabinet BOM',rows:primary},{name:'Other job',rows:flat()},{name:'Template',rows:flat(0),hidden:true}]);
  const parsed=await read(source);assert.deepEqual(parsed.sheets,['Cabinet BOM','Other job']);assert.equal(parsed.results[0].items.length,2);assert.equal(parsed.results[0].items[0].quantity,24);assert.equal(parsed.results[0].items[0].spec,'18 mm · Sheet Goods');assert.equal(parsed.results[0].items[1].spec,'H-123 · Test brand · Hardware');assert.equal(parsed.results[0].items[1].quantity,6);assert.equal(parsed.results[0].date,'2026-09-28');assert.deepEqual(parsed.results[0].issues,[]);
  const shared=await read(workbook([{name:'Shared',rows:row(1,{A:'Material',B:'Specification',C:'Unit',D:'Quantity'})+row(2,{A:{xml:'<v>0</v>',toString:()=>''},B:'',C:'pcs',D:1}).replace('<c r="A2">','<c r="A2" t="s">')}],{'xl/sharedStrings.xml':'<sst><si><r><t>Shared </t></r><r><t>material</t></r></si></sst>'}));assert.equal(shared.results[0].items[0].material,'Shared material');
  for(const qty of [-1,'bad',{xml:'<f>1+1</f>'},{xml:'<f>1+1</f><v/>'},{xml:'<v>#REF!</v>'}])assert((await read(workbook([{name:'Bad',rows:flat(qty)}]))).results[0].issues.length,'invalid quantities blocked');
  assert.equal((await read(workbook([{name:'Scientific',rows:flat({xml:'<v>1E-6</v>'})}]))).results[0].items[0].quantity,0.000001);
  assert.match((await read(Buffer.from('not Excel'))).error,/Cannot read/);
  assert.match((await read(workbook([{name:'Bad XML',rows:'<broken>'}]))).error,/damaged XML/);
  assert.match((await read(workbook([{name:'Missing unit',rows:row(1,{A:'Material',B:'Qty'})+row(2,{A:'Board',B:3})}]))).results[0].issues.join(' '),/Unit headers/);
  assert.match((await read(workbook([{name:'Huge',rows:row(1,{A:'Material',C:'Unit',D:'Qty'})+Array.from({length:301},(_,i)=>row(i+2,{A:'Board',C:'pcs',D:1})).join('')}]))).results[0].issues.join(' '),/300/);
  const expanded=workbook([{name:'Bomb',rows:' '.repeat(21*1024*1024)}]);assert.match((await read(expanded)).error,/20 MB/);
  // A workbook file is only decoded locally; no write occurs before Save BOM.
  const payload={name:'BOM_Test cabinets.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:source};
  await page.locator('[data-pr-start="bom"]').click();await page.locator('#pr-import-file').setInputFiles(payload);await page.waitForFunction(()=>document.getElementById('pr-import-status').textContent.includes('2 materials added'));
  assert.equal(await page.locator('#pr-bom-items tr').count(),2);assert.equal(await page.locator('#pr-bom-name').inputValue(),'Test cabinets');assert.equal(await page.locator('#pr-bom-date').inputValue(),'2026-09-28');assert(!actions.some(r=>r.action==='saveProcurement'),'choosing file does not save prematurely');assert.equal(await page.locator('#pr-import-sheet option').count(),3);
  await page.locator('#pr-bom-add-row').click();const manual=page.locator('#pr-bom-items tr').last();await manual.locator('[data-field="material"]').fill('Manual tape');await manual.locator('[data-field="unit"]').fill('rolls');await manual.locator('[data-field="quantity"]').fill('2');
  await page.locator('#pr-import-sheet').selectOption('1');assert.equal(await page.locator('#pr-bom-items tr').count(),2);assert.equal(await page.locator('#pr-bom-items [data-field="material"]').first().inputValue(),'Manual tape');
  await page.locator('#pr-bom-items [data-field="quantity"]').last().fill('9');page.once('dialog',d=>d.dismiss());await page.locator('#pr-import-sheet').selectOption('0');assert.equal(await page.locator('#pr-import-sheet').inputValue(),'1');assert.equal(await page.locator('#pr-bom-items [data-field="quantity"]').last().inputValue(),'9');
  page.once('dialog',d=>d.dismiss());await page.locator('#pr-import-file').setInputFiles(payload);await page.waitForFunction(()=>!document.getElementById('pr-fields-bom').disabled);assert(!/Reading/.test(await page.locator('#pr-import-status').innerText()),'cancelled replacement restores prior status');
  page.once('dialog',d=>d.accept());await page.locator('#pr-import-sheet').selectOption('0');assert.equal(await page.locator('#pr-bom-items tr').count(),3);
  await page.locator('#pr-import-file').setInputFiles({...payload,name:'Broken.xlsx',buffer:Buffer.from('broken')});await page.waitForFunction(()=>document.getElementById('pr-import-status').textContent.includes('Cannot read'));assert.equal(await page.locator('#pr-bom-items tr').count(),3);
  await page.locator('#pr-import-file').setInputFiles({...payload,name:'Wrong.pdf'});assert.match(await page.locator('#pr-import-status').innerText(),/Choose an .xlsx/);
  await page.locator('#pr-import-file').setInputFiles({...payload,buffer:Buffer.alloc(5*1024*1024+1)});assert.match(await page.locator('#pr-import-status').innerText(),/5 MB/);
  failure='Spreadsheet write permission denied';await page.locator('#pr-bom-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>document.getElementById('pr-status').textContent.includes('permission denied'));assert.equal(await page.locator('#pr-bom-items tr').count(),3);assert.equal(b.request({action:'getProcurement',projectId:job}).revision,0);
  failure='Spreadsheet capacity exceeded';await page.locator('#pr-bom-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>document.getElementById('pr-status').textContent.includes('capacity'));assert.equal(await page.locator('#pr-bom-items tr').count(),3);
  failure='';await page.locator('#pr-bom-form').evaluate(f=>f.requestSubmit());await page.waitForFunction(()=>document.getElementById('pr-boms').textContent.includes('Test cabinets')&&!document.getElementById('pr-fields-bom').disabled);assert.equal(b.request({action:'getProcurement',projectId:job}).data.boms[0].items.length,3);assert.match(await page.locator('#pr-summary').innerText(),/24/);
  // Empty first worksheet still lets the officer select a useful sheet.
  await page.locator('#pr-bom-title').click();await page.locator('#pr-import-file').setInputFiles({...payload,buffer:workbook([{name:'Empty',rows:flat(0)},{name:'Actual materials',rows:flat()}])});await page.waitForFunction(()=>document.getElementById('pr-import-status').textContent.includes('No materials'));await page.locator('#pr-import-sheet').selectOption('1');assert.equal(await page.locator('#pr-bom-items tr').count(),1);
  // Drag and drop invokes the same parser and does not duplicate a previous batch.
  await page.locator('#pr-import-zone').evaluate((zone,bytes)=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],'Dropped.xlsx'));zone.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt,cancelable:true}));},Array.from(source));await page.waitForFunction(()=>document.getElementById('pr-import-status').textContent.includes('Dropped.xlsx')&&!document.getElementById('pr-fields-bom').disabled);assert.equal(await page.locator('#pr-bom-items tr').count(),2);
  await page.setViewportSize({width:390,height:844});await page.locator('.bom-import').screenshot({path:'/tmp/bom-upload-mobile.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert(!actions.some(r=>JSON.stringify(r).includes('base64')||r.action==='uploadFuelReceipt'),'no original workbook or Drive writes sent');assert.deepEqual(errors,[]);
  await page.close({runBeforeUnload:false});console.log('PASS Excel BOM import: template sections, merged-style headings, shared strings, cached formulas, sheet separation, limits/errors, drag/drop, edited-row protection, storage failure retention/retry and mobile layout.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
