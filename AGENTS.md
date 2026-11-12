# Tracker development instructions

Follow the application rules in README.md, including `track()` for database writes
and bumping `PAGE_VERSION` whenever tracker.html changes. portal.ritehomemodular.com serves tracker.html at `/` and at `/projects`, `/procurement`, `/fuel` (accounting.html at `/accounting`, leads.html at `/leads`, schedule.html at `/schedule`, team.html at `/team`, inventory.html at `/inventory`, attendance.html at `/attendance`) through `vercel.json`; `.vercelignore` keeps the old directory `index.html` out of that deployment, because on Vercel a real file wins over a rewrite. Browser tests need `node tests/fixtures/serve.cjs` running (same rules), not a plain static server. Keep versioned asset URLs current for UI changes.

Owner's standing rule (2026-11-12): every update to the portal also updates the agents' knowledge
in the same commit. When a change adds or alters a workspace, role, stage, table, RPC, test or deploy
step, update this file (and any skill under `.claude/skills/`, if one exists) so the next Claude Code
or Codex session knows it without being told. A portal change whose instructions here are stale is
not finished.

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
`supabase/migrations/20261112000006_leads.sql`): admin and sales (see Roles; only the admin converts a lead). The website Worker files leads through
`ingest_lead(p, key)`; the key's SHA-256 lives in `app_secrets` (no policy: only SECURITY DEFINER code
reads it), the key itself only in the Worker's `PORTAL_LEAD_KEY` secret. Never commit either. Repeat
inquiries from the same phone or email within 30 days join the open lead. Contact (call, message, visit,
quote) times the first reply for the 2-business-hour promise (Mon-Sat 8-17, Manila: the staff's working hours; clients see 9-17 on the website and Google). Scores are computed,
not stored. Tests: `node --test tests/leads.test.cjs tests/lead-score.test.cjs` and
`node tests/leads.browser.cjs` (real SQL through `tests/fixtures/pg-rpc.cjs`).


Schedule (`schedule.html`/`schedule.js` at `/schedule`, arithmetic in `schedule-plan.js`, data in
`supabase/migrations/20261113000008_schedule.sql` on the `project_stages`/`project_events` tables from portal_core):
the one workspace every staff role can use. Whiteboard (the office board as a table: client, project type, person in
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

Team (`team.html`/`team.js` at `/team`, admin only; SQL in `supabase/migrations/20261114000010_team.sql`, the
`team-admin` Edge Function in `supabase/functions/team-admin/`): the admin makes each person's sign-in with a
temporary password handed over in person (no email is sent: Supabase's built-in mailer only reaches the project's
own team members). `user_metadata.must_change_password` makes tracker.html ask for a new password before anything
else, on every page. Creating accounts and resetting passwords need the service role key, so they go through the
Edge Function (`core.js` is plain JavaScript with `fetch` injected, so Node tests run it; `index.ts` is the Deno
entry). It checks the caller's token and that their profile is an active admin before doing anything; deploy it
with JWT verification off, since it verifies the caller itself. Everything else is SQL: `team_list()` (definer,
because it reads `auth.users` for emails and last sign-in; refuses anyone but an admin), `team_update()` (role, name,
switch off/on; an admin can't switch off or demote their own account) and `team_assign_in_charge()` (gives a person
the unfinished whiteboard rows whose "In charge" matches their name, and their own role's unassigned stages on them).
Never put the service role key in this repo or a browser. Tests: `node --test tests/team.test.cjs` and
`node tests/team.browser.cjs`.

Design rules (the 2026-11-14 review; the "Design review" block at the end of `shell.css` carries them, numbered):
no eyebrow labels over page titles (the menu already says where you are) and no "Soon" placeholders in the menu;
headlines say something true (the dashboard's is computed: "3 open jobs · 1 needs you"); the first figure on a page
is the one to act on and is drawn larger; monospace only for account codes and passwords, figures use Inter with
tabular numerals; labels are sentence case, not spaced capitals (the whiteboard alone keeps marker capitals); one red
button per screen, and a Save with nothing to save is quiet until something changes; red means action or alert, not
decoration; nested corners follow inner radius = outer − padding; buttons that start a request call
`RitehomeBusy(button, true)` (shell.js) so they spin until it settles; a saved row or whiteboard cell gets
`just-saved` for a one-off green glow. Page stylesheets (schedule.css, team.css, leads.css) load after shell.css, so a
shell.css rule meant to override one of them needs the `body ` prefix.

Purchaser and Inventory (`inventory.html`/`inventory.js`/`inventory.css` at `/inventory`; SQL in
`supabase/migrations/20261115000011_purchaser_role.sql` and `…12_inventory.sql`): `purchaser` is one role for the
person who buys materials and keeps the stock. `can_stock()` (admin or purchaser) guards everything. Stock has no
quantity column: every change is an `inventory_moves` row (+ receive, − issue, ± adjust from a count) and on-hand
is the sum, so the page always shows who took what for which job; movements can't be edited or deleted, and a
trigger refuses any row that would take an item below zero. `inventory_board()` is definer only because it names
people and offers open job names (never prices). The purchaser also gets the Procurement workspace: a second
`tracker_docs` policy for the `procurementJobs` and `procurement` collections only, and tracker.html's gate admits a
purchaser in procurement mode and sends them to `/inventory` from anywhere else on that page. They own the
`procurement` stage on the Schedule (`role_owns_stage`). Where role lists live: see Roles below.
Tests: `node --test tests/inventory.test.cjs` and `node tests/inventory.browser.cjs`.

Attendance (`attendance.html`/`attendance.js`/`attendance.css` at `/attendance`, every active role; SQL in
`supabase/migrations/20261116000013_attendance.sql` on the `attendance_punches` table from portal_core): four
punches a day, each with a selfie (private `attendance-selfies` bucket, `<user id>/…jpg`) and one GPS fix; the time
and work date are the server's. Flags are computed in `prepare_punch()`, never taken from the phone: late / early
out (8, 12, 1, 5 o'clock), `off_site` (more than `office_site()`'s 150 m from the plus-code pin: information, since
installers clock in at client sites), `low_gps_accuracy`, and the face check. The face check: `vendor/face-api`
makes a 128-number template in the browser; `attendance_punch()` hands it to the trigger, which compares it with
the person's reference template (`profiles.face_descriptor`, set once by `attendance_enroll()`, reset only by the
admin) and stores `face_match` = 1 − distance; under `face_match_threshold()` (0.45) it's `face_mismatch`, with no
template `no_face_check`. A punch always goes through; flags are for the admin, who sees the photo beside the
reference photo and marks it checked (`attendance_review()`). The template never returns to a browser. Consent
(`accept_attendance_notice()`) comes first; the notice on the page promises photos are deleted after 90 days, so
keep `attendance_old_selfies()` / the admin's "Delete these photos" card working. `attendance_month()` is the
payroll summary (hours from matched in/out pairs). Tests: `node --test tests/attendance.test.cjs` and
`node tests/attendance.browser.cjs` (fake camera and location; the face template is a stand-in there, and the last
step loads the real library and models). `tests/fixtures/pg-rpc.cjs` now turns JSON arrays into Postgres arrays
for array-typed arguments, as PostgREST does.

Roles (`supabase/migrations/20261117000014_sales_bookkeeper.sql`, `…15_multi_role.sql`): seven roles, and one
person can hold several: a main role (`profiles.role`) plus `profiles.extra_roles`. Admin is only ever a main
role (a check constraint refuses it as an extra; making someone admin clears their extras). `my_role()` still
returns the main role (null when inactive); every permission question uses `my_roles()` / `has_role()`, and
`can_work_stage()` lets a person work a stage when any of their roles owns it. Sales: the Leads workspace
(`can_sell()`; converting a lead into a project stays admin-only because it sets price and budget) and the
consultation and site visit stages. Bookkeeper: the role exists, nothing opens to it yet beyond its own
attendance (books, attendance corrections and company profile come in phase 5). The site visit stage sits
between consultation and design (consultation 1 day + site visit 1 day in `schedule-plan.js`; the total stays
40 working days). Role lists must agree in five places: the enum, `team.js` ROLES, `schedule.js` ROLE,
`attendance.js` ROLE, and the Edge Function's ROLES in `core.js` (redeploy it when they change). The menu is
filtered by role in `shell.js` (`RitehomeAccess`: ACCESS map, `home(roles)`, roles remembered per tab in
sessionStorage `ritehome_roles_v1`); every page calls `RitehomeAccess.apply(roles)` after `my_roles()`.
Hiding a link is never the security: row-level security is. Tests: `node --test tests/roles.test.cjs`.
