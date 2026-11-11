// What PostgREST does for supabase.rpc(name, args), against tests/fixtures/local-pg.cjs: call the
// function by named arguments as the signed-in user, and answer like supabase-js would.
// Pass it to createFakeSupabase({rpc: pgRpc(db)}).
function pgRpc(db, actors = {'u-admin': 'admin', 'u-designer': 'designer'}) {
  const kind = {};
  const literal = v => v === null || v === undefined ? 'null'
    : "'" + String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/'/g, "''") + "'";
  return function rpc(name, args, user) {
    if (!/^[a-z_]+$/.test(name)) return {data: null, error: {message: 'bad name'}};
    if (!kind[name]) kind[name] = db.must('super', `select case when proretset then 'set' when prorettype = 'void'::regtype then 'void' else 'one' end
      from pg_proc where proname = '${name}' and pronamespace = 'public'::regnamespace`);
    const call = `public.${name}(${Object.keys(args || {}).map(k => `${k} => ${literal(args[k])}`).join(', ')})`;
    const q = kind[name] === 'set' ? `select coalesce(json_agg(t), '[]'::json) from ${call} t`
      : kind[name] === 'void' ? `select ${call}` : `select to_json(${call})`;
    const r = db.sql(user && actors[user.id] ? actors[user.id] : 'anon', q);
    if (!r.ok) return {data: null, error: {message: r.err.split('\n')[0].replace(/^ERROR:\s+/, '')}};
    return {data: kind[name] === 'void' ? null : JSON.parse(r.out), error: null};
  };
}
module.exports = {pgRpc};
