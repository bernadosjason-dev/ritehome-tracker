-- Private storage for project files and attendance selfies, gated by the same
-- role rules as the tables in 20261105000001_portal_core.sql.
--   project-files       <project id>/<stage>/<file id>-<name>   (SketchUp, cutlists, BOMs, photos)
--   attendance-selfies  <user id>/<work date>-<punch>.jpg

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('project-files', 'project-files', false, 104857600, null),
  ('attendance-selfies', 'attendance-selfies', false, 2097152, array['image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy "project files: assigned staff read" on storage.objects for select to authenticated
  using (bucket_id = 'project-files' and public.can_read_project((storage.foldername(name))[1]));

create policy "project files: upload to your own stages" on storage.objects for insert to authenticated
  with check (bucket_id = 'project-files'
    and public.can_work_stage((storage.foldername(name))[1], (storage.foldername(name))[2]));

create policy "project files: uploader or admin deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'project-files' and (public.is_admin()
    or (owner_id = auth.uid()::text
        and public.can_work_stage((storage.foldername(name))[1], (storage.foldername(name))[2]))));

-- Selfies: write once into your own folder; no overwriting, no deleting your own.
create policy "selfies: upload to your own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'attendance-selfies'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.my_role() is not null);

create policy "selfies: read your own, admin reads all" on storage.objects for select to authenticated
  using (bucket_id = 'attendance-selfies'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

create policy "selfies: admin deletes (retention)" on storage.objects for delete to authenticated
  using (bucket_id = 'attendance-selfies' and public.is_admin());
