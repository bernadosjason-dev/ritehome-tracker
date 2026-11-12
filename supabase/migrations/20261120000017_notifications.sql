-- Phase 3: notifications. Every activity-log row an employee causes becomes a notification for the
-- admins (the bell in the portal menu), and the ones that matter go to the owner's Telegram.
--
-- Built on audit_log (20261118000016): one notify_events row per log row (unique audit_id, so an
-- event can never notify twice), made by a trigger. The admin's own actions don't notify anyone.
-- Levels: 'alert' (refused attempts, deletes, a stage flagged blocked, stock running low or out, a
-- selfie that doesn't match), 'handoff' (new leads, a lead won, a stage submitted or finished),
-- 'info' (everything else an employee changes). With nobody signed in, only a website lead notifies. Telegram gets what notify_settings asks for:
-- 'off', 'alerts', 'important' (alerts + handoffs, the default) or 'all'.
--
-- Telegram: a new event that should go out pings the notify-telegram Edge Function through pg_net.
-- The ping carries nothing; the function claims the waiting events itself (notify_claim_telegram,
-- service role only) and sends them with the bot token it holds as a secret. A failed send goes
-- back in the queue and goes out with the next ping. The bot token never touches the database.
--
-- Also here: the team-admin Edge Function works as the service role, so the activity log couldn't
-- tell who created an account. It now sends the admin's id in the x-ritehome-actor header, which
-- audit_row() believes only from the service role; and audit_service_note() records what happens
-- outside the database (a sign-in made, a password reset).

-- ------------------------------------------------------------- extension ----

do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'net')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension pg_net;
  end if;
end $$;

-- ---------------------------------------------------------------- tables ----

