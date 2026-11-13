-- v4.1: payroll runs. The bookkeeper (or the admin) prepares a cutoff from attendance, the database
-- computes every line (pay, SSS, PhilHealth, Pag-IBIG, withholding tax, net), the admin approves, and
-- the release is recorded with its reference. Approved runs are locked; each person reads only their
-- own payslips, and only once the run is approved.
--
-- The owner's open decisions are settings, not code (MEMORY.md, 2026-11-13):
--   * contributions_timing: 'second' (default: the whole month's contributions on the 16-end cutoff,
--     computed on the month's actual pay) or 'split' (first cutoff: half, estimated from the rate;
--     second cutoff: the month's actual figure less what the first cutoff took).
--   * every pay adjustment needs the admin's approval (the strictest reading of decision 7).
--   * allowance_taxable: true by default (conservative until the accountant classifies allowances).
--
-- How a line is computed (payroll_person_period):
--   daily-paid:   basic pay = the period's days from pay_day_calc (each day's basic less its deductions;
--                 paid leave and regular-holiday pay included).
--   monthly-paid: basic pay = half the monthly rate, less the minutes deducted and one daily-equivalent
--                 per absence or unpaid leave (holidays are inside the monthly rate).
--   gross = basic pay + premiums + overtime + allowance + approved earnings adjustments.
--   Contributions on the month (16-end cutoff): SSS on the month's gross, PhilHealth and Pag-IBIG on
--     the month's basic pay; less what the 1-15 run already deducted.
--   Withholding: the semi-monthly table on (taxable pay less the employee's contributions this
--     cutoff); nothing for minimum-wage earners (employee_statutory, or the rate against the minimum).
--   net = gross - employee contributions - tax - approved deductions.
-- The bases (SSS on gross, PhilHealth and Pag-IBIG on basic pay) are flagged for the accountant.

alter table public.payroll_settings
  add column contributions_timing text not null default 'second' check (contributions_timing in ('second', 'split')),
  add column allowance_taxable boolean not null default true;

create or replace function public.payroll_settings_save(p jsonb) returns jsonb
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
      regular_unworked = s.regular_unworked, payday_rule = s.payday_rule,
      contributions_timing = s.contributions_timing, allowance_taxable = s.allowance_taxable,
      updated_by = auth.uid(), updated_at = now()
    where id = 1;
  exception when check_violation or not_null_violation then
    raise exception 'That setting is outside what the law allows here: check the rates and the payday rule.' using errcode = '23514';
  end;
  return public.payroll_settings_get();
end $$;

-- ---------------------------------------------------------------- tables ----

create table public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  release_date date not null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'released', 'void')),
  contributions_timing text not null,
  totals jsonb not null default '{}'::jsonb,
  prepared_by uuid not null default auth.uid() references public.profiles (id),
  prepared_at timestamptz not null default now(),
  computed_at timestamptz,
  submitted_by uuid references public.profiles (id), submitted_at timestamptz,
  returned_note text,
  approved_by uuid references public.profiles (id), approved_at timestamptz, approval_note text,
  released_by uuid references public.profiles (id), released_at timestamptz,
  release_ref text check (release_ref is null or length(btrim(release_ref)) between 3 and 300),
  voided_by uuid references public.profiles (id), voided_at timestamptz,
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 3 and 300),
  check (period_end >= period_start)
);
create unique index payroll_runs_one_per_period on public.payroll_runs (period_start) where status <> 'void';

create table public.payroll_lines (
  run_id uuid not null references public.payroll_runs (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  name text not null, role text, employment_type text, salary_type text not null, daily_rate numeric(12,2) not null,
  days_worked int not null, worked_minutes int not null, deducted_minutes int not null, unaccounted_days int not null,
  basic_pay numeric(12,2) not null, premium numeric(12,2) not null, overtime_pay numeric(12,2) not null, allowance numeric(12,2) not null,
  adj_taxable numeric(12,2) not null, adj_nontaxable numeric(12,2) not null, adj_deductions numeric(12,2) not null,
  gross numeric(12,2) not null, taxable numeric(12,2) not null,
  sss_ee numeric(12,2) not null, sss_er numeric(12,2) not null, sss_ec numeric(12,2) not null,
  ph_ee numeric(12,2) not null, ph_er numeric(12,2) not null, pi_ee numeric(12,2) not null, pi_er numeric(12,2) not null,
  mwe boolean not null, tax numeric(12,2) not null, net numeric(12,2) not null,
  basis jsonb not null,           -- the month's bases and the rule ids and statuses used
  days jsonb not null,            -- pay_day_calc for each day, as computed
  primary key (run_id, user_id)
);

create table public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payroll_runs (id),
  user_id uuid not null references public.profiles (id),
  kind text not null check (kind in ('taxable_earning', 'nontaxable_earning', 'deduction')),
  amount numeric(12,2) not null check (amount > 0 and amount <= 1000000),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  reference text not null default '' check (length(reference) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id), decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 500)
);

