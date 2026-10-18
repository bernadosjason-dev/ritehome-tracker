const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createBackend} = require('./fuel.test.cjs');

// Receipt scanning = save the photo (uploadReceipt_) + ask Gemini to read it (readReceiptWithAi_).
// These tests never contact Google: UrlFetchApp is a local fake that answers like the Gemini API.
const PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII=', 'base64');
const READ = {is_receipt:true, vendor:'CitiHardware Kauswagan', date:'2026-09-27', total:12450.5, ref:'OR 004512', item:'18mm marine plywood, 14 sheets', category:'materials'};
const FAKE_KEY = 'gemini-test-only-key';

function geminiReply(read) {
  const text = typeof read === 'string' ? read : JSON.stringify(read);
  return {status:200, body:{candidates:[{content:{parts:[{text}]}}]}};
}

/* Codex's createBackend() plus what scanning needs: a fake Gemini, unique upload names,
   Drive parents (so replaced photos can be trashed) and Logger for testReceiptAi(). */
function createScanBackend({geminiKey = FAKE_KEY, replies = [geminiReply(READ)]} = {}) {
  const b = createBackend();
  const props = b.context.PropertiesService.getScriptProperties();
  if (geminiKey) props.setProperty('GEMINI_API_KEY', geminiKey);
  let stamp = 0;
  b.context.Utilities.formatDate = () => 'test-' + (++stamp);
  const folder = b.context.DriveApp.getFolderById('test-receipts-folder');
  const createFile = folder.createFile;
  folder.createFile = function (blob) {
    const file = createFile.call(this, blob);
    file.getParents = () => { let read = false; return {hasNext: () => !read, next: () => { read = true; return folder; }}; };
    return file;
  };
  // Real DriveApp throws for an unknown id; b.outside holds files that live in some other folder.
  b.outside = {};
  const getFileById = b.context.DriveApp.getFileById;
  b.context.DriveApp.getFileById = id => {
    const file = getFileById(id) || b.outside[id];
    if (!file) throw Error('No item with the given ID could be found.');
    return file;
  };
  const gemini = {calls:[], replies};
  b.context.UrlFetchApp = {fetch(url, options) {
    const body = JSON.parse(options.payload);
    gemini.calls.push({url, model:(url.match(/models\/([^:]+):/) || [])[1], headers:options.headers || {}, body});
    const reply = gemini.replies.length > 1 ? gemini.replies.shift() : gemini.replies[0];
    if (reply instanceof Error) throw reply;
    return {getResponseCode: () => reply.status, getContentText: () => JSON.stringify(reply.body)};
  }};
  b.logs = [];
  b.context.Logger = {log: message => b.logs.push(String(message))};
  b.gemini = gemini;
  b.scan = (extra = {}) => b.request({action:'scanReceipt', mimeType:'image/png', data:PHOTO.toString('base64'), ...extra});
  b.fileById = id => [...b.storage.files.values()].find(f => f.id === id);
  return b;
}

test('scan saves the photo and returns what Gemini read, without adding an expense', () => {
  const b = createScanBackend();
  const res = b.scan();
  assert.equal(res.ok, true);
  assert.deepEqual(res.fields, {isReceipt:true, vendor:'CitiHardware Kauswagan', date:'2026-09-27', total:12450.5, ref:'OR 004512', item:'18mm marine plywood, 14 sheets', category:'materials'});
  const file = b.fileById(res.id);
  assert.ok(file, 'photo stored in the receipts folder');
  assert.equal(file.shared, true, 'photo is view-by-link so the page can show it');
  assert.deepEqual(Buffer.from(file.blob.bytes), PHOTO);
  assert.equal(b.sheets.has('Expenses'), false, 'nothing is written to the ledger until the person taps Add to ledger');
});

test('the Gemini key travels in a header, never in the URL, with the photo inline and a JSON schema', () => {
  const b = createScanBackend();
  b.scan();
  assert.equal(b.gemini.calls.length, 1);
  const call = b.gemini.calls[0];
  assert.equal(call.headers['x-goog-api-key'], FAKE_KEY);
  assert.doesNotMatch(call.url, /key=/);
  assert.equal(call.model, 'gemini-3.5-flash-lite');
  const parts = call.body.contents[0].parts;
  assert.equal(parts[0].inlineData.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(parts[0].inlineData.data, 'base64'), PHOTO);
  assert.match(parts[1].text, /Philippines/);
  assert.equal(call.body.generationConfig.temperature, 0);
  assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(call.body.generationConfig.responseSchema.required, ['is_receipt', 'total']);
});

test('without GEMINI_API_KEY the photo is still saved and the page is told reading is off', () => {
  const b = createScanBackend({geminiKey:null});
  const res = b.scan();
  assert.equal(res.ok, true);
  assert.ok(b.fileById(res.id));
  assert.equal(res.fields, null);
  assert.equal(res.aiError, 'ai_not_configured');
  assert.equal(b.gemini.calls.length, 0);
});

