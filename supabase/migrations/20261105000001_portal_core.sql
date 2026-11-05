-- Ritehome portal: staff accounts and roles, the existing tracker's data,
-- the design-to-installation pipeline, calendar events and attendance.
--
-- Access model (enforced here, in row-level security, not in the page):
--   admin        everything, including all money (budgets, billing, expenses,
--                fuel, procurement) and everyone's attendance
--   designer     assigned projects; updates design, cutlist and BOM stages
--   fabrication  assigned projects; updates the fabrication stage
--   installer    assigned projects; updates installation and handover stages
-- Every non-admin sees only a project's name, system, client name and phone,
-- address, status and target date -- never budget, price, billing or email.
-- Accounts start inactive: an admin must activate each one and set its role.

-- ---------------------------------------------------------------- roles ----

create type public.staff_role as enum ('admin', 'designer', 'fabrication', 'installer');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (length(full_name) <= 120),
  role public.staff_role not null default 'installer',
  active boolean not null default false,
  -- 128-number face descriptor taken at enrollment, in the admin's presence.
  -- Readable by its owner so the phone can compare a fresh selfie against it.
  face_descriptor real[] check (face_descriptor is null or array_length(face_descriptor, 1) = 128),
  face_enrolled_at timestamptz,
  attendance_consent_at timestamptz,
  created_at timestamptz not null default now()
);

-- Every new sign-in account gets an inactive profile; nothing is visible until
-- an admin activates it.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- The caller's role, or null when signed out or not yet activated.
create function public.my_role() returns public.staff_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false)
$$;

-- ------------------------------------------------- existing tracker data ----
-- The tracker page reads and writes JSON documents (projects, expenses, fuel,
-- vehicles, procurement). They move here unchanged, admin-only.

create table public.tracker_docs (
  collection text not null check (collection in
    ('projects', 'expenses', 'companyFuel', 'companyVehicles', 'procurementJobs', 'procurement')),
  id text not null check (length(id) between 1 and 80),
  parent_id text check (parent_id is null or length(parent_id) <= 80),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  revision integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (collection, id)
);
create index tracker_docs_parent on public.tracker_docs (collection, parent_id);

create function public.touch_tracker_doc() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if tg_op = 'UPDATE' then new.revision := old.revision + 1; end if;
  return new;
end $$;
create trigger tracker_docs_touch before insert or update on public.tracker_docs
  for each row execute function public.touch_tracker_doc();

-- ------------------------------------------------------------- projects ----

create table public.project_assignments (
  project_collection text not null default 'projects' check (project_collection = 'projects'),
  project_id text not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (project_id, user_id),
  foreign key (project_collection, project_id) references public.tracker_docs (collection, id) on delete cascade
);

