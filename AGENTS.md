# Tracker development instructions

Follow the application rules in README.md, including `track()` for database writes
and bumping `PAGE_VERSION` whenever tracker.html changes. portal.ritehomemodular.com serves tracker.html at `/` and at `/projects`, `/procurement`, `/fuel` (accounting.html at `/accounting`, leads.html at `/leads`, schedule.html at `/schedule`, team.html at `/team`, inventory.html at `/inventory`, attendance.html at `/attendance`, activity.html at `/activity`, approvals.html at `/approvals`, company.html at `/company`) through `vercel.json`; `.vercelignore` keeps the old directory `index.html` out of that deployment, because on Vercel a real file wins over a rewrite. Browser tests need `node tests/fixtures/serve.cjs` running (same rules), not a plain static server. Keep versioned asset URLs current for UI changes.

Owner's standing rule (2026-11-12): every update to the portal also updates the agents' knowledge
in the same commit. When a change adds or alters a workspace, role, stage, table, RPC, test or deploy
step, update this file (and any skill under `.claude/skills/`, if one exists) so the next Claude Code
or Codex session knows it without being told. A portal change whose instructions here are stale is
not finished.

Deploys (2026-11-13): the Vercel project `ritehome-portal` is linked to GitHub and its production branch is
`claude/portal-supabase`, so **every push to that branch goes live within a minute**. Never push code that
needs a migration that isn't applied yet: apply the migration first (Supabase connector, or the owner runs it
in the SQL Editor and confirms), then push. Work that isn't ready to go live belongs on another branch (those
only make preview builds). `main` holds the old Apps Script code (Oct 18); never make it the production branch.

Owner's standing rule (2026-11-13): every change is documented in `MEMORY.md` with a version. Add an
entry at the top of its version history (what changed, migration, commit, live or pending and why),
bump `PORTAL_VERSION` in `shell.js` to match (shown under the menu), and keep its "Live state" and
"Owner to-dos" true. No exceptions: live actions (migration applied, deploy, Edge Function, secret or
setting changed), owner decisions and to-dos are recorded there too, in the same session they happen. `node --test tests/memory.test.cjs` fails when the two versions differ.

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

Accounting (`accounting.html`, `accounting.js`, admin and bookkeeper since v3.1): in-house management books, not the
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
consultation and site visit stages. Bookkeeper: Company profile (v3.0, their home page), Accounting (v3.1) and attendance
management (v3.2). The site visit stage sits
between consultation and design (consultation 1 day + site visit 1 day in `schedule-plan.js`; the total stays
40 working days). Role lists must agree in five places: the enum, `team.js` ROLES, `schedule.js` ROLE,
`attendance.js` ROLE, and the Edge Function's ROLES in `core.js` (redeploy it when they change). The menu is
grouped and filtered by role in `shell.js` (GROUPS: Overview · Sales · Design and production · Purchasing · Office
and finance · People, each heading hidden when none of its links shows; `RitehomeAccess`: ACCESS map, `home(roles)`, roles remembered per tab in
sessionStorage `ritehome_roles_v1`); every page calls `RitehomeAccess.apply(roles)` after `my_roles()`.
Hiding a link is never the security: row-level security is. Tests: `node --test tests/roles.test.cjs`.

