-- v4.5: 13th-month pay (PD 851; the owner's brief of 2026-11-13, Part 2F). Coordinating agent TEAM_02-AGENT_02.
--
-- Checked 2026-11-14 (rule row 'thirteenth_month', pending the accountant):
--   * 1/12 of the total basic salary earned in the calendar year (Revised Guidelines on PD 851, 1987, No. 4(a));
--     resigned or terminated employees get it in proportion to their service (No. 6); paid on or before Dec 24.
--   * "Basic salary" excludes cost-of-living allowance, profit sharing, overtime, premiums, night differential, holiday
--     pay, cash for unused leave, and (Supreme Court: San Miguel v. Inciong, Honda v. Samahan) pay for sick, vacation
--     and maternity leave, unless company practice treats them as basic salary.
--   * Rank-and-file employees; managerial employees are not covered.
--   * 13th month and other benefits are tax-free up to 90,000 a year (NIRC 32(B)(7)(e) as amended by RA 10963).
--
-- How it is computed here (thirteenth_person):
--   earlier   = basic salary earned in the year before the portal's payroll (entered from the old payroll records,
--               each entry with a reference; void-only).
--   portal    = from approved or released payroll runs of the year: daily-paid, each ordinary working day actually
--               worked (its basic less late, undertime and missing minutes); holidays, rest days, leave, premiums,
--               overtime and allowances are left out. Monthly-paid: the run's basic pay (holidays are inside it).
--   projected = an estimate for the rest of the year after the last approved run: daily-paid, the daily rate for each
--               working day left (Mon-Sat, not a holiday); monthly-paid, half the monthly rate per cutoff left.
--   13th month to date = (earlier + portal) / 12; projected 13th month = (earlier + portal + projected) / 12.
-- A 13th-month run (prepare -> submit -> admin approves -> release recorded) pays the projected figure when prepared
-- before the year ends (the owner pays by Dec 24, before December is over); the to-date figure is kept beside it so
-- the accountant can true it up. Nobody's run is approved by an agent.

insert into public.statutory_rules (agency, code, name, params, salary_basis, max_basis, effective_from, source_title, source_url, verified_on, verified_by, notes) values
('DOLE', 'thirteenth_month', '13th-month pay: 1/12 of basic salary earned in the year; tax-free up to 90,000',
 '{"divisor":12,"tax_exempt_cap":90000,"excluded":["overtime","premiums","night differential","holiday pay","allowances and COLA","paid sick, vacation and maternity leave","cash for unused leave","profit sharing"]}',
 'Basic salary earned in the calendar year (days actually worked; monthly rate for monthly-paid)', 90000,
 '2018-01-01', 'Revised Guidelines on the Implementation of the 13th Month Pay Law (1987); NIRC Sec. 32(B)(7)(e) as amended by RA 10963 (TRAIN)',
 'https://www.lawphil.net/statutes/repacts/ra2017/ra_10963_2017.html', '2026-11-14',
 'Agent (RA 10963 text on lawphil; guideline wording and case law via laborlaw.ph citing DOLE-BWC Handbook p. 41)',
 'Leave pay is excluded per Supreme Court rulings unless company practice includes it: owner and accountant to confirm Ritehome''s practice. The 90,000 cap covers 13th month and other benefits together; other benefits are not tracked here yet.');

-- Who is covered: rank-and-file by default; the admin or bookkeeper marks managerial employees.
alter table public.employee_statutory add column rank_and_file boolean not null default true;

