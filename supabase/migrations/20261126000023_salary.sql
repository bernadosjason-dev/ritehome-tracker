-- v3.3: daily salary beside attendance (the owner's brief of 2026-11-13, first half). Rates with a
-- history, the payroll settings, holiday types, overtime the admin approves, and every day's estimated
-- earnings computed from attendance. Cutoffs, approval, payslips and statutory deductions are v3.4.
--
-- The owner's decisions (MEMORY.md, 2026-11-13):
--   * rates are set by the admin and the bookkeeper (nobody but the admin sets their own);
--   * no late grace period: lateness and undertime are deducted per minute, never a whole day;
--   * the admin approves overtime day by day, in 30-minute blocks after 5 PM;
--   * pay is released on the 15th and the 30th (month end in February); a Sunday or a holiday moves
--     it to the working day before ('earlier', DOLE's rule) or after ('later'), as far as it takes.
-- Not decided, so defaults until the accountant signs off: divisor 313 (a monthly rate's daily
-- equivalent = monthly x 12 / 313), and the premium rates below (the Labor Code's).
--
-- How a day is paid (pay_day_calc). Minute rate = daily rate / 480 (8:00-12:00, 13:00-17:00).
--   Ordinary working day, present: the daily rate, less the minute rate for every minute not worked
--     inside the schedule (late, undertime, a half with no in/out pair). A half with only one punch is
--     not paid ("incomplete"). Paid leave: the daily rate. Absent, unpaid leave, no record: nothing.
--   Rest day (Sunday) worked: minutes worked x minute rate x 1.30.
--   Regular holiday: the daily rate x 1.00 when the person was present or on paid leave on the
--     working day before; minutes worked add (2.00 - 1.00), or 2.00 in full without that day. On a
--     Sunday, 2.60 instead of 2.00.
--   Special day: unpaid unless worked (x 1.30; x 1.50 on a Sunday).
--   Overtime (approved minutes): minute rate x 1.25; on a rest day or holiday, its day rate x 1.30.
--   The daily allowance is added on any day with time worked, or paid leave.
-- Every figure is an estimate until a cutoff is approved (v3.4).

-- ------------------------------------------------------------- settings ----

create table public.payroll_settings (
  id int primary key default 1 check (id = 1),
  divisor numeric(6,2) not null default 313 check (divisor between 200 and 366),
  ot_rate numeric(4,2) not null default 1.25 check (ot_rate between 1 and 5),
  ot_rest_holiday_rate numeric(4,2) not null default 1.30 check (ot_rest_holiday_rate between 1 and 5),
  rest_day_worked numeric(4,2) not null default 1.30 check (rest_day_worked between 1 and 5),
  special_worked numeric(4,2) not null default 1.30 check (special_worked between 1 and 5),
  special_rest_worked numeric(4,2) not null default 1.50 check (special_rest_worked between 1 and 5),
  special_unworked numeric(4,2) not null default 0 check (special_unworked between 0 and 1),
  regular_worked numeric(4,2) not null default 2.00 check (regular_worked between 1 and 5),
  regular_rest_worked numeric(4,2) not null default 2.60 check (regular_rest_worked between 1 and 5),
  regular_unworked numeric(4,2) not null default 1.00 check (regular_unworked between 0 and 1),
  payday_rule text not null default 'earlier' check (payday_rule in ('earlier', 'later')),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);
insert into public.payroll_settings (id) values (1);
alter table public.payroll_settings enable row level security;
create policy "payroll settings: admin and bookkeeper read" on public.payroll_settings for select using (public.can_keep_books());
revoke insert, update, delete on public.payroll_settings from anon, authenticated;

-- ---------------------------------------------------------------- rates ----

-- A rate is never changed or deleted: a new row with its own effective date replaces it from that
-- day on, and a mistake is fixed by adding the right one with the same date (the newest row for a
-- date wins). So every earlier day keeps the rate it was worked at.
create table public.salary_rates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  effective_from date not null check (effective_from >= date '2020-01-01'),
  salary_type text not null check (salary_type in ('daily', 'monthly')),
  rate numeric(12,2) not null check (rate > 0 and rate <= 1000000),
  daily_allowance numeric(10,2) not null default 0 check (daily_allowance between 0 and 100000),
  employment_type text not null default 'regular'
    check (employment_type in ('regular', 'probationary', 'contractual', 'project_based', 'part_time')),
  notes text not null default '' check (length(notes) <= 500),
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default clock_timestamp()
);
create index salary_rates_current on public.salary_rates (user_id, effective_from desc, created_at desc);
alter table public.salary_rates enable row level security;
create policy "salary rates: the person, the admin and the bookkeeper read" on public.salary_rates for select
  using (user_id = auth.uid() or public.can_keep_books());
revoke insert, update, delete on public.salary_rates from anon, authenticated;

create function public.salary_rate_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;   -- only with the person's account
  raise exception 'Rates are kept: add a new rate with its effective date instead.' using errcode = '42501';
end $$;
create trigger salary_rate_guard before update or delete on public.salary_rates
  for each row execute function public.salary_rate_guard();

-- The rate on a day: the newest row effective on or before it.
create function public.salary_rate_on(p_user uuid, p_date date) returns public.salary_rates
language sql stable security definer set search_path = public as $$
  select * from public.salary_rates where user_id = p_user and effective_from <= p_date
  order by effective_from desc, created_at desc limit 1
$$;

create function public.salary_rate_json(r public.salary_rates) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when r.id is null then null else jsonb_build_object('id', r.id, 'user_id', r.user_id, 'effective_from', r.effective_from,
    'salary_type', r.salary_type, 'rate', r.rate, 'daily_allowance', r.daily_allowance, 'employment_type', r.employment_type,
    'daily_equivalent', case r.salary_type when 'daily' then r.rate
      else round(r.rate * 12 / (select divisor from public.payroll_settings where id = 1), 2) end,
    'notes', r.notes, 'created_at', r.created_at,
    'by', coalesce((select full_name from public.profiles where id = r.created_by), '')) end
$$;

-- p: {user_id, effective_from, salary_type, rate, daily_allowance, employment_type, notes}
create function public.salary_rate_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid := nullif(p ->> 'user_id', '')::uuid; r public.salary_rates;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper set salaries.' using errcode = '42501'; end if;
  if v_user is null then raise exception 'Choose the person.' using errcode = '22023'; end if;
  if v_user = auth.uid() and not public.is_admin() then raise exception 'Only the admin sets your own salary.' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = v_user) then raise exception 'No such person.' using errcode = 'P0002'; end if;
  if coalesce(p ->> 'effective_from', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Give the date the rate starts.' using errcode = '22023'; end if;
  if coalesce(p ->> 'rate', '') !~ '^\d+(\.\d{1,2})?$' or coalesce(p ->> 'daily_allowance', '0') !~ '^\d+(\.\d{1,2})?$' then
    raise exception 'Amounts are pesos with up to two decimals.' using errcode = '22023';
  end if;
  begin
    insert into public.salary_rates (user_id, effective_from, salary_type, rate, daily_allowance, employment_type, notes)
    values (v_user, (p ->> 'effective_from')::date, p ->> 'salary_type', (p ->> 'rate')::numeric,
      coalesce(nullif(p ->> 'daily_allowance', ''), '0')::numeric, coalesce(nullif(p ->> 'employment_type', ''), 'regular'),
      left(btrim(coalesce(p ->> 'notes', '')), 500))
    returning * into r;
  exception when check_violation or not_null_violation then
    raise exception 'Check the rate: daily or monthly, more than zero, a start date from 2020, and a known employment type.' using errcode = '23514';
  end;
  return public.salary_rate_json(r);
end $$;

-- Everyone's current rate and history (admin and bookkeeper).
create function public.salary_rates_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper see salaries.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.full_name, 'role', pr.role, 'active', pr.active,
      'self', pr.id = auth.uid(),
      'current', public.salary_rate_json(public.salary_rate_on(pr.id, (now() at time zone 'Asia/Manila')::date)),
      'history', coalesce((select jsonb_agg(public.salary_rate_json(r) order by r.effective_from desc, r.created_at desc)
        from public.salary_rates r where r.user_id = pr.id), '[]'::jsonb))
      order by pr.active desc, lower(pr.full_name))
    from public.profiles pr where pr.active or exists (select 1 from public.salary_rates r where r.user_id = pr.id)), '[]'::jsonb);