Activity log (`activity.html`/`activity.js`/`activity.css` at `/activity`, admin only; SQL in
`supabase/migrations/20261118000016_audit_log.sql`): a `zz_audit` AFTER trigger (`audit_row()`, SECURITY DEFINER)
on every business table writes `audit_log`: who (id, name and roles at that moment), workspace (`audit_module()`),
table and record key (the trigger's arguments name the key columns), project, insert/update/delete, only the
changed fields with before and after (a tracker document's `data` is opened up into `data.<key>`), and the IP and
browser from PostgREST's `request.headers`. Every new table gets a `zz_audit` trigger in the migration that makes
it. Never copied: `face_descriptor`, a punch's `lat`/`lng`/`accuracy_m`/`selfie_path` (shown as "(hidden)" when they
change). Not logged: saves that only touch `updated_at`/`updated_by`/`revision`/`data.updatedAt`, and rows written by
another trigger (`pg_trigger_depth() > 1`: seeded stages, the lead's automatic notes, cascaded deletes). Nobody,
admin included, can insert, change or delete log rows (no write policies, privileges revoked); admins read through
`audit_search(p)` (filters actor, module, action, project, table, record, from/to Manila dates, q, before, limit).
Refusals: Postgres undoes a refused transaction, log row included, so pages report their own through
`audit_refused()` (source 'page', active accounts only, 30 an hour): every page's `rpc()` calls
`RitehomeRefused(client, module, name, error)` from `shell.js` on an error. A page's report is evidence of a
mistake, not tamper-proof: someone calling the API directly won't report themselves (their refused writes still
change nothing). The team-admin Edge Function credits the admin (see Notifications). Tests: `node --test tests/audit.test.cjs` and `node tests/activity.browser.cjs`.

Notifications (`supabase/migrations/20261120000017_notifications.sql`, the bell in `shell.js`/`shell.css`, the
`notify-telegram` Edge Function in `supabase/functions/notify-telegram/`): a trigger on `audit_log` makes one
`notify_events` row per log row (unique `audit_id`: never twice) for everything an employee does; the admin's own
actions notify nobody, and with nobody signed in only a website lead does. Levels: 'alert' (refused, deleted, stage
blocked, stock crossing its reorder level or out, a selfie that doesn't match), 'handoff' (new lead, lead won, stage
submitted or done), 'info' (the rest; an ordinary punch is not news). `notify_settings.telegram` ('off', 'alerts',
'important' = alerts + handoffs, the default, 'all') decides which go to Telegram; admins change it in the bell. The
bell: `RitehomeAccess.apply(roles, client)` starts `RitehomeBell` for admins (every page passes its client);
`notify_list()`/`notify_read()` keep a per-admin unread count; new events arrive by Supabase Realtime (`notify_events`
is in the `supabase_realtime` publication) and a one-minute poll. Telegram: `notify_ping()` posts an empty request
through pg_net to the function, which claims the queue with the service role (`notify_claim_telegram()`, rows
'pending' → 'sending'), sends, and reports (`notify_telegram_done()`: failures go back, five tries then 'failed').
The bot token and chat id are Edge Function secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), set by the owner in
the Supabase dashboard; without them the function answers 503 and events wait. Deploy it with JWT verification off
(the request carries nothing and is not trusted). Attribution: the team-admin function sends `x-ritehome-actor`
(believed only from the service role, `acting_user()`) and notes Auth-side actions with `audit_service_note()`.
Tests: `node --test tests/notify.test.cjs` (rules, bell, queue, and the function under Node against a stand-in
Telegram; `tests/fixtures/supabase-stub.sql` stubs pg_net as `net.http_requests` and the service role, run as the
"service" actor) and the bell steps in `node tests/activity.browser.cjs`.

One record per fact (`supabase/migrations/20261121000018_one_record.sql`, the 2026-11-13 duplicate review): the same
thing is never typed in two places.
- Site visit: booking a `site_visit` event on the Schedule calendar sets that project's Site visit stage dates (Manila
  day; `site_visit_from_event()`), unless the stage is done. The calendar doesn't repeat the stage's due date on a day
  that has the event.
- Duplicate projects: `project_duplicate_guard()` (BEFORE INSERT on `projects`) refuses a second open project for the
  same client (name ignoring case and spaces, or the last 10 digits of the phone) with errcode `RH409`, the message
  "This client already has an open project: X." and the existing id as the HINT. `supabase-backend.js` turns it into
  `{code:'duplicate_project', existing}`; Projects, the whiteboard (`board_project_save` passes it on) and Leads ask
  first, then retry with `data.confirmDuplicate = "true"`, which the guard strips before storing. `lead_convert(p_id,
  p_price, p_budget, p_project, p_confirm_new)`: with `p_project` a won lead joins that open project instead of making
  one. `tests/fixtures/pg-rpc.cjs` (psql `VERBOSITY=verbose`) now returns `code` and `hint` like PostgREST.
- Deliveries are stock: `procurement_deliveries_to_stock()` (AFTER INSERT/UPDATE on `procurement` docs) adds the
  change in each PO line's `received` to Inventory as a `receive` move (job name, note "PO <ref> · <supplier>"), and a
  lowered `received` as an `adjust` that never goes below zero. Items match by name + spec (case-insensitive) or are
  created. Never enter PO deliveries in Inventory by hand; the Inventory page says so.
