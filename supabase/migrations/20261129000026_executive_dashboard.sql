-- v4.2: the executive dashboard (the owner's brief of 2026-11-13, Parts 4-7 and 9). Read-only: every
-- function here only reads, and the page has no forms. Admin and bookkeeper (can_keep_books()); the
-- dashboard page itself is the admin's ("/"). Nothing is stored: figures are computed when asked.
--
-- Money is kept in separate boxes and never added across them:
--   actual   = the books (acct_gl): cash on hand, in bank and e-wallets; income and costs by month.
--   owed     = receivables (contract price less what was received) and liabilities in the books.
--   estimate = pay from attendance so far (pay_day_calc), labelled an estimate until approved.
--   forecast = only with 6 months of books, a 3-month moving average of net cash flow, labelled with
--              its assumption and a low confidence; otherwise "not enough history" and nothing else.
-- Risks are rules on real records; each says why it fired and where to act.

create function public.executive_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  per jsonb := public.pay_period(today);
  books_start date := (select books_start from public.acct_settings limit 1);
  v_org jsonb; v_fin jsonb; v_pay jsonb; v_risks jsonb := '[]'::jsonb; v_months jsonb; v_fc jsonb;
  n_hist int; cash numeric; recv numeric; recv_n int; staff int; mw numeric := public.stat_minimum_wage(today);
  est numeric; fc_rest numeric; rest_days int; norate int;
  r record;
begin
  if not public.can_keep_books() then raise exception 'The executive dashboard is for the admin and the bookkeeper.' using errcode = '42501'; end if;

  -- ---------------------------------------------------------- organisation
  staff := (select count(*) from public.profiles where active and role <> 'admin');
  with open_p as (
    select d.id, d.data from public.tracker_docs d
    where d.collection = 'projects' and coalesce(d.data ->> 'status', 'active') not in ('completed', 'cancelled')
  ), st as (
    select s.project_id, count(*) as n, count(*) filter (where s.status = 'done') as done,
      count(*) filter (where s.status <> 'done' and s.planned_end < today) as late
    from public.project_stages s join open_p on open_p.id = s.project_id group by s.project_id
  )
  select jsonb_build_object(
    'people', (select count(*) from public.profiles where active),
    'staff', staff,
    'by_role', coalesce((select jsonb_object_agg(role, n) from (select role::text, count(*) n from public.profiles where active group by role) x), '{}'::jsonb),
    'today', jsonb_build_object(
      'present', (select count(distinct user_id) from public.attendance_punches where work_date = today),
      'on_leave', (select count(*) from public.attendance_records where work_date = today and kind = 'leave' and voided_at is null),
      'absent', (select count(*) from public.attendance_records where work_date = today and kind = 'absent' and voided_at is null),
      'holiday', public.holiday_on(today), 'sunday', extract(isodow from today) = 7),
    -- The last 14 working days (Mon-Sat, not holidays): how many of the staff clocked in.
    'trend', coalesce((select jsonb_agg(jsonb_build_object('date', g.d::date,
        'present', (select count(distinct p.user_id) from public.attendance_punches p join public.profiles pr on pr.id = p.user_id and pr.role <> 'admin' where p.work_date = g.d::date),
        'staff', (select count(*) from public.profiles pr where pr.active and pr.role <> 'admin' and (pr.created_at at time zone 'Asia/Manila')::date <= g.d::date)) order by g.d)
      from (select d from generate_series(today - 20, today - 1, interval '1 day') d
            where extract(isodow from d) <> 7 and public.holiday_on(d::date) is null order by d desc limit 14) g), '[]'::jsonb),
    'pending', jsonb_build_object(
      'approvals', (select count(*) from public.stage_submissions where decision = 'pending'),
      'stages_blocked', (select count(*) from public.project_stages s join open_p on open_p.id = s.project_id where s.status = 'blocked'),
      'stages_late', (select coalesce(sum(late), 0) from st),
      'leads_unanswered', (select count(*) from public.leads where stage = 'new' and first_response_at is null),
      'punches_to_check', (select count(*) from public.attendance_punches where cardinality(flags) > 0 and reviewed_at is null),
      'payroll_adjustments', (select count(*) from public.payroll_adjustments where status = 'pending'),
      'payroll_to_approve', (select count(*) from public.payroll_runs where status = 'submitted')),
    'projects', jsonb_build_object(
      'open', (select count(*) from open_p),
      'late_target', (select count(*) from open_p where public.acct_date(open_p.data ->> 'targetDate') < today),
      'with_late_stages', (select count(*) from st where late > 0),
      'progress', (select round(100.0 * sum(done) / nullif(sum(n), 0)) from st),
      'completed_30d', (select count(*) from public.tracker_docs d where d.collection = 'projects' and d.data ->> 'status' = 'completed'
                        and d.updated_at >= now() - interval '30 days'))
  ) into v_org;

  -- --------------------------------------------------------------- money
  cash := coalesce((select sum(debit - credit) from public.acct_gl where account_code in ('1010', '1020', '1030') and entry_date <= today), 0);
  select coalesce(sum(balance) filter (where balance > 0), 0), count(*) filter (where balance > 0) into recv, recv_n from public.acct_receivables();
  select coalesce(jsonb_agg(m order by m ->> 'month'), '[]'::jsonb) into v_months from (
    select jsonb_build_object('month', to_char(g.m, 'YYYY-MM'),
      'income', coalesce(sum(case when a.type = 'revenue' then l.credit - l.debit end), 0),
      'costs', coalesce(sum(case when a.type in ('cost_of_sales', 'expense') then l.debit - l.credit end), 0),
      'cash_in', coalesce(sum(case when l.account_code in ('1010', '1020', '1030') then l.debit end), 0),
      'cash_out', coalesce(sum(case when l.account_code in ('1010', '1020', '1030') then l.credit end), 0),
      'activity', count(l.account_code)) as m
    from generate_series(date_trunc('month', today) - interval '11 months', date_trunc('month', today), interval '1 month') g(m)
    left join public.acct_gl l on l.entry_date >= g.m::date and l.entry_date < (g.m + interval '1 month')::date
    left join public.acct_accounts a on a.code = l.account_code
    group by g.m) x;
  n_hist := (select count(*) from jsonb_array_elements(v_months) m where (m ->> 'activity')::int > 0 and (m ->> 'month') < to_char(today, 'YYYY-MM'));
  if n_hist >= 6 then
    -- Forecast: the average net cash flow of the last 3 full months, carried 3 months ahead from today's cash.
    select round(avg(net), 2) into fc_rest from (select ((m ->> 'cash_in')::numeric - (m ->> 'cash_out')::numeric) as net
      from jsonb_array_elements(v_months) m where (m ->> 'month') < to_char(today, 'YYYY-MM') order by m ->> 'month' desc limit 3) l3;
    v_fc := jsonb_build_object('available', true, 'confidence', 'low', 'method', '3-month moving average of net cash flow',
      'assumptions', 'Cash in and out continue at the average of the last three full months; no one-off payments; receivables not collected early.',
      'monthly_net', fc_rest,
      'months', (select jsonb_agg(jsonb_build_object('month', to_char(date_trunc('month', today) + (k || ' month')::interval, 'YYYY-MM'),
        'cash', round(cash + fc_rest * k, 2)) order by k) from generate_series(1, 3) k));
  else
    v_fc := jsonb_build_object('available', false, 'months_of_history', n_hist,
      'reason', 'A forecast needs at least 6 full months of books; there are ' || n_hist || '. Nothing is projected until then.');
  end if;
  v_fin := jsonb_build_object('books_start', books_start,
    'actual', jsonb_build_object('cash', round(cash, 2),
      'cash_by_account', coalesce((select jsonb_object_agg(account_code, round(s, 2)) from (select account_code, sum(debit - credit) s from public.acct_gl
        where account_code in ('1010', '1020', '1030') and entry_date <= today group by account_code) c), '{}'::jsonb)),
    'owed_to_us', jsonb_build_object('receivables', round(recv, 2), 'projects', recv_n),
    'we_owe', jsonb_build_object(
      'payables', round(coalesce((select sum(credit - debit) from public.acct_gl where account_code in ('2010', '2020') and entry_date <= today), 0), 2),
      'tax', round(coalesce((select sum(credit - debit) from public.acct_gl where account_code in ('2110', '2120') and entry_date <= today), 0), 2),
      'contributions', round(coalesce((select sum(credit - debit) from public.acct_gl where account_code = '2130' and entry_date <= today), 0), 2),
      'loans', round(coalesce((select sum(credit - debit) from public.acct_gl where account_code = '2300' and entry_date <= today), 0), 2),
      'liabilities', round(coalesce((select sum(l.credit - l.debit) from public.acct_gl l join public.acct_accounts a on a.code = l.account_code
        where a.type = 'liability' and l.entry_date <= today), 0), 2),
      'tracked', exists (select 1 from public.acct_gl where account_code in ('2010', '2020', '2300'))),
    'months', v_months, 'forecast', v_fc);

  -- -------------------------------------------------------------- payroll
  select coalesce(sum((public.pay_day_calc(p.id, g.d::date) ->> 'total')::numeric), 0) into est
  from public.profiles p cross join generate_series((per ->> 'start')::date, today, interval '1 day') g(d)
  where p.active and exists (select 1 from public.salary_rates s where s.user_id = p.id);
  -- Forecast for the rest of the cutoff: each rated person's daily rate for each working day left.
  rest_days := (select count(*) from generate_series(today + 1, (per ->> 'end')::date, interval '1 day') d
                where extract(isodow from d) <> 7 and public.holiday_on(d::date) is null);
  fc_rest := coalesce((select sum(((public.salary_rate_json(public.salary_rate_on(p.id, today))) ->> 'daily_equivalent')::numeric) * rest_days
                       from public.profiles p where p.active and (public.salary_rate_on(p.id, today)).id is not null), 0);
  norate := (select count(*) from public.profiles p where p.active and p.role <> 'admin' and not exists (select 1 from public.salary_rates s where s.user_id = p.id));
  v_pay := jsonb_build_object('period', per,
    'estimate_to_date', round(est, 2), 'forecast_rest', round(fc_rest, 2), 'working_days_left', rest_days,
    'forecast_assumption', 'Everyone with a rate works every remaining working day at their daily rate (no overtime, no absences).',
    'people_without_rate', norate,
    'runs', coalesce((select jsonb_agg(jsonb_build_object('period_start', period_start, 'period_end', period_end, 'status', status,
        'release_date', release_date, 'net', totals -> 'net', 'gross', totals -> 'gross', 'employer', totals -> 'employer_contributions',
        'employee', totals -> 'employee_contributions', 'tax', totals -> 'tax') order by period_start desc)
      from (select * from public.payroll_runs where status <> 'void' order by period_start desc limit 6) r), '[]'::jsonb),
    'month', (select jsonb_build_object('employer_contributions', coalesce(sum((totals ->> 'employer_contributions')::numeric), 0),
        'employee_contributions', coalesce(sum((totals ->> 'employee_contributions')::numeric), 0), 'withholding', coalesce(sum((totals ->> 'tax')::numeric), 0),
        'approved_net', coalesce(sum((totals ->> 'net')::numeric) filter (where status in ('approved', 'released')), 0))
      from public.payroll_runs where status <> 'void' and period_start >= date_trunc('month', today)::date),
    'rules_pending', (select count(*) from public.statutory_rules where status = 'pending_review'));

  -- ---------------------------------------------------------------- risks
  -- Each: severity (critical, high, moderate, low), title, why (the records behind it), where to act.
  if cash < 0 then v_risks := v_risks || jsonb_build_object('severity', 'critical', 'area', 'Finance', 'title', 'Cash in the books is below zero',
    'why', 'Cash on hand, in bank and in e-wallets adds up to ' || to_char(cash, 'FM999,999,990.00') || ' as of today. Either money went out that wasn''t recorded coming in, or the books are missing receipts.', 'link', 'accounting'); end if;
  for r in select pr.full_name, ((public.salary_rate_json(public.salary_rate_on(pr.id, today))) ->> 'daily_equivalent')::numeric as d
           from public.profiles pr where pr.active and (public.salary_rate_on(pr.id, today)).id is not null loop
    if mw is not null and r.d < mw then v_risks := v_risks || jsonb_build_object('severity', 'critical', 'area', 'Payroll', 'title', r.full_name || ' is paid below the minimum wage',
      'why', 'Daily rate ' || to_char(r.d, 'FM999,990.00') || ' against the ' || to_char(mw, 'FM990.00') || ' minimum (Wage Order RX-24, Region X Category I).', 'link', 'attendance'); end if;
  end loop;
  for r in select status, period_start, period_end, release_date from public.payroll_runs where status in ('submitted', 'approved') loop
    if r.status = 'submitted' then v_risks := v_risks || jsonb_build_object('severity', case when r.release_date - today <= 2 then 'high' else 'moderate' end, 'area', 'Payroll',
      'title', 'Payroll ' || r.period_start || ' to ' || r.period_end || ' is waiting for approval', 'why', 'Pay day is ' || r.release_date || ' (' || (r.release_date - today) || ' days).', 'link', 'attendance');
    elsif r.release_date < today then v_risks := v_risks || jsonb_build_object('severity', 'critical', 'area', 'Payroll',
      'title', 'Approved payroll ' || r.period_start || ' to ' || r.period_end || ' has no release recorded', 'why', 'Pay day was ' || r.release_date || '. Record the release, or check that staff were paid.', 'link', 'attendance'); end if;
  end loop;
  if (per ->> 'release')::date - today between 0 and 3 and not exists (select 1 from public.payroll_runs where period_start = (per ->> 'start')::date and status <> 'void') then
    v_risks := v_risks || jsonb_build_object('severity', 'high', 'area', 'Payroll', 'title', 'Pay day is close and the payroll isn''t prepared',
      'why', 'Pay day for ' || (per ->> 'start') || ' to ' || (per ->> 'end') || ' is ' || (per ->> 'release') || '.', 'link', 'attendance');
  end if;
  if norate > 0 then v_risks := v_risks || jsonb_build_object('severity', 'moderate', 'area', 'Payroll', 'title', norate || case when norate = 1 then ' person has' else ' people have' end || ' no pay rate',
    'why', 'Payroll can''t compute their pay or contributions until a rate is set.', 'link', 'attendance'); end if;
  if (v_pay ->> 'rules_pending')::int > 0 then v_risks := v_risks || jsonb_build_object('severity', 'moderate', 'area', 'Compliance',
    'title', (v_pay ->> 'rules_pending') || ' statutory rules are waiting for the accountant', 'why', 'Contributions and tax computed from them are estimates until each rule is approved.', 'link', 'attendance'); end if;
  for r in select project_name, balance from public.acct_receivables() where balance > 0 and status = 'completed' order by balance desc limit 5 loop
    v_risks := v_risks || jsonb_build_object('severity', 'high', 'area', 'Finance', 'title', r.project_name || ' is finished but still owes ' || to_char(r.balance, 'FM999,999,990.00'),
      'why', 'The project is marked completed and the payments received are below the contract price.', 'link', 'projects');
  end loop;
  for r in select coalesce(nullif(d.data ->> 'name', ''), d.id) as name, s.stage::text as stage, s.status::text as status, today - s.planned_end as days
           from public.project_stages s join public.tracker_docs d on d.collection = 'projects' and d.id = s.project_id
           where coalesce(d.data ->> 'status', 'active') not in ('completed', 'cancelled') and ((s.status <> 'done' and s.planned_end < today) or s.status = 'blocked')
           order by s.status = 'blocked' desc, s.planned_end limit 8 loop
    v_risks := v_risks || jsonb_build_object('severity', case when r.status = 'blocked' or r.days > 7 then 'high' else 'moderate' end, 'area', 'Projects',
      'title', r.name || ' · ' || public.stage_word(r.stage) || case when r.status = 'blocked' then ' is blocked' else ' is ' || r.days || ' days late' end,
      'why', case when r.status = 'blocked' then 'The stage is marked blocked on the Schedule.' else 'Its planned end has passed and it isn''t done.' end, 'link', 'schedule');
  end loop;
  if (v_org -> 'pending' ->> 'punches_to_check')::int > 0 then v_risks := v_risks || jsonb_build_object('severity', 'moderate', 'area', 'Attendance',
    'title', (v_org -> 'pending' ->> 'punches_to_check') || ' punches need checking', 'why', 'Face mismatch, no face check, weak GPS, late or off-site flags not yet reviewed.', 'link', 'attendance'); end if;
  if (v_org -> 'pending' ->> 'leads_unanswered')::int > 0 then v_risks := v_risks || jsonb_build_object('severity', 'moderate', 'area', 'Sales',
    'title', (v_org -> 'pending' ->> 'leads_unanswered') || ' new leads have no reply', 'why', 'The website promises a reply within 2 business hours.', 'link', 'leads'); end if;
  for r in select title, expires_on from public.company_documents where archived_at is null and expires_on <= today + 30 order by expires_on loop
    v_risks := v_risks || jsonb_build_object('severity', case when r.expires_on < today then 'critical' else 'moderate' end, 'area', 'Compliance',
      'title', r.title || case when r.expires_on < today then ' expired' else ' expires ' || r.expires_on end, 'why', 'Expiry date on the company document register.', 'link', 'company');
  end loop;
  -- Unusually high costs: this month so far above 1.5x the average of the last 3 full months (needs those 3 months).
  if (select count(*) from jsonb_array_elements(v_months) m where (m ->> 'activity')::int > 0 and (m ->> 'month') < to_char(today, 'YYYY-MM')) >= 3 then
    select (select (m ->> 'costs')::numeric from jsonb_array_elements(v_months) m where m ->> 'month' = to_char(today, 'YYYY-MM')) as now_c,
           (select avg((m ->> 'costs')::numeric) from (select m from jsonb_array_elements(v_months) m where (m ->> 'month') < to_char(today, 'YYYY-MM') order by m ->> 'month' desc limit 3) z) as avg_c into r;
    if r.avg_c > 0 and r.now_c > 1.5 * r.avg_c then v_risks := v_risks || jsonb_build_object('severity', 'high', 'area', 'Finance', 'title', 'Costs this month are unusually high',
      'why', 'So far ' || to_char(r.now_c, 'FM999,999,990.00') || ' against an average of ' || to_char(r.avg_c, 'FM999,999,990.00') || ' for the last 3 months.', 'link', 'accounting'); end if;
  end if;
  if (select count(*) from public.inventory_items i where i.active and i.reorder_level > 0 and public.inventory_on_hand(i.id) <= 0) > 0 then
    v_risks := v_risks || jsonb_build_object('severity', 'low', 'area', 'Stock', 'title', (select count(*) from public.inventory_items i where i.active and i.reorder_level > 0 and public.inventory_on_hand(i.id) <= 0) || ' stock items are out',
      'why', 'On hand is zero for items with a reorder level.', 'link', 'inventory');
  end if;

  return jsonb_build_object('today', today, 'generated_at', now(), 'org', v_org, 'finance', v_fin, 'payroll', v_pay,
    'risks', coalesce((select jsonb_agg(x order by case x ->> 'severity' when 'critical' then 0 when 'high' then 1 when 'moderate' then 2 else 3 end)
      from jsonb_array_elements(v_risks) x), '[]'::jsonb));
end $$;

-- Everything dated between p_from and p_to (at most 400 days): holidays, events, stage milestones,
-- project targets, cutoffs and pay days, payroll runs, document expiries, and (money) payments received,
-- costs paid and payroll released. Categories drive the page's colours and filters.
create function public.executive_calendar(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb := '[]'::jsonb; d date;
begin
  if not public.can_keep_books() then raise exception 'The executive dashboard is for the admin and the bookkeeper.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Choose up to 400 days.' using errcode = '22023'; end if;
  -- Holidays and company or project events.
  v := v || coalesce((select jsonb_agg(jsonb_build_object('date', (e.starts_at at time zone 'Asia/Manila')::date, 'end', (e.ends_at at time zone 'Asia/Manila')::date,
      'category', case when e.kind = 'holiday' then 'holiday' else 'event' end, 'kind', e.kind, 'title', e.title,
      'detail', case when e.kind = 'holiday' then coalesce(e.holiday_type, 'regular') || ' holiday' else coalesce((select coalesce(nullif(p.data ->> 'name', ''), p.id) from public.tracker_docs p where p.collection = 'projects' and p.id = e.project_id), 'Company') end,
      'link', 'schedule'))
    from public.project_events e where (e.ends_at at time zone 'Asia/Manila')::date >= p_from and (e.starts_at at time zone 'Asia/Manila')::date <= p_to), '[]'::jsonb);
  -- Stage milestones (planned ends) and project targets of open projects.
  v := v || coalesce((select jsonb_agg(jsonb_build_object('date', s.planned_end, 'category', 'milestone', 'title', coalesce(nullif(p.data ->> 'name', ''), p.id) || ' · ' || public.stage_word(s.stage::text),
      'detail', s.status::text, 'status', case when s.status = 'done' then 'done' when s.planned_end < (now() at time zone 'Asia/Manila')::date then 'overdue' else 'upcoming' end, 'link', 'schedule'))
    from public.project_stages s join public.tracker_docs p on p.collection = 'projects' and p.id = s.project_id
    where s.planned_end between p_from and p_to and coalesce(p.data ->> 'status', 'active') <> 'cancelled'), '[]'::jsonb);
  v := v || coalesce((select jsonb_agg(jsonb_build_object('date', public.acct_date(p.data ->> 'targetDate'), 'category', 'milestone',
      'title', coalesce(nullif(p.data ->> 'name', ''), p.id) || ' · handover target', 'detail', coalesce(p.data ->> 'status', 'active'), 'link', 'projects'))
    from public.tracker_docs p where p.collection = 'projects' and public.acct_date(p.data ->> 'targetDate') between p_from and p_to
      and coalesce(p.data ->> 'status', 'active') not in ('completed', 'cancelled')), '[]'::jsonb);
  -- Cutoffs and pay days.
  d := date_trunc('month', p_from)::date;
  while d <= p_to loop
    for i in 0..1 loop
      declare per jsonb := public.pay_period(d + i * 16); begin
        if (per ->> 'release')::date between p_from and p_to then
          v := v || jsonb_build_object('date', (per ->> 'release')::date, 'category', 'payroll', 'title', 'Pay day',
            'detail', 'Cutoff ' || (per ->> 'start') || ' to ' || (per ->> 'end'), 'link', 'attendance',
            'status', coalesce((select status from public.payroll_runs where period_start = (per ->> 'start')::date and status <> 'void'), 'not prepared'));
        end if;
        if (per ->> 'end')::date between p_from and p_to then
          v := v || jsonb_build_object('date', (per ->> 'end')::date, 'category', 'payroll', 'title', 'Cutoff ends', 'detail', (per ->> 'start') || ' to ' || (per ->> 'end'), 'link', 'attendance');
        end if;
      end;
    end loop;
    d := (d + interval '1 month')::date;
  end loop;
  -- Company documents expiring.
  v := v || coalesce((select jsonb_agg(jsonb_build_object('date', expires_on, 'category', 'compliance', 'title', title || ' expires', 'detail', kind, 'link', 'company',
      'status', case when expires_on < (now() at time zone 'Asia/Manila')::date then 'overdue' else 'upcoming' end))
    from public.company_documents where archived_at is null and expires_on between p_from and p_to), '[]'::jsonb);
  -- Money that actually moved, per day: received from clients, paid out (books), payroll released.
  v := v || coalesce((select jsonb_agg(jsonb_build_object('date', entry_date, 'category', 'money_in', 'title', 'Received', 'amount', round(s, 2), 'link', 'accounting'))
    from (select entry_date, sum(debit) s from public.acct_gl where account_code in ('1010', '1020', '1030') and entry_date between p_from and p_to group by entry_date having sum(debit) > 0) x), '[]'::jsonb);
  v := v || coalesce((select jsonb_agg(jsonb_build_object('date', entry_date, 'category', 'money_out', 'title', 'Paid out', 'amount', round(s, 2), 'link', 'accounting'))
    from (select entry_date, sum(credit) s from public.acct_gl where account_code in ('1010', '1020', '1030') and entry_date between p_from and p_to group by entry_date having sum(credit) > 0) x), '[]'::jsonb);
  v := v || coalesce((select jsonb_agg(jsonb_build_object('date', (released_at at time zone 'Asia/Manila')::date, 'category', 'money_out', 'title', 'Payroll released',
      'amount', totals -> 'net', 'detail', release_ref, 'link', 'attendance'))
    from public.payroll_runs where status = 'released' and (released_at at time zone 'Asia/Manila')::date between p_from and p_to), '[]'::jsonb);
  return coalesce((select jsonb_agg(x order by x ->> 'date', x ->> 'category') from jsonb_array_elements(v) x where x ->> 'date' is not null), '[]'::jsonb);
end $$;

revoke execute on function public.executive_overview(), public.executive_calendar(date, date) from public, anon;
grant execute on function public.executive_overview(), public.executive_calendar(date, date) to authenticated;
