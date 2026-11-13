-- Phase 5c (v3.2): attendance management (the CRM master prompt, section 13, and its permission
-- matrix: Attendance = admin full, bookkeeper edit). Absences, leave, corrections and remarks, the
-- month for payroll with them counted, and the bookkeeper managing it alongside the admin.
--
-- The owner's rule (2026-11-12): punches are never edited. A wrong or missing punch gets a
-- correction: a new record with the right time and a reason, which the hours and the late count use
-- in place of the punch. A record is never edited or deleted either; a wrong one is voided with a
-- reason. Every record and void is in the activity log with who made it.
--
-- Two controls:
--   * nobody but the admin adds or voids a record about themselves (no approving your own leave or
--     fixing your own late);
--   * the bookkeeper sees everyone's times and flags, never the selfies, GPS or face scores
--     (biometric data stays with the admin, who also keeps the photo review and face resets).

create function public.can_manage_attendance() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin') or public.has_role('bookkeeper')
$$;

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  work_date date not null,
  kind text not null check (kind in ('absent', 'leave', 'correction', 'remark')),
  leave_type text check (leave_type in ('vacation', 'sick', 'emergency', 'bereavement', 'maternity_paternity', 'unpaid', 'other')),
  paid boolean,
  punch_kind public.punch_kind,
  at timestamptz,
  remarks text not null default '' check (length(remarks) <= 1000),
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.profiles (id),
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 1 and 300),
  check ((voided_at is null) = (void_reason is null)),
  check ((kind = 'leave') = (leave_type is not null and paid is not null)),
  check (kind = 'leave' or (leave_type is null and paid is null)),
  check ((kind = 'correction') = (punch_kind is not null and at is not null)),
  check (kind <> 'correction' or ((at at time zone 'Asia/Manila')::date = work_date and length(btrim(remarks)) > 0)),
  check (kind <> 'remark' or length(btrim(remarks)) > 0)
);
-- One standing for the day (absent or on leave), one correction per punch, at a time.
create unique index attendance_records_one_status on public.attendance_records (user_id, work_date)
  where voided_at is null and kind in ('absent', 'leave');
create unique index attendance_records_one_correction on public.attendance_records (user_id, work_date, punch_kind)
  where voided_at is null and kind = 'correction';
create index attendance_records_by_day on public.attendance_records (work_date, user_id) where voided_at is null;

alter table public.attendance_records enable row level security;
create policy "attendance records: the person, the admin and the bookkeeper read" on public.attendance_records for select
  using (user_id = auth.uid() or public.can_manage_attendance());
revoke insert, update, delete on public.attendance_records from anon, authenticated;

-- Never changed, except to void it once.
create function public.attendance_record_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;   -- with the person's account, nothing else
    raise exception 'Attendance records are kept: void it instead.' using errcode = '42501';
  end if;
  if old.voided_at is not null then raise exception 'A voided record can''t be changed.' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason']) is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
    raise exception 'Attendance records aren''t edited: void it and add the right one.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger attendance_record_guard before update or delete on public.attendance_records
  for each row execute function public.attendance_record_guard();

create function public.attendance_record_json(r public.attendance_records) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'user_id', r.user_id, 'date', r.work_date, 'kind', r.kind, 'leave_type', r.leave_type,
    'paid', r.paid, 'punch_kind', r.punch_kind, 'at', r.at, 'remarks', r.remarks, 'created_at', r.created_at,
    'by', coalesce((select full_name from public.profiles where id = r.created_by), ''))
$$;

-- p: {user_id, date, kind, leave_type, paid, punch_kind, time ("HH:MM", Manila), remarks}
create function public.attendance_record_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid := nullif(p ->> 'user_id', '')::uuid; v_date date := nullif(p ->> 'date', '')::date;
  v_kind text := coalesce(p ->> 'kind', ''); v_at timestamptz; r public.attendance_records;
