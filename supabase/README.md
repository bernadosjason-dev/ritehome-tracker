# Ritehome portal — Supabase backend

The tracker runs on Supabase: real per-person logins, roles enforced by the
database, and private file storage. This folder holds the database schema and
the Sheet importer; the page talks to it through `../supabase-backend.js`.

## Who can see what

| Role | Sees | Can change |
|---|---|---|
| **admin** | Everything: every project's money (budget, price, billing, expenses, labor), fuel, procurement, all files, everyone's attendance | Everything; plans stage dates and assigns people |
| **designer** | Assigned projects only: name, system, client name and phone, address, status, target date | Design, cutlist and BOM stages; uploads into those stages |
| **fabrication** | Same as designer | The fabrication stage |
| **installer** | Same as designer | The installation and handover stages |

Nobody but an admin ever sees budget, price, billing, expenses or a client's
email. A new account sees nothing until an admin activates it and sets its role.
Staff can update a stage's status, actual dates and notes; only an admin can
change planned dates or who a stage is assigned to.

**Attendance** is four punches a day: 8:00 in, 12:00 out, 1:00 in, 5:00 out
(Manila time). Each punch saves a selfie and the phone's location *at that
moment*. Nothing is tracked between punches. The punch time comes from the
server clock, so a phone can't backdate it. Punches are flagged automatically
(`late`, `early_out`, `face_mismatch`, `no_face_check`, `low_gps_accuracy`) for
the admin to review. A punch can't be edited afterwards, by anyone; the admin
adds a review note instead. Each person must accept the attendance notice
before their first punch.

Face data: each person's face is enrolled once, in the admin's presence, as a
128-number descriptor. The phone compares each selfie against it and records a
similarity score. This flags likely mismatches. It is not tamper-proof: someone
holding up a photo can fool it. That's why every punch keeps its selfie for the
admin to check.

## Live project

- Project: **Ritehome** (`laxavfldivkhufeubgmb`), region Southeast Asia (Singapore),
  free plan, in the `bernadoscecel-design` organization.
- Migrations applied: `portal_core`, `portal_storage`, `portal_harden`
  (2026-11-05), `tracker_backend` (2026-11-08: row order, longer ids, the
  public-by-unguessable-name `receipts` bucket).
- `accounting` (2026-11-11, `20261111000005_accounting.sql`): applied with its
  comment lines stripped; every `acct_*` function and view definition was then
  checked by md5 against a local load of the file and matched exactly.
- `leads` (2026-11-11, `20261112000006_leads.sql`): applied the same way, md5-checked;
  the website Worker's intake key hash is in `app_secrets` (see below).
- `stage_vocabulary`, `schedule`, `board_system` (2026-11-12,
  `20261113000007`–`20261113000009`): applied as three separate migrations,
  comment-stripped; every function md5-checked against a local load and
  matched. The 16 rows of the office whiteboard were loaded the same day
  (project ids `p_wb…`, `importedFrom` "office whiteboard 2026-11-12"), with no
  start or finish dates, since the board never recorded any.
- `team` (2026-11-14, `20261114000010_team.sql`): applied comment-stripped, all three
  functions md5-checked against a local load and matched; anon can't execute them.
  The `team-admin` Edge Function (`supabase/functions/team-admin/`, version 1) was
  deployed the same day with JWT verification **off**: it checks the caller's token and
  admin profile itself, and the platform check would also block the browser's CORS
  preflight. It uses the `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` that Supabase
  gives every function; no secret needs setting. Redeploy it after any change to
  `core.js` (upload both files).
- Data: imported from the "Ritehome Tracker Data" Sheet on 2026-11-08 with
  `import-from-sheet.cjs` (1 project, 11 expenses, 1 vehicle, 7 fuel purchases,
  2 procurement jobs, 1 procurement record). Totals checked against the Sheet.
  **Re-run the import at cutover**: anything entered through the old Apps Script
  link after 2026-11-08 is only in the Sheet until then. Verified live: row-level security on every table, signed-out
  visitors get nothing, both buckets private, and a rolled-back probe account
  came up inactive and saw only its own profile.
