// Row-level security checks for supabase/migrations, run against a throwaway
// local PostgreSQL with tests/fixtures/supabase-stub.sql standing in for
// Supabase's auth and storage schemas. Every rule is tested from the side that
// should be refused, not only the side that should work.
//
//   node --test tests/supabase-rls.test.cjs
//
// Needs PostgreSQL 15+ server binaries (initdb, pg_ctl) on this machine. This
// does not prove the live Supabase project is configured: it proves the SQL.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const STUB = path.join(__dirname, "fixtures", "supabase-stub.sql");

function pgBin() {
  const base = "/usr/lib/postgresql";
  if (fs.existsSync(base)) {
    const v = fs.readdirSync(base).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a)[0];
    if (v) return path.join(base, v, "bin");
  }
  return path.dirname(execFileSync("which", ["pg_ctl"]).toString().trim());
}
const BIN = pgBin();
const asRoot = process.getuid && process.getuid() === 0;
function run(cmd, args, opts = {}) {
  const full = asRoot ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args];
  return execFileSync(full[0], full[1], { stdio: "pipe", ...opts });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-pg-"));
const data = path.join(dir, "data");
const port = String(56000 + Math.floor(Math.random() * 2000));
if (asRoot) execFileSync("chown", ["-R", "postgres", dir]);

const U = {
  admin: "00000000-0000-4000-8000-00000000000a",
  designer: "00000000-0000-4000-8000-00000000000d",
  fab: "00000000-0000-4000-8000-00000000000f",
  installer: "00000000-0000-4000-8000-000000000001",
  inactive: "00000000-0000-4000-8000-000000000009"
};