alter table public.payroll_runs enable row level security;
alter table public.payroll_lines enable row level security;
alter table public.payroll_adjustments enable row level security;
create policy "payroll runs: admin and bookkeeper read" on public.payroll_runs for select using (public.can_keep_books());
create policy "payroll lines: admin and bookkeeper read" on public.payroll_lines for select using (public.can_keep_books());
create policy "payroll adjustments: admin and bookkeeper read" on public.payroll_adjustments for select using (public.can_keep_books());
revoke insert, update, delete on public.payroll_runs, public.payroll_lines, public.payroll_adjustments from anon, authenticated;

-- Runs are never deleted; lines change only while their run is a draft; adjustments are decided once.
create function public.payroll_run_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Payroll runs are kept: void it instead.' using errcode = '42501'; end if;
  if old.status in ('released', 'void') then raise exception 'A released or void payroll run can''t be changed.' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['status', 'totals', 'computed_at', 'submitted_by', 'submitted_at', 'returned_note', 'approved_by', 'approved_at',
        'approval_note', 'released_by', 'released_at', 'release_ref', 'voided_by', 'voided_at', 'void_reason', 'contributions_timing'])
     is distinct from (to_jsonb(old) - array['status', 'totals', 'computed_at', 'submitted_by', 'submitted_at', 'returned_note', 'approved_by', 'approved_at',
        'approval_note', 'released_by', 'released_at', 'release_ref', 'voided_by', 'voided_at', 'void_reason', 'contributions_timing']) then
    raise exception 'A payroll run''s period is fixed.' using errcode = '42501';
  end if;
  if old.status <> 'draft' and new.status <> 'void' and (new.totals is distinct from old.totals or new.contributions_timing is distinct from old.contributions_timing) then
    raise exception 'Only a draft payroll is recomputed.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger payroll_run_guard before update or delete on public.payroll_runs for each row execute function public.payroll_run_guard();

create function public.payroll_line_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then raise exception 'Payroll lines aren''t edited: recompute the draft.' using errcode = '42501'; end if;
  if (select status from public.payroll_runs where id = coalesce(new.run_id, old.run_id)) is distinct from 'draft' then
    raise exception 'Only a draft payroll is recomputed.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger payroll_line_guard before insert or update or delete on public.payroll_lines for each row execute function public.payroll_line_guard();

create function public.payroll_adjustment_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Adjustments are kept: reject it instead.' using errcode = '42501'; end if;
  if old.status <> 'pending' then raise exception 'That adjustment was already decided.' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['status', 'decided_by', 'decided_at', 'decision_note']) is distinct from (to_jsonb(old) - array['status', 'decided_by', 'decided_at', 'decision_note']) then
    raise exception 'Adjustments aren''t edited: reject it and add the right one.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger payroll_adjustment_guard before update or delete on public.payroll_adjustments for each row execute function public.payroll_adjustment_guard();

-- ------------------------------------------------------------- the maths ----

