-- v4.3: compliance records and calendar (the owner's brief of 2026-11-13, Part 2A tracking and Part 3).
-- Deadlines are statutory_rules rows (codes 'deadline_*'), so they carry the same source, verification date
-- and approval as the rates, and change by new versions, never by editing. Each month's (or year's)
-- obligation is computed from its rule: the due date, the amount from approved payroll runs, and its
-- status from what people recorded. Nothing here files or pays anything: "filed" and "paid" exist only
-- once someone records the reference of what they did in the agency's own system.
--
-- Checked 2026-11-13 (sources in each rule; all pending the accountant):
--   BIR 1601-C: the 10th of the following month (eFPS help page); December's: January 15 (secondary source).
--   BIR 2316 to each employee and BIR 1604-C: January 31 (BIR's own reminder; secondary source).
--   SSS: the last day of the month following (sss.gov.ph, regular employers).
--   PhilHealth: 11th-15th of the following month for PENs ending 0-4, 16th-20th for 5-9 (philhealth.gov.ph).
--   Pag-IBIG: by the employer name's first letter (A-D 10-14, E-L 15-19, M-Q 20-24, R-Z 25-end of month)
--     (secondary sources only).
--   13th-month pay: on or before December 24 (PD 851 implementing rules).
-- A deadline on a weekend or holiday is shown as the rule gives it; the page says to check the agency's rule.

-- ------------------------------------------------------------- settings ----

create table public.compliance_settings (
  id int primary key default 1 check (id = 1),
  tracking_from date not null default date '2026-12-01',   -- the first month whose obligations are tracked here
  bir_filing text not null default 'ebirforms' check (bir_filing in ('ebirforms', 'efps')),
  bir_rdo text not null default '' check (length(bir_rdo) <= 20),
  sss_employer_no text not null default '' check (sss_employer_no = '' or sss_employer_no ~ '^\d{2}-\d{7}-\d{1,4}$|^\d{10,13}$'),
  philhealth_pen text not null default '' check (philhealth_pen = '' or philhealth_pen ~ '^\d{2}-\d{9}-\d$|^\d{12}$'),
  pagibig_employer_id text not null default '' check (length(pagibig_employer_id) <= 20),
  employer_name text not null default 'Ritehome Modular Systems' check (length(btrim(employer_name)) between 1 and 160),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);
insert into public.compliance_settings (id) values (1);
alter table public.compliance_settings enable row level security;
create policy "compliance settings: admin and bookkeeper read" on public.compliance_settings for select using (public.can_keep_books());
revoke insert, update, delete on public.compliance_settings from anon, authenticated;

create function public.compliance_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.compliance_settings;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper keep compliance settings.' using errcode = '42501'; end if;
  if p ? 'tracking_from' and not public.is_admin() then raise exception 'Only the admin changes when tracking starts.' using errcode = '42501'; end if;
  select * into s from public.compliance_settings where id = 1;
  s := jsonb_populate_record(s, p - array['id', 'updated_by', 'updated_at']);
  begin
    update public.compliance_settings set tracking_from = date_trunc('month', s.tracking_from)::date, bir_filing = s.bir_filing,
      bir_rdo = btrim(s.bir_rdo), sss_employer_no = btrim(s.sss_employer_no), philhealth_pen = btrim(s.philhealth_pen),
      pagibig_employer_id = btrim(s.pagibig_employer_id), employer_name = btrim(s.employer_name), updated_by = auth.uid(), updated_at = now()
    where id = 1 returning * into s;
  exception when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format then
    raise exception 'Check the numbers: SSS employer number (10 to 13 digits), PhilHealth PEN (12 digits), and the dates.' using errcode = '23514';
  end;
  return to_jsonb(s) - 'updated_by';
end $$;

-- --------------------------------------------------------- deadline rules ----

insert into public.statutory_rules (agency, code, name, params, salary_basis, effective_from, source_title, source_url, verified_on, verified_by, notes) values
('BIR', 'deadline_1601c', 'BIR 1601-C: file and pay tax withheld on compensation, monthly',
 '{"frequency":"monthly","due":{"type":"day_of_next_month","day":10},"december":{"month":1,"day":15},"amount":"withholding","done":"paid"}',
 'Tax withheld in the month (approved payroll runs)', '2018-01-01', 'BIR Form 1601-C guidelines (eFPS help)', 'https://efps.bir.gov.ph/efps-war/EFPSWeb_war/help/help1601c_v2.html',
 '2026-11-13', 'Agent (eFPS help page; December date from a secondary source)',
 'eBIRForms and manual filers: the 10th of the following month. eFPS filers file by group, 11th to 15th: set the filing method. December''s return is due January 15 (secondary source: accountant to confirm).'),
('BIR', 'deadline_2316', 'BIR 2316: give each employee their certificate of compensation and tax withheld',
 '{"frequency":"annual","due":{"type":"fixed_next_year","month":1,"day":31},"amount":null,"done":"filed"}',
 'Each employee''s compensation and tax for the year', '2018-01-01', 'BIR tax deadline reminder (BIR''s own page)', 'https://www.facebook.com/birgovph/',
 '2026-11-13', 'Agent (BIR reminder post, 2026-11-13)', 'The copy filed with the BIR may have a later date: accountant to confirm.'),
('BIR', 'deadline_1604c', 'BIR 1604-C: annual information return of taxes withheld on compensation, with the alphalist',
 '{"frequency":"annual","due":{"type":"fixed_next_year","month":1,"day":31},"amount":null,"done":"filed"}',
 'The year''s compensation and tax withheld, per employee', '2018-01-01', 'Secondary sources (payroll compliance guides), RR 11-2018', 'https://www.bir.gov.ph/bir-forms',
 '2026-11-13', 'Agent (secondary sources)', 'Accountant to confirm the deadline and the alphalist format.'),
('SSS', 'deadline_sss', 'SSS: remit employee and employer contributions (and EC), monthly',
 '{"frequency":"monthly","due":{"type":"last_day_of_next_month"},"amount":"sss","done":"paid"}',
 'The month''s SSS contributions (approved payroll runs)', '2019-01-01', 'SSS: Pay contributions (regular employers)', 'https://www.sss.gov.ph/pay-contribution/',
 '2026-11-13', 'Agent (sss.gov.ph, 2026-11-13)', 'Regular employers: the last day of the month following the applicable month.'),
('PhilHealth', 'deadline_philhealth', 'PhilHealth: remit premiums, monthly',
 '{"frequency":"monthly","due":{"type":"by_pen_digit","ranges":[[0,4,15],[5,9,20]],"default":15},"amount":"philhealth","done":"paid"}',
 'The month''s PhilHealth premiums (approved payroll runs)', '2014-01-01', 'PhilHealth: Payment and reporting procedures (employers)', 'https://www.philhealth.gov.ph/partners/employers/pay_procedures.php',
 '2026-11-13', 'Agent (philhealth.gov.ph, 2026-11-13)', 'PEN ending 0-4: the 11th to the 15th of the following month; 5-9: the 16th to the 20th. Without the PEN the earlier deadline is used.'),
('Pag-IBIG', 'deadline_pagibig', 'Pag-IBIG: remit members'' savings and the employer counterpart, monthly',
 '{"frequency":"monthly","due":{"type":"by_name_letter","ranges":[["A","D",14],["E","L",19],["M","Q",24],["R","Z",31]],"default":14},"amount":"pagibig","done":"paid"}',
 'The month''s Pag-IBIG contributions (approved payroll runs)', '2014-01-01', 'Secondary sources (payroll remittance guides)', 'https://www.pagibigfund.gov.ph/',
 '2026-11-13', 'Agent (secondary sources)', 'Window by the employer name''s first letter: A-D 10th-14th, E-L 15th-19th, M-Q 20th-24th, R-Z and numerals 25th to the month''s end. Accountant to confirm.'),
('DOLE', 'deadline_13th_month', '13th-month pay to rank-and-file employees',
 '{"frequency":"annual","due":{"type":"fixed_same_year","month":12,"day":24},"amount":null,"done":"paid"}',
 'Basic salary earned in the year / 12', '1975-12-16', 'Presidential Decree No. 851 and its implementing rules', 'https://www.dole.gov.ph/',
 '2026-11-13', 'Agent (PD 851)', 'Pay on or before December 24. The amount comes with the 13th-month module.');

-- ---------------------------------------------------------------- records ----

-- One row per thing someone did: filed (the return was submitted) or paid (the money was remitted), with the
-- reference from the agency's system. Never edited or deleted; a wrong one is voided with a reason.
create table public.compliance_records (
  id uuid primary key default gen_random_uuid(),
  rule_code text not null check (rule_code ~ '^deadline_[a-z0-9_]+$'),
  period text not null check (period ~ '^\d{4}(-\d{2})?$'),
  kind text not null check (kind in ('filed', 'paid')),
  reference text not null check (length(btrim(reference)) between 3 and 200),
  on_date date not null,
  amount numeric(14,2) check (amount is null or amount >= 0),
  note text not null default '' check (length(note) <= 1000),
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  voided_at timestamptz, voided_by uuid references public.profiles (id),
  void_reason text check (void_reason is null or length(btrim(void_reason)) between 3 and 300),
  check ((voided_at is null) = (void_reason is null)),
  check (kind <> 'paid' or amount is not null)
);
create index compliance_records_by_period on public.compliance_records (rule_code, period) where voided_at is null;
alter table public.compliance_records enable row level security;
create policy "compliance records: admin and bookkeeper read" on public.compliance_records for select using (public.can_keep_books());
revoke insert, update, delete on public.compliance_records from anon, authenticated;

create function public.compliance_record_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Compliance records are kept: void it instead.' using errcode = '42501'; end if;
  if old.voided_at is not null then raise exception 'A voided record can''t be changed.' using errcode = '42501'; end if;
  if (to_jsonb(new) - array['voided_at', 'voided_by', 'void_reason']) is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'void_reason']) then
    raise exception 'Compliance records aren''t edited: void it and record the right one.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger compliance_record_guard before update or delete on public.compliance_records for each row execute function public.compliance_record_guard();

