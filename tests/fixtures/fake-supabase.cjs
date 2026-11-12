// A stand-in for the Supabase project, for browser tests: the page loads this shim in place of
// vendor/supabase-js, and every query it builds is sent to Node, where an in-memory copy of
// tracker_docs, the receipts bucket and the sign-in users answers it with the same semantics
// as the live project (row order by seq, revision bumped on update, duplicate keys refused
// with 23505, everything admin-only through row-level security).
const SHIM = String.raw`(function(){
  function send(msg){ return window.__fakeSupabase(JSON.stringify(msg)).then(JSON.parse); }
  function toBase64(file){
    if(file instanceof Blob) return new Promise(function(res){ var r = new FileReader(); r.onload = function(){ res(String(r.result).split(',')[1] || ''); }; r.readAsDataURL(file); });
    var s = ''; for(var i = 0; i < file.length; i++) s += String.fromCharCode(file[i]); return Promise.resolve(btoa(s));
  }
  function builder(table){
    var q = {table: table, op: 'select', filters: [], order: null, range: null, single: null, returning: false, payload: null};
    var b = {
      select: function(){ if(q.op === 'select') q.op = 'select'; else q.returning = true; return b; },
      insert: function(rows){ q.op = 'insert'; q.payload = rows; return b; },
      update: function(patch){ q.op = 'update'; q.payload = patch; return b; },
      delete: function(){ q.op = 'delete'; return b; },
      eq: function(col, val){ q.filters.push([col, val]); return b; },
      order: function(col, o){ q.order = [col, !o || o.ascending !== false]; return b; },
      range: function(a, z){ q.range = [a, z]; return b; },
      maybeSingle: function(){ q.single = 'maybe'; return b; },
      single: function(){ q.single = 'one'; return b; },
      then: function(ok, bad){ return send({kind: 'query', session: session && session.access_token, q: q}).then(ok, bad); }
    };
    return b;
  }
  var session = null, listeners = [];
  try { session = JSON.parse(localStorage.getItem('fake-sb-session')); } catch(e){}
  function setSession(s, event){
    session = s;
    try { if(s) localStorage.setItem('fake-sb-session', JSON.stringify(s)); else localStorage.removeItem('fake-sb-session'); } catch(e){}
    listeners.forEach(function(cb){ cb(event, s); });
  }
  window.supabase = {createClient: function(url, key){
    window.__fakeSupabaseConfig = {url: url, key: key};
    return {
      auth: {
        getSession: function(){ return Promise.resolve({data: {session: session}, error: null}); },
        signInWithPassword: function(c){ return send({kind: 'signIn', email: c.email, password: c.password}).then(function(r){
          if(r.error) return {data: {session: null}, error: r.error};
          setSession(r.session, 'SIGNED_IN'); return {data: {session: r.session}, error: null};
        }); },
        signOut: function(){ setSession(null, 'SIGNED_OUT'); return Promise.resolve({error: null}); },
        updateUser: function(attrs){ return send({kind: 'updateUser', session: session && session.access_token, attrs: attrs}).then(function(r){
          if(r.error) return {data: {user: null}, error: r.error};
          setSession(Object.assign({}, session, {user: r.user}), 'USER_UPDATED'); return {data: {user: r.user}, error: null};
        }); },
        onAuthStateChange: function(cb){ listeners.push(cb); return {data: {subscription: {unsubscribe: function(){}}}}; }
      },
      rpc: function(name, args){ return send({kind: 'rpc', name: name, args: args || {}, session: session && session.access_token}); },
      from: builder,
      storage: {from: function(bucket){ return {
        upload: function(path, file, opts){ return toBase64(file).then(function(b64){ return send({kind: 'upload', session: session && session.access_token, bucket: bucket, path: path, b64: b64, type: opts && opts.contentType}); }); },
        remove: function(paths){ return send({kind: 'remove', session: session && session.access_token, bucket: bucket, paths: paths}); },
        createSignedUrl: function(path){ return Promise.resolve({data: {signedUrl: 'https://laxavfldivkhufeubgmb.supabase.co/storage/v1/object/sign/' + bucket + '/' + path + '?token=test'}, error: null}); }
      }; }}
    };
  }};
})();`;

