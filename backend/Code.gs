/**
 * Ritehome Project Tracker backend — Google Apps Script web app.
 *
 * The tracker page (tracker/index.html) keeps every project and expense in
 * the Google Sheet this script is bound to, and receipt photos in a Drive
 * folder it creates. The page POSTs JSON ({action, key, ...}) as text/plain
 * so the browser sends it without a CORS preflight, which Apps Script can't
 * answer.
 *
 * Access: every request must carry the TRACKER_KEY Script Property. The page
 * gets it from the share link (…/tracker/#key=…); it is never in the repo.
 * Run setup() once to create the sheets, the receipts folder and the key;
 * run rotateKey() to cut off every old link.
 *
 * Each row stores the full record as JSON in its last column ("Data") — that
 * column is the source of truth. The other columns only mirror a few fields
 * so the sheet is readable by a person; editing them does nothing.
 *
 * Setup: see README.md in this folder.
 */

var PROJECT_HEADERS = ["ID", "Name", "Status", "Client", "Contract price", "Budget", "Total spent", "Target date", "Updated", "Data"];
var EXPENSE_HEADERS = ["ID", "Project ID", "Date", "Item", "Category", "Amount", "Vendor / payee", "Receipt", "Head confirmed", "Updated", "Data"];
var RECEIPT_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
var MAX_RECEIPT_BYTES = 15 * 1024 * 1024;
var SHARE_URL = "https://bernadosjason-dev.github.io/ritehome-tracker/";

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return respond_({ ok: false, code: "invalid_argument", error: "Request body is not JSON." });
  }

  var denied = checkKey_(req.key);
  if (denied) return respond_(denied);

  var reads = { ping: ping_, listProjects: listProjects_, getProject: getProject_,
                uploadReceipt: uploadReceipt_, deleteReceipt: deleteReceipt_, scanReceipt: scanReceipt_ };
  var writes = { addProject: addProject_, updateProject: updateProject_, deleteProject: deleteProject_,
                 importProject: importProject_, addExpense: addExpense_, updateExpense: updateExpense_,
                 deleteExpense: deleteExpense_ };
  var action = String(req.action || "");

  try {
    if (reads.hasOwnProperty(action)) return respond_(reads[action](req));
    if (!writes.hasOwnProperty(action)) return respond_({ ok: false, code: "invalid_argument", error: "Unknown action." });

    // One writer at a time, so two phones saving at once can't overwrite each other's row.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return respond_({ ok: false, code: "resource_exhausted", error: "The tracker is busy — try again." });
    try {
      return respond_(writes[action](req));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return respond_({ ok: false, code: err.code || "unavailable", error: String(err.message || err) });
  }
}

/* Open the deployed /exec URL in a browser to check the deployment is live. */
function doGet() {
  return respond_({ ok: true, message: "Ritehome project tracker backend is running." });
}

// ---------- one-time setup & access key ----------

/* Run once from the Apps Script editor (select "setup", press Run). Creates the
   two sheets and the receipts folder, makes an access key if there isn't one,
   and logs the share link (View → Logs / Execution log). */
function setup() {
  projectsSheet_();
  expensesSheet_();
  receiptsFolder_();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("TRACKER_KEY")) props.setProperty("TRACKER_KEY", newKey_());
  Logger.log("Share this link (anyone who has it can update projects): " + SHARE_URL + "#key=" + props.getProperty("TRACKER_KEY"));
}

/* Replaces the key: every link shared so far stops working. Share the new one. */
function rotateKey() {
  PropertiesService.getScriptProperties().setProperty("TRACKER_KEY", newKey_());
  setup();
}

function newKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "").slice(0, 40);
}

function checkKey_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty("TRACKER_KEY");
  if (!expected) return { ok: false, code: "not_configured", error: "Run setup() in the Apps Script editor first." };
  if (typeof key !== "string" || key !== expected) return { ok: false, code: "bad_key", error: "Wrong or missing access key." };
  return null;
}

// ---------- actions ----------

function ping_() {
  return { ok: true };
}

