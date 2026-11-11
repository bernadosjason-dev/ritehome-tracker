-- Schedule workspace (schedule.html at /schedule): the pipeline board, the Gantt timeline and the
-- calendar, on the project_stages and project_events tables from portal_core. Nothing here widens
-- who sees what: every function is SECURITY INVOKER, so row-level security and the stage guard
-- trigger still decide every read and write. Staff see only projects they're assigned to (through
-- my_projects(), which never returns money or a client's email) and change only their own stages.

-- The whiteboard's Final cutlist is the designer's, like the initial cutlist and the BOM.
create or replace function public.role_owns_stage(p_role public.staff_role, p_stage text) returns boolean
language sql immutable set search_path = public as $$
  select case p_role
    when 'admin' then true
    when 'designer' then p_stage in ('design', 'cutlist', 'bom', 'final_cutlist')
    when 'fabrication' then p_stage = 'fabrication'
    when 'installer' then p_stage in ('installation', 'handover')
    else false end
$$;

-- Projects that already exist get the new stage too (new ones get it from seed_project_stages).
insert into public.project_stages (project_id, stage)
select d.id, 'final_cutlist' from public.tracker_docs d where d.collection = 'projects'
on conflict do nothing;

-- What the whiteboard writes beside the client's name: the project type in the office's own words
-- ("TV console", "Walk-in pantry") and the person in charge. Neither is money, so staff see them for
-- their own projects; they live in the project document (projectType, inCharge), which only an admin
-- can read directly.
create function public.project_labels()
returns table (id text, project_type text, in_charge text, created_at text)
language sql stable security definer set search_path = public as $$
  select d.id, coalesce(d.data ->> 'projectType', ''), coalesce(d.data ->> 'inCharge', ''),
         coalesce(d.data ->> 'createdAt', to_char(d.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
  from public.tracker_docs d
  where d.collection = 'projects' and public.can_read_project(d.id)
$$;

-- A whiteboard row (admin): a new project from a client name, project type and person in charge,
-- or, with "id", a change to those (and the target date). Other project fields are left alone.
create function public.board_project_save(p jsonb) returns text
language plpgsql security invoker set search_path = public as $$
declare
  v_id text := nullif(p ->> 'id', '');
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_type text := btrim(coalesce(p ->> 'projectType', ''));
  v_client text := btrim(coalesce(p ->> 'clientName', ''));
  v_system text;
  v_patch jsonb;
begin
  if not public.is_admin() then raise exception 'Only an admin can add or change projects.' using errcode = '42501'; end if;
  if length(v_type) > 80 or length(v_client) > 120 or length(coalesce(p ->> 'inCharge', '')) > 80 then
    raise exception 'Keep the client name under 120 characters and the type and person under 80.' using errcode = '22001';
  end if;
  v_system := case when lower(v_type) like '%kitchen%' or lower(v_type) like '%pantry%' then 'kitchen'
    when lower(v_type) like '%partition%' then 'partition'
    when lower(v_type) ~ '(office|workstation|workspace|desk)' then 'workspace'
    when v_type = '' then null else 'storage' end;
  if v_id is null then
    if v_client = '' then raise exception 'Write the client''s name.' using errcode = '23514'; end if;
    v_id := 'p_' || substr(md5(gen_random_uuid()::text), 1, 16);
    insert into public.tracker_docs (collection, id, data) values ('projects', v_id, jsonb_strip_nulls(jsonb_build_object(
      'name', case when v_type <> '' then v_type || ' – ' || v_client else v_client end,
      'clientName', v_client, 'projectType', nullif(v_type, ''), 'inCharge', nullif(btrim(coalesce(p ->> 'inCharge', '')), ''),
      'system', v_system, 'targetDate', nullif(p ->> 'targetDate', ''), 'status', 'active',
      'createdAt', v_now, 'updatedAt', v_now)));
    return v_id;
  end if;
  v_patch := jsonb_build_object('updatedAt', v_now);
  if p ? 'projectType' then v_patch := v_patch || jsonb_build_object('projectType', v_type); end if;
  if p ? 'inCharge' then v_patch := v_patch || jsonb_build_object('inCharge', btrim(coalesce(p ->> 'inCharge', ''))); end if;
  if p ? 'clientName' and v_client <> '' then v_patch := v_patch || jsonb_build_object('clientName', v_client); end if;
  if p ? 'targetDate' then v_patch := v_patch || jsonb_build_object('targetDate', coalesce(p ->> 'targetDate', '')); end if;
  update public.tracker_docs set data = data || v_patch where collection = 'projects' and id = v_id;
  if not found then raise exception 'No project %.', v_id using errcode = 'P0002'; end if;
  return v_id;
end $$;

-- Stage dates fill themselves in when the status moves, on the Manila calendar day, so staff only
-- have to tap a status. Reopening a finished stage clears the finish date unless one is given.
create function public.stage_auto_dates() returns trigger
language plpgsql set search_path = public as $$
declare v_today date := (now() at time zone 'Asia/Manila')::date;
begin
  if new.status is distinct from old.status then
    if new.status <> 'not_started' and new.actual_start is null then
      new.actual_start := least(v_today, coalesce(new.actual_end, v_today));
    end if;
    if new.status = 'done' and new.actual_end is null then
      new.actual_end := greatest(v_today, new.actual_start);
    end if;
    if old.status = 'done' and new.status <> 'done' and new.actual_end is not distinct from old.actual_end then
      new.actual_end := null;
    end if;
    if new.status = 'not_started' and new.actual_start is not distinct from old.actual_start then
      new.actual_start := null;
    end if;
  end if;
  return new;
end $$;
-- Named to run after project_stages_guard (same timing: alphabetical order).
create trigger project_stages_zz_dates before update on public.project_stages
  for each row execute function public.stage_auto_dates();

-- Everything the board, timeline and calendar draw, in one call: the caller's role, today in
-- Manila, the projects they may see with all eight stages, and the active staff for pickers.
create function public.schedule_board() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'role', public.my_role(),
    'today', (now() at time zone 'Asia/Manila')::date,
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'system', p.system, 'client', p.client_name, 'phone', p.client_phone,
        'address', p.address, 'status', p.status, 'target', p.target_date,
        'type', lb.project_type, 'in_charge', lb.in_charge, 'created', lb.created_at,
        'stages', coalesce((
          select jsonb_agg(jsonb_build_object(
            'stage', s.stage, 'status', s.status, 'planned_start', s.planned_start, 'planned_end', s.planned_end,
            'actual_start', s.actual_start, 'actual_end', s.actual_end, 'assignee', s.assignee, 'notes', s.notes,
            'updated_at', s.updated_at, 'can_edit', public.can_work_stage(p.id, s.stage::text)) order by s.stage)
          from public.project_stages s where s.project_id = p.id), '[]'::jsonb))
        order by p.target_date nulls last, p.name)
      from public.my_projects() p left join public.project_labels() lb on lb.id = p.id), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(to_jsonb(d) order by d.full_name) from public.staff_directory() d), '[]'::jsonb))