create table public.notify_settings (
  id boolean primary key default true check (id),
  telegram text not null default 'important' check (telegram in ('off', 'alerts', 'important', 'all')),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
insert into public.notify_settings default values;

create table public.notify_events (
  id bigint generated always as identity primary key,
  audit_id bigint not null unique references public.audit_log (id),
  at timestamptz not null default now(),
  level text not null check (level in ('alert', 'handoff', 'info')),
  module text not null,
  actor uuid,
  title text not null check (length(title) <= 300),
  body text not null default '' check (length(body) <= 600),
  link text not null default '',
  telegram text not null default 'none' check (telegram in ('none', 'pending', 'sending', 'sent', 'failed')),
  telegram_tries integer not null default 0,
  telegram_at timestamptz
);
create index notify_events_at on public.notify_events (id desc);
create index notify_events_telegram on public.notify_events (telegram) where telegram in ('pending', 'sending');

-- Who has read what: one row per admin per event read.
create table public.notify_reads (
  event_id bigint not null references public.notify_events (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

alter table public.notify_settings enable row level security;
alter table public.notify_events enable row level security;
alter table public.notify_reads enable row level security;
create policy "notify settings: admin reads" on public.notify_settings for select using (public.is_admin());
create policy "notify events: admin reads" on public.notify_events for select using (public.is_admin());
create policy "notify reads: own" on public.notify_reads for select using (user_id = auth.uid() and public.is_admin());
revoke insert, update, delete, truncate on public.notify_settings, public.notify_events, public.notify_reads from public, anon, authenticated;

-- The bell updates the moment something happens (row-level security still decides who hears it).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notify_events;
  end if;
end $$;

-- ------------------------------------------------- who did it (Edge Functions) ----

-- The request's JWT claims, or {} outside an API request.
create function public.request_claims() returns jsonb
language plpgsql stable set search_path = public as $$
begin
  return coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
exception when others then return '{}'::jsonb;
end $$;

create function public.request_headers() returns jsonb
language plpgsql stable set search_path = public as $$
begin
  return coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
exception when others then return '{}'::jsonb;
end $$;

-- Who is acting: the signed-in person, or for the service role (Edge Functions only) the admin
-- named in x-ritehome-actor. Anyone else's header is ignored.
create function public.acting_user() returns uuid
language plpgsql stable set search_path = public as $$
declare v text;
begin
  if auth.uid() is not null then return auth.uid(); end if;
  if public.request_claims() ->> 'role' is distinct from 'service_role' then return null; end if;
  v := public.request_headers() ->> 'x-ritehome-actor';
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  return v::uuid;
end $$;

-- audit_row as before, with the actor from acting_user().
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then public.audit_flat(to_jsonb(old)) end;
  n jsonb := case when tg_op <> 'DELETE' then public.audit_flat(to_jsonb(new)) end;
  r jsonb := coalesce(n, o);
  noise text[] := array['updated_at', 'updated_by', 'revision', 'data.updatedAt'];
  secret text[] := array['face_descriptor', 'lat', 'lng', 'accuracy_m', 'selfie_path'];
  ch text[] := '{}';
  v_id text; v_project text; v_label text; hdr jsonb := public.request_headers(); me public.profiles;
  v_actor uuid := public.acting_user();
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(x.key order by x.key), '{}') into ch from (
      select e.key from jsonb_each(n) e where not (o ? e.key) or o -> e.key is distinct from e.value
      union
      select e.key from jsonb_each(o) e where not (n ? e.key)) x
    where x.key <> all (noise);
    if ch = '{}' then return null; end if;
  end if;

  select string_agg(coalesce(r ->> a.col, ''), '/' order by a.ord) into v_id
  from unnest(tg_argv) with ordinality a(col, ord);
  v_project := case
    when tg_table_name = 'tracker_docs' then case r ->> 'collection'
      when 'projects' then r ->> 'id' when 'expenses' then r ->> 'parent_id' end
    else r ->> 'project_id' end;
  v_label := left(coalesce(nullif(r ->> 'data.name', ''), nullif(r ->> 'name', ''), nullif(r ->> 'full_name', ''),
    nullif(r ->> 'title', ''), nullif(r ->> 'memo', ''), nullif(r ->> 'data.description', ''),
    nullif(r ->> 'data.note', ''), nullif(r ->> 'body', ''), nullif(r ->> 'stage', ''), nullif(r ->> 'kind', ''), ''), 160);

  if tg_op = 'UPDATE' then
    o := (select coalesce(jsonb_object_agg(e.key, case when e.key = any (secret) then '"(hidden)"'::jsonb else e.value end), '{}'::jsonb)
          from jsonb_each(o) e where e.key = any (ch));
    n := (select coalesce(jsonb_object_agg(e.key, case when e.key = any (secret) then '"(hidden)"'::jsonb else e.value end), '{}'::jsonb)
          from jsonb_each(n) e where e.key = any (ch));
  else
    o := (select jsonb_object_agg(e.key, e.value) from jsonb_each(o) e where e.key <> all (secret || noise));
    n := (select jsonb_object_agg(e.key, e.value) from jsonb_each(n) e where e.key <> all (secret || noise));
  end if;

  select * into me from public.profiles where id = v_actor;

  insert into public.audit_log (actor, actor_name, actor_roles, module, table_name, record_id, project_id,
                                action, changed, old, new, label, ip, user_agent)
  values (v_actor, coalesce(me.full_name, ''), case when me.id is null then '{}' else array[me.role] || me.extra_roles end,
          public.audit_module(tg_table_name, r), tg_table_name, coalesce(v_id, ''), v_project,
          lower(tg_op), ch, o, n, v_label,
          coalesce(hdr ->> 'cf-connecting-ip', nullif(btrim(split_part(hdr ->> 'x-forwarded-for', ',', 1)), ''), hdr ->> 'x-real-ip'),
          left(hdr ->> 'user-agent', 300));
  return null;
end $$;

-- What an Edge Function did outside the database (a sign-in made, a password reset), logged under
-- the admin who asked. Service role only.
create function public.audit_service_note(p_actor uuid, p_module text, p_what text, p_record text default '') returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles;
begin
  if public.request_claims() ->> 'role' is distinct from 'service_role' then
    raise exception 'Only the portal''s own services can write this.' using errcode = '42501';
  end if;
  select * into me from public.profiles where id = p_actor;
  insert into public.audit_log (actor, actor_name, actor_roles, module, table_name, record_id, action, label, new)
  values (p_actor, coalesce(me.full_name, ''), case when me.id is null then '{}' else array[me.role] || me.extra_roles end,
          left(coalesce(nullif(p_module, ''), 'Team'), 40), 'auth.users', coalesce(p_record, ''), 'update',
          left(coalesce(p_what, ''), 160), jsonb_build_object('note', left(coalesce(p_what, ''), 160)));
end $$;

-- ---------------------------------------------------------- the events ----

create function public.stage_word(p text) returns text
language sql immutable set search_path = public as $$
  select case p when 'consultation' then 'Consultation' when 'site_visit' then 'Site visit' when 'design' then 'Design'
    when 'cutlist' then 'Initial cutlist' when 'bom' then 'BOM' when 'final_cutlist' then 'Final cutlist'
    when 'procurement' then 'Procurement' when 'fabrication' then 'Fabrication' when 'installation' then 'Installation'
    when 'handover' then 'Handover' else coalesce(p, '') end
$$;

-- Does a notification at this level go to Telegram, with the current settings?
create function public.notify_telegram_wanted(p_level text) returns boolean
language sql stable security definer set search_path = public as $$
  select case (select telegram from public.notify_settings)
    when 'all' then true
    when 'important' then p_level in ('alert', 'handoff')
    when 'alerts' then p_level = 'alert'
    else false end
$$;

create function public.notify_from_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a public.audit_log := new;
  who text := coalesce(nullif(a.actor_name, ''), case when a.actor is null then 'The website' else 'Someone' end);
  proj text := (select d.data ->> 'name' from public.tracker_docs d where d.collection = 'projects' and d.id = a.project_id);
  lvl text := 'info'; title text; body text := ''; link text := '/activity'; st text; flags jsonb;
  it public.inventory_items; onhand numeric; qty numeric;
begin
  -- The admin's own actions, and notes the services write for the admin, notify nobody.
  if a.actor is not null and 'admin' = any (a.actor_roles) then return null; end if;
  -- With nobody signed in, only a website lead is news; anything else is maintenance.
  if a.actor is null and not (a.table_name = 'leads' and a.action = 'insert') then return null; end if;

  if a.action = 'refused' then
    lvl := 'alert'; title := who || ' was refused: ' || coalesce(nullif(a.label, ''), 'an action');
    body := coalesce(a.new ->> 'detail', '');
  elsif a.action = 'delete' then
    lvl := 'alert'; title := who || ' deleted ' || coalesce(nullif(a.label, ''), a.table_name);
    body := a.module || coalesce(' · ' || proj, '');
  elsif a.table_name = 'leads' and a.action = 'insert' then
    lvl := 'handoff'; title := 'New lead: ' || coalesce(nullif(a.label, ''), 'no name');
    body := case when a.actor is null then 'From the website' else 'Added by ' || who end;
    link := '/leads#lead=' || a.record_id;
  elsif a.table_name = 'leads' and 'stage' = any (a.changed) then
    st := a.new ->> 'stage';
    lvl := case when st = 'won' then 'handoff' else 'info' end;
    title := who || ' moved lead ' || a.label || ' to ' || st;
    link := '/leads#lead=' || a.record_id;
  elsif a.table_name = 'leads' then
    title := who || ' updated lead ' || a.label; link := '/leads#lead=' || a.record_id;
  elsif a.table_name = 'lead_activity' then
    title := who || ' logged ' || coalesce(a.new ->> 'kind', 'a note') || ' with a lead'; body := a.label;
    link := '/leads#lead=' || coalesce(a.new ->> 'lead_id', '');
  elsif a.table_name = 'project_stages' and 'status' = any (a.changed) then
    st := a.new ->> 'status';
    lvl := case when st in ('done', 'submitted') then 'handoff' when st = 'blocked' then 'alert' else 'info' end;
    title := who || ' ' || case st when 'done' then 'finished' when 'submitted' then 'submitted' when 'blocked' then 'is blocked on'
      when 'waiting_client' then 'is waiting on the client for' when 'in_progress' then 'started' else 'reset' end
      || ' ' || public.stage_word(split_part(a.record_id, '/', 2)) || coalesce(' · ' || proj, '');
    body := coalesce(a.new ->> 'notes', ''); link := '/schedule';
  elsif a.table_name = 'project_stages' then
    title := who || ' updated ' || public.stage_word(split_part(a.record_id, '/', 2)) || coalesce(' · ' || proj, '');
    link := '/schedule';
  elsif a.table_name = 'project_files' and a.action = 'insert' then
    title := who || ' uploaded ' || coalesce(nullif(a.new ->> 'file_name', ''), 'a file') || coalesce(' · ' || proj, '');
    link := '/schedule';
  elsif a.table_name = 'inventory_moves' and a.action = 'insert' then
    select * into it from public.inventory_items where id = (a.new ->> 'item_id')::uuid;
    qty := trim_scale((a.new ->> 'qty')::numeric);
    onhand := trim_scale(public.inventory_on_hand(it.id));
    title := who || ' ' || case when qty < 0 then 'took ' || abs(qty) else 'added ' || qty end || ' ' || coalesce(it.unit, '') || ' ' || coalesce(it.name, 'stock')
      || coalesce(' for ' || nullif(a.new ->> 'job', ''), '');
    body := onhand || ' ' || coalesce(it.unit, '') || ' left';
    link := '/inventory';
    if it.reorder_level > 0 and onhand <= it.reorder_level and onhand - qty > it.reorder_level then
      lvl := 'alert';
      title := coalesce(it.name, 'An item') || case when onhand <= 0 then ' is out' else ' is low: ' || onhand || ' ' || coalesce(it.unit, '') || ' left' end;
      body := 'Reorder level ' || trim_scale(it.reorder_level) || '. Last: ' || who || case when qty < 0 then ' took ' || abs(qty) else ' counted' end || '.';
    end if;
  elsif a.table_name = 'attendance_punches' and a.action = 'insert' then
    flags := coalesce(a.new -> 'flags', '[]'::jsonb);
    if flags ? 'face_mismatch' then
      lvl := 'alert'; title := who || '''s selfie doesn''t match their reference photo';
    elsif flags ? 'late' or flags ? 'early_out' then
      title := who || case when flags ? 'late' then ' clocked in late' else ' clocked out early' end;
    elsif flags ? 'off_site' then
      title := who || ' clocked from outside the office';
    else
      return null;   -- an ordinary punch is not news
    end if;
    body := replace(coalesce(a.new ->> 'kind', ''), '_', ' '); link := '/attendance';
  elsif a.table_name = 'tracker_docs' and a.module = 'Procurement' then
    title := who || ' ' || case a.action when 'insert' then 'added' else 'changed' end || ' ' || coalesce(nullif(a.label, ''), 'a procurement record');
    link := '/procurement';
  else
    title := who || ' ' || case a.action when 'insert' then 'added' else 'changed' end || ' ' || coalesce(nullif(a.label, ''), a.table_name)
      || coalesce(' · ' || proj, '');
  end if;

  insert into public.notify_events (audit_id, at, level, module, actor, title, body, link, telegram)
  values (a.id, a.at, lvl, a.module, a.actor, left(title, 300), left(coalesce(body, ''), 600), link,
          case when public.notify_telegram_wanted(lvl) then 'pending' else 'none' end)
  on conflict (audit_id) do nothing;
  return null;
end $$;
create trigger notify_from_audit after insert on public.audit_log for each row execute function public.notify_from_audit();

-- A new event for Telegram wakes the notify-telegram Edge Function. The request carries nothing:
-- the function reads the queue itself. Without pg_net (local tests have a stand-in) nothing is sent.
create function public.notify_endpoint() returns text
language sql immutable set search_path = public as $$
  select 'https://laxavfldivkhufeubgmb.supabase.co/functions/v1/notify-telegram'
$$;
create function public.notify_ping() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return null; end if;
  perform net.http_post(url := public.notify_endpoint(), body := '{}'::jsonb,
                        headers := '{"content-type":"application/json"}'::jsonb);
  return null;
end $$;
create trigger notify_ping after insert on public.notify_events
  for each row when (new.telegram = 'pending') execute function public.notify_ping();

-- ------------------------------------------------------ Telegram queue ----

-- The Edge Function takes up to p_limit waiting events (and any stuck sending for 5 minutes).
create function public.notify_claim_telegram(p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ids bigint[];
begin
  if public.request_claims() ->> 'role' is distinct from 'service_role' then
    raise exception 'Only the portal''s own services can send notifications.' using errcode = '42501';
  end if;
  select coalesce(array_agg(x.id), '{}') into v_ids from (
    select e.id from public.notify_events e
    where e.telegram = 'pending' or (e.telegram = 'sending' and e.telegram_at < now() - interval '5 minutes')
    order by e.id limit least(greatest(coalesce(p_limit, 20), 1), 50)
    for update skip locked) x;
  update public.notify_events set telegram = 'sending', telegram_tries = telegram_tries + 1, telegram_at = now()
  where id = any (v_ids);
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'level', e.level, 'module', e.module, 'title', e.title,
      'body', e.body, 'link', e.link, 'at', e.at) order by e.id)
    from public.notify_events e where e.id = any (v_ids)), '[]'::jsonb);
end $$;

-- Sent: done. Not sent: back in the queue, given up after 5 tries.
create function public.notify_telegram_done(p_sent bigint[], p_failed bigint[] default '{}') returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.request_claims() ->> 'role' is distinct from 'service_role' then
    raise exception 'Only the portal''s own services can send notifications.' using errcode = '42501';
  end if;
  update public.notify_events set telegram = 'sent', telegram_at = now() where id = any (coalesce(p_sent, '{}'));
  update public.notify_events set telegram = case when telegram_tries >= 5 then 'failed' else 'pending' end
  where id = any (coalesce(p_failed, '{}'));
end $$;

-- ----------------------------------------------------------- the bell ----

-- The admin's bell: the newest events (before an id, for older ones), each with whether this
-- admin has read it, and how many are unread.
create function public.notify_list(p_limit integer default 30, p_before bigint default null) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin gets notifications.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'unread', (select count(*) from public.notify_events e
               where not exists (select 1 from public.notify_reads r where r.event_id = e.id and r.user_id = auth.uid())),
    'telegram', (select telegram from public.notify_settings),
    'events', coalesce((select jsonb_agg(x order by (x ->> 'id')::bigint desc) from (
      select jsonb_build_object('id', e.id, 'at', e.at, 'level', e.level, 'module', e.module, 'title', e.title,
        'body', e.body, 'link', e.link, 'telegram', e.telegram,
        'read', exists (select 1 from public.notify_reads r where r.event_id = e.id and r.user_id = auth.uid())) x
      from public.notify_events e
      where p_before is null or e.id < p_before
      order by e.id desc limit least(greatest(coalesce(p_limit, 30), 1), 100)) y), '[]'::jsonb));
end $$;

-- Mark events read (all of them when p_ids is null). Returns the new unread count.
create function public.notify_read(p_ids bigint[] default null) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'Only an admin gets notifications.' using errcode = '42501'; end if;
  insert into public.notify_reads (event_id, user_id)
  select e.id, auth.uid() from public.notify_events e where p_ids is null or e.id = any (p_ids)
  on conflict do nothing;
  select count(*) into n from public.notify_events e
  where not exists (select 1 from public.notify_reads r where r.event_id = e.id and r.user_id = auth.uid());
  return n;
end $$;

create function public.notify_settings_save(p_telegram text) returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can change notifications.' using errcode = '42501'; end if;
  if p_telegram not in ('off', 'alerts', 'important', 'all') then
    raise exception 'Pick off, alerts, important or all.' using errcode = '23514';
  end if;
  update public.notify_settings set telegram = p_telegram, updated_at = now(), updated_by = auth.uid();
  return p_telegram;
end $$;
create trigger zz_audit after insert or update or delete on public.notify_settings for each row execute function public.audit_row('id');

-- ------------------------------------------------------------- grants ----

revoke execute on function public.request_claims(), public.request_headers(), public.acting_user(), public.stage_word(text),
  public.notify_telegram_wanted(text), public.notify_from_audit(), public.notify_endpoint(), public.notify_ping(),
  public.audit_service_note(uuid, text, text, text), public.notify_claim_telegram(integer),
  public.notify_telegram_done(bigint[], bigint[]),
  public.notify_list(integer, bigint), public.notify_read(bigint[]), public.notify_settings_save(text) from public, anon, authenticated;
grant execute on function public.audit_service_note(uuid, text, text, text), public.notify_claim_telegram(integer),
  public.notify_telegram_done(bigint[], bigint[]) to service_role;
grant execute on function public.notify_list(integer, bigint), public.notify_read(bigint[]), public.notify_settings_save(text) to authenticated;
