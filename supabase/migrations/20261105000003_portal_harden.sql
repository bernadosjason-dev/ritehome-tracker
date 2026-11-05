-- Hardening from Supabase's security advisor after the first deploy.
--
-- 1. Pin search_path on the four functions that didn't set one, so a caller
--    can't steer which schema their unqualified names resolve in.
-- 2. Internal trigger functions are never meant to be called through the API.
--    Supabase grants every new function to the API roles by default; take
--    that back. Triggers still fire: PostgreSQL checks EXECUTE on a trigger
--    function only when the trigger is created.
--
-- The remaining SECURITY DEFINER functions stay callable by signed-in users on
-- purpose: my_role, is_admin, is_assigned, can_read_project and can_work_stage
-- are what the row-level security policies themselves call, and my_projects,
-- staff_directory and accept_attendance_notice are the money-free project view,
-- the assignee picker and the attendance consent. Each only ever answers about
-- the caller.

alter function public.face_match_threshold() set search_path = public;
alter function public.guard_punch_update() set search_path = public;
alter function public.role_owns_stage(public.staff_role, text) set search_path = public;
alter function public.touch_tracker_doc() set search_path = public;

revoke execute on function public.handle_new_user(), public.guard_stage_update(),
  public.seed_project_stages(), public.prepare_punch(), public.guard_punch_update(),
  public.touch_tracker_doc() from public, anon, authenticated;