create or replace function public.employee_statutory_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid := nullif(p ->> 'user_id', '')::uuid; e public.employee_statutory;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper keep government numbers.' using errcode = '42501'; end if;
  if v_user is null or not exists (select 1 from public.profiles where id = v_user) then raise exception 'Choose the person.' using errcode = '22023'; end if;
  if v_user = auth.uid() and not public.is_admin() then raise exception 'Only the admin changes your own records.' using errcode = '42501'; end if;
  insert into public.employee_statutory (user_id) values (v_user) on conflict (user_id) do nothing;
  begin
    update public.employee_statutory set
      tin = case when p ? 'tin' then public.gov_number_format('tin', p ->> 'tin') else tin end,
      sss_no = case when p ? 'sss_no' then public.gov_number_format('sss', p ->> 'sss_no') else sss_no end,
      philhealth_no = case when p ? 'philhealth_no' then public.gov_number_format('philhealth', p ->> 'philhealth_no') else philhealth_no end,
      pagibig_no = case when p ? 'pagibig_no' then public.gov_number_format('pagibig', p ->> 'pagibig_no') else pagibig_no end,
      birth_date = case when p ? 'birth_date' then nullif(p ->> 'birth_date', '')::date else birth_date end,
      hired_on = case when p ? 'hired_on' then nullif(p ->> 'hired_on', '')::date else hired_on end,
      separated_on = case when p ? 'separated_on' then nullif(p ->> 'separated_on', '')::date else separated_on end,
      minimum_wage_earner = case when p ? 'minimum_wage_earner' then nullif(p ->> 'minimum_wage_earner', '')::boolean else minimum_wage_earner end,
      rank_and_file = case when p ? 'rank_and_file' then coalesce(nullif(p ->> 'rank_and_file', '')::boolean, true) else rank_and_file end,
      updated_by = auth.uid(), updated_at = now()
    where user_id = v_user returning * into e;
  exception when check_violation then
    raise exception 'Check the numbers: TIN 9 or 12 digits, SSS 10, PhilHealth 12, Pag-IBIG 12; dates in order.' using errcode = '23514';
  end;
  return to_jsonb(e) - 'updated_by';
end $$;

-- ------------------------------------------------------- earlier earnings ----

create table public.thirteenth_earlier (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  year int not null check (year between 2020 and 2100),
  amount numeric(12,2) not null check (amount > 0 and amount <= 10000000),
  reference text not null check (length(btrim(reference)) between 3 and 200),
  note text not null default '' check (length(note) <= 500),
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  voided_at timestamptz, voided_by uuid references public.profiles (id),
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 3 and 300),
  check ((voided_at is null) = (void_reason is null))
);
alter table public.thirteenth_earlier enable row level security;
create policy "13th month earlier earnings: admin and bookkeeper read" on public.thirteenth_earlier for select using (public.can_keep_books());
revoke insert, update, delete on public.thirteenth_earlier from anon, authenticated;

create function public.thirteenth_earlier_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'Earlier earnings are kept: void the entry instead.' using errcode = '42501';
  end if;
  if old.voided_at is not null then raise exception 'A voided entry can''t be changed.' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason']) is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
    raise exception 'Earlier earnings aren''t edited: void the entry and add the right one.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger thirteenth_earlier_guard before update or delete on public.thirteenth_earlier for each row execute function public.thirteenth_earlier_guard();

-- p: {user_id, year, amount, reference, note}
create function public.thirteenth_earlier_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid := nullif(p ->> 'user_id', '')::uuid; v_id uuid;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper keep 13th-month records.' using errcode = '42501'; end if;
  if v_user is null or not exists (select 1 from public.profiles where id = v_user) then raise exception 'Choose the person.' using errcode = '22023'; end if;
  if v_user = auth.uid() and not public.is_admin() then raise exception 'Only the admin enters your own earnings.' using errcode = '42501'; end if;
  if coalesce(p ->> 'amount', '') !~ '^\d+(\.\d{1,2})?$' then raise exception 'The amount is pesos with up to two decimals.' using errcode = '22023'; end if;
  begin
    insert into public.thirteenth_earlier (user_id, year, amount, reference, note)
    values (v_user, (p ->> 'year')::int, (p ->> 'amount')::numeric, btrim(coalesce(p ->> 'reference', '')), left(btrim(coalesce(p ->> 'note', '')), 500))
    returning id into v_id;
  exception when check_violation or not_null_violation or invalid_text_representation then
    raise exception 'Give the year, the basic salary earned and where it comes from (e.g. "old payroll sheets Jan-Sep").' using errcode = '23514';
  end;
  return jsonb_build_object('id', v_id);
