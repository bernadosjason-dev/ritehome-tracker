# Ritehome Project Tracker

An internal tool for running Ritehome Modular Systems jobs. It covers projects and clients, 50/40/10 progress billing, pakyawan and daily-rate labor, who owes us (with reminder messages), and receipt photos with a "confirmed by head" flag for expenses that have no receipt. **Scan receipt** reads a receipt photo with Gemini and fills in the expense form.

- **Directory:** `index.html`; tracker workspaces use `tracker.html?portal=fuel`, `tracker.html?portal=projects` and `tracker.html?portal=procurement`, served by GitHub Pages at `https://bernadosjason-dev.github.io/ritehome-tracker/`
- **Data:** a Google Sheet you own, reached through the Apps Script web app in `backend/Code.gs`. Receipt photos live in a Drive folder that script creates. Setup and day-to-day operations are in [`backend/README.md`](backend/README.md).

## Access

Only the share link opens the tracker: `https://bernadosjason-dev.github.io/ritehome-tracker/#key=…`. **Anyone with that link can view and update every project.** Without the key, the page shows only a key prompt.

The key lives in the Apps Script's Script Properties. It is never stored in this repo, and this repo is public, so it must never be committed here. Each device remembers the key after its first visit, and the page removes it from the address bar. Running `rotateKey()` in the Apps Script editor cuts off every old link at once.

## Rules for changing the page

- Every save goes through `track()`. A failed save shows a red "not saved" bar with **Save again**, and edits that haven't been submitted warn before you leave the page. Don't add a write path that bypasses `track()`, and never bring back a silent local fallback: a real project was lost that way.
- The same `tracker.html` also runs as a claude.ai Artifact. There it uses the platform's `db`/`assets` capabilities instead of the Sheet. `makeSheetBackend()` mimics those call shapes, so new data access should go through them.
- The page is `noindex`. Keep the link private.
- **Bump `PAGE_VERSION`** near the top of the script on every change. Open tabs compare it with the published page and show a "newer version — Reload now" bar. Without the bump, phones can keep running the old page for days.

## Company fuel tracker

The dashboard has a separate company-wide gasoline/diesel ledger for vehicles and
equipment. Record the date, vehicle or equipment name, fuel type, liters and total
cost in pesos; driver/operator, odometer, station and notes are optional. Entries
can be edited or deleted. Month, vehicle and fuel-type filters control the displayed
records, liters and spending totals, and the CSV export. Clear the month to see all
dates. Totals measure fuel purchased; odometer readings alone do not establish
actual consumption or km/L. Company fuel purchases do not change project budgets.

The hosted ledger uses the same private access key as projects and stores records
in a new **Company Fuel** Sheet tab. Update the Apps Script deployment before
publishing the new page; see backend/README.md. In a Claude Artifact, records use
the database's `companyFuel` collection. Failed saves retain form inputs and show
the existing save warning; retrying a hosted create does not duplicate it.

**Download projects backup** continues to export projects and their expenses.
Export company fuel separately with **Export filtered CSV**; clear all filters
to export the complete company fuel ledger. The CSV is a report, not a tracker
import file.

Run the fuel backend regression checks with `node --test tests/fuel.test.cjs`.
These tests emulate Google Sheets and Apps Script services locally; they do not
contact the production deployment.

### Vehicle names and default fuel types

Open **Manage vehicles & fuel types** in the company fuel section to add or edit
vehicles, their default fuel type and an optional plate/asset number. For example,
add **Wigo** with **Gasoline** and **Van** with **Diesel**. Saved vehicles appear in
the purchase form's vehicle suggestions even before their first fuel purchase.
Selecting a saved vehicle fills its fuel type for a new purchase. You can still
enter an equipment name manually and choose a fuel type. Give vehicles distinct
names (include their plate number when several are the same model).

Vehicle profiles are shared through the **Company Vehicles** Sheet tab (or the
`companyVehicles` collection in a Claude Artifact), rather than device storage.
Editing a profile changes the suggestions and default for future purchases; past
purchases retain the name and fuel type recorded at the time. These records remain
in the ledger, filters and CSV under their original names.

### Fuel receipts and admin confirmation

Fuel purchases can include a receipt photo (JPG, PNG, WebP or GIF). Choose a file
to preview it; it uploads when the purchase is saved. **View receipt** opens the
saved photo. Photos can be replaced or removed when editing a purchase. If an
upload or save fails, the form and photo stay available for retry.

Without a photo, select **No receipt photo available**. **Confirmed by admin**
requires the confirming admin's name and stores the confirmation date. Leave it
unchecked until reviewed; the ledger displays **Awaiting admin confirmation**.
Confirmation is a recorded attestation under the shared tracker key, not a separate
admin login. Receipt status, Drive file ID and confirmation details are included
in the fuel CSV export. Existing purchases remain compatible.

