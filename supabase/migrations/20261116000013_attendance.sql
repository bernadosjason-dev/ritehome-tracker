-- Attendance, on top of the punches table from portal_core: face reference photos, the face check
-- done here instead of trusted from the phone, distance from the office, and what the admin reviews.
--
-- What a punch proves and what it doesn't: the time is the server's, the place is the phone's GPS
-- fix at that moment, and the selfie is kept for the admin to look at. The face check compares the
-- selfie's 128-number face template (worked out on the phone; the photo itself is never analysed
-- by anyone else's service) with the person's reference template, here in the database. It is a
-- flag for review, not a lock: a punch always goes through, and anything doubtful is marked.

alter table public.profiles add column face_selfie_path text;
alter table public.attendance_punches add column office_distance_m real;

-- The showroom and workshop (the Google Business Profile's plus code GJ2F+655) and how far from it
-- still counts as "at the office". Installers clock in at client sites: off-site is information, not a fault.
create function public.office_site() returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object('lat', 8.500563, 'lng', 124.622937, 'radius_m', 150)
$$;

create function public.geo_distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable set search_path = public as $$
  select 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))
$$;

-- Similarity is 1 − the distance between the two templates. The same person in decent light scores
-- about 0.5 to 0.7; a different person, 0.2 to 0.4. Below this, the punch is flagged.
create or replace function public.face_match_threshold() returns real
language sql immutable set search_path = public as $$ select 0.45::real $$;

create or replace function public.prepare_punch() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  local_now timestamp := now() at time zone 'Asia/Manila';
  t time := local_now::time;
  f text[] := '{}';
  consent timestamptz;
  ref real[];
  seen real[];
  site jsonb := public.office_site();
begin
  if public.my_role() is null then
    raise exception 'This account is not active yet.' using errcode = '42501';
  end if;
  if new.user_id is distinct from auth.uid() then
    raise exception 'You can only clock in for yourself.' using errcode = '42501';
  end if;
  select attendance_consent_at, face_descriptor into consent, ref from public.profiles where id = auth.uid();
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

  -- The face score is worked out here from the template attendance_punch() passes along; a score
  -- sent straight from a phone is thrown away.
  begin
    seen := nullif(current_setting('app.punch_descriptor', true), '')::real[];
  exception when others then seen := null;
  end;
  if ref is null or seen is null or array_length(seen, 1) is distinct from 128 then
    new.face_match := null;
  else
    select greatest(0, least(1, 1 - sqrt(sum(power(a - b, 2)))))::real into new.face_match from unnest(ref, seen) as u(a, b);
  end if;
  new.office_distance_m := public.geo_distance_m(new.lat, new.lng, (site ->> 'lat')::double precision, (site ->> 'lng')::double precision)::real;

  if new.kind = 'am_in' and t > time '08:00' then f := f || 'late'::text; end if;
  if new.kind = 'pm_in' and t > time '13:00' then f := f || 'late'::text; end if;
  if new.kind = 'am_out' and t < time '12:00' then f := f || 'early_out'::text; end if;
  if new.kind = 'pm_out' and t < time '17:00' then f := f || 'early_out'::text; end if;
  if new.face_match is null then f := f || 'no_face_check'::text;
  elsif new.face_match < public.face_match_threshold() then f := f || 'face_mismatch'::text; end if;
  if new.accuracy_m is null or new.accuracy_m > 100 then f := f || 'low_gps_accuracy'::text; end if;
  if new.office_distance_m > (site ->> 'radius_m')::real then f := f || 'off_site'::text; end if;
  new.flags := f;
  return new;
end $$;

create or replace function public.guard_punch_update() returns trigger
language plpgsql set search_path = public as $$
begin
  if (new.id, new.user_id, new.kind, new.punched_at, new.work_date, new.lat, new.lng,
      new.accuracy_m, new.selfie_path, new.face_match, new.flags, new.office_distance_m)
     is distinct from
     (old.id, old.user_id, old.kind, old.punched_at, old.work_date, old.lat, old.lng,
      old.accuracy_m, old.selfie_path, old.face_match, old.flags, old.office_distance_m) then
    raise exception 'A punch can''t be edited after it''s made; add a review note instead.'
      using errcode = '42501';
  end if;
  return new;
end $$;