begin
  if not public.can_manage_attendance() then raise exception 'Attendance records are for the admin and the bookkeeper.' using errcode = '42501'; end if;
  if v_user is null or v_date is null then raise exception 'Choose the person and the day.' using errcode = '22023'; end if;
  if v_user = auth.uid() and not public.is_admin() then
    raise exception 'Only the admin records your own attendance.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = v_user) then raise exception 'No such person.' using errcode = 'P0002'; end if;
  if v_date > (now() at time zone 'Asia/Manila')::date + 60 then raise exception 'That day is too far ahead.' using errcode = '22023'; end if;
  if v_kind = 'absent' and exists (select 1 from public.attendance_punches where user_id = v_user and work_date = v_date) then
    raise exception 'They clocked in that day: record a correction or leave, not an absence.' using errcode = '22023';
  end if;
  if v_kind = 'correction' then
    if coalesce(p ->> 'time', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'Give the corrected time as HH:MM.' using errcode = '22023'; end if;
    v_at := ((v_date::text || ' ' || (p ->> 'time'))::timestamp at time zone 'Asia/Manila');
  end if;
  begin
    insert into public.attendance_records (user_id, work_date, kind, leave_type, paid, punch_kind, at, remarks)
    values (v_user, v_date, v_kind,
      case when v_kind = 'leave' then nullif(p ->> 'leave_type', '') end,
      case when v_kind = 'leave' then coalesce(nullif(p ->> 'paid', '')::boolean, false) end,
      case when v_kind = 'correction' then (p ->> 'punch_kind')::public.punch_kind end,
      v_at, left(btrim(coalesce(p ->> 'remarks', '')), 1000))
    returning * into r;
  exception
    when unique_violation then
      raise exception '%', case when v_kind = 'correction' then 'That punch already has a correction: void it first.'
        else 'That day already has an absence or leave: void it first.' end using errcode = '23505';
    when check_violation then
      raise exception '%', case when v_kind = 'correction' then 'A correction needs the punch, the time and the reason.'
        when v_kind = 'leave' then 'Choose the kind of leave.' when v_kind = 'remark' then 'Write the remark.'
        else 'Choose absent, leave, correction or remark.' end using errcode = '23514';
  end;
  return public.attendance_record_json(r);
end $$;

create function public.attendance_record_void(p_id uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
declare r public.attendance_records;
begin
  if not public.can_manage_attendance() then raise exception 'Attendance records are for the admin and the bookkeeper.' using errcode = '42501'; end if;
  select * into r from public.attendance_records where id = p_id;
  if not found or r.voided_at is not null then raise exception 'That record isn''t open any more.' using errcode = 'P0002'; end if;
  if r.user_id = auth.uid() and not public.is_admin() then raise exception 'Only the admin records your own attendance.' using errcode = '42501'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'Say why it''s void.' using errcode = '23514'; end if;
  update public.attendance_records set voided_at = now(), voided_by = auth.uid(), void_reason = left(btrim(p_reason), 300) where id = p_id;
  return true;
end $$;

-- ---------------------------------------------- the day and the month ----

-- The team's day, for the admin and the bookkeeper. Only the admin gets the photos, GPS and face
-- scores (punch_json's full form); both get times, flags and the day's records.
create or replace function public.attendance_day(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_admin boolean := public.is_admin();
begin
  if not public.can_manage_attendance() then raise exception 'Only the admin and the bookkeeper see everyone''s attendance.' using errcode = '42501'; end if;
  return jsonb_build_object('date', p_date, 'threshold', public.face_match_threshold(), 'can_review', v_admin,
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'id', pr.id, 'name', pr.full_name, 'role', pr.role, 'enrolled', pr.face_descriptor is not null,
        'face_selfie_path', case when v_admin then pr.face_selfie_path end, 'face_enrolled_at', pr.face_enrolled_at,
        'consent_at', pr.attendance_consent_at, 'self', pr.id = auth.uid(),
        'punches', coalesce((select jsonb_agg(public.punch_json(p, v_admin) order by p.punched_at)
          from public.attendance_punches p where p.user_id = pr.id and p.work_date = p_date), '[]'::jsonb),
        'records', coalesce((select jsonb_agg(public.attendance_record_json(r) order by r.created_at)
          from public.attendance_records r where r.user_id = pr.id and r.work_date = p_date and r.voided_at is null), '[]'::jsonb))
        order by lower(pr.full_name))
      from public.profiles pr where pr.active), '[]'::jsonb));
