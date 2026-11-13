-- Ritehome portal: record migrations 18-22 (already applied by hand in the SQL Editor) in
-- Supabase's migration history, so `supabase migration list` / the dashboard agree with the repo.
-- Touches only supabase_migrations.schema_migrations. Safe to run twice (skips rows already there).
-- Run AFTER md5-compare.sql returns ALL MATCH.
insert into supabase_migrations.schema_migrations (version, name)
select v, n from (values
  ('20261121000018', 'one_record'),
  ('20261122000019', 'approvals'),
  ('20261123000020', 'company_profile'),
  ('20261124000021', 'bookkeeper_books'),
  ('20261125000022', 'attendance_records')
) as t(v, n)
where not exists (select 1 from supabase_migrations.schema_migrations m where m.version = t.v or m.name = t.n);

-- Check: expect 22 rows, the last five being the ones above.
select version, name from supabase_migrations.schema_migrations order by version;
