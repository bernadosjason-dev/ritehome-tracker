-- Phase 4: approvals (the CRM master prompt, section 7: department hand-off and approval workflow).
--
-- A stage that needs approval is not finished by its department: they submit it for review with a
-- note (and a link to the drawing, cutlist or BOM if there is one). Each submission is a numbered
-- version. The admin approves it (the stage is done and the next department may start) or asks for a
-- revision, which needs remarks. Submissions and decisions are never edited or deleted, so every
-- earlier version stays. The admin decides which stages need approval (approval_rules).
--
-- Rules, enforced here and nowhere else:
--   * staff can't mark an approval stage done, or move it while a submission waits;
--   * a stage can't start until the stage before it (if that one needs approval) is approved;
--   * the admin can do anything; marking a stage done on the Schedule approves what was waiting.

-- ------------------------------------------------------------- the rules ----

create table public.approval_rules (
  stage public.stage_key primary key,
  required boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
-- Defaults: the hand-offs the master prompt names. Consultation and site visit flow into design
-- without a review; procurement is the purchaser's own; handover is the end.
insert into public.approval_rules (stage, required)
select s, s in ('design', 'cutlist', 'bom', 'final_cutlist', 'fabrication', 'installation')
from unnest(enum_range(null::public.stage_key)) s;

alter table public.approval_rules enable row level security;
create policy "approval rules: every active account reads" on public.approval_rules for select
  using (public.my_role() is not null);
revoke insert, update, delete on public.approval_rules from anon, authenticated;

create function public.stage_needs_approval(p_stage text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select required from public.approval_rules where stage::text = p_stage), false)
$$;

-- The stage whose approval a stage waits for. Procurement starts from the BOM.
create function public.stage_prev(p_stage text) returns text
language sql immutable set search_path = public as $$
  select case p_stage
    when 'site_visit' then 'consultation' when 'design' then 'site_visit' when 'cutlist' then 'design'
    when 'bom' then 'cutlist' when 'final_cutlist' then 'bom' when 'procurement' then 'bom'
    when 'fabrication' then 'final_cutlist' when 'installation' then 'fabrication' when 'handover' then 'installation'
    else null end
$$;

-- ------------------------------------------------------- the submissions ----

create table public.stage_submissions (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  stage public.stage_key not null,
  version integer not null check (version > 0),
  note text not null check (length(btrim(note)) between 1 and 2000),
  link text not null default '' check (length(link) <= 500 and (link = '' or link ~* '^https?://')),
  submitted_by uuid not null default auth.uid() references public.profiles (id),
  submitted_at timestamptz not null default now(),
  decision text not null default 'pending' check (decision in ('pending', 'approved', 'revise')),
  remarks text not null default '' check (length(remarks) <= 2000),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  unique (project_id, stage, version),
  foreign key (project_id, stage) references public.project_stages (project_id, stage) on delete cascade,
  check (decision <> 'revise' or length(btrim(remarks)) > 0),
  check ((decision = 'pending') = (decided_at is null))
);
create unique index stage_submissions_one_pending on public.stage_submissions (project_id, stage) where decision = 'pending';
create index stage_submissions_recent on public.stage_submissions (submitted_at desc);

alter table public.stage_submissions enable row level security;
-- The admin sees all; staff see their own and the history of the stages they work.
create policy "submissions: admin, submitter and the stage's people read" on public.stage_submissions for select
  using (public.is_admin() or submitted_by = auth.uid() or public.can_work_stage(project_id, stage::text));
revoke insert, update, delete on public.stage_submissions from anon, authenticated;

-- Kept for good: a decision is added once, nothing else changes, nothing is deleted (except with the
-- project itself, which takes its stages and their history with it).
create function public.stage_submission_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'Submissions are kept: they can''t be deleted.' using errcode = '42501';
  end if;
  if old.decision <> 'pending' then
    raise exception 'A decided submission can''t be changed.' using errcode = '42501';
  end if;
  if (new.project_id, new.stage, new.version, new.note, new.link, new.submitted_by, new.submitted_at)
     is distinct from (old.project_id, old.stage, old.version, old.note, old.link, old.submitted_by, old.submitted_at) then
    raise exception 'Only the decision can be added to a submission.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger stage_submission_guard before update or delete on public.stage_submissions
  for each row execute function public.stage_submission_guard();

