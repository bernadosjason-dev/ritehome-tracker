-- Leads and prospect clients: every inquiry in one list, scored, followed up, and turned
-- into a tracker project when won.
--
-- Where leads come from:
--   - the website's inquiry and site-visit forms and Hannah's chat, through the Worker
--     (ritehome-website/cloudflare-worker), which calls ingest_lead() with a secret key;
--   - anyone the admin adds by hand: walk-ins, Facebook messages, referrals, calls.
-- A repeat inquiry from the same phone or email within 30 days, while the lead is still
-- open, is added to that lead's history instead of making a duplicate.
--
-- Scores are computed in the page (lead-score.js), not stored, so changing the rules
-- re-scores every lead at once and every point can be explained.
--
-- Admin only, like the money in the tracker: a lead is a person's contact details.

create type public.lead_stage as enum ('new', 'contacted', 'site_visit', 'quoted', 'won', 'lost');

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'other'
    check (source in ('website', 'site-visit', 'hannah', 'facebook', 'walk-in', 'referral', 'phone', 'other')),
  name text not null check (length(name) between 1 and 120),
  phone text not null default '' check (length(phone) <= 40),
  email text not null default '' check (length(email) <= 160),
  location text not null default '' check (length(location) <= 300),
  system text not null default '' check (system in ('', 'kitchen', 'storage', 'partition', 'workspace', 'other')),
  budget numeric(14, 2) check (budget is null or budget >= 0),
  timeline text not null default '' check (timeline in ('', 'asap', '1-3m', '3-6m', 'later')),
  message text not null default '' check (length(message) <= 2000),
  visit_requested text not null default '' check (length(visit_requested) <= 60),
  page text not null default '' check (length(page) <= 300),
  stage public.lead_stage not null default 'new',
  lost_reason text not null default '' check (length(lost_reason) <= 300),
  expected_value numeric(14, 2) check (expected_value is null or expected_value >= 0),
  next_action text not null default '' check (length(next_action) <= 200),
  next_action_at date,
  first_response_at timestamptz,
  last_contact_at timestamptz,
  project_id text check (project_id is null or length(project_id) <= 100),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  check (phone <> '' or email <> '' or source in ('walk-in', 'referral', 'facebook', 'other'))
);
create index leads_stage on public.leads (stage, created_at desc);
create index leads_phone on public.leads (right(regexp_replace(phone, '\D', '', 'g'), 10)) where phone <> '';
create index leads_email on public.leads (lower(email)) where email <> '';

create table public.lead_activity (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads (id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (kind in ('inquiry', 'note', 'call', 'message', 'visit', 'quote', 'stage')),
  body text not null default '' check (length(body) <= 2000),
  by uuid default auth.uid()
);
create index lead_activity_lead on public.lead_activity (lead_id, at desc);

-- Contact moves the clock: the first call, message, visit or quote is the first response
-- (the website promises one within 2 business hours); every one is the latest contact.
create function public.lead_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('call', 'message', 'visit', 'quote') then
    update public.leads set
      first_response_at = coalesce(first_response_at, new.at),
      last_contact_at = greatest(coalesce(last_contact_at, new.at), new.at),
      stage = case when stage = 'new' then 'contacted'::public.lead_stage else stage end
    where id = new.lead_id;
  end if;
  return new;
end $$;
create trigger lead_activity_touch after insert on public.lead_activity
  for each row execute function public.lead_touch();

-- A stage change is written into the history, with who did it.
create function public.lead_stage_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  if new.stage is distinct from old.stage then
    insert into public.lead_activity (lead_id, kind, body, by)
    values (new.id, 'stage', old.stage || ' → ' || new.stage ||
      case when new.stage = 'lost' and new.lost_reason <> '' then ': ' || new.lost_reason else '' end, auth.uid());
  end if;
  return new;
end $$;
create trigger leads_stage_log before update on public.leads
  for each row execute function public.lead_stage_log();

-- ------------------------------------------------------------------ intake ----
-- The Worker's key is stored only as a SHA-256 hash, readable by no API role.

create table public.app_secrets (
  name text primary key,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$')
);

create function public.lead_norm_phone(p text) returns text
language sql immutable set search_path = public as $$ select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10) $$;

