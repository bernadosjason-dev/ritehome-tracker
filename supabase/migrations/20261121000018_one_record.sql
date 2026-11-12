-- One record per fact (the 2026-11-13 duplicate review). Five places where the same thing was
-- typed twice, or could be:
--   5. A site visit was a calendar event and a schedule stage. Now the event sets the stage's date.
--   2. A project could be created three ways (Projects, the whiteboard, a won lead) and nothing
--      stopped the same client twice. Now one guard on every new project asks first.
--   1. Deliveries were recorded on the purchase order and again by hand in Inventory. Now a PO
--      delivery adds the stock itself.
--   3. A procurement job and its project were separate records with nothing joining them. Now a job
--      names its project.
--   4. The dashboard was the Projects, Procurement and Fuel pages stacked. Now dashboard_overview()
--      gives it its own figures.

-- ------------------------------------------------- 5. site visit: one record ----

-- A site-visit event on a project's calendar sets that project's Site visit stage dates (Manila
-- days), unless the stage is already done. Events are admin-only, so the stage guard lets it through.
create function public.site_visit_from_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare d1 date; d2 date;
begin
  if new.kind <> 'site_visit' or new.project_id is null then return null; end if;
  d1 := (new.starts_at at time zone 'Asia/Manila')::date;
  d2 := greatest(d1, (new.ends_at at time zone 'Asia/Manila')::date);
  update public.project_stages set planned_start = d1, planned_end = d2
  where project_id = new.project_id and stage = 'site_visit' and status <> 'done'
    and (planned_start is distinct from d1 or planned_end is distinct from d2);
  return null;
end $$;
create trigger site_visit_from_event after insert or update of kind, project_id, starts_at, ends_at on public.project_events
  for each row execute function public.site_visit_from_event();
revoke execute on function public.site_visit_from_event() from public, anon, authenticated;

-- ------------------------------------------- 2. one project per client job ----

-- Open projects for the same client: the same name (ignoring case and spaces) or the same phone
-- (last ten digits). Completed and cancelled jobs don't count; a returning client can start again.
create function public.project_duplicates(p_client text, p_phone text, p_except text default null)
returns table (id text, name text)
language sql stable security definer set search_path = public as $$
  select d.id, coalesce(nullif(d.data ->> 'name', ''), d.id)
  from public.tracker_docs d
  where d.collection = 'projects' and d.id is distinct from p_except
    and coalesce(d.data ->> 'status', 'active') not in ('completed', 'cancelled')
    and ((nullif(lower(btrim(p_client)), '') is not null and lower(btrim(d.data ->> 'clientName')) = lower(btrim(p_client)))
      or (length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 7
          and right(regexp_replace(coalesce(d.data ->> 'clientPhone', ''), '\D', '', 'g'), 10)
            = right(regexp_replace(p_phone, '\D', '', 'g'), 10)))
  order by d.updated_at desc
$$;

-- Every new project, however it's made (Projects, the whiteboard, a won lead), is checked here.
-- A duplicate is refused with SQLSTATE RH409, the existing project's id in the hint. The page asks
-- "use it, or create another?"; another is made by sending data.confirmDuplicate = true, which is
-- taken off before the row is stored.
create function public.project_duplicate_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  if new.collection <> 'projects' then return new; end if;
  if coalesce(new.data ->> 'confirmDuplicate', '') = 'true' then
    new.data := new.data - 'confirmDuplicate';
    return new;
  end if;
  select * into d from public.project_duplicates(new.data ->> 'clientName', new.data ->> 'clientPhone', new.id) limit 1;
  if found then
    raise exception 'This client already has an open project: %.', d.name
      using errcode = 'RH409', hint = d.id;
  end if;
  return new;
end $$;
create trigger project_duplicate_guard before insert on public.tracker_docs
  for each row execute function public.project_duplicate_guard();

