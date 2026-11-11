-- In-house books: a double-entry general ledger for the whole company, so the
-- owner can see a trial balance, an income statement, a balance sheet and
-- quarterly VAT and tax figures at any time, and hand clean numbers to the
-- external accounting firm. These are management books for in-house audit; the
-- firm keeps the BIR-registered books of accounts and files the returns.
--
-- Where the numbers come from:
--   1. The tracker, automatically, with nothing typed twice:
--        project expenses     Dr cost of sales (by category)   Cr cash
--        company fuel         Dr fuel & oil                    Cr cash
--        client payments      Dr cash, Dr creditable withholding tax
--                             Cr sales (VATable or non-VAT), Cr output VAT
--      These lines are computed from tracker_docs every time (acct_auto_lines),
--      never copied, so editing an expense in the tracker corrects the books.
--   2. Journal entries for everything the tracker doesn't hold: opening
--      balances, rent, office payroll, utilities, bank deposits, loans, assets,
--      owner's capital and drawings, VAT and tax payments.
--
-- Basis: client payments are recognised as sales when received (cash basis),
-- because that is what the tracker records with a date. Unpaid billings show
-- as receivables on the status page, not in the ledger. The accounting firm
-- adjusts to its own basis for the BIR books.
--
-- VAT: a project is VATable unless an admin marks it non-VAT. A VATable
-- payment's output VAT is 12/112 of the cash received plus tax withheld. An
-- expense or fuel purchase carries input VAT only once an admin marks it as
-- backed by a VAT invoice (12/112 of the amount unless a figure is entered).
--
-- Rules the database enforces, not the page:
--   - admin only, for every table, view and function here
--   - every journal entry balances (debits = credits) and has two lines or more
--   - posted entries are never edited or deleted; a mistake is voided (kept,
--     with who, when and why) and re-entered
--   - nothing can be posted or voided on or before the lock date

-- ------------------------------------------------------------ accounts ----

create type public.acct_type as enum ('asset', 'liability', 'equity', 'revenue', 'cost_of_sales', 'expense');

