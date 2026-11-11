// team-admin Edge Function: creates staff sign-ins and resets passwords for the Team page.
// The only code that holds the service role key (SUPABASE_SERVICE_ROLE_KEY, provided by Supabase
// to every Edge Function, never sent to a browser). Every request must carry the signed-in
// caller's access token, and the caller must be an active admin, checked here against
// public.profiles before anything else happens.
//
// Plain JavaScript with fetch injected, so tests/team.test.cjs runs it under Node.
//
//   POST {action: "create", email, full_name, role, password}  -> {id}
//   POST {action: "reset_password", user_id, password}         -> {ok: true}
// Both set user_metadata.must_change_password, so the person picks their own password at
// their next sign-in (tracker.html asks before anything else).

const ROLES = ['admin', 'designer', 'purchaser', 'fabrication', 'installer'];
const ORIGINS = ['https://portal.ritehomemodular.com', 'https://ritehome-portal.vercel.app',
  'http://127.0.0.1:8000', 'http://localhost:8000'];
const PREVIEW = /^https:\/\/ritehome-portal-[a-z0-9-]+\.vercel\.app$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function makeHandler({ env, fetch }) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const service = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const admin = { apikey: service, Authorization: 'Bearer ' + service, 'content-type': 'application/json' };

  return async function handle(req) {
    const origin = req.headers.get('origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ORIGINS.includes(origin) || PREVIEW.test(origin) ? origin : ORIGINS[0],
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin'
    };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
    if (!base || !service) return reply(500, { error: 'The function is missing its Supabase settings.' });

    // Who is calling: their token must be a real session, and their profile an active admin.
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return reply(401, { error: 'Sign in first.' });
    const who = await fetch(base + '/auth/v1/user', { headers: { apikey: service, Authorization: 'Bearer ' + token } });
    if (!who.ok) return reply(401, { error: 'Your sign-in has expired. Sign in again.' });
    const caller = await who.json();
    const prof = await fetch(base + '/rest/v1/profiles?select=role,active&id=eq.' + encodeURIComponent(caller.id), { headers: admin });
    const rows = prof.ok ? await prof.json() : [];
    if (!rows[0] || rows[0].role !== 'admin' || !rows[0].active) return reply(403, { error: 'Only an admin can manage team accounts.' });

    let body;
    try { body = await req.json(); } catch (e) { return reply(400, { error: 'Send JSON.' }); }
    const password = String(body.password || '');
    if (password.length < 10 || password.length > 72) return reply(400, { error: 'The password must be 10 to 72 characters.' });

    if (body.action === 'create') {
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.full_name || '').trim();
      const role = String(body.role || '');
      if (!EMAIL.test(email) || email.length > 160) return reply(400, { error: 'That email address doesn\'t look right.' });
      if (!name || name.length > 120) return reply(400, { error: 'Write the person\'s name.' });
      if (!ROLES.includes(role)) return reply(400, { error: 'Pick a role.' });
      const made = await fetch(base + '/auth/v1/admin/users', { method: 'POST', headers: admin, body: JSON.stringify({
        email, password, email_confirm: true, user_metadata: { full_name: name, must_change_password: true } }) });
      if (!made.ok) {
        const err = await made.json().catch(() => ({}));
        const text = String(err.msg || err.message || err.error_description || err.error || '');
        if (made.status === 422 || /already/i.test(text)) return reply(409, { error: 'That email already has an account.' });
        return reply(502, { error: 'Supabase refused the account: ' + (text || made.status) });
      }
      const user = await made.json();
      // The sign-up trigger made an inactive profile; turn it on with the chosen role.
      const set = await fetch(base + '/rest/v1/profiles?id=eq.' + encodeURIComponent(user.id), { method: 'PATCH',
        headers: { ...admin, Prefer: 'return=minimal' }, body: JSON.stringify({ full_name: name, role, active: true }) });
      if (!set.ok) return reply(502, { error: 'The sign-in was made but the profile wasn\'t switched on. Activate it on the Team page.', id: user.id });
      return reply(200, { id: user.id });
    }

    if (body.action === 'reset_password') {
      const id = String(body.user_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return reply(400, { error: 'Pick a person.' });
      const done = await fetch(base + '/auth/v1/admin/users/' + id, { method: 'PUT', headers: admin,
        body: JSON.stringify({ password, user_metadata: { must_change_password: true } }) });
      if (!done.ok) return reply(502, { error: 'Supabase refused the new password (' + done.status + ').' });
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'Unknown action.' });
  };
}
