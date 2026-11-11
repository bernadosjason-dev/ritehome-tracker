-- Team accounts (team.html at /team, admin only). The accounts themselves are created by the
-- team-admin Edge Function (supabase/functions/team-admin), the only code that holds the service
-- role key: it makes the sign-in with a temporary password and activates the profile. Everything
-- else is here, and row-level security still decides: only an admin lists, changes or assigns.

-- Everyone with a profile, with the sign-in email and last sign-in from auth.users (which only
-- SECURITY DEFINER code can read), the projects they're assigned to, and whether they still have
-- to replace the temporary password.
create function public.team_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can see the team.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'full_name', p.full_name, 'role', p.role, 'active', p.active, 'created_at', p.created_at,
      'email', u.email, 'last_sign_in_at', u.last_sign_in_at,
      'must_change_password', coalesce(u.raw_user_meta_data ->> 'must_change_password', 'false') = 'true',
      'projects', (select count(*) from public.project_assignments a where a.user_id = p.id),
      'project_ids', (select coalesce(jsonb_agg(a.project_id), '[]'::jsonb) from public.project_assignments a where a.user_id = p.id),
      'me', p.id = auth.uid())
      order by p.active desc, lower(p.full_name))
    from public.profiles p left join auth.users u on u.id = p.id), '[]'::jsonb);
end $$;

-- Change a person's name, role or whether the account works. An admin can't switch off or demote
-- their own account, so there is always someone left who can let people in.
create function public.team_update(p_user uuid, p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare r public.profiles;
begin
  if not public.is_admin() then raise exception 'Only an admin can change the team.' using errcode = '42501'; end if;
  if p_user = auth.uid() and ((p ? 'active' and not (p ->> 'active')::boolean)
      or (p ? 'role' and p ->> 'role' <> 'admin')) then
    raise exception 'You can''t switch off or demote your own account.' using errcode = '42501';
  end if;
  update public.profiles set
    full_name = case when p ? 'full_name' then btrim(p ->> 'full_name') else full_name end,
    role = case when p ? 'role' then (p ->> 'role')::public.staff_role else role end,
    active = case when p ? 'active' then (p ->> 'active')::boolean else active end
  where id = p_user
  returning * into r;
  if not found then raise exception 'No such person.' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', r.id, 'full_name', r.full_name, 'role', r.role, 'active', r.active);
end $$;

-- Hand a person every unfinished whiteboard project written under their name in "In charge":
-- they're assigned to the project and to the stages their role owns that nobody has yet.
-- Returns how many projects they now have from the board.
create function public.team_assign_in_charge(p_user uuid, p_name text) returns integer
language plpgsql security invoker set search_path = public as $$
declare v_role public.staff_role; n integer;
begin
  if not public.is_admin() then raise exception 'Only an admin can assign work.' using errcode = '42501'; end if;
  select role into v_role from public.profiles where id = p_user and active;
  if v_role is null then raise exception 'That account isn''t active.' using errcode = 'P0002'; end if;
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
    and s.assignee is null and s.status <> 'done' and public.role_owns_stage(v_role, s.stage::text)
    and v_role <> 'admin';
  select count(*) into n from public.project_assignments a
  join public.tracker_docs d on d.collection = 'projects' and d.id = a.project_id
  where a.user_id = p_user and lower(btrim(d.data ->> 'inCharge')) = lower(btrim(p_name));
  return n;
end $$;

revoke execute on function public.team_list(), public.team_update(uuid, jsonb), public.team_assign_in_charge(uuid, text) from public, anon;
grant execute on function public.team_list(), public.team_update(uuid, jsonb), public.team_assign_in_charge(uuid, text) to authenticated;