-- The whiteboard passes "create another anyway" through to the guard.
create or replace function public.board_project_save(p jsonb) returns text
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
  -- The system is chosen on the board; a row added without one is guessed from its type.
  v_system := nullif(p ->> 'system', '');
  if v_system is not null and v_system not in ('kitchen', 'storage', 'partition', 'workspace') then
    raise exception 'Pick Kitchen, Storage, Partition or Workstation.' using errcode = '23514';
  end if;
  v_system := coalesce(v_system, case when lower(v_type) like '%kitchen%' or lower(v_type) like '%pantry%' then 'kitchen'
    when lower(v_type) like '%partition%' then 'partition'
    when lower(v_type) ~ '(office|workstation|workspace|desk|cubicle)' then 'workspace'
    when v_type = '' then null else 'storage' end);
  if v_id is null then
    if v_client = '' then raise exception 'Write the client''s name.' using errcode = '23514'; end if;
    v_id := 'p_' || substr(md5(gen_random_uuid()::text), 1, 16);
    insert into public.tracker_docs (collection, id, data) values ('projects', v_id, jsonb_strip_nulls(jsonb_build_object(
      'name', case when v_type <> '' then v_type || ' – ' || v_client else v_client end,
      'clientName', v_client, 'projectType', nullif(v_type, ''), 'inCharge', nullif(btrim(coalesce(p ->> 'inCharge', '')), ''),
      'system', v_system, 'targetDate', nullif(p ->> 'targetDate', ''), 'status', 'active',
      'createdAt', v_now, 'updatedAt', v_now,
      'confirmDuplicate', case when coalesce(p ->> 'confirmDuplicate', '') = 'true' then 'true' end)));
    return v_id;
  end if;
  v_patch := jsonb_build_object('updatedAt', v_now);
  if p ? 'projectType' then v_patch := v_patch || jsonb_build_object('projectType', v_type); end if;
  if p ? 'system' and nullif(p ->> 'system', '') is not null then v_patch := v_patch || jsonb_build_object('system', v_system); end if;
  if p ? 'inCharge' then v_patch := v_patch || jsonb_build_object('inCharge', btrim(coalesce(p ->> 'inCharge', ''))); end if;
  if p ? 'clientName' and v_client <> '' then v_patch := v_patch || jsonb_build_object('clientName', v_client); end if;
  if p ? 'targetDate' then v_patch := v_patch || jsonb_build_object('targetDate', coalesce(p ->> 'targetDate', '')); end if;
  update public.tracker_docs set data = data || v_patch where collection = 'projects' and id = v_id;
  if not found then raise exception 'No project %.', v_id using errcode = 'P0002'; end if;
  return v_id;
end $$;

-- A won lead either opens a new project (as before) or, with p_project, is linked to the client's
-- project that already exists. p_confirm_new creates another even when one is open.
drop function public.lead_convert(uuid, numeric, numeric);
create function public.lead_convert(p_id uuid, p_price numeric, p_budget numeric default null,
                                    p_project text default null, p_confirm_new boolean default false) returns text
language plpgsql security invoker set search_path = public as $$
declare l public.leads; v_pid text; v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if not public.is_admin() then raise exception 'Only an admin can change leads.' using errcode = '42501'; end if;
  select * into l from public.leads where id = p_id;
  if not found then raise exception 'No lead %.', p_id using errcode = 'P0002'; end if;
  if l.project_id is not null then return l.project_id; end if;
  if nullif(p_project, '') is not null then
    if not exists (select 1 from public.tracker_docs where collection = 'projects' and id = p_project) then
      raise exception 'No project %.', p_project using errcode = 'P0002';
    end if;
    update public.tracker_docs set data = data || jsonb_build_object('leadId', l.id::text, 'updatedAt', v_now)
    where collection = 'projects' and id = p_project;
    update public.leads set stage = 'won', project_id = p_project, expected_value = coalesce(p_price, expected_value) where id = p_id;
    return p_project;
  end if;
  v_pid := 'p_' || substr(md5(gen_random_uuid()::text), 1, 16);
  insert into public.tracker_docs (collection, id, data) values ('projects', v_pid, jsonb_strip_nulls(jsonb_build_object(
    'name', case l.system when 'kitchen' then 'Kitchen' when 'storage' then 'Storage' when 'partition' then 'Partition'
                          when 'workspace' then 'Workspace' else 'Project' end || ' – ' || l.name,
    'clientName', l.name, 'clientPhone', nullif(l.phone, ''), 'clientEmail', nullif(l.email, ''),
    'address', nullif(l.location, ''), 'system', case when l.system in ('kitchen', 'storage', 'partition', 'workspace') then l.system end,
    'price', coalesce(p_price, l.expected_value, 0), 'budget', p_budget, 'status', 'active',
    'createdAt', v_now, 'updatedAt', v_now, 'leadId', l.id::text,
    'confirmDuplicate', case when p_confirm_new then 'true' end)));
  update public.leads set stage = 'won', project_id = v_pid,
    expected_value = coalesce(p_price, expected_value) where id = p_id;
  return v_pid;
