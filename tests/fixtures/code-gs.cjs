// Runs the real backend/Code.gs in a Node VM with in-memory stand-ins for Sheets,
// Drive and the script lock. Same emulator as tests/fuel.test.cjs, plus the few
// Drive/Utilities calls the project and receipt actions use.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createCodeGs() {
  const sheets = new Map();
  let locks = 0;
  const files = new Map();
  const properties = new Map([['TRACKER_KEY', 'test-only-key'], ['RECEIPTS_FOLDER_ID', 'test-receipts-folder']]);
  const folder = {
    getId: () => 'test-receipts-folder',
    getFilesByName(name) { const f = [...files.values()].find(x => x.blob.name === name && !x.trashed); let read = false; return {hasNext: () => !!f && !read, next() { read = true; return f; }}; },
    createFile(blob) {
      const file = {id: 'receipt_' + (files.size + 1), blob, trashed: false,
        setTrashed(v) { this.trashed = v; }, getId() { return this.id; }, setSharing() {},
        getParents() { let read = false; return {hasNext: () => !read, next() { read = true; return folder; }}; }};
      files.set(file.id, file); return file;
    }
  };
  function sheet() {
    const rows = [];
    return {
      rows, getLastRow: () => rows.length,
      getRange(row, col, height, width) {
        return {
          getValues: () => Array.from({length: height}, (_, i) => Array.from({length: width}, (_, j) => rows[row + i - 1]?.[col + j - 1] ?? '')),
          setValues(values) { values.forEach((r, i) => { rows[row + i - 1] ||= []; r.forEach((v, j) => { rows[row + i - 1][col + j - 1] = v; }); }); return this; },
          setFontWeight() { return this; }
        };
      },
      setFrozenRows() {}, deleteRow(row) { rows.splice(row - 1, 1); }
    };
  }
  const context = vm.createContext({
    SpreadsheetApp: {getActiveSpreadsheet: () => ({getSheetByName: n => sheets.get(n), insertSheet(n) { const s = sheet(); sheets.set(n, s); return s; }})},
    PropertiesService: {getScriptProperties: () => ({getProperty: n => properties.get(n) || null, setProperty: (n, v) => properties.set(n, v)})},
    Utilities: {getUuid: () => crypto.randomUUID(), base64Decode: d => Array.from(Buffer.from(d, 'base64')), newBlob: (bytes, type, name) => ({bytes, type, name}), formatDate: () => '2026-11-08 120000'},
    DriveApp: {Access: {ANYONE_WITH_LINK: 'anyone'}, Permission: {VIEW: 'view'},
      getFileById(id) { const f = files.get(id); if (!f) throw Error('No such file'); return f; },
      getFolderById() { return folder; }, createFolder: () => folder},
    LockService: {getScriptLock: () => ({tryLock() { locks++; return true; }, releaseLock() { locks--; }})},
    ContentService: {MimeType: {JSON: 'application/json'}, createTextOutput: text => ({setMimeType: () => text})}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../backend/Code.gs'), 'utf8'), context);
  return {
    sheets, files,
    request(req) {
      const out = JSON.parse(context.doPost({postData: {contents: JSON.stringify({key: 'test-only-key', ...req})}}));
      if (locks !== 0) throw Error('write lock not released');
      return out;
    }
  };
}
module.exports = {createCodeGs};