- Procurement job ↔ project: a job may carry `projectId` (validated `^[A-Za-z0-9_-]{1,80}$` in both backends). The
  purchaser picks it from `procurement_project_choices()` (definer, purchaser/admin, names only, never prices). The
  project page's Procurement tab (Supabase) lists the jobs linked to it and links to `/procurement#new=<project id>`,
  which opens a new job with the project chosen. The old per-project procurement card shows only on "/" and only when
  that project already has BOMs or POs (legacy records are kept). Sheet mode keeps the old tabs.
- Dashboard ("/", Supabase): `dashboard_overview()` (definer, admin only, counts only) feeds one tile per workspace
  (Leads unanswered, Schedule submitted/blocked/late, Stock out/low, Attendance today and punches to check), each a link,
  plus "Waiting on you" (a submitted stage links to /approvals, a blocked one to /schedule). With figures loaded `data-overview` hides the project lists, company fuel and
  the jump buttons (they live on /projects and /fuel); if the call fails the old lists stay. Health and "Who owes us"
  stay on the dashboard.
Tests: `node --test tests/one-record.test.cjs tests/procurement.test.cjs` and `node tests/dashboard.browser.cjs`,
plus the leads, schedule and procurement-jobs browser suites.

Approvals (Phase 4; `approvals.html`/`approvals.js`/`approvals.css` at `/approvals`, every active account; SQL in
`supabase/migrations/20261122000019_approvals.sql`): the department hand-off of the CRM master prompt (section 7).
`approval_rules` (one row per `stage_key`, admin changes it through `approval_rules_save()`; defaults: design, cutlist,
bom, final_cutlist, fabrication, installation) says which stages need approval. For those, `stage_approval_guard()`
(BEFORE UPDATE OF status on `project_stages`, named `project_stages_approval` so it runs before the other guards)
refuses staff marking the stage done, setting "submitted" without a submission, or moving it while a submission waits.
Staff hand over with `stage_submit(project, stage, note, link)`: a `stage_submissions` row with the next `version`,
then the stage turns "submitted". The admin decides with `stage_review(id, 'approved' | 'revise', remarks)`:
approved = stage done; revise needs remarks and reopens the stage (in_progress). An admin marking a stage done on the
Schedule approves what was waiting ("Marked done on the Schedule."). A stage can't start (leave not_started) while
the stage before it (`stage_prev()`: site_visit→design→cutlist→bom→final_cutlist→fabrication→installation→handover;
procurement waits for bom) needs approval and isn't done; the admin is never held. Submissions are never edited
after the decision or deleted (`stage_submission_guard()`, privileges revoked; they go only with the project), so
every version is kept. Reads: `approvals_list(p)` (state, project, stage, limit; admin all, staff their own and their
stages'), `approval_rules_list()`. Schedule (`schedule.js`): for staff on an approval stage "Approved" is not offered,
"Submit for review…" asks for the note and link (`window.prompt`), and a waiting stage is read-only; the approval
calls go through `quiet()` so a database without migration 19 just shows no approvals. Activity log module
"Approvals"; the bell rings once per submission ('handoff', "Dina submitted Design v2 for review · project"); the
stage turning "submitted" with it is not a second event. Staff have no bell: they read decisions on /approvals.
Tests: `node --test tests/approvals.test.cjs` and `node tests/approvals.browser.cjs`. Other suites that move staff
stages switch approvals off for their own subject and restore the defaults (schedule, supabase-rls).

Versions: `PORTAL_VERSION` in `shell.js` is shown under the menu (`#portalVersion`) and must equal the newest entry in
`MEMORY.md` (`node --test tests/memory.test.cjs`).

Company profile (Phase 5a, v3.0; `company.html`/`company.js`/`company.css` at `/company`, admin and bookkeeper; SQL in
`supabase/migrations/20261123000020_company_profile.sql`): the master prompt's section 14 and its permission matrix
(Company Profile: admin full, bookkeeper edit, everyone else no). `can_keep_books()` = admin or bookkeeper (any of a
person's roles). `company_profile` is one row (id 1: names, logo path, address, phones, email, website, TIN, business
type, VAT, registration no., business info, `authorized` = up to 10 {name, position, phone, email}); `company_documents`
is the register (title, kind, file, expiry, notes, uploader). Both: read policy `can_keep_books()`, no write privileges;
writes through `company_profile_save(p)` (only the fields sent), `company_document_save(p)` (new: the file must
already be in the bucket; or edits) and `company_document_archive(id)` (admin only: archived, record and file kept);
the page reads `company_get()` (names, `days_left` in Manila days, `can_archive`). Files: private bucket
`company-files` (10 MB, PDF/PNG/JPEG/WebP; no SVG, it can carry script), paths `logo/<uuid>.<ext>` and
`documents/<uuid>.<ext>` enforced by the insert policy; no update or delete policy (nothing overwritten or deleted),
read through signed links (5 min for documents, 1 h for the logo). The page checks type and size before uploading
(2 MB for the logo), turns storage errors into words, keeps the form on any failure, and on retry reuses the file
already uploaded (`state.pendingFile`). `dashboard_overview()` gains `company` {expired, expiring (30 days), next}
and the dashboard shows a "Company documents" tile only when one is expired or expiring. Bookkeepers start on
`/company` (`homeFor`; tracker.html sends them there from "/"). Activity log module "Company". Tests: `node --test
tests/company.test.cjs` and `node tests/company.browser.cjs` (uploads pass through the real storage policies on the
local PostgreSQL via `createFakeSupabase({upload})`). Those are not proof of the live bucket: after migration 20 is
applied, run the live storage check in MEMORY.md.

Browser-test page errors: `tests/fixtures/page-errors.cjs` (`collectErrors(page)`) records every uncaught page error
except Chromium's "Transition was aborted because of invalid state" (a cancelled @view-transition page swap; nothing
visible changes and no page script can catch it). Use it in suites that navigate between pages through the menu
(portals, warm-start). Don't widen it to any other message.