-- A person's own reference photo, taken once on their own phone. The admin sees it on the
-- Attendance page and can reset it; nobody can replace their own.
create function public.attendance_enroll(p_descriptor real[], p_selfie_path text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v_at timestamptz;
begin
  if public.my_role() is null then raise exception 'This account is not active yet.' using errcode = '42501'; end if;
  if (select attendance_consent_at from public.profiles where id = auth.uid()) is null then
    raise exception 'Read and accept the attendance notice first.' using errcode = '42501';
  end if;
  if p_descriptor is null or array_length(p_descriptor, 1) is distinct from 128 then
    raise exception 'The photo needs a clear face. Try again in better light.' using errcode = '23514';
  end if;
  if left(coalesce(p_selfie_path, ''), 37) is distinct from auth.uid()::text || '/' then
    raise exception 'The photo must be uploaded to your own folder.' using errcode = '42501';
  end if;
  update public.profiles set face_descriptor = p_descriptor, face_enrolled_at = now(), face_selfie_path = p_selfie_path
  where id = auth.uid() and face_descriptor is null returning face_enrolled_at into v_at;
  if v_at is null then raise exception 'Your reference photo is already set. Ask the admin to reset it.' using errcode = '42501'; end if;
  return v_at;
end $$;

create function public.attendance_face_reset(p_user uuid) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can reset a reference photo.' using errcode = '42501'; end if;
  update public.profiles set face_descriptor = null, face_enrolled_at = null, face_selfie_path = null where id = p_user;
  if not found then raise exception 'No such person.' using errcode = 'P0002'; end if;
end $$;

create function public.attendance_punch(p_kind text, p_lat double precision, p_lng double precision, p_accuracy real,
  p_selfie_path text, p_descriptor real[] default null) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare r public.attendance_punches;
begin
  if p_kind not in ('am_in', 'am_out', 'pm_in', 'pm_out') then raise exception 'Pick which punch this is.' using errcode = '23514'; end if;
  if p_lat is null or p_lng is null then raise exception 'Your location is needed to clock in. Turn on location and try again.' using errcode = '23514'; end if;
  perform set_config('app.punch_descriptor', coalesce(p_descriptor::text, ''), true);
  insert into public.attendance_punches (kind, lat, lng, accuracy_m, selfie_path)
  values (p_kind::public.punch_kind, p_lat, p_lng, p_accuracy, p_selfie_path) returning * into r;
  perform set_config('app.punch_descriptor', '', true);
  return jsonb_build_object('id', r.id, 'kind', r.kind, 'at', r.punched_at, 'flags', r.flags, 'face_match', r.face_match,
    'office_distance_m', r.office_distance_m);
exception when unique_violation then
  raise exception 'That punch is already recorded for today.' using errcode = '23505';
end $$;

create function public.punch_json(r public.attendance_punches, p_full boolean) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object('id', r.id, 'kind', r.kind, 'at', r.punched_at, 'flags', r.flags, 'office_distance_m', r.office_distance_m)
    || case when p_full then jsonb_build_object('face_match', r.face_match, 'lat', r.lat, 'lng', r.lng, 'accuracy_m', r.accuracy_m,
        'selfie_path', case when r.selfie_deleted_at is null then r.selfie_path end, 'reviewed_at', r.reviewed_at, 'admin_note', r.admin_note)
      else '{}'::jsonb end
$$;

-- The signed-in person's own page: where they stand today and the last two weeks.
create function public.attendance_me() returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare me public.profiles; d date := (now() at time zone 'Asia/Manila')::date;
begin
  select * into me from public.profiles where id = auth.uid() and active;
  if not found then raise exception 'This account is not active yet.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'id', me.id, 'role', me.role, 'name', me.full_name, 'consent_at', me.attendance_consent_at, 'enrolled', me.face_descriptor is not null,
    'today', d, 'office', public.office_site(),
    'punches', coalesce((select jsonb_agg(public.punch_json(p, false) order by p.punched_at)
      from public.attendance_punches p where p.user_id = me.id and p.work_date = d), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(x.day order by x.work_date desc) from (
      select p.work_date, jsonb_build_object('date', p.work_date, 'punches', jsonb_agg(public.punch_json(p, false) order by p.punched_at)) as day
      from public.attendance_punches p where p.user_id = me.id and p.work_date between d - 14 and d - 1 group by p.work_date) x), '[]'::jsonb));
end $$;

