# Ritehome Project Tracker

An internal tool for running Ritehome Modular Systems jobs. It covers projects and clients, 50/40/10 progress billing, pakyawan and daily-rate labor, who owes us (with reminder messages), and receipt photos with a "confirmed by head" flag for expenses that have no receipt. **Scan receipt** reads a receipt photo with Gemini and fills in the expense form.

- **Page:** `index.html`, served by GitHub Pages at `https://bernadosjason-dev.github.io/ritehome-tracker/`
- **Data:** a Google Sheet you own, reached through the Apps Script web app in `backend/Code.gs`. Receipt photos live in a Drive folder that script creates. Setup and day-to-day operations are in [`backend/README.md`](backend/README.md).

## Access

Only the share link opens the tracker: `https://bernadosjason-dev.github.io/ritehome-tracker/#key=…`. **Anyone with that link can view and update every project.** Without the key, the page shows only a key prompt.

The key lives in the Apps Script's Script Properties. It is never stored in this repo, and this repo is public, so it must never be committed here. Each device remembers the key after its first visit, and the page removes it from the address bar. Running `rotateKey()` in the Apps Script editor cuts off every old link at once.

## Rules for changing the page

- Every save goes through `track()`. A failed save shows a red "not saved" bar with **Save again**, and edits that haven't been submitted warn before you leave the page. Don't add a write path that bypasses `track()`, and never bring back a silent local fallback: a real project was lost that way.
- The same `index.html` also runs as a claude.ai Artifact. There it uses the platform's `db`/`assets` capabilities instead of the Sheet. `makeSheetBackend()` mimics those call shapes, so new data access should go through them.
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