$$;

-- One stage: status, actual dates and notes for whoever works the stage; planned dates and the
-- assignee for an admin only (the guard trigger refuses anyone else). Only keys present change.
-- Assigning someone to a stage also gives them the project, so they can see it.
create function public.stage_save(p_project text, p_stage public.stage_key, p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare r public.project_stages;
begin
  if public.my_role() is null then raise exception 'Sign in with an active account first.' using errcode = '42501'; end if;
  update public.project_stages s set
    status = case when p ? 'status' then (p ->> 'status')::public.stage_status else s.status end,
    actual_start = case when p ? 'actual_start' then nullif(p ->> 'actual_start', '')::date else s.actual_start end,
    actual_end = case when p ? 'actual_end' then nullif(p ->> 'actual_end', '')::date else s.actual_end end,
    notes = case when p ? 'notes' then btrim(coalesce(p ->> 'notes', '')) else s.notes end,
    planned_start = case when p ? 'planned_start' then nullif(p ->> 'planned_start', '')::date else s.planned_start end,
    planned_end = case when p ? 'planned_end' then nullif(p ->> 'planned_end', '')::date else s.planned_end end,
    assignee = case when p ? 'assignee' then nullif(p ->> 'assignee', '')::uuid else s.assignee end
  where s.project_id = p_project and s.stage = p_stage
  returning * into r;
  if not found then
    raise exception 'That stage isn''t yours to change.' using errcode = '42501';
  end if;
  if r.assignee is not null and public.is_admin() then
    insert into public.project_assignments (project_id, user_id) values (p_project, r.assignee) on conflict do nothing;
  end if;
  return to_jsonb(r);
end $$;

-- Planned dates for several stages at once (the planner and "push the rest"), all or nothing.
create function public.stage_plan(p_project text, p_rows jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'Only an admin can plan stage dates.' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Send a list of stages.' using errcode = '22023'; end if;
  update public.project_stages s set
    planned_start = nullif(r ->> 'planned_start', '')::date,
    planned_end = nullif(r ->> 'planned_end', '')::date
  from jsonb_array_elements(p_rows) r
  where s.project_id = p_project and s.stage = (r ->> 'stage')::public.stage_key;
  get diagnostics n = row_count;
  if n <> jsonb_array_length(p_rows) then
    raise exception 'Planned % of % stages: check the project and stage names.', n, jsonb_array_length(p_rows) using errcode = 'P0002';
  end if;
  return n;
end $$;

-- Calendar items between two dates (inclusive): events the caller may see, and for an admin the
-- leads' next follow-ups and requested site visits (read-only, from the lead scoreboard).
create function public.schedule_events(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v_events jsonb; v_leads jsonb := '[]'::jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'project_id', e.project_id, 'kind', e.kind, 'title', e.title,
      'starts_at', e.starts_at, 'ends_at', e.ends_at, 'notes', e.notes) order by e.starts_at), '[]'::jsonb)
    into v_events
  from public.project_events e
  where e.starts_at < ((p_to + 1)::timestamp at time zone 'Asia/Manila')
    and e.ends_at >= (p_from::timestamp at time zone 'Asia/Manila');
  -- Staff never reach the leads table, not even to be refused by row-level security.
  if public.is_admin() then
    select coalesce(jsonb_agg(x order by x ->> 'date', x ->> 'name'), '[]'::jsonb) into v_leads from (
      select jsonb_build_object('lead_id', l.id, 'name', l.name, 'kind', 'follow_up', 'date', l.next_action_at, 'text', l.next_action) x
      from public.leads l
      where l.stage not in ('won', 'lost') and l.next_action_at between p_from and p_to
      union all
      select jsonb_build_object('lead_id', l.id, 'name', l.name, 'kind', 'visit_request', 'date', left(l.visit_requested, 10),
        'text', btrim(substr(l.visit_requested, 11)))
      from public.leads l
      where l.stage in ('new', 'contacted') and l.visit_requested ~ '^\d{4}-\d{2}-\d{2}'
        and left(l.visit_requested, 10) between p_from::text and p_to::text
    ) q;
  end if;
  return jsonb_build_object('events', v_events, 'leads', v_leads);
