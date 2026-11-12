-- Phase 1 of the role plan: one person can hold several roles, two new roles (sales, bookkeeper)
-- and a site visit stage.
--
-- Roles: every profile keeps its main role (profiles.role) and may add extra roles
-- (profiles.extra_roles). Admin is only ever a main role: an admin already has everything, and the
-- team-admin Edge Function checks the main role alone. my_role() still returns the main role (and
-- null for an inactive account), so nothing that only asks "is this account active?" changes.
-- Everything that asks "may this person do X?" now asks has_role(), which looks at every role.
--
-- Sales: the Leads workspace (add, change, log contact; converting a lead into a project stays with
-- the admin, because that sets the contract price and budget) and the consultation and site visit
-- stages on the projects they're assigned to.
-- Bookkeeper: the role exists so the account can be made now. Accounting, attendance corrections
-- and the company profile open to it in phase 5; until then it sees only its own attendance.
-- Site visit: a stage between consultation and design. Until now the consultation included the site
-- visit, so every existing project gets a site visit stage with the consultation's status and dates.

-- ------------------------------------------------------------------ roles ----

alter table public.profiles add column if not exists extra_roles public.staff_role[] not null default '{}';
alter table public.profiles add constraint profiles_extra_roles_not_admin check (not ('admin' = any (extra_roles)));

-- Every role the caller holds (main role first), or an empty list when signed out or inactive.
create function public.my_roles() returns public.staff_role[]
language sql stable security definer set search_path = public as $$
  select coalesce((
    select array[p.role] || array(select distinct r from unnest(p.extra_roles) r where r <> p.role order by r)
    from public.profiles p where p.id = auth.uid() and p.active), '{}')
$$;

create function public.has_role(p_role public.staff_role) returns boolean
language sql stable security definer set search_path = public as $$
  select p_role = any (public.my_roles())
$$;

create or replace function public.can_stock() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin') or public.has_role('purchaser')
$$;

create function public.can_sell() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin') or public.has_role('sales')
$$;

-- Which role may work which stage. Sales: consultation and site visit. Bookkeeper: none.
create or replace function public.role_owns_stage(p_role public.staff_role, p_stage text) returns boolean
language sql immutable set search_path = public as $$
  select case p_role
    when 'admin' then true
    when 'sales' then p_stage in ('consultation', 'site_visit')
    when 'designer' then p_stage in ('design', 'cutlist', 'bom', 'final_cutlist')
    when 'purchaser' then p_stage = 'procurement'
    when 'fabrication' then p_stage = 'fabrication'
    when 'installer' then p_stage in ('installation', 'handover')
    else false end
$$;

