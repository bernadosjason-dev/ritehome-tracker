-- v4.6: year-end tax adjustment and the BIR 2316 figures. Coordinating agent T02-A02; T02-A01 re-worked the figures.
--
-- Checked 2026-11-14 against RR 11-2018 (bir-cdn.bir.gov.ph/local/pdf/RR%20No.%2011-2018.pdf), Sec. 2.79(B)(5)(b):
--   the employer computes the year-end adjustment on the last payment of compensation in December:
--   Step 1-2 the year's taxable regular and supplementary compensation (with previous employers' in the same year);
--   Step 3 the annual table (2023 onwards: 0 to 250,000 none; 15% over 250,000; 22,500 + 20% over 400,000;
--     102,500 + 25% over 800,000; 402,500 + 30% over 2,000,000; 2,202,500 + 35% over 8,000,000);
--   Step 4 tax due less everything withheld since January: a shortfall is withheld from the last payment (what can't be
--     withheld is the employer's to settle with the employee); an excess is refunded by January 25 and deducted from the
--     employer's remittance of the month it is refunded.
--   Minimum-wage earners: no withholding on the minimum wage, holiday pay, overtime, night shift differential, hazard pay.
--   13th month and other benefits are non-taxable up to the cap in rule 'thirteenth_month' (90,000).
-- The table is the statutory rule 'bir_annual_income_tax' (pending the accountant). Nothing here files anything.
--
-- How the portal does it:
--   tax_year_earlier: pay before the portal's payroll in the year (this employer's old payroll, or a previous employer's
--     2316), entered with a reference; void-only.
--   annual_tax_person(user, year, exclude run, cutoff start): approved/released payroll lines of the year (taxable pay less
--     the employee's contributions; for a minimum-wage earner only the taxable allowance and taxable adjustments), plus
--     approved/released 13th month, plus the earlier entries. "History complete" when the person has an earlier entry for
--     the year or was hired on or after their first portal cutoff of the year: without it the year-end figure would be
--     wrong money, so the December 16-31 run can't be submitted until it's entered.
--   payroll_run_compute: on the 16-31 December run (setting year_end_adjustment, default on) each line's tax is the
--     year-end adjustment: negative is a refund paid with this cutoff.

alter table public.payroll_settings add column year_end_adjustment boolean not null default true;

insert into public.statutory_rules (agency, code, name, params, salary_basis, employee_share, employer_share, effective_from, source_title, source_url, verified_on, verified_by, notes) values
('BIR', 'bir_annual_income_tax', 'Annual income tax on compensation (TRAIN, 2023 onwards): year-end adjustment',
 '{"brackets":[[0,0,0],[250000,0,0.15],[400000,22500,0.20],[800000,102500,0.25],[2000000,402500,0.30],[8000000,2202500,0.35]]}',
 'Taxable compensation for the calendar year: gross less non-taxable pay (13th month and other benefits up to the cap, de minimis, a minimum-wage earner''s exempt pay) and the employee''s SSS, PhilHealth and Pag-IBIG',
 'All of it (withheld; the year-end difference in December)', 'None (the employer remits it; refunds are deducted from the remittance)',
 '2023-01-01', 'RR 11-2018, Sec. 2.79(B)(5)(b), Step 3(b): tax table for compensation earned in 2023 and onwards',
 'https://bir-cdn.bir.gov.ph/local/pdf/RR%20No.%2011-2018.pdf', '2026-11-14',
 'Agent (official BIR PDF, 2026-11-14; same table in RMC 34-2025 Annex A and PwC tax summaries)',
 'Each bracket: fixed tax + rate on the excess over its start. Year-end shortfall withheld from the last pay of December; excess refunded by January 25.');

create function public.stat_annual_tax(p_taxable numeric, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.statutory_rules := public.statutory_rule_on('bir_annual_income_tax', p_date); b jsonb; pick jsonb; t numeric := greatest(coalesce(p_taxable, 0), 0);
begin
  if r.id is null then return jsonb_build_object('rule', null, 'tax', 0, 'error', 'No annual tax table in force on ' || p_date); end if;
  for b in select * from jsonb_array_elements(r.params -> 'brackets') loop
    if t >= (b ->> 0)::numeric then pick := b; end if;
  end loop;
  return jsonb_build_object('rule', r.id, 'rule_status', r.status, 'taxable', t, 'bracket_from', (pick ->> 0)::numeric,
    'tax', round((pick ->> 1)::numeric + (pick ->> 2)::numeric * (t - (pick ->> 0)::numeric), 2));
end $$;

-- ------------------------------------------------------- earlier pay ----

create table public.tax_year_earlier (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  year int not null check (year between 2020 and 2100),
  source text not null check (source in ('this_employer', 'previous_employer')),
  employer_name text not null default '' check (length(employer_name) <= 160),
  employer_tin text not null default '' check (length(employer_tin) <= 20),
  taxable numeric(12,2) not null default 0 check (taxable between 0 and 100000000),
  benefits numeric(12,2) not null default 0 check (benefits between 0 and 100000000),
  de_minimis numeric(12,2) not null default 0 check (de_minimis between 0 and 100000000),
  contributions numeric(12,2) not null default 0 check (contributions between 0 and 100000000),
  mwe_exempt numeric(12,2) not null default 0 check (mwe_exempt between 0 and 100000000),
  tax_withheld numeric(12,2) not null default 0 check (tax_withheld between 0 and 100000000),
  reference text not null check (length(btrim(reference)) between 3 and 200),
  note text not null default '' check (length(note) <= 500),
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  voided_at timestamptz, voided_by uuid references public.profiles (id),
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 3 and 300),
  check ((voided_at is null) = (void_reason is null)),
  check (source = 'this_employer' or length(btrim(employer_name)) >= 2)
);
alter table public.tax_year_earlier enable row level security;
create policy "earlier pay: admin and bookkeeper read" on public.tax_year_earlier for select using (public.can_keep_books());
revoke insert, update, delete on public.tax_year_earlier from anon, authenticated;

create function public.tax_year_earlier_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'Earlier pay is kept: void the entry instead.' using errcode = '42501';
  end if;
  if old.voided_at is not null then raise exception 'A voided entry can''t be changed.' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason']) is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
    raise exception 'Earlier pay isn''t edited: void the entry and add the right one.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger tax_year_earlier_guard before update or delete on public.tax_year_earlier for each row execute function public.tax_year_earlier_guard();

-- p: {user_id, year, source, employer_name, employer_tin, taxable, benefits, de_minimis, contributions, mwe_exempt, tax_withheld, reference, note}
create function public.tax_year_earlier_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_user uuid := nullif(p ->> 'user_id', '')::uuid; v_id uuid; k text;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper keep year-end tax records.' using errcode = '42501'; end if;
  if v_user is null or not exists (select 1 from public.profiles where id = v_user) then raise exception 'Choose the person.' using errcode = '22023'; end if;
  if v_user = auth.uid() and not public.is_admin() then raise exception 'Only the admin enters your own pay.' using errcode = '42501'; end if;
  foreach k in array array['taxable', 'benefits', 'de_minimis', 'contributions', 'mwe_exempt', 'tax_withheld'] loop
    if coalesce(nullif(p ->> k, ''), '0') !~ '^\d+(\.\d{1,2})?$' then raise exception 'Amounts are pesos with up to two decimals (blank is zero).' using errcode = '22023'; end if;
  end loop;
  begin
    insert into public.tax_year_earlier (user_id, year, source, employer_name, employer_tin, taxable, benefits, de_minimis, contributions, mwe_exempt, tax_withheld, reference, note)
    values (v_user, (p ->> 'year')::int, coalesce(nullif(p ->> 'source', ''), 'this_employer'), btrim(coalesce(p ->> 'employer_name', '')), btrim(coalesce(p ->> 'employer_tin', '')),
      coalesce(nullif(p ->> 'taxable', ''), '0')::numeric, coalesce(nullif(p ->> 'benefits', ''), '0')::numeric, coalesce(nullif(p ->> 'de_minimis', ''), '0')::numeric,
      coalesce(nullif(p ->> 'contributions', ''), '0')::numeric, coalesce(nullif(p ->> 'mwe_exempt', ''), '0')::numeric, coalesce(nullif(p ->> 'tax_withheld', ''), '0')::numeric,
      btrim(coalesce(p ->> 'reference', '')), left(btrim(coalesce(p ->> 'note', '')), 500))
    returning id into v_id;
  exception when check_violation or not_null_violation or invalid_text_representation then
    raise exception 'Give the year, where the figures come from (e.g. "old payroll Jan-Nov" or the previous employer''s 2316), and the employer''s name for a previous employer.' using errcode = '23514';
  end;
  return jsonb_build_object('id', v_id);
end $$;

create function public.tax_year_earlier_void(p_id uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the admin voids an earlier-pay entry.' using errcode = '42501'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'Say why it''s void.' using errcode = '23514'; end if;
  update public.tax_year_earlier set voided_at = now(), voided_by = auth.uid(), void_reason = left(btrim(p_reason), 300) where id = p_id and voided_at is null;
  if not found then raise exception 'That entry isn''t open any more.' using errcode = 'P0002'; end if;
  return true;
end $$;

-- ------------------------------------------------------------ the year ----

create function public.annual_tax_person(p_user uuid, p_year int, p_exclude uuid, p_current_start date) returns jsonb
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
    p_gross := p_gross + l.gross; p_withheld := p_withheld + l.tax; p_contrib := p_contrib + l.sss_ee + l.ph_ee + l.pi_ee;
    if l.mwe then
      p_taxable := p_taxable + case when coalesce((l.basis ->> 'allowance_taxable')::boolean, true) then l.allowance else 0 end + l.adj_taxable;
      p_mwe := p_mwe + l.basic_pay + l.premium + l.overtime_pay;
      p_nontax := p_nontax + l.adj_nontaxable + case when coalesce((l.basis ->> 'allowance_taxable')::boolean, true) then 0 else l.allowance end;
    else
      p_taxable := p_taxable + greatest(l.taxable - l.sss_ee - l.ph_ee - l.pi_ee, 0);
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

-- The 2316 figures for everyone paid in a year: what the portal knows, with the December adjustment if that run exists.
create function public.annual_tax_list(p_year int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare dec_run public.payroll_runs;
begin
  if not public.can_keep_books() then raise exception 'Year-end tax is for the admin and the bookkeeper.' using errcode = '42501'; end if;
  select * into dec_run from public.payroll_runs where period_start = make_date(p_year, 12, 16) and status <> 'void';
  return jsonb_build_object('year', p_year, 'can_void', public.is_admin(),
    'settings', jsonb_build_object('year_end_adjustment', (select year_end_adjustment from public.payroll_settings where id = 1)),
    'rule', (select public.statutory_rule_json(public.statutory_rule_on('bir_annual_income_tax', make_date(p_year, 12, 31)))),
    'december_run', case when dec_run.id is null then null else jsonb_build_object('id', dec_run.id, 'status', dec_run.status) end,
    'people', coalesce((select jsonb_agg(public.annual_tax_person(pr.id, p_year, null, null)
        || jsonb_build_object('name', pr.full_name, 'active', pr.active,
          'december', (select jsonb_build_object('tax', pl.tax, 'basis', pl.basis -> 'withholding') from public.payroll_lines pl where pl.run_id = dec_run.id and pl.user_id = pr.id))
        order by lower(pr.full_name))
      from public.profiles pr
      where exists (select 1 from public.payroll_lines pl join public.payroll_runs r on r.id = pl.run_id
                    where pl.user_id = pr.id and r.status <> 'void' and extract(year from r.period_end) = p_year)
         or exists (select 1 from public.tax_year_earlier t where t.user_id = pr.id and t.year = p_year and t.voided_at is null)
         or (pr.active and exists (select 1 from public.salary_rates s where s.user_id = pr.id and s.effective_from <= make_date(p_year, 12, 31)))), '[]'::jsonb),
    'earlier', coalesce((select jsonb_agg(to_jsonb(t) - 'created_by' - 'voided_by' || jsonb_build_object('person', (select full_name from public.profiles where id = t.user_id),
        'by', (select full_name from public.profiles where id = t.created_by)) order by t.created_at)
      from public.tax_year_earlier t where t.year = p_year and t.voided_at is null), '[]'::jsonb));
end $$;

-- ---------------------------------------------------- payroll changes ----

create or replace function public.payroll_run_compute(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare run public.payroll_runs; st public.payroll_settings; pr record; pp jsonb; p1 jsonb; first_run uuid; first_line public.payroll_lines;
  is_second boolean; ms date; adj_t numeric; adj_n numeric; adj_d numeric; adj1 numeric; gross numeric; taxable numeric;
  sss jsonb; ph jsonb; pgb jsonb; sss_ee numeric; sss_er numeric; sss_ec numeric; ph_ee numeric; ph_er numeric; pi_ee numeric; pi_er numeric;
  mon numeric; mwe boolean; mw numeric; tax numeric; wt jsonb; es public.employee_statutory;
  ye boolean; ann jsonb; cut numeric; at jsonb; room numeric; unwithheld numeric;
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
    if ye then
      -- Year-end: the annual table on the whole year's taxable pay, less everything withheld before this cutoff.
      -- A minimum-wage earner's minimum wage, holiday pay, premiums and overtime stay exempt; only other taxable pay counts.
      ann := public.annual_tax_person(pr.id, extract(year from run.period_end)::int, p_run, run.period_start);
      cut := case when mwe then case when st.allowance_taxable then (pp ->> 'allowance')::numeric else 0 end + adj_t
             else greatest(taxable - sss_ee - ph_ee - pi_ee, 0) end;
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


create or replace function public.payroll_run_submit(p_run uuid) returns jsonb
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
  select string_agg(name, ', ' order by name) into who from public.payroll_lines where run_id = p_run and basis -> 'withholding' ->> 'year_end' = 'missing_history';
  if who is not null then
    raise exception 'Year-end tax needs the pay before the portal for: %. Enter it under Year-end tax (Add earlier pay), then submit.', who using errcode = '22023';
  end if;
  select string_agg(name, ', ' order by name) into who from public.payroll_lines where run_id = p_run and net < 0;
  if who is not null then raise exception 'Net pay below zero for %: check the deductions.', who using errcode = '22023'; end if;
  update public.payroll_runs set status = 'submitted', submitted_by = auth.uid(), submitted_at = now(), returned_note = null where id = p_run;
  return public.payroll_run_get(p_run);
end $$;

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
      year_end_adjustment = coalesce(s.year_end_adjustment, true),
      updated_by = auth.uid(), updated_at = now()
    where id = 1;
  exception when check_violation or not_null_violation then
    raise exception 'That setting is outside what the law allows here: check the rates and the payday rule.' using errcode = '23514';
  end;
  return public.payroll_settings_get();
end $$;

-- Payslips say when the tax line is the year-end adjustment (a negative one is a refund).
create or replace function public.payslips_mine() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(l) - 'basis' || jsonb_build_object('period_start', r.period_start, 'period_end', r.period_end,
      'release_date', r.release_date, 'status', r.status, 'released_at', r.released_at, 'year_end', l.basis -> 'withholding' ->> 'year_end',
      'adjustments', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'amount', a.amount, 'reason', a.reason) order by a.created_at)
        from public.payroll_adjustments a where a.run_id = r.id and a.user_id = l.user_id and a.status = 'approved'), '[]'::jsonb))
    order by r.period_start desc), '[]'::jsonb)
  from public.payroll_lines l join public.payroll_runs r on r.id = l.run_id
  where l.user_id = auth.uid() and r.status in ('approved', 'released')
$$;

revoke execute on function public.stat_annual_tax(numeric, date), public.annual_tax_person(uuid, int, uuid, date), public.tax_year_earlier_guard()
  from public, anon, authenticated;
revoke execute on function public.tax_year_earlier_add(jsonb), public.tax_year_earlier_void(uuid, text), public.annual_tax_list(int) from public, anon;
grant execute on function public.tax_year_earlier_add(jsonb), public.tax_year_earlier_void(uuid, text), public.annual_tax_list(int) to authenticated;

create trigger zz_audit after insert or update or delete on public.tax_year_earlier for each row execute function public.audit_row('user_id', 'year');

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
      'thirteenth_earlier', 'thirteenth_runs', 'tax_year_earlier') then 'Payroll'
    when p_table in ('compliance_records', 'compliance_settings') then 'Compliance'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;
