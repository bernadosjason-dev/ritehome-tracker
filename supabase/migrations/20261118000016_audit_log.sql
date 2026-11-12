-- Phase 2: the activity log. Every insert, change and delete on every business table is written
-- here by a trigger, with who did it (name and roles at that moment), what changed (only the
-- fields that changed, before and after), which project it belongs to, and the caller's IP and
-- browser when the request came through the API.
--
-- Nobody edits or deletes the log, not even an admin: there is no insert, update or delete policy,
-- and the table's write privileges are revoked. Only the trigger (SECURITY DEFINER) writes. Admins
-- read it through audit_search().
--
-- Kept out of the log on purpose: the face template (biometric), a punch's GPS fix and selfie path
-- (personal data that the attendance notice promises to delete after 90 days; the log would keep it
-- forever). When one of those changes, the log says so with "(hidden)" in place of the value.
-- Noise left out: updated_at, updated_by, revision and the tracker's data.updatedAt, which change on
-- every save. An update that changes nothing else is not logged. Rows written by another trigger
-- (a new project's ten stages, the lead's automatic stage note and first-reply time, the rows a
-- delete cascades to) are consequences of an action that is already logged, so they are left out:
-- pg_trigger_depth() is 1 for a row a person or a function wrote, more for a trigger's own writes.
--
-- Refused attempts: Postgres undoes everything in a refused transaction, a log row included, so the
-- database can't record its own refusals. The pages report them instead through audit_refused()
-- (source 'page'): good for spotting mistakes and confusion, but a determined person calling the
-- API directly won't report themselves. Their refused writes still change nothing.

create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text not null default '',
  actor_roles public.staff_role[] not null default '{}',
  module text not null,
  table_name text not null,
  record_id text not null default '',
  project_id text,
  action text not null check (action in ('insert', 'update', 'delete', 'refused')),
  changed text[] not null default '{}',
  old jsonb,
  new jsonb,
  label text not null default '',
  source text not null default 'database' check (source in ('database', 'page')),
  ip text,
  user_agent text
);
create index audit_log_at on public.audit_log (at desc);
create index audit_log_actor on public.audit_log (actor, at desc);
create index audit_log_project on public.audit_log (project_id, at desc) where project_id is not null;
create index audit_log_record on public.audit_log (table_name, record_id, at desc);

alter table public.audit_log enable row level security;
create policy "audit log: admin reads" on public.audit_log for select using (public.is_admin());
revoke insert, update, delete, truncate on public.audit_log from public, anon, authenticated;