-- A stage is yours to work when you're assigned to the project and any of your roles owns it.
create or replace function public.can_work_stage(p_project text, p_stage text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (public.is_assigned(p_project)
          and exists (select 1 from unnest(public.my_roles()) r where public.role_owns_stage(r, p_stage)))
$$;

-- The purchaser's procurement documents, for anyone holding the purchaser role (main or extra).
drop policy if exists "tracker data: purchaser on procurement" on public.tracker_docs;
create policy "tracker data: purchaser on procurement" on public.tracker_docs for all
  using (public.has_role('purchaser') and collection in ('procurementJobs', 'procurement'))
  with check (public.has_role('purchaser') and collection in ('procurementJobs', 'procurement'));

-- ------------------------------------------------------------- site visit ----

insert into public.project_stages (project_id, stage, status, actual_start, actual_end, notes)
select c.project_id, 'site_visit', c.status, c.actual_start, c.actual_end, ''
from public.project_stages c
where c.stage = 'consultation'
on conflict do nothing;

-- ------------------------------------------------------------------ leads ----

drop policy if exists "leads: admin only" on public.leads;
drop policy if exists "lead activity: admin reads" on public.lead_activity;
drop policy if exists "lead activity: admin adds" on public.lead_activity;
create policy "leads: sales and admin" on public.leads for all using (public.can_sell()) with check (public.can_sell());
create policy "lead activity: sales and admin read" on public.lead_activity for select using (public.can_sell());
create policy "lead activity: sales and admin add" on public.lead_activity for insert with check (public.can_sell());

-- Who logged each contact, by name. profiles is private to its owner and the admin, so the names
-- come from staff_directory() (active staff, names and roles only).
create or replace function public.lead_get(p_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object('lead', to_jsonb(l), 'activity', coalesce((
    select jsonb_agg(to_jsonb(a) || jsonb_build_object('by_name', (select d.full_name from public.staff_directory() d where d.id = a.by))
      order by a.at desc, a.id desc)
    from public.lead_activity a where a.lead_id = l.id), '[]'::jsonb))
  from public.leads l where l.id = p_id
$$;

create or replace function public.lead_save(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  if not public.can_sell() then raise exception 'Only sales or an admin can change leads.' using errcode = '42501'; end if;
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

create or replace function public.lead_log(p_id uuid, p_kind text, p_body text, p_next_action text default null, p_next_at date default null)
returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint;
begin
  if not public.can_sell() then raise exception 'Only sales or an admin can change leads.' using errcode = '42501'; end if;
  if p_kind not in ('note', 'call', 'message', 'visit', 'quote') then
    raise exception 'Unknown activity %.', p_kind using errcode = '23514';
  end if;
  insert into public.lead_activity (lead_id, kind, body) values (p_id, p_kind, btrim(coalesce(p_body, ''))) returning id into v_id;
  if p_next_action is not null or p_next_at is not null then
    update public.leads set next_action = btrim(coalesce(p_next_action, '')), next_action_at = p_next_at where id = p_id;
  end if;
  return v_id;
end $$;

-- lead_convert is unchanged: it checks is_admin(), because it sets the contract price and budget.

-- ---------------------------------------------------------------- schedule ----

-- The board now also says every role the caller holds.
create or replace function public.schedule_board() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'role', public.my_role(),
    'roles', to_jsonb(public.my_roles()),
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

-- The calendar shows the leads' follow-ups and requested site visits to sales as well as the admin.
create or replace function public.schedule_events(p_from date, p_to date) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare v_events jsonb; v_leads jsonb := '[]'::jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'project_id', e.project_id, 'kind', e.kind, 'title', e.title,
      'starts_at', e.starts_at, 'ends_at', e.ends_at, 'notes', e.notes) order by e.starts_at), '[]'::jsonb)
    into v_events
  from public.project_events e
  where e.starts_at < ((p_to + 1)::timestamp at time zone 'Asia/Manila')
    and e.ends_at >= (p_from::timestamp at time zone 'Asia/Manila');
  -- Other staff never reach the leads table, not even to be refused by row-level security.
  if public.can_sell() then
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

-- -------------------------------------------------------------------- team ----

create or replace function public.team_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can see the team.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'full_name', p.full_name, 'role', p.role, 'extra_roles', to_jsonb(p.extra_roles),
      'active', p.active, 'created_at', p.created_at,
      'email', u.email, 'last_sign_in_at', u.last_sign_in_at,
      'must_change_password', coalesce(u.raw_user_meta_data ->> 'must_change_password', 'false') = 'true',
      'projects', (select count(*) from public.project_assignments a where a.user_id = p.id),
      'project_ids', (select coalesce(jsonb_agg(a.project_id), '[]'::jsonb) from public.project_assignments a where a.user_id = p.id),
      'me', p.id = auth.uid())
      order by p.active desc, lower(p.full_name))
    from public.profiles p left join auth.users u on u.id = p.id), '[]'::jsonb);
end $$;

