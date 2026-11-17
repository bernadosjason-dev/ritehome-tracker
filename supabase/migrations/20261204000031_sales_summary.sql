-- v4.8: the sales summary (the owner's SALES SUMMARY workbooks 2024-2026, sent 2026-11-17). Coordinating agent T04-A02;
-- T02-A01 for the totals.
--
-- His workbooks keep, per year: a monthly list of sales contracts (date, SC no., customer, project, amount, a status note)
-- and the same contracts split by salesperson, against a quota (2024: a team quota per quarter; 2025-2026: an individual
-- quota per month). Here a sales contract is one row, kept once (one record per fact): the monthly list, the split by
-- salesperson and the quota tracking are all computed from it.
--   * SC numbers are unique and never reused; a contract is never deleted: it is cancelled (kept, with the reason).
--   * Who can see it: the admin and the bookkeeper (the books) everything; sales staff the whole register (the office's
--     sheet is shared among them today) but they add only their own and change only the status and notes of their own.
--   * Every change is in the activity log (module "Sales").
--   * Quotas are rows with a start date, so a change of quota doesn't rewrite earlier months.
-- No business figures are seeded here (the repository is public): history comes in through the page's import, which reads
-- the owner's workbook in his browser.

create table public.sales_contracts (
  id uuid primary key default gen_random_uuid(),
  sc_no int not null unique check (sc_no between 1 and 9999999),
  contract_date date,
  client text not null check (length(btrim(client)) between 1 and 200),
  description text not null default '' check (length(description) <= 600),
  amount numeric(14,2) check (amount is null or amount between 0 and 1000000000),
  salesperson text not null default '' check (length(salesperson) <= 80),
  salesperson_id uuid references public.profiles (id),
  status text not null default 'ongoing' check (status in ('ongoing', 'awaiting_payment', 'paid', 'on_hold', 'cancelled')),
  status_note text not null default '' check (length(status_note) <= 300),
  project_id text check (project_id is null or project_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  source text not null default 'portal' check (source in ('portal', 'import')),
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);
create index sales_contracts_date on public.sales_contracts (contract_date);
alter table public.sales_contracts enable row level security;
create policy "sales contracts: admin, bookkeeper and sales read" on public.sales_contracts for select using (public.can_sell() or public.can_keep_books());
revoke insert, update, delete on public.sales_contracts from anon, authenticated;

create function public.sales_contract_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Sales contracts are kept: cancel it instead.' using errcode = '42501'; end if;
  if new.sc_no <> old.sc_no and old.source = 'portal' and exists (select 1 from public.sales_contracts where sc_no = new.sc_no) then
    raise exception 'SC % is already used.', new.sc_no using errcode = '23505';
  end if;
  return new;
end $$;
create trigger sales_contract_guard before update or delete on public.sales_contracts for each row execute function public.sales_contract_guard();

create table public.sales_quotas (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null,
  scope text not null check (scope in ('person_month', 'team_quarter')),
  amount numeric(14,2) not null check (amount > 0 and amount <= 10000000000),
  note text not null default '' check (length(note) <= 300),
  created_by uuid default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (effective_from, scope)
);
alter table public.sales_quotas enable row level security;
create policy "sales quotas: admin, bookkeeper and sales read" on public.sales_quotas for select using (public.can_sell() or public.can_keep_books());
revoke insert, update, delete on public.sales_quotas from anon, authenticated;

create function public.sales_quota_on(p_scope text, p_date date) returns numeric
language sql stable security definer set search_path = public as $$
  select amount from public.sales_quotas where scope = p_scope and effective_from <= p_date order by effective_from desc limit 1
$$;

-- p: {id?, sc_no, contract_date, client, description, amount, salesperson, salesperson_id, status, status_note, project_id, source}
create function public.sales_contract_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid; old public.sales_contracts; admin boolean := public.is_admin(); books boolean := public.can_keep_books();
  seller boolean := public.can_sell(); me uuid := auth.uid(); c public.sales_contracts; v_person uuid; v_name text;
begin
  if not (seller or books) then raise exception 'Sales contracts are for the admin, the bookkeeper and sales.' using errcode = '42501'; end if;
  if coalesce(nullif(p ->> 'amount', ''), '0') !~ '^\d+(\.\d{1,2})?$' then raise exception 'The amount is pesos with up to two decimals.' using errcode = '22023'; end if;
  if coalesce(p ->> 'sc_no', '') !~ '^\d{1,7}$' and v_id is null then raise exception 'Give the SC number.' using errcode = '22023'; end if;
  if v_id is not null then
    select * into old from public.sales_contracts where id = v_id for update;
    if not found then raise exception 'No such sales contract.' using errcode = 'P0002'; end if;
    if old.status = 'cancelled' and not admin then raise exception 'A cancelled contract is changed only by the admin.' using errcode = '42501'; end if;
  end if;
  v_person := nullif(p ->> 'salesperson_id', '')::uuid;
  v_name := btrim(coalesce(p ->> 'salesperson', ''));
  if not admin then
    if v_id is null and not books then
      -- Sales staff add their own sales only.
      v_person := me; v_name := coalesce((select full_name from public.profiles where id = me), '');
    elsif v_id is not null then
      if not books and old.salesperson_id is distinct from me then raise exception 'You can change only your own sales contracts.' using errcode = '42501'; end if;
      if (p ? 'sc_no' and (p ->> 'sc_no')::int <> old.sc_no) or (p ? 'amount' and nullif(p ->> 'amount', '')::numeric is distinct from old.amount)
         or (p ? 'client' and btrim(p ->> 'client') <> old.client) or (p ? 'contract_date' and nullif(p ->> 'contract_date', '')::date is distinct from old.contract_date)
         or (p ? 'salesperson' and btrim(p ->> 'salesperson') <> old.salesperson) or (p ? 'salesperson_id' and nullif(p ->> 'salesperson_id', '')::uuid is distinct from old.salesperson_id) then
        raise exception 'Only the admin changes the SC number, date, client, amount or salesperson of a contract.' using errcode = '42501';
      end if;
    end if;
  end if;
  if v_person is not null and v_name = '' then v_name := coalesce((select full_name from public.profiles where id = v_person), ''); end if;
  begin
    if v_id is null then
      insert into public.sales_contracts (sc_no, contract_date, client, description, amount, salesperson, salesperson_id, status, status_note, project_id, source)
      values ((p ->> 'sc_no')::int, nullif(p ->> 'contract_date', '')::date, btrim(coalesce(p ->> 'client', '')), btrim(coalesce(p ->> 'description', '')),
        nullif(p ->> 'amount', '')::numeric, v_name, v_person, coalesce(nullif(p ->> 'status', ''), 'ongoing'), btrim(coalesce(p ->> 'status_note', '')),
        nullif(p ->> 'project_id', ''), case when p ->> 'source' = 'import' and (admin or books) then 'import' else 'portal' end)
      returning * into c;
    else
      update public.sales_contracts set
        sc_no = case when p ? 'sc_no' then (p ->> 'sc_no')::int else sc_no end,
        contract_date = case when p ? 'contract_date' then nullif(p ->> 'contract_date', '')::date else contract_date end,
        client = case when p ? 'client' then btrim(p ->> 'client') else client end,
        description = case when p ? 'description' then btrim(coalesce(p ->> 'description', '')) else description end,
        amount = case when p ? 'amount' then nullif(p ->> 'amount', '')::numeric else amount end,
        salesperson = case when p ? 'salesperson' or p ? 'salesperson_id' then v_name else salesperson end,
        salesperson_id = case when p ? 'salesperson_id' then v_person else salesperson_id end,
        status = case when p ? 'status' then coalesce(nullif(p ->> 'status', ''), status) else status end,
        status_note = case when p ? 'status_note' then btrim(coalesce(p ->> 'status_note', '')) else status_note end,
        project_id = case when p ? 'project_id' then nullif(p ->> 'project_id', '') else project_id end,
        updated_by = me, updated_at = now()
      where id = v_id returning * into c;
    end if;
  exception
    when unique_violation then raise exception 'SC % is already in the register.', p ->> 'sc_no' using errcode = '23505';
    when check_violation or not_null_violation then raise exception 'Check the contract: SC number, client, an amount of zero or more, a known status.' using errcode = '23514';
    when invalid_text_representation or datetime_field_overflow then raise exception 'Check the date and the numbers.' using errcode = '22023';
  end;
  return to_jsonb(c) - 'created_by' - 'updated_by';
end $$;

create function public.sales_contract_cancel(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c public.sales_contracts;
begin
  if not public.is_admin() then raise exception 'Only the admin cancels a sales contract.' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why it''s cancelled.' using errcode = '23514'; end if;
  update public.sales_contracts set status = 'cancelled', status_note = left('Cancelled: ' || btrim(p_reason), 300), updated_by = auth.uid(), updated_at = now()
  where id = p_id and status <> 'cancelled' returning * into c;
  if not found then raise exception 'That contract isn''t open.' using errcode = 'P0002'; end if;
  return to_jsonb(c) - 'created_by' - 'updated_by';
end $$;

create function public.sales_quota_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q public.sales_quotas;
begin
  if not public.is_admin() then raise exception 'Only the admin sets sales quotas.' using errcode = '42501'; end if;
  begin
    insert into public.sales_quotas (effective_from, scope, amount, note)
    values ((p ->> 'effective_from')::date, coalesce(nullif(p ->> 'scope', ''), 'person_month'), (p ->> 'amount')::numeric, btrim(coalesce(p ->> 'note', '')))
    on conflict (effective_from, scope) do update set amount = excluded.amount, note = excluded.note
    returning * into q;
  exception when check_violation or not_null_violation or invalid_text_representation then
    raise exception 'A quota needs a start date and an amount above zero.' using errcode = '23514';
  end;
  return to_jsonb(q) - 'created_by';
end $$;

-- The year as the office's workbook shows it: each month's contracts and total, each salesperson's months against the
-- quota, the team's quarters, and what to check (gaps in the SC numbers, contracts with no amount, date or salesperson).
create function public.sales_summary(p_year int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a date := make_date(p_year, 1, 1); z date := make_date(p_year, 12, 31); rows jsonb; lo int; hi int;
begin
  if not (public.can_sell() or public.can_keep_books()) then raise exception 'Sales are for the admin, the bookkeeper and sales.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(to_jsonb(c) - 'created_by' - 'updated_by' order by c.contract_date nulls last, c.sc_no), '[]'::jsonb), min(c.sc_no), max(c.sc_no)
    into rows, lo, hi from public.sales_contracts c where c.contract_date between a and z;
  return jsonb_build_object('year', p_year, 'can_admin', public.is_admin(), 'can_books', public.can_keep_books(), 'me', auth.uid(),
    'next_sc_no', coalesce((select max(sc_no) + 1 from public.sales_contracts), 1),
    'contracts', rows,
    'undated', coalesce((select jsonb_agg(to_jsonb(c) - 'created_by' - 'updated_by' order by c.sc_no) from public.sales_contracts c where c.contract_date is null), '[]'::jsonb),
    'months', (select jsonb_agg(x order by mm) from (select m mm, jsonb_build_object('month', m, 'count', count(c.id) filter (where c.status <> 'cancelled'),
        'total', coalesce(sum(c.amount) filter (where c.status <> 'cancelled'), 0)) x
      from generate_series(1, 12) m left join public.sales_contracts c on c.contract_date between a and z and extract(month from c.contract_date) = m group by m) t),
    'people', coalesce((with base as (
          select coalesce(nullif(c.salesperson, ''), '(not given)') sp, c.salesperson_id sid, c.status, c.amount, extract(month from c.contract_date)::int m
          from public.sales_contracts c where c.contract_date between a and z),
        per as (select sp, (array_agg(sid) filter (where sid is not null))[1] sid,
            coalesce(sum(amount) filter (where status <> 'cancelled'), 0) total, count(*) filter (where status <> 'cancelled') n from base group by sp),
        pm as (select per.sp, g m, coalesce((select sum(b.amount) from base b where b.sp = per.sp and b.m = g and b.status <> 'cancelled'), 0) amt
          from per cross join generate_series(1, 12) g)
      select jsonb_agg(jsonb_build_object('salesperson', per.sp, 'salesperson_id', per.sid, 'total', per.total, 'count', per.n,
          'months', (select jsonb_agg(pm.amt order by pm.m) from pm where pm.sp = per.sp)) order by per.total desc, per.sp)
      from per), '[]'::jsonb),
    'quota', jsonb_build_object(
      'person_month', (select jsonb_agg(public.sales_quota_on('person_month', (make_date(p_year, m, 1) + interval '1 month - 1 day')::date) order by m) from generate_series(1, 12) m),
      'team_quarter', (select jsonb_agg(public.sales_quota_on('team_quarter', (make_date(p_year, q * 3, 1) + interval '1 month - 1 day')::date) order by q) from generate_series(1, 4) q),
      'history', coalesce((select jsonb_agg(to_jsonb(s) - 'created_by' order by s.effective_from, s.scope) from public.sales_quotas s), '[]'::jsonb)),
    'total', coalesce((select sum(amount) from public.sales_contracts where contract_date between a and z and status <> 'cancelled'), 0),
    'cancelled', (select count(*) from public.sales_contracts where contract_date between a and z and status = 'cancelled'),
    'check', jsonb_build_object(
      'missing_sc', coalesce((select jsonb_agg(g order by g) from generate_series(lo, hi) g where lo is not null
        and not exists (select 1 from public.sales_contracts where sc_no = g)), '[]'::jsonb),
      'no_amount', coalesce((select jsonb_agg(sc_no order by sc_no) from public.sales_contracts where contract_date between a and z and amount is null and status <> 'cancelled'), '[]'::jsonb),
      'no_salesperson', coalesce((select jsonb_agg(sc_no order by sc_no) from public.sales_contracts where contract_date between a and z and salesperson = '' and status <> 'cancelled'), '[]'::jsonb)));
end $$;

-- The owner's workbook history, in one go (admin): rows the page read and he reviewed. SC numbers already in the register
-- are skipped, never overwritten; everything else goes in together or not at all.
create function public.sales_contract_import(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; added int := 0; skipped jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then raise exception 'Only the admin imports sales history.' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'Up to 2,000 contracts at a time.' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if exists (select 1 from public.sales_contracts where sc_no = (r ->> 'sc_no')::int) then skipped := skipped || to_jsonb((r ->> 'sc_no')::int); continue; end if;
    begin
      perform public.sales_contract_save(r || jsonb_build_object('source', 'import'));
    exception when others then
      raise exception 'SC %: %', r ->> 'sc_no', sqlerrm using errcode = coalesce(nullif(sqlstate, 'P0001'), '22023');
    end;
    added := added + 1;
  end loop;
  return jsonb_build_object('added', added, 'skipped', skipped);
end $$;

revoke execute on function public.sales_contract_guard(), public.sales_quota_on(text, date) from public, anon, authenticated;
revoke execute on function public.sales_contract_save(jsonb), public.sales_contract_cancel(uuid, text), public.sales_quota_save(jsonb), public.sales_summary(int), public.sales_contract_import(jsonb) from public, anon;
grant execute on function public.sales_contract_save(jsonb), public.sales_contract_cancel(uuid, text), public.sales_quota_save(jsonb), public.sales_summary(int), public.sales_contract_import(jsonb) to authenticated;

create trigger zz_audit after insert or update or delete on public.sales_contracts for each row execute function public.audit_row('sc_no');
create trigger zz_audit after insert or update or delete on public.sales_quotas for each row execute function public.audit_row('effective_from', 'scope');

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
    when p_table in ('sales_contracts', 'sales_quotas') then 'Sales'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;