end $$;

create function public.thirteenth_earlier_void(p_id uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the admin voids an earlier-earnings entry.' using errcode = '42501'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'Say why it''s void.' using errcode = '23514'; end if;
  update public.thirteenth_earlier set voided_at = now(), voided_by = auth.uid(), void_reason = left(btrim(p_reason), 300) where id = p_id and voided_at is null;
  if not found then raise exception 'That entry isn''t open any more.' using errcode = 'P0002'; end if;
  return true;
end $$;

-- ------------------------------------------------------------ the maths ----

create function public.thirteenth_person(p_user uuid, p_year int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rule public.statutory_rules := public.statutory_rule_on('thirteenth_month', make_date(p_year, 12, 31));
  div numeric := coalesce((rule.params ->> 'divisor')::numeric, 12); cap numeric := coalesce((rule.params ->> 'tax_exempt_cap')::numeric, 90000);
  earlier numeric; portal numeric := 0; last_end date; proj numeric := 0; r public.salary_rates; ln record; d jsonb;
  y_start date := make_date(p_year, 1, 1); y_end date := make_date(p_year, 12, 31); days_left int; cutoffs_left int; dt date; p_end date;
begin
  -- Someone who left during the year is projected only to their last day.
  p_end := least(y_end, coalesce((select separated_on from public.employee_statutory where user_id = p_user), y_end));
  earlier := coalesce((select sum(amount) from public.thirteenth_earlier where user_id = p_user and year = p_year and voided_at is null), 0);
  for ln in select l.*, pr.period_end from public.payroll_lines l join public.payroll_runs pr on pr.id = l.run_id
            where l.user_id = p_user and pr.status in ('approved', 'released') and pr.period_start >= y_start and pr.period_end <= y_end loop
    if ln.salary_type = 'monthly' then portal := portal + ln.basic_pay;
    else
      for d in select * from jsonb_array_elements(ln.days) loop
        if d ->> 'holiday' is null and not coalesce((d ->> 'rest_day')::boolean, false) and d ->> 'status' in ('present', 'incomplete', 'in_progress') then
          portal := portal + (d ->> 'basic')::numeric - (d ->> 'deductions')::numeric;
        end if;
      end loop;
    end if;
    last_end := greatest(coalesce(last_end, ln.period_end), ln.period_end);
  end loop;
  -- Projection for the rest of the year (an estimate), at the rate in force at the year's end.
  r := public.salary_rate_on(p_user, y_end);
  dt := greatest(coalesce(last_end, y_start - 1) + 1, coalesce(r.effective_from, y_start));
  if r.id is not null and dt <= p_end then
    if r.salary_type = 'daily' then
      select count(*) into days_left from generate_series(dt, p_end, interval '1 day') g(x)
      where extract(isodow from g.x) <> 7 and public.holiday_on(g.x::date) is null;
      proj := r.rate * days_left;
    else
      select count(*) into cutoffs_left from generate_series(dt, p_end, interval '1 day') g(x) where extract(day from g.x) in (1, 16);
      proj := round(r.rate / 2, 2) * cutoffs_left;
    end if;
  end if;
  return jsonb_build_object('user_id', p_user, 'year', p_year, 'earlier', round(earlier, 2), 'portal', round(portal, 2), 'projected_basic', round(proj, 2),
    'covered_through', last_end, 'basic_to_date', round(earlier + portal, 2),
    'to_date', round((earlier + portal) / div, 2), 'projected', round((earlier + portal + proj) / div, 2),
    'tax_exempt_cap', cap, 'rule', rule.id, 'rule_status', rule.status);
end $$;

-- Everyone covered in a year: active (or separated during the year), rank-and-file, not the admin, with a rate or earnings.
create function public.thirteenth_people(p_year int) returns setof jsonb
language sql stable security definer set search_path = public as $$
  select public.thirteenth_person(pr.id, p_year) || jsonb_build_object('name', pr.full_name, 'role', pr.role, 'active', pr.active,
    'rank_and_file', coalesce(es.rank_and_file, true), 'separated_on', es.separated_on)
  from public.profiles pr left join public.employee_statutory es on es.user_id = pr.id
  where pr.role <> 'admin'
    and (pr.active or (es.separated_on is not null and extract(year from es.separated_on) = p_year))
    and (exists (select 1 from public.salary_rates s where s.user_id = pr.id and s.effective_from <= make_date(p_year, 12, 31))
         or exists (select 1 from public.thirteenth_earlier t where t.user_id = pr.id and t.year = p_year and t.voided_at is null))
  order by lower(pr.full_name)
$$;

-- --------------------------------------------------------------- runs ----

create table public.thirteenth_runs (
  id uuid primary key default gen_random_uuid(),
  year int not null check (year between 2020 and 2100),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'released', 'void')),
  totals jsonb not null default '{}'::jsonb,
  prepared_by uuid not null default auth.uid() references public.profiles (id), prepared_at timestamptz not null default now(),
  submitted_by uuid references public.profiles (id), submitted_at timestamptz, returned_note text,
  approved_by uuid references public.profiles (id), approved_at timestamptz, approval_note text,
  released_by uuid references public.profiles (id), released_at timestamptz,
  release_ref text check (release_ref is null or length(btrim(release_ref)) between 3 and 300),
  voided_by uuid references public.profiles (id), voided_at timestamptz,
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 3 and 300)
);
create unique index thirteenth_runs_one_per_year on public.thirteenth_runs (year) where status <> 'void';