-- --------------------------------------------------------------- the maths ----

-- The due date of a rule's obligation for a period ('YYYY-MM' monthly, 'YYYY' annual).
create function public.compliance_due(p_rule public.statutory_rules, p_period text) returns date
language plpgsql stable security definer set search_path = public as $$
declare d jsonb := p_rule.params -> 'due'; s public.compliance_settings; m date; y int; digit int; letter text; r jsonb; v int;
begin
  select * into s from public.compliance_settings where id = 1;
  if p_rule.params ->> 'frequency' = 'annual' then
    y := left(p_period, 4)::int;
    return case d ->> 'type' when 'fixed_next_year' then make_date(y + 1, (d ->> 'month')::int, (d ->> 'day')::int)
      else make_date(y, (d ->> 'month')::int, (d ->> 'day')::int) end;
  end if;
  m := (p_period || '-01')::date;
  if extract(month from m) = 12 and p_rule.params ? 'december' then
    return make_date(extract(year from m)::int + 1, (p_rule.params -> 'december' ->> 'month')::int, (p_rule.params -> 'december' ->> 'day')::int);
  end if;
  if d ->> 'type' = 'day_of_next_month' then return (m + interval '1 month')::date + ((d ->> 'day')::int - 1); end if;
  if d ->> 'type' = 'last_day_of_next_month' then return (m + interval '2 months - 1 day')::date; end if;
  if d ->> 'type' = 'by_pen_digit' then
    digit := nullif(right(regexp_replace(s.philhealth_pen, '\D', '', 'g'), 1), '')::int;
    v := (d ->> 'default')::int;
    if digit is not null then for r in select * from jsonb_array_elements(d -> 'ranges') loop
      if digit between (r ->> 0)::int and (r ->> 1)::int then v := (r ->> 2)::int; end if; end loop; end if;
    return (m + interval '1 month')::date + (v - 1);
  end if;
  if d ->> 'type' = 'by_name_letter' then
    letter := upper(left(btrim(s.employer_name), 1)); v := (d ->> 'default')::int;
    for r in select * from jsonb_array_elements(d -> 'ranges') loop
      if letter between (r ->> 0) and (r ->> 1) then v := (r ->> 2)::int; end if; end loop;
    if letter ~ '^[0-9]$' then v := 31; end if;
    return least((m + interval '1 month')::date + (v - 1), (m + interval '2 months - 1 day')::date);
  end if;
  return null;