-- ------------------------------------------------------- the stage guard ----

-- Runs before project_stages_guard and project_stages_zz_dates (alphabetical).
create function public.stage_approval_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_pending boolean; v_prev text; v_prev_status public.stage_status;
begin
  if new.status is not distinct from old.status then return new; end if;
  v_pending := exists (select 1 from public.stage_submissions
                       where project_id = new.project_id and stage = new.stage and decision = 'pending');
  if public.is_admin() then
    if new.status = 'done' and v_pending then
      update public.stage_submissions set decision = 'approved', decided_by = auth.uid(), decided_at = now(),
        remarks = 'Marked done on the Schedule.'
      where project_id = new.project_id and stage = new.stage and decision = 'pending';
    end if;
    return new;
  end if;
  if public.stage_needs_approval(new.stage::text) then
    if new.status = 'submitted' and not v_pending then
      raise exception 'Submit % for review with a note.', public.stage_word(new.stage::text) using errcode = '42501';
    elsif v_pending and new.status <> 'submitted' then
      raise exception '% is waiting for the admin''s review.', public.stage_word(new.stage::text) using errcode = '42501';
    elsif new.status = 'done' then
      raise exception '% needs the admin''s approval: submit it for review.', public.stage_word(new.stage::text) using errcode = '42501';
    end if;
  end if;
  if old.status = 'not_started' then
    v_prev := public.stage_prev(new.stage::text);
    if v_prev is not null and public.stage_needs_approval(v_prev) then
      select status into v_prev_status from public.project_stages
      where project_id = new.project_id and stage = v_prev::public.stage_key;
      if found and v_prev_status <> 'done' then
        raise exception '% can''t start until % is approved.', public.stage_word(new.stage::text), public.stage_word(v_prev)
          using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger project_stages_approval before update of status on public.project_stages
  for each row execute function public.stage_approval_guard();

-- Stages already marked "submitted" on the board before this: their first version, so the admin can
-- decide them. Who submitted is the last person to change the stage (or the first admin).
insert into public.stage_submissions (project_id, stage, version, note, submitted_by, submitted_at)
select s.project_id, s.stage, 1, 'Marked submitted on the board before approvals started.',
       coalesce(s.updated_by, (select id from public.profiles where role = 'admin' and active order by id limit 1)), s.updated_at
from public.project_stages s
where s.status = 'submitted' and public.stage_needs_approval(s.stage::text)
  and coalesce(s.updated_by, (select id from public.profiles where role = 'admin' and active order by id limit 1)) is not null;

-- ------------------------------------------------------------ the actions ----

