// What PostgREST does for supabase.rpc(name, args), against tests/fixtures/local-pg.cjs: call the
// function by named arguments as the signed-in user, and answer like supabase-js would.
// Pass it to createFakeSupabase({rpc: pgRpc(db)}).
function pgRpc(db, actors = {'u-admin': 'admin', 'u-designer': 'designer', 'u-purchaser': 'purchaser'}) {
  const kind = {}, arrays = {};
  const literal = v => v === null || v === undefined ? 'null'
    : "'" + String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/'/g, "''") + "'";
  return function rpc(name, args, user) {
    if (!/^[a-z_]+$/.test(name)) return {data: null, error: {message: 'bad name'}};
    if (!kind[name]) kind[name] = db.must('super', `select case when proretset then 'set' when prorettype = 'void'::regtype then 'void' else 'one' end
      from pg_proc where proname = '${name}' and pronamespace = 'public'::regnamespace`);
    // Like PostgREST: a JSON array sent to an array-typed argument (real[], uuid[]) becomes a Postgres array.
    if (!(name in arrays)) arrays[name] = db.must('super', `select coalesce(string_agg(n, ','), '') from pg_proc p, unnest(p.proargnames, p.proargtypes::oid[]) as a(n, t)
      where p.proname = '${name}' and p.pronamespace = 'public'::regnamespace and t::regtype::text like '%[]'`).split(',');
    const value = k => Array.isArray(args[k]) && arrays[name].includes(k) ? literal('{' + args[k].map(v => v === null ? 'NULL' : '"' + String(v).replace(/(["\\])/g, '\\$1') + '"').join(',') + '}') : literal(args[k]);
    const call = `public.${name}(${Object.keys(args || {}).map(k => `${k} => ${value(k)}`).join(', ')})`;
    const q = kind[name] === 'set' ? `select coalesce(json_agg(t), '[]'::json) from ${call} t`
      : kind[name] === 'void' ? `select ${call}` : `select to_json(${call})`;
    const r = db.sql(user && actors[user.id] ? actors[user.id] : 'anon', q);
    if (!r.ok) {
      // Like PostgREST: the SQLSTATE as code, and the hint. (psql runs with VERBOSITY=verbose.)
      const first = r.err.split('\n')[0].replace(/^ERROR:\s+/, ''), m = /^([0-9A-Z]{5}): ([\s\S]*)$/.exec(first);
      const hint = /^HINT:\s+(.*)$/m.exec(r.err);
      return {data: null, error: {message: m ? m[2] : first, code: m ? m[1] : undefined, hint: hint ? hint[1] : null}};
    }
    return {data: kind[name] === 'void' ? null : JSON.parse(r.out), error: null};
  };
}
module.exports = {pgRpc};
