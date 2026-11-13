-- Phase 5b (v3.1): the bookkeeper keeps the books (the CRM master prompt, section 12, and its permission
-- matrix: Accounting = admin full, bookkeeper edit). Before this, every rule in
-- 20261111000005_accounting.sql said "admin". Now it says "admin or bookkeeper" (can_keep_books(),
-- from 20261123000020_company_profile.sql): reading every report, posting and voiding journal entries,
-- the settings, the chart of accounts and the VAT tags. Entries are still voided, never edited or
-- deleted, and every change is in the activity log with who made it.
--
-- The books post tracker expenses, company fuel and client payments through views that run with the
-- reader's rights (security_invoker). So the bookkeeper also reads those records, and only those:
-- projects (prices, payments), expenses and company fuel. Read only: they can't change a project, an
-- expense or a fuel log, and they still can't see leads, procurement or anything else.

-- ------------------------------------------------------------- the books ----

drop policy "accounts: admin reads" on public.acct_accounts;
drop policy "accounts: admin adds" on public.acct_accounts;
drop policy "accounts: admin edits" on public.acct_accounts;
drop policy "settings: admin reads" on public.acct_settings;
drop policy "settings: admin edits" on public.acct_settings;
drop policy "entries: admin reads" on public.acct_entries;
drop policy "entries: admin posts" on public.acct_entries;
drop policy "entries: admin voids" on public.acct_entries;
drop policy "lines: admin reads" on public.acct_lines;
drop policy "lines: admin posts" on public.acct_lines;
drop policy "project VAT: admin only" on public.acct_project_vat;
drop policy "purchase VAT: admin only" on public.acct_purchase_vat;

create policy "accounts: books keepers read" on public.acct_accounts for select using (public.can_keep_books());
create policy "accounts: books keepers add" on public.acct_accounts for insert with check (public.can_keep_books());
create policy "accounts: books keepers edit" on public.acct_accounts for update using (public.can_keep_books()) with check (public.can_keep_books());
create policy "settings: books keepers read" on public.acct_settings for select using (public.can_keep_books());
create policy "settings: books keepers edit" on public.acct_settings for update using (public.can_keep_books()) with check (public.can_keep_books());
create policy "entries: books keepers read" on public.acct_entries for select using (public.can_keep_books());
create policy "entries: books keepers post" on public.acct_entries for insert with check (public.can_keep_books());
create policy "entries: books keepers void" on public.acct_entries for update using (public.can_keep_books()) with check (public.can_keep_books());
create policy "lines: books keepers read" on public.acct_lines for select using (public.can_keep_books());
create policy "lines: books keepers post" on public.acct_lines for insert with check (public.can_keep_books());
create policy "project VAT: books keepers" on public.acct_project_vat for all
  using (public.can_keep_books()) with check (public.can_keep_books());
create policy "purchase VAT: books keepers" on public.acct_purchase_vat for all
  using (public.can_keep_books()) with check (public.can_keep_books());

-- The functions that checked is_admin() themselves (the rest are invoker-rights: the policies decide).
create or replace function public.acct_post_entry(p_date date, p_memo text, p_lines jsonb, p_ref text default '', p_project text default null)
returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint; v_dr numeric; v_cr numeric;
begin
  if not public.can_keep_books() then
    raise exception 'Only the admin and the bookkeeper post to the books.' using errcode = '42501';
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

create or replace function public.acct_void_entry(p_id bigint, p_reason text) returns bigint
language plpgsql security invoker set search_path = public as $$
declare v_id bigint;
begin
  if not public.can_keep_books() then
    raise exception 'Only the admin and the bookkeeper void entries.' using errcode = '42501';
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

create or replace function public.acct_require_admin() returns void
language plpgsql stable set search_path = public as $$
begin
  if not public.can_keep_books() then
    raise exception 'Only the admin and the bookkeeper change the books.' using errcode = '42501';
  end if;
end $$;

-- ------------------------------------------------- the books' own sources ----

create policy "tracker data: bookkeeper reads the books' sources" on public.tracker_docs for select
  using (public.has_role('bookkeeper') and collection in ('projects', 'expenses', 'companyFuel'));
