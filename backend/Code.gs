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
var VEHICLE_HEADERS = ["ID", "Vehicle / equipment", "Fuel type", "Plate / asset number", "Updated", "Data"];
var FUEL_HEADERS = ["ID", "Date", "Vehicle / equipment", "Fuel type", "Liters", "Cost PHP", "Driver", "Odometer km", "Station", "Notes", "Updated", "Data"];
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

  var reads = { getProcurement: getProcurement_, listVehicles: listVehicles_, listFuel: listFuel_, ping: ping_, listProjects: listProjects_, getProject: getProject_,
                uploadReceipt: uploadReceipt_, deleteReceipt: deleteReceipt_, scanReceipt: scanReceipt_ };
  var writes = { saveProcurement: saveProcurement_, checkFuelReceiptStorage: checkFuelReceiptStorage_, uploadFuelReceipt: uploadFuelReceipt_, saveVehicle: saveVehicle_, saveFuel: saveFuel_, deleteFuel: deleteFuel_, addProject: addProject_, updateProject: updateProject_, deleteProject: deleteProject_,
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

// ---------- company-wide fuel ----------

function vehiclesSheet_() { return sheet_("Company Vehicles", VEHICLE_HEADERS); }
function listVehicles_() {
  return {ok: true, vehicles: readRows_(vehiclesSheet_(), VEHICLE_HEADERS).map(function(r) { return withId_(r.id, r.data); })};
}
function saveVehicle_(req) {
  var id = String(req.id || ""), d = objectOrThrow_(req.data);
  if (!/^vehicle-[A-Za-z0-9-]{10,80}$/.test(id)) throw codeError_("invalid_argument", "A valid vehicle ID is required.");
  var name = String(d.name == null ? "" : d.name).trim(), plate = String(d.plate == null ? "" : d.plate).trim();
  if (!name || name.length > 100 || plate.length > 50) throw codeError_("invalid_argument", "Enter a vehicle name up to 100 characters and a plate up to 50 characters.");
  if (d.fuelType !== "gasoline" && d.fuelType !== "diesel") throw codeError_("invalid_argument", "Choose gasoline or diesel.");
  var sh = vehiclesSheet_(), existing = findRow_(sh, VEHICLE_HEADERS, id);
  if (req.create === true && existing) {
    if (existing.data.name !== name || existing.data.fuelType !== d.fuelType || existing.data.plate !== plate) throw codeError_("already_exists", "This vehicle was already saved. Refresh, then edit the saved vehicle.");
    return {ok: true, id: id};
  }
  if (req.create !== true && !existing) throw codeError_("not_found", "This vehicle no longer exists.");
  var duplicate = readRows_(sh, VEHICLE_HEADERS).some(function(r) { return r.id !== id && String(r.data.name || "").toLowerCase() === name.toLowerCase(); });
  if (duplicate) throw codeError_("invalid_argument", "That vehicle name already exists. Edit it, or use a distinct name or plate number.");
  var data = {name:name, fuelType:d.fuelType, plate:plate, updatedAt:new Date().toISOString()};
  var row = [id, text_(name), text_(data.fuelType), text_(plate), data.updatedAt, JSON.stringify(data)];
  if (existing) writeRow_(sh, existing.row, row); else appendRows_(sh, [row]);
  return {ok:true, id:id};
}

function checkFuelReceiptStorage_() {
  // Exercise the same destination and sharing permission as a real upload, then trash only this probe.
  var probe = uploadFuelReceipt_({uploadId:"fuelphoto-check-" + Utilities.getUuid(), mimeType:"image/png", data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWOQAAAAASUVORK5CYII="});
  try { DriveApp.getFileById(probe.id).setTrashed(true); }
  catch (err) { throw codeError_("receipt_storage_unavailable", "The receipt test photo uploaded, but cleanup failed. Ask the tracker admin to check Google Drive permissions."); }
  return {ok:true, message:"Receipt storage check passed: photo upload, sharing and cleanup work."};
}

function uploadFuelReceipt_(req) {
  var uploadId = String(req.uploadId || ""), type = String(req.mimeType || "");
  if (!/^fuelphoto-[A-Za-z0-9-]{10,80}$/.test(uploadId)) throw codeError_("invalid_argument", "A valid fuel photo upload ID is required.");
  if (!RECEIPT_TYPES[type]) throw codeError_("unsupported_type", "Use a JPG, PNG, WebP or GIF receipt photo.");
  var bytes = Utilities.base64Decode(String(req.data || ""));
  if (!bytes.length) throw codeError_("invalid_argument", "The photo is empty.");
  if (bytes.length > MAX_RECEIPT_BYTES) throw codeError_("too_large", "The photo is too large.");
  try {
    // Check the configured destination explicitly; do not silently switch folders on access errors.
    var folderId = PropertiesService.getScriptProperties().getProperty("RECEIPTS_FOLDER_ID");
    var folder = folderId ? DriveApp.getFolderById(folderId) : receiptsFolder_();
    var name = uploadId + "." + RECEIPT_TYPES[type], existing = folder.getFilesByName(name);
    var file = existing.hasNext() ? existing.next() : folder.createFile(Utilities.newBlob(bytes, type, name));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return {ok:true, id:file.getId()};
  } catch (err) {
    throw codeError_("receipt_storage_unavailable", "Receipt upload failed in Google Drive. Ask the tracker admin to check the receipt folder access, Drive space and photo-sharing permissions, then try again.");
  }
}

function fuelSheet_() { return sheet_("Company Fuel", FUEL_HEADERS); }
function listFuel_() {
  return { ok: true, entries: readRows_(fuelSheet_(), FUEL_HEADERS).map(function(r) { return withId_(r.id, r.data); }) };
}
function fuelData_(value) {
  var d = objectOrThrow_(value);
  var date = String(d.date || "");
  var parsed = new Date(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date) throw codeError_("invalid_argument", "A valid fuel date is required.");
  function textValue(name, max) {
    var v = String(d[name] == null ? "" : d[name]).trim();
    if (v.length > max) throw codeError_("invalid_argument", "Fuel " + name + " is too long.");
    return v;
  }
  if (d.fuelType !== "gasoline" && d.fuelType !== "diesel") throw codeError_("invalid_argument", "Choose gasoline or diesel.");
  if (typeof d.liters !== "number" || !isFinite(d.liters) || d.liters <= 0 || typeof d.amount !== "number" || !isFinite(d.amount) || d.amount <= 0) throw codeError_("invalid_argument", "Liters and cost must be positive numbers.");
  var odometer = d.odometer == null ? null : d.odometer;
  if (odometer !== null && (typeof odometer !== "number" || !isFinite(odometer) || odometer < 0)) throw codeError_("invalid_argument", "Odometer must be a nonnegative number.");
  var vehicle = textValue("vehicle", 100);
  if (!vehicle) throw codeError_("invalid_argument", "A vehicle or equipment name is required.");
  var receipt = d.receipt == null || d.receipt === "" ? null : String(d.receipt);
  if (receipt && !/^[A-Za-z0-9_-]{1,200}$/.test(receipt)) throw codeError_("invalid_argument", "A valid receipt photo ID is required.");
  var noReceipt = d.noReceipt === true, adminConfirmed = d.adminConfirmed === true;
  if (receipt && noReceipt) throw codeError_("invalid_argument", "A purchase cannot have a receipt photo and be marked no receipt.");
  if (adminConfirmed && (!noReceipt || receipt)) throw codeError_("invalid_argument", "Admin confirmation is only for purchases without a receipt photo.");
  var adminName = adminConfirmed ? textValue("adminName", 100) : "";
  if (adminConfirmed && !adminName) throw codeError_("invalid_argument", "Enter the admin who confirmed this purchase.");
  return {receipt:receipt, noReceipt:noReceipt, adminConfirmed:adminConfirmed, adminName:adminName, date: date, vehicle: vehicle, fuelType: d.fuelType, liters: d.liters, amount: d.amount, driver: textValue("driver", 100), odometer: odometer, vendor: textValue("vendor", 150), notes: textValue("notes", 500), updatedAt: new Date().toISOString()};
}
function saveFuel_(req) {
  var id = String(req.id || "");
  if (!/^fuel-[A-Za-z0-9-]{10,80}$/.test(id)) throw codeError_("invalid_argument", "A valid fuel entry ID is required.");
  var sh = fuelSheet_(), existing = findRow_(sh, FUEL_HEADERS, id);
  var receiptFields = {};
  ["receipt", "noReceipt", "adminConfirmed", "adminName"].forEach(function(k) { if (existing) receiptFields[k] = existing.data[k]; });
  var data = fuelData_(Object.assign(receiptFields, objectOrThrow_(req.data)));
  // A repeated create after a lost response returns the original record, without duplicates.
  if (req.create === true && existing) {
    var same = Object.keys(data).filter(function(k) { return k !== "updatedAt"; }).every(function(k) { return (data[k] === existing.data[k] || (existing.data[k] == null && (data[k] === false || data[k] === "" || data[k] === null))); });
    if (!same) throw codeError_("already_exists", "This purchase was already saved with different details. Refresh the ledger, then edit the saved purchase.");
    return {ok: true, id: id};
  }
  if (req.create !== true && !existing) throw codeError_("not_found", "This fuel purchase no longer exists.");
  data.adminConfirmedAt = data.adminConfirmed ? (existing && existing.data.adminConfirmed && existing.data.adminName === data.adminName ? existing.data.adminConfirmedAt || data.updatedAt : data.updatedAt) : null;
  var row = [id, text_(data.date), text_(data.vehicle), text_(data.fuelType), data.liters, data.amount, text_(data.driver), data.odometer == null ? "" : data.odometer, text_(data.vendor), text_(data.notes), data.updatedAt, JSON.stringify(data)];
  if (existing) writeRow_(sh, existing.row, row); else appendRows_(sh, [row]);
  return {ok: true, id: id};
}
function deleteFuel_(req) {
  var sh = fuelSheet_(), existing = findRow_(sh, FUEL_HEADERS, String(req.id || ""));
  if (existing) sh.deleteRow(existing.row);
  return {ok: true};
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

// ---------- project procurement ----------
var ProcurementLogic = (function(){
  function clean(v,max){var s=String(v==null?'':v).trim();if(s.length>max)throw Error('Text is too long (maximum '+max+' characters).');return s;}
  function number(v,zero){if(typeof v!=='number'||!Number.isFinite(v)||v<0||(!zero&&v===0))throw Error('Quantities must be valid '+(zero?'nonnegative':'positive')+' numbers.');var n=Math.round(v*1000000)/1000000;if(!Number.isFinite(n)||n>1000000000000||(!zero&&n===0))throw Error('Quantity or price is outside the supported range.');return n;}
  function date(v){v=clean(v,10);var d=new Date(v+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==v)throw Error('Enter a valid date.');return v;}
  function id(v){v=clean(v,80);if(!/^[A-Za-z0-9_-]{1,80}$/.test(v))throw Error('Invalid record ID.');return v;}
  function normalize(value){
    if(!value||!Array.isArray(value.boms)||!Array.isArray(value.orders)||value.boms.length>100||value.orders.length>500)throw Error('Invalid procurement data or too many BOMs/POs.');
    var ids={},items={},refs={},bomNames={};
    function unique(v){v=id(v);if(ids[v])throw Error('Duplicate record ID.');ids[v]=true;return v;}
    var boms=value.boms.map(function(b){
      var name=clean(b.name,100);if(!name)throw Error('BOM name is required.');if(bomNames[name.toLowerCase()])throw Error('Use a distinct reference for each BOM.');bomNames[name.toLowerCase()]=true;
      if(!Array.isArray(b.items)||!b.items.length||b.items.length>300)throw Error('Each BOM needs 1–300 material rows.');
      return {id:unique(b.id),name:name,draftsman:clean(b.draftsman,100),date:date(b.date),items:b.items.map(function(i){
        var result={id:unique(i.id),material:clean(i.material,150),spec:clean(i.spec,200),unit:clean(i.unit,30),quantity:number(i.quantity,false)};
        if(!result.material||!result.unit)throw Error('Material name and unit are required.');items[result.id]=result;return result;
      })};
    });
    var allocated={},orders=value.orders.map(function(o){
      var ref=clean(o.reference,100),supplier=clean(o.supplier,150);if(!ref||!supplier)throw Error('PO reference and supplier are required.');
      var key=ref.toLowerCase();if(refs[key])throw Error('PO reference already exists.');refs[key]=true;
      if(['requested','confirmed','cancelled'].indexOf(o.status)<0)throw Error('Choose a valid PO status.');
      if(!Array.isArray(o.lines)||!o.lines.length||o.lines.length>300)throw Error('Each PO needs at least one material.');
      var seen={};
      var lines=o.lines.map(function(l){
        var itemId=id(l.itemId);if(!items[itemId])throw Error('A PO references a missing BOM material.');if(seen[itemId])throw Error('Use one row per BOM material in a PO.');seen[itemId]=true;
        var quantity=number(l.quantity,false),received=number(l.received==null?0:l.received,true),unitPrice=number(l.unitPrice==null?0:l.unitPrice,true);
        if(received>quantity)throw Error('Received quantity cannot exceed the ordered quantity.');
        if(o.status!=='confirmed'&&received>0)throw Error('Only supplier-confirmed POs can have deliveries.');
        if(o.status!=='cancelled')allocated[itemId]=(allocated[itemId]||0)+quantity;
        return {itemId:itemId,quantity:quantity,received:received,unitPrice:unitPrice};
      });
      return {id:unique(o.id),reference:ref,supplier:supplier,date:date(o.date),status:o.status,notes:clean(o.notes,500),lines:lines};
    });
    Object.keys(allocated).forEach(function(k){if(allocated[k]-items[k].quantity>0.000001)throw Error('PO requests exceed the BOM quantity for '+items[k].material+'. Reduce/cancel another request first.');});
    return {boms:boms,orders:orders};
  }
  function summary(value,bomId){
    var rows=[];
    value.boms.forEach(function(b){if(bomId&&b.id!==bomId)return;b.items.forEach(function(i){
      var requested=0,ordered=0,received=0;
      value.orders.forEach(function(o){if(o.status==='cancelled')return;o.lines.forEach(function(l){if(l.itemId!==i.id)return;if(o.status==='requested')requested+=l.quantity;else{ordered+=l.quantity;received+=l.received;}});});
      function n(v){return Math.round(Math.max(0,v)*1000000)/1000000;}
      rows.push({bomId:b.id,bom:b.name,id:i.id,material:i.material,spec:i.spec,unit:i.unit,required:i.quantity,requested:n(requested),ordered:n(ordered),received:n(received),remaining:n(i.quantity-ordered),unallocated:n(i.quantity-ordered-requested),awaitingDelivery:n(ordered-received)});
    });});return rows;
  }
  function consolidate(rows){
    var groups={};rows.forEach(function(r){
      var key=JSON.stringify([r.material.trim().toLowerCase(),r.spec.trim().toLowerCase(),r.unit.trim().toLowerCase()]);
      if(!groups[key])groups[key]={material:r.material,spec:r.spec,unit:r.unit,boms:[],required:0,requested:0,ordered:0,received:0,remaining:0,unallocated:0,awaitingDelivery:0};
      var g=groups[key];if(g.boms.indexOf(r.bom)<0)g.boms.push(r.bom);
      ['required','requested','ordered','received','remaining','unallocated','awaitingDelivery'].forEach(function(k){g[k]=Math.round((g[k]+r[k])*1000000)/1000000;});
    });return Object.keys(groups).map(function(k){var g=groups[k];g.bom=g.boms.join(' / ');return g;});
  }
return {normalize:normalize,summary:summary,consolidate:consolidate};
})();

var PROCUREMENT_HEADERS = ["Project ID", "Revision", "Last mutation", "Updated", "Data 1", "Data 2", "Data 3", "Data 4"];
function procurementRecord_(projectId) {
  if (!findRow_(projectsSheet_(), PROJECT_HEADERS, projectId)) throw codeError_("not_found", "That project no longer exists.");
  var sh = sheet_("Procurement", PROCUREMENT_HEADERS), last = sh.getLastRow();
  if (last > 1) {
    var values = sh.getRange(2, 1, last - 1, PROCUREMENT_HEADERS.length).getValues();
    for (var i=0; i<values.length; i++) if (String(values[i][0]) === projectId) {
      try {
        var revision=Number(values[i][1]);
        if (!Number.isInteger(revision) || revision<1) throw Error("Invalid procurement revision.");
        var chunks=values[i].slice(4).map(function(chunk){chunk=String(chunk);if(chunk.indexOf("json:")!==0)throw Error("Invalid procurement data chunk.");return chunk.slice(5);});
        return {sh:sh,row:i+2,revision:revision,mutationId:String(values[i][2]),data:ProcurementLogic.normalize(JSON.parse(chunks.join("")))};
      }
      catch (err) { throw codeError_("data_loss", "Procurement records could not be read. Ask the admin to restore this project's procurement data before editing."); }
    }
  }
  return {sh:sh,row:null,revision:0,mutationId:"",data:{boms:[],orders:[]}};
}
function getProcurement_(req) {
  var record=procurementRecord_(String(req.projectId || ""));
  return {ok:true,revision:record.revision,data:record.data};
}
function saveProcurement_(req) {
  var projectId=String(req.projectId || ""), record=procurementRecord_(projectId);
  var mutationId=String(req.mutationId || "");
  if (!/^pr-[A-Za-z0-9_-]{10,80}$/.test(mutationId)) throw codeError_("invalid_argument", "A valid procurement change ID is required.");
  var data;
  try { data=ProcurementLogic.normalize(req.data); }
  catch (err) { throw codeError_("invalid_argument", err.message); }
  if (record.mutationId===mutationId) {
    if (JSON.stringify(record.data)!==JSON.stringify(data)) throw codeError_("invalid_argument", "This change ID was already used for different data.");
    return {ok:true,revision:record.revision,data:record.data};
  }
  if (!Number.isInteger(req.revision) || req.revision!==record.revision) throw codeError_("conflict", "Procurement was changed by another officer. Refresh before saving.");
  var oldItems={},newItems={};record.data.boms.forEach(function(b){b.items.forEach(function(i){oldItems[i.id]=i;});});data.boms.forEach(function(b){b.items.forEach(function(i){newItems[i.id]=i;});});
  record.data.orders.forEach(function(oldPO){
    var nextPO=data.orders.filter(function(o){return o.id===oldPO.id;})[0];
    oldPO.lines.forEach(function(line){
      if (newItems[line.itemId] && oldItems[line.itemId] && ["material","spec","unit"].some(function(k){return oldItems[line.itemId][k]!==newItems[line.itemId][k];})) throw codeError_("invalid_argument", "A material already used in a PO cannot change its name, specification or unit. Add a new BOM line for changed materials.");
      if (line.received>0 && (!nextPO || nextPO.status!=="confirmed" || !nextPO.lines.some(function(l){return l.itemId===line.itemId;}))) throw codeError_("invalid_argument", "A PO with recorded deliveries cannot be removed or cancelled. Preserve delivered material rows.");
    });
  });
  var serialized=JSON.stringify(data);
  if (serialized.length>180000) throw codeError_("resource_exhausted", "This project's procurement record is too large. Ask the admin to archive older procurement before adding more.");
  var revision=record.revision+1,row=[projectId,revision,mutationId,new Date().toISOString()];
  for(var i=0;i<4;i++)row.push("json:"+serialized.slice(i*45000,(i+1)*45000));
  record.sh.getRange(record.row || record.sh.getLastRow()+1,1,1,row.length).setValues([row]);
  return {ok:true,revision:revision,data:data};
}