end $$;

create function public.payroll_settings_get() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper see payroll settings.' using errcode = '42501'; end if;
  return (select to_jsonb(s) - 'updated_by' || jsonb_build_object('can_edit', public.is_admin()) from public.payroll_settings s where id = 1);
end $$;

-- Only the admin changes how pay is computed. p: any of the settings' columns.
create function public.payroll_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.payroll_settings;
begin
  if not public.is_admin() then raise exception 'Only the admin changes the payroll settings.' using errcode = '42501'; end if;
  select * into s from public.payroll_settings where id = 1;
  s := jsonb_populate_record(s, p - array['id', 'updated_by', 'updated_at']);
  begin
    update public.payroll_settings set divisor = s.divisor, ot_rate = s.ot_rate, ot_rest_holiday_rate = s.ot_rest_holiday_rate,
      rest_day_worked = s.rest_day_worked, special_worked = s.special_worked, special_rest_worked = s.special_rest_worked,
      special_unworked = s.special_unworked, regular_worked = s.regular_worked, regular_rest_worked = s.regular_rest_worked,
      regular_unworked = s.regular_unworked, payday_rule = s.payday_rule, updated_by = auth.uid(), updated_at = now()
    where id = 1;
  exception when check_violation or not_null_violation then
    raise exception 'That setting is outside what the law allows here: check the rates and the payday rule.' using errcode = '23514';
  end;
  return public.payroll_settings_get();