create table public.thirteenth_lines (
  run_id uuid not null references public.thirteenth_runs (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  name text not null,
  earlier numeric(12,2) not null, portal numeric(12,2) not null, projected_basic numeric(12,2) not null,
  to_date numeric(12,2) not null, amount numeric(12,2) not null,
  tax_exempt_cap numeric(12,2) not null, taxable_excess numeric(12,2) not null,
  covered_through date,
  primary key (run_id, user_id)
);
alter table public.thirteenth_runs enable row level security;
alter table public.thirteenth_lines enable row level security;
create policy "13th month runs: admin and bookkeeper read" on public.thirteenth_runs for select using (public.can_keep_books());
create policy "13th month lines: admin and bookkeeper read" on public.thirteenth_lines for select using (public.can_keep_books());
revoke insert, update, delete on public.thirteenth_runs, public.thirteenth_lines from anon, authenticated;

create function public.thirteenth_run_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception '13th-month runs are kept: void it instead.' using errcode = '42501'; end if;
  if old.status in ('released', 'void') then raise exception 'A released or void 13th-month run can''t be changed.' using errcode = '42501'; end if;
  if new.year <> old.year or new.prepared_by <> old.prepared_by then raise exception 'A 13th-month run''s year is fixed.' using errcode = '42501'; end if;
  if old.status <> 'draft' and new.status <> 'void' and new.totals is distinct from old.totals then raise exception 'Only a draft is recomputed.' using errcode = '42501'; end if;
  return new;
end $$;
create trigger thirteenth_run_guard before update or delete on public.thirteenth_runs for each row execute function public.thirteenth_run_guard();

create function public.thirteenth_line_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then raise exception '13th-month lines aren''t edited: recompute the draft.' using errcode = '42501'; end if;
  if (select status from public.thirteenth_runs where id = coalesce(new.run_id, old.run_id)) is distinct from 'draft' then
    raise exception 'Only a draft 13th-month run is recomputed.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger thirteenth_line_guard before insert or update or delete on public.thirteenth_lines for each row execute function public.thirteenth_line_guard();

create function public.thirteenth_run_compute(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
declare run public.thirteenth_runs; x jsonb; amt numeric;
begin
  select * into run from public.thirteenth_runs where id = p_run;
  if run.status <> 'draft' then raise exception 'Only a draft 13th-month run is recomputed.' using errcode = '42501'; end if;
  delete from public.thirteenth_lines where run_id = p_run;
  for x in select * from public.thirteenth_people(run.year) loop
    continue when not (x ->> 'rank_and_file')::boolean;
    -- Before the year is over, the run pays the projected figure; after it, what was earned.
    amt := case when (now() at time zone 'Asia/Manila')::date > make_date(run.year, 12, 31) then (x ->> 'to_date')::numeric else (x ->> 'projected')::numeric end;
    insert into public.thirteenth_lines values (p_run, (x ->> 'user_id')::uuid, coalesce(x ->> 'name', ''), (x ->> 'earlier')::numeric, (x ->> 'portal')::numeric,
      (x ->> 'projected_basic')::numeric, (x ->> 'to_date')::numeric, amt, (x ->> 'tax_exempt_cap')::numeric,
      greatest(amt - (x ->> 'tax_exempt_cap')::numeric, 0), nullif(x ->> 'covered_through', '')::date);
  end loop;
  update public.thirteenth_runs set totals = (select jsonb_build_object('people', count(*), 'amount', coalesce(sum(amount), 0),
      'to_date', coalesce(sum(to_date), 0), 'taxable_excess', coalesce(sum(taxable_excess), 0)) from public.thirteenth_lines where run_id = p_run)
  where id = p_run;
end $$;

create function public.thirteenth_overview(p_year int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare run public.thirteenth_runs;
begin
  if not public.can_keep_books() then raise exception '13th-month pay is for the admin and the bookkeeper.' using errcode = '42501'; end if;
  select * into run from public.thirteenth_runs where year = p_year and status <> 'void';
  return jsonb_build_object('year', p_year, 'can_approve', public.is_admin(),
    'rule', (select public.statutory_rule_json(public.statutory_rule_on('thirteenth_month', make_date(p_year, 12, 31)))),
    'people', coalesce((select jsonb_agg(x) from public.thirteenth_people(p_year) x), '[]'::jsonb),
    'earlier', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'user_id', t.user_id, 'amount', t.amount, 'reference', t.reference, 'note', t.note,
        'by', (select full_name from public.profiles where id = t.created_by), 'created_at', t.created_at) order by t.created_at)
      from public.thirteenth_earlier t where t.year = p_year and t.voided_at is null), '[]'::jsonb),
    'run', case when run.id is null then null else to_jsonb(run) || jsonb_build_object(
      'approver', (select full_name from public.profiles where id = run.approved_by),
      'lines', coalesce((select jsonb_agg(to_jsonb(l) order by lower(l.name)) from public.thirteenth_lines l where l.run_id = run.id), '[]'::jsonb)) end);