create function public.stage_submit(p_project text, p_stage public.stage_key, p_note text, p_link text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.project_stages; v integer; r public.stage_submissions; v_link text := btrim(coalesce(p_link, ''));
begin
  if public.my_role() is null then raise exception 'Sign in with an active account first.' using errcode = '42501'; end if;
  if not public.can_work_stage(p_project, p_stage::text) then
    raise exception 'That stage isn''t yours to submit.' using errcode = '42501';
  end if;
  if not public.stage_needs_approval(p_stage::text) then
    raise exception '% doesn''t need approval: mark it done on the Schedule.', public.stage_word(p_stage::text) using errcode = '22023';
  end if;
  select * into s from public.project_stages where project_id = p_project and stage = p_stage for update;
  if not found then raise exception 'No such stage.' using errcode = 'P0002'; end if;
  if s.status = 'done' then raise exception '% is already approved.', public.stage_word(p_stage::text) using errcode = '22023'; end if;
  if exists (select 1 from public.stage_submissions where project_id = p_project and stage = p_stage and decision = 'pending') then
    raise exception '% is already waiting for review.', public.stage_word(p_stage::text) using errcode = '22023';
  end if;
  if btrim(coalesce(p_note, '')) = '' then raise exception 'Say what you''re submitting in a short note.' using errcode = '23514'; end if;
  if v_link <> '' and v_link !~* '^https?://' then raise exception 'A link must start with http:// or https://.' using errcode = '22023'; end if;
  select coalesce(max(version), 0) + 1 into v from public.stage_submissions where project_id = p_project and stage = p_stage;
  insert into public.stage_submissions (project_id, stage, version, note, link)
  values (p_project, p_stage, v, left(btrim(p_note), 2000), left(v_link, 500)) returning * into r;
  update public.project_stages set status = 'submitted' where project_id = p_project and stage = p_stage and status <> 'submitted';
  return to_jsonb(r);
end $$;

create function public.stage_review(p_id uuid, p_decision text, p_remarks text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.stage_submissions;
begin
  if not public.is_admin() then raise exception 'Only an admin approves submissions.' using errcode = '42501'; end if;
  select * into r from public.stage_submissions where id = p_id for update;
  if not found then raise exception 'No such submission.' using errcode = 'P0002'; end if;
  if r.decision <> 'pending' then raise exception 'This submission was already decided.' using errcode = '22023'; end if;
  if p_decision not in ('approved', 'revise') then raise exception 'Approve it or ask for a revision.' using errcode = '22023'; end if;
  if p_decision = 'revise' and btrim(coalesce(p_remarks, '')) = '' then
    raise exception 'Say what needs changing: a revision needs remarks.' using errcode = '23514';
  end if;
  update public.stage_submissions set decision = p_decision, remarks = left(btrim(coalesce(p_remarks, '')), 2000),
    decided_by = auth.uid(), decided_at = now()
  where id = p_id returning * into r;
  update public.project_stages set status = case when p_decision = 'approved' then 'done' else 'in_progress' end::public.stage_status
  where project_id = r.project_id and stage = r.stage;
  return to_jsonb(r);
end $$;

create function public.approval_rules_save(p_stage public.stage_key, p_required boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin decides which stages need approval.' using errcode = '42501'; end if;
  update public.approval_rules set required = coalesce(p_required, false), updated_at = now(), updated_by = auth.uid()
  where stage = p_stage;
  return coalesce(p_required, false);
end $$;

create function public.approval_rules_list() returns jsonb
language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('stage', stage, 'required', required) order by stage), '[]'::jsonb)
  from public.approval_rules
$$;

-- The queue and the history. Admin: everything. Staff: their own and their stages' history.
-- Filters: state ('pending' | 'decided' | all), project, stage, limit (default 100, at most 300).
create function public.approvals_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_limit integer := least(greatest(coalesce(nullif(p ->> 'limit', '')::integer, 100), 1), 300);
begin
  if public.my_role() is null then raise exception 'Sign in with an active account first.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by (x ->> 'decision') <> 'pending', x ->> 'at' desc) from (
    select jsonb_build_object('id', s.id, 'project_id', s.project_id,
        'project', coalesce(nullif(d.data ->> 'name', ''), s.project_id), 'stage', s.stage, 'version', s.version,
        'note', s.note, 'link', s.link, 'submitted_by', s.submitted_by, 'submitter', coalesce(ps.full_name, ''),
        'submitted_at', s.submitted_at, 'decision', s.decision, 'remarks', s.remarks,
        'decider', coalesce(pd.full_name, ''), 'decided_at', s.decided_at, 'mine', s.submitted_by = auth.uid(),
        'at', coalesce(s.decided_at, s.submitted_at)) as x
    from public.stage_submissions s
    left join public.tracker_docs d on d.collection = 'projects' and d.id = s.project_id
    left join public.profiles ps on ps.id = s.submitted_by
    left join public.profiles pd on pd.id = s.decided_by
    where (public.is_admin() or s.submitted_by = auth.uid() or public.can_work_stage(s.project_id, s.stage::text))
      and (coalesce(p ->> 'state', '') = '' or (p ->> 'state' = 'pending') = (s.decision = 'pending'))
      and (coalesce(p ->> 'project', '') = '' or s.project_id = p ->> 'project')
      and (coalesce(p ->> 'stage', '') = '' or s.stage::text = p ->> 'stage')
    order by s.decision <> 'pending', coalesce(s.decided_at, s.submitted_at) desc
    limit v_limit) t), '[]'::jsonb);
end $$;

revoke execute on function public.stage_submit(text, public.stage_key, text, text), public.stage_review(uuid, text, text),
  public.approval_rules_save(public.stage_key, boolean), public.approval_rules_list(), public.approvals_list(jsonb),
  public.stage_needs_approval(text), public.stage_prev(text) from public, anon;
