-- v4.0 (first part): the Philippine statutory rules engine and each person's government numbers.
-- The owner's brief of 2026-11-13 ("MAJOR PORTAL UPGRADE"), Part 2.
--
-- No rate is written into a formula. Every figure lives in a statutory_rules row: agency, the
-- parameters, the salary basis, floor and ceiling, the shares, effective dates, the official source,
-- when it was last verified and by whom, and its approval status. A rule is never edited: a law
-- change is a new row with its own effective date, and the old one stays for the months it covered.
--
-- The seeded rows were checked by the agent on 2026-11-13 against the official issuances named in
-- them, and are 'pending_review': the figures they give are labelled unapproved until the admin
-- approves each one, naming the accountant who checked it. The calculations use the newest approved
-- or pending rule in force on the date, and say which rule and its status.
--
-- Access: admin and bookkeeper (can_keep_books()) read rules, propose new ones and keep government
-- numbers; only the admin approves or retires a rule. Each person can read their own numbers.

create table public.statutory_rules (
  id uuid primary key default gen_random_uuid(),
  agency text not null check (agency in ('BIR', 'SSS', 'PhilHealth', 'Pag-IBIG', 'DOLE')),
  code text not null check (code ~ '^[a-z][a-z0-9_]{2,60}$'),
  name text not null check (length(btrim(name)) between 3 and 160),
  params jsonb not null,
  salary_basis text not null default '' check (length(salary_basis) <= 300),
  min_basis numeric(14,2),
  max_basis numeric(14,2),
  employee_share text not null default '' check (length(employee_share) <= 300),
  employer_share text not null default '' check (length(employer_share) <= 300),
  effective_from date not null,
  effective_to date,
  source_title text not null check (length(btrim(source_title)) between 3 and 300),
  source_url text not null default '' check (source_url = '' or source_url ~ '^https://'),
  verified_on date not null,
  verified_by text not null check (length(btrim(verified_by)) between 2 and 160),
  status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'retired')),
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  approval_note text check (approval_note is null or length(btrim(approval_note)) between 3 and 500),
  notes text not null default '' check (length(notes) <= 2000),
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default clock_timestamp(),
  check (effective_to is null or effective_to >= effective_from),
  check ((status = 'approved') = (approved_at is not null) or status = 'retired')
);
create index statutory_rules_lookup on public.statutory_rules (code, effective_from desc);
alter table public.statutory_rules enable row level security;
create policy "statutory rules: admin and bookkeeper read" on public.statutory_rules for select using (public.can_keep_books());
revoke insert, update, delete on public.statutory_rules from anon, authenticated;

-- Only the approval and retirement fields ever change; nothing is deleted.
create function public.statutory_rule_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Statutory rules are kept: retire it instead.' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['status', 'approved_by', 'approved_at', 'approval_note', 'effective_to'])
     is distinct from (to_jsonb(old) - array['status', 'approved_by', 'approved_at', 'approval_note', 'effective_to']) then
    raise exception 'A rule isn''t edited: add a new version with its effective date.' using errcode = '42501';
  end if;
  if old.status = 'retired' then raise exception 'A retired rule stays retired.' using errcode = '42501'; end if;
  return new;
end $$;
create trigger statutory_rule_guard before update or delete on public.statutory_rules
  for each row execute function public.statutory_rule_guard();

-- The rule for a code on a date: the newest approved or pending one in force (approved wins a tie).
create function public.statutory_rule_on(p_code text, p_date date) returns public.statutory_rules
language sql stable security definer set search_path = public as $$
  select * from public.statutory_rules
  where code = p_code and status in ('approved', 'pending_review') and effective_from <= p_date
    and (effective_to is null or effective_to >= p_date)
  order by effective_from desc, (status = 'approved') desc, created_at desc limit 1
$$;

create function public.statutory_rule_json(r public.statutory_rules) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(r) - 'created_by' - 'approved_by' || jsonb_build_object(
    'approver', (select full_name from public.profiles where id = r.approved_by),
    'author', coalesce((select full_name from public.profiles where id = r.created_by), 'Seeded from the official source'))
$$;