// opts.rpc(name, args, user) answers any function but my_role (e.g. from a real local PostgreSQL).
// opts.delayMs holds every answer back that long.
function createFakeSupabase(opts = {}) {
  const users = [
    {id: 'u-admin', email: 'admin@ritehome.test', password: 'admin-pass', role: 'admin', active: true},
    {id: 'u-designer', email: 'designer@ritehome.test', password: 'designer-pass', role: 'designer', active: true},
    {id: 'u-new', email: 'new@ritehome.test', password: 'new-pass', role: null, active: false}
  ];
  (opts.users || []).forEach(u => users.push(u));   // extra people, e.g. {id, email, password, role, active, meta: {must_change_password: true}}
  const rows = [], files = new Map(), log = [];
  let seq = 0;
  const who = token => users.find(u => 'token-' + u.id === token) || null;
  const isAdmin = token => { const u = who(token); return !!(u && u.active && u.role === 'admin'); };
  const rls = {code: '42501', message: 'new row violates row-level security policy for table "tracker_docs"'};
  const match = (r, filters) => filters.every(([c, v]) => r[c] === v);
  const pick = r => ({id: r.id, parent_id: r.parent_id, data: JSON.parse(JSON.stringify(r.data)), revision: r.revision});

  function query(token, q) {
    if (q.table !== 'tracker_docs') return {data: null, error: {code: '42P01', message: 'relation does not exist'}};
    const admin = isAdmin(token);
    log.push(q.op);
    if (q.op === 'select') {
      let list = admin ? rows.filter(r => match(r, q.filters)) : [];
      if (q.order) list = list.slice().sort((a, b) => (a[q.order[0]] - b[q.order[0]]) * (q.order[1] ? 1 : -1));
      if (q.range) list = list.slice(q.range[0], q.range[1] + 1);
      list = list.map(pick);
      if (q.single === 'maybe') return list.length > 1 ? {data: null, error: {code: 'PGRST116', message: 'multiple rows'}} : {data: list[0] || null, error: null};
      if (q.single === 'one') return list.length === 1 ? {data: list[0], error: null} : {data: null, error: {code: 'PGRST116', message: 'not one row'}};
      return {data: list, error: null};
    }
    if (q.op === 'insert') {
      if (!admin) return {data: null, error: rls};
      const incoming = Array.isArray(q.payload) ? q.payload : [q.payload];
      for (const r of incoming) if (rows.some(x => x.collection === r.collection && x.id === r.id) || incoming.filter(x => x.collection === r.collection && x.id === r.id).length > 1)
        return {data: null, error: {code: '23505', message: 'duplicate key value violates unique constraint "tracker_docs_pkey"'}};
      const added = incoming.map(r => { const row = {collection: r.collection, id: r.id, parent_id: r.parent_id ?? null, data: r.data, revision: 1, seq: ++seq}; rows.push(row); return row; });
      if (!q.returning) return {data: null, error: null};
      return q.single === 'one' ? {data: pick(added[0]), error: null} : {data: added.map(pick), error: null};
    }
    if (q.op === 'update') {
      const hit = admin ? rows.filter(r => match(r, q.filters)) : [];
      hit.forEach(r => { r.data = JSON.parse(JSON.stringify(q.payload.data)); r.revision += 1; });
      return {data: q.returning ? hit.map(pick) : null, error: null};
    }
    if (q.op === 'delete') {
      if (admin) for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], q.filters)) rows.splice(i, 1);
      return {data: null, error: null};
    }
  }

  async function handle(raw) {
    const m = JSON.parse(raw);
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));   // a slow network, for loading-state tests
    if (m.kind === 'signIn') {
      const u = users.find(x => x.email === m.email && x.password === m.password);
      if (!u) return {error: {status: 400, code: 'invalid_credentials', message: 'Invalid login credentials'}};
      return {session: {access_token: 'token-' + u.id, user: {id: u.id, email: u.email, user_metadata: Object.assign({}, u.meta)}}};
    }
    if (m.kind === 'updateUser') {   // a signed-in person changing their own password or metadata
      const u = who(m.session);
      if (!u) return {error: {status: 401, message: 'Not signed in'}};
      if (m.attrs.password) u.password = m.attrs.password;
      if (m.attrs.data) u.meta = Object.assign({}, u.meta, m.attrs.data);
      return {user: {id: u.id, email: u.email, user_metadata: Object.assign({}, u.meta)}};
    }
    if (m.kind === 'rpc') {
      const u = who(m.session);
      if (m.name === 'my_role') return {data: u && u.active ? u.role : null, error: null};
      if (opts.rpc) return opts.rpc(m.name, m.args, u);
      return {data: null, error: {message: 'unknown function'}};
    }
    if (m.kind === 'query') return query(m.session, m.q);
    if (m.kind === 'upload' && m.bucket === 'attendance-selfies') {   // any active person, their own folder, never overwritten
      const u = who(m.session);
      if (!u || !u.active || !/^[\w-]+\/[\w.-]+\.jpg$/.test(m.path)) return {data: null, error: {statusCode: '403', message: 'new row violates row-level security policy'}};
      if (files.has('selfie:' + m.path)) return {data: null, error: {statusCode: '409', message: 'The resource already exists'}};
      files.set('selfie:' + m.path, {type: m.type, bytes: Buffer.from(m.b64, 'base64')});
      return {data: {path: m.path}, error: null};
    }
    if (m.kind === 'remove' && m.bucket === 'attendance-selfies') {
      if (isAdmin(m.session)) m.paths.forEach(p => files.delete('selfie:' + p));
      return {data: [], error: null};
    }
    if (m.kind === 'upload') {
      const ok = isAdmin(m.session) && m.bucket === 'receipts' && /^sb_[A-Za-z0-9_-]{1,120}$/.test(m.path);
      if (!ok) return {data: null, error: {statusCode: '403', message: 'new row violates row-level security policy'}};
      if (files.has(m.path)) return {data: null, error: {statusCode: '409', message: 'The resource already exists'}};
      files.set(m.path, {type: m.type, bytes: Buffer.from(m.b64, 'base64')});
      return {data: {path: m.path}, error: null};
    }
    if (m.kind === 'remove') {
      if (isAdmin(m.session)) m.paths.forEach(p => files.delete(p));
      return {data: [], error: null};
    }
    return {data: null, error: {message: 'unknown request'}};
  }

  // Serves the shim in place of the vendored client, the receipts bucket's public URLs, and the bridge.
  async function attach(page) {
    await page.exposeFunction('__fakeSupabase', async raw => JSON.stringify(await handle(raw)));
    await page.route('**/vendor/supabase-js-2.118.0.js', r => r.fulfill({contentType: 'application/javascript', body: SHIM}));
    // Registered first: Playwright tries the most recently added route first, so this only catches what the routes below don't.
    await page.route('https://laxavfldivkhufeubgmb.supabase.co/**', r => r.abort());   // nothing else may reach the real project
    await page.route('https://laxavfldivkhufeubgmb.supabase.co/storage/v1/object/sign/attendance-selfies/**', r => {
      const f = files.get('selfie:' + decodeURIComponent(new URL(r.request().url()).pathname.split('/attendance-selfies/')[1]));
      return f ? r.fulfill({contentType: f.type || 'image/jpeg', body: f.bytes}) : r.fulfill({status: 404, body: 'gone'});
    });
    await page.route('https://laxavfldivkhufeubgmb.supabase.co/storage/v1/object/public/receipts/**', r => {
      const f = files.get(decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()));
      return r.fulfill(f ? {contentType: f.type, body: f.bytes} : {status: 404, body: ''});
    });
  }

  function seed(collection, id, data, parent) { rows.push({collection, id, parent_id: parent ?? null, data, revision: 1, seq: ++seq}); }
  return {users, rows, files, log, attach, seed};
}
module.exports = {createFakeSupabase};