end $$;

create function public.thirteenth_run_prepare(p_year int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper prepare 13th-month pay.' using errcode = '42501'; end if;
  begin
    insert into public.thirteenth_runs (year) values (p_year) returning id into v_id;
  exception when unique_violation then raise exception 'The % 13th-month pay is already prepared: open it, or void it first.', p_year using errcode = '23505';
  when check_violation then raise exception 'Choose a year.' using errcode = '22023';
  end;
  perform public.thirteenth_run_compute(v_id);
  return public.thirteenth_overview(p_year);
end $$;

-- p_action: 'recompute' | 'submit' (admin and bookkeeper) · 'approve' | 'return' | 'void' (admin) · 'release' (admin and bookkeeper)
create function public.thirteenth_run_act(p_run uuid, p_action text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare run public.thirteenth_runs;
begin
  if not public.can_keep_books() then raise exception '13th-month pay is for the admin and the bookkeeper.' using errcode = '42501'; end if;
  select * into run from public.thirteenth_runs where id = p_run;
  if not found then raise exception 'No such 13th-month run.' using errcode = 'P0002'; end if;
  if p_action = 'recompute' then
    if run.status <> 'draft' then raise exception 'Only a draft is recomputed.' using errcode = '22023'; end if;
    perform public.thirteenth_run_compute(p_run);
  elsif p_action = 'submit' then
    if run.status <> 'draft' then raise exception 'Only a draft is submitted.' using errcode = '22023'; end if;
    perform public.thirteenth_run_compute(p_run);
    update public.thirteenth_runs set status = 'submitted', submitted_by = auth.uid(), submitted_at = now(), returned_note = null where id = p_run;
  elsif p_action in ('approve', 'return', 'void') then
    if not public.is_admin() then raise exception 'Only the admin approves, returns or voids 13th-month pay.' using errcode = '42501'; end if;
    if p_action = 'approve' then
      if run.status <> 'submitted' then raise exception 'Only a submitted run is approved.' using errcode = '22023'; end if;
      update public.thirteenth_runs set status = 'approved', approved_by = auth.uid(), approved_at = now(), approval_note = nullif(left(btrim(coalesce(p_note, '')), 500), '') where id = p_run;
    elsif p_action = 'return' then
      if run.status <> 'submitted' then raise exception 'Only a submitted run is returned.' using errcode = '22023'; end if;
      if btrim(coalesce(p_note, '')) = '' then raise exception 'Say what needs fixing.' using errcode = '23514'; end if;
      update public.thirteenth_runs set status = 'draft', returned_note = left(btrim(p_note), 500), submitted_by = null, submitted_at = null where id = p_run;
    else
      if run.status = 'released' then raise exception 'A released 13th-month run stays: correct it with a payroll adjustment.' using errcode = '22023'; end if;
      if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Say why it''s void.' using errcode = '23514'; end if;
      update public.thirteenth_runs set status = 'void', voided_by = auth.uid(), voided_at = now(), void_reason = left(btrim(p_note), 300) where id = p_run;
    end if;
  elsif p_action = 'release' then
    if run.status <> 'approved' then raise exception 'Only an approved run is released.' using errcode = '22023'; end if;
    if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Give the release reference: the bank batch number, or "cash, signed sheet".' using errcode = '23514'; end if;
    update public.thirteenth_runs set status = 'released', released_by = auth.uid(), released_at = now(), release_ref = left(btrim(p_note), 300) where id = p_run;
  else raise exception 'Unknown action.' using errcode = '22023'; end if;
  return public.thirteenth_overview(run.year);
end $$;

-- Each person's own 13th month, once approved.
create function public.thirteenth_mine() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(l) || jsonb_build_object('year', r.year, 'status', r.status, 'released_at', r.released_at) order by r.year desc), '[]'::jsonb)
  from public.thirteenth_lines l join public.thirteenth_runs r on r.id = l.run_id
  where l.user_id = auth.uid() and r.status in ('approved', 'released')