-- ------------------------------------------------------------------ seeds ----
-- Checked 2026-11-13 by the agent against the official documents linked; pending the accountant.

insert into public.statutory_rules (agency, code, name, params, salary_basis, min_basis, max_basis, employee_share, employer_share,
  effective_from, source_title, source_url, verified_on, verified_by, notes) values
('SSS', 'sss_contribution', 'SSS contributions, business employers and employees (2025 schedule)',
 '{"min_msc":5000,"max_msc":35000,"step":500,"ss_cap":20000,"ee_rate":0.05,"er_rate":0.10,"ec_low":10,"ec_high":30,"ec_from_msc":15000}',
 'Monthly Salary Credit from the month''s total compensation: below 5,250 = 5,000; then each 500 band (5,250-5,749.99 = 5,500 ...); 34,750 and over = 35,000',
 5000, 35000, '5% of the MSC (regular SS on the first 20,000, MPF on the rest)', '10% of the MSC plus Employees'' Compensation: 10 below an MSC of 15,000, 30 from 15,000',
 '2025-01-01', 'SSS Schedule of Contributions effective January 2025 (business employers and employees)',
 'https://www.sss.gov.ph/wp-content/uploads/2024/12/2025-SSS-Contribution-Table-rev.pdf', '2026-11-13', 'Agent (official PDF read 2026-11-13)',
 'Checked rows: below 5,250 -> EE 250, ER 510; 5,250-5,749.99 -> 275 / 560; 34,750 and over -> 1,750 / 3,530 (total 5,280).'),
('PhilHealth', 'philhealth_premium', 'PhilHealth premium, employed members',
 '{"rate":0.05,"floor":10000,"ceiling":100000,"employee_part":0.5}',
 'Monthly basic salary (excluding overtime, holiday premiums, allowances), held between the floor and the ceiling',
 10000, 100000, 'Half of 5% of the basis', 'Half of 5% of the basis',
 '2024-01-01', 'PhilHealth premium schedule: 5% of monthly basic salary, floor 10,000, ceiling 100,000 (UHC Act, RA 11223, Sec. 10)',
 'https://www.philhealth.gov.ph/circulars/', '2026-11-13', 'Agent (secondary sources 2026-11-13; the circular itself not read)',
 'Needs the accountant: confirm the circular number in force for 2026.'),
('Pag-IBIG', 'pagibig_savings', 'Pag-IBIG monthly savings (HDMF Circular No. 460)',
 '{"ee_rate_low":0.01,"low_up_to":1500,"ee_rate":0.02,"er_rate":0.02,"max_fund_salary":10000}',
 'Monthly compensation, up to the maximum fund salary of 10,000',
 0, 10000, '1% if the monthly compensation is 1,500 or less, else 2% (at most 200)', '2% (at most 200); never taken from the employee',
 '2024-02-01', 'HDMF Circular No. 460 (maximum fund salary raised to 10,000)',
 'https://www.dbm.gov.ph/wp-content/uploads/Issuances/2024/Circular-Letter/CIRCULAR-LETTER-NO-2024-2-DATED-FEBRUARY-01-2024.pdf', '2026-11-13', 'Agent (DBM circular letter quoting HDMF 460, 2026-11-13)',
 'Needs the accountant: confirm the effective month (February 2024) for private employers.'),
('BIR', 'bir_withholding_semi_monthly', 'Withholding tax on compensation, semi-monthly (TRAIN, 2023 onwards)',
 '{"brackets":[[0,0,0],[10417,0,0.15],[16667,937.50,0.20],[33333,4270.70,0.25],[83333,16770.70,0.30],[333333,91770.70,0.35]]}',
 'Taxable compensation for the period: gross less non-taxable pay and the employee''s SSS, PhilHealth and Pag-IBIG',
 null, null, 'All of it (withheld)', 'None (the employer remits it)',
 '2023-01-01', 'RR 11-2018, Annex E: Revised Withholding Tax Table effective January 1, 2023 and onwards',
 'https://bir-cdn.bir.gov.ph/local/pdf/Annex%20E%20RR%2011-2018.pdf', '2026-11-13', 'Agent (official BIR PDF, 2026-11-13)',
 'Each bracket: fixed tax + rate on the excess over its start.'),