-- One person over [a, z]: pay from attendance, without adjustments or contributions.
create function public.payroll_person_period(p_user uuid, a date, z date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.salary_rates := public.salary_rate_on(p_user, z); v_days jsonb; dly numeric; basic numeric;
  div numeric := (select divisor from public.payroll_settings where id = 1);
begin
  if r.id is null then return null; end if;
  select coalesce(jsonb_agg(public.pay_day_calc(p_user, g.d::date) order by g.d), '[]'::jsonb) into v_days
  from generate_series(a, z, interval '1 day') g(d);
  dly := case r.salary_type when 'daily' then r.rate else round(r.rate * 12 / div, 2) end;
  if r.salary_type = 'daily' then
    select coalesce(sum((x ->> 'basic')::numeric - (x ->> 'deductions')::numeric), 0) into basic from jsonb_array_elements(v_days) x;
  else
    select round(r.rate / 2, 2) - coalesce(sum((x ->> 'deductions')::numeric), 0)
      - dly * count(*) filter (where x ->> 'status' in ('absent', 'leave_unpaid')) into basic from jsonb_array_elements(v_days) x;
  end if;
  return (select jsonb_build_object('salary_type', r.salary_type, 'employment_type', r.employment_type, 'daily_rate', dly, 'monthly_rate', case when r.salary_type = 'monthly' then r.rate end,
      'days_worked', count(*) filter (where (x ->> 'worked_minutes')::int > 0),
      'worked_minutes', coalesce(sum((x ->> 'worked_minutes')::int), 0),
      'deducted_minutes', coalesce(sum((x ->> 'late_minutes')::int + (x ->> 'undertime_minutes')::int + (x ->> 'unworked_minutes')::int), 0),
      'unaccounted_days', count(*) filter (where x ->> 'status' = 'unaccounted'),
      'scheduled_days', count(*) filter (where x ->> 'status' in ('scheduled', 'not_yet', 'in_progress')),
      'basic_pay', basic, 'premium', coalesce(sum((x ->> 'premium')::numeric), 0),
      'overtime_pay', coalesce(sum((x ->> 'overtime_pay')::numeric), 0), 'allowance', coalesce(sum((x ->> 'allowance')::numeric), 0),
      'days', v_days)
    from jsonb_array_elements(v_days) x);
end $$;

-- Recompute every line of a draft run.
create function public.payroll_run_compute(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare run public.payroll_runs; st public.payroll_settings; pr record; pp jsonb; p1 jsonb; first_run uuid; first_line public.payroll_lines;
  is_second boolean; ms date; adj_t numeric; adj_n numeric; adj_d numeric; adj1 numeric; gross numeric; taxable numeric;
  sss jsonb; ph jsonb; pgb jsonb; sss_ee numeric; sss_er numeric; sss_ec numeric; ph_ee numeric; ph_er numeric; pi_ee numeric; pi_er numeric;
  mon numeric; mwe boolean; mw numeric; tax numeric; wt jsonb; es public.employee_statutory;
begin
  select * into run from public.payroll_runs where id = p_run for update;
  if run.status <> 'draft' then raise exception 'Only a draft payroll is recomputed.' using errcode = '42501'; end if;
  select * into st from public.payroll_settings where id = 1;
  update public.payroll_runs set contributions_timing = st.contributions_timing where id = p_run;
  delete from public.payroll_lines where run_id = p_run;
  is_second := extract(day from run.period_start) > 1;
  ms := date_trunc('month', run.period_start)::date;
  mw := public.stat_minimum_wage(run.period_end);
  if is_second then
    select id into first_run from public.payroll_runs where period_start = ms and status <> 'void';
  end if;
  for pr in select p.id, p.full_name, p.role from public.profiles p
            where p.active and exists (select 1 from public.salary_rates s where s.user_id = p.id and s.effective_from <= run.period_end)
            order by lower(p.full_name) loop
    pp := public.payroll_person_period(pr.id, run.period_start, run.period_end);
    continue when pp is null;
    select coalesce(sum(amount) filter (where kind = 'taxable_earning'), 0), coalesce(sum(amount) filter (where kind = 'nontaxable_earning'), 0),
           coalesce(sum(amount) filter (where kind = 'deduction'), 0)
      into adj_t, adj_n, adj_d from public.payroll_adjustments where run_id = p_run and user_id = pr.id and status = 'approved';
    gross := (pp ->> 'basic_pay')::numeric + (pp ->> 'premium')::numeric + (pp ->> 'overtime_pay')::numeric + (pp ->> 'allowance')::numeric + adj_t + adj_n;
    taxable := (pp ->> 'basic_pay')::numeric + (pp ->> 'premium')::numeric + (pp ->> 'overtime_pay')::numeric
      + case when st.allowance_taxable then (pp ->> 'allowance')::numeric else 0 end + adj_t;
    sss_ee := 0; sss_er := 0; sss_ec := 0; ph_ee := 0; ph_er := 0; pi_ee := 0; pi_er := 0; sss := null; ph := null; pgb := null; p1 := null;
    if not is_second and st.contributions_timing = 'split' then
      -- First cutoff, split: half of a month at the rate.
      mon := case when pp ->> 'salary_type' = 'monthly' then (pp ->> 'monthly_rate')::numeric else round((pp ->> 'daily_rate')::numeric * st.divisor / 12, 2) end;
      sss := public.stat_sss(mon, run.period_end); ph := public.stat_philhealth(mon, run.period_end); pgb := public.stat_pagibig(mon, run.period_end);
      sss_ee := round((sss ->> 'employee')::numeric / 2, 2); sss_er := round(((sss ->> 'employer')::numeric - (sss ->> 'ec')::numeric) / 2, 2);
      sss_ec := round((sss ->> 'ec')::numeric / 2, 2);
      ph_ee := round((ph ->> 'employee')::numeric / 2, 2); ph_er := round((ph ->> 'employer')::numeric / 2, 2);
      pi_ee := round((pgb ->> 'employee')::numeric / 2, 2); pi_er := round((pgb ->> 'employer')::numeric / 2, 2);
    elsif is_second then
      -- The month: the 1-15 figures (from attendance, plus that run's approved earnings) and this cutoff.
      p1 := public.payroll_person_period(pr.id, ms, run.period_start - 1);
      adj1 := coalesce((select sum(amount) from public.payroll_adjustments where run_id = first_run and user_id = pr.id
        and status = 'approved' and kind <> 'deduction'), 0);
      sss := public.stat_sss(coalesce((p1 ->> 'basic_pay')::numeric + (p1 ->> 'premium')::numeric + (p1 ->> 'overtime_pay')::numeric + (p1 ->> 'allowance')::numeric, 0) + adj1 + gross, run.period_end);
      ph := public.stat_philhealth(coalesce((p1 ->> 'basic_pay')::numeric, 0) + (pp ->> 'basic_pay')::numeric, run.period_end);
      pgb := public.stat_pagibig(coalesce((p1 ->> 'basic_pay')::numeric, 0) + (pp ->> 'basic_pay')::numeric, run.period_end);
      select * into first_line from public.payroll_lines where run_id = first_run and user_id = pr.id;
      sss_ee := greatest((sss ->> 'employee')::numeric - coalesce(first_line.sss_ee, 0), 0);
      sss_ec := greatest((sss ->> 'ec')::numeric - coalesce(first_line.sss_ec, 0), 0);
      sss_er := greatest((sss ->> 'employer')::numeric - (sss ->> 'ec')::numeric - coalesce(first_line.sss_er, 0), 0);
      ph_ee := greatest((ph ->> 'employee')::numeric - coalesce(first_line.ph_ee, 0), 0);
      ph_er := greatest((ph ->> 'employer')::numeric - coalesce(first_line.ph_er, 0), 0);
      pi_ee := greatest((pgb ->> 'employee')::numeric - coalesce(first_line.pi_ee, 0), 0);
      pi_er := greatest((pgb ->> 'employer')::numeric - coalesce(first_line.pi_er, 0), 0);
    end if;
    select * into es from public.employee_statutory where user_id = pr.id;
    mwe := coalesce(es.minimum_wage_earner, mw is not null and (pp ->> 'daily_rate')::numeric <= mw);
    if mwe then tax := 0; wt := jsonb_build_object('tax', 0, 'exempt', 'minimum wage earner');
    else wt := public.stat_withholding(greatest(taxable - sss_ee - ph_ee - pi_ee, 0), 'semi_monthly', run.period_end); tax := (wt ->> 'tax')::numeric; end if;
    insert into public.payroll_lines values (p_run, pr.id, coalesce(pr.full_name, ''), pr.role::text, pp ->> 'employment_type', pp ->> 'salary_type',
      (pp ->> 'daily_rate')::numeric, (pp ->> 'days_worked')::int, (pp ->> 'worked_minutes')::int, (pp ->> 'deducted_minutes')::int,
      (pp ->> 'unaccounted_days')::int, (pp ->> 'basic_pay')::numeric, (pp ->> 'premium')::numeric, (pp ->> 'overtime_pay')::numeric,
      (pp ->> 'allowance')::numeric, adj_t, adj_n, adj_d, gross, taxable,
      sss_ee, sss_er, sss_ec, ph_ee, ph_er, pi_ee, pi_er, mwe, tax, gross - sss_ee - ph_ee - pi_ee - tax - adj_d,
      jsonb_build_object('first_cutoff', p1 is not null, 'first_run', first_run, 'scheduled_days', (pp ->> 'scheduled_days')::int,
        'sss', sss, 'philhealth', ph, 'pagibig', pgb, 'withholding', wt, 'allowance_taxable', st.allowance_taxable),
      pp -> 'days');
  end loop;
  update public.payroll_runs set computed_at = now(), totals = (select jsonb_build_object('people', count(*), 'gross', coalesce(sum(gross), 0),
      'employee_contributions', coalesce(sum(sss_ee + ph_ee + pi_ee), 0), 'employer_contributions', coalesce(sum(sss_er + sss_ec + ph_er + pi_er), 0),
      'tax', coalesce(sum(tax), 0), 'deductions', coalesce(sum(adj_deductions), 0), 'net', coalesce(sum(net), 0),
      'unaccounted_days', coalesce(sum(unaccounted_days), 0), 'negative_net', count(*) filter (where net < 0))
    from public.payroll_lines where run_id = p_run)
  where id = p_run;
end $$;

-- --------------------------------------------------------------- workflow ----

create function public.payroll_run_json(p_run uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(r) || jsonb_build_object(
    'preparer', (select full_name from public.profiles where id = r.prepared_by),
    'submitter', (select full_name from public.profiles where id = r.submitted_by),
    'approver', (select full_name from public.profiles where id = r.approved_by),
    'releaser', (select full_name from public.profiles where id = r.released_by),
    'pending_adjustments', (select count(*) from public.payroll_adjustments a where a.run_id = r.id and a.status = 'pending'))
  from public.payroll_runs r where r.id = p_run
$$;

create function public.payroll_runs_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_keep_books() then raise exception 'Payroll is for the admin and the bookkeeper.' using errcode = '42501'; end if;
  return jsonb_build_object('can_approve', public.is_admin(), 'settings', public.payroll_settings_get(),
    'runs', coalesce((select jsonb_agg(public.payroll_run_json(id) order by period_start desc, prepared_at desc) from public.payroll_runs), '[]'::jsonb));
end $$;

create function public.payroll_run_get(p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_keep_books() then raise exception 'Payroll is for the admin and the bookkeeper.' using errcode = '42501'; end if;
  if not exists (select 1 from public.payroll_runs where id = p_run) then raise exception 'No such payroll run.' using errcode = 'P0002'; end if;
  return public.payroll_run_json(p_run) || jsonb_build_object('can_approve', public.is_admin(),
    'lines', coalesce((select jsonb_agg(to_jsonb(l) - 'days' order by lower(l.name)) from public.payroll_lines l where l.run_id = p_run), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(to_jsonb(a) || jsonb_build_object('person', (select full_name from public.profiles where id = a.user_id),
        'by', (select full_name from public.profiles where id = a.created_by), 'decider', (select full_name from public.profiles where id = a.decided_by),
        'self', a.user_id = auth.uid()) order by a.created_at)
      from public.payroll_adjustments a where a.run_id = p_run), '[]'::jsonb));
end $$;

-- Prepare the cutoff that contains p_date.
create function public.payroll_run_prepare(p_date date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare per jsonb := public.pay_period(p_date); v_id uuid;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper prepare payroll.' using errcode = '42501'; end if;
  begin
    insert into public.payroll_runs (period_start, period_end, release_date, contributions_timing)
    values ((per ->> 'start')::date, (per ->> 'end')::date, (per ->> 'release')::date, (select contributions_timing from public.payroll_settings where id = 1))
    returning id into v_id;
  exception when unique_violation then
    raise exception 'The % to % payroll is already prepared: open it, or void it first.', per ->> 'start', per ->> 'end' using errcode = '23505';
  end;
  perform public.payroll_run_compute(v_id);
  return public.payroll_run_get(v_id);
end $$;

create function public.payroll_run_recompute(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper prepare payroll.' using errcode = '42501'; end if;
  if (select status from public.payroll_runs where id = p_run) is distinct from 'draft' then
    raise exception 'Only a draft payroll is recomputed.' using errcode = '42501';
  end if;
  perform public.payroll_run_compute(p_run);
  return public.payroll_run_get(p_run);
end $$;

-- p: {run_id, user_id, kind, amount, reason, reference}. Every adjustment waits for the admin.
create function public.payroll_adjustment_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_run uuid := nullif(p ->> 'run_id', '')::uuid; v_user uuid := nullif(p ->> 'user_id', '')::uuid; v_id uuid;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper adjust payroll.' using errcode = '42501'; end if;
  if (select status from public.payroll_runs where id = v_run) is distinct from 'draft' then
    raise exception 'Adjustments go on a draft payroll only.' using errcode = '22023';
  end if;
  if v_user = auth.uid() and not public.is_admin() then raise exception 'Only the admin adjusts your own pay.' using errcode = '42501'; end if;
  if coalesce(p ->> 'amount', '') !~ '^\d+(\.\d{1,2})?$' then raise exception 'The amount is pesos with up to two decimals.' using errcode = '22023'; end if;
  begin
    insert into public.payroll_adjustments (run_id, user_id, kind, amount, reason, reference)
    values (v_run, v_user, p ->> 'kind', (p ->> 'amount')::numeric, btrim(coalesce(p ->> 'reason', '')), left(btrim(coalesce(p ->> 'reference', '')), 300))
    returning id into v_id;
  exception when check_violation or not_null_violation or foreign_key_violation then
    raise exception 'An adjustment needs the person, the kind, an amount and the reason.' using errcode = '23514';
  end;
  return public.payroll_run_get(v_run);
end $$;

create function public.payroll_adjustment_decide(p_id uuid, p_decision text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.payroll_adjustments;
begin
  if not public.is_admin() then raise exception 'Only the admin approves payroll adjustments.' using errcode = '42501'; end if;
  select * into a from public.payroll_adjustments where id = p_id;
  if not found then raise exception 'No such adjustment.' using errcode = 'P0002'; end if;
  if (select status from public.payroll_runs where id = a.run_id) <> 'draft' then raise exception 'Adjustments go on a draft payroll only.' using errcode = '22023'; end if;
  if p_decision not in ('approved', 'rejected') then raise exception 'Approve or reject.' using errcode = '22023'; end if;
  update public.payroll_adjustments set status = p_decision, decided_by = auth.uid(), decided_at = now(), decision_note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
  where id = p_id;
  perform public.payroll_run_compute(a.run_id);
  return public.payroll_run_get(a.run_id);
end $$;

-- Submit for approval: recomputed, no pending adjustments, the cutoff over, every day accounted for.
create function public.payroll_run_submit(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare run public.payroll_runs; who text;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper prepare payroll.' using errcode = '42501'; end if;
  select * into run from public.payroll_runs where id = p_run;
  if run.status is distinct from 'draft' then raise exception 'Only a draft payroll is submitted.' using errcode = '22023'; end if;
  if run.period_end >= (now() at time zone 'Asia/Manila')::date then raise exception 'The cutoff isn''t over yet (it ends %).', run.period_end using errcode = '22023'; end if;
  if exists (select 1 from public.payroll_adjustments where run_id = p_run and status = 'pending') then
    raise exception 'Adjustments are still waiting for the admin.' using errcode = '22023';
  end if;
  perform public.payroll_run_compute(p_run);
  select string_agg(name || ' (' || unaccounted_days || ')', ', ' order by name) into who from public.payroll_lines where run_id = p_run and unaccounted_days > 0;
  if who is not null then raise exception 'Days not accounted for: %. Record the leave, absence or correction first.', who using errcode = '22023'; end if;
  select string_agg(name, ', ' order by name) into who from public.payroll_lines where run_id = p_run and net < 0;
  if who is not null then raise exception 'Net pay below zero for %: check the deductions.', who using errcode = '22023'; end if;
  update public.payroll_runs set status = 'submitted', submitted_by = auth.uid(), submitted_at = now(), returned_note = null where id = p_run;
  return public.payroll_run_get(p_run);
end $$;

create function public.payroll_run_decide(p_run uuid, p_decision text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare run public.payroll_runs;
begin
  if not public.is_admin() then raise exception 'Only the admin approves payroll.' using errcode = '42501'; end if;
  select * into run from public.payroll_runs where id = p_run;
  if run.status is distinct from 'submitted' then raise exception 'Only a submitted payroll is approved or returned.' using errcode = '22023'; end if;
  if p_decision = 'approved' then
    update public.payroll_runs set status = 'approved', approved_by = auth.uid(), approved_at = now(), approval_note = nullif(left(btrim(coalesce(p_note, '')), 500), '') where id = p_run;
  elsif p_decision = 'returned' then
    if btrim(coalesce(p_note, '')) = '' then raise exception 'Say what needs fixing.' using errcode = '23514'; end if;
    update public.payroll_runs set status = 'draft', returned_note = left(btrim(p_note), 500), submitted_by = null, submitted_at = null where id = p_run;
  else raise exception 'Approve or return.' using errcode = '22023'; end if;
  return public.payroll_run_get(p_run);
end $$;

-- The release is recorded, not made: the money moves in the bank or in cash, by people.
create function public.payroll_run_release(p_run uuid, p_ref text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper record a release.' using errcode = '42501'; end if;
  if (select status from public.payroll_runs where id = p_run) is distinct from 'approved' then
    raise exception 'Only an approved payroll is released.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_ref, ''))) < 3 then raise exception 'Give the release reference: the bank batch number, or "cash, signed payroll sheet".' using errcode = '23514'; end if;
  update public.payroll_runs set status = 'released', released_by = auth.uid(), released_at = now(), release_ref = left(btrim(p_ref), 300) where id = p_run;
  return public.payroll_run_get(p_run);
end $$;

create function public.payroll_run_void(p_run uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the admin voids a payroll run.' using errcode = '42501'; end if;
  if (select status from public.payroll_runs where id = p_run) not in ('draft', 'submitted', 'approved') then
    raise exception 'A released payroll stays: correct it with an adjustment in the next cutoff.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why it''s void.' using errcode = '23514'; end if;
  update public.payroll_runs set status = 'void', voided_by = auth.uid(), voided_at = now(), void_reason = left(btrim(p_reason), 300) where id = p_run;
  return public.payroll_run_json(p_run);
end $$;

-- Each person's own payslips, from approved and released runs only.
create function public.payslips_mine() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(l) - 'basis' || jsonb_build_object('period_start', r.period_start, 'period_end', r.period_end,
      'release_date', r.release_date, 'status', r.status, 'released_at', r.released_at,
      'adjustments', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'amount', a.amount, 'reason', a.reason) order by a.created_at)
        from public.payroll_adjustments a where a.run_id = r.id and a.user_id = l.user_id and a.status = 'approved'), '[]'::jsonb))
    order by r.period_start desc), '[]'::jsonb)
  from public.payroll_lines l join public.payroll_runs r on r.id = l.run_id
  where l.user_id = auth.uid() and r.status in ('approved', 'released')
$$;

revoke execute on function public.payroll_person_period(uuid, date, date), public.payroll_run_compute(uuid), public.payroll_run_json(uuid),
  public.payroll_run_guard(), public.payroll_line_guard(), public.payroll_adjustment_guard() from public, anon, authenticated;
revoke execute on function public.payroll_runs_list(), public.payroll_run_get(uuid), public.payroll_run_prepare(date), public.payroll_run_recompute(uuid),
  public.payroll_adjustment_add(jsonb), public.payroll_adjustment_decide(uuid, text, text), public.payroll_run_submit(uuid),
  public.payroll_run_decide(uuid, text, text), public.payroll_run_release(uuid, text), public.payroll_run_void(uuid, text), public.payslips_mine() from public, anon;
grant execute on function public.payroll_runs_list(), public.payroll_run_get(uuid), public.payroll_run_prepare(date), public.payroll_run_recompute(uuid),
  public.payroll_adjustment_add(jsonb), public.payroll_adjustment_decide(uuid, text, text), public.payroll_run_submit(uuid),
  public.payroll_run_decide(uuid, text, text), public.payroll_run_release(uuid, text), public.payroll_run_void(uuid, text), public.payslips_mine() to authenticated;

-- ------------------------------------------------------------ activity log ----
-- Runs (every status change) and adjustments are logged; lines are recomputed from them and not.

create trigger zz_audit after insert or update or delete on public.payroll_runs
  for each row execute function public.audit_row('period_start');
create trigger zz_audit after insert or update or delete on public.payroll_adjustments
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
    when p_table in ('salary_rates', 'payroll_settings', 'statutory_rules', 'employee_statutory', 'payroll_runs', 'payroll_adjustments') then 'Payroll'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;