test('a retired or rate-limited model falls through to the next one; GEMINI_MODEL is tried first', () => {
  let b = createScanBackend({replies:[{status:404, body:{}}, geminiReply(READ)]});
  assert.equal(b.scan().fields.total, 12450.5);
  assert.deepEqual(b.gemini.calls.map(c => c.model), ['gemini-3.5-flash-lite', 'gemini-3.6-flash']);

  b = createScanBackend();
  b.context.PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', 'gemini-pinned');
  b.scan();
  assert.equal(b.gemini.calls[0].model, 'gemini-pinned');
});

test('quota, outage and errors keep the photo, report a code and never leak the Gemini key', () => {
  let b = createScanBackend({replies:[{status:429, body:{error:'quota'}}]});
  let res = b.scan();
  assert.equal(res.ok, true);
  assert.ok(b.fileById(res.id));
  assert.equal(res.aiError, 'ai_busy');
  assert.equal(b.gemini.calls.length, 3, 'each fallback model is tried once');

  b = createScanBackend({replies:[new Error('Address unavailable: https://generativelanguage.googleapis.com/?key=' + FAKE_KEY)]});
  res = b.scan();
  assert.equal(res.aiError, 'ai_unavailable');
  assert.ok(b.fileById(res.id));
  assert.doesNotMatch(JSON.stringify(res), new RegExp(FAKE_KEY));

  b = createScanBackend({replies:[{status:500, body:{error:'boom'}}]});
  res = b.scan();
  assert.equal(res.aiError, 'ai_failed');
  assert.equal(b.gemini.calls.length, 1, 'a hard error does not burn quota on other models');
  assert.doesNotMatch(JSON.stringify(res), new RegExp(FAKE_KEY));
});

test('model output is shape-checked: bad values are dropped, fenced JSON is read, non-receipts are flagged', () => {
  let b = createScanBackend({replies:[geminiReply({is_receipt:true, vendor:'  Hardware   Store ', date:'27/09/2026', total:-5, ref:'x'.repeat(200), item:'', category:'bribes'})]});
  assert.deepEqual(b.scan().fields, {isReceipt:true, vendor:'Hardware Store', date:'', total:0, ref:'x'.repeat(40), item:'', category:''});

  b = createScanBackend({replies:[geminiReply('```json\n' + JSON.stringify(READ) + '\n```')]});
  assert.equal(b.scan().fields.total, 12450.5);

  b = createScanBackend({replies:[geminiReply({is_receipt:false, total:0})]});
  assert.equal(b.scan().fields.isReceipt, false);

  b = createScanBackend({replies:[geminiReply('not json at all')]});
  const res = b.scan();
  assert.equal(res.ok, true, 'unreadable model output still keeps the photo');
  assert.equal(res.fields, null);
  assert.ok(res.aiError);
});

test('bad requests are refused before any photo is stored or any AI call is paid for', () => {
  const b = createScanBackend();
  assert.equal(b.scan({key:'wrong-key'}).ok, false);
  assert.equal(b.scan({mimeType:'text/html'}).code, 'unsupported_type');
  assert.equal(b.scan({data:''}).code, 'invalid_argument');
  assert.equal(b.scan({data:Buffer.alloc(15 * 1024 * 1024 + 1).toString('base64')}).code, 'too_large');
  assert.equal(b.gemini.calls.length, 0);
  assert.equal(b.storage.files.size, 0);
});

test('a replaced scan photo can be trashed, but only inside the receipts folder', () => {
  const b = createScanBackend();
  const first = b.scan().id;
  assert.equal(b.request({action:'deleteReceipt', id:first}).ok, true);
  assert.equal(b.fileById(first).trashed, true);
  assert.equal(b.request({action:'deleteReceipt', id:'no-such-file'}).ok, true, 'unknown ids are ignored');
  const other = {trashed:false, setTrashed(v) { this.trashed = v; },
    getParents: () => { let read = false; return {hasNext: () => !read, next: () => { read = true; return {getId: () => 'owners-private-folder'}; }}; }};
  b.outside['owners-other-file'] = other;
  assert.equal(b.request({action:'deleteReceipt', id:'owners-other-file'}).ok, true);
  assert.equal(other.trashed, false, 'a key holder cannot trash files outside the receipts folder');
});

test('testReceiptAi() reports a working key, a rejected key and a missing key', () => {
  let b = createScanBackend({replies:[geminiReply('OK')]});
  b.context.testReceiptAi();
  assert.match(b.logs.join('\n'), /Receipt reading is ON/);
  assert.equal(b.gemini.calls[0].headers['x-goog-api-key'], FAKE_KEY);

  b = createScanBackend({replies:[{status:403, body:{}}]});
  assert.throws(() => b.context.testReceiptAi(), /rejected the key/);

  b = createScanBackend({geminiKey:null});
  assert.throws(() => b.context.testReceiptAi(), /Add GEMINI_API_KEY/);
});

module.exports = {createScanBackend, geminiReply, PHOTO, READ};
