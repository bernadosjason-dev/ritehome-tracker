-- The whiteboard's breakdown by system (Kitchen / Storage / Partition / Workstation): the board now
-- picks a project's system explicitly instead of only guessing it from the project type, and can
-- change it later. Storage covers cabinets, TV consoles, wardrobes, closets and headboards; the
-- Workstation system is stored as 'workspace', the website's word for it.
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
      'createdAt', v_now, 'updatedAt', v_now)));
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