grant execute on function public.stage_submit(text, public.stage_key, text, text), public.stage_review(uuid, text, text),
  public.approval_rules_save(public.stage_key, boolean), public.approval_rules_list(), public.approvals_list(jsonb),
  public.stage_needs_approval(text), public.stage_prev(text) to authenticated;
revoke execute on function public.stage_approval_guard(), public.stage_submission_guard() from public, anon, authenticated;

-- ---------------------------------------------- activity log and the bell ----

create trigger zz_audit after insert or update or delete on public.stage_submissions
  for each row execute function public.audit_row('project_id', 'stage', 'version');
create trigger zz_audit after insert or update or delete on public.approval_rules
  for each row execute function public.audit_row('stage');

create or replace function public.audit_module(p_table text, p_row jsonb) returns text
language sql immutable set search_path = public as $$
  select case
    when p_table = 'tracker_docs' then case p_row ->> 'collection'
      when 'projects' then 'Projects' when 'expenses' then 'Projects'
      when 'companyFuel' then 'Company fuel' when 'companyVehicles' then 'Company fuel'
      when 'procurementJobs' then 'Procurement' when 'procurement' then 'Procurement' else 'Projects' end
    when p_table in ('project_stages', 'project_events', 'project_files', 'project_assignments') then 'Schedule'
    when p_table in ('stage_submissions', 'approval_rules') then 'Approvals'
    when p_table in ('leads', 'lead_activity') then 'Leads'
    when p_table like 'acct\_%' then 'Accounting'
    when p_table like 'inventory\_%' then 'Inventory'
    when p_table = 'attendance_punches' then 'Attendance'
    when p_table = 'profiles' then 'Team'
    else p_table end
$$;

-- The bell: a submission is a hand-off with its note; the stage turning "submitted" with it isn't
-- news twice. (Everything else as in 20261120000017_notifications.sql.)
create or replace function public.notify_from_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a public.audit_log := new;
  who text := coalesce(nullif(a.actor_name, ''), case when a.actor is null then 'The website' else 'Someone' end);
  proj text := (select d.data ->> 'name' from public.tracker_docs d where d.collection = 'projects' and d.id = a.project_id);
  lvl text := 'info'; title text; body text := ''; link text := '/activity'; st text; flags jsonb;
  it public.inventory_items; onhand numeric; qty numeric;