function listProjects_() {
  var projects = readRows_(projectsSheet_(), PROJECT_HEADERS).map(function (r) { return withId_(r.id, r.data); });
  projects.sort(function (a, b) { return String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")); });
  return { ok: true, projects: projects };
}

function getProject_(req) {
  var id = String(req.id || "");
  var found = findRow_(projectsSheet_(), PROJECT_HEADERS, id);
  return { ok: true, project: found ? withId_(id, found.data) : null, expenses: expensesOf_(id) };
}

function addProject_(req) {
  var id = newId_("p");
  var data = objectOrThrow_(req.data);
  appendRows_(projectsSheet_(), [projectRow_(id, data)]);
  return { ok: true, id: id };
}

function updateProject_(req) {
  var sh = projectsSheet_();
  var id = String(req.id || "");
  var found = findRow_(sh, PROJECT_HEADERS, id);
  if (!found) throw codeError_("not_found", "That project no longer exists.");
  var data = deepMerge_(found.data, objectOrThrow_(req.patch));
  writeRow_(sh, found.row, projectRow_(id, data));
  return { ok: true };
}

function deleteProject_(req) {
  var id = String(req.id || "");
  var psh = projectsSheet_();
  var found = findRow_(psh, PROJECT_HEADERS, id);
  var esh = expensesSheet_();
  var mine = readRows_(esh, EXPENSE_HEADERS).filter(function (r) { return r.projectId === id; });
  deleteRows_(esh, mine.map(function (r) { return r.row; }));
  if (found) psh.deleteRow(found.row);
  mine.forEach(function (r) { if (r.data.receipt) trashReceipt_(r.data.receipt); });
  return { ok: true };
}

/* Brings in a whole project with its expenses in one call (the page's "Import"
   button). Skips a project that was already imported from the same source id. */
function importProject_(req) {
  var data = objectOrThrow_(req.data);
  var sh = projectsSheet_();
  if (data.importedFrom) {
    var dup = readRows_(sh, PROJECT_HEADERS).filter(function (r) { return r.data.importedFrom === data.importedFrom; })[0];
    if (dup) return { ok: true, id: dup.id, skipped: true };
  }
  var id = newId_("p");
  appendRows_(sh, [projectRow_(id, data)]);
  var expenses = Array.isArray(req.expenses) ? req.expenses : [];
  appendRows_(expensesSheet_(), expenses.map(function (e) { return expenseRow_(newId_("e"), id, objectOrThrow_(e)); }));
  return { ok: true, id: id, expenses: expenses.length };
}

function addExpense_(req) {
  var projectId = String(req.projectId || "");
  if (!findRow_(projectsSheet_(), PROJECT_HEADERS, projectId)) throw codeError_("not_found", "That project no longer exists.");
  var id = newId_("e");
  appendRows_(expensesSheet_(), [expenseRow_(id, projectId, objectOrThrow_(req.data))]);
  return { ok: true, id: id };
}

function updateExpense_(req) {
  var sh = expensesSheet_();
  var id = String(req.id || "");
  var found = findRow_(sh, EXPENSE_HEADERS, id);
  if (!found) throw codeError_("not_found", "That expense no longer exists.");
  writeRow_(sh, found.row, expenseRow_(id, found.projectId, deepMerge_(found.data, objectOrThrow_(req.patch))));
  return { ok: true };
}

function deleteExpense_(req) {
  var sh = expensesSheet_();
  var found = findRow_(sh, EXPENSE_HEADERS, String(req.id || ""));
  if (found) sh.deleteRow(found.row);
  return { ok: true };
}

function uploadReceipt_(req) {
  var type = String(req.mimeType || "");
  if (!RECEIPT_TYPES[type]) throw codeError_("unsupported_type", "Receipts must be JPG, PNG, WebP or GIF photos.");
  var bytes = Utilities.base64Decode(String(req.data || ""));
  if (!bytes.length) throw codeError_("invalid_argument", "The photo is empty.");
  if (bytes.length > MAX_RECEIPT_BYTES) throw codeError_("too_large", "The photo is too large.");
  var stamp = Utilities.formatDate(new Date(), "Asia/Manila", "yyyy-MM-dd HHmmss");
  var file = receiptsFolder_().createFile(Utilities.newBlob(bytes, type, "receipt " + stamp + "." + RECEIPT_TYPES[type]));
  // Viewable by link so the page can show it; the id is only handed out to key holders.
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, id: file.getId() };
}

/* Saves the photo exactly like uploadReceipt_, then asks Gemini to read it. The photo is kept even when
   the AI part fails (no key, quota, unreadable), so the page can still attach it and let the person type. */
function scanReceipt_(req) {
  var saved = uploadReceipt_(req);
  var out = { ok: true, id: saved.id, fields: null };
  try {
    out.fields = readReceiptWithAi_(String(req.data || ""), String(req.mimeType || ""));
  } catch (err) {
    out.aiError = err.code || "ai_failed";
    out.aiMessage = String(err.message || err).slice(0, 300);
  }
  return out;
}

// ---------- AI receipt reading (Gemini, Google AI Studio key in Script Properties) ----------

/* Same model list Hannah (the website chat) uses: Google renames and retires model ids, so try cheap
   Flash models first and move on when one is missing (404) or out of quota (429). GEMINI_MODEL, if set
   in Script Properties, is tried first. */
function aiModels_() {
  var models = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.1-flash"];
  var preferred = PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL");
  if (preferred) models.unshift(preferred);
  return models.filter(function (m, i, a) { return a.indexOf(m) === i; });
}

var RECEIPT_CATEGORIES = ["materials", "transportation", "food", "labor", "other"];

var RECEIPT_PROMPT = [
  "This photo should be a receipt from the Philippines: an official receipt (OR), sales invoice, charge or delivery receipt, cash slip, or fuel receipt.",
  "Read it and return JSON with:",
  "- is_receipt: false if the photo is not a receipt or bill at all.",
  "- vendor: the store or company name as printed.",
  "- date: the purchase date as YYYY-MM-DD. Philippine receipts usually print dates as MM/DD/YYYY or MM-DD-YY.",
  "- total: the final amount paid in pesos (the grand total or amount due). Not the VATable sales, VAT amount, subtotal, cash tendered or change.",
  "- ref: the OR, invoice, DR or PO number if one is printed, e.g. \"OR 004512\".",
  "- item: what was bought, in at most 8 words, e.g. \"18mm marine plywood, 14 sheets\" or \"Diesel, 40 liters\".",
  "- category: exactly one of materials (boards, hardware, fittings, paint, adhesives, tools, construction or cabinet supplies), transportation (diesel, gasoline, tolls, parking, delivery or freight), food (meals, snacks, water for the crew), labor (payments to workers), other.",
  "Use an empty string, or 0 for total, for anything you cannot read. Do not guess numbers."
].join("\n");

function readReceiptWithAi_(b64, mimeType) {
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) throw codeError_("ai_not_configured", "Add a GEMINI_API_KEY Script Property to switch on receipt reading.");
  var body = {
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: mimeType, data: b64 } }, { text: RECEIPT_PROMPT }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          is_receipt: { type: "BOOLEAN" },
          vendor: { type: "STRING" },
          date: { type: "STRING" },
          total: { type: "NUMBER" },
          ref: { type: "STRING" },
          item: { type: "STRING" },
          category: { type: "STRING" }
        },
        required: ["is_receipt", "total"]
      }
    }
  };
  var lastErr = null;
  var models = aiModels_();
  for (var i = 0; i < models.length; i++) {
    var res;
    try {
      // Key in a header, not the URL, so a network error message can't carry it back to the page.
      res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent", {
        method: "post", contentType: "application/json", headers: { "x-goog-api-key": key },
        payload: JSON.stringify(body), muteHttpExceptions: true });
    } catch (err) {
      lastErr = codeError_("ai_unavailable", "Gemini " + models[i] + ": network error");
      continue;
    }
    var status = res.getResponseCode();
    if (status === 404 || status === 429 || status === 503) {
      lastErr = codeError_(status === 404 ? "ai_unavailable" : "ai_busy", "Gemini " + models[i] + ": " + status);
      continue;
    }
    if (status !== 200) throw codeError_("ai_failed", "Gemini " + models[i] + ": " + status + " " + res.getContentText().slice(0, 200));
    var data = JSON.parse(res.getContentText());
    var parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    var text = parts.map(function (p) { return p.text || ""; }).join("").replace(/^```(?:json)?\s*|\s*```$/g, "");
    if (!text) throw codeError_("ai_failed", "Gemini " + models[i] + " returned no text.");
    return cleanReceipt_(JSON.parse(text));
  }
  throw lastErr || codeError_("ai_failed", "No Gemini model answered.");
}

