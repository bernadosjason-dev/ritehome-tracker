const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function createBackend() {
  const sheets = new Map();
  let locks = 0;
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
    PropertiesService: {getScriptProperties: () => ({getProperty: name => name === 'TRACKER_KEY' ? 'test-only-key' : null})},
    LockService: {getScriptLock: () => ({tryLock(){locks++;return true;},releaseLock(){locks--;}})},
    ContentService: {MimeType:{JSON:'application/json'},createTextOutput: text => ({setMimeType:()=>text})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../backend/Code.gs'),'utf8'),context);
  return {sheets, context, request(req){const result=JSON.parse(context.doPost({postData:{contents:JSON.stringify({key:'test-only-key',...req})}}));assert.equal(locks,0,'write lock released');return result;}};
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