create function public.is_assigned(p_project text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() is not null and exists (
    select 1 from public.project_assignments a
    where a.project_id = p_project and a.user_id = auth.uid())
$$;

create function public.can_read_project(p_project text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.is_assigned(p_project)
$$;

-- The staff-safe face of a project: no money, no client email.
create function public.my_projects()
returns table (id text, name text, system text, client_name text, client_phone text,
               address text, status text, target_date text)
language sql stable security definer set search_path = public as $$
  select d.id, d.data ->> 'name', d.data ->> 'system', d.data ->> 'clientName',
         d.data ->> 'clientPhone', d.data ->> 'address', d.data ->> 'status', d.data ->> 'targetDate'
  from public.tracker_docs d
  where d.collection = 'projects' and public.can_read_project(d.id)
  order by d.data ->> 'targetDate' nulls last, d.data ->> 'name'
$$;

-- Names and roles of active staff, for assignee pickers. No face data.
create function public.staff_directory()
returns table (id uuid, full_name text, role public.staff_role)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role from public.profiles p
  where p.active and public.my_role() is not null
  order by p.full_name
$$;

-- ------------------------------------------------------------- pipeline ----

create type public.stage_key as enum
  ('consultation', 'design', 'cutlist', 'bom', 'procurement', 'fabrication', 'installation', 'handover');
create type public.stage_status as enum ('not_started', 'in_progress', 'blocked', 'done');

-- Which role may update which stage. Consultation and procurement are admin's.
create function public.role_owns_stage(p_role public.staff_role, p_stage text) returns boolean
language sql immutable as $$
  select case p_role
    when 'admin' then true
    when 'designer' then p_stage in ('design', 'cutlist', 'bom')
    when 'fabrication' then p_stage = 'fabrication'
    when 'installer' then p_stage in ('installation', 'handover')
    else false end
$$;

create function public.can_work_stage(p_project text, p_stage text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (public.is_assigned(p_project) and public.role_owns_stage(public.my_role(), p_stage))
$$;

create table public.project_stages (
  project_collection text not null default 'projects' check (project_collection = 'projects'),
  project_id text not null,
  stage public.stage_key not null,
  status public.stage_status not null default 'not_started',
  planned_start date,
  planned_end date,
  actual_start date,
  actual_end date,
  assignee uuid references public.profiles (id) on delete set null,
  notes text not null default '' check (length(notes) <= 4000),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (project_id, stage),
  foreign key (project_collection, project_id) references public.tracker_docs (collection, id) on delete cascade,
  check (planned_end is null or planned_start is null or planned_end >= planned_start),
  check (actual_end is null or actual_start is null or actual_end >= actual_start)
);

-- Staff can move their own stages along; only an admin plans dates or reassigns.
create function public.guard_stage_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and (
       new.project_id is distinct from old.project_id or new.stage is distinct from old.stage
    or new.planned_start is distinct from old.planned_start or new.planned_end is distinct from old.planned_end
    or new.assignee is distinct from old.assignee) then
    raise exception 'Only an admin can change planned dates or the assignee of a stage.'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger project_stages_guard before update on public.project_stages
  for each row execute function public.guard_stage_update();

-- Every project gets its full pipeline the moment it exists.
create function public.seed_project_stages() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.collection = 'projects' then
    insert into public.project_stages (project_id, stage)
    select new.id, s from unnest(enum_range(null::public.stage_key)) s
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger tracker_docs_seed_stages after insert on public.tracker_docs
  for each row execute function public.seed_project_stages();

-- ---------------------------------------------------------------- files ----
-- SketchUp models, cutlists, BOMs, drawings and photos, filed under a project
-- and stage. Bytes live in the private "project-files" storage bucket at
-- <project id>/<stage>/<file id>-<name>.

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_collection text not null default 'projects' check (project_collection = 'projects'),
  project_id text not null,
  stage public.stage_key not null,
  kind text not null check (kind in ('sketchup', 'cutlist', 'bom', 'drawing', 'photo', 'other')),
  file_name text not null check (length(file_name) between 1 and 200),
  storage_path text not null unique,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 104857600),
  uploaded_by uuid not null default auth.uid() references public.profiles (id),
  uploaded_at timestamptz not null default now(),
  foreign key (project_collection, project_id) references public.tracker_docs (collection, id) on delete cascade,
  check (left(storage_path, length(project_id) + length(stage::text) + 2) = project_id || '/' || stage::text || '/')
);
create index project_files_project on public.project_files (project_id, stage);

-- ------------------------------------------------------------- calendar ----

create table public.project_events (
  id uuid primary key default gen_random_uuid(),
  project_collection text default 'projects' check (project_collection = 'projects'),
  project_id text,                       -- null = company-wide (e.g. a holiday)
  kind text not null check (kind in ('site_visit', 'delivery', 'installation', 'meeting', 'holiday', 'other')),
  title text not null check (length(title) between 1 and 160),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  notes text not null default '' check (length(notes) <= 2000),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (project_collection, project_id) references public.tracker_docs (collection, id) on delete cascade,
  check (ends_at >= starts_at)
);
create index project_events_time on public.project_events (starts_at);

-- ----------------------------------------------------------- attendance ----
-- Four punches a day, each with a selfie and a GPS fix taken at that moment.
-- Location is recorded only at a punch, never tracked in between. The punch
-- time and work date come from the server clock, so a phone can't backdate.

create type public.punch_kind as enum ('am_in', 'am_out', 'pm_in', 'pm_out');

create table public.attendance_punches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind public.punch_kind not null,
  punched_at timestamptz not null default now(),
  work_date date not null default ((now() at time zone 'Asia/Manila')::date),
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_m real check (accuracy_m >= 0),
  selfie_path text not null,
  face_match real check (face_match is null or face_match between 0 and 1),
  flags text[] not null default '{}',
  admin_note text not null default '' check (length(admin_note) <= 1000),
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  selfie_deleted_at timestamptz,
  unique (user_id, work_date, kind)
);
create index attendance_by_day on public.attendance_punches (work_date, user_id);

-- Below this on-device similarity score a punch is flagged for review.
create function public.face_match_threshold() returns real language sql immutable as $$ select 0.55::real $$;

create function public.prepare_punch() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  local_now timestamp := now() at time zone 'Asia/Manila';
  t time := local_now::time;
  f text[] := '{}';
  consent timestamptz;