-- Called by the website Worker. p: {source, name, phone, email, line, location, address,
-- visitDate, visitTime, notes, page}. Returns {id, duplicate}.
create function public.ingest_lead(p jsonb, p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_hash text := encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
  v_source text := case p ->> 'source' when 'site-visit' then 'site-visit' when 'hannah' then 'hannah' else 'website' end;
  v_name text := left(btrim(coalesce(p ->> 'name', '')), 120);
  v_phone text := left(btrim(coalesce(p ->> 'phone', '')), 40);
  v_email text := lower(left(btrim(coalesce(p ->> 'email', '')), 160));
  v_line text := lower(btrim(coalesce(p ->> 'line', '')));
  v_system text;
  v_location text := left(btrim(coalesce(nullif(p ->> 'address', ''), p ->> 'location', '')), 300);
  v_visit text := left(btrim(concat_ws(' ', nullif(p ->> 'visitDate', ''), nullif(p ->> 'visitTime', ''))), 60);
  v_message text := left(btrim(coalesce(p ->> 'notes', '')), 2000);
  v_id uuid;
begin
  if not exists (select 1 from public.app_secrets where name = 'lead_ingest' and sha256 = v_hash) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  if v_name = '' or (v_phone = '' and v_email = '') then
    raise exception 'A name and a phone or email are required.' using errcode = '23514';
  end if;
  v_system := case
    when v_line like '%kitchen%' then 'kitchen'
    when v_line like '%storage%' or v_line like '%wardrobe%' or v_line like '%closet%' or v_line like '%cabinet%' then 'storage'
    when v_line like '%partition%' then 'partition'
    when v_line like '%workspace%' or v_line like '%workstation%' or v_line like '%office%' then 'workspace'
    when v_line = '' then '' else 'other' end;

  select id into v_id from public.leads l
  where l.stage not in ('won', 'lost') and l.created_at > now() - interval '30 days'
    and ((v_phone <> '' and l.phone <> '' and public.lead_norm_phone(l.phone) = public.lead_norm_phone(v_phone))
      or (v_email <> '' and lower(l.email) = v_email))
  order by l.created_at desc limit 1;

  if v_id is not null then
    update public.leads set
      phone = case when phone = '' then v_phone else phone end,
      email = case when email = '' then v_email else email end,
      location = case when location = '' then v_location else location end,
      system = case when system = '' then v_system else system end,
      visit_requested = case when v_visit <> '' then v_visit else visit_requested end,
      name = case when name like 'Hannah lead (%' and v_source <> 'hannah' then v_name else name end
    where id = v_id;
    insert into public.lead_activity (lead_id, kind, body, by)
    values (v_id, 'inquiry', 'Again via ' || v_source || coalesce(nullif(': ' || v_message, ': '), ''), null);
    return jsonb_build_object('id', v_id, 'duplicate', true);
  end if;

  insert into public.leads (source, name, phone, email, location, system, message, visit_requested, page, updated_by)
  values (v_source, v_name, v_phone, v_email, v_location, v_system, v_message, v_visit,
          left(coalesce(p ->> 'page', ''), 300), null)
  returning id into v_id;
  insert into public.lead_activity (lead_id, kind, body, by)
  values (v_id, 'inquiry', 'Via ' || v_source || coalesce(nullif(': ' || v_message, ': '), ''), null);
  return jsonb_build_object('id', v_id, 'duplicate', false);
end $$;

-- ------------------------------------------------------------ the page's API ----

create function public.leads_list() returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(l) || jsonb_build_object(
    'activity_count', (select count(*) from public.lead_activity a where a.lead_id = l.id),
    'last_activity', (select jsonb_build_object('at', a.at, 'kind', a.kind, 'body', left(a.body, 160))
                      from public.lead_activity a where a.lead_id = l.id order by a.at desc, a.id desc limit 1))
    order by l.created_at desc), '[]'::jsonb)
  from public.leads l
$$;

