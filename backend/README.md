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