-- A row as one flat object; a jsonb "data" column (the tracker's documents) is opened up into
-- "data.<key>" entries so a change to one field of a project shows as that field.
create function public.audit_flat(r jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
    select e.key as k, e.value as v from jsonb_each(r) e where e.key <> 'data' or jsonb_typeof(e.value) <> 'object'
    union all
    select 'data.' || d.key, d.value from jsonb_each(r) e cross join lateral jsonb_each(e.value) d
    where e.key = 'data' and jsonb_typeof(e.value) = 'object'
  ) x
$$;

-- Which workspace a row belongs to, as the menu names it.
create function public.audit_module(p_table text, p_row jsonb) returns text
language sql immutable set search_path = public as $$
  select case
    when p_table = 'tracker_docs' then case p_row ->> 'collection'
      when 'projects' then 'Projects' when 'expenses' then 'Projects'
      when 'companyFuel' then 'Company fuel' when 'companyVehicles' then 'Company fuel'
      when 'procurementJobs' then 'Procurement' when 'procurement' then 'Procurement' else 'Projects' end
    when p_table in ('project_stages', 'project_events', 'project_files', 'project_assignments') then 'Schedule'
    when p_table in ('leads', 'lead_activity') then 'Leads'
    when p_table like 'acct\_%' then 'Accounting'
    when p_table like 'inventory\_%' then 'Inventory'
    when p_table = 'attendance_punches' then 'Attendance'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;

-- The trigger. Arguments: the key columns that name the row (e.g. 'project_id', 'stage').
create function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then public.audit_flat(to_jsonb(old)) end;
  n jsonb := case when tg_op <> 'DELETE' then public.audit_flat(to_jsonb(new)) end;
  r jsonb := coalesce(n, o);
  noise text[] := array['updated_at', 'updated_by', 'revision', 'data.updatedAt'];
  secret text[] := array['face_descriptor', 'lat', 'lng', 'accuracy_m', 'selfie_path'];
  ch text[] := '{}';
  v_id text; v_project text; v_label text; hdr jsonb; me public.profiles;
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

  -- Keep only what changed (updates), and never the secret values.
  if tg_op = 'UPDATE' then
    o := (select coalesce(jsonb_object_agg(e.key, case when e.key = any (secret) then '"(hidden)"'::jsonb else e.value end), '{}'::jsonb)
          from jsonb_each(o) e where e.key = any (ch));
    n := (select coalesce(jsonb_object_agg(e.key, case when e.key = any (secret) then '"(hidden)"'::jsonb else e.value end), '{}'::jsonb)
          from jsonb_each(n) e where e.key = any (ch));
  else
    o := (select jsonb_object_agg(e.key, e.value) from jsonb_each(o) e where e.key <> all (secret || noise));
    n := (select jsonb_object_agg(e.key, e.value) from jsonb_each(n) e where e.key <> all (secret || noise));
  end if;

  select * into me from public.profiles where id = auth.uid();
  begin
    hdr := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then hdr := null;
  end;

  insert into public.audit_log (actor, actor_name, actor_roles, module, table_name, record_id, project_id,
                                action, changed, old, new, label, ip, user_agent)
  values (auth.uid(), coalesce(me.full_name, ''), case when me.id is null then '{}' else array[me.role] || me.extra_roles end,
          public.audit_module(tg_table_name, r), tg_table_name, coalesce(v_id, ''), v_project,
          lower(tg_op), ch, o, n, v_label,
          coalesce(hdr ->> 'cf-connecting-ip', nullif(btrim(split_part(hdr ->> 'x-forwarded-for', ',', 1)), ''), hdr ->> 'x-real-ip'),
          left(hdr ->> 'user-agent', 300));
  return null;
end $$;

-- One trigger per table, named to run after every other trigger on it.
create trigger zz_audit after insert or update or delete on public.profiles for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.tracker_docs for each row execute function public.audit_row('collection', 'id');
create trigger zz_audit after insert or update or delete on public.project_assignments for each row execute function public.audit_row('project_id', 'user_id');
create trigger zz_audit after insert or update or delete on public.project_stages for each row execute function public.audit_row('project_id', 'stage');
create trigger zz_audit after insert or update or delete on public.project_files for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.project_events for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.leads for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.lead_activity for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.acct_accounts for each row execute function public.audit_row('code');
create trigger zz_audit after insert or update or delete on public.acct_settings for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.acct_entries for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.acct_lines for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.acct_project_vat for each row execute function public.audit_row('project_id');
create trigger zz_audit after insert or update or delete on public.acct_purchase_vat for each row execute function public.audit_row('collection', 'doc_id');
create trigger zz_audit after insert or update or delete on public.inventory_items for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.inventory_moves for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.attendance_punches for each row execute function public.audit_row('id');

-- A page reports an action the database refused (it can't log that itself: the refusal undoes the
-- transaction). Any active account may report its own refusals, at most 30 an hour.
create function public.audit_refused(p_module text, p_what text, p_detail text default '') returns void
language plpgsql security definer set search_path = public as $$
declare me public.profiles; hdr jsonb;
begin
  select * into me from public.profiles where id = auth.uid() and active;
  if not found then return; end if;
  if (select count(*) from public.audit_log where actor = me.id and action = 'refused' and at > now() - interval '1 hour') >= 30 then
    return;
  end if;
  begin
    hdr := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then hdr := null;
  end;
  insert into public.audit_log (actor, actor_name, actor_roles, module, table_name, action, new, label, source, ip, user_agent)
  values (me.id, me.full_name, array[me.role] || me.extra_roles, left(coalesce(nullif(btrim(p_module), ''), 'Portal'), 40), '',
          'refused', jsonb_build_object('detail', left(coalesce(p_detail, ''), 500)), left(coalesce(p_what, ''), 160), 'page',
          coalesce(hdr ->> 'cf-connecting-ip', nullif(btrim(split_part(hdr ->> 'x-forwarded-for', ',', 1)), ''), hdr ->> 'x-real-ip'),
          left(hdr ->> 'user-agent', 300));
end $$;

-- The admin's search. Filters (all optional, in p): actor (uuid), module, action, project, table,
-- record, from / to (Manila dates, inclusive), q (text in the label, record or name), before (an id,
-- for the next page), limit (default 100, at most 500). Newest first.
create function public.audit_search(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_actor uuid := nullif(p ->> 'actor', '')::uuid;
  v_module text := nullif(p ->> 'module', '');
  v_action text := nullif(p ->> 'action', '');
  v_project text := nullif(p ->> 'project', '');
  v_table text := nullif(p ->> 'table', '');
  v_record text := nullif(p ->> 'record', '');
  v_from date := nullif(p ->> 'from', '')::date;
  v_to date := nullif(p ->> 'to', '')::date;
  v_q text := nullif(btrim(coalesce(p ->> 'q', '')), '');
  v_before bigint := nullif(p ->> 'before', '')::bigint;
  v_limit integer := least(greatest(coalesce(nullif(p ->> 'limit', '')::integer, 100), 1), 500);
begin
  if not public.is_admin() then raise exception 'Only an admin can see the activity log.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.id desc) from (
    select a.id, a.at, a.actor, a.actor_name, a.actor_roles, a.module, a.table_name, a.record_id, a.project_id,
      (select d.data ->> 'name' from public.tracker_docs d where d.collection = 'projects' and d.id = a.project_id) as project_name,
      a.action, a.changed, a.old, a.new, a.label, a.source, a.ip, a.user_agent
    from public.audit_log a
    where (v_actor is null or a.actor = v_actor)
      and (v_module is null or a.module = v_module)
      and (v_action is null or a.action = v_action)
      and (v_project is null or a.project_id = v_project)
      and (v_table is null or a.table_name = v_table)
      and (v_record is null or a.record_id = v_record)
      and (v_from is null or a.at >= (v_from::timestamp at time zone 'Asia/Manila'))
      and (v_to is null or a.at < ((v_to + 1)::timestamp at time zone 'Asia/Manila'))
      and (v_before is null or a.id < v_before)
      and (v_q is null or a.label ilike '%' || v_q || '%' or a.record_id ilike '%' || v_q || '%' or a.actor_name ilike '%' || v_q || '%')
    order by a.id desc
    limit v_limit) x), '[]'::jsonb);
end $$;

revoke execute on function public.audit_row(), public.audit_flat(jsonb), public.audit_module(text, jsonb) from public, anon, authenticated;
revoke execute on function public.audit_refused(text, text, text), public.audit_search(jsonb) from public, anon;
grant execute on function public.audit_refused(text, text, text), public.audit_search(jsonb) to authenticated;