('BIR', 'bir_withholding_monthly', 'Withholding tax on compensation, monthly (TRAIN, 2023 onwards)',
 '{"brackets":[[0,0,0],[20833,0,0.15],[33333,1875.00,0.20],[66667,8541.80,0.25],[166667,33541.80,0.30],[666667,183541.80,0.35]]}',
 'Taxable compensation for the month', null, null, 'All of it (withheld)', 'None (the employer remits it)',
 '2023-01-01', 'RR 11-2018, Annex E: Revised Withholding Tax Table effective January 1, 2023 and onwards',
 'https://bir-cdn.bir.gov.ph/local/pdf/Annex%20E%20RR%2011-2018.pdf', '2026-11-13', 'Agent (official BIR PDF, 2026-11-13)', ''),
('BIR', 'bir_withholding_weekly', 'Withholding tax on compensation, weekly (TRAIN, 2023 onwards)',
 '{"brackets":[[0,0,0],[4808,0,0.15],[7692,432.60,0.20],[15385,1971.20,0.25],[38462,7740.45,0.30],[153846,42355.65,0.35]]}',
 'Taxable compensation for the week', null, null, 'All of it (withheld)', 'None (the employer remits it)',
 '2023-01-01', 'RR 11-2018, Annex E: Revised Withholding Tax Table effective January 1, 2023 and onwards',
 'https://bir-cdn.bir.gov.ph/local/pdf/Annex%20E%20RR%2011-2018.pdf', '2026-11-13', 'Agent (official BIR PDF, 2026-11-13)', ''),
('BIR', 'bir_withholding_daily', 'Withholding tax on compensation, daily (TRAIN, 2023 onwards)',
 '{"brackets":[[0,0,0],[685,0,0.15],[1096,61.65,0.20],[2192,280.85,0.25],[5479,1102.60,0.30],[21918,6034.30,0.35]]}',
 'Taxable compensation for the day', null, null, 'All of it (withheld)', 'None (the employer remits it)',
 '2023-01-01', 'RR 11-2018, Annex E: Revised Withholding Tax Table effective January 1, 2023 and onwards',
 'https://bir-cdn.bir.gov.ph/local/pdf/Annex%20E%20RR%2011-2018.pdf', '2026-11-13', 'Agent (official BIR PDF, 2026-11-13)',
 'The PDF prints the top bracket''s fixed tax as "6,034.00.30"; 6,034.30 is taken (= 1,102.60 + 30% of 16,439). Accountant to confirm.'),
('DOLE', 'minimum_wage_daily', 'Daily minimum wage, Region X Wage Category I (Cagayan de Oro), first tranche',
 '{"daily":486}', 'Daily basic wage', null, null, '', '',
 '2026-01-16', 'Wage Order No. RX-24 (RTWPB Region X), first tranche',
 'https://nwpc.dole.gov.ph/region-x/', '2026-11-13', 'Agent (NWPC Region X page, 2026-11-13)', ''),
('DOLE', 'minimum_wage_daily', 'Daily minimum wage, Region X Wage Category I (Cagayan de Oro), second tranche',
 '{"daily":500}', 'Daily basic wage', null, null, '', '',
 '2026-05-01', 'Wage Order No. RX-24 (RTWPB Region X), second tranche',
 'https://nwpc.dole.gov.ph/region-x/', '2026-11-13', 'Agent (NWPC Region X page, 2026-11-13)',
 'Minimum-wage earners are exempt from withholding tax on their basic, holiday, overtime and night-shift pay.');

-- -------------------------------------------------------------- formulas ----
-- Each takes the amount and the date, finds the rule in force and returns the figures with the rule
-- id and status. Nothing here is stored; payroll runs (v4.1) will store what they used.