The hosted app uses the existing Google Drive receipts folder, not a storage
bucket. After updating the Apps Script deployment, use **Check receipt uploads**
to test an actual image upload, view-by-link sharing and cleanup in that folder.
The diagnostic creates and trashes only its own temporary test photo. A passing
local mock test does not establish live Drive readiness. Upload errors report
folder-access, capacity or sharing problems without saving an incomplete purchase.
Removed or replaced fuel photos remain in Drive rather than deleting files that
might be referenced elsewhere.

Backend tests: `node --test tests/fuel.test.cjs`. Browser regression checks:
start `python3 -m http.server 8000 --bind 127.0.0.1` in the repository, then run
`node tests/fuel.browser.cjs` with Playwright and `/usr/bin/chromium` installed.
The browser checks use local simulated Apps Script/Drive services; no production
records or photos are written.

The fuel ledger also has a **Specific date** filter for day/month/year selection.
Choosing a day clears the month filter; choosing a month clears the day filter.
Clear both to view all dates. Totals and CSV export follow the selected day.

## Connection and save troubleshooting

**Can't save here** means the hosted page could not connect to its Google backend,
so editing remains disabled. Check the Web app `/exec` URL in the existing Apps
Script deployment; it must match `TRACKER_ENDPOINT` in the page. Deploy as the
owner with access set to **Anyone**. A GitHub Pages URL ending in `/exec` is not
a backend URL. The connection banner distinguishes HTTP errors, sign-in/error
pages and network failures, with **Retry connection** and **Check backend link**
controls. Once the connection and relevant ledger reads succeed, editing unlocks.

Fuel and vehicle failed saves are tracked by record identity: a successful manual
resubmission clears the old retry, and clearing a failed form discards its queued
retry. This prevents an obsolete retry from restoring discarded form details.

Additional project calculation checks: `node --test tests/tracker-logic.test.cjs`.
They cover billing allocations/withheld tax, category totals, receipt counts,
contract/daily labor totals and date boundaries. Local logic checks do not prove
that a particular live deployment is reachable or authorized.

## Procurement officer workflow

Open the **Procurement portal** and press **Start procurement** to create an
independent procurement job. Name the client, site or requirement; it is not
a general project and has no billing/profit card. Then open **Procurement · BOMs
& purchase orders**. The same job can have several distinct BOM references, such as BOM 01 through
BOM 05. Enter the draftsman's name, BOM date and material rows: material, exact
specification/size, unit and required quantity. Choose **Upload a BOM from Excel**
to select or drop an `.xlsx` workbook (up to 5 MB). The selected worksheet's
positive-quantity materials fill the editable table immediately. Review the rows
and click **Save BOM** to persist them; choosing a file alone does not save.
Alternatively, type rows or paste four columns from Excel in that order, without
a header.

The reader handles Ritehome's sectioned BOM layout and simple tables with
Material, Specification, Quantity and Unit headers. Thickness, item codes, brand,
dimensions and category are preserved in the specification. Zero/empty quantities,
subtotals, prices and totals do not become purchase quantities. Hidden sheets are
excluded; visible worksheets stay separate so unrelated clients' materials do not
mix. Switching worksheets replaces only the current imported rows, retaining
manual rows and asking before replacing edited imported rows. Name each saved
BOM distinctly. The workbook filename suggests the BOM reference; an explicit
MM/DD/YYYY date near the sheet heading fills the date field when it is still at
its default. Review both before saving.

Files are decoded locally with the vendored ZIP reader in `vendor/`. No original
workbook is sent to Google Drive or committed to GitHub, and no new upload bucket
or sharing permission is required. Only the reviewed material rows and BOM fields
go through the existing authenticated, revision-checked Google Sheet save. The
importer adds no backend actions or deployment requirement beyond the existing
independent-procurement backend. It supports `.xlsx`, not PDF/image OCR or legacy
`.xls`; save those as `.xlsx` first. It reads saved formula results without
executing formulas; missing/error results require recalculation in Excel. Invalid
or oversized files keep the existing form intact (300 materials/BOM, 10,000
worksheet rows, 100 columns and 20 MB expanded XML limits).

Run `node tests/bom-import.browser.cjs` for Excel decoding, worksheet separation,
import/replacement protection, drag/drop and simulated Google Sheets permission/
capacity failures and recovery. These local checks do not prove production Google
Sheet permissions. On the live portal, open a job, import a workbook and select
**Save BOM**, then refresh to verify the saved materials. Failed saves retain the
rows for retry.

Create one PO per supplier, with its own PO reference, date and status. Each PO
line selects the exact BOM material and the quantity that supplier can provide.
A PO can cover lines from several BOMs. Start with **PO requested**, then change
to **Supplier confirmed** once the supplier accepts it. Unit prices are optional
(default zero). Print the PO from its card when needed. This does not implement
a separate approval/signature process or automatically add expenses.

