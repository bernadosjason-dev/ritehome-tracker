# Ritehome portal memory

The portal's change history, the owner's decisions, and what is live. Every Claude Code or Codex
session reads this first (CLAUDE.md loads it). **Every change to the portal adds an entry here and
bumps the version in the same commit**: the newest version at the top of the history must equal
`PORTAL_VERSION` in `shell.js` (shown under the menu), and `node --test tests/memory.test.cjs` fails
if they differ.

Versions: `MAJOR.MINOR`. Major = a new backend or a phase of the CRM master prompt; minor = a
feature or fix shipped on its own. A version is "live" only once its migration is applied to the
Supabase project and its commit is deployed to Vercel; until then it says "pending" and why.

## Owner's standing decisions

- 2026-11-12 Every portal update also updates the agents' knowledge (AGENTS.md, this file, any
  `.claude/skills`) in the same commit.
- 2026-11-13 Every update or change goes in this file, no exceptions: code (a new version entry),
  and also every live action (a migration applied, a deploy, an Edge Function, a secret or setting
  changed: update "Live state" with the date), every owner decision (here), and every to-do added or
  done. A change that isn't written here isn't finished.
- 2026-11-12 One person can hold several roles (a main role plus extras); admin is only ever a main role.
- 2026-11-12 Keep the Procurement stage on the Schedule; the purchaser owns it.
- 2026-11-12 Journal entries are voided, never edited; attendance punches are never edited
  (corrections are added as new records).
- 2026-11-12 Backups: dropped for now; reminder set for Fri Nov 20, 9 AM Manila.
- 2026-11-13 Vercel deploys production from `claude/portal-supabase` on every push (owner linked
  the project to GitHub). So a database change goes live first (owner runs it, or the agent applies
  it), and only then is the code that needs it pushed.
- 2026-11-13 Duplicates: one record per fact. A thing typed in one workspace is never typed again
  in another.
- Brutal honesty in reports to the owner; every task has a deadline.

## Live state (update when it changes)

