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
- 2026-11-13 Duplicates: one record per fact. A thing typed in one workspace is never typed again
  in another.
- Brutal honesty in reports to the owner; every task has a deadline.

## Live state (update when it changes)

| What | Live | Notes |
|---|---|---|
| Supabase project | `laxavfldivkhufeubgmb` | migrations 01–17 applied and md5-checked; **18 and 19 pending** (2026-11-13: two apply attempts for 18 timed out, the approval card went unanswered; checked afterwards, nothing was applied) |
| Edge Function `team-admin` | v4 | JWT verification off (checks the caller itself) |
| Edge Function `notify-telegram` | v1 | needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` secrets (owner sets them) |
| Vercel `ritehome-portal` | commit `2457d30` (v2.3) | portal.ritehomemodular.com; branch `claude/portal-supabase` |

## Owner to-dos

- Approve migration 18 (and 19, Phase 4) in the Supabase card, then the site is deployed.
- Telegram: add the two Edge Function secrets in the Supabase dashboard (never in chat).
- Shelf count in Inventory before relying on stock: deliveries before v2.4 are not in stock.
- Check the clients with more than one open project (Dandan ×3, Ar. Amerol ×2, Mayor Azum ×2):
  separate jobs, or accidental doubles to close.
- Backups decision (reminder Fri Nov 20).

## Roadmap (CRM master prompt)

| Phase | What | Version | Due | State |
|---|---|---|---|---|
| 1 | Roles: sales, bookkeeper, several roles per person, role menu | 2.0 | Nov 12 | live |
| 2 | Activity log | 2.1 | Nov 12 | live |
| 3 | Notifications: bell, Telegram | 2.2 | Nov 12 | live (Telegram waits for secrets) |
| 4 | Approvals: stage hand-offs reviewed by the admin, versions kept | 2.5 | Thu Nov 26 | built, pending migration |
| 5 | Company profile, bookkeeper books, attendance corrections | 3.x | — | not started |
| 6 | Role dashboards and reports | 3.x | — | not started |

## Version history (newest first)

### 2.5 — 2026-11-13 — Phase 4: approvals (pending: migration 19 not applied, not deployed)
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
- Fix: page-to-page transitions that Chromium skips no longer leave an unhandled error (the
  portals test still trips on it about 1 run in 8; not a user-facing fault).

### 2.4 — 2026-11-12 — One record per fact (pending: migration 18 not applied, not deployed)
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
