# Tracker development instructions

Follow the application rules in README.md, including `track()` for database writes
and bumping `PAGE_VERSION` whenever tracker.html changes. portal.ritehomemodular.com serves tracker.html at `/` and at `/projects`, `/procurement`, `/fuel` (accounting.html at `/accounting`, leads.html at `/leads`, schedule.html at `/schedule`) through `vercel.json`; `.vercelignore` keeps the old directory `index.html` out of that deployment, because on Vercel a real file wins over a rewrite. Browser tests need `node tests/fixtures/serve.cjs` running (same rules), not a plain static server. Keep versioned asset URLs current for UI changes.

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
the addresses and workspaces with tests/portals.browser.cjs after navigation changes.

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

Loading states and moving between workspaces (each menu item is a full page load):
- Warm start (Supabase only): once a tab has signed in as admin, `tracker.html` keeps that fact and
  the last-read data in sessionStorage (`ritehome_warm_v1`) and draws from it before the first
  paint, then re-checks the sign-in and reloads behind it. Cleared on sign-out, on a failed check,
  and when the tab closes. Row-level security still decides every read and write.
- No frame of an unfilled page: `shell.js` is loaded as the first thing inside `.wrap` (not at the
  end), and `<link rel="expect" href="#pageReady" blocking="render">` holds the first paint until the
  marker at the end of `<body>` is parsed. The marker must stay a parsed element, not one a script
  creates: Chromium ignores script-created targets. Pages swap in one frame (`@view-transition`,
  no cross-fade).
- Cold loads show the skeleton `shell.js` builds (`body.connecting`); skeletons fade in only after
  0.3 s so fast loads never flicker. `node tests/warm-start.browser.cjs` covers all of this with an
  800 ms backend.

Project health (`project-health.js`, used by the project page header and the projects list): cost at
handover = spent + (1 − work done) × (budget − materials already bought); profit at handover = contract
price − that. Materials count as spent because modular cabinetry buys them up front; do not switch to
spent ÷ work done, which calls every new job a loss. Portfolio "profit eroded" counts only jobs short of
their quote. `node --test tests/project-health.test.cjs` holds hand-worked figures; keep it that way.
The project page is tabbed (Overview · Expenses · Billing · Labor · Procurement · Details) by
`data-ptab` on each section; the tab is remembered per browser tab in sessionStorage (`ritehome_ptab`).

Leads (`leads.html`/`leads.js` at `/leads`, scoring in `lead-score.js`, data in
`supabase/migrations/20261112000006_leads.sql`): admin only. The website Worker files leads through
`ingest_lead(p, key)`; the key's SHA-256 lives in `app_secrets` (no policy: only SECURITY DEFINER code
reads it), the key itself only in the Worker's `PORTAL_LEAD_KEY` secret. Never commit either. Repeat
inquiries from the same phone or email within 30 days join the open lead. Contact (call, message, visit,
quote) times the first reply for the 2-business-hour promise (Mon-Sat 9-17, Manila: the office hours on the Google Business Profile). Scores are computed,
not stored. Tests: `node --test tests/leads.test.cjs tests/lead-score.test.cjs` and
`node tests/leads.browser.cjs` (real SQL through `tests/fixtures/pg-rpc.cjs`).


Schedule (`schedule.html`/`schedule.js` at `/schedule`, arithmetic in `schedule-plan.js`, data in
`supabase/migrations/20261113000008_schedule.sql` on the `project_stages`/`project_events` tables from portal_core):
the one workspace staff can use. Whiteboard (the office board as a table: client, project type, person in
charge, then Design / Initial cutlist / BOM / Final cutlist / Fabrication / Installation in the board's own words
and marker colours, tapped to change), pipeline board, timeline (Gantt) with workshop load, and calendar. The
board's vocabulary is `stage_key` 'final_cutlist' and `stage_status` 'waiting_client' / 'submitted', added on their
own in `20261113000007_stage_vocabulary.sql` (Postgres can't use a new enum value in the transaction that adds it).
Project type and person in charge are `projectType`/`inCharge` in the project document, read through
`project_labels()` and written by `board_project_save()`; never put client data from the real board in tests.
The board is broken down by system (Kitchen / Storage / Partition / Workstation, stored as the project's `system`;
Storage covers cabinets, TV consoles, wardrobes, closets, headboards; Workstation is stored as 'workspace'), with a
filter per system and rows grouped under each; `board_project_save()` takes the system explicitly
(`20261113000009_board_system.sql`) and only guesses it from the type when none is sent. Admin sees every
project, plans dates and assigns people; assigning someone to a stage also assigns them the project. Staff see only
assigned projects through `my_projects()` (never money or client email) and change status, actual dates and notes of
their own stages; the stage guard trigger refuses planned dates and assignees from anyone but an admin. A status
change fills in the actual dates (Manila day). Working days are Monday to Saturday minus holiday events; the default
durations in `schedule-plan.js` (40 working days, initial cutlist to handover 31) are a starting point to tune. Tests:
`node --test tests/schedule.test.cjs tests/schedule-plan.test.cjs` (dates in the latter worked out by hand: keep it
that way) and `node tests/schedule.browser.cjs`.
