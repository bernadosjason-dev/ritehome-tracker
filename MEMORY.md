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
- 2026-11-13 Payroll (owner's answers to the salary brief): payroll before inventory v4. Rates are
  set by the admin and the bookkeeper; only the admin approves a cutoff. No late grace period (lateness
  is deducted per minute, never a whole day). The owner approves every overtime day (30-minute blocks
  after 5 PM). Release on the 15th and the 30th (Feb: month end); when that day is a Sunday or a
  holiday it moves, by as many days as it takes. Direction: **earlier** (the last working day before),
  because DOLE's rule says wages due on a holiday or rest day are paid the working day before; the
  owner can switch it to later in the payroll settings. Not answered, so defaults until the
  accountant signs off: divisor 313 days (monthly-paid equivalent daily rate), and statutory
  deductions (SSS, PhilHealth, Pag-IBIG, withholding tax) left as an empty table the accountant fills,
  with a gross-pay export meanwhile.
- Brutal honesty in reports to the owner; every task has a deadline.

## Live state (update when it changes)

| What | Live | Notes |
|---|---|---|
| Supabase project | `laxavfldivkhufeubgmb` | migrations 01–24 applied (18–24 by the owner in the SQL Editor). **Verified 2026-11-13 by the agent through the Supabase connector:** all 155 public functions match a local load of 01–24 (comment- and whitespace-normalised: none differ, none missing, none extra); rolled-back smoke test 25/25 (admin calls work; anon refused for dashboard, company, approvals, salaries, pay, statutory); company-files bucket and its two policies exactly as expected; 18–24 registered in `supabase_migrations.schema_migrations` (24 rows) |
| Migration 23 (v3.3 salary) | applied 2026-11-13 | owner ran it; agent verified via the connector (18/18 functions match, privileges right). Live calendar has **0 holidays**, so release dates and holiday pay ignore holidays until the owner adds them. Registered in `supabase_migrations` 2026-11-13 |
| Migration 24 (v4.0 statutory rules) | applied 2026-11-13 | owner ran it; agent verified (16/16 functions match, live figures match the tests). 9 rules seeded, all **waiting for the accountant's review**. Registered in `supabase_migrations` 2026-11-13 |
| Holidays on the calendar | 36 loaded 2026-11-13 by the agent (owner: "we follow what's online") | National list from Proclamation No. 1006 s. 2025 (2026) and No. 1427 s. 2026 (2027), read from the PCO PDFs: 10 regular + 8 special each year, typed regular/special, source in each event's notes. Not included: Eid'l Fitr / Eid'l Adha (proclaimed separately each year), NCR-only days, Cagayan de Oro local days (owner to add if the company observes them), the EDSA special *working* day. Release dates now: Nov 16-30 -> Sat Nov 28, Dec 16-31 -> Tue Dec 29 |
| Edge Function `team-admin` | v4 | JWT verification off (checks the caller itself) |
| Edge Function `notify-telegram` | v1 | needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` secrets (owner sets them) |
| Vercel `ritehome-portal` | commit `012b3bc` (v3.2), live 2026-11-13 (owner confirmed "live") | portal.ritehomemodular.com. **2026-11-13: the owner connected the project to GitHub (bernadosjason-dev/ritehome-tracker) and set Production Branch Tracking to `claude/portal-supabase`**: every push to that branch deploys to production by itself (before this the project had no Git link and only connector-made deployments existed). `main` still holds the Oct 18 Apps Script code: never point production at it |

## Owner to-dos

- (Done 2026-11-13: migrations 18–22 run; check query all "yes"; storage check passed; Vercel linked to
  GitHub; v3.2 live, owner confirmed.)
- (Done 2026-11-13 by the agent: go-live step 7 — md5 compare, smoke test, storage check, register 18–24.)
- Company profile: fill in the details and upload the permits with their expiry dates.
- Telegram: add the two Edge Function secrets in the Supabase dashboard (never in chat).
- Shelf count in Inventory before relying on stock: deliveries before v2.4 are not in stock.
- Check the clients with more than one open project (Dandan ×3, Ar. Amerol ×2, Mayor Azum ×2):
  separate jobs, or accidental doubles to close.
- Backups decision (reminder Fri Nov 20).
- Reminder set for Sat Nov 14, 9 AM Manila (owner asked): rates, accountant review of the rules, decisions a-c.
- Payroll: enter each person's rate (Attendance → Pay → Rates) by Mon Nov 16 for the Nov 16-30
  parallel run.
- Statutory rules: have the accountant check the 9 rules (Attendance → Pay → Statutory rules), then approve each
  naming who checked it. Enter government numbers per person.
- Finance upgrade: answer the 8 decisions (2026-11-13 plan), and get the accountant to check the
  statutory rules before the first official payroll (Dec 1-15, released Dec 15).
- Rule found 2026-11-13: Cagayan de Oro minimum wage is ₱500/day since May 1 2026 (Wage Order RX-24,
  Wage Category I). Any daily rate below that is a legal problem; minimum-wage earners are exempt
  from withholding tax on their basic, holiday, overtime and night-shift pay.

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
| 4 | Approvals: stage hand-offs reviewed by the admin, versions kept | 2.5 | Thu Nov 26 | live Nov 13 |
| 5 | Company profile (3.0), bookkeeper in Accounting (3.1), attendance management (3.2) | 3.0–3.2 | Thu Nov 26 | live Nov 13 |
| 6 | Role dashboards and reports | 3.x | — | not started |
| — | Daily salary + semi-monthly payroll from attendance: rates with history, daily estimated earnings beside attendance, OT approval, holidays, cutoffs, approval, payslips, self-service (owner's brief 2026-11-13) | 3.3–3.4 | proposed Tue Nov 17 / Fri Nov 20 | owner decided 2026-11-13 (see decisions); building v3.3 on branch `claude/payroll-v3.3`; formulas need the accountant's sign-off; parallel run Nov 16–30, official from Dec 1–15 |
| — | Finance & compliance + executive dashboard (owner's brief 2026-11-13, "MAJOR PORTAL UPGRADE"): statutory rules engine (BIR, SSS, PhilHealth, Pag-IBIG, versioned with sources), payroll runs with approval and payslips, remittances and filings, compliance calendar, 13th month, benefits, executive dashboard (finance, payroll, calendar, Gantt, risks), AI recommendations | 4.0–4.6 | proposed Nov 17 → Dec 11 | plan proposed 2026-11-13; waiting for 8 owner decisions; needs v3.3 live first; 13th month must be payable by Dec 24 |
| — | Inventory v4: unique codes, QR/barcode labels, scanner, IN/OUT checkout engine, statuses, reports (owner's brief 2026-11-13) | 4.0–4.2 | proposed Fri Nov 20 | plan proposed 2026-11-13; after payroll (owner 2026-11-13); still needs the owner's answers to 5 decisions |

## Version history (newest first)

### 4.0 — 2026-11-13 — Statutory rules engine and government numbers (live)
Migration `20261127000024_statutory_rules.sql`: applied by the owner; verified by the agent through the connector
(16/16 functions match the tested source; live SSS 15,650 -> 775 / 1,580, tax on 46,800 -> 4,568.40; internals closed
to browsers). Branch `claude/finance-v4.0` merged into `claude/portal-supabase` (production).
First part of the finance upgrade, built the night of Nov 13 while the owner's answers are pending (none of
it depends on them). Goes live when the owner runs migration 24 and says "merge".
- Statutory rules engine: every rate in a versioned `statutory_rules` row (agency, parameters, basis,
  floor/ceiling, shares, effective dates, official source with link, checked on/by, status). Never edited
  or deleted: a law change is a new version from its date. Bookkeeper and admin propose; only the admin
  approves (must name who checked it) or retires.
- Seeded, checked by the agent on 2026-11-13, all **waiting for the accountant's review**: SSS 2025
  schedule (official SSS PDF read), PhilHealth 5% 10k-100k (secondary sources; circular number to
  confirm), Pag-IBIG Circular 460 (via the DBM circular letter; effective month to confirm), BIR
  withholding tables daily/weekly/semi-monthly/monthly (RR 11-2018 Annex E, official PDF; the PDF's
  "6,034.00.30" typo read as 6,034.30), Region X minimum wage (RX-24: 486 from Jan 16 2026, 500 from May 1 2026).
- Formulas in SQL: `stat_sss`, `stat_philhealth`, `stat_pagibig`, `stat_withholding`, `stat_minimum_wage`;
  each says which rule it used and whether that rule is approved.
- Government numbers per person (TIN, SSS, PhilHealth, Pag-IBIG, birth date, hired on, minimum-wage
  earner): admin and bookkeeper keep them (not their own unless admin); each person reads their own.
- Pay tab: "Government contributions" (a full month at each rate: SSS, PhilHealth, Pag-IBIG employee /
  employer, tax withheld; minimum-wage earners pay no tax) with a red warning for anyone paid below the
  minimum wage, and "Statutory rules" (source links, status, Approve…/Retire… for the admin).
- Tests: `tests/statutory.test.cjs` (figures by hand from the official tables) and `tests/statutory.browser.cjs`.
- Not in this part (v4.1+): payroll runs, payslips, remittances, filings, compliance calendar, 13th month,
  dashboard. Deduction timing (decision 4) is applied by payroll runs, not here.

### 3.3 — 2026-11-13 — Daily salary from attendance (live)
Migration `20261126000023_salary.sql`: applied 2026-11-13 by the owner in the SQL Editor; the agent then
verified it through the Supabase connector (all 18 functions match the tested source, whitespace-normalised;
browser can't call `pay_day_calc` or insert rates). Branch `claude/payroll-v3.3` merged into
`claude/portal-supabase` the same day (4 days ahead of the Tue Nov 17 due date).
- Rates per person with a history (daily or monthly, daily allowance, employment type, from a date).
  Set by the admin and the bookkeeper (Attendance → Pay → Rates); nobody but the admin sets their own.
  Never edited or deleted: a new rate starts on its date, a mistake is fixed by a newer row with the
  same date.
- Each day's estimated pay from attendance: the day less the minute rate for every minute late, early
  or not worked (never a whole day); a half with only one punch isn't paid; paid leave pays the day;
  Sunday work x1.30; regular holiday x1.00 unworked (only if present or on paid leave the working day
  before), x2.00 worked (x2.60 on a Sunday); special day unpaid unless worked (x1.30, x1.50 on a
  Sunday); approved overtime x1.25 (x1.30 of the day's rate on rest days and holidays); allowance on
  days worked or on paid leave. All are Labor Code defaults; only the admin changes them.
- Pages: Team today has an "Estimated pay" column (total, status, what moved it) and KPI. New Pay tab
  (admin, bookkeeper): date range (defaults to the current cutoff), filters by person, department,
  employment type and kind of day, KPIs (estimated pay, deducted, overtime, unaccounted days), each
  person's days, CSV, Rates, and the payroll settings (bookkeeper reads, admin edits). Staff get "My
  pay" on their own page: cutoff so far, today, release date, their rate, day by day.
- Overtime: the admin approves it per day (Record… → Approve overtime) in 30-minute blocks, never more
  than the clock-out allows.
- Holidays on the Schedule calendar are regular (default) or special (new picker in the event form).
- Release date of each cutoff (1-15 -> 15th, 16-end -> 30th or month end), moved earlier off Sundays
  and holidays (the owner can switch to later).
- Tests: `tests/salary.test.cjs` (October 2026 by hand: cutoff Oct 1-15 = 6,451.88) and
  `tests/salary.browser.cjs`. Fixed on the way: people without a rate showed a full day "not worked"
  for every empty day (208 h in the KPI); the unaccounted count now covers paid people only.
- Not yet (v3.4, Fri Nov 20): cutoffs, approval, payslips, statutory deductions (accountant's table).
- Holiday types: existing holidays on the calendar count as regular until the admin marks the
  special ones.

### 3.2 — 2026-11-13 — Phase 5c: attendance management (live)
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

### 3.1 — 2026-11-13 — Phase 5b: the bookkeeper keeps the books (live)
Commit: see `git log` ("Bookkeeper in Accounting"). Migration `20261124000021_bookkeeper_books.sql`.
- Accounting opens to the bookkeeper (the permission matrix: Accounting = Edit): every report, posting
  and voiding journal entries, settings, chart of accounts, VAT tags. The menu shows it to them.
- Their books are the admin's books, figure for figure: they read (never change) the project
  payments, expenses and company fuel the books post from. Leads, procurement and the rest stay hidden.
- Entries are still voided, never edited or deleted; each one names who posted it, is in the
  activity log, and the admin's bell hears about it.

### 3.0 — 2026-11-13 — Phase 5a: company profile (live)
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

### 2.5 — 2026-11-13 — Phase 4: approvals (live)
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

### 2.4 — 2026-11-12 — One record per fact (live)
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