-- The admin's day: every active person and their four punches.
create function public.attendance_day(p_date date) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can see everyone''s attendance.' using errcode = '42501'; end if;
  return jsonb_build_object('date', p_date, 'threshold', public.face_match_threshold(),
    'people', coalesce((select jsonb_agg(jsonb_build_object(
        'id', pr.id, 'name', pr.full_name, 'role', pr.role, 'enrolled', pr.face_descriptor is not null,
        'face_selfie_path', pr.face_selfie_path, 'face_enrolled_at', pr.face_enrolled_at, 'consent_at', pr.attendance_consent_at,
        'punches', coalesce((select jsonb_agg(public.punch_json(p, true) order by p.punched_at)
          from public.attendance_punches p where p.user_id = pr.id and p.work_date = p_date), '[]'::jsonb))
        order by lower(pr.full_name))
      from public.profiles pr where pr.active), '[]'::jsonb));
end $$;

create function public.attendance_review(p_id uuid, p_note text default '') returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can review a punch.' using errcode = '42501'; end if;
  update public.attendance_punches set reviewed_by = auth.uid(), reviewed_at = now(), admin_note = left(btrim(coalesce(p_note, '')), 1000) where id = p_id;
  if not found then raise exception 'No such punch.' using errcode = 'P0002'; end if;
end $$;

-- The month, per person, for payroll: days present, lates, hours from matched in/out pairs.
create function public.attendance_month(p_month date) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare a date := date_trunc('month', p_month)::date; z date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  if not public.is_admin() then raise exception 'Only an admin can see everyone''s attendance.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.full_name, 'role', pr.role,
      'days', coalesce(s.days, 0), 'lates', coalesce(s.lates, 0), 'early_outs', coalesce(s.early_outs, 0),
      'incomplete_days', coalesce(s.incomplete, 0), 'hours', coalesce(s.hours, 0), 'to_review', coalesce(s.to_review, 0))
      order by lower(pr.full_name))
    from public.profiles pr
    left join lateral (
      select count(*) as days, sum(d.lates) as lates, sum(d.early_outs) as early_outs, sum(d.to_review) as to_review,
        count(*) filter (where d.n < 4) as incomplete, round(sum(d.secs) / 3600.0, 2) as hours
      from (
        select p.work_date, count(*) as n,
          count(*) filter (where 'late' = any(p.flags)) as lates, count(*) filter (where 'early_out' = any(p.flags)) as early_outs,
          count(*) filter (where p.reviewed_at is null and (p.flags && array['face_mismatch', 'no_face_check', 'low_gps_accuracy'])) as to_review,
          coalesce(extract(epoch from max(p.punched_at) filter (where p.kind = 'am_out') - max(p.punched_at) filter (where p.kind = 'am_in')), 0)
          + coalesce(extract(epoch from max(p.punched_at) filter (where p.kind = 'pm_out') - max(p.punched_at) filter (where p.kind = 'pm_in')), 0) as secs
        from public.attendance_punches p where p.user_id = pr.id and p.work_date >= a and p.work_date < z group by p.work_date) d
    ) s on true
    where pr.active), '[]'::jsonb);
end $$;

-- Selfies are kept 90 days. The admin's page lists the older ones, deletes the files, then marks them here.
create function public.attendance_old_selfies(p_days integer default 90) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can clear selfies.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'path', selfie_path)) from public.attendance_punches
    where selfie_deleted_at is null and punched_at < now() - make_interval(days => greatest(p_days, 30))), '[]'::jsonb);
end $$;
create function public.attendance_selfies_cleared(p_ids uuid[]) returns integer
language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'Only an admin can clear selfies.' using errcode = '42501'; end if;
  update public.attendance_punches set selfie_deleted_at = now() where id = any(p_ids) and selfie_deleted_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.office_site(), public.geo_distance_m(double precision, double precision, double precision, double precision),
  public.attendance_enroll(real[], text), public.attendance_face_reset(uuid),
  public.attendance_punch(text, double precision, double precision, real, text, real[]), public.punch_json(public.attendance_punches, boolean),
  public.attendance_me(), public.attendance_day(date), public.attendance_review(uuid, text), public.attendance_month(date),
  public.attendance_old_selfies(integer), public.attendance_selfies_cleared(uuid[]) from public, anon;
grant execute on function public.office_site(), public.geo_distance_m(double precision, double precision, double precision, double precision),
  public.attendance_enroll(real[], text), public.attendance_face_reset(uuid),
  public.attendance_punch(text, double precision, double precision, real, text, real[]), public.punch_json(public.attendance_punches, boolean),
  public.attendance_me(), public.attendance_day(date), public.attendance_review(uuid, text), public.attendance_month(date),
  public.attendance_old_selfies(integer), public.attendance_selfies_cleared(uuid[]) to authenticated;