end $$;

-- The month, per person, for payroll. Each punch counts at its corrected time when it has a
-- correction. Late / left early use the same clock as prepare_punch(): in after 8:00 or 13:00, out
-- before 12:00 or 17:00. Unaccounted = a working day (Monday to Saturday, not a holiday on the
-- calendar) already over, since the account was made, with no punch, no correction, no absence and no
-- leave: the days payroll has to ask about.
create or replace function public.attendance_month(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a date := date_trunc('month', p_month)::date; z date := (date_trunc('month', p_month) + interval '1 month')::date;
  today date := (now() at time zone 'Asia/Manila')::date;
begin
  if not public.can_manage_attendance() then raise exception 'Only the admin and the bookkeeper see everyone''s attendance.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.full_name, 'role', pr.role,
      'days', coalesce(s.days, 0), 'lates', coalesce(s.lates, 0), 'early_outs', coalesce(s.early_outs, 0),
      'incomplete_days', coalesce(s.incomplete, 0), 'hours', coalesce(s.hours, 0), 'to_review', coalesce(s.to_review, 0),
      'absences', coalesce(rc.absences, 0), 'leave_paid', coalesce(rc.leave_paid, 0), 'leave_unpaid', coalesce(rc.leave_unpaid, 0),
      'corrections', coalesce(rc.corrections, 0), 'unaccounted', coalesce(u.n, 0))
      order by lower(pr.full_name))
    from public.profiles pr
    left join lateral (
      select count(*) as days, sum(d.lates) as lates, sum(d.early_outs) as early_outs, sum(d.to_review) as to_review,
        count(*) filter (where d.n < 4) as incomplete, round(sum(d.secs) / 3600.0, 2) as hours
      from (
        select e.work_date, count(*) as n,
          count(*) filter (where (e.kind = 'am_in' and e.t > time '08:00') or (e.kind = 'pm_in' and e.t > time '13:00')) as lates,
          count(*) filter (where (e.kind = 'am_out' and e.t < time '12:00') or (e.kind = 'pm_out' and e.t < time '17:00')) as early_outs,
          sum(e.to_review) as to_review,
          coalesce(extract(epoch from max(e.at) filter (where e.kind = 'am_out') - max(e.at) filter (where e.kind = 'am_in')), 0)
          + coalesce(extract(epoch from max(e.at) filter (where e.kind = 'pm_out') - max(e.at) filter (where e.kind = 'pm_in')), 0) as secs
        from (
          -- each punch slot at its effective time: the correction if there is one, else the punch
          select k.work_date, k.kind, coalesce(c.at, p.punched_at) as at, (coalesce(c.at, p.punched_at) at time zone 'Asia/Manila')::time as t,
            case when c.id is null and p.reviewed_at is null and (p.flags && array['face_mismatch', 'no_face_check', 'low_gps_accuracy']) then 1 else 0 end as to_review
          from (select work_date, kind from public.attendance_punches where user_id = pr.id and work_date >= a and work_date < z
                union
                select work_date, punch_kind from public.attendance_records
                where user_id = pr.id and kind = 'correction' and voided_at is null and work_date >= a and work_date < z) k
          left join public.attendance_punches p on p.user_id = pr.id and p.work_date = k.work_date and p.kind = k.kind
          left join public.attendance_records c on c.user_id = pr.id and c.work_date = k.work_date and c.punch_kind = k.kind
            and c.kind = 'correction' and c.voided_at is null) e
        group by e.work_date) d
    ) s on true
    left join lateral (
      select count(*) filter (where kind = 'absent') as absences,
        count(*) filter (where kind = 'leave' and paid) as leave_paid, count(*) filter (where kind = 'leave' and not paid) as leave_unpaid,
        count(*) filter (where kind = 'correction') as corrections
      from public.attendance_records where user_id = pr.id and voided_at is null and work_date >= a and work_date < z
    ) rc on true
    left join lateral (
      select count(*) as n from generate_series(greatest(a, (pr.created_at at time zone 'Asia/Manila')::date), least(z - 1, today - 1), interval '1 day') g(day)
      where extract(isodow from g.day) <> 7
        and not exists (select 1 from public.project_events ev where ev.kind = 'holiday'
          and g.day::date between (ev.starts_at at time zone 'Asia/Manila')::date and (coalesce(ev.ends_at, ev.starts_at) at time zone 'Asia/Manila')::date)
        and not exists (select 1 from public.attendance_punches p where p.user_id = pr.id and p.work_date = g.day::date)
        and not exists (select 1 from public.attendance_records r where r.user_id = pr.id and r.work_date = g.day::date and r.voided_at is null
          and r.kind in ('absent', 'leave', 'correction'))
    ) u on true
    where pr.active), '[]'::jsonb);