end $$;

-- Every tracked obligation with a due date in [p_from, p_to], plus any earlier one still open (overdue).
create function public.compliance_list(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.compliance_settings; today date := (now() at time zone 'Asia/Manila')::date; v jsonb := '[]'::jsonb;
  r public.statutory_rules; per text; due date; amt numeric; done_kind text; recs jsonb; st text; runs int; approved int; m date; y int;
begin
  if not public.can_keep_books() then raise exception 'Compliance is for the admin and the bookkeeper.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then raise exception 'Choose up to 800 days.' using errcode = '22023'; end if;
  select * into s from public.compliance_settings where id = 1;
  for r in select distinct on (code) * from public.statutory_rules where code like 'deadline\_%' and status in ('approved', 'pending_review')
           order by code, effective_from desc, (status = 'approved') desc, created_at desc loop
    -- Candidate periods: months (or years) from tracking_from up to p_to.
    for per in
      select to_char(g, case when r.params ->> 'frequency' = 'annual' then 'YYYY' else 'YYYY-MM' end)
      from generate_series(case when r.params ->> 'frequency' = 'annual' then date_trunc('year', s.tracking_from) else s.tracking_from end,
                           p_to, case when r.params ->> 'frequency' = 'annual' then interval '1 year' else interval '1 month' end) g
    loop
      due := public.compliance_due(r, per);
      continue when due is null or due > p_to;
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'reference', c.reference, 'on_date', c.on_date, 'amount', c.amount,
          'note', c.note, 'by', (select full_name from public.profiles where id = c.created_by)) order by c.created_at), '[]'::jsonb)
        into recs from public.compliance_records c where c.rule_code = r.code and c.period = per and c.voided_at is null;
      done_kind := r.params ->> 'done';
      st := case when exists (select 1 from jsonb_array_elements(recs) x where x ->> 'kind' = done_kind) then 'done'
                 when due < today then 'overdue' when due - today <= 5 then 'due_soon' else 'upcoming' end;
      continue when due < p_from and st <> 'overdue';
      -- The amount from approved payroll runs whose cutoff falls in the month.
      amt := null; runs := 0; approved := 0;
      if r.params ->> 'amount' is not null and length(per) = 7 then
        m := (per || '-01')::date;
        select sum(case r.params ->> 'amount' when 'withholding' then l.tax when 'sss' then l.sss_ee + l.sss_er + l.sss_ec
            when 'philhealth' then l.ph_ee + l.ph_er when 'pagibig' then l.pi_ee + l.pi_er end) filter (where pr.status in ('approved', 'released'))
        into amt
        from public.payroll_runs pr left join public.payroll_lines l on l.run_id = pr.id
        where pr.status <> 'void' and pr.period_start >= m and pr.period_start < m + interval '1 month';
        select count(*), count(*) filter (where status in ('approved', 'released')) into runs, approved from public.payroll_runs
        where status <> 'void' and period_start >= m and period_start < m + interval '1 month';
      end if;
      v := v || jsonb_build_object('code', r.code, 'agency', r.agency, 'name', r.name, 'period', per, 'due', due, 'status', st,
        'rule_status', r.status, 'source_title', r.source_title, 'source_url', r.source_url, 'rule_notes', r.notes, 'done_kind', done_kind,
        'amount', case when r.params ->> 'amount' is null then null when approved = 2 then round(coalesce(amt, 0), 2) end,
        'amount_partial', case when r.params ->> 'amount' is not null and approved between 1 and 1 then round(coalesce(amt, 0), 2) end,
        'payroll_runs', runs, 'payroll_approved', approved, 'records', recs,
        'weekend', extract(isodow from due) in (6, 7) or public.holiday_on(due) is not null);
    end loop;
  end loop;
  return jsonb_build_object('settings', to_jsonb(s) - 'updated_by', 'can_void', public.is_admin(),
    'items', coalesce((select jsonb_agg(x order by x ->> 'due', x ->> 'agency') from jsonb_array_elements(v) x), '[]'::jsonb));
