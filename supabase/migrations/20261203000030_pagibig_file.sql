-- v4.7: the Pag-IBIG remittance file (the owner's sheet, 2026-11-17) and a higher Pag-IBIG share chosen by an employee.
-- Coordinating agent T02-A02; T05-A02 for the file.
--
-- The file follows the owner's own monthly sheet (the format the Fund has been accepting from Ritehome): employer ID,
-- name, address, contact numbers and email on top; then per member: Pag-IBIG MID No., MP2 account no., membership program
-- ("F1-Pag-IBIG 1" / "F1-Pag-IBIG 2"), last name, first name, name extension, middle name, PERCOV (YYYYMM), EE share,
-- ER share, remarks. Remarks follow the MCRF guidelines (checked 2026-11-17 on the form's instructions): only changes in
-- the month, N = newly hired, RS = resigned/separated, with the date as mm/dd/yy. The owner's sheet used NH/S and kept old
-- remarks; that is flagged to the owner, not copied.
-- Amounts come only from approved or released payroll runs of the month (the 1-15 and 16-end cutoffs added together),
-- never from the rates: the file says what was actually deducted.
--
-- A member may choose a higher employee share than the mandatory one (the owner's sheet has one at 400). It is
-- employee_statutory.pagibig_ee_monthly (the whole monthly share they chose; blank = mandatory only), deducted on the
-- contribution cutoff(s) like the rest. Only the mandatory share is excluded from taxable pay; the extra stays taxable
-- (flagged for the accountant).

alter table public.employee_statutory
  add column last_name text not null default '' check (length(last_name) <= 80),
  add column first_name text not null default '' check (length(first_name) <= 80),
  add column middle_name text not null default '' check (length(middle_name) <= 80),
  add column name_ext text not null default '' check (length(name_ext) <= 10),
  add column pagibig_program text not null default 'pagibig1' check (pagibig_program in ('pagibig1', 'pagibig2')),
  add column mp2_account text not null default '' check (mp2_account = '' or mp2_account ~ '^\d{4}-\d{4}-\d{4}$'),
  add column pagibig_ee_monthly numeric(10,2) check (pagibig_ee_monthly is null or pagibig_ee_monthly between 200 and 100000);

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
      last_name = case when p ? 'last_name' then btrim(coalesce(p ->> 'last_name', '')) else last_name end,
      first_name = case when p ? 'first_name' then btrim(coalesce(p ->> 'first_name', '')) else first_name end,
      middle_name = case when p ? 'middle_name' then btrim(coalesce(p ->> 'middle_name', '')) else middle_name end,
      name_ext = case when p ? 'name_ext' then btrim(coalesce(p ->> 'name_ext', '')) else name_ext end,
      pagibig_program = case when p ? 'pagibig_program' then coalesce(nullif(p ->> 'pagibig_program', ''), 'pagibig1') else pagibig_program end,
      mp2_account = case when p ? 'mp2_account' then public.gov_number_format('pagibig', p ->> 'mp2_account') else mp2_account end,
      pagibig_ee_monthly = case when p ? 'pagibig_ee_monthly' then nullif(p ->> 'pagibig_ee_monthly', '')::numeric else pagibig_ee_monthly end,
      updated_by = auth.uid(), updated_at = now()
    where user_id = v_user returning * into e;
  exception when check_violation then
    raise exception 'Check the numbers: TIN 9 or 12 digits, SSS 10, PhilHealth 12, Pag-IBIG and MP2 12; dates in order; names up to 80 letters; a chosen Pag-IBIG share of at least 200.' using errcode = '23514';
  when invalid_text_representation then
    raise exception 'The chosen Pag-IBIG share is pesos, e.g. 400.' using errcode = '22023';
  end;
  return to_jsonb(e) - 'updated_by';
end $$;

create or replace function public.payroll_run_compute(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare run public.payroll_runs; st public.payroll_settings; pr record; pp jsonb; p1 jsonb; first_run uuid; first_line public.payroll_lines;
  is_second boolean; ms date; adj_t numeric; adj_n numeric; adj_d numeric; adj1 numeric; gross numeric; taxable numeric;
  sss jsonb; ph jsonb; pgb jsonb; sss_ee numeric; sss_er numeric; sss_ec numeric; ph_ee numeric; ph_er numeric; pi_ee numeric; pi_er numeric;
  mon numeric; mwe boolean; mw numeric; tax numeric; wt jsonb; es public.employee_statutory;
  ye boolean; ann jsonb; cut numeric; at jsonb; room numeric; unwithheld numeric;
  pi_mand numeric; vol_month numeric; vol_this numeric; vol_first numeric;
begin
  select * into run from public.payroll_runs where id = p_run for update;
  if run.status <> 'draft' then raise exception 'Only a draft payroll is recomputed.' using errcode = '42501'; end if;
  select * into st from public.payroll_settings where id = 1;
  update public.payroll_runs set contributions_timing = st.contributions_timing where id = p_run;
  delete from public.payroll_lines where run_id = p_run;
  is_second := extract(day from run.period_start) > 1;
  -- The last cutoff of the year (16-31 December) carries the year-end adjustment (RR 11-2018, Sec. 2.79(B)(5)(b)).
  ye := is_second and extract(month from run.period_end) = 12 and st.year_end_adjustment;
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
    sss_ee := 0; sss_er := 0; sss_ec := 0; ph_ee := 0; ph_er := 0; pi_ee := 0; pi_er := 0; sss := null; ph := null; pgb := null; p1 := null; vol_this := 0;
    select * into es from public.employee_statutory where user_id = pr.id;
    if not is_second and st.contributions_timing = 'split' then
      -- First cutoff, split: half of a month at the rate.
      mon := case when pp ->> 'salary_type' = 'monthly' then (pp ->> 'monthly_rate')::numeric else round((pp ->> 'daily_rate')::numeric * st.divisor / 12, 2) end;
      sss := public.stat_sss(mon, run.period_end); ph := public.stat_philhealth(mon, run.period_end); pgb := public.stat_pagibig(mon, run.period_end);
      sss_ee := round((sss ->> 'employee')::numeric / 2, 2); sss_er := round(((sss ->> 'employer')::numeric - (sss ->> 'ec')::numeric) / 2, 2);
      sss_ec := round((sss ->> 'ec')::numeric / 2, 2);
      ph_ee := round((ph ->> 'employee')::numeric / 2, 2); ph_er := round((ph ->> 'employer')::numeric / 2, 2);
      pi_ee := round((pgb ->> 'employee')::numeric / 2, 2); pi_er := round((pgb ->> 'employer')::numeric / 2, 2);
      -- A higher Pag-IBIG share the employee chose (the part above the mandatory one): half on each cutoff.
      vol_month := greatest(coalesce(es.pagibig_ee_monthly, 0) - (pgb ->> 'employee')::numeric, 0);
      vol_this := round(vol_month / 2, 2); pi_ee := pi_ee + vol_this;
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
      vol_month := greatest(coalesce(es.pagibig_ee_monthly, 0) - (pgb ->> 'employee')::numeric, 0);
      vol_first := coalesce((first_line.basis ->> 'pagibig_voluntary')::numeric, 0);
      pi_mand := greatest((pgb ->> 'employee')::numeric - (coalesce(first_line.pi_ee, 0) - vol_first), 0);
      vol_this := greatest(vol_month - vol_first, 0);
      pi_ee := pi_mand + vol_this;
      pi_er := greatest((pgb ->> 'employer')::numeric - coalesce(first_line.pi_er, 0), 0);
    end if;
    mwe := coalesce(es.minimum_wage_earner, mw is not null and (pp ->> 'daily_rate')::numeric <= mw);
    if mwe then tax := 0; wt := jsonb_build_object('tax', 0, 'exempt', 'minimum wage earner');
    else wt := public.stat_withholding(greatest(taxable - sss_ee - ph_ee - (pi_ee - vol_this), 0), 'semi_monthly', run.period_end); tax := (wt ->> 'tax')::numeric; end if;
    if ye then
      -- Year-end: the annual table on the whole year's taxable pay, less everything withheld before this cutoff.
      -- A minimum-wage earner's minimum wage, holiday pay, premiums and overtime stay exempt; only other taxable pay counts.
      ann := public.annual_tax_person(pr.id, extract(year from run.period_end)::int, p_run, run.period_start);
      cut := case when mwe then case when st.allowance_taxable then (pp ->> 'allowance')::numeric else 0 end + adj_t
             else greatest(taxable - sss_ee - ph_ee - (pi_ee - vol_this), 0) end;
      if (ann ->> 'history_complete')::boolean then
        at := public.stat_annual_tax((ann ->> 'taxable')::numeric + cut, run.period_end);
        tax := round((at ->> 'tax')::numeric - (ann ->> 'withheld')::numeric, 2);
        -- A shortfall bigger than this pay can't all be withheld: the rest is the employer's to settle (Step 4).
        room := greatest(gross - sss_ee - ph_ee - pi_ee - adj_d, 0);
        unwithheld := greatest(tax - room, 0); tax := tax - unwithheld;
        wt := jsonb_build_object('year_end', 'adjusted', 'annual_taxable', (ann ->> 'taxable')::numeric + cut, 'this_cutoff', cut,
          'annual_tax', (at ->> 'tax')::numeric, 'withheld_before', (ann ->> 'withheld')::numeric, 'adjustment', tax, 'unwithheld', unwithheld,
          'rule', at -> 'rule', 'rule_status', at ->> 'rule_status', 'bracket_from', at -> 'bracket_from');
      else
        wt := wt || jsonb_build_object('year_end', 'missing_history');
      end if;
    end if;
    insert into public.payroll_lines values (p_run, pr.id, coalesce(pr.full_name, ''), pr.role::text, pp ->> 'employment_type', pp ->> 'salary_type',
      (pp ->> 'daily_rate')::numeric, (pp ->> 'days_worked')::int, (pp ->> 'worked_minutes')::int, (pp ->> 'deducted_minutes')::int,
      (pp ->> 'unaccounted_days')::int, (pp ->> 'basic_pay')::numeric, (pp ->> 'premium')::numeric, (pp ->> 'overtime_pay')::numeric,
      (pp ->> 'allowance')::numeric, adj_t, adj_n, adj_d, gross, taxable,
      sss_ee, sss_er, sss_ec, ph_ee, ph_er, pi_ee, pi_er, mwe, tax, gross - sss_ee - ph_ee - pi_ee - tax - adj_d,
      jsonb_build_object('first_cutoff', p1 is not null, 'first_run', first_run, 'scheduled_days', (pp ->> 'scheduled_days')::int,
        'sss', sss, 'philhealth', ph, 'pagibig', pgb, 'pagibig_voluntary', vol_this, 'withholding', wt, 'allowance_taxable', st.allowance_taxable),
      pp -> 'days');
  end loop;
  update public.payroll_runs set computed_at = now(), totals = (select jsonb_build_object('people', count(*), 'gross', coalesce(sum(gross), 0),
      'employee_contributions', coalesce(sum(sss_ee + ph_ee + pi_ee), 0), 'employer_contributions', coalesce(sum(sss_er + sss_ec + ph_er + pi_er), 0),
      'tax', coalesce(sum(tax), 0), 'deductions', coalesce(sum(adj_deductions), 0), 'net', coalesce(sum(net), 0),
      'unaccounted_days', coalesce(sum(unaccounted_days), 0), 'negative_net', count(*) filter (where net < 0))
    from public.payroll_lines where run_id = p_run)
  where id = p_run;
end $$;

create or replace function public.annual_tax_person(p_user uuid, p_year int, p_exclude uuid, p_current_start date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e record; l record; th numeric; cap numeric; first_start date; es public.employee_statutory; has_earlier boolean;
  p_taxable numeric := 0; p_withheld numeric := 0; p_gross numeric := 0; p_contrib numeric := 0; p_nontax numeric := 0; p_mwe numeric := 0; runs int := 0;
  v_benefits numeric; v_excess numeric; v_taxable numeric; v_withheld numeric; due jsonb; y_end date := make_date(p_year, 12, 31);
begin
  select coalesce(sum(t.taxable), 0) taxable, coalesce(sum(t.benefits), 0) benefits, coalesce(sum(t.de_minimis), 0) de_minimis,
         coalesce(sum(t.contributions), 0) contributions, coalesce(sum(t.mwe_exempt), 0) mwe_exempt, coalesce(sum(t.tax_withheld), 0) tax_withheld,
         coalesce(sum(t.taxable + t.benefits + t.de_minimis + t.contributions + t.mwe_exempt), 0) gross, count(*) n
    into e from public.tax_year_earlier t where t.user_id = p_user and t.year = p_year and t.voided_at is null;
  has_earlier := e.n > 0;
  for l in select pl.*, r.period_start from public.payroll_lines pl join public.payroll_runs r on r.id = pl.run_id
           where pl.user_id = p_user and r.status in ('approved', 'released') and r.id is distinct from p_exclude
             and r.period_start >= make_date(p_year, 1, 1) and r.period_end <= y_end loop
    runs := runs + 1;
    first_start := least(coalesce(first_start, l.period_start), l.period_start);
    p_gross := p_gross + l.gross; p_withheld := p_withheld + l.tax;
    p_contrib := p_contrib + l.sss_ee + l.ph_ee + l.pi_ee - coalesce((l.basis ->> 'pagibig_voluntary')::numeric, 0);
    if l.mwe then
      p_taxable := p_taxable + case when coalesce((l.basis ->> 'allowance_taxable')::boolean, true) then l.allowance else 0 end + l.adj_taxable;
      p_mwe := p_mwe + l.basic_pay + l.premium + l.overtime_pay;
      p_nontax := p_nontax + l.adj_nontaxable + case when coalesce((l.basis ->> 'allowance_taxable')::boolean, true) then 0 else l.allowance end;
    else
      p_taxable := p_taxable + greatest(l.taxable - l.sss_ee - l.ph_ee - l.pi_ee + coalesce((l.basis ->> 'pagibig_voluntary')::numeric, 0), 0);
      p_nontax := p_nontax + l.adj_nontaxable + case when coalesce((l.basis ->> 'allowance_taxable')::boolean, true) then 0 else l.allowance end;
    end if;
  end loop;
  th := coalesce((select sum(tl.amount) from public.thirteenth_lines tl join public.thirteenth_runs tr on tr.id = tl.run_id
                  where tl.user_id = p_user and tr.year = p_year and tr.status in ('approved', 'released')), 0);
  cap := coalesce(((public.statutory_rule_on('thirteenth_month', y_end)).params ->> 'tax_exempt_cap')::numeric, 90000);
  v_benefits := th + e.benefits;
  v_excess := greatest(v_benefits - cap, 0);
  v_taxable := e.taxable + p_taxable + v_excess;
  v_withheld := e.tax_withheld + p_withheld;
  due := public.stat_annual_tax(v_taxable, y_end);
  select * into es from public.employee_statutory where user_id = p_user;
  first_start := least(coalesce(first_start, p_current_start), coalesce(p_current_start, first_start));
  return jsonb_build_object('user_id', p_user, 'year', p_year,
    'earlier', jsonb_build_object('entries', e.n, 'gross', e.gross, 'taxable', e.taxable, 'benefits', e.benefits, 'de_minimis', e.de_minimis,
      'contributions', e.contributions, 'mwe_exempt', e.mwe_exempt, 'tax_withheld', e.tax_withheld),
    'portal', jsonb_build_object('runs', runs, 'first_cutoff', first_start, 'gross', p_gross, 'taxable', p_taxable, 'contributions', p_contrib,
      'nontaxable', p_nontax, 'mwe_exempt', p_mwe, 'tax_withheld', p_withheld),
    'thirteenth', th, 'benefits', v_benefits, 'benefits_cap', cap, 'benefits_excess', v_excess,
    'gross', e.gross + p_gross + th,
    'taxable', v_taxable, 'withheld', v_withheld, 'annual_tax', (due ->> 'tax')::numeric, 'difference', round((due ->> 'tax')::numeric - v_withheld, 2),
    'rule', due -> 'rule', 'rule_status', due ->> 'rule_status',
    'hired_on', es.hired_on, 'separated_on', es.separated_on,
    'history_complete', has_earlier or (es.hired_on is not null and first_start is not null and es.hired_on >= first_start));
end $$;

-- The month's file: who was paid in it, what was deducted and what the employer adds.
create function public.pagibig_remittance(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m date := date_trunc('month', p_month)::date; z date; cs public.compliance_settings; cp public.company_profile; rows jsonb; runs jsonb;
begin
  if not public.can_keep_books() then raise exception 'Pag-IBIG remittances are for the admin and the bookkeeper.' using errcode = '42501'; end if;
  z := (m + interval '1 month - 1 day')::date;
  select * into cs from public.compliance_settings where id = 1;
  select * into cp from public.company_profile where id = 1;
  select coalesce(jsonb_agg(jsonb_build_object('period_start', r.period_start, 'status', r.status) order by r.period_start), '[]'::jsonb) into runs
    from public.payroll_runs r where r.period_start between m and z and r.status <> 'void';
  select coalesce(jsonb_agg(x order by x ->> 'sort'), '[]'::jsonb) into rows from (
    select jsonb_build_object('sort', lower(coalesce(nullif(es.last_name, ''), pr.full_name)) || ' ' || lower(coalesce(es.first_name, '')),
      'user_id', pr.id, 'name', pr.full_name,
      'mid', coalesce(es.pagibig_no, ''), 'mp2', coalesce(es.mp2_account, ''),
      'program', case coalesce(es.pagibig_program, 'pagibig1') when 'pagibig2' then 'F1-Pag-IBIG 2' else 'F1-Pag-IBIG 1' end,
      'last_name', coalesce(es.last_name, ''), 'first_name', coalesce(es.first_name, ''), 'name_ext', coalesce(es.name_ext, ''), 'middle_name', coalesce(es.middle_name, ''),
      'percov', to_char(m, 'YYYYMM'), 'ee', sum(l.pi_ee), 'er', sum(l.pi_er),
      'remarks', concat_ws(' ', case when es.hired_on between m and z then 'N ' || to_char(es.hired_on, 'MM/DD/YY') end,
                                case when es.separated_on between m and z then 'RS ' || to_char(es.separated_on, 'MM/DD/YY') end),
      'problems', to_jsonb(array_remove(array[
        case when coalesce(es.pagibig_no, '') = '' then 'no Pag-IBIG MID number' end,
        case when coalesce(es.last_name, '') = '' or coalesce(es.first_name, '') = '' then 'last and first name not entered' end], null))) x
    from public.payroll_lines l join public.payroll_runs r on r.id = l.run_id join public.profiles pr on pr.id = l.user_id
    left join public.employee_statutory es on es.user_id = l.user_id
    where r.period_start between m and z and r.status in ('approved', 'released')
    group by pr.id, pr.full_name, es.user_id, es.pagibig_no, es.mp2_account, es.pagibig_program, es.last_name, es.first_name, es.name_ext, es.middle_name, es.hired_on, es.separated_on
    having sum(l.pi_ee) + sum(l.pi_er) > 0) t;
  return jsonb_build_object('month', to_char(m, 'YYYY-MM'), 'percov', to_char(m, 'YYYYMM'), 'runs', runs,
    'complete', (select count(*) from jsonb_array_elements(runs) e where e ->> 'status' in ('approved', 'released')) = 2,
    'employer', jsonb_build_object('id', cs.pagibig_employer_id, 'name', coalesce(nullif(cs.employer_name, ''), cp.legal_name),
      'address', coalesce(cp.address, ''), 'phones', coalesce(cp.phones, ''), 'email', coalesce(cp.email, '')),
    'rows', (select coalesce(jsonb_agg(e - 'sort'), '[]'::jsonb) from jsonb_array_elements(rows) e),
    'totals', jsonb_build_object('members', jsonb_array_length(rows),
      'ee', coalesce((select sum((e ->> 'ee')::numeric) from jsonb_array_elements(rows) e), 0),
      'er', coalesce((select sum((e ->> 'er')::numeric) from jsonb_array_elements(rows) e), 0)));
end $$;

revoke execute on function public.pagibig_remittance(date) from public, anon;
grant execute on function public.pagibig_remittance(date) to authenticated;