/* Run this once from the editor after adding GEMINI_API_KEY. It asks for the new "connect to an external
   service" permission (the web app can't ask for it by itself) and checks the key with a tiny text request. */
function testReceiptAi() {
  var key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) throw new Error("Add GEMINI_API_KEY in Project Settings > Script Properties first.");
  var models = aiModels_();
  for (var i = 0; i < models.length; i++) {
    var res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent", {
      method: "post", contentType: "application/json", headers: { "x-goog-api-key": key }, muteHttpExceptions: true,
      payload: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with the word OK." }] }], generationConfig: { maxOutputTokens: 5 } }) });
    var status = res.getResponseCode();
    Logger.log(models[i] + ": " + status);
    if (status === 200) { Logger.log("Receipt reading is ON (model " + models[i] + "). Scan receipt will fill the form."); return; }
    if (status === 400 || status === 401 || status === 403) throw new Error("Google rejected the key (" + status + "). Copy it again from aistudio.google.com/apikey.");
  }
  throw new Error("No Gemini model answered. Wait a minute and run this again.");
}

/* Never trust the model's output shape: keep only well-formed values. */
function cleanReceipt_(r) {
  r = r || {};
  var str = function (v, max) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max); };
  var total = Math.round(Number(r.total) * 100) / 100;
  var date = str(r.date, 10);
  var category = str(r.category, 20).toLowerCase();
  return {
    isReceipt: r.is_receipt !== false,
    vendor: str(r.vendor, 80),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    total: isFinite(total) && total > 0 && total < 10000000 ? total : 0,
    ref: str(r.ref, 40),
    item: str(r.item, 80),
    category: RECEIPT_CATEGORIES.indexOf(category) >= 0 ? category : ""
  };
}