end $$;

-- ------------------------------------------------------------- holidays ----

-- A holiday on the calendar is regular (the default: Christmas, Bonifacio Day...) or special
-- non-working. Pay follows the type.
alter table public.project_events add column holiday_type text constraint project_events_holiday_type_check
  check (holiday_type is null or (holiday_type in ('regular', 'special') and kind = 'holiday'));

create or replace function public.event_save(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_type text := case when p ->> 'kind' = 'holiday' then coalesce(nullif(p ->> 'holiday_type', ''), 'regular') end;
begin
  if not public.is_admin() then raise exception 'Only an admin can add or change events.' using errcode = '42501'; end if;
  if v_id is null then
    insert into public.project_events (project_id, kind, title, starts_at, ends_at, notes, holiday_type)
    values (nullif(p ->> 'project_id', ''), p ->> 'kind', btrim(coalesce(p ->> 'title', '')),
            (p ->> 'starts_at')::timestamptz, coalesce(nullif(p ->> 'ends_at', ''), p ->> 'starts_at')::timestamptz,
            btrim(coalesce(p ->> 'notes', '')), v_type)
    returning id into v_id;
    return v_id;
  end if;
  update public.project_events set
    project_id = nullif(p ->> 'project_id', ''), kind = p ->> 'kind', title = btrim(coalesce(p ->> 'title', '')),
    starts_at = (p ->> 'starts_at')::timestamptz,
    ends_at = coalesce(nullif(p ->> 'ends_at', ''), p ->> 'starts_at')::timestamptz,
    notes = btrim(coalesce(p ->> 'notes', '')), holiday_type = v_type
  where id = v_id;
  if not found then raise exception 'No event %.', v_id using errcode = 'P0002'; end if;
  return v_id;
end $$;

-- 'regular', 'special' or null. A day with both counts as regular.
create function public.holiday_on(p_date date) returns text
language sql stable security definer set search_path = public as $$
  select case when bool_or(coalesce(holiday_type, 'regular') = 'regular') then 'regular' when count(*) > 0 then 'special' end
  from public.project_events
  where kind = 'holiday' and p_date between (starts_at at time zone 'Asia/Manila')::date and (ends_at at time zone 'Asia/Manila')::date
$$;

-- The cutoff a day belongs to and its release date: 1-15 paid on the 15th, 16-end on the 30th (or
-- the month's last day when shorter), moved off Sundays and holidays by the payday rule.
create function public.pay_period(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a date; z date; d date; step int;
  last date := (date_trunc('month', p_date) + interval '1 month - 1 day')::date;
begin
  if extract(day from p_date) <= 15 then a := date_trunc('month', p_date)::date; z := a + 14; d := z;
  else a := date_trunc('month', p_date)::date + 15; z := last; d := least(date_trunc('month', p_date)::date + 29, last); end if;
  step := case when (select payday_rule from public.payroll_settings where id = 1) = 'later' then 1 else -1 end;
  while extract(isodow from d) = 7 or public.holiday_on(d) is not null loop d := d + step; end loop;
  return jsonb_build_object('start', a, 'end', z, 'release', d);
end $$;

-- ------------------------------------------------------------- overtime ----

alter table public.attendance_records add column minutes int;
alter table public.attendance_records drop constraint attendance_records_kind_check;
alter table public.attendance_records add constraint attendance_records_kind_check
  check (kind in ('absent', 'leave', 'correction', 'remark', 'overtime'));
alter table public.attendance_records add constraint attendance_records_overtime_check
  check ((kind = 'overtime') = (minutes is not null) and (minutes is null or (minutes between 30 and 720 and minutes % 30 = 0)));
create unique index attendance_records_one_overtime on public.attendance_records (user_id, work_date)
  where voided_at is null and kind = 'overtime';

-- A punch slot's effective time on a day, in minutes after midnight (Manila): the correction if
-- there is one, else the punch. Seconds are dropped (08:00:45 is 08:00).
create function public.punch_minutes(p_user uuid, p_date date, p_kind public.punch_kind) returns int
language sql stable security definer set search_path = public as $$
  select floor(extract(epoch from (coalesce(
      (select at from public.attendance_records where user_id = p_user and work_date = p_date and kind = 'correction'
        and punch_kind = p_kind and voided_at is null limit 1),
      (select punched_at from public.attendance_punches where user_id = p_user and work_date = p_date and kind = p_kind
        order by punched_at limit 1)) at time zone 'Asia/Manila')::time) / 60)::int
$$;

create or replace function public.attendance_record_json(r public.attendance_records) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'user_id', r.user_id, 'date', r.work_date, 'kind', r.kind, 'leave_type', r.leave_type,
    'paid', r.paid, 'punch_kind', r.punch_kind, 'at', r.at, 'minutes', r.minutes, 'remarks', r.remarks, 'created_at', r.created_at,
    'by', coalesce((select full_name from public.profiles where id = r.created_by), ''))
$$;

-- p: {user_id, date, kind, leave_type, paid, punch_kind, time ("HH:MM", Manila), minutes, remarks}
create or replace function public.attendance_record_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid := nullif(p ->> 'user_id', '')::uuid; v_date date := nullif(p ->> 'date', '')::date;
  v_kind text := coalesce(p ->> 'kind', ''); v_at timestamptz; v_min int; v_out int; r public.attendance_records;
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
  if v_kind = 'overtime' then
    -- The owner approves overtime himself, day by day, in 30-minute blocks after 5 PM.
    if not public.is_admin() then raise exception 'Only the admin approves overtime.' using errcode = '42501'; end if;
    if coalesce(p ->> 'minutes', '') !~ '^\d{1,3}$' or (p ->> 'minutes')::int < 30 or (p ->> 'minutes')::int % 30 <> 0 then
      raise exception 'Overtime is approved in 30-minute blocks.' using errcode = '23514';
    end if;
    v_min := (p ->> 'minutes')::int;
    v_out := public.punch_minutes(v_user, v_date, 'pm_out');
    if v_out is null then raise exception 'There''s no clock-out that day to approve overtime against.' using errcode = '22023'; end if;
    if v_min > greatest(v_out - 1020, 0) / 30 * 30 then
      raise exception 'They clocked out at %: at most % minutes of overtime.', to_char(time '00:00' + v_out * interval '1 minute', 'HH24:MI'),
        greatest(v_out - 1020, 0) / 30 * 30 using errcode = '22023';
    end if;
  end if;
  begin
    insert into public.attendance_records (user_id, work_date, kind, leave_type, paid, punch_kind, at, minutes, remarks)
    values (v_user, v_date, v_kind,
      case when v_kind = 'leave' then nullif(p ->> 'leave_type', '') end,
      case when v_kind = 'leave' then coalesce(nullif(p ->> 'paid', '')::boolean, false) end,
      case when v_kind = 'correction' then (p ->> 'punch_kind')::public.punch_kind end,
      v_at, v_min, left(btrim(coalesce(p ->> 'remarks', '')), 1000))
    returning * into r;
  exception
    when unique_violation then
      raise exception '%', case when v_kind = 'correction' then 'That punch already has a correction: void it first.'
        when v_kind = 'overtime' then 'That day already has approved overtime: void it first.'
        else 'That day already has an absence or leave: void it first.' end using errcode = '23505';
    when check_violation then
      raise exception '%', case when v_kind = 'correction' then 'A correction needs the punch, the time and the reason.'
        when v_kind = 'leave' then 'Choose the kind of leave.' when v_kind = 'remark' then 'Write the remark.'
        when v_kind = 'overtime' then 'Overtime is approved in 30-minute blocks.'
        else 'Choose absent, leave, correction, overtime or remark.' end using errcode = '23514';
  end;
  return public.attendance_record_json(r);
end $$;

-- ------------------------------------------------------------ the day's pay ----

create function public.pay_day_calc(p_user uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  st public.payroll_settings; r public.salary_rates;
  today date := (now() at time zone 'Asia/Manila')::date;
  v_hol text := public.holiday_on(p_date);
  v_rest boolean := extract(isodow from p_date) = 7;
  ai int := public.punch_minutes(p_user, p_date, 'am_in'); ao int := public.punch_minutes(p_user, p_date, 'am_out');
  pi int := public.punch_minutes(p_user, p_date, 'pm_in'); po int := public.punch_minutes(p_user, p_date, 'pm_out');
  w int := 0; v_late int := 0; v_under int := 0; v_unworked int := 0; v_incomplete boolean := false; w_half int; l_half int;
  v_leave public.attendance_records; v_ot int; v_status text; v_daily numeric; v_min numeric;
  v_basic numeric := 0; v_ded numeric := 0; v_prem numeric := 0; v_allow numeric := 0; v_otpay numeric := 0;
  v_mult numeric := 1; v_base numeric := 0; v_ot_mult numeric; v_prev date; v_eligible boolean := null;
begin
  select * into st from public.payroll_settings where id = 1;
  r := public.salary_rate_on(p_user, p_date);
  -- Morning 8:00-12:00 (480-720), afternoon 13:00-17:00 (780-1020): a half is paid only with both punches.
  if ai is not null and ao is not null then
    w_half := greatest(0, least(ao, 720) - greatest(ai, 480)); l_half := least(greatest(ai - 480, 0), 240);
    w := w + w_half; v_late := v_late + l_half; v_under := v_under + greatest(240 - w_half - l_half, 0);
  else v_unworked := v_unworked + 240; v_incomplete := v_incomplete or ai is not null or ao is not null; end if;
  if pi is not null and po is not null then
    w_half := greatest(0, least(po, 1020) - greatest(pi, 780)); l_half := least(greatest(pi - 780, 0), 240);
    w := w + w_half; v_late := v_late + l_half; v_under := v_under + greatest(240 - w_half - l_half, 0);
  else v_unworked := v_unworked + 240; v_incomplete := v_incomplete or pi is not null or po is not null; end if;

  select * into v_leave from public.attendance_records where user_id = p_user and work_date = p_date and voided_at is null
    and kind in ('absent', 'leave') limit 1;
  select coalesce(sum(minutes), 0) into v_ot from public.attendance_records where user_id = p_user and work_date = p_date
    and voided_at is null and kind = 'overtime';

  v_status := case
    when coalesce(ai, ao, pi, po) is not null then case when v_incomplete then 'incomplete' when p_date = today and po is null then 'in_progress' else 'present' end
    when v_leave.kind = 'leave' then case when v_leave.paid then 'leave_paid' else 'leave_unpaid' end
    when v_leave.kind = 'absent' then 'absent'
    when v_hol is not null then 'holiday'
    when v_rest then 'rest_day'
    when p_date > today then 'scheduled'
    when p_date = today then 'not_yet'
    else 'unaccounted' end;

  if r.id is null then
    return jsonb_build_object('user_id', p_user, 'date', p_date, 'status', v_status, 'holiday', v_hol, 'rest_day', v_rest, 'rate', null,
      'worked_minutes', w, 'late_minutes', v_late, 'undertime_minutes', v_under, 'unworked_minutes', v_unworked, 'overtime_minutes', v_ot,
      'daily_rate', 0, 'basic', 0, 'deductions', 0, 'premium', 0, 'allowance', 0, 'overtime_pay', 0, 'total', 0);
  end if;
  v_daily := case r.salary_type when 'daily' then r.rate else round(r.rate * 12 / st.divisor, 2) end;
  v_min := v_daily / 480;

  if v_hol is null and not v_rest then
    -- An ordinary working day: the day, less each minute not worked.
    if v_status in ('present', 'incomplete', 'in_progress') then v_basic := v_daily; v_ded := v_min * (480 - w);
    elsif v_status = 'leave_paid' then v_basic := v_daily; end if;
    v_ot_mult := st.ot_rate;
  else
    v_mult := case when v_hol = 'regular' and v_rest then st.regular_rest_worked when v_hol = 'regular' then st.regular_worked
      when v_hol = 'special' and v_rest then st.special_rest_worked when v_hol = 'special' then st.special_worked else st.rest_day_worked end;
    v_base := case v_hol when 'regular' then st.regular_unworked when 'special' then st.special_unworked else 0 end;
    if v_base > 0 then
      -- Holiday pay needs the working day before (not a Sunday, not a holiday) present or on paid leave.
      v_prev := p_date - 1;
      while (extract(isodow from v_prev) = 7 or public.holiday_on(v_prev) is not null) and v_prev > p_date - 15 loop v_prev := v_prev - 1; end loop;
      v_eligible := exists (select 1 from public.attendance_punches where user_id = p_user and work_date = v_prev)
        or exists (select 1 from public.attendance_records where user_id = p_user and work_date = v_prev and voided_at is null
          and (kind = 'correction' or (kind = 'leave' and paid)));
      if v_eligible then v_basic := v_daily * v_base; v_prem := v_min * w * (v_mult - v_base);
      else v_prem := v_min * w * v_mult; end if;
    else v_prem := v_min * w * v_mult; end if;
    v_ot_mult := v_mult * st.ot_rest_holiday_rate;
  end if;
  if w > 0 or v_status = 'leave_paid' and v_hol is null and not v_rest then v_allow := r.daily_allowance; end if;
  v_otpay := v_min * v_ot * v_ot_mult;

  v_basic := round(v_basic, 2); v_ded := round(v_ded, 2); v_prem := round(v_prem, 2); v_otpay := round(v_otpay, 2);
  return jsonb_build_object('user_id', p_user, 'date', p_date, 'status', v_status, 'holiday', v_hol, 'rest_day', v_rest,
    'holiday_pay_eligible', v_eligible, 'rate', public.salary_rate_json(r),
    'worked_minutes', w, 'late_minutes', case when v_hol is null and not v_rest then v_late else 0 end,
    'undertime_minutes', case when v_hol is null and not v_rest then v_under else 0 end,
    'unworked_minutes', case when v_hol is null and not v_rest and v_status in ('present', 'incomplete', 'in_progress') then v_unworked else 0 end,
    'overtime_minutes', v_ot, 'daily_rate', v_daily,
    'basic', v_basic, 'deductions', v_ded, 'premium', v_prem, 'allowance', v_allow, 'overtime_pay', v_otpay,
    'total', v_basic - v_ded + v_prem + v_allow + v_otpay);
end $$;

-- Every active person's days from p.from to p.to (at most 62 days), optionally one person. Admin and
-- bookkeeper.
create function public.pay_days(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a date := nullif(p ->> 'from', '')::date; z date := nullif(p ->> 'to', '')::date; v_user uuid := nullif(p ->> 'user_id', '')::uuid;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper see everyone''s pay.' using errcode = '42501'; end if;
  if a is null or z is null or z < a then raise exception 'Choose the days.' using errcode = '22023'; end if;
  if z - a > 61 then raise exception 'Up to 62 days at a time.' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(public.pay_day_calc(pr.id, g.d::date)
      || jsonb_build_object('name', pr.full_name, 'role', pr.role) order by lower(pr.full_name), g.d)
    from public.profiles pr cross join generate_series(a, z, interval '1 day') g(d)
    where pr.active and (v_user is null or pr.id = v_user)), '[]'::jsonb);
end $$;

-- The person's own: today's estimate, this cutoff so far, the release date, their rate.
create function public.pay_me() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Manila')::date; per jsonb := public.pay_period(d); v_days jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and active) then
    raise exception 'This account is not active yet.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(public.pay_day_calc(auth.uid(), g.d::date) order by g.d), '[]'::jsonb) into v_days
  from generate_series((per ->> 'start')::date, d, interval '1 day') g(d);
  return jsonb_build_object('today', d, 'period', per, 'rate', public.salary_rate_json(public.salary_rate_on(auth.uid(), d)),
    'days', v_days, 'to_date', (select coalesce(sum((x ->> 'total')::numeric), 0) from jsonb_array_elements(v_days) x));
end $$;

revoke execute on function public.salary_rate_on(uuid, date), public.salary_rate_json(public.salary_rates), public.pay_day_calc(uuid, date),
  public.punch_minutes(uuid, date, public.punch_kind), public.salary_rate_guard() from public, anon, authenticated;
revoke execute on function public.salary_rate_add(jsonb), public.salary_rates_list(), public.payroll_settings_get(),
  public.payroll_settings_save(jsonb), public.holiday_on(date), public.pay_period(date), public.pay_days(jsonb), public.pay_me() from public, anon;
grant execute on function public.salary_rate_add(jsonb), public.salary_rates_list(), public.payroll_settings_get(),
  public.payroll_settings_save(jsonb), public.holiday_on(date), public.pay_period(date), public.pay_days(jsonb), public.pay_me() to authenticated;

-- ------------------------------------------------------------ activity log ----

create trigger zz_audit after insert or update or delete on public.salary_rates
  for each row execute function public.audit_row('user_id', 'effective_from');
create trigger zz_audit after insert or update or delete on public.payroll_settings
  for each row execute function public.audit_row('id');

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
    when p_table in ('salary_rates', 'payroll_settings') then 'Payroll'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;