begin
  -- The admin's own actions, and notes the services write for the admin, notify nobody.
  if a.actor is not null and 'admin' = any (a.actor_roles) then return null; end if;
  -- With nobody signed in, only a website lead is news; anything else is maintenance.
  if a.actor is null and not (a.table_name = 'leads' and a.action = 'insert') then return null; end if;

  if a.action = 'refused' then
    lvl := 'alert'; title := who || ' was refused: ' || coalesce(nullif(a.label, ''), 'an action');
    body := coalesce(a.new ->> 'detail', '');
  elsif a.action = 'delete' then
    lvl := 'alert'; title := who || ' deleted ' || coalesce(nullif(a.label, ''), a.table_name);
    body := a.module || coalesce(' · ' || proj, '');
  elsif a.table_name = 'leads' and a.action = 'insert' then
    lvl := 'handoff'; title := 'New lead: ' || coalesce(nullif(a.label, ''), 'no name');
    body := case when a.actor is null then 'From the website' else 'Added by ' || who end;
    link := '/leads#lead=' || a.record_id;
  elsif a.table_name = 'leads' and 'stage' = any (a.changed) then
    st := a.new ->> 'stage';
    lvl := case when st = 'won' then 'handoff' else 'info' end;
    title := who || ' moved lead ' || a.label || ' to ' || st;
    link := '/leads#lead=' || a.record_id;
  elsif a.table_name = 'leads' then
    title := who || ' updated lead ' || a.label; link := '/leads#lead=' || a.record_id;
  elsif a.table_name = 'lead_activity' then
    title := who || ' logged ' || coalesce(a.new ->> 'kind', 'a note') || ' with a lead'; body := a.label;
    link := '/leads#lead=' || coalesce(a.new ->> 'lead_id', '');
  elsif a.table_name = 'stage_submissions' and a.action = 'insert' then
    lvl := 'handoff';
    title := who || ' submitted ' || public.stage_word(a.new ->> 'stage') || ' v' || coalesce(a.new ->> 'version', '1')
      || ' for review' || coalesce(' · ' || proj, '');
    body := coalesce(a.new ->> 'note', ''); link := '/approvals';
  elsif a.table_name in ('stage_submissions', 'approval_rules') then
    return null;   -- decisions and rules are the admin's own
  elsif a.table_name = 'project_stages' and 'status' = any (a.changed) and a.new ->> 'status' = 'submitted'
        and public.stage_needs_approval(split_part(a.record_id, '/', 2)) then
    return null;   -- the submission (above) is the news, with its note
  elsif a.table_name = 'project_stages' and 'status' = any (a.changed) then
    st := a.new ->> 'status';
    lvl := case when st in ('done', 'submitted') then 'handoff' when st = 'blocked' then 'alert' else 'info' end;
    title := who || ' ' || case st when 'done' then 'finished' when 'submitted' then 'submitted' when 'blocked' then 'is blocked on'
      when 'waiting_client' then 'is waiting on the client for' when 'in_progress' then 'started' else 'reset' end
      || ' ' || public.stage_word(split_part(a.record_id, '/', 2)) || coalesce(' · ' || proj, '');
    body := coalesce(a.new ->> 'notes', ''); link := '/schedule';
  elsif a.table_name = 'project_stages' then
    title := who || ' updated ' || public.stage_word(split_part(a.record_id, '/', 2)) || coalesce(' · ' || proj, '');
    link := '/schedule';
  elsif a.table_name = 'project_files' and a.action = 'insert' then
    title := who || ' uploaded ' || coalesce(nullif(a.new ->> 'file_name', ''), 'a file') || coalesce(' · ' || proj, '');
    link := '/schedule';
  elsif a.table_name = 'inventory_moves' and a.action = 'insert' then
    select * into it from public.inventory_items where id = (a.new ->> 'item_id')::uuid;
    qty := trim_scale((a.new ->> 'qty')::numeric);
    onhand := trim_scale(public.inventory_on_hand(it.id));
    title := who || ' ' || case when qty < 0 then 'took ' || abs(qty) else 'added ' || qty end || ' ' || coalesce(it.unit, '') || ' ' || coalesce(it.name, 'stock')
      || coalesce(' for ' || nullif(a.new ->> 'job', ''), '');
    body := onhand || ' ' || coalesce(it.unit, '') || ' left';
    link := '/inventory';
    if it.reorder_level > 0 and onhand <= it.reorder_level and onhand - qty > it.reorder_level then
      lvl := 'alert';
      title := coalesce(it.name, 'An item') || case when onhand <= 0 then ' is out' else ' is low: ' || onhand || ' ' || coalesce(it.unit, '') || ' left' end;
      body := 'Reorder level ' || trim_scale(it.reorder_level) || '. Last: ' || who || case when qty < 0 then ' took ' || abs(qty) else ' counted' end || '.';
    end if;
  elsif a.table_name = 'attendance_punches' and a.action = 'insert' then
    flags := coalesce(a.new -> 'flags', '[]'::jsonb);
    if flags ? 'face_mismatch' then
      lvl := 'alert'; title := who || '''s selfie doesn''t match their reference photo';
    elsif flags ? 'late' or flags ? 'early_out' then
      title := who || case when flags ? 'late' then ' clocked in late' else ' clocked out early' end;
    elsif flags ? 'off_site' then
      title := who || ' clocked from outside the office';
    else
      return null;   -- an ordinary punch is not news
    end if;
    body := replace(coalesce(a.new ->> 'kind', ''), '_', ' '); link := '/attendance';
  elsif a.table_name = 'tracker_docs' and a.module = 'Procurement' then
    title := who || ' ' || case a.action when 'insert' then 'added' else 'changed' end || ' ' || coalesce(nullif(a.label, ''), 'a procurement record');
    link := '/procurement';
  else
    title := who || ' ' || case a.action when 'insert' then 'added' else 'changed' end || ' ' || coalesce(nullif(a.label, ''), a.table_name)
      || coalesce(' · ' || proj, '');
  end if;

  insert into public.notify_events (audit_id, at, level, module, actor, title, body, link, telegram)
  values (a.id, a.at, lvl, a.module, a.actor, left(title, 300), left(coalesce(body, ''), 600), link,
          case when public.notify_telegram_wanted(lvl) then 'pending' else 'none' end)
  on conflict (audit_id) do nothing;
  return null;
end $$;