function deleteReceipt_(req) {
  trashReceipt_(String(req.id || ""));
  return { ok: true };
}

/* Only ever touches files inside the receipts folder, so a key holder can't
   trash arbitrary files in the owner's Drive by guessing ids. */
function trashReceipt_(fileId) {
  if (!fileId) return;
  var file;
  try { file = DriveApp.getFileById(fileId); } catch (err) { return; }
  var folderId = receiptsFolder_().getId();
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) { file.setTrashed(true); return; }
  }
}

// ---------- sheet storage ----------

function projectsSheet_() { return sheet_("Projects", PROJECT_HEADERS); }
function expensesSheet_() { return sheet_("Expenses", EXPENSE_HEADERS); }

function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function receiptsFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("RECEIPTS_FOLDER_ID");
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* deleted — make a new one */ }
  }
  var folder = DriveApp.createFolder("Ritehome Tracker Receipts");
  props.setProperty("RECEIPTS_FOLDER_ID", folder.getId());
  return folder;
}

/* Every data row as {row, id, projectId, data}; rows whose Data cell isn't valid JSON are skipped. */
function readRows_(sh, headers) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var data;
    try { data = JSON.parse(values[i][headers.length - 1]); } catch (err) { continue; }
    if (!data || typeof data !== "object") continue;
    out.push({ row: i + 2, id: String(values[i][0]), projectId: String(values[i][1]), data: data });
  }
  return out;
}

function findRow_(sh, headers, id) {
  if (!id) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) !== id) continue;
    var row = sh.getRange(i + 2, 1, 1, headers.length).getValues()[0];
    var data;
    try { data = JSON.parse(row[headers.length - 1]); } catch (err) { data = {}; }
    return { row: i + 2, id: id, projectId: String(row[1]), data: data || {} };
  }
  return null;
}

function appendRows_(sh, rows) {
  if (!rows.length) return;
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function writeRow_(sh, rowNum, values) {
  sh.getRange(rowNum, 1, 1, values.length).setValues([values]);
}

/* Deletes rows bottom-up so earlier deletions don't shift the later row numbers. */
function deleteRows_(sh, rowNums) {
  rowNums.slice().sort(function (a, b) { return b - a; }).forEach(function (n) { sh.deleteRow(n); });
}

function projectRow_(id, data) {
  data = stripId_(data);
  return [id, text_(data.name), text_(data.status || "active"), text_(data.clientName), num_(data.price), num_(data.budget),
          num_(data.totalSpent), text_(data.targetDate), text_(data.updatedAt), JSON.stringify(data)];
}

function expenseRow_(id, projectId, data) {
  data = stripId_(data);
  var receipt = data.receipt ? "Photo" : data.noReceipt ? "None" : "Missing";
  var confirmed = data.receipt ? "" : data.noReceipt ? (data.headConfirmed ? "Yes" : "No") : "";
  return [id, projectId, text_(data.date), text_(data.item), text_(data.category), num_(data.amount), text_(data.vendor),
          receipt, confirmed, new Date().toISOString(), JSON.stringify(data)];
}

// ---------- helpers ----------

function expensesOf_(projectId) {
  var list = readRows_(expensesSheet_(), EXPENSE_HEADERS)
    .filter(function (r) { return r.projectId === projectId; })
    .map(function (r) { return withId_(r.id, r.data); });
  list.sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
  return list;
}

/* Same rules as the page's claude.ai database: objects merge key by key, arrays and values replace. */
function deepMerge_(target, patch) {
  var out = JSON.parse(JSON.stringify(target || {}));
  Object.keys(patch).forEach(function (k) {
    var v = patch[k];
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge_(out[k], v);
    } else {
      out[k] = v === undefined ? null : JSON.parse(JSON.stringify(v));
    }
  });
  return out;
}

function objectOrThrow_(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw codeError_("invalid_argument", "Expected an object.");
  return v;
}

function withId_(id, data) {
  var out = { id: id };
  Object.keys(data).forEach(function (k) { if (k !== "id") out[k] = data[k]; });
  return out;
}

function stripId_(data) {
  var out = {};
  Object.keys(data).forEach(function (k) { if (k !== "id") out[k] = data[k]; });
  return out;
}

function newId_(prefix) {
  return prefix + "_" + Utilities.getUuid().replace(/-/g, "").slice(0, 16);
}

/* Mirror columns only: neutralise formula injection (a cell starting with =, +, -, @). */
function text_(v) {
  var s = String(v == null ? "" : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function num_(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function codeError_(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