end $$;

-- p: {code, period, kind ('filed' | 'paid'), reference, on_date, amount, note}
create function public.compliance_record_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_date date;
begin
  if not public.can_keep_books() then raise exception 'Only the admin and the bookkeeper record filings and payments.' using errcode = '42501'; end if;
  if not exists (select 1 from public.statutory_rules where code = p ->> 'code' and code like 'deadline\_%') then raise exception 'No such obligation.' using errcode = 'P0002'; end if;
  v_date := nullif(p ->> 'on_date', '')::date;
  if v_date is null or v_date > (now() at time zone 'Asia/Manila')::date then raise exception 'Give the date it was done (not in the future).' using errcode = '22023'; end if;
  if p ->> 'kind' = 'paid' and coalesce(p ->> 'amount', '') !~ '^\d+(\.\d{1,2})?$' then raise exception 'Give the amount paid, in pesos.' using errcode = '22023'; end if;
  begin
    insert into public.compliance_records (rule_code, period, kind, reference, on_date, amount, note)
    values (p ->> 'code', p ->> 'period', p ->> 'kind', btrim(coalesce(p ->> 'reference', '')), v_date,
      case when p ->> 'kind' = 'paid' then (p ->> 'amount')::numeric else nullif(p ->> 'amount', '')::numeric end, left(btrim(coalesce(p ->> 'note', '')), 1000))
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'Record what was done (filed or paid) with the reference number from the agency''s system.' using errcode = '23514';
  end;
  return jsonb_build_object('id', v_id);
end $$;

create function public.compliance_record_void(p_id uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the admin voids a compliance record.' using errcode = '42501'; end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'Say why it''s void.' using errcode = '23514'; end if;
  update public.compliance_records set voided_at = now(), voided_by = auth.uid(), void_reason = left(btrim(p_reason), 300) where id = p_id and voided_at is null;
  if not found then raise exception 'That record isn''t open any more.' using errcode = 'P0002'; end if;
  return true;
end $$;

revoke execute on function public.compliance_due(public.statutory_rules, text), public.compliance_record_guard() from public, anon, authenticated;
revoke execute on function public.compliance_settings_save(jsonb), public.compliance_list(date, date), public.compliance_record_add(jsonb),
  public.compliance_record_void(uuid, text) from public, anon;
grant execute on function public.compliance_settings_save(jsonb), public.compliance_list(date, date), public.compliance_record_add(jsonb),
  public.compliance_record_void(uuid, text) to authenticated;

create trigger zz_audit after insert or update or delete on public.compliance_records for each row execute function public.audit_row('rule_code', 'period', 'kind');
create trigger zz_audit after insert or update or delete on public.compliance_settings for each row execute function public.audit_row('id');

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
    when p_table in ('compliance_records', 'compliance_settings') then 'Compliance'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;