// Runs SQL as an actor. Returns {ok, out} or {ok:false, err}.
function sql(actor, query) {
  const prefix = actor === "super" ? "" : actor === "anon" ? "set role anon;\n"
    : `set role authenticated;\nset request.jwt.claim.sub = '${U[actor]}';\n`;
  const res = spawnSync(asRoot ? "runuser" : path.join(BIN, "psql"),
    (asRoot ? ["-u", "postgres", "--", path.join(BIN, "psql")] : []).concat(
      ["-h", dir, "-p", port, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q", "-c", prefix + query]),
    { encoding: "utf8" });
  return res.status === 0 ? { ok: true, out: res.stdout.trim() } : { ok: false, err: res.stderr.trim() };
}
function must(actor, query) {
  const r = sql(actor, query);
  assert.ok(r.ok, `expected success for ${actor}: ${query}\n${r.err}`);
  return r.out;
}
function refused(actor, query, pattern) {
  const r = sql(actor, query);
  assert.ok(!r.ok, `expected ${actor} to be refused: ${query}\ngot: ${r.out}`);
  if (pattern) assert.match(r.err, pattern);
}
function loadFile(file) {
  const r = spawnSync(asRoot ? "runuser" : path.join(BIN, "psql"),
    (asRoot ? ["-u", "postgres", "--", path.join(BIN, "psql")] : []).concat(
      ["-h", dir, "-p", port, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-f", file]),
    { encoding: "utf8" });
  assert.equal(r.status, 0, `loading ${path.basename(file)} failed:\n${r.stderr}`);
}

test.before(() => {
  run(path.join(BIN, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  // -l sends the server's output to a file: an inherited pipe would keep this process waiting forever.
  run(path.join(BIN, "pg_ctl"), ["-D", data, "-l", path.join(dir, "server.log"), "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { stdio: "ignore" });
  loadFile(STUB);
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) loadFile(path.join(MIGRATIONS, f));

  must("super", `insert into auth.users (id, email, raw_user_meta_data) values
    ('${U.admin}', 'owner@example.com', '{"full_name":"Owner"}'),
    ('${U.designer}', 'designer@example.com', '{"full_name":"Dana Designer"}'),
    ('${U.fab}', 'fab@example.com', '{"full_name":"Fred Fab"}'),
    ('${U.installer}', 'installer@example.com', '{"full_name":"Ivan Installer"}'),
    ('${U.inactive}', 'new@example.com', '{}');`);
});
test.after(() => {
  try { run(path.join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]); } catch (e) {}
  fs.rmSync(dir, { recursive: true, force: true });
});

test("new accounts start inactive and see nothing", () => {
  assert.equal(must("super", `select role || ',' || active from public.profiles where id = '${U.inactive}'`), "installer,false");
  assert.equal(must("super", `select full_name from public.profiles where id = '${U.designer}'`), "Dana Designer");
  // Only the database owner (Supabase SQL editor) bootstraps the first admin.
  must("super", `update public.profiles set role = 'admin', active = true where id = '${U.admin}';`);
  assert.equal(must("inactive", "select count(*) from public.profiles where active"), "0");
  assert.equal(must("inactive", "select public.my_role() is null"), "t");
});

test("only an admin activates staff and sets roles; nobody promotes themselves", () => {
  must("admin", `update public.profiles set active = true, role = 'designer' where id = '${U.designer}';
                 update public.profiles set active = true, role = 'fabrication' where id = '${U.fab}';
                 update public.profiles set active = true, role = 'installer' where id = '${U.installer}';`);
  assert.equal(must("designer", `update public.profiles set role = 'admin' where id = '${U.designer}' returning id`), "");
  assert.equal(must("inactive", `update public.profiles set active = true where id = '${U.inactive}' returning id`), "");
  assert.equal(must("super", `select role from public.profiles where id = '${U.designer}'`), "designer");
  assert.equal(must("designer", "select count(*) from public.profiles"), "1", "staff read only their own profile");
  assert.equal(must("designer", "select count(*) from public.staff_directory()"), "4", "active staff are listed by name");
  assert.equal(must("inactive", "select count(*) from public.staff_directory()"), "0");
});

test("signed-out visitors can't read or call anything", () => {
  refused("anon", "select count(*) from public.tracker_docs", /permission denied/);
  refused("anon", "select count(*) from public.attendance_punches", /permission denied/);
  refused("anon", "select * from public.my_projects()", /permission denied/);
});

test("the admin keeps the whole tracker; each project gets its pipeline", () => {
  must("admin", `insert into public.tracker_docs (collection, id, data) values
    ('projects', 'P1', '{"name":"Ana kitchen","system":"Kitchen","clientName":"Ana","clientPhone":"0917","clientEmail":"ana@example.com","address":"Carmen, CDO","budget":250000,"price":310000,"status":"active","targetDate":"2026-12-15"}'),
    ('projects', 'P2', '{"name":"Office floor","system":"Workspace","budget":900000,"price":1100000}'),
    ('expenses', 'E1', '{"amount":12000,"note":"marine plywood"}');`);
  assert.equal(must("admin", "select count(*) from public.project_stages where project_id = 'P1'"), "8");
  assert.equal(must("admin", "select string_agg(stage::text, ',' order by stage) from public.project_stages where project_id = 'P1'"),
    "consultation,design,cutlist,bom,procurement,fabrication,installation,handover");
  assert.equal(must("admin", "select revision from public.tracker_docs where id = 'P1'"), "1");
  must("admin", `update public.tracker_docs set data = data || '{"status":"active"}' where id = 'P1'`);
  assert.equal(must("admin", "select revision from public.tracker_docs where id = 'P1'"), "2");
  must("admin", `insert into public.project_assignments (project_id, user_id) values
    ('P1', '${U.designer}'), ('P1', '${U.fab}'), ('P1', '${U.installer}');`);
});

test("staff never see money: no tracker documents, only the safe project view", () => {
  for (const who of ["designer", "fab", "installer"]) {
    assert.equal(must(who, "select count(*) from public.tracker_docs"), "0", `${who} sees no raw documents`);
    assert.equal(must(who, "select id || '|' || name || '|' || client_phone || '|' || address from public.my_projects()"),
      "P1|Ana kitchen|0917|Carmen, CDO", `${who} sees only assigned P1`);
  }
  const view = must("designer", "select row_to_json(p)::text from public.my_projects() p");
  for (const hidden of ["budget", "price", "250000", "310000", "ana@example.com", "billing"]) {
    assert.ok(!view.includes(hidden), `my_projects() must not expose ${hidden}`);
  }
  refused("designer", `insert into public.tracker_docs (collection, id) values ('projects', 'P9')`, /row-level security/);
  assert.equal(must("designer", "update public.tracker_docs set data = '{}' returning id"), "");
  assert.equal(must("inactive", "select count(*) from public.my_projects()"), "0");
});

test("each role moves only its own stages, only on assigned projects", () => {
  assert.equal(must("designer", "update public.project_stages set status = 'in_progress' where project_id = 'P1' and stage = 'design' returning stage"), "design");
  assert.equal(must("designer", "update public.project_stages set status = 'done' where project_id = 'P1' and stage = 'fabrication' returning stage"), "");
  assert.equal(must("fab", "update public.project_stages set status = 'in_progress', actual_start = '2026-11-20' where project_id = 'P1' and stage = 'fabrication' returning stage"), "fabrication");
  assert.equal(must("installer", "update public.project_stages set status = 'done' where project_id = 'P1' and stage = 'design' returning stage"), "");
  assert.equal(must("installer", "update public.project_stages set notes = 'site ready' where project_id = 'P1' and stage = 'installation' returning stage"), "installation");
  assert.equal(must("designer", "select count(*) from public.project_stages where project_id = 'P2'"), "0", "unassigned project hidden");
  assert.equal(must("designer", "update public.project_stages set status = 'done' where project_id = 'P2' and stage = 'design' returning stage"), "");
  // Nobody but consultation/procurement's owner (admin) touches those stages.
  assert.equal(must("designer", "update public.project_stages set status = 'done' where project_id = 'P1' and stage = 'procurement' returning stage"), "");
});

test("only an admin plans dates and assigns; staff can't reschedule", () => {
  refused("designer", "update public.project_stages set planned_end = '2027-01-01' where project_id = 'P1' and stage = 'design'", /Only an admin/);
  refused("fab", `update public.project_stages set assignee = '${U.fab}' where project_id = 'P1' and stage = 'fabrication'`, /Only an admin/);
  must("admin", `update public.project_stages set planned_start = '2026-11-10', planned_end = '2026-11-18', assignee = '${U.designer}' where project_id = 'P1' and stage = 'design'`);
  refused("admin", "update public.project_stages set planned_start = '2026-12-01', planned_end = '2026-11-01' where project_id = 'P1' and stage = 'cutlist'", /check constraint/);
  assert.equal(must("super", "select updated_by from public.project_stages where project_id = 'P1' and stage = 'design'"), U.admin);
});

test("files: upload only into your own stages, read only assigned projects", () => {
  must("designer", `insert into public.project_files (project_id, stage, kind, file_name, storage_path, size_bytes)
    values ('P1', 'design', 'sketchup', 'kitchen.skp', 'P1/design/a1-kitchen.skp', 5242880)`);
  refused("designer", `insert into public.project_files (project_id, stage, kind, file_name, storage_path, size_bytes)
    values ('P1', 'fabrication', 'photo', 'x.jpg', 'P1/fabrication/a2-x.jpg', 100)`, /row-level security/);
  refused("designer", `insert into public.project_files (project_id, stage, kind, file_name, storage_path, size_bytes)
    values ('P1', 'design', 'sketchup', 'x.skp', 'P2/design/a3-x.skp', 100)`, /check constraint/);
  refused("designer", `insert into public.project_files (project_id, stage, kind, file_name, storage_path, size_bytes, uploaded_by)
    values ('P1', 'design', 'other', 'x.txt', 'P1/design/a4-x.txt', 100, '${U.fab}')`, /row-level security/);
  assert.equal(must("fab", "select count(*) from public.project_files where project_id = 'P1'"), "1", "assigned staff can read");
  assert.equal(must("inactive", "select count(*) from public.project_files"), "0");
});

test("storage objects follow the same project and stage rules", () => {
  must("designer", "insert into storage.objects (bucket_id, name) values ('project-files', 'P1/design/a1-kitchen.skp')");
  refused("designer", "insert into storage.objects (bucket_id, name) values ('project-files', 'P1/fabrication/b-cut.jpg')", /row-level security/);
  refused("designer", "insert into storage.objects (bucket_id, name) values ('project-files', 'P2/design/c-x.skp')", /row-level security/);
  must("fab", "insert into storage.objects (bucket_id, name) values ('project-files', 'P1/fabrication/d-cut.jpg')");
  assert.equal(must("installer", "select count(*) from storage.objects where bucket_id = 'project-files'"), "2");
  assert.equal(must("designer", "delete from storage.objects where name = 'P1/fabrication/d-cut.jpg' returning name"), "", "can't delete another stage's file");
  refused("anon", "insert into storage.objects (bucket_id, name) values ('project-files', 'P1/design/z.skp')", /row-level security/);
});

test("calendar: staff see their projects' events and company-wide ones", () => {
  must("admin", `insert into public.project_events (project_id, kind, title, starts_at, ends_at) values
    ('P1', 'site_visit', 'Measure Ana kitchen', '2026-11-12 09:00+08', '2026-11-12 10:30+08'),
    ('P2', 'delivery', 'Deliver office desks', '2026-11-20 08:00+08', '2026-11-20 12:00+08'),
    (null, 'holiday', 'Bonifacio Day', '2026-11-30 00:00+08', '2026-11-30 23:59+08')`);
  assert.equal(must("installer", "select string_agg(title, ',' order by starts_at) from public.project_events"), "Measure Ana kitchen,Bonifacio Day");
  refused("installer", "insert into public.project_events (kind, title, starts_at, ends_at) values ('other', 'x', now(), now())", /row-level security/);
  assert.equal(must("inactive", "select count(*) from public.project_events"), "0");
});

function manilaTime() {
  const s = new Date().toLocaleString("en-GB", { timeZone: "Asia/Manila", hour12: false, hour: "2-digit", minute: "2-digit" });
  return s.replace(/ |\s/g, "");
}

test("attendance: consent first, own folder only, server clock, flags computed", () => {
  refused("designer", `insert into public.attendance_punches (kind, lat, lng, accuracy_m, selfie_path)
    values ('am_in', 8.4542, 124.6319, 12, '${U.designer}/2026-11-05-am_in.jpg')`, /attendance notice/);
  refused("inactive", "select public.accept_attendance_notice()", /not active/);
  assert.ok(must("designer", "select public.accept_attendance_notice() is not null") === "t");
  const first = must("designer", "select public.accept_attendance_notice()");
  assert.equal(must("designer", "select public.accept_attendance_notice()"), first, "consent time never moves");

  refused("designer", `insert into public.attendance_punches (kind, lat, lng, accuracy_m, selfie_path)
    values ('am_in', 8.45, 124.63, 12, '${U.fab}/stolen.jpg')`, /own folder/);
  refused("designer", `insert into public.attendance_punches (user_id, kind, lat, lng, accuracy_m, selfie_path)
    values ('${U.fab}', 'am_in', 8.45, 124.63, 12, '${U.fab}/x.jpg')`, /row-level security|only clock in for yourself/);

  // A backdated time, a forged review and a forged flag list are all overwritten.
  const row = must("designer", `insert into public.attendance_punches
      (kind, lat, lng, accuracy_m, selfie_path, face_match, punched_at, work_date, flags, admin_note, reviewed_by)
    values ('am_in', 8.4542, 124.6319, 12, '${U.designer}/am_in.jpg', 0.31, '2020-01-01 07:00+08', '2020-01-01', '{}', 'ok', '${U.admin}')
    returning extract(epoch from now() - punched_at) < 5, work_date = (now() at time zone 'Asia/Manila')::date,
              array_to_string(flags, ','), admin_note, reviewed_by is null`);
  const [fresh, today, flags, note, unreviewed] = row.split("|");
  assert.equal(fresh, "t", "punch time comes from the server");
  assert.equal(today, "t", "work date is today in Manila");
  assert.equal(note, "");
  assert.equal(unreviewed, "t");
  const expectLate = manilaTime() > "08:00";
  assert.deepEqual(flags.split(",").filter(Boolean).sort(), [...(expectLate ? ["late"] : []), "face_mismatch"].sort());

  refused("designer", `insert into public.attendance_punches (kind, lat, lng, accuracy_m, selfie_path)
    values ('am_in', 8.45, 124.63, 12, '${U.designer}/again.jpg')`, /duplicate key/);
  const lowGps = must("designer", `insert into public.attendance_punches (kind, lat, lng, accuracy_m, selfie_path)
    values ('pm_out', 8.45, 124.63, 450, '${U.designer}/pm_out.jpg') returning array_to_string(flags, ',')`);
  assert.ok(lowGps.includes("low_gps_accuracy") && lowGps.includes("no_face_check"));
  refused("designer", `insert into public.attendance_punches (kind, lat, lng, selfie_path)
    values ('pm_in', 95, 124.63, '${U.designer}/pm_in.jpg')`, /check constraint/);
});

test("attendance: private to each person, admin reviews but can't alter a punch", () => {
  must("fab", "select public.accept_attendance_notice()");
  must("fab", `insert into public.attendance_punches (kind, lat, lng, accuracy_m, selfie_path, face_match)
    values ('am_in', 8.48, 124.65, 8, '${U.fab}/am_in.jpg', 0.92)`);
  assert.equal(must("fab", "select count(*) from public.attendance_punches"), "1", "fab sees only their own punch");
  assert.equal(must("designer", "select count(*) from public.attendance_punches"), "2");
  assert.equal(must("admin", "select count(*) from public.attendance_punches"), "3", "admin sees everyone");
  assert.equal(must("designer", "update public.attendance_punches set lat = 0 returning id"), "", "staff can't edit punches");
  assert.equal(must("designer", "delete from public.attendance_punches returning id"), "", "staff can't delete punches");
  must("admin", `update public.attendance_punches set admin_note = 'traffic on Corrales', reviewed_by = '${U.admin}', reviewed_at = now() where user_id = '${U.fab}'`);
  refused("admin", `update public.attendance_punches set lat = 0 where user_id = '${U.fab}'`, /can't be edited/);
  refused("admin", `update public.attendance_punches set flags = '{}' where user_id = '${U.designer}'`, /can't be edited/);
});

test("selfie storage: write once into your own folder, admin reads all", () => {
  must("designer", `insert into storage.objects (bucket_id, name) values ('attendance-selfies', '${U.designer}/2026-11-05-am_in.jpg')`);
  refused("designer", `insert into storage.objects (bucket_id, name) values ('attendance-selfies', '${U.fab}/2026-11-05-am_in.jpg')`, /row-level security/);
  refused("inactive", `insert into storage.objects (bucket_id, name) values ('attendance-selfies', '${U.inactive}/x.jpg')`, /row-level security/);
  must("fab", `insert into storage.objects (bucket_id, name) values ('attendance-selfies', '${U.fab}/2026-11-05-am_in.jpg')`);
  assert.equal(must("designer", "select count(*) from storage.objects where bucket_id = 'attendance-selfies'"), "1");
  assert.equal(must("admin", "select count(*) from storage.objects where bucket_id = 'attendance-selfies'"), "2");
  assert.equal(must("designer", "delete from storage.objects where bucket_id = 'attendance-selfies' returning name"), "", "staff can't delete selfies");
  assert.equal(must("designer", "update storage.objects set name = 'x' where bucket_id = 'attendance-selfies' returning name"), "", "staff can't overwrite selfies");
});

test("internal trigger functions can't be called through the API, yet still fire", () => {
  for (const fn of ["handle_new_user", "guard_stage_update", "seed_project_stages", "prepare_punch", "guard_punch_update", "touch_tracker_doc"]) {
    assert.equal(must("super", `select has_function_privilege('authenticated', 'public.${fn}()', 'execute')`), "f", fn);
  }
  // Triggers fired above as signed-in users (stage seeding, punch preparation, the
  // stage guard) after the revoke; check the definer helpers are pinned too.
  assert.equal(must("super", `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proconfig is null and p.prokind = 'f'`), "0", "every public function pins search_path");
});

test("deleting a project removes its pipeline, files rows, events and assignments", () => {
  must("admin", "delete from public.tracker_docs where collection = 'projects' and id = 'P1'");
  for (const t of ["project_stages", "project_files", "project_events", "project_assignments"]) {
    assert.equal(must("super", `select count(*) from public.${t} where project_id = 'P1'`), "0", t);
  }
});
