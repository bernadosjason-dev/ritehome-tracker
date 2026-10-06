const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function createBackend() {
  const sheets = new Map();
  let locks = 0;
  const storage = {files:new Map(), failure:null};
  const properties = new Map([['TRACKER_KEY','test-only-key'], ['RECEIPTS_FOLDER_ID','test-receipts-folder']]);
  const folder = {
    getId: () => 'test-receipts-folder',
    getFilesByName(name){ const file=storage.files.get(name); let read=false; return {hasNext:()=>!!file&&!read,next(){read=true;return file;}}; },
    createFile(blob){
      if(storage.failure==='write')throw Error('Drive quota exceeded');
      const file={id:'receipt_'+(storage.files.size+1),blob,shared:false,trashed:false,setTrashed(value){this.trashed=value;},getId(){return this.id;},setSharing(){if(storage.failure==='share')throw Error('Sharing forbidden');this.shared=true;}};
      storage.files.set(blob.name,file);return file;
    }
  };
  function sheet() {
    const rows = [];
    return {
      rows, getLastRow: () => rows.length,
      getRange(row, col, height, width) {
        return {
          getValues: () => Array.from({length:height}, (_, i) => Array.from({length:width}, (_, j) => rows[row+i-1]?.[col+j-1] ?? '')),
          setValues(values) { values.forEach((r,i) => { rows[row+i-1] ||= []; r.forEach((v,j) => {rows[row+i-1][col+j-1] = v;}); }); return this; },
          setFontWeight() { return this; }
        };
      },
      setFrozenRows() {}, deleteRow(row) { rows.splice(row-1,1); }
    };
  }
  const context = vm.createContext({
    SpreadsheetApp: {getActiveSpreadsheet: () => ({getSheetByName:name=>sheets.get(name), insertSheet(name){const s=sheet();sheets.set(name,s);return s;}})},
    PropertiesService: {getScriptProperties: () => ({getProperty:name=>properties.get(name)||null,setProperty:(name,value)=>properties.set(name,value)})},
    Utilities:{getUuid:()=>require('node:crypto').randomUUID(),base64Decode:data=>Array.from(Buffer.from(data,'base64')),newBlob:(bytes,type,name)=>({bytes,type,name})},
    DriveApp:{Access:{ANYONE_WITH_LINK:'anyone'},Permission:{VIEW:'view'},getFileById(id){return [...storage.files.values()].find(f=>f.id===id);},getFolderById(id){if(storage.failure==='read')throw Error('Folder access denied');assert.equal(id,'test-receipts-folder');return folder;},createFolder:()=>folder},
    LockService: {getScriptLock: () => ({tryLock(){locks++;return true;},releaseLock(){locks--;}})},
    ContentService: {MimeType:{JSON:'application/json'},createTextOutput: text => ({setMimeType:()=>text})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../backend/Code.gs'),'utf8'),context);
  return {sheets, context, storage, request(req){const result=JSON.parse(context.doPost({postData:{contents:JSON.stringify({key:'test-only-key',...req})}}));assert.equal(locks,0,'write lock released');return result;}};
}
const data = {date:'2026-10-06',vehicle:'Truck ABC 123',fuelType:'diesel',liters:20.5,amount:1230,driver:'Juan',odometer:12000,vendor:'Station',notes:''};
const id = 'fuel-00000000-0000-4000-8000-000000000001';
test('fuel create, retry, edit, list and delete remain separate from projects', () => {
  const b = createBackend();
  assert.equal(b.request({action:'saveFuel',id,data,create:true}).ok,true);
  assert.equal(b.request({action:'saveFuel',id,data,create:true}).ok,true);
  assert.equal(b.request({action:'listFuel'}).entries.length,1);
  assert.equal(b.request({action:'saveFuel',id,data:{...data,liters:99},create:true}).code,'already_exists','changed retry must not silently discard edited details');
  assert.equal(b.request({action:'saveFuel',id,data:{...data,liters:30,amount:1800},create:false}).ok,true);
  assert.equal(b.request({action:'listFuel'}).entries[0].liters,30);
  assert.equal(b.sheets.has('Projects'),false);
  assert.equal(b.sheets.has('Expenses'),false);
  assert.equal(b.request({action:'deleteFuel',id}).ok,true);
  assert.equal(b.request({action:'deleteFuel',id}).ok,true);
  assert.equal(b.request({action:'listFuel'}).entries.length,0);
  assert.equal(b.request({action:'saveFuel',id,data,create:false}).code,'not_found');
});
test('fuel actions require the existing tracker access key', () => {
  const b=createBackend();
  for(const action of ['listFuel','saveFuel','deleteFuel']) assert.equal(b.request({action,key:'wrong',id,data,create:true}).code,'bad_key');
  assert.equal(b.sheets.size,0);
});
test('fuel validation rejects invalid dates, types, numbers and missing vehicles', () => {
  const b=createBackend();
  for(const patch of [{date:'2026-02-30'},{date:'garbage'},{fuelType:'kerosene'},{liters:0},{liters:-2},{liters:'20'},{amount:0},{odometer:-1},{vehicle:'  '},{notes:'a'.repeat(501)}]) {
    assert.equal(b.request({action:'saveFuel',id,data:{...data,...patch},create:true}).code,'invalid_argument',JSON.stringify(patch));
  }
  assert.equal(b.request({action:'saveFuel',id:'invalid',data,create:true}).code,'invalid_argument');
  assert.equal(b.request({action:'listFuel'}).entries.length,0);
});
test('readable sheet cells neutralize formulas and preserve optional blank odometer', () => {
  const b=createBackend();
  assert.equal(b.request({action:'saveFuel',id,data:{...data,vehicle:'=HYPERLINK("example")',driver:'@driver',odometer:null},create:true}).ok,true);
  const row=b.sheets.get('Company Fuel').rows[1];
  assert.equal(row[2], '\'=HYPERLINK("example")');
  assert.equal(row[6], "'@driver");
  assert.equal(row[7],'');
  assert.equal(b.request({action:'listFuel'}).entries[0].odometer,null);
});
module.exports={createBackend};

test('vehicle profiles persist, retry safely, edit defaults and preserve fuel history', () => {
  const b=createBackend();
  const vehicleId='vehicle-00000000-0000-4000-8000-000000000001';
  const profile={name:'Wigo',fuelType:'gasoline',plate:'ABC 123'};
  assert.equal(b.request({action:'saveVehicle',id:vehicleId,data:profile,create:true}).ok,true);
  assert.equal(b.request({action:'saveVehicle',id:vehicleId,data:profile,create:true}).ok,true);
  assert.equal(b.request({action:'listVehicles'}).vehicles.length,1);
  assert.equal(b.request({action:'saveFuel',id,data:{...data,vehicle:'Wigo',fuelType:'gasoline'},create:true}).ok,true);
  assert.equal(b.request({action:'saveVehicle',id:vehicleId,data:{...profile,name:'Wigo ABC 123',fuelType:'diesel'},create:false}).ok,true);
  const vehicle=b.request({action:'listVehicles'}).vehicles[0];
  assert.equal(vehicle.name,'Wigo ABC 123');
  assert.equal(vehicle.fuelType,'diesel');
  const purchase=b.request({action:'listFuel'}).entries[0];
  assert.equal(purchase.vehicle,'Wigo');
  assert.equal(purchase.fuelType,'gasoline','profile edits do not rewrite historical purchases');
});
test('vehicle profiles reject unauthenticated access, duplicates and invalid fields', () => {
  const b=createBackend();
  const id='vehicle-00000000-0000-4000-8000-000000000001';
  const data={name:'Van',fuelType:'diesel',plate:''};
  for(const action of ['saveVehicle','listVehicles'])assert.equal(b.request({action,key:'wrong',id,data,create:true}).code,'bad_key');
  assert.equal(b.sheets.size,0);
  for(const patch of [{name:' '},{name:'x'.repeat(101)},{fuelType:'electric'},{plate:'x'.repeat(51)}])assert.equal(b.request({action:'saveVehicle',id,data:{...data,...patch},create:true}).code,'invalid_argument');
  assert.equal(b.request({action:'saveVehicle',id,data,create:true}).ok,true);
  assert.equal(b.request({action:'saveVehicle',id:id+'2',data:{...data,name:'van'},create:true}).code,'invalid_argument');
  assert.equal(b.request({action:'saveVehicle',id:id+'2',data,create:false}).code,'not_found');
  assert.equal(b.request({action:'saveVehicle',id,data:{...data,fuelType:'gasoline'},create:true}).code,'already_exists');
});

test('fuel receipt upload uses configured Drive folder, shares photos and retries without duplicates', () => {
  const b=createBackend(),uploadId='fuelphoto-00000000-0000-4000-8000-000000000001';
  const request={action:'uploadFuelReceipt',uploadId,mimeType:'image/png',data:Buffer.from('test-photo-bytes').toString('base64')};
  assert.equal(b.request({...request,key:'wrong'}).code,'bad_key');
  assert.equal(b.storage.files.size,0);
  const first=b.request(request);
  assert.equal(first.ok,true);
  assert.equal(b.request(request).id,first.id);
  assert.equal(b.storage.files.size,1);
  assert.equal([...b.storage.files.values()][0].shared,true);
  assert.equal(b.request({action:'saveFuel',id,data:{...data,receipt:first.id},create:true}).ok,true);
  assert.equal(b.request({action:'listFuel'}).entries[0].receipt,first.id);
  assert.equal(b.request({...request,mimeType:'application/pdf'}).code,'unsupported_type');
  assert.equal(b.request({...request,data:''}).code,'invalid_argument');
});
test('receipt storage permission, quota and sharing failures are visible and recoverable', () => {
  for(const failure of ['read','write','share']){
    const b=createBackend(),req={action:'uploadFuelReceipt',uploadId:'fuelphoto-00000000-0000-4000-8000-000000000001',mimeType:'image/png',data:Buffer.from('photo').toString('base64')};
    b.storage.failure=failure;
    assert.equal(b.request(req).code,'receipt_storage_unavailable',failure);
    assert.equal(b.request({action:'listFuel'}).entries.length,0);
    b.storage.failure=null;
    assert.equal(b.request(req).ok,true);
    assert.equal(b.storage.files.size,1);
    assert.equal([...b.storage.files.values()][0].shared,true);
  }
});
test('fuel no-photo admin confirmation records name and server time, with consistent receipt states', () => {
  const b=createBackend();
  const missing={...data,noReceipt:true,adminConfirmed:false};
  assert.equal(b.request({action:'saveFuel',id,data:missing,create:true}).ok,true);
  assert.equal(b.request({action:'listFuel'}).entries[0].adminConfirmedAt,null);
  assert.equal(b.request({action:'saveFuel',id,data:{...missing,adminConfirmed:true,adminName:'Jason'},create:false}).ok,true);
  const confirmed=b.request({action:'listFuel'}).entries[0];
  assert.equal(confirmed.adminName,'Jason');assert.match(confirmed.adminConfirmedAt,/^\d{4}-/);
  assert.equal(b.request({action:'saveFuel',id,data:{...data,amount:1500},create:false}).ok,true,'older clients preserve new receipt metadata');
  assert.equal(b.request({action:'listFuel'}).entries[0].adminConfirmedAt,confirmed.adminConfirmedAt);
  for(const patch of [{receipt:'file123',noReceipt:true},{noReceipt:false,adminConfirmed:true,adminName:'Admin'},{noReceipt:true,adminConfirmed:true,adminName:''},{receipt:'bad/id'}])assert.equal(b.request({action:'saveFuel',id,data:{...data,...patch},create:false}).code,'invalid_argument');
  assert.equal(b.request({action:'saveFuel',id,data:{...data,receipt:'photo123',noReceipt:false,adminConfirmed:false,adminName:''},create:false}).ok,true);
  assert.equal(b.request({action:'listFuel'}).entries[0].adminConfirmedAt,null);
});

test('live receipt diagnostic exercises upload and sharing and trashes only its own probe', () => {
  const b=createBackend();
  assert.equal(b.request({action:'checkFuelReceiptStorage',key:'wrong'}).code,'bad_key');
  assert.equal(b.storage.files.size,0);
  const result=b.request({action:'checkFuelReceiptStorage'});
  assert.equal(result.ok,true);assert.match(result.message,/check passed/);
  const probe=[...b.storage.files.values()][0];assert.equal(probe.shared,true);assert.equal(probe.trashed,true);
  b.storage.failure='write';
  assert.equal(b.request({action:'checkFuelReceiptStorage'}).code,'receipt_storage_unavailable');
  assert.equal(b.request({action:'listFuel'}).entries.length,0);
});