create function public.stat_sss(p_comp numeric, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.statutory_rules := public.statutory_rule_on('sss_contribution', p_date); x jsonb; msc numeric; ss numeric; mpf numeric; ec numeric;
begin
  if r.id is null then return jsonb_build_object('rule', null, 'error', 'No SSS rule in force on ' || p_date); end if;
  x := r.params;
  msc := least((x ->> 'max_msc')::numeric, greatest((x ->> 'min_msc')::numeric,
    (x ->> 'min_msc')::numeric + (x ->> 'step')::numeric
      * floor((greatest(coalesce(p_comp, 0), 0) - ((x ->> 'min_msc')::numeric - (x ->> 'step')::numeric / 2)) / (x ->> 'step')::numeric)));
  ss := least(msc, (x ->> 'ss_cap')::numeric); mpf := msc - ss;
  ec := case when msc >= (x ->> 'ec_from_msc')::numeric then (x ->> 'ec_high')::numeric else (x ->> 'ec_low')::numeric end;
  return jsonb_build_object('rule', r.id, 'rule_status', r.status, 'compensation', p_comp, 'msc', msc, 'msc_ss', ss, 'msc_mpf', mpf,
    'ee_ss', round(ss * (x ->> 'ee_rate')::numeric, 2), 'ee_mpf', round(mpf * (x ->> 'ee_rate')::numeric, 2),
    'er_ss', round(ss * (x ->> 'er_rate')::numeric, 2), 'er_mpf', round(mpf * (x ->> 'er_rate')::numeric, 2), 'ec', ec,
    'employee', round(msc * (x ->> 'ee_rate')::numeric, 2), 'employer', round(msc * (x ->> 'er_rate')::numeric, 2) + ec);
end $$;

create function public.stat_philhealth(p_basic numeric, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.statutory_rules := public.statutory_rule_on('philhealth_premium', p_date); x jsonb; base numeric; prem numeric; ee numeric;
begin
  if r.id is null then return jsonb_build_object('rule', null, 'error', 'No PhilHealth rule in force on ' || p_date); end if;
  x := r.params;
  base := least((x ->> 'ceiling')::numeric, greatest((x ->> 'floor')::numeric, coalesce(p_basic, 0)));
  prem := round(base * (x ->> 'rate')::numeric, 2); ee := round(prem * (x ->> 'employee_part')::numeric, 2);
  return jsonb_build_object('rule', r.id, 'rule_status', r.status, 'basic', p_basic, 'basis', base, 'premium', prem,
    'employee', ee, 'employer', prem - ee);
end $$;

create function public.stat_pagibig(p_comp numeric, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.statutory_rules := public.statutory_rule_on('pagibig_savings', p_date); x jsonb; fs numeric;
begin
  if r.id is null then return jsonb_build_object('rule', null, 'error', 'No Pag-IBIG rule in force on ' || p_date); end if;
  x := r.params;
  fs := least((x ->> 'max_fund_salary')::numeric, greatest(coalesce(p_comp, 0), 0));
  return jsonb_build_object('rule', r.id, 'rule_status', r.status, 'compensation', p_comp, 'fund_salary', fs,
    'employee', round(fs * case when coalesce(p_comp, 0) <= (x ->> 'low_up_to')::numeric then (x ->> 'ee_rate_low')::numeric else (x ->> 'ee_rate')::numeric end, 2),
    'employer', round(fs * (x ->> 'er_rate')::numeric, 2));
end $$;

-- p_period: 'daily', 'weekly', 'semi_monthly' or 'monthly'. Bracket = the last one whose start the
-- taxable amount reaches: fixed tax + rate x (taxable - start).
create function public.stat_withholding(p_taxable numeric, p_period text, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r public.statutory_rules := public.statutory_rule_on('bir_withholding_' || coalesce(p_period, ''), p_date); b jsonb; pick jsonb;
begin
  if p_period not in ('daily', 'weekly', 'semi_monthly', 'monthly') then raise exception 'Period is daily, weekly, semi_monthly or monthly.' using errcode = '22023'; end if;
  if r.id is null then return jsonb_build_object('rule', null, 'error', 'No withholding table in force on ' || p_date); end if;
  for b in select * from jsonb_array_elements(r.params -> 'brackets') loop
    if greatest(coalesce(p_taxable, 0), 0) >= (b ->> 0)::numeric then pick := b; end if;
  end loop;
  return jsonb_build_object('rule', r.id, 'rule_status', r.status, 'taxable', p_taxable, 'period', p_period,
    'bracket_from', (pick ->> 0)::numeric, 'tax', round((pick ->> 1)::numeric + (pick ->> 2)::numeric * (greatest(coalesce(p_taxable, 0), 0) - (pick ->> 0)::numeric), 2));
end $$;

create function public.stat_minimum_wage(p_date date) returns numeric
language sql stable security definer set search_path = public as $$
  select (params ->> 'daily')::numeric from public.statutory_rule_on('minimum_wage_daily', p_date) where id is not null
$$;

-- --------------------------------------------------- rules: list, propose, approve ----

create function public.statutory_rules_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Manila')::date;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper see the statutory rules.' using errcode = '42501'; end if;
  return jsonb_build_object('can_approve', public.is_admin(), 'rules', coalesce((select jsonb_agg(public.statutory_rule_json(r)
      || jsonb_build_object('in_force', r.id = (public.statutory_rule_on(r.code, today)).id)
      order by r.agency, r.code, r.effective_from desc, r.created_at desc) from public.statutory_rules r), '[]'::jsonb));
end $$;

-- A new version (admin or bookkeeper): always starts pending review.
create function public.statutory_rule_propose(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.statutory_rules;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper propose statutory rules.' using errcode = '42501'; end if;
  if jsonb_typeof(p -> 'params') is distinct from 'object' then raise exception 'Give the rule''s parameters.' using errcode = '22023'; end if;
  begin
    insert into public.statutory_rules (agency, code, name, params, salary_basis, min_basis, max_basis, employee_share, employer_share,
      effective_from, effective_to, source_title, source_url, verified_on, verified_by, notes)
    values (p ->> 'agency', p ->> 'code', btrim(coalesce(p ->> 'name', '')), p -> 'params', coalesce(p ->> 'salary_basis', ''),
      nullif(p ->> 'min_basis', '')::numeric, nullif(p ->> 'max_basis', '')::numeric, coalesce(p ->> 'employee_share', ''), coalesce(p ->> 'employer_share', ''),
      (p ->> 'effective_from')::date, nullif(p ->> 'effective_to', '')::date, btrim(coalesce(p ->> 'source_title', '')), coalesce(p ->> 'source_url', ''),
      coalesce(nullif(p ->> 'verified_on', '')::date, (now() at time zone 'Asia/Manila')::date),
      coalesce(nullif(btrim(p ->> 'verified_by'), ''), (select full_name from public.profiles where id = auth.uid())), coalesce(p ->> 'notes', ''))
    returning * into r;
  exception when check_violation or not_null_violation or invalid_datetime_format or invalid_text_representation then
    raise exception 'A rule needs the agency, a code, a name, the effective date and the official source.' using errcode = '23514';
  end;
  return public.statutory_rule_json(r);
end $$;

-- The admin approves (naming who checked it) or retires a rule.
create function public.statutory_rule_decide(p_id uuid, p_decision text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.statutory_rules;
begin
  if not public.is_admin() then raise exception 'Only the admin approves or retires statutory rules.' using errcode = '42501'; end if;
  if btrim(coalesce(p_note, '')) = '' or length(btrim(p_note)) < 3 then
    raise exception 'Say who checked it, or why it''s retired.' using errcode = '23514';
  end if;
  select * into r from public.statutory_rules where id = p_id;
  if not found then raise exception 'No such rule.' using errcode = 'P0002'; end if;
  if p_decision = 'approved' then
    if r.status <> 'pending_review' then raise exception 'Only a rule waiting for review is approved.' using errcode = '22023'; end if;
    update public.statutory_rules set status = 'approved', approved_by = auth.uid(), approved_at = now(), approval_note = left(btrim(p_note), 500)
    where id = p_id returning * into r;
  elsif p_decision = 'retired' then
    update public.statutory_rules set status = 'retired', approval_note = left(btrim(p_note), 500),
      effective_to = coalesce(effective_to, greatest(effective_from, (now() at time zone 'Asia/Manila')::date))
    where id = p_id returning * into r;
  else raise exception 'Approve or retire.' using errcode = '22023'; end if;
  return public.statutory_rule_json(r);
end $$;

-- --------------------------------------------------- government numbers ----

create table public.employee_statutory (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  tin text not null default '' check (tin = '' or tin ~ '^\d{3}-\d{3}-\d{3}(-\d{3,5})?$'),
  sss_no text not null default '' check (sss_no = '' or sss_no ~ '^\d{2}-\d{7}-\d$'),
  philhealth_no text not null default '' check (philhealth_no = '' or philhealth_no ~ '^\d{2}-\d{9}-\d$'),
  pagibig_no text not null default '' check (pagibig_no = '' or pagibig_no ~ '^\d{4}-\d{4}-\d{4}$'),
  birth_date date check (birth_date is null or birth_date between date '1930-01-01' and date '2015-01-01'),
  hired_on date,
  separated_on date check (separated_on is null or hired_on is null or separated_on >= hired_on),
  -- null = decided from the rate against the minimum wage; true/false = the admin or bookkeeper decided.
  minimum_wage_earner boolean,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);
alter table public.employee_statutory enable row level security;
create policy "government numbers: the person, the admin and the bookkeeper read" on public.employee_statutory for select
  using (user_id = auth.uid() or public.can_keep_books());
revoke insert, update, delete on public.employee_statutory from anon, authenticated;

-- Digits only are accepted and formatted (e.g. "123456789" -> "123-456-789").
create function public.gov_number_format(p_kind text, p_value text) returns text
language plpgsql immutable set search_path = public as $$
declare d text := regexp_replace(coalesce(p_value, ''), '\D', '', 'g');
begin
  if d = '' then return ''; end if;
  return case p_kind
    when 'tin' then case when length(d) = 9 then substr(d, 1, 3) || '-' || substr(d, 4, 3) || '-' || substr(d, 7, 3)
      when length(d) between 12 and 14 then substr(d, 1, 3) || '-' || substr(d, 4, 3) || '-' || substr(d, 7, 3) || '-' || substr(d, 10) else p_value end
    when 'sss' then case when length(d) = 10 then substr(d, 1, 2) || '-' || substr(d, 3, 7) || '-' || substr(d, 10, 1) else p_value end
    when 'philhealth' then case when length(d) = 12 then substr(d, 1, 2) || '-' || substr(d, 3, 9) || '-' || substr(d, 12, 1) else p_value end
    when 'pagibig' then case when length(d) = 12 then substr(d, 1, 4) || '-' || substr(d, 5, 4) || '-' || substr(d, 9, 4) else p_value end
    else p_value end;
end $$;

-- p: {user_id, tin, sss_no, philhealth_no, pagibig_no, birth_date, hired_on, separated_on, minimum_wage_earner}
-- Only the fields sent change. Nobody but the admin changes their own.
create function public.employee_statutory_save(p jsonb) returns jsonb
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
      updated_by = auth.uid(), updated_at = now()
    where user_id = v_user returning * into e;
  exception when check_violation then
    raise exception 'Check the numbers: TIN 9 or 12 digits, SSS 10, PhilHealth 12, Pag-IBIG 12; dates in order.' using errcode = '23514';
  end;
  return to_jsonb(e) - 'updated_by';
end $$;

-- Each active person: their numbers, their rate, whether they earn the minimum wage, and a full
-- month's contributions and withholding at their rate (an estimate: payroll runs use actual pay).
-- Monthly equivalent of a daily rate = daily x divisor / 12. Minimum-wage earners withhold nothing.
create function public.statutory_overview(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_date, (now() at time zone 'Asia/Manila')::date); mw numeric := public.stat_minimum_wage(d);
  div numeric := (select divisor from public.payroll_settings where id = 1);
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper see contributions.' using errcode = '42501'; end if;
  return jsonb_build_object('date', d, 'minimum_wage', mw, 'people', coalesce((select jsonb_agg(x order by lower(x ->> 'name')) from (
    select jsonb_build_object('id', pr.id, 'name', pr.full_name, 'role', pr.role, 'self', pr.id = auth.uid(),
      'numbers', coalesce(to_jsonb(es) - 'updated_by' - 'user_id', '{}'::jsonb),
      'rate', public.salary_rate_json(public.salary_rate_on(pr.id, d)), 'daily', dly, 'monthly', mon,
      'below_minimum', mw is not null and dly is not null and dly < mw,
      'mwe', coalesce(es.minimum_wage_earner, mw is not null and dly is not null and dly <= mw), 'mwe_decided', es.minimum_wage_earner is not null,
      'sss', case when mon is not null then public.stat_sss(mon, d) end,
      'philhealth', case when mon is not null then public.stat_philhealth(mon, d) end,
      'pagibig', case when mon is not null then public.stat_pagibig(mon, d) end) as x
    from public.profiles pr
    left join public.employee_statutory es on es.user_id = pr.id
    left join lateral (select (public.salary_rate_on(pr.id, d)).*) r on true
    left join lateral (select case when r.id is null then null when r.salary_type = 'daily' then r.rate else round(r.rate * 12 / div, 2) end as dly,
                              case when r.id is null then null when r.salary_type = 'monthly' then r.rate else round(r.rate * div / 12, 2) end as mon) m on true
    where pr.active) q), '[]'::jsonb));
end $$;

-- The withholding for a month's estimate is added by the page from stat_withholding (one call per
-- person would repeat the contributions); this wrapper keeps it in the database instead.
create function public.statutory_month_estimate(p_user uuid, p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o jsonb; p jsonb; ee numeric; taxable numeric;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper see contributions.' using errcode = '42501'; end if;
  o := public.statutory_overview(p_date);
  select x into p from jsonb_array_elements(o -> 'people') x where (x ->> 'id')::uuid = p_user;
  if p is null or p -> 'monthly' = 'null'::jsonb then return null; end if;
  ee := (p -> 'sss' ->> 'employee')::numeric + (p -> 'philhealth' ->> 'employee')::numeric + (p -> 'pagibig' ->> 'employee')::numeric;
  taxable := greatest((p ->> 'monthly')::numeric - ee, 0);
  return p || jsonb_build_object('employee_contributions', ee, 'taxable', taxable,
    'withholding', case when (p ->> 'mwe')::boolean then jsonb_build_object('tax', 0, 'exempt', 'minimum wage earner')
      else public.stat_withholding(taxable, 'monthly', coalesce(p_date, (now() at time zone 'Asia/Manila')::date)) end);
end $$;

revoke execute on function public.statutory_rule_on(text, date), public.statutory_rule_json(public.statutory_rules),
  public.statutory_rule_guard() from public, anon, authenticated;
revoke execute on function public.stat_sss(numeric, date), public.stat_philhealth(numeric, date), public.stat_pagibig(numeric, date),
  public.stat_withholding(numeric, text, date), public.stat_minimum_wage(date), public.statutory_rules_list(),
  public.statutory_rule_propose(jsonb), public.statutory_rule_decide(uuid, text, text), public.gov_number_format(text, text),
  public.employee_statutory_save(jsonb), public.statutory_overview(date), public.statutory_month_estimate(uuid, date) from public, anon;
-- The formulas only compute from an amount (no one's pay), so any signed-in page may use them; the
-- lists and saves check can_keep_books() themselves.
grant execute on function public.stat_sss(numeric, date), public.stat_philhealth(numeric, date), public.stat_pagibig(numeric, date),
  public.stat_withholding(numeric, text, date), public.stat_minimum_wage(date), public.statutory_rules_list(),
  public.statutory_rule_propose(jsonb), public.statutory_rule_decide(uuid, text, text), public.gov_number_format(text, text),
  public.employee_statutory_save(jsonb), public.statutory_overview(date), public.statutory_month_estimate(uuid, date) to authenticated;

-- ------------------------------------------------------------ activity log ----

create trigger zz_audit after insert or update or delete on public.statutory_rules
  for each row execute function public.audit_row('code', 'effective_from');
create trigger zz_audit after insert or update or delete on public.employee_statutory
  for each row execute function public.audit_row('user_id');

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
    when p_table in ('salary_rates', 'payroll_settings', 'statutory_rules', 'employee_statutory') then 'Payroll'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;
