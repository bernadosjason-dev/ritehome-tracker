# Ritehome Project Tracker — backend setup

The tracker page lives at `https://bernadosjason-dev.github.io/ritehome-tracker/` (`index.html`).
GitHub Pages can only serve files, so the data lives in a **Google Sheet you own**,
reached through a Google Apps Script web app (`Code.gs` in this folder). Receipt
photos go into a Drive folder the script creates.

Access works by **secret link**: `https://bernadosjason-dev.github.io/ritehome-tracker/#key=…`.
Anyone with that link can view and update every project. The bare
address without the key shows only a key prompt. The key is stored in the
script's Script Properties, never in this repo. This repo is public, so the key
must never be committed here.

## One-time setup (about 10 minutes)

1. **Create the sheet.** Go to [sheets.new](https://sheets.new) and name it
   `Ritehome Tracker Data`. Use a new sheet, not the inquiry-form sheet.
2. **Add the script.** In that sheet: **Extensions → Apps Script**. Delete the
   sample code, paste the whole of `Code.gs`, and save (disk icon).
3. **Run `setup()` once.** Pick `setup` in the function dropdown next to **Run**
   and press **Run**. Approve the permission prompt: Google asks for Sheets and
   Drive access because the data and the receipt photos live there. When it
   finishes, open **Execution log**. It prints the share link:
   `Share this link …: https://bernadosjason-dev.github.io/ritehome-tracker/#key=…`.
   Copy it and keep it somewhere private.
4. **Deploy it as a web app.** **Deploy → New deployment →** gear icon **→ Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**

   Press **Deploy** and copy the **Web app URL** (ends in `/exec`).
5. **Put the URL in the page.** In `index.html`, set
   `var TRACKER_ENDPOINT = "…/exec";` near the top of the `<script>`, then commit
   to `main`. GitHub Pages publishes it within a minute or two.
6. **Open the share link** on your phone. You should land on the dashboard with a
   green **Synced** tag.

GitHub Pages (`*.github.io`) sends no Content-Security-Policy, so nothing else needs
allowing. If this page is ever moved onto a domain that sets one, that policy needs
`connect-src https://script.google.com https://script.googleusercontent.com` and
`img-src blob: https://drive.google.com https://*.googleusercontent.com`.

## Receipt scanning (optional, about 5 minutes)

**Scan receipt** in the expense form sends the photo to Google's Gemini AI. It fills in
the category, item, amount, date, vendor and OR number. Everything stays editable,
the filled fields are highlighted, and nothing saves until someone taps **Add to ledger**.
Without a key the button still works: it attaches the photo and says reading isn't switched on.

1. Get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
   It's the same kind of key Hannah (the website chat) uses. The free tier is enough for a
   few dozen receipts a day. On the free tier, Google may use the photos to improve its
   products. Turn on billing in AI Studio if that matters for a given job.
2. In the Apps Script editor: **Project Settings** (gear) **→ Script Properties → Add script
   property**. Property: `GEMINI_API_KEY`. Value: the key. Save.
3. Pick `testReceiptAi` in the function dropdown and press **Run**. Approve the new
   permission ("connect to an external service"). The web app can't ask for that
   permission itself, so this step is required. The log should end with
   `Receipt reading is ON`.
4. **Deploy → Manage deployments →** pencil **→ Version: New version → Deploy**.

The key stays in Script Properties. It is sent to Google in a request header, never
to the page. To pin a model, add a `GEMINI_MODEL` property; otherwise the script tries
cheap Flash models in order and skips any that are retired or out of quota.

## Moving projects over from the claude.ai tracker

In the hosted tracker, open the dashboard. At the bottom, **Import projects** takes
a backup `.json` file. Importing the same project twice is skipped, not duplicated.
**Download backup** saves everything as one `.json` file. Do that before big changes.

## Day to day

- **Share access:** send the link from step 3. Each phone remembers the key after
  the first visit, and the page removes the key from the address bar.
- **Cut off access:** in the Apps Script editor run `rotateKey()`. Every old
  link stops working at once. The log prints the new link to share.
- **Look at the data:** the sheet has a **Projects** tab and an **Expenses** tab.
  The last column (**Data**) of each row is the real record, stored as JSON. The other
  columns are copies for reading. **Editing them in the sheet changes nothing**; make
  changes in the tracker.
- **Changing `Code.gs` later:** paste the new code, then **Deploy → Manage deployments →**
  pencil icon **→ Version: New version → Deploy**. That keeps the same `/exec` URL.
  A brand-new deployment gets a different URL, and the page stops connecting until
  `TRACKER_ENDPOINT` is updated.
- **Share links print the page's address from `SHARE_URL`** at the top of `Code.gs`.
  If the page ever moves, update that line so `setup()`/`rotateKey()` print the right link.

## How it behaves

- The page POSTs JSON as `text/plain`, so the browser skips the CORS preflight that
  Apps Script can't answer. Writes take a script lock, so two phones saving at the
  same moment can't overwrite each other.
- There are no live pushes. Open screens re-read every 30 seconds while the tab is
  visible, when you switch back to the tab, and right after every save.
- Receipt photos are Drive files shared **view-by-link**, so the page can show
  them. Their ids are only ever given out to people who hold the key. Deleting a
  photo or its expense moves the file to Drive's trash, where it's recoverable for 30 days. The
  script only ever trashes files inside its own receipts folder.
- Text that looks like a formula (`=`, `+`, `-`, `@` at the start) is neutralised
  in the readable columns, so an exported sheet can't run it.
- A wrong key gets a "key isn't right" screen and nothing else. The key is 40 random
  characters, so guessing it isn't practical. If you set `TRACKER_KEY` by hand in
  Script Properties instead of using `setup()`/`rotateKey()`, keep it just as long.

## Enabling the company fuel ledger

For an existing tracker, paste the updated `Code.gs` into its existing Apps Script
project, save, then **Deploy → Manage deployments → pencil → Version: New version
→ Deploy**. Keep the existing `/exec` URL and Script Properties. Deploy this backend
update before publishing the new `index.html` to GitHub Pages. No key rotation or
new Google Sheet is required.

The first authenticated fuel-ledger request creates a **Company Fuel** tab in the
same Sheet. Its final **Data** column holds each complete JSON record; the other
columns mirror it for reading, just like project and expense tabs. Make edits in
the tracker rather than in those mirrored columns. Fuel saves and deletes use
the existing script lock and require the same `TRACKER_KEY`.

After deploying, open the tracker with your private link and check that the company
fuel section says **Fuel ledger synced**. Check one purchase, edit, filtered totals
and CSV export on a test Sheet/deployment before using production data. If the page
asks you to update Apps Script, it is connected to an older backend deployment.
Company fuel is separate from project expenses and their JSON backups; export it
with the fuel section's CSV button.

### Enabling editable vehicle profiles

Vehicle management also requires the latest `Code.gs`: paste it into the existing
Apps Script project, save and redeploy a **New version** using the existing
deployment. The first authenticated vehicle request creates **Company Vehicles**
in the same Sheet. It stores vehicle/equipment name, fuel type, optional plate or
asset number and the complete JSON record. Vehicle profile saves use the existing
access-key validation and script lock.

After redeploying, reload the page, open **Manage vehicles & fuel types**, and check
for **Vehicle list synced**. Add Wigo with Gasoline and Van with Diesel; choosing
each in a new purchase should fill the matching fuel type. Editing vehicle details
does not rewrite existing fuel purchases.

### Fuel receipt uploads and storage verification

Redeploy the latest `Code.gs` in the existing Apps Script deployment to enable
`uploadFuelReceipt` and `checkFuelReceiptStorage`. The page uploads fuel photos
to the same folder identified by **RECEIPTS_FOLDER_ID** in Script Properties.
Run `setup()` from the Apps Script editor if Drive permissions have not yet been
authorized. Preserve the folder property and existing access key.

After redeploying, open the fuel section and press **Check receipt uploads**. It
tests creating and sharing a small PNG in the configured folder and moves that
test photo to trash. Expect **Receipt storage check passed** before relying on
uploads. Then test attaching and viewing a receipt on a test purchase. Folder
access errors do not silently redirect uploads to a different folder. If the check
fails, verify the deployment executes as the Sheet owner, that owner can access
the configured folder, Drive has space, and organizational policy allows link
sharing. The photo and form stay available after a failed upload.

Fuel receipt and admin-confirmation metadata are stored in the final JSON **Data**
column without changing the existing Company Fuel column layout. Confirmation
requires no-photo status and an admin name; the backend records its timestamp.
Fuel uploads use the existing access key and write lock, with stable upload IDs
so a retried upload reuses its photo. Removing/replacing a fuel receipt or deleting
a fuel purchase leaves its Drive file intact.

## Enabling BOM and procurement tracking

Replace the existing script with the latest **complete Code.gs**, save and edit
the existing web app deployment to publish a **New version**. Keep the existing
`/exec` URL, Sheet and Script Properties. The browser also serves the repository's
new `procurement.js`; GitHub Pages includes it automatically.

Open a saved project. Its **Procurement · BOMs & purchase orders** card should
say **Procurement synced**. The authenticated `getProcurement` and locked
`saveProcurement` actions store one project record in a new **Procurement** tab.
The data uses four prefixed JSON chunks to stay below individual Sheet cell limits
and avoid formula interpretation. Do not edit those columns manually.

Supplier-confirmed orders reduce the remaining-to-procure quantity; PO requests
reserve quantities but stay unconfirmed. Received quantities are tracked separately.
The backend rejects over-allocation, invalid quantities, deliveries exceeding the
PO, duplicate references, stale revisions and changes to material identity used in
POs. Confirmed orders with recorded deliveries cannot be removed or cancelled.

This is a shared-key workflow, without a distinct procurement-officer login or
formal PO approval/signature step. It does not write procurement totals into the
expense ledger. Download the procurement JSON backup from the project card; the
existing projects backup does not contain this separate tab.

Live Google deployment and authentication must be checked from your browser.
Local tests emulate the backend; they do not prove the deployed script is updated.
