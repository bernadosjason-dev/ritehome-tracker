// notify-telegram Edge Function: sends the portal's waiting notifications to the owner's Telegram.
// The database wakes it (pg_net, from public.notify_ping()) whenever an event should go out. The
// request carries nothing and is not trusted: the function claims the waiting events itself through
// public.notify_claim_telegram() with the service role key (SUPABASE_SERVICE_ROLE_KEY, provided by
// Supabase), so anyone calling it can at most make the queue go out sooner. The response says only
// how many went.
//
// Secrets (Supabase dashboard, Edge Functions, Secrets; never in this repo):
//   TELEGRAM_BOT_TOKEN   the bot that pages the owner (the same bot as the website's lead alerts is fine)
//   TELEGRAM_CHAT_ID     the owner's chat with that bot
// Without them nothing is claimed: events stay waiting and go out once the secrets are set.
//
// Plain JavaScript with fetch injected, so tests/notify.test.cjs runs it under Node.

const PORTAL = 'https://portal.ritehomemodular.com';
const ICON = { alert: '🔴', handoff: '🟢', info: '•' };

export function message(e) {
  const lines = [(ICON[e.level] || '•') + ' ' + String(e.title || '').trim()];
  if (e.body) lines.push(String(e.body).trim().slice(0, 500));
  lines.push(e.module + ' · ' + PORTAL + (e.link || '/activity'));
  return lines.join('\n').slice(0, 4000);
}

export function makeNotifier({ env, fetch }) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const service = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const token = env.TELEGRAM_BOT_TOKEN || '';
  const chat = env.TELEGRAM_CHAT_ID || '';
  const db = { apikey: service, Authorization: 'Bearer ' + service, 'content-type': 'application/json' };
  const rpc = async (name, args) => {
    const r = await fetch(base + '/rest/v1/rpc/' + name, { method: 'POST', headers: db, body: JSON.stringify(args) });
    if (!r.ok) throw new Error(name + ' answered ' + r.status);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  };

  return async function handle(req) {
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
    if (!base || !service) return reply(500, { error: 'The function is missing its Supabase settings.' });
    if (!token || !chat) return reply(503, { error: 'Telegram is not set up yet: add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as Edge Function secrets.' });

    let events;
    try { events = await rpc('notify_claim_telegram', { p_limit: 20 }) || []; }
    catch (e) { return reply(502, { error: 'Could not read the queue.' }); }

    const sent = [], failed = [];
    for (const e of events) {
      try {
        const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chat, text: message(e), disable_web_page_preview: true }) });
        (r.ok ? sent : failed).push(e.id);
      } catch (err) { failed.push(e.id); }
    }
    if (events.length) {
      try { await rpc('notify_telegram_done', { p_sent: sent, p_failed: failed }); }
      catch (e) { return reply(502, { error: 'Sent, but could not mark them sent.', sent: sent.length, failed: failed.length }); }
    }
    return reply(200, { sent: sent.length, failed: failed.length });
  };
}