end $$;
revoke execute on function public.lead_convert(uuid, numeric, numeric, text, boolean) from public, anon;
grant execute on function public.lead_convert(uuid, numeric, numeric, text, boolean) to authenticated;
revoke execute on function public.project_duplicates(text, text, text), public.project_duplicate_guard() from public, anon, authenticated;

-- ------------------------------------ 1. a PO delivery is the stock received ----

-- Procurement documents (collection 'procurement', one per job) hold BOMs and purchase orders; a PO
-- line's "received" is what the supplier has delivered. Each time that number changes, the
-- difference goes into Inventory as a movement, so the purchaser never types a delivery twice:
--   more received   -> a 'receive' movement (+)
--   less received   -> an 'adjust' movement (−), never below what is on the shelf (a correction
--                      after the stock was already used is left to a count)
-- The stock item is the BOM material with the same name and spec (ignoring case); a material that
-- isn't stocked yet becomes a new item. A unit that differs from the stock item's is noted on the
-- movement so the purchaser can see it. Movements name the job and the PO.
create function public.stock_category_guess(p_material text) returns text
language sql immutable set search_path = public as $$
  select case
    when p_material ~* '(plywood|mdf|board|laminate|melamine|particle|hpl)' then 'board'
    when p_material ~* 'edge' then 'edgeband'
    when p_material ~* '(hinge|slide|runner|handle|knob|screw|bolt|bracket|lock)' then 'hardware'
    when p_material ~* '(countertop|granite|quartz|solid surface)' then 'countertop'
    when p_material ~* '(glue|adhesive|sealant|silicone|sandpaper|tape|nail)' then 'consumable'
    else 'other' end
$$;

create function public.procurement_deliveries_to_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o_line jsonb; n_order jsonb; n_line jsonb; bom_item jsonb;
  v_old numeric; v_new numeric; v_delta numeric; v_have numeric;
  v_item public.inventory_items; v_job text; v_unit text; v_note text;
begin
  if new.collection <> 'procurement' then return null; end if;
  v_job := left(coalesce(
    (select nullif(d.data ->> 'name', '') from public.tracker_docs d where d.collection = 'procurementJobs' and d.id = new.id),
    (select nullif(d.data ->> 'name', '') from public.tracker_docs d where d.collection = 'projects' and d.id = new.id), ''), 120);
  for n_order in select * from jsonb_array_elements(coalesce(new.data -> 'orders', '[]'::jsonb)) loop
    for n_line in select * from jsonb_array_elements(coalesce(n_order -> 'lines', '[]'::jsonb)) loop
      v_new := coalesce((n_line ->> 'received')::numeric, 0);
      v_old := 0;
      if tg_op = 'UPDATE' then
        select coalesce((l ->> 'received')::numeric, 0) into v_old
        from jsonb_array_elements(coalesce(old.data -> 'orders', '[]'::jsonb)) o, jsonb_array_elements(coalesce(o -> 'lines', '[]'::jsonb)) l
        where lower(o ->> 'reference') = lower(n_order ->> 'reference') and l ->> 'itemId' = n_line ->> 'itemId'
        limit 1;
        v_old := coalesce(v_old, 0);
      end if;
      v_delta := v_new - v_old;
      continue when v_delta = 0;
      select i into bom_item from jsonb_array_elements(coalesce(new.data -> 'boms', '[]'::jsonb)) b, jsonb_array_elements(coalesce(b -> 'items', '[]'::jsonb)) i
      where i ->> 'id' = n_line ->> 'itemId' limit 1;
      continue when bom_item is null;
      select * into v_item from public.inventory_items
      where active and lower(btrim(name)) = lower(btrim(left(bom_item ->> 'material', 120)))
        and lower(btrim(spec)) = lower(btrim(coalesce(bom_item ->> 'spec', '')));
      if not found then
        insert into public.inventory_items (name, category, unit, spec)
        values (btrim(left(bom_item ->> 'material', 120)), public.stock_category_guess(bom_item ->> 'material'),
                coalesce(nullif(btrim(left(bom_item ->> 'unit', 20)), ''), 'pc'), btrim(coalesce(bom_item ->> 'spec', '')))
        returning * into v_item;
      end if;
      v_unit := btrim(coalesce(bom_item ->> 'unit', ''));
      v_note := left('PO ' || coalesce(n_order ->> 'reference', '') || ' · ' || coalesce(n_order ->> 'supplier', '')
        || case when v_unit <> '' and lower(v_unit) <> lower(v_item.unit) then ' (PO unit: ' || v_unit || ')' else '' end, 300);
      if v_delta > 0 then
        insert into public.inventory_moves (item_id, qty, kind, job, note) values (v_item.id, v_delta, 'receive', v_job, v_note);
      else
        v_have := public.inventory_on_hand(v_item.id);
        v_delta := -least(abs(v_delta), v_have);
        continue when v_delta = 0;
        insert into public.inventory_moves (item_id, qty, kind, job, note)
        values (v_item.id, v_delta, 'adjust', v_job, left('Delivery corrected on ' || v_note, 300));
      end if;
    end loop;
  end loop;
  return null;