begin
  if public.my_role() is null then
    raise exception 'This account is not active yet.' using errcode = '42501';
  end if;
  if new.user_id is distinct from auth.uid() then
    raise exception 'You can only clock in for yourself.' using errcode = '42501';
  end if;
  select attendance_consent_at into consent from public.profiles where id = auth.uid();
  if consent is null then
    raise exception 'Read and accept the attendance notice before your first punch.' using errcode = '42501';
  end if;
  if left(new.selfie_path, 37) is distinct from auth.uid()::text || '/' then
    raise exception 'The selfie must be uploaded to your own folder.' using errcode = '42501';
  end if;

  new.punched_at := now();
  new.work_date := local_now::date;
  new.reviewed_by := null;
  new.reviewed_at := null;
  new.admin_note := '';
  new.selfie_deleted_at := null;

  if new.kind = 'am_in' and t > time '08:00' then f := f || 'late'::text; end if;
  if new.kind = 'pm_in' and t > time '13:00' then f := f || 'late'::text; end if;
  if new.kind = 'am_out' and t < time '12:00' then f := f || 'early_out'::text; end if;
  if new.kind = 'pm_out' and t < time '17:00' then f := f || 'early_out'::text; end if;
  if new.face_match is null then f := f || 'no_face_check'::text;
  elsif new.face_match < public.face_match_threshold() then f := f || 'face_mismatch'::text; end if;
  if new.accuracy_m is null or new.accuracy_m > 100 then f := f || 'low_gps_accuracy'::text; end if;
  new.flags := f;
  return new;
end $$;
create trigger attendance_prepare before insert on public.attendance_punches
  for each row execute function public.prepare_punch();

-- A punch is a record: after it's made, only the review fields may change.
create function public.guard_punch_update() returns trigger
language plpgsql as $$
begin
  if (new.id, new.user_id, new.kind, new.punched_at, new.work_date, new.lat, new.lng,
      new.accuracy_m, new.selfie_path, new.face_match, new.flags)
     is distinct from
     (old.id, old.user_id, old.kind, old.punched_at, old.work_date, old.lat, old.lng,
      old.accuracy_m, old.selfie_path, old.face_match, old.flags) then
    raise exception 'A punch can''t be edited after it''s made; add a review note instead.'
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger attendance_guard before update on public.attendance_punches
  for each row execute function public.guard_punch_update();

-- Self-service actions. Profiles are otherwise admin-only to write, so nobody
-- can promote themselves.
create function public.accept_attendance_notice() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  if public.my_role() is null then
    raise exception 'This account is not active yet.' using errcode = '42501';
  end if;
  update public.profiles set attendance_consent_at = coalesce(attendance_consent_at, now())
  where id = auth.uid() returning attendance_consent_at into v_at;
  return v_at;
end $$;

-- --------------------------------------------------------------- access ----

alter table public.profiles enable row level security;
alter table public.tracker_docs enable row level security;
alter table public.project_assignments enable row level security;
alter table public.project_stages enable row level security;
alter table public.project_files enable row level security;
alter table public.project_events enable row level security;
alter table public.attendance_punches enable row level security;

create policy "profiles: read own or admin" on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy "profiles: admin writes" on public.profiles for update
  using (public.is_admin()) with check (public.is_admin());

create policy "tracker data: admin only" on public.tracker_docs for all
  using (public.is_admin()) with check (public.is_admin());

create policy "assignments: read own or admin" on public.project_assignments for select
  using (user_id = auth.uid() and public.my_role() is not null or public.is_admin());
create policy "assignments: admin writes" on public.project_assignments for all
  using (public.is_admin()) with check (public.is_admin());

create policy "stages: assigned staff read" on public.project_stages for select
  using (public.can_read_project(project_id));
create policy "stages: staff update their own stages" on public.project_stages for update
  using (public.can_work_stage(project_id, stage::text))
  with check (public.can_work_stage(project_id, stage::text));
create policy "stages: admin inserts" on public.project_stages for insert
  with check (public.is_admin());
create policy "stages: admin deletes" on public.project_stages for delete
  using (public.is_admin());

create policy "files: assigned staff read" on public.project_files for select
  using (public.can_read_project(project_id));
create policy "files: upload to your own stages" on public.project_files for insert
  with check (uploaded_by = auth.uid() and public.can_work_stage(project_id, stage::text));
create policy "files: uploader or admin deletes" on public.project_files for delete
  using (public.is_admin() or (uploaded_by = auth.uid() and public.can_work_stage(project_id, stage::text)));

create policy "events: staff read their projects and company events" on public.project_events for select
  using (public.is_admin() or (public.my_role() is not null and (project_id is null or public.is_assigned(project_id))));
create policy "events: admin writes" on public.project_events for all
  using (public.is_admin()) with check (public.is_admin());

create policy "attendance: read own or admin" on public.attendance_punches for select
  using (user_id = auth.uid() or public.is_admin());
create policy "attendance: punch for yourself" on public.attendance_punches for insert
  with check (user_id = auth.uid() and public.my_role() is not null);
create policy "attendance: admin reviews" on public.attendance_punches for update
  using (public.is_admin()) with check (public.is_admin());

-- Signed-out visitors get nothing at all.
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on function public.my_role(), public.is_admin(), public.is_assigned(text),
  public.can_read_project(text), public.can_work_stage(text, text), public.role_owns_stage(public.staff_role, text),
  public.my_projects(), public.staff_directory(), public.accept_attendance_notice(),
  public.face_match_threshold() to authenticated;