-- Change a person's name, main role, extra roles or whether the account works. Extra roles never
-- repeat the main role and never include admin; making someone admin clears their extra roles.
-- An admin can't switch off or demote their own account.
create or replace function public.team_update(p_user uuid, p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare r public.profiles; v_role public.staff_role; v_extra public.staff_role[];
begin
  if not public.is_admin() then raise exception 'Only an admin can change the team.' using errcode = '42501'; end if;
  if p_user = auth.uid() and ((p ? 'active' and not (p ->> 'active')::boolean)
      or (p ? 'role' and p ->> 'role' <> 'admin')) then
    raise exception 'You can''t switch off or demote your own account.' using errcode = '42501';
  end if;
  select * into r from public.profiles where id = p_user;
  if not found then raise exception 'No such person.' using errcode = 'P0002'; end if;
  v_role := case when p ? 'role' then (p ->> 'role')::public.staff_role else r.role end;
  if p ? 'extra_roles' then
    if jsonb_typeof(p -> 'extra_roles') <> 'array' then
      raise exception 'Send the extra roles as a list.' using errcode = '22023';
    end if;
    if p -> 'extra_roles' ? 'admin' then
      raise exception 'Admin is a main role: set it as the role instead.' using errcode = '23514';
    end if;
    v_extra := array(select distinct x::public.staff_role from jsonb_array_elements_text(p -> 'extra_roles') x);
  else
    v_extra := r.extra_roles;
  end if;
  v_extra := case when v_role = 'admin' then '{}'
    else array(select distinct x from unnest(v_extra) x where x <> v_role order by x) end;
  update public.profiles set
    full_name = case when p ? 'full_name' then btrim(p ->> 'full_name') else full_name end,
    role = v_role,
    extra_roles = v_extra,
    active = case when p ? 'active' then (p ->> 'active')::boolean else active end
  where id = p_user
  returning * into r;
  return jsonb_build_object('id', r.id, 'full_name', r.full_name, 'role', r.role,
    'extra_roles', to_jsonb(r.extra_roles), 'active', r.active);
end $$;

-- Hand a person every unfinished whiteboard project written under their name in "In charge": they're
-- assigned to the project and to the stages any of their roles owns that nobody has yet.
create or replace function public.team_assign_in_charge(p_user uuid, p_name text) returns integer
language plpgsql security invoker set search_path = public as $$
declare v_roles public.staff_role[]; n integer;
begin
  if not public.is_admin() then raise exception 'Only an admin can assign work.' using errcode = '42501'; end if;
  select array[role] || extra_roles into v_roles from public.profiles where id = p_user and active;
  if v_roles is null then raise exception 'That account isn''t active.' using errcode = 'P0002'; end if;
  if btrim(coalesce(p_name, '')) = '' then raise exception 'Give the name written on the board.' using errcode = '23514'; end if;
  insert into public.project_assignments (project_id, user_id)
  select d.id, p_user from public.tracker_docs d
  where d.collection = 'projects' and coalesce(d.data ->> 'status', '') <> 'completed'
    and lower(btrim(d.data ->> 'inCharge')) = lower(btrim(p_name))
  on conflict do nothing;
  update public.project_stages s set assignee = p_user
  from public.tracker_docs d
  where d.collection = 'projects' and d.id = s.project_id and coalesce(d.data ->> 'status', '') <> 'completed'
    and lower(btrim(d.data ->> 'inCharge')) = lower(btrim(p_name))
    and s.assignee is null and s.status <> 'done'
    and not ('admin' = any (v_roles))
    and exists (select 1 from unnest(v_roles) r where public.role_owns_stage(r, s.stage::text));
  select count(*) into n from public.project_assignments a
  join public.tracker_docs d on d.collection = 'projects' and d.id = a.project_id
  where a.user_id = p_user and lower(btrim(d.data ->> 'inCharge')) = lower(btrim(p_name));
  return n;
end $$;

-- ------------------------------------------------------------------ grants ----

revoke execute on function public.my_roles(), public.has_role(public.staff_role), public.can_sell() from public, anon;
grant execute on function public.my_roles(), public.has_role(public.staff_role), public.can_sell() to authenticated;