create table public.acct_accounts (
  code text primary key check (code ~ '^[0-9]{4}$'),
  name text not null check (length(name) between 1 and 80),
  type public.acct_type not null,
  -- The side a balance normally sits on. Defaults from the type; contra
  -- accounts (accumulated depreciation, owner's drawings) set it explicitly.
  normal_side text not null check (normal_side in ('debit', 'credit')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create function public.acct_default_side() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.normal_side is null then
    new.normal_side := case when new.type in ('asset', 'cost_of_sales', 'expense') then 'debit' else 'credit' end;
  end if;
  return new;
end $$;
create trigger acct_accounts_side before insert on public.acct_accounts
  for each row execute function public.acct_default_side();

insert into public.acct_accounts (code, name, type, normal_side) values
  ('1010', 'Cash on hand', 'asset', 'debit'),
  ('1020', 'Cash in bank', 'asset', 'debit'),
  ('1030', 'E-wallets (GCash, Maya)', 'asset', 'debit'),
  ('1100', 'Accounts receivable - clients', 'asset', 'debit'),
  ('1150', 'Advances to employees', 'asset', 'debit'),
  ('1160', 'Advances to suppliers', 'asset', 'debit'),
  ('1200', 'Materials inventory', 'asset', 'debit'),
  ('1300', 'Input VAT', 'asset', 'debit'),
  ('1310', 'Creditable withholding tax', 'asset', 'debit'),
  ('1320', 'Prepaid expenses', 'asset', 'debit'),
  ('1500', 'Tools and equipment', 'asset', 'debit'),
  ('1510', 'Machinery', 'asset', 'debit'),
  ('1520', 'Vehicles', 'asset', 'debit'),
  ('1530', 'Furniture and office equipment', 'asset', 'debit'),
  ('1590', 'Accumulated depreciation', 'asset', 'credit'),
  ('2010', 'Accounts payable - suppliers', 'liability', 'credit'),
  ('2020', 'Accrued expenses', 'liability', 'credit'),
  ('2100', 'Output VAT', 'liability', 'credit'),
  ('2110', 'VAT payable', 'liability', 'credit'),
  ('2120', 'Withholding tax payable', 'liability', 'credit'),
  ('2130', 'SSS, PhilHealth, Pag-IBIG payable', 'liability', 'credit'),
  ('2200', 'Customer deposits', 'liability', 'credit'),
  ('2300', 'Loans payable', 'liability', 'credit'),
  ('3010', 'Owner''s capital', 'equity', 'credit'),
  ('3020', 'Owner''s drawings', 'equity', 'debit'),
  ('3900', 'Prior years'' income', 'equity', 'credit'),
  ('4010', 'Sales - VATable', 'revenue', 'credit'),
  ('4020', 'Sales - non-VAT', 'revenue', 'credit'),
  ('4900', 'Other income', 'revenue', 'credit'),
  ('5010', 'Direct materials', 'cost_of_sales', 'debit'),
  ('5020', 'Direct labor', 'cost_of_sales', 'debit'),
  ('5030', 'Project transportation', 'cost_of_sales', 'debit'),
  ('5040', 'Project meals', 'cost_of_sales', 'debit'),
  ('5090', 'Other project costs', 'cost_of_sales', 'debit'),
  ('6010', 'Salaries and wages - office', 'expense', 'debit'),
  ('6020', 'Employer SSS, PhilHealth, Pag-IBIG', 'expense', 'debit'),
  ('6030', 'Rent', 'expense', 'debit'),
  ('6040', 'Light and water', 'expense', 'debit'),
  ('6050', 'Communication and internet', 'expense', 'debit'),
  ('6060', 'Fuel and oil - company vehicles', 'expense', 'debit'),
  ('6070', 'Repairs and maintenance', 'expense', 'debit'),
  ('6080', 'Office supplies', 'expense', 'debit'),
  ('6090', 'Advertising and marketing', 'expense', 'debit'),
  ('6100', 'Professional fees', 'expense', 'debit'),
  ('6110', 'Taxes and licenses', 'expense', 'debit'),
  ('6120', 'Depreciation', 'expense', 'debit'),
  ('6130', 'Bank charges', 'expense', 'debit'),
  ('6140', 'Representation', 'expense', 'debit'),
  ('6150', 'Travel - office', 'expense', 'debit'),
  ('6160', 'Interest expense', 'expense', 'debit'),
  ('6190', 'Miscellaneous expense', 'expense', 'debit');

-- ------------------------------------------------------------ settings ----

create table public.acct_settings (
  id boolean primary key default true check (id),
  -- Tracker records dated before this are left out; opening balances go in
  -- as a journal entry on this date. The fiscal year is the calendar year.
  books_start date not null default date '2026-01-01',
  -- Nothing on or before this date can be posted or voided.
  locked_through date,
  vat_rate numeric(5, 4) not null default 0.12 check (vat_rate >= 0 and vat_rate < 1),
  default_project_vat text not null default 'vatable' check (default_project_vat in ('vatable', 'non_vat')),
  receipts_account text not null default '1010' references public.acct_accounts (code),
  expenses_paid_from text not null default '1010' references public.acct_accounts (code),
  vatable_sales_account text not null default '4010' references public.acct_accounts (code),
  non_vat_sales_account text not null default '4020' references public.acct_accounts (code),
  output_vat_account text not null default '2100' references public.acct_accounts (code),
  input_vat_account text not null default '1300' references public.acct_accounts (code),
  cwt_account text not null default '1310' references public.acct_accounts (code),
  fuel_account text not null default '6060' references public.acct_accounts (code),
  -- Tracker expense category -> account. Unknown categories use "other".
  category_accounts jsonb not null default
    '{"materials":"5010","labor":"5020","transportation":"5030","food":"5040","other":"5090"}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
insert into public.acct_settings default values;

create function public.acct_check_settings() returns trigger
language plpgsql set search_path = public as $$
declare v_bad text;
begin
  if jsonb_typeof(new.category_accounts) <> 'object' or not new.category_accounts ? 'other' then
    raise exception 'Category accounts need an entry for "other".' using errcode = '23514';
  end if;
  select string_agg(value, ', ') into v_bad from jsonb_each_text(new.category_accounts)
  where value not in (select code from public.acct_accounts);
  if v_bad is not null then
    raise exception 'Unknown account in category accounts: %', v_bad using errcode = '23503';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger acct_settings_check before insert or update on public.acct_settings
  for each row execute function public.acct_check_settings();

-- ------------------------------------------------------------- journal ----

create table public.acct_entries (
  id bigint generated always as identity primary key,
  entry_date date not null,
  memo text not null check (length(memo) between 1 and 300),
  ref text not null default '' check (length(ref) <= 60),
  project_id text check (project_id is null or length(project_id) <= 100),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text check (void_reason is null or length(void_reason) between 1 and 300),
  check ((voided_at is null) = (void_reason is null))
);
create index acct_entries_date on public.acct_entries (entry_date);

create table public.acct_lines (
  id bigint generated always as identity primary key,
  entry_id bigint not null references public.acct_entries (id),
  account_code text not null references public.acct_accounts (code),
  debit numeric(14, 2) not null default 0 check (debit >= 0),
  credit numeric(14, 2) not null default 0 check (credit >= 0),
  memo text not null default '' check (length(memo) <= 200),
  check ((debit > 0) <> (credit > 0))
);
create index acct_lines_entry on public.acct_lines (entry_id);
create index acct_lines_account on public.acct_lines (account_code);

-- Posting and voiding respect the lock date; an entry may only ever change by
-- being voided once; posted lines never change.
create function public.acct_guard_entry() returns trigger
language plpgsql set search_path = public as $$
declare v_lock date := (select locked_through from public.acct_settings);
begin
  if tg_op = 'DELETE' then
    raise exception 'Posted entries are never deleted. Void it instead.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.voided_at is not null then
      raise exception 'A new entry can''t start voided.' using errcode = '23514';
    end if;
    if v_lock is not null and new.entry_date <= v_lock then
      raise exception 'The books are locked through %. Date the entry after that.', v_lock using errcode = '42501';
    end if;
    new.created_at := now();
    new.created_by := auth.uid();
    return new;
  end if;
  if old.voided_at is not null then
    raise exception 'This entry is already void.' using errcode = '42501';
  end if;
  if (new.entry_date, new.memo, new.ref, new.project_id, new.created_at, new.created_by)
     is distinct from (old.entry_date, old.memo, old.ref, old.project_id, old.created_at, old.created_by)
     or new.voided_at is null then
    raise exception 'Posted entries can''t be edited. Void it and post a corrected one.' using errcode = '42501';
  end if;
  if v_lock is not null and old.entry_date <= v_lock then
    raise exception 'The books are locked through %. This entry can''t be voided.', v_lock using errcode = '42501';
  end if;
  new.voided_at := now();
  new.voided_by := auth.uid();
  return new;
end $$;
create trigger acct_entries_guard before insert or update or delete on public.acct_entries
  for each row execute function public.acct_guard_entry();

create function public.acct_guard_line() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'Posted lines can''t be changed. Void the entry and post a corrected one.' using errcode = '42501';
  end if;
  if exists (select 1 from public.acct_entries e where e.id = new.entry_id and e.voided_at is not null) then
    raise exception 'Can''t add lines to a void entry.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.acct_accounts a where a.code = new.account_code and a.active) then
    raise exception 'Account % doesn''t exist or is inactive.', new.account_code using errcode = '23514';
  end if;
  return new;
end $$;
create trigger acct_lines_guard before insert or update or delete on public.acct_lines
  for each row execute function public.acct_guard_line();

-- Checked when the transaction commits, so an entry and its lines can be
-- inserted in any order, but never left unbalanced.
create function public.acct_check_balanced() returns trigger
language plpgsql set search_path = public as $$
declare v_entry bigint := (to_jsonb(new) ->> tg_argv[0])::bigint;
        v_n int; v_dr numeric; v_cr numeric;
begin
  select count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0) into v_n, v_dr, v_cr
  from public.acct_lines where entry_id = v_entry;
  if v_n < 2 then
    raise exception 'Entry % needs at least two lines.', v_entry using errcode = '23514';
  end if;
  if v_dr <> v_cr then
    raise exception 'Entry % doesn''t balance: debits % and credits %.', v_entry, v_dr, v_cr using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger acct_entries_balanced after insert on public.acct_entries
  deferrable initially deferred for each row execute function public.acct_check_balanced('id');
create constraint trigger acct_lines_balanced after insert on public.acct_lines
  deferrable initially deferred for each row execute function public.acct_check_balanced('entry_id');

-- ----------------------------------------------------- VAT tags on tracker ----
-- Kept beside the tracker's documents, not inside them, so the tracker's own
-- saves (and the Google Sheet path) never see or overwrite them.

create table public.acct_project_vat (
  project_collection text not null default 'projects' check (project_collection = 'projects'),
  project_id text primary key,
  treatment text not null check (treatment in ('vatable', 'non_vat')),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  foreign key (project_collection, project_id) references public.tracker_docs (collection, id) on delete cascade
);

create table public.acct_purchase_vat (
  collection text not null check (collection in ('expenses', 'companyFuel')),
  doc_id text not null,
  -- null: 12/112 of the purchase amount. A figure: the VAT printed on the invoice.
  input_vat numeric(14, 2) check (input_vat is null or input_vat >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (collection, doc_id),
  foreign key (collection, doc_id) references public.tracker_docs (collection, id) on delete cascade
);

-- ----------------------------------------------------- reading the tracker ----

-- A JSON number or numeric string, else 0. Tracker documents are typed by a
-- browser form, so the ledger never trusts their shape.
create function public.acct_num(v jsonb) returns numeric
language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric
    when jsonb_typeof(v) = 'string' and btrim(v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(v #>> '{}')::numeric
    else 0 end
$$;

-- A YYYY-MM-DD date that exists, else null.
create function public.acct_date(v text) returns date
language plpgsql immutable set search_path = public as $$
begin
  if v is null or v !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return v::date;
exception when others then return null;
end $$;

-- Every client payment the tracker holds, one row per billing milestone.
-- Mirrors the tracker's normBilling(): projects from before milestone billing
-- only had `downpayment`, which counts as the down payment received.
create view public.acct_payments with (security_invoker = true) as
select p.id as project_id,
       coalesce(nullif(btrim(p.data ->> 'name'), ''), p.id) as project_name,
       m.key as milestone, m.label as milestone_label, m.ord,
       round(public.acct_num(b.v -> 'received'), 2) as cash,
       round(public.acct_num(b.v -> 'withheld'), 2) as withheld,
       public.acct_date(b.v ->> 'receivedDate') as received_date,
       coalesce(t.treatment, s.default_project_vat) as vat_treatment,
       t.treatment is not null as vat_confirmed
from public.tracker_docs p
cross join public.acct_settings s
cross join (values ('dp', 'Down payment', 1), ('progress', 'Progress billing', 2), ('retention', 'Retention', 3))
  as m (key, label, ord)
cross join lateral (select case
    when jsonb_typeof(p.data -> 'billing') = 'object' then
      case when jsonb_typeof(p.data -> 'billing' -> m.key) = 'object' then p.data -> 'billing' -> m.key end
    when m.key = 'dp' and public.acct_num(p.data -> 'downpayment') > 0 then
      jsonb_build_object('received', p.data -> 'downpayment')
  end as v) b
left join public.acct_project_vat t on t.project_id = p.id
where p.collection = 'projects' and b.v is not null
  and (public.acct_num(b.v -> 'received') <> 0 or public.acct_num(b.v -> 'withheld') <> 0);

-- Every expense and fuel purchase the tracker holds, with its input VAT.
create view public.acct_purchases with (security_invoker = true) as
select x.collection, x.doc_id, x.project_id, x.purchase_date, x.description, x.category, x.amount, x.cost_account,
       x.vat_invoice, x.input_vat_entered,
       case when not x.vat_invoice then 0::numeric
            else sign(x.amount) * least(abs(x.amount), coalesce(x.input_vat_entered,
                   round(abs(x.amount) * x.vat_rate / (1 + x.vat_rate), 2))) end as input_vat
from (
  select d.collection, d.id as doc_id,
         case when d.collection = 'expenses' then d.parent_id end as project_id,
         public.acct_date(d.data ->> 'date') as purchase_date,
         left(coalesce(nullif(btrim(case when d.collection = 'expenses' then d.data ->> 'item'
                else concat_ws(' ', 'Fuel', nullif(btrim(d.data ->> 'vehicle'), '')) end), ''), d.id), 200) as description,
         case when d.collection = 'expenses' then coalesce(d.data ->> 'category', 'other') else 'fuel' end as category,
         round(public.acct_num(d.data -> 'amount'), 2) as amount,
         case when d.collection = 'companyFuel' then s.fuel_account
              else coalesce(s.category_accounts ->> (d.data ->> 'category'), s.category_accounts ->> 'other') end as cost_account,
         v.doc_id is not null as vat_invoice,
         v.input_vat as input_vat_entered,
         s.vat_rate
  from public.tracker_docs d
  cross join public.acct_settings s
  left join public.acct_purchase_vat v on v.collection = d.collection and v.doc_id = d.id
  where d.collection in ('expenses', 'companyFuel')
) x;

-- The ledger lines the tracker produces. Signed: positive is a debit.
create view public.acct_auto_lines with (security_invoker = true) as
with s as (select * from public.acct_settings),
pay as (
  select a.*, a.cash + a.withheld as settled,
         case when a.vat_treatment = 'vatable'
              then round((a.cash + a.withheld) * s.vat_rate / (1 + s.vat_rate), 2) else 0 end as vat
  from public.acct_payments a cross join s
  where a.received_date is not null and a.received_date >= s.books_start
)
select 'payment'::text as source, pay.project_id || ':' || pay.milestone as source_id, pay.project_id,
       pay.received_date as entry_date, pay.milestone_label || ' - ' || pay.project_name as memo,
       l.account_code, l.amount
from pay cross join s
cross join lateral (values
  (s.receipts_account, pay.cash),
  (s.cwt_account, pay.withheld),
  (case when pay.vat_treatment = 'vatable' then s.vatable_sales_account else s.non_vat_sales_account end, -(pay.settled - pay.vat)),
  (s.output_vat_account, -pay.vat)) as l (account_code, amount)
where l.amount <> 0
union all
select case when p.collection = 'expenses' then 'expense' else 'fuel' end, p.doc_id, p.project_id,
       p.purchase_date, p.description, l.account_code, l.amount
from public.acct_purchases p cross join s
cross join lateral (values
  (p.cost_account, p.amount - p.input_vat),
  (s.input_vat_account, p.input_vat),
  (s.expenses_paid_from, -p.amount)) as l (account_code, amount)
where p.purchase_date is not null and p.purchase_date >= s.books_start and l.amount <> 0;

-- The general ledger: posted journal lines (not void) plus the tracker's.
create view public.acct_gl with (security_invoker = true) as
select 'journal'::text as source, e.id::text as source_id, e.project_id, e.entry_date,
       e.memo || case when l.memo <> '' then ' - ' || l.memo else '' end as memo,
       e.ref, l.account_code, l.debit, l.credit
from public.acct_lines l join public.acct_entries e on e.id = l.entry_id
where e.voided_at is null
union all
select a.source, a.source_id, a.project_id, a.entry_date, a.memo, '' as ref, a.account_code,
       greatest(a.amount, 0), greatest(-a.amount, 0)
from public.acct_auto_lines a;

-- ------------------------------------------------------------- reports ----
-- All invoker-rights: they read through the views above, so row-level
-- security decides, and a non-admin gets empty reports, never someone's books.

-- Ledger detail for a date range (either end open), optionally one account.
create function public.acct_ledger(p_from date default null, p_to date default null, p_account text default null)
returns setof public.acct_gl
language sql stable security invoker set search_path = public as $$
  select * from public.acct_gl g
  where (p_from is null or g.entry_date >= p_from) and (p_to is null or g.entry_date <= p_to)
    and (p_account is null or g.account_code = p_account)
  order by g.entry_date, g.source, g.source_id, g.debit desc, g.account_code
$$;

-- Trial balance as of a date. Balance-sheet accounts carry everything to
-- date; income and expense accounts carry this calendar year only, and earlier
-- years' profit sits in 3900 Prior years' income, as if closed at each year end.
create function public.acct_trial_balance(p_as_of date)
returns table (code text, name text, type public.acct_type, debit numeric, credit numeric)
language sql stable security invoker set search_path = public as $$
  with fy as (select make_date(extract(year from p_as_of)::int, 1, 1) as start),
  sums as (
    select a.code, a.name, a.type,
           coalesce(sum(case
             when a.type in ('asset', 'liability', 'equity') then g.debit - g.credit
             when g.entry_date >= fy.start then g.debit - g.credit
             else 0 end), 0) as net
    from public.acct_accounts a cross join fy
    left join public.acct_gl g on g.account_code = a.code and g.entry_date <= p_as_of
    group by a.code, a.name, a.type
  ),
  closed as (
    select coalesce(sum(g.debit - g.credit), 0) as net
    from public.acct_gl g join public.acct_accounts a on a.code = g.account_code cross join fy
    where a.type in ('revenue', 'cost_of_sales', 'expense') and g.entry_date < fy.start
  )
  select s.code, s.name, s.type,
         round(greatest(s.net + case when s.code = '3900' then c.net else 0 end, 0), 2),
         round(greatest(-(s.net + case when s.code = '3900' then c.net else 0 end), 0), 2)
  from sums s cross join closed c
  where s.net + case when s.code = '3900' then c.net else 0 end <> 0
  order by s.code
$$;

-- Income statement for a period. Amounts are positive in the account's
-- natural direction: revenue as credits, costs and expenses as debits.
create function public.acct_income_statement(p_from date, p_to date)
returns table (code text, name text, type public.acct_type, amount numeric)
language sql stable security invoker set search_path = public as $$
  select a.code, a.name, a.type,
         round(sum(case when a.type = 'revenue' then g.credit - g.debit else g.debit - g.credit end), 2)
  from public.acct_gl g join public.acct_accounts a on a.code = g.account_code
  where a.type in ('revenue', 'cost_of_sales', 'expense') and g.entry_date between p_from and p_to
  group by a.code, a.name, a.type
  having sum(g.debit - g.credit) <> 0
  order by a.code
$$;

-- Balance sheet as of a date. Assets positive as debits, liabilities and
-- equity positive as credits; a contra account comes out negative. This
-- year's profit to date is its own equity line (code '').
create function public.acct_balance_sheet(p_as_of date)
returns table (code text, name text, type public.acct_type, amount numeric)
language sql stable security invoker set search_path = public as $$
  with tb as (select * from public.acct_trial_balance(p_as_of)),
  rows as (
    select tb.code, tb.name, tb.type,
           case when tb.type = 'asset' then tb.debit - tb.credit else tb.credit - tb.debit end as amount
    from tb where tb.type in ('asset', 'liability', 'equity')
    union all
    select '', 'Net income, this year to date', 'equity'::public.acct_type, coalesce(sum(tb.credit - tb.debit), 0)
    from tb where tb.type in ('revenue', 'cost_of_sales', 'expense')
  )
  select * from rows order by type, code = '', code
$$;

-- Quarterly VAT and withholding figures for a calendar year, for the firm's
-- 2550Q and 1701Q work. Output VAT counts credits to the output VAT account and
-- input VAT counts debits to the input VAT account, so the entry that settles
-- a quarter (Dr output VAT, Cr input VAT, Cr VAT payable) doesn't cancel the
-- figures it settles.
create function public.acct_vat_quarters(p_year int)
returns table (quarter int, period_start date, period_end date, vatable_sales numeric, non_vat_sales numeric,
               output_vat numeric, input_vat numeric, vat_still_due numeric, tax_withheld_by_clients numeric)
language sql stable security invoker set search_path = public as $$
  with s as (select * from public.acct_settings),
  q as (select n, make_date(p_year, n * 3 - 2, 1) as qs,
               (make_date(p_year, n * 3 - 2, 1) + interval '3 months' - interval '1 day')::date as qe
        from generate_series(1, 4) n),
  x as (
    select q.n, q.qs, q.qe,
      coalesce(sum(g.credit - g.debit) filter (where g.account_code = s.vatable_sales_account), 0) as vs,
      coalesce(sum(g.credit - g.debit) filter (where g.account_code = s.non_vat_sales_account), 0) as nvs,
      coalesce(sum(g.credit) filter (where g.account_code = s.output_vat_account), 0) as ov,
      coalesce(sum(g.debit) filter (where g.account_code = s.input_vat_account), 0) as iv,
      coalesce(sum(g.debit) filter (where g.account_code = s.cwt_account), 0) as cwt
    from q cross join s
    left join public.acct_gl g on g.entry_date between q.qs and q.qe
    group by q.n, q.qs, q.qe
  )
  select n, qs, qe, round(vs, 2), round(nvs, 2), round(ov, 2), round(iv, 2), round(ov - iv, 2), round(cwt, 2) from x order by n
$$;

-- What a client still owes, per project with a contract price (cash basis
-- keeps this out of the ledger; the status page shows it beside it).
create function public.acct_receivables()
returns table (project_id text, project_name text, status text, contract_price numeric, settled numeric, balance numeric)
language sql stable security invoker set search_path = public as $$
  select p.id, coalesce(nullif(btrim(p.data ->> 'name'), ''), p.id), coalesce(p.data ->> 'status', 'active'),
         round(public.acct_num(p.data -> 'price'), 2),
         round(coalesce(sum(a.cash + a.withheld), 0), 2),
         round(public.acct_num(p.data -> 'price') - coalesce(sum(a.cash + a.withheld), 0), 2)
  from public.tracker_docs p
  left join public.acct_payments a on a.project_id = p.id
  where p.collection = 'projects' and public.acct_num(p.data -> 'price') > 0
  group by p.id, p.data
  having round(public.acct_num(p.data -> 'price'), 2) - coalesce(sum(a.cash + a.withheld), 0) <> 0
  order by 6 desc
$$;

-- Tracker records the ledger can't use as they stand, and decisions still
-- open. The status page lists them so nothing drops out of the books silently.
create function public.acct_data_issues()
returns table (kind text, collection text, doc_id text, project_id text, detail text)
language sql stable security invoker set search_path = public as $$
  with s as (select * from public.acct_settings)
  select 'undated_payment', 'projects', a.project_id, a.project_id,
         a.milestone_label || ' of ' || to_char(a.cash + a.withheld, 'FM999,999,990.00') || ' for ' || a.project_name || ' has no received date, so it isn''t in the books.'
  from public.acct_payments a where a.received_date is null
  union all
  select 'undated_purchase', p.collection, p.doc_id, p.project_id,
         p.description || ' (' || to_char(p.amount, 'FM999,999,990.00') || ') has no valid date, so it isn''t in the books.'
  from public.acct_purchases p where p.purchase_date is null and p.amount <> 0
  union all
  select 'bad_amount', d.collection, d.id, d.parent_id,
         'Amount "' || left(d.data ->> 'amount', 40) || '" isn''t a number, so it counts as zero.'
  from public.tracker_docs d
  where d.collection in ('expenses', 'companyFuel') and d.data ? 'amount'
    and jsonb_typeof(d.data -> 'amount') not in ('number', 'null')
    and not (jsonb_typeof(d.data -> 'amount') = 'string' and btrim(d.data ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$')
  union all
  select 'unmapped_category', p.collection, p.doc_id, p.project_id,
         p.description || ': category "' || p.category || '" has no account, so it went to ' || (s.category_accounts ->> 'other') || '.'
  from public.acct_purchases p cross join s
  where p.collection = 'expenses' and not s.category_accounts ? p.category
  union all
  select 'vat_unconfirmed', 'projects', x.project_id, x.project_id,
         x.project_name || ' is treated as ' || case x.vat_treatment when 'vatable' then 'VATable' else 'non-VAT' end || ' by default. Confirm its VAT treatment.'
  from (select distinct project_id, project_name, vat_treatment from public.acct_payments where not vat_confirmed) x
  union all
  select 'before_books_start', p.collection, p.doc_id, p.project_id,
         p.description || ' is dated ' || p.purchase_date || ', before the books start (' || s.books_start || '), so it isn''t in the books.'
  from public.acct_purchases p cross join s where p.purchase_date < s.books_start and p.amount <> 0
  union all
  select 'before_books_start', 'projects', a.project_id, a.project_id,
         a.milestone_label || ' for ' || a.project_name || ' was received ' || a.received_date || ', before the books start (' || s.books_start || '), so it isn''t in the books.'
  from public.acct_payments a cross join s where a.received_date < s.books_start
$$;

-- Posts one balanced entry atomically. lines: [{account, debit, credit, memo}].
create function public.acct_post_entry(p_date date, p_memo text, p_lines jsonb, p_ref text default '', p_project text default null)
returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint; v_dr numeric; v_cr numeric;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can post to the books.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'An entry needs at least two lines.' using errcode = '23514';
  end if;
  if coalesce(btrim(p_memo), '') = '' then
    raise exception 'Say what the entry is for.' using errcode = '23514';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) x
             where round(public.acct_num(x -> 'debit'), 2) < 0 or round(public.acct_num(x -> 'credit'), 2) < 0
                or (round(public.acct_num(x -> 'debit'), 2) > 0) = (round(public.acct_num(x -> 'credit'), 2) > 0)) then
    raise exception 'Each line needs either a debit or a credit, not both, and no negatives.' using errcode = '23514';
  end if;
  select sum(round(coalesce(public.acct_num(x -> 'debit'), 0), 2)), sum(round(coalesce(public.acct_num(x -> 'credit'), 0), 2))
    into v_dr, v_cr from jsonb_array_elements(p_lines) x;
  if v_dr <> v_cr then
    raise exception 'Debits (%) and credits (%) must be equal.', v_dr, v_cr using errcode = '23514';
  end if;
  insert into public.acct_entries (entry_date, memo, ref, project_id)
  values (p_date, btrim(p_memo), coalesce(btrim(p_ref), ''), nullif(btrim(p_project), ''))
  returning id into v_id;
  insert into public.acct_lines (entry_id, account_code, debit, credit, memo)
  select v_id, x ->> 'account', round(public.acct_num(x -> 'debit'), 2), round(public.acct_num(x -> 'credit'), 2),
         coalesce(btrim(x ->> 'memo'), '')
  from jsonb_array_elements(p_lines) with ordinality as t (x, n) order by n;
  return v_id;
end $$;

create function public.acct_void_entry(p_id bigint, p_reason text) returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can void entries.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why the entry is void.' using errcode = '23514';
  end if;
  update public.acct_entries set voided_at = now(), void_reason = nullif(btrim(p_reason), '')
  where id = p_id and voided_at is null returning id into v_id;
  if v_id is null then
    raise exception 'No open entry %.', p_id using errcode = 'P0002';
  end if;
  return v_id;
end $$;

-- --------------------------------------------------- the page's API ----
-- accounting.html talks to the books only through these functions and the
-- report functions above. All invoker-rights, so row-level security decides.

create function public.acct_require_admin() returns void
language plpgsql stable set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can change the books.' using errcode = '42501';
  end if;
end $$;

-- Settings, the chart of accounts and the project list, in one round trip.
create function public.acct_config() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'settings', (select to_jsonb(s) - 'id' from public.acct_settings s),
    'accounts', coalesce((select jsonb_agg(to_jsonb(a) - 'created_at' order by a.code) from public.acct_accounts a), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('id', d.id,
        'name', coalesce(nullif(btrim(d.data ->> 'name'), ''), d.id), 'status', coalesce(d.data ->> 'status', 'active'))
        order by coalesce(nullif(btrim(d.data ->> 'name'), ''), d.id))
      from public.tracker_docs d where d.collection = 'projects'), '[]'::jsonb))
$$;

-- Changes only the settings named in p; "locked_through": "" clears the lock.
create function public.acct_save_settings(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
begin
  perform public.acct_require_admin();
  update public.acct_settings set
    books_start = coalesce(public.acct_date(p ->> 'books_start'), books_start),
    locked_through = case when p ? 'locked_through' then public.acct_date(p ->> 'locked_through') else locked_through end,
    default_project_vat = coalesce(p ->> 'default_project_vat', default_project_vat),
    receipts_account = coalesce(p ->> 'receipts_account', receipts_account),
    expenses_paid_from = coalesce(p ->> 'expenses_paid_from', expenses_paid_from),
    fuel_account = coalesce(p ->> 'fuel_account', fuel_account),
    category_accounts = coalesce(p -> 'category_accounts', category_accounts);
  return public.acct_config() -> 'settings';
end $$;

-- Adds an account, or renames / retypes / (de)activates one. Codes never change.
create function public.acct_save_account(p_code text, p_name text, p_type public.acct_type,
  p_active boolean default true, p_normal_side text default null) returns void
language plpgsql security invoker set search_path = public as $$
begin
  perform public.acct_require_admin();
  insert into public.acct_accounts as a (code, name, type, normal_side, active)
  values (btrim(p_code), btrim(p_name), p_type, p_normal_side, coalesce(p_active, true))
  on conflict (code) do update set name = excluded.name, type = excluded.type, active = excluded.active,
    normal_side = coalesce(p_normal_side, a.normal_side);
end $$;

-- Journal entries in a date range (either end open), newest first, void ones included.
create function public.acct_journal(p_from date default null, p_to date default null) returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x ->> 'entry_date') desc, (x ->> 'id')::bigint desc), '[]'::jsonb) from (
    select to_jsonb(e) || jsonb_build_object(
      'created_by_name', (select full_name from public.profiles pr where pr.id = e.created_by),
      'voided_by_name', (select full_name from public.profiles pr where pr.id = e.voided_by),
      'lines', (select jsonb_agg(jsonb_build_object('account', l.account_code, 'debit', l.debit, 'credit', l.credit, 'memo', l.memo) order by l.id)
                from public.acct_lines l where l.entry_id = e.id)) as x
    from public.acct_entries e
    where (p_from is null or e.entry_date >= p_from) and (p_to is null or e.entry_date <= p_to)
  ) t
$$;

-- Every project and purchase with its VAT tag, for the tagging screen.
create function public.acct_vat_tags() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'default_project_vat', (select default_project_vat from public.acct_settings),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('id', d.id,
        'name', coalesce(nullif(btrim(d.data ->> 'name'), ''), d.id), 'status', coalesce(d.data ->> 'status', 'active'),
        'treatment', t.treatment) order by coalesce(nullif(btrim(d.data ->> 'name'), ''), d.id))
      from public.tracker_docs d left join public.acct_project_vat t on t.project_id = d.id
      where d.collection = 'projects'), '[]'::jsonb),
    'purchases', coalesce((select jsonb_agg(to_jsonb(p) - 'cost_account' order by p.purchase_date desc nulls first, p.doc_id)
      from public.acct_purchases p), '[]'::jsonb))