$$;

revoke execute on function public.thirteenth_person(uuid, int), public.thirteenth_people(int), public.thirteenth_run_compute(uuid),
  public.thirteenth_earlier_guard(), public.thirteenth_run_guard(), public.thirteenth_line_guard() from public, anon, authenticated;
revoke execute on function public.thirteenth_earlier_add(jsonb), public.thirteenth_earlier_void(uuid, text), public.thirteenth_overview(int),
  public.thirteenth_run_prepare(int), public.thirteenth_run_act(uuid, text, text), public.thirteenth_mine() from public, anon;
grant execute on function public.thirteenth_earlier_add(jsonb), public.thirteenth_earlier_void(uuid, text), public.thirteenth_overview(int),
  public.thirteenth_run_prepare(int), public.thirteenth_run_act(uuid, text, text), public.thirteenth_mine() to authenticated;

create trigger zz_audit after insert or update or delete on public.thirteenth_earlier for each row execute function public.audit_row('user_id', 'year');
create trigger zz_audit after insert or update or delete on public.thirteenth_runs for each row execute function public.audit_row('year');

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
    when p_table in ('salary_rates', 'payroll_settings', 'statutory_rules', 'employee_statutory', 'payroll_runs', 'payroll_adjustments',
      'thirteenth_earlier', 'thirteenth_runs') then 'Payroll'
    when p_table in ('compliance_records', 'compliance_settings') then 'Compliance'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;
