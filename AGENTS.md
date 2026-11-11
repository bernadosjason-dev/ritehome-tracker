# Tracker development instructions

Follow the application rules in README.md, including `track()` for database writes
and bumping `PAGE_VERSION` whenever tracker.html changes. index.html is the portal directory; keep versioned asset URLs current for UI and directory changes.

The owner requires storage verification whenever upload controls are added or
changed. Identify the actual destination and check its configured storage access,
write permission, sharing permission, file limits and error handling. This tracker
uses a Google Drive receipt folder rather than an object-storage bucket. Exercise
success, permission/capacity failures and retries; retain form data on failures.
Verify real storage when authorized runtime access is available. If live access
is unavailable, state that limitation and provide a usable live storage check;
never describe simulated tests as proof of live storage readiness.

Procurement validation lives in procurement.js and is embedded in backend/Code.gs
so the complete Apps Script remains deployable by copying one file. Keep the core
validation functions identical; the procurement tests detect drift. Test split
supplier quantities, five BOMs, over-allocation, deliveries, cancellation, revision
conflicts and replayed writes when changing procurement. Procurement uses Google
Sheets. XLSX selection/drop is decoded locally by bom-import.js with vendored
fflate; only reviewed material rows are saved. There is no raw BOM document
storage or PDF/image OCR. Preserve this distinction and test workbook import with
tests/bom-import.browser.cjs. Never commit customer workbooks as public fixtures.

Keep portal URLs and version reloads compatible with the shared access key.
Fuel/project/procurement views share tracker.html; do not duplicate business logic
per portal. Preserve root #key share links through landing.js and test the
three portals with tests/portals.browser.cjs after navigation changes.

Procurement uses independently created jobs in the Procurement Jobs tab; never
automatically list or clone general Projects in that portal. Preserve legacy
project-linked BOM/PO records. Test separation plus Start procurement → first BOM
→ supplier PO using tests/procurement-jobs.browser.cjs after changes.

Receipt scanning (Scan receipt in the project expense form) saves the photo through
`uploadReceipt_` and reads it with Gemini via `scanReceipt_`; the GEMINI_API_KEY stays in
Script Properties and goes to Google in a header, never to the page. After changing the
expense form, receipt uploads or the scan backend, run `node --test tests/receipt-scan.test.cjs`
and `node tests/receipt-scan.browser.cjs`. Scanning must never save an expense by itself.

Supabase backend: `tracker.html` (BACKEND = "supabase") signs people in with Supabase
Auth and runs every Code.gs action through `supabase-backend.js`. Keep the two in step:
`node --test tests/supabase-backend.test.cjs` sends the same requests to Code.gs (emulated)
and to the port and fails on any difference in the reply; the only deliberate difference is
documented in that file. `node tests/supabase-login.browser.cjs` covers the sign-in gate,
role routing and real saves against `tests/fixtures/fake-supabase.cjs`. The other browser
suites run the page in "sheet" mode (`tests/fixtures/sheet-mode.cjs`). Never commit the
output of `supabase/import-from-sheet.cjs`: it is business data and this repo is public.

Supabase portal (in progress): the move off Apps Script lives in `supabase/`. Roles
and visibility are enforced only by row-level security in `supabase/migrations/`;
never rely on the page to hide money or other people's data. After changing any
migration, run `node --test tests/supabase-rls.test.cjs` (throwaway local
PostgreSQL, Supabase auth/storage stubbed by `tests/fixtures/supabase-stub.sql`),
and add a refused-side test for every new rule. Never edit a migration that has
been applied to the live project: add a new, later-numbered one.

Accounting (`accounting.html`, `accounting.js`, admin only): in-house management books, not the
BIR-registered books (an external accounting firm keeps those). All figures are computed in SQL by
`supabase/migrations/20261111000005_accounting.sql`; the page only formats and exports. Tracker
expenses, company fuel and client payments post themselves through views (never copied), so
editing a tracker record corrects the books; everything else is a journal entry, which must
balance and is voided, never edited or deleted. After changing it, run
`node --test tests/accounting.test.cjs` (expected figures in that file are worked out by hand: keep
it that way) and `node tests/accounting.browser.cjs` (the page against the real SQL).

Loading states: while a page checks the session and loads data, `body.connecting` shows the
skeleton that `shell.js` builds (styles at the end of `shell.css`) instead of a "Connecting…" card.

