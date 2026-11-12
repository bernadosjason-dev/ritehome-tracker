// A throwaway local PostgreSQL with the Supabase stand-ins and every migration
// loaded, for tests that check what the database itself enforces. Same setup as
// tests/supabase-rls.test.cjs. Needs PostgreSQL 15+ server binaries.
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
const STUB = path.join(__dirname, "supabase-stub.sql");

const U = {
  admin: "00000000-0000-4000-8000-00000000000a",
  designer: "00000000-0000-4000-8000-00000000000d",
  purchaser: "00000000-0000-4000-8000-00000000000b",
  inactive: "00000000-0000-4000-8000-000000000009"
};

function pgBin() {
  const base = "/usr/lib/postgresql";
  if (fs.existsSync(base)) {
    const v = fs.readdirSync(base).filter((d) => /^\d+$/.test(d)).sort((a, b) => b - a)[0];
    if (v) return path.join(base, v, "bin");
  }
  return path.dirname(execFileSync("which", ["pg_ctl"]).toString().trim());
}

function startLocalPg() {
  const BIN = pgBin();
  const asRoot = process.getuid && process.getuid() === 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-pg-"));
  const data = path.join(dir, "data");
  const port = String(58000 + Math.floor(Math.random() * 2000));
  if (asRoot) execFileSync("chown", ["-R", "postgres", dir]);
  const run = (cmd, args, opts = {}) => {
    const full = asRoot ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args];
    return execFileSync(full[0], full[1], { stdio: "pipe", ...opts });
  };
  const psql = (args) => spawnSync(asRoot ? "runuser" : path.join(BIN, "psql"),
    (asRoot ? ["-u", "postgres", "--", path.join(BIN, "psql")] : []).concat(
      ["-h", dir, "-p", port, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], args),
    { encoding: "utf8" });

  // Runs SQL as an actor ("super", "anon", "service" (the Edge Functions' role), or a key of U). Returns {ok, out} or {ok:false, err}.
  function sql(actor, query) {
    const prefix = actor === "super" ? "" : actor === "anon" ? "set role anon;\n"
      : actor === "service" ? "set role service_role;\nset request.jwt.claims = '{\"role\":\"service_role\"}';\n"
      : `set role authenticated;\nset request.jwt.claim.sub = '${U[actor]}';\n`;
    const res = psql(["-At", "-c", prefix + query]);
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
    return r.err;
  }
  function loadFile(file) {
    const r = psql(["-f", file]);
    assert.equal(r.status, 0, `loading ${path.basename(file)} failed:\n${r.stderr}`);
  }

  run(path.join(BIN, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  // -l sends the server's output to a file: an inherited pipe would keep this process waiting forever.
  run(path.join(BIN, "pg_ctl"), ["-D", data, "-l", path.join(dir, "server.log"), "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "start"], { stdio: "ignore" });
  loadFile(STUB);
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) loadFile(path.join(MIGRATIONS, f));

  function stop() {
    try { run(path.join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]); } catch (e) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { U, sql, must, refused, stop };
}

module.exports = { startLocalPg, U };