$$;

-- p_treatment null: back to the default.
create function public.acct_tag_project(p_project text, p_treatment text) returns void
language plpgsql security invoker set search_path = public as $$
begin
  perform public.acct_require_admin();
  if p_treatment is null then
    delete from public.acct_project_vat where project_id = p_project;
  else
    insert into public.acct_project_vat (project_id, treatment) values (p_project, p_treatment)
    on conflict (project_id) do update set treatment = excluded.treatment, updated_at = now(), updated_by = auth.uid();
  end if;
end $$;

-- p_vat_invoice false removes the tag; p_input_vat null means 12/112 of the amount.
create function public.acct_tag_purchase(p_collection text, p_doc text, p_vat_invoice boolean, p_input_vat numeric default null)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  perform public.acct_require_admin();
  if not coalesce(p_vat_invoice, false) then
    delete from public.acct_purchase_vat where collection = p_collection and doc_id = p_doc;
  else
    insert into public.acct_purchase_vat (collection, doc_id, input_vat) values (p_collection, p_doc, p_input_vat)
    on conflict (collection, doc_id) do update set input_vat = excluded.input_vat, updated_at = now(), updated_by = auth.uid();
  end if;
end $$;

-- --------------------------------------------------------------- access ----

alter table public.acct_accounts enable row level security;
alter table public.acct_settings enable row level security;
alter table public.acct_entries enable row level security;
alter table public.acct_lines enable row level security;
alter table public.acct_project_vat enable row level security;
alter table public.acct_purchase_vat enable row level security;