Bookkeeper in Accounting (Phase 5b, v3.1; `supabase/migrations/20261124000021_bookkeeper_books.sql`): the permission
matrix gives the bookkeeper Accounting = Edit. Every `acct_*` policy is "admin or bookkeeper" (`can_keep_books()`), and
`acct_post_entry`, `acct_void_entry` and `acct_require_admin` (used by settings, accounts and VAT tags) check
`can_keep_books()`; refusals read "Only the admin and the bookkeeper …". Because the books post tracker payments,
expenses and fuel through security_invoker views, the bookkeeper also has a read-only `tracker_docs` policy for the
collections `projects`, `expenses`, `companyFuel` (no write policy: they can't change a project, an expense or a fuel
log, and still can't see leads, procurement or anything else). If a view ever reads another collection, add it here
or the bookkeeper's books silently lose those figures; `tests/bookkeeper.test.cjs` compares the bookkeeper's trial
balance with the admin's, figure for figure. Entries stay voided, never edited or deleted. Tests: `node --test
tests/bookkeeper.test.cjs tests/accounting.test.cjs` and `node tests/accounting.browser.cjs` (bookkeeper step 1b).

Attendance management (Phase 5c, v3.2; `supabase/migrations/20261125000022_attendance_records.sql`, the Team today and
Month tabs of `attendance.js`): admin and bookkeeper (`can_manage_attendance()`). `attendance_records` holds what the
office adds: 'absent', 'leave' (leave_type + paid), 'correction' (punch_kind + at, reason required, same Manila day)
and 'remark'. The owner's rule: punches are never edited; a correction sits beside the punch and the month counts
its time instead. Records are never edited or deleted (`attendance_record_guard()`): `attendance_record_void(id,
reason)` once, then add the right one. One absence/leave per person per day and one correction per punch while open
(partial unique indexes). `attendance_record_add(p)` refuses an absence on a day with punches, and refuses anyone but
the admin adding or voiding a record about themselves. `attendance_day()` and `attendance_month()` are now definer
with `can_manage_attendance()`; `punch_json(p, is_admin())` gives the bookkeeper times and flags only (no selfie path,
GPS or face score), `can_review` is the admin's photo review and face resets (still admin-only). The month: effective
time per punch slot = correction else punch; late/early out recomputed from it with prepare_punch()'s clock (in after
8:00/13:00, out before 12:00/17:00); plus absences, paid/unpaid leave, corrections and unaccounted = working days
(Mon-Sat, not a 'holiday' event) already over, since the account was created, with no punch, correction, absence or
leave (a remark doesn't account for a day). `attendance_me()` returns the person's own records (31 days). Tests:
`node --test tests/attendance-records.test.cjs` (October 2026 worked out by hand in its header: keep it that way) and
the bookkeeper step 5b in `node tests/attendance.browser.cjs`.