| What | Live | Notes |
|---|---|---|
| Supabase project | `laxavfldivkhufeubgmb` | migrations 01–17 applied and md5-checked by the agent; **18–22 applied 2026-11-13 by the owner** in the SQL Editor (the approval card never reached them), confirmed by the owner's check query (all five "yes") and the company-files storage check (passed). **Still not md5-compared, smoke-tested or registered against the live database** (2026-11-13, second attempt: the agent's Supabase connector failed to connect and the session's network refuses `*.supabase.co`). Done locally instead: all 127 public functions of a local load of 01–22 fingerprinted; the three paste-ready scripts in `supabase/checks/go-live-18-22-*.sql` (1 md5 compare, 2 rolled-back smoke test, 3 register 18–22) each proven on a local load (compare: ALL MATCH, and a tampered function is caught; smoke: 14/14, nothing saved) |
| Edge Function `team-admin` | v4 | JWT verification off (checks the caller itself) |
| Edge Function `notify-telegram` | v1 | needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` secrets (owner sets them) |
| Vercel `ritehome-portal` | building v3.2 from `claude/portal-supabase` (2026-11-13, pending the owner's check) | portal.ritehomemodular.com. **2026-11-13: the owner connected the project to GitHub (bernadosjason-dev/ritehome-tracker) and set Production Branch Tracking to `claude/portal-supabase`**: every push to that branch now deploys to production by itself (before this, the project had no Git link and only connector-made deployments existed; the agent's Vercel connector was down). `main` still holds the Oct 18 Apps Script code: never point production at it |

## Owner to-dos

- Check the site shows "Portal v3.2" (refresh portal.ritehomemodular.com) and tell the agent "live".
  (Done 2026-11-13: migrations 18–22 run; check query all "yes"; storage check passed; Vercel linked to
  GitHub with production on `claude/portal-supabase`.)
- Before or right after the deploy (go-live page step 7, with Copy buttons), in the SQL Editor, in order (each read-only or self-rolling-back
  except 3): `supabase/checks/go-live-18-22-1-md5-compare.sql` (expect one row "ALL MATCH"),
  `…-2-smoke.sql` (expect an error reading "SMOKE RESULT … 14 of 14 passed": the error is the
  rollback), `…-3-register.sql` (expect 22 rows). Paste the three results to the agent.
  Alternative: fix the agent's Supabase and Vercel connectors and say "go live" again.
- Company profile: fill in the details and upload the permits with their expiry dates.
- Telegram: add the two Edge Function secrets in the Supabase dashboard (never in chat).
- Shelf count in Inventory before relying on stock: deliveries before v2.4 are not in stock.
- Check the clients with more than one open project (Dandan ×3, Ar. Amerol ×2, Mayor Azum ×2):
  separate jobs, or accidental doubles to close.
- Backups decision (reminder Fri Nov 20).

## Live storage check (company-files bucket, after migration 20)

The tests run the real storage policies on a local database, which is not the live bucket. Once,
after migration 20 is applied, in the Supabase SQL Editor:

    select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'company-files';
    -- expect: company-files | false | 10485760 | {application/pdf,image/png,image/jpeg,image/webp}
    select policyname, cmd from pg_policies where schemaname = 'storage' and policyname like 'company files:%';
    -- expect two: "admin and bookkeeper read" (SELECT), "admin and bookkeeper upload" (INSERT)

Then on portal.ritehomemodular.com/company as the admin: add a small PDF (it appears, Open shows it),
try a file over 10 MB (refused before upload), and confirm a designer account can't open the page.
Record the result in "Live state".

## Roadmap (CRM master prompt)

| Phase | What | Version | Due | State |
|---|---|---|---|---|
| 1 | Roles: sales, bookkeeper, several roles per person, role menu | 2.0 | Nov 12 | live |
| 2 | Activity log | 2.1 | Nov 12 | live |
| 3 | Notifications: bell, Telegram | 2.2 | Nov 12 | live (Telegram waits for secrets) |
| 4 | Approvals: stage hand-offs reviewed by the admin, versions kept | 2.5 | Thu Nov 26 | database live; site deploy pending |
| 5 | Company profile (3.0), bookkeeper in Accounting (3.1), attendance management (3.2) | 3.0–3.2 | Thu Nov 26 | database live; site deploy pending |
| 6 | Role dashboards and reports | 3.x | — | not started |
| — | Inventory v4: unique codes, QR/barcode labels, scanner, IN/OUT checkout engine, statuses, reports (owner's brief 2026-11-13) | 4.0–4.2 | proposed Fri Nov 20 | plan proposed 2026-11-13; waiting for the owner's answers to 5 decisions, then build |

## Version history (newest first)

### 3.2 — 2026-11-13 — Phase 5c: attendance management (pending: database live Nov 13, site not deployed yet)
Commit: see `git log` ("Attendance management"). Migration `20261125000022_attendance_records.sql`.
- The admin and the bookkeeper record absences, leave (vacation, sick, emergency, bereavement,
  maternity/paternity, unpaid, other; paid or unpaid), corrections to punches and remarks, from
  Attendance → Team today → Record…
- Punches are never changed (owner's rule): a correction (the right time and a required reason) sits
  beside the punch, struck through, and the month counts the corrected time. A wrong record is voided
  with a reason, never edited or deleted.
- Controls: nobody but the admin records or voids their own attendance; the bookkeeper sees times and
  flags but never selfies, GPS or face scores (photo review and face resets stay with the admin).
- The month adds Absent, Paid leave, Unpaid leave, Corrections and Unaccounted (working days already
  over with no punch, leave or absence: the days to ask about before payroll), in the table and the CSV.
- Staff see what the office recorded about them on their own Attendance page.

### 3.1 — 2026-11-13 — Phase 5b: the bookkeeper keeps the books (pending: database live Nov 13, site not deployed yet)
Commit: see `git log` ("Bookkeeper in Accounting"). Migration `20261124000021_bookkeeper_books.sql`.
- Accounting opens to the bookkeeper (the permission matrix: Accounting = Edit): every report, posting
  and voiding journal entries, settings, chart of accounts, VAT tags. The menu shows it to them.
- Their books are the admin's books, figure for figure: they read (never change) the project
  payments, expenses and company fuel the books post from. Leads, procurement and the rest stay hidden.
- Entries are still voided, never edited or deleted; each one names who posted it, is in the
  activity log, and the admin's bell hears about it.

### 3.0 — 2026-11-13 — Phase 5a: company profile (pending: database live Nov 13, site not deployed yet)
Commit: see `git log` ("Company profile"). Migration `20261123000020_company_profile.sql`.
- New Company profile page (`/company`, Office and finance), for the admin and the bookkeeper only
  (the master prompt's permission matrix): names, logo, address, contact numbers, email, website,
  TIN, business type, VAT, registration number, business information, and up to 10 authorised people.
- Document register: registrations, permits, contracts as PDF or photo (10 MB), each with a kind and
  an expiry date shown as "Expires in 12 days" / "Expired". The bookkeeper adds and edits; only the
  admin removes, and removing archives (the record and file are kept).
- The dashboard shows a "Company documents" tile when a permit is expired or expires within 30 days.
- The bookkeeper's home page is now the company profile.
- Files in a private bucket, read through short signed links; no SVG; nothing overwritten or deleted.
  A failed upload or save keeps the form, and a retry doesn't upload the file twice.
- Tests: the portals and warm-start suites ignore exactly one Chromium message ("Transition was
  aborted…", raised when a page-to-page swap is cancelled; invisible to people), via
  `tests/fixtures/page-errors.cjs`. Every other page error still fails them. Now 0 failures in 8 runs.
- Fix on the way: saving the company details left Save looking unsaved, so the page skipped redrawing.

### 2.5 — 2026-11-13 — Phase 4: approvals (pending: database live Nov 13, site not deployed yet)
Commit: see `git log` ("Phase 4: approvals"). Migration `20261122000019_approvals.sql`.
- A stage that needs approval can't be marked done by its department: they submit it (a note and
  an optional link), which records a numbered version. The admin approves (stage done, the next
  department may start) or asks for a revision with remarks (required). Every version and decision
  is kept; none is edited or deleted.
- The admin chooses which stages need approval (Approvals page, "Which stages need approval").
  Defaults: Design, Initial cutlist, BOM, Final cutlist, Fabrication, Installation.
- The next department can't start its stage until the stage before it is approved (the admin
  can always). Procurement waits for the approved BOM; Fabrication for the approved Final cutlist.
- Stages already marked "Submitted" on the whiteboard become version 1 submissions, so they show in
  the admin's queue.
- New Approvals page (`/approvals`): the admin's queue and history; everyone else sees their own
  submissions and the decisions on them. The dashboard's "Waiting on you" links there.
- The admin's bell rings once per submission. Staff have no bell yet: they see decisions on /approvals.
- The portal version is shown under the menu.
- Fix: page-to-page transitions that Chromium skips no longer leave an unhandled error where a page
  script can catch it. (Corrected in 3.0: the "1 run in 8" reported here was a lucky sample; the
  portals test still failed about half the time on a Chromium message no script can catch.)

### 2.4 — 2026-11-12 — One record per fact (pending: database live Nov 13, site not deployed yet)
Commit `67237d9`. Migration `20261121000018_one_record.sql`.
- Site visit event sets the Site visit stage dates.
- One guard against a second open project for the same client (Projects, whiteboard, won lead);
  the page asks first. A won lead can join the client's open project.
- PO deliveries add stock to Inventory by themselves (corrections reduce it, never below zero).
- Procurement jobs can be linked to their project; the project page lists them.
- Dashboard is its own overview (leads, schedule, stock, attendance, waiting on you).

### 2.3 — 2026-11-12 — Menu grouped by who owns the work (live)
Commit `2457d30`. Overview · Sales · Design and production · Purchasing · Office and finance · People.

### 2.2 — 2026-11-12 — Phase 3: notifications (live)
Commit `2f2e2db`. Migration 17. Admin bell with unread count, Realtime, Telegram queue and the
`notify-telegram` function; team-admin actions credited to the admin.

### 2.1 — 2026-11-12 — Phase 2: activity log (live)
Commit `605ffaf`. Migration 16. Every change logged with who, what, before/after, IP; Activity page.

### 2.0 — 2026-11-12 — Phase 1: roles (live)
Commit `8a54eb9`. Migrations 14–15. Sales and bookkeeper roles, several roles per person, site visit
stage, role-filtered menu.

### 1.6 — 2026-11-12 — Attendance (live)
Commits `fee0234`, `8eb73d0`. Migration 13. Selfie + GPS punches, face check, admin review, month summary.

### 1.5 — 2026-11-11 — Purchaser role and Inventory (live)
Commits `01dc901`, `c643ef6`. Migrations 11–12. Stock as a history of movements.

### 1.4 — 2026-11-11 — Team accounts and design review (live)
Commits `5649c2b`, `0056ca4`, `14f7492`. Migration 10, `team-admin` function. Admin-made sign-ins,
forced first password change; the 20-point design pass.

### 1.3 — 2026-11-11 — Schedule and whiteboard (live)
Commits `0fd5b9d`, `1f84f3e`, `cd4479a`. Migrations 07–09. Pipeline, Gantt, calendar, the office
whiteboard by system.

### 1.2 — 2026-11-11 — Short addresses, project health, leads (live)
Commits `21ed883`, `afe6278`, `a2a7f84`, `df65eca`, `86618a6`, `4938002`, `7c51cd6`. Migration 06.
portal.ritehomemodular.com, tabbed project page, lead scoreboard, real logo and hours.

### 1.1 — 2026-11-11 — Ritehome look and accounting (live)
Commits `b78c980`, `71e9356`, `5c596e4`, `a8ff920`, `1a79d43`. Migration 05. In-house books, skeleton loading.

### 1.0 — 2026-11-05 to 11-08 — Supabase backend (live)
Commits `bcee7cb`, `98f5a18`, `c6395df`. Migrations 01–04. Per-person sign-in replaces the shared key.

### 0.4 — 2026-10-08 to 10-18 — Procurement and portals (Apps Script)
Commits `51623fd` … `3053ecb`. BOMs and supplier POs, separate procurement jobs, Excel BOM import,
fuel/project/procurement portals.

### 0.3 — 2026-10-06 — Company fuel (Apps Script)
Commits `4a2e63f` … `35906d1`. Fuel ledger, vehicles, receipt photos.

### 0.2 — 2026-09-28 — Receivables and receipt scanning (Apps Script)
Commits `a578df4` … `afeb5be`. "Who owes us", Gemini receipt scan, new-version notice.

### 0.1 — 2026-09-24 — Project tracker (Apps Script)
Commit `7384fc4`. Projects and expenses on Google Sheets.