create policy "accounts: admin reads" on public.acct_accounts for select using (public.is_admin());
create policy "accounts: admin adds" on public.acct_accounts for insert with check (public.is_admin());
create policy "accounts: admin edits" on public.acct_accounts for update using (public.is_admin()) with check (public.is_admin());

create policy "settings: admin reads" on public.acct_settings for select using (public.is_admin());
create policy "settings: admin edits" on public.acct_settings for update using (public.is_admin()) with check (public.is_admin());

create policy "entries: admin reads" on public.acct_entries for select using (public.is_admin());
create policy "entries: admin posts" on public.acct_entries for insert with check (public.is_admin());
create policy "entries: admin voids" on public.acct_entries for update using (public.is_admin()) with check (public.is_admin());

create policy "lines: admin reads" on public.acct_lines for select using (public.is_admin());
create policy "lines: admin posts" on public.acct_lines for insert with check (public.is_admin());

create policy "project VAT: admin only" on public.acct_project_vat for all
  using (public.is_admin()) with check (public.is_admin());
create policy "purchase VAT: admin only" on public.acct_purchase_vat for all
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.acct_accounts, public.acct_settings, public.acct_entries, public.acct_lines,
  public.acct_project_vat, public.acct_purchase_vat, public.acct_payments, public.acct_purchases,
  public.acct_auto_lines, public.acct_gl from anon;