For a 24-sheet BOM, a confirmed 16-sheet PO to Supplier A leaves **8 sheets still
to procure**. A second 8-sheet request to Supplier B reserves that balance but
does not count as confirmed procurement until the supplier accepts it. The
summary separates required, requested, confirmed, received, still-to-procure,
not-yet-allocated and awaiting-delivery quantities. Quantities reserved in active
POs cannot exceed the BOM requirement; cancelled undelivered orders free their
allocation. Record cumulative received quantities by editing confirmed POs.

The summary can show one BOM or all BOMs. Identical material/specification/unit
combinations are consolidated by default; turn that option off to see each BOM
line. Different specifications and units stay separate. Use consistent wording
for matching materials. The CSV export follows that summary view.

**Download procurement backup** exports the full BOM/PO data as JSON. Procurement
is separate from the existing projects/expenses backup and company fuel ledger.
The JSON is an archival export; a restore/import UI is not included.

Procurement writes use the shared access key and a locked, revision-checked
Google Sheets record. If another officer saves first, your stale save is rejected
and your form remains available: refresh procurement, review the latest quantities
and save again. Replayed saves reuse their change ID. Existing PO material names,
specifications and units cannot be silently changed by editing a BOM; create a
new material line for changed specifications. POs with recorded deliveries cannot
be removed or cancelled.

Redeploy the latest backend/Code.gs in the existing Google Apps Script deployment
to enable procurement. The first authenticated request creates a **Procurement**
Sheet tab; no new Drive bucket/folder or API key is required. Procurement currently
uses the hosted Google backend; the Claude Artifact database path is not supported.

Checks: `node --test tests/procurement.test.cjs tests/tracker-logic.test.cjs`, then
`node tests/procurement.browser.cjs` with the local HTTP server, Playwright and
Chromium available. Tests use simulated Sheets services and do not modify live
company records.

## Interface and UI checks

The workspace toolbar jumps to the current screen's sections: Projects,
Receivables and Company fuel on the dashboard; Overview, Procurement and Expenses
inside a project. Local SVG icons supplement visible button labels, including
actions generated by live updates. The shared presentation in ui.css/ui.js supports
dark mode, reduced motion, keyboard focus and phone touch sizes without replacing
the tracker's existing data handlers.

Run `node tests/ui.browser.cjs` with the local HTTP server, Playwright and Chromium
available to check contextual shortcuts, access-gate behavior, static/dynamic
icons, fuel saving, phone overflow/touch sizes and dark mode. Receipt/Drive failure
handling is also exercised by tests/fuel.browser.cjs; those local simulations do
not prove live storage readiness.

## Portal directory

The site home page now lists three focused portals: **Fuel**, **Projects** and
**Procurement**. They share the existing Google backend and stored access key.
The fuel portal opens directly to vehicles, purchase records and receipt photos.
Projects contains client jobs, schedules, billing, labor and expenses. Procurement
has its own independently created jobs and opens each job's BOM/PO workspace.
Use **All portals** in the header to return to the directory. The separate views
do not add new user roles or change the shared-key permissions.

Existing `#key=...` share links and `#p=...` project bookmarks at the site root
redirect to the project portal. The tracker removes keys from the address bar as
before. Key storage remains on the same origin, so signed-in devices need no new
key. Version reloads preserve the selected portal. Direct `tracker.html` access
without a portal parameter retains the combined workspace for compatibility.

The fuel receipt chooser now has a styled photo card, a keyboard-accessible
**Choose receipt photo** button, selected filename and a **Change photo** action.
It uses the existing Drive upload, photo validation, save/retry and admin-confirmation
logic. Local failure-path tests pass; live Drive readiness must still be checked
using **Check receipt uploads** in the fuel portal.

Run the local server from this repository. The root URL serves the directory;
`/tracker.html` serves the compatibility workspace used by the existing browser
suites. `node tests/portals.browser.cjs` verifies the directory, focused views,
shared key, legacy links and portal-preserving version reload.

### Starting independent procurement

General projects and their budget, profit, billing and completed-project cards
do not appear in Procurement. Its job metadata lives in a separate **Procurement
Jobs** Sheet tab. Creating, editing or closing a procurement job does not create
or update a general project. Each job keeps its own BOM/PO snapshot in the existing
Procurement tab, under an independent `pj-...` ID.

To begin: **Start procurement → name the job/client/site → Create job & add BOM**.
Inside the job, **Add first BOM** opens the BOM form. After saving it, **Create
supplier PO** opens the next step. Then use the remaining-material summary and
record confirmations/deliveries. First-time guidance collapses once jobs exist so
the job list stays easy to reach. **Edit job** changes its name/client or Open/Closed
status; the job list contains procurement details rather than project finances.

This change requires publishing a new version of the latest backend/Code.gs in the
existing Apps Script deployment. Existing general projects and legacy project-linked
BOM/PO data are preserved; they are not automatically imported into independent
jobs. The compatibility workspace at `tracker.html#p=...` can still open legacy
project-linked procurement data when needed.

`node tests/procurement-jobs.browser.cjs` checks independent job creation, no general
project reads/cards, the first BOM/PO steps, retries, remaining quantities, closing
and reload persistence.
