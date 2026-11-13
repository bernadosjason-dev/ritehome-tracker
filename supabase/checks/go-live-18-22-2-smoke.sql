-- Ritehome portal v2.4–v3.2 smoke test. Changes NOTHING: the block always ends by raising an
-- error, which rolls back every statement in it. The error text IS the result.
do $smoke$
declare
  admin_id uuid; n int := 0; bad int := 0; out text := ''; r text; ok boolean;
  calls text[] := array[
    'admin|select public.dashboard_overview()::text',
    'admin|select public.approval_rules_list()::text',
    'admin|select public.approvals_list(''{}''::jsonb)::text',
    'admin|select public.company_get()::text',
    'admin|select public.procurement_project_choices()::text',
    'admin|select public.attendance_month(date_trunc(''month'', now())::date)::text',
    'admin|select public.attendance_day(current_date)::text',
    'admin|select public.can_keep_books()::text',
    'admin|select public.can_manage_attendance()::text',
    'admin|select public.stage_needs_approval(''design'')::text',
    'admin|select public.approval_rules_save(''design'', public.stage_needs_approval(''design''))::text',
    'anon!|select public.dashboard_overview()::text',
    'anon!|select public.company_get()::text',
    'anon!|select public.approvals_list(''{}''::jsonb)::text'
  ];
  c text; who text; q text;
begin
  select id into admin_id from public.profiles where role = 'admin' and active order by created_at limit 1;
  if admin_id is null then raise exception 'SMOKE: no active admin profile found'; end if;
  foreach c in array calls loop
    who := split_part(c, '|', 1); q := substr(c, length(who) + 2); n := n + 1;
    begin
      if who = 'admin' then
        perform set_config('request.jwt.claim.sub', admin_id::text, true);
        perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
        execute 'set local role authenticated';
      else
        perform set_config('request.jwt.claim.sub', '', true);
        perform set_config('request.jwt.claims', '{"role":"anon"}', true);
        execute 'set local role anon';
      end if;
      execute q into r;
      execute 'reset role';
      ok := (who = 'admin');
      out := out || E'\n' || case when ok then 'PASS ' else 'FAIL (anon was allowed) ' end || q;
    exception when others then
      execute 'reset role';
      ok := (who = 'anon!');
      out := out || E'\n' || case when ok then 'PASS (refused) ' else 'FAIL ' || sqlerrm || ' :: ' end || q;
    end;
    if not ok then bad := bad + 1; end if;
  end loop;
  raise exception 'SMOKE RESULT (rolled back, nothing saved): % of % passed%', n - bad, n, out;
end
$smoke$;