end $$;

-- Add or change an event (admin). With "id" it updates that event.
create function public.event_save(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  if not public.is_admin() then raise exception 'Only an admin can add or change events.' using errcode = '42501'; end if;
  if v_id is null then
    insert into public.project_events (project_id, kind, title, starts_at, ends_at, notes)
    values (nullif(p ->> 'project_id', ''), p ->> 'kind', btrim(coalesce(p ->> 'title', '')),
            (p ->> 'starts_at')::timestamptz, coalesce(nullif(p ->> 'ends_at', ''), p ->> 'starts_at')::timestamptz,
            btrim(coalesce(p ->> 'notes', '')))
    returning id into v_id;
    return v_id;
  end if;
  update public.project_events set
    project_id = nullif(p ->> 'project_id', ''), kind = p ->> 'kind', title = btrim(coalesce(p ->> 'title', '')),
    starts_at = (p ->> 'starts_at')::timestamptz,
    ends_at = coalesce(nullif(p ->> 'ends_at', ''), p ->> 'starts_at')::timestamptz,
    notes = btrim(coalesce(p ->> 'notes', ''))
  where id = v_id;
  if not found then raise exception 'No event %.', v_id using errcode = 'P0002'; end if;
  return v_id;
end $$;

create function public.event_delete(p_id uuid) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can delete events.' using errcode = '42501'; end if;
  delete from public.project_events where id = p_id;
  if not found then raise exception 'No event %.', p_id using errcode = 'P0002'; end if;
end $$;

revoke execute on function public.stage_auto_dates() from public, anon, authenticated;
revoke execute on function public.project_labels(), public.board_project_save(jsonb) from public, anon;
grant execute on function public.project_labels(), public.board_project_save(jsonb) to authenticated;
revoke execute on function public.schedule_board(), public.stage_save(text, public.stage_key, jsonb),
  public.stage_plan(text, jsonb), public.schedule_events(date, date), public.event_save(jsonb),
  public.event_delete(uuid) from public, anon;
grant execute on function public.schedule_board(), public.stage_save(text, public.stage_key, jsonb),
  public.stage_plan(text, jsonb), public.schedule_events(date, date), public.event_save(jsonb),
  public.event_delete(uuid) to authenticated;