- Supabase's security advisor still lists eight signed-in-callable SECURITY
  DEFINER functions. That's intended: see the comment at the top of
  `20261105000003_portal_harden.sql`.

## One-time setup

1. **Create the account.** Sign up at [supabase.com](https://supabase.com) with
   the business Google account (not the one that holds the Athlos projects:
   its free plan is full).
2. **Create the project.** Name: `Ritehome`. Region: **Southeast Asia
   (Singapore)**. Save the database password in a password manager; you won't
   need to type it anywhere for this setup.
3. **Turn off public sign-ups.** Authentication → Sign In / Providers → **Allow
   new users to sign up: off**. Staff accounts are created by invitation only
   (Authentication → Users → **Invite user**).
4. **Load the schema.** Either:
   - **Let Claude do it:** in claude.ai, Settings → Connectors → Supabase,
     reconnect it signed in to the *new* account. Claude then applies the
     migrations directly; or
   - **Do it by hand:** SQL Editor → paste and run
     `migrations/20261105000001_portal_core.sql`, then
     `migrations/20261105000002_portal_storage.sql`, in that order.
5. **Make yourself admin.** Invite yourself (step 3), accept the email, then in
   the SQL Editor run, with your own email:

   ```sql
   update public.profiles set role = 'admin', active = true, full_name = 'Jason Bernados'
   where id = (select id from auth.users where email = 'you@example.com');
   ```

   This is the only time SQL is needed: every later account is activated from
   the portal by an admin.

## Website lead intake key

The website's Cloudflare Worker (repo `ritehome-website`) sends every form
submission and every phone/email Hannah captures to `ingest_lead(p, p_key)`.
That function refuses any `p_key` whose SHA-256 isn't in `app_secrets` under
`lead_ingest`. No API role can read that table. The key itself exists only as the
Worker secret `PORTAL_LEAD_KEY`. Never commit the key or its hash.

To set or rotate it:

1. Make a new key: `openssl rand -hex 32`.
2. Store its hash, in the SQL Editor (or through the Supabase connector):
   ```sql
   insert into public.app_secrets (name, sha256)
   values ('lead_ingest', encode(sha256(convert_to('<the key>', 'UTF8')), 'hex'))
   on conflict (name) do update set sha256 = excluded.sha256;
   ```
3. Put the same key in Cloudflare: Workers & Pages → ritehome-hannah →
   Settings → Variables and Secrets → `PORTAL_LEAD_KEY` (type Secret).

Website leads stop reaching the portal between steps 2 and 3, though they still
reach Telegram, so do both together.

## Moving the data from the Google Sheet

1. Export each tab's values (Sheets API `values.get`, or have Claude read them
   with the Google Sheets connector) into one JSON file:
   `{"Projects": [[header...], [row...]], "Expenses": ..., "Company Vehicles": ...,
   "Company Fuel": ..., "Procurement Jobs": ..., "Procurement": ...}`.
2. `node supabase/import-from-sheet.cjs sheet-values.json > import.sql`. It
   prints per-collection counts and any row it had to skip.
3. Run `import.sql` in the SQL Editor (or through the Supabase connector). It
   keeps every id and the sheet order, and overwrites records already imported,
   so it is safe to run again. Delete `import.sql` afterwards: it is business
   data, and this repository is public.

## Testing the rules

```
node --test tests/supabase-rls.test.cjs
```

Starts a throwaway local PostgreSQL (needs the server binaries: `initdb`,
`pg_ctl`), loads `tests/fixtures/supabase-stub.sql` in place of Supabase's auth
and storage schemas, applies every migration, then tries each rule from the
side that should be refused: signed-out visitors, inactive accounts, each staff
role reaching for money, other roles' stages, unassigned projects, other
people's selfies, backdated or edited punches. This proves the SQL; it does
not prove the live project's settings (sign-ups off, buckets created). Check
those in the dashboard after step 4.

Never change a migration that has been applied to the live project. Add a new,
later-numbered file instead.