end $$;
create trigger procurement_deliveries_to_stock after insert or update of data on public.tracker_docs
  for each row execute function public.procurement_deliveries_to_stock();
revoke execute on function public.procurement_deliveries_to_stock(), public.stock_category_guess(text) from public, anon, authenticated;

-- ------------------------------- 3. a procurement job names its project ----

-- A procurement job (collection 'procurementJobs') may carry data.projectId: the client project it
-- buys for. The purchaser can't read projects (they hold prices), so this offers the open ones by
-- name and client only, to pick from.
create function public.procurement_project_choices() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_stock() then raise exception 'Procurement is for the purchaser and the admin.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', coalesce(nullif(d.data ->> 'name', ''), d.id),
      'client', coalesce(d.data ->> 'clientName', '')) order by lower(coalesce(d.data ->> 'name', d.id)))
    from public.tracker_docs d
    where d.collection = 'projects' and coalesce(d.data ->> 'status', 'active') not in ('completed', 'cancelled')), '[]'::jsonb);
end $$;
revoke execute on function public.procurement_project_choices() from public, anon;
grant execute on function public.procurement_project_choices() to authenticated;

-- ============================================================================================
-- Fix 4. The Dashboard ('/') is the company at a glance, not the Projects, Procurement and Fuel
-- pages stacked. Counts only, each one the thing to act on, each linked to the page that acts on
-- it. Definer so it can count across every workspace; refuses anyone but an admin.
-- ============================================================================================
create function public.dashboard_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  r jsonb;
begin
  if not public.is_admin() then raise exception 'The dashboard is for the admin.' using errcode = '42501'; end if;
  with open_projects as (
    select d.id, coalesce(nullif(d.data ->> 'name', ''), d.id) as name from public.tracker_docs d
    where d.collection = 'projects' and coalesce(d.data ->> 'status', 'active') not in ('completed', 'cancelled')
  ), stages as (
    select s.*, p.name as project_name, pr.full_name as who
    from public.project_stages s join open_projects p on p.id = s.project_id
    left join public.profiles pr on pr.id = s.assignee
  ), stock as (
    select i.name, i.reorder_level, public.inventory_on_hand(i.id) as on_hand
    from public.inventory_items i where i.active and i.reorder_level > 0
  )
  select jsonb_build_object(
    'leads', jsonb_build_object(
      'open', (select count(*) from public.leads where stage not in ('won', 'lost')),
      'unanswered', (select count(*) from public.leads where stage = 'new' and first_response_at is null),
      'followups_due', (select count(*) from public.leads where stage not in ('won', 'lost') and next_action_at <= today)),
    'stages', jsonb_build_object(
      'submitted', (select count(*) from stages where status = 'submitted'),
      'blocked', (select count(*) from stages where status = 'blocked'),
      'overdue', (select count(*) from stages where status <> 'done' and planned_end < today)),
    'stock', jsonb_build_object(
      'out', (select count(*) from stock where on_hand <= 0),
      'low', (select count(*) from stock where on_hand > 0 and on_hand <= reorder_level)),
    'attendance', jsonb_build_object(
      'in_today', (select count(distinct user_id) from public.attendance_punches where work_date = today and kind in ('am_in', 'pm_in')),
      'staff', (select count(*) from public.profiles where active and role <> 'admin'),
      'to_check', (select count(*) from public.attendance_punches where cardinality(flags) > 0 and reviewed_at is null)),
    -- The stages waiting on the admin, oldest first: what "needs you" means on the schedule.
    'needs_you', coalesce((select jsonb_agg(x order by x ->> 'since') from (
        select jsonb_build_object('project_id', project_id, 'project', project_name, 'stage', stage, 'status', status,
          'who', coalesce(who, ''), 'since', (updated_at at time zone 'Asia/Manila')::date) as x
        from stages where status in ('submitted', 'blocked') order by updated_at limit 8) t), '[]'::jsonb)
  ) into r;
  return r;
end $$;
revoke execute on function public.dashboard_overview() from public, anon;
grant execute on function public.dashboard_overview() to authenticated;