create function public.lead_get(p_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object('lead', to_jsonb(l), 'activity', coalesce((
    select jsonb_agg(to_jsonb(a) || jsonb_build_object('by_name', (select full_name from public.profiles pr where pr.id = a.by))
      order by a.at desc, a.id desc)
    from public.lead_activity a where a.lead_id = l.id), '[]'::jsonb))
  from public.leads l where l.id = p_id
$$;

-- Adds a lead (no id) or changes one. Only the fields present in p change.
create function public.lead_save(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  if not public.is_admin() then raise exception 'Only an admin can change leads.' using errcode = '42501'; end if;
  if v_id is null then
    insert into public.leads (source, name, phone, email, location, system, budget, timeline, message,
                              expected_value, next_action, next_action_at)
    values (coalesce(nullif(p ->> 'source', ''), 'other'), btrim(coalesce(p ->> 'name', '')), btrim(coalesce(p ->> 'phone', '')),
            lower(btrim(coalesce(p ->> 'email', ''))), btrim(coalesce(p ->> 'location', '')), coalesce(p ->> 'system', ''),
            nullif(p ->> 'budget', '')::numeric, coalesce(p ->> 'timeline', ''), btrim(coalesce(p ->> 'message', '')),
            nullif(p ->> 'expected_value', '')::numeric, btrim(coalesce(p ->> 'next_action', '')), nullif(p ->> 'next_action_at', '')::date)
    returning id into v_id;
    -- A walk-in or a phone call is already a conversation: it counts as the first contact.
    insert into public.lead_activity (lead_id, kind, body) values (v_id,
      case p ->> 'source' when 'walk-in' then 'visit' when 'phone' then 'call' else 'inquiry' end,
      case p ->> 'source' when 'walk-in' then 'Walked in' when 'phone' then 'Called in' else 'Added by hand' end ||
      coalesce(nullif(': ' || btrim(coalesce(p ->> 'message', '')), ': '), ''));
    return v_id;
  end if;
  update public.leads set
    source = case when p ? 'source' then p ->> 'source' else source end,
    name = case when p ? 'name' then btrim(p ->> 'name') else name end,
    phone = case when p ? 'phone' then btrim(p ->> 'phone') else phone end,
    email = case when p ? 'email' then lower(btrim(p ->> 'email')) else email end,
    location = case when p ? 'location' then btrim(p ->> 'location') else location end,
    system = case when p ? 'system' then p ->> 'system' else system end,
    budget = case when p ? 'budget' then nullif(p ->> 'budget', '')::numeric else budget end,
    timeline = case when p ? 'timeline' then p ->> 'timeline' else timeline end,
    message = case when p ? 'message' then btrim(p ->> 'message') else message end,
    expected_value = case when p ? 'expected_value' then nullif(p ->> 'expected_value', '')::numeric else expected_value end,
    next_action = case when p ? 'next_action' then btrim(p ->> 'next_action') else next_action end,
    next_action_at = case when p ? 'next_action_at' then nullif(p ->> 'next_action_at', '')::date else next_action_at end,
    stage = case when p ? 'stage' then (p ->> 'stage')::public.lead_stage else stage end,
    lost_reason = case when p ? 'lost_reason' then btrim(p ->> 'lost_reason') else lost_reason end
  where id = v_id;
  if not found then raise exception 'No lead %.', v_id using errcode = 'P0002'; end if;
  return v_id;
end $$;

-- Logs a call, message, visit, quote or note; optionally sets the next follow-up.
create function public.lead_log(p_id uuid, p_kind text, p_body text, p_next_action text default null, p_next_at date default null)
returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint;
begin
  if not public.is_admin() then raise exception 'Only an admin can change leads.' using errcode = '42501'; end if;
  if p_kind not in ('note', 'call', 'message', 'visit', 'quote') then
    raise exception 'Unknown activity %.', p_kind using errcode = '23514';
  end if;
  insert into public.lead_activity (lead_id, kind, body) values (p_id, p_kind, btrim(coalesce(p_body, ''))) returning id into v_id;
  if p_next_action is not null or p_next_at is not null then
    update public.leads set next_action = btrim(coalesce(p_next_action, '')), next_action_at = p_next_at where id = p_id;
  end if;
  return v_id;
end $$;

-- Won: opens the tracker project with the client's details, and links the two.
create function public.lead_convert(p_id uuid, p_price numeric, p_budget numeric default null) returns text
language plpgsql security invoker set search_path = public as $$
declare l public.leads; v_pid text; v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if not public.is_admin() then raise exception 'Only an admin can change leads.' using errcode = '42501'; end if;
  select * into l from public.leads where id = p_id;
  if not found then raise exception 'No lead %.', p_id using errcode = 'P0002'; end if;
  if l.project_id is not null then return l.project_id; end if;
  v_pid := 'p_' || substr(md5(gen_random_uuid()::text), 1, 16);
  insert into public.tracker_docs (collection, id, data) values ('projects', v_pid, jsonb_strip_nulls(jsonb_build_object(
    'name', case l.system when 'kitchen' then 'Kitchen' when 'storage' then 'Storage' when 'partition' then 'Partition'
                          when 'workspace' then 'Workspace' else 'Project' end || ' – ' || l.name,
    'clientName', l.name, 'clientPhone', nullif(l.phone, ''), 'clientEmail', nullif(l.email, ''),
    'address', nullif(l.location, ''), 'system', case when l.system in ('kitchen', 'storage', 'partition', 'workspace') then l.system end,
    'price', coalesce(p_price, l.expected_value, 0), 'budget', p_budget, 'status', 'active',
    'createdAt', v_now, 'updatedAt', v_now, 'leadId', l.id::text)));
  update public.leads set stage = 'won', project_id = v_pid,
    expected_value = coalesce(p_price, expected_value) where id = p_id;
  return v_pid;
end $$;

-- ------------------------------------------------------------------ access ----

alter table public.leads enable row level security;
alter table public.lead_activity enable row level security;
alter table public.app_secrets enable row level security;
create policy "leads: admin only" on public.leads for all using (public.is_admin()) with check (public.is_admin());
create policy "lead activity: admin reads" on public.lead_activity for select using (public.is_admin());
create policy "lead activity: admin adds" on public.lead_activity for insert with check (public.is_admin());
-- app_secrets has no policy at all: only SECURITY DEFINER functions read it.

revoke all on public.leads, public.lead_activity, public.app_secrets from anon;
revoke all on public.app_secrets from authenticated;
revoke execute on function public.leads_list(), public.lead_get(uuid), public.lead_save(jsonb),
  public.lead_log(uuid, text, text, text, date), public.lead_convert(uuid, numeric, numeric),
  public.lead_norm_phone(text), public.ingest_lead(jsonb, text) from public, anon;
grant execute on function public.leads_list(), public.lead_get(uuid), public.lead_save(jsonb),
  public.lead_log(uuid, text, text, text, date), public.lead_convert(uuid, numeric, numeric),
  public.lead_norm_phone(text) to authenticated;
-- The Worker calls this with the publishable key; the secret key is what lets it in.
grant execute on function public.ingest_lead(jsonb, text) to anon, authenticated;
revoke execute on function public.lead_touch(), public.lead_stage_log() from public, anon, authenticated;