revoke execute on function public.acct_ledger(date, date, text), public.acct_trial_balance(date),
  public.acct_income_statement(date, date), public.acct_balance_sheet(date), public.acct_vat_quarters(int),
  public.acct_receivables(), public.acct_data_issues(), public.acct_post_entry(date, text, jsonb, text, text),
  public.acct_void_entry(bigint, text), public.acct_num(jsonb), public.acct_date(text),
  public.acct_require_admin(), public.acct_config(), public.acct_save_settings(jsonb),
  public.acct_save_account(text, text, public.acct_type, boolean, text), public.acct_journal(date, date),
  public.acct_vat_tags(), public.acct_tag_project(text, text), public.acct_tag_purchase(text, text, boolean, numeric)
  from public, anon;
grant execute on function public.acct_ledger(date, date, text), public.acct_trial_balance(date),
  public.acct_income_statement(date, date), public.acct_balance_sheet(date), public.acct_vat_quarters(int),
  public.acct_receivables(), public.acct_data_issues(), public.acct_post_entry(date, text, jsonb, text, text),
  public.acct_void_entry(bigint, text), public.acct_num(jsonb), public.acct_date(text),
  public.acct_require_admin(), public.acct_config(), public.acct_save_settings(jsonb),
  public.acct_save_account(text, text, public.acct_type, boolean, text), public.acct_journal(date, date),
  public.acct_vat_tags(), public.acct_tag_project(text, text), public.acct_tag_purchase(text, text, boolean, numeric)
  to authenticated;
revoke execute on function public.acct_default_side(), public.acct_check_settings(), public.acct_guard_entry(),
  public.acct_guard_line(), public.acct_check_balanced() from public, anon, authenticated;
