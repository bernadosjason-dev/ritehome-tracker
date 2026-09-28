# Ritehome Project Tracker

An internal tool for running Ritehome Modular Systems jobs. It covers projects and clients, 50/40/10 progress billing, pakyawan and daily-rate labor, BOM vs actual materials, and receipt photos with a "confirmed by head" flag for expenses that have no receipt.

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