end $$;

-- The person's own page shows what was recorded about them.
create or replace function public.attendance_me() returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare me public.profiles; d date := (now() at time zone 'Asia/Manila')::date;
begin
  select * into me from public.profiles where id = auth.uid() and active;
  if not found then raise exception 'This account is not active yet.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'id', me.id, 'role', me.role, 'name', me.full_name, 'consent_at', me.attendance_consent_at, 'enrolled', me.face_descriptor is not null,
    'today', d, 'office', public.office_site(),
    'punches', coalesce((select jsonb_agg(public.punch_json(p, false) order by p.punched_at)
      from public.attendance_punches p where p.user_id = me.id and p.work_date = d), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(x.day order by x.work_date desc) from (
      select p.work_date, jsonb_build_object('date', p.work_date, 'punches', jsonb_agg(public.punch_json(p, false) order by p.punched_at)) as day
      from public.attendance_punches p where p.user_id = me.id and p.work_date between d - 14 and d - 1 group by p.work_date) x), '[]'::jsonb),
    -- Leave, absences, corrections and remarks the admin or bookkeeper recorded for them (last 31 days).
    'records', coalesce((select jsonb_agg(public.attendance_record_json(r) order by r.work_date desc, r.created_at)
      from public.attendance_records r where r.user_id = me.id and r.voided_at is null and r.work_date between d - 31 and d), '[]'::jsonb));
end $$;

revoke execute on function public.can_manage_attendance(), public.attendance_record_add(jsonb), public.attendance_record_void(uuid, text),
  public.attendance_record_json(public.attendance_records) from public, anon;
grant execute on function public.can_manage_attendance(), public.attendance_record_add(jsonb), public.attendance_record_void(uuid, text),
  public.attendance_record_json(public.attendance_records) to authenticated;
revoke execute on function public.attendance_record_guard() from public, anon, authenticated;

-- ------------------------------------------------------------ activity log ----

create trigger zz_audit after insert or update or delete on public.attendance_records
  for each row execute function public.audit_row('user_id', 'work_date', 'kind');

create or replace function public.audit_module(p_table text, p_row jsonb) returns text
language sql immutable set search_path = public as $$
  select case
    when p_table = 'tracker_docs' then case p_row ->> 'collection'
      when 'projects' then 'Projects' when 'expenses' then 'Projects'
      when 'companyFuel' then 'Company fuel' when 'companyVehicles' then 'Company fuel'
      when 'procurementJobs' then 'Procurement' when 'procurement' then 'Procurement' else 'Projects' end
    when p_table in ('project_stages', 'project_events', 'project_files', 'project_assignments') then 'Schedule'
    when p_table in ('stage_submissions', 'approval_rules') then 'Approvals'
    when p_table in ('company_profile', 'company_documents') then 'Company'
    when p_table in ('leads', 'lead_activity') then 'Leads'
    when p_table like 'acct\_%' then 'Accounting'
    when p_table like 'inventory\_%' then 'Inventory'
    when p_table in ('attendance_punches', 'attendance_records') then 'Attendance'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;
