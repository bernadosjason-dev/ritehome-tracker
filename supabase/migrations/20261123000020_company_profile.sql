-- Phase 5a (v3.0): Company profile (the CRM master prompt, section 14).
--
-- One profile row (name, logo, address, contact numbers, email, business information, the people
-- authorised to sign for the company) and a register of company documents (registrations, permits,
-- contracts) with their expiry dates. The bookkeeper edits it; the admin has full access, including
-- removing a document (archived, never deleted: the file stays). Nobody else sees it (the
-- permission matrix: Company Profile = Admin full, Bookkeeper edit, everyone else no).
--
-- Files live in the private 'company-files' bucket: logo/<uuid>.<ext> and documents/<uuid>.<ext>,
-- PDF or image, at most 10 MB, read through signed links only.

create function public.can_keep_books() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('admin') or public.has_role('bookkeeper')
$$;
revoke execute on function public.can_keep_books() from public, anon;
grant execute on function public.can_keep_books() to authenticated;

-- ------------------------------------------------------------ the profile ----

create table public.company_profile (
  id smallint primary key default 1 check (id = 1),
  legal_name text not null default '' check (length(legal_name) <= 160),
  trade_name text not null default '' check (length(trade_name) <= 160),
  logo_path text not null default '' check (logo_path = '' or logo_path ~ '^logo/[0-9a-f-]{36}\.(png|jpg|webp)$'),
  address text not null default '' check (length(address) <= 400),
  phones text not null default '' check (length(phones) <= 200),
  email text not null default '' check (length(email) <= 160 and (email = '' or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  website text not null default '' check (length(website) <= 200 and (website = '' or website ~* '^https?://')),
  tin text not null default '' check (length(tin) <= 40),
  business_type text not null default '' check (business_type in ('', 'sole_proprietorship', 'partnership', 'corporation', 'opc')),
  vat_registered boolean,
  registration_no text not null default '' check (length(registration_no) <= 80),
  business_info text not null default '' check (length(business_info) <= 4000),
  -- People authorised to sign for or represent the company: [{name, position, phone, email}], at most 10.
  authorized jsonb not null default '[]'::jsonb check (jsonb_typeof(authorized) = 'array' and jsonb_array_length(authorized) <= 10),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
insert into public.company_profile (id, legal_name, trade_name) values (1, 'Ritehome Modular Systems', 'Ritehome');

alter table public.company_profile enable row level security;
create policy "company profile: admin and bookkeeper read" on public.company_profile for select
  using (public.can_keep_books());
revoke insert, update, delete on public.company_profile from anon, authenticated;

-- Saves the fields sent (others stay). Admin or bookkeeper.
create function public.company_profile_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.company_profile; v_auth jsonb; e jsonb;
begin
  if not public.can_keep_books() then raise exception 'The company profile is for the admin and the bookkeeper.' using errcode = '42501'; end if;
  if p ? 'authorized' then
    if jsonb_typeof(p -> 'authorized') <> 'array' then raise exception 'Authorised people must be a list.' using errcode = '22023'; end if;
    v_auth := '[]'::jsonb;
    for e in select * from jsonb_array_elements(p -> 'authorized') loop
      continue when btrim(coalesce(e ->> 'name', '')) = '';
      if length(e ->> 'name') > 120 or length(coalesce(e ->> 'position', '')) > 120 or length(coalesce(e ->> 'phone', '')) > 40
         or length(coalesce(e ->> 'email', '')) > 160 then
        raise exception 'Keep each authorised person''s details short (name and position under 120 characters).' using errcode = '22001';
      end if;
      v_auth := v_auth || jsonb_build_array(jsonb_build_object('name', btrim(e ->> 'name'), 'position', btrim(coalesce(e ->> 'position', '')),
        'phone', btrim(coalesce(e ->> 'phone', '')), 'email', btrim(coalesce(e ->> 'email', ''))));
    end loop;
    if jsonb_array_length(v_auth) > 10 then raise exception 'List at most 10 authorised people.' using errcode = '22023'; end if;
  end if;
  update public.company_profile c set
    legal_name = case when p ? 'legal_name' then btrim(coalesce(p ->> 'legal_name', '')) else c.legal_name end,
    trade_name = case when p ? 'trade_name' then btrim(coalesce(p ->> 'trade_name', '')) else c.trade_name end,
    logo_path = case when p ? 'logo_path' then btrim(coalesce(p ->> 'logo_path', '')) else c.logo_path end,
    address = case when p ? 'address' then btrim(coalesce(p ->> 'address', '')) else c.address end,
    phones = case when p ? 'phones' then btrim(coalesce(p ->> 'phones', '')) else c.phones end,
    email = case when p ? 'email' then btrim(coalesce(p ->> 'email', '')) else c.email end,
    website = case when p ? 'website' then btrim(coalesce(p ->> 'website', '')) else c.website end,
    tin = case when p ? 'tin' then btrim(coalesce(p ->> 'tin', '')) else c.tin end,
    business_type = case when p ? 'business_type' then coalesce(p ->> 'business_type', '') else c.business_type end,
    vat_registered = case when p ? 'vat_registered' then (nullif(p ->> 'vat_registered', ''))::boolean else c.vat_registered end,
    registration_no = case when p ? 'registration_no' then btrim(coalesce(p ->> 'registration_no', '')) else c.registration_no end,
    business_info = case when p ? 'business_info' then btrim(coalesce(p ->> 'business_info', '')) else c.business_info end,
    authorized = case when p ? 'authorized' then v_auth else c.authorized end,
    updated_at = now(), updated_by = auth.uid()
  where id = 1 returning * into r;
  return to_jsonb(r);
end $$;

-- ---------------------------------------------------------- the documents ----

create table public.company_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 120),
  kind text not null default 'other' check (kind in ('dti_sec', 'bir', 'mayors_permit', 'barangay', 'government_ids',
    'contract', 'insurance', 'bank', 'other')),
  file_path text not null unique check (file_path ~ '^documents/[0-9a-f-]{36}\.(pdf|png|jpg|webp)$'),
  file_name text not null default '' check (length(file_name) <= 200),
  size_bytes integer check (size_bytes between 1 and 10485760),
  expires_on date,
  notes text not null default '' check (length(notes) <= 1000),
  uploaded_by uuid not null default auth.uid() references public.profiles (id),
  uploaded_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index company_documents_expiry on public.company_documents (expires_on) where archived_at is null;

alter table public.company_documents enable row level security;
create policy "company documents: admin and bookkeeper read" on public.company_documents for select
  using (public.can_keep_books());
revoke insert, update, delete on public.company_documents from anon, authenticated;

create function public.company_document_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.company_documents; v_id uuid := nullif(p ->> 'id', '')::uuid;
begin
  if not public.can_keep_books() then raise exception 'Company documents are for the admin and the bookkeeper.' using errcode = '42501'; end if;
  if v_id is null then
    -- The file must already be in the bucket (uploaded by the page a moment ago).
    if not exists (select 1 from storage.objects where bucket_id = 'company-files' and name = p ->> 'file_path') then
      raise exception 'The file didn''t arrive. Choose it again and retry.' using errcode = 'P0002';
    end if;
    insert into public.company_documents (title, kind, file_path, file_name, size_bytes, expires_on, notes)
    values (btrim(coalesce(p ->> 'title', '')), coalesce(nullif(p ->> 'kind', ''), 'other'), p ->> 'file_path',
            left(coalesce(p ->> 'file_name', ''), 200), nullif(p ->> 'size_bytes', '')::integer,
            nullif(p ->> 'expires_on', '')::date, btrim(coalesce(p ->> 'notes', '')))
    returning * into r;
  else
    update public.company_documents d set
      title = case when p ? 'title' then btrim(coalesce(p ->> 'title', '')) else d.title end,
      kind = case when p ? 'kind' then coalesce(nullif(p ->> 'kind', ''), 'other') else d.kind end,
      expires_on = case when p ? 'expires_on' then nullif(p ->> 'expires_on', '')::date else d.expires_on end,
      notes = case when p ? 'notes' then btrim(coalesce(p ->> 'notes', '')) else d.notes end,
      updated_at = now(), updated_by = auth.uid()
    where id = v_id and archived_at is null returning * into r;
    if not found then raise exception 'That document isn''t in the register any more.' using errcode = 'P0002'; end if;
  end if;
  return to_jsonb(r);
end $$;

-- Removing is archiving: the record and the file stay, out of the list. Admin only.
create function public.company_document_archive(p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the admin removes company documents.' using errcode = '42501'; end if;
  update public.company_documents set archived_at = now(), archived_by = auth.uid(), updated_at = now(), updated_by = auth.uid()
  where id = p_id and archived_at is null;
  if not found then raise exception 'That document isn''t in the register any more.' using errcode = 'P0002'; end if;
  return true;
end $$;

-- Everything the page shows, with names instead of ids and days to expiry (Manila).
create function public.company_get() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Manila')::date;
begin
  if not public.can_keep_books() then raise exception 'The company profile is for the admin and the bookkeeper.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'profile', (select to_jsonb(c) || jsonb_build_object('updated_by_name', coalesce(pr.full_name, ''))
                from public.company_profile c left join public.profiles pr on pr.id = c.updated_by where c.id = 1),
    'documents', coalesce((select jsonb_agg(to_jsonb(d) || jsonb_build_object('uploader', coalesce(pr.full_name, ''),
                   'days_left', d.expires_on - today) order by d.expires_on nulls last, d.title)
                 from public.company_documents d left join public.profiles pr on pr.id = d.uploaded_by
                 where d.archived_at is null), '[]'::jsonb),
    'can_archive', public.is_admin());
end $$;

revoke execute on function public.company_profile_save(jsonb), public.company_document_save(jsonb),
  public.company_document_archive(uuid), public.company_get() from public, anon;
grant execute on function public.company_profile_save(jsonb), public.company_document_save(jsonb),
  public.company_document_archive(uuid), public.company_get() to authenticated;

-- ---------------------------------------------------------------- storage ----

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('company-files', 'company-files', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy "company files: admin and bookkeeper read" on storage.objects for select to authenticated
  using (bucket_id = 'company-files' and public.can_keep_books());
create policy "company files: admin and bookkeeper upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'company-files' and public.can_keep_books()
    and name ~ '^(logo/[0-9a-f-]{36}\.(png|jpg|webp)|documents/[0-9a-f-]{36}\.(pdf|png|jpg|webp))$');
-- No update policy (a file is never overwritten) and no delete policy (archived documents keep their file).

-- ---------------------------------------------- activity log and dashboard ----

create trigger zz_audit after insert or update or delete on public.company_profile
  for each row execute function public.audit_row('id');
create trigger zz_audit after insert or update or delete on public.company_documents
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
    when p_table = 'attendance_punches' then 'Attendance'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;

-- The dashboard also counts company documents that are expired or expire within 30 days.
create or replace function public.dashboard_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Asia/Manila')::date;
  r jsonb;
begin
  if not public.is_admin() then raise exception 'The dashboard is for the admin.' using errcode = '42501'; end if;
  with open_projects as (
    select d.id, coalesce(nullif(d.data ->> 'name', ''), d.id) as name from public.tracker_docs d
    where d.collection = 'projects' and coalesce(d.data ->> 'status', 'active') not in ('completed', 'cancelled')
  ), stages as (
    select s.*, p.name as project_name, pr.full_name as who
    from public.project_stages s join open_projects p on p.id = s.project_id
    left join public.profiles pr on pr.id = s.assignee
  ), stock as (
    select i.name, i.reorder_level, public.inventory_on_hand(i.id) as on_hand
    from public.inventory_items i where i.active and i.reorder_level > 0
  )
  select jsonb_build_object(
    'leads', jsonb_build_object(
      'open', (select count(*) from public.leads where stage not in ('won', 'lost')),
      'unanswered', (select count(*) from public.leads where stage = 'new' and first_response_at is null),
      'followups_due', (select count(*) from public.leads where stage not in ('won', 'lost') and next_action_at <= today)),
    'stages', jsonb_build_object(
      'submitted', (select count(*) from stages where status = 'submitted'),
      'blocked', (select count(*) from stages where status = 'blocked'),
      'overdue', (select count(*) from stages where status <> 'done' and planned_end < today)),
    'stock', jsonb_build_object(
      'out', (select count(*) from stock where on_hand <= 0),
      'low', (select count(*) from stock where on_hand > 0 and on_hand <= reorder_level)),
    'attendance', jsonb_build_object(
      'in_today', (select count(distinct user_id) from public.attendance_punches where work_date = today and kind in ('am_in', 'pm_in')),
      'staff', (select count(*) from public.profiles where active and role <> 'admin'),
      'to_check', (select count(*) from public.attendance_punches where cardinality(flags) > 0 and reviewed_at is null)),
    -- Company documents (permits, registrations) expired or expiring within 30 days.
    'company', jsonb_build_object(
      'expired', (select count(*) from public.company_documents where archived_at is null and expires_on < today),
      'expiring', (select count(*) from public.company_documents where archived_at is null and expires_on between today and today + 30),
      'next', (select jsonb_build_object('title', title, 'expires_on', expires_on) from public.company_documents
               where archived_at is null and expires_on is not null order by expires_on limit 1)),
    -- The stages waiting on the admin, oldest first: what "needs you" means on the schedule.
    'needs_you', coalesce((select jsonb_agg(x order by x ->> 'since') from (
        select jsonb_build_object('project_id', project_id, 'project', project_name, 'stage', stage, 'status', status,
          'who', coalesce(who, ''), 'since', (updated_at at time zone 'Asia/Manila')::date) as x
        from stages where status in ('submitted', 'blocked') order by updated_at limit 8) t), '[]'::jsonb)
  ) into r;
  return r;
end $$;
