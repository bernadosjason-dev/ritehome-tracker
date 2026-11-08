-- What the tracker page's Supabase backend (supabase-backend.js) needs beyond
-- 20261105000001_portal_core.sql.
--
-- 1. seq: the order documents were added in. Code.gs lists rows in sheet order
--    (oldest first) and the page relies on that for fuel and vehicles, which it
--    doesn't sort itself; PostgreSQL has no row order without a column for it.
-- 2. Ids up to 100 characters. Code.gs accepts vehicle-, fuel- and pj- ids of up
--    to 88 characters; the page makes ~45, but the database shouldn't be the
--    stricter of the two.
-- 3. The "receipts" bucket for expense and fuel receipt photos. It is public by
--    design, matching what it replaces: Google Drive files shared "anyone with
--    the link". Each name is sb_ + 32 random hex characters (128 bits), handed
--    out only to signed-in admins, so a photo can be shown in an <img> without a
--    signed URL that expires. Listing, uploading and deleting are admin-only.
--    Attendance selfies are a separate, private bucket and stay that way.

alter table public.tracker_docs add column seq bigint generated always as identity;
create index tracker_docs_order on public.tracker_docs (collection, seq);

alter table public.tracker_docs drop constraint tracker_docs_id_check;
alter table public.tracker_docs add constraint tracker_docs_id_check check (length(id) between 1 and 100);
alter table public.tracker_docs drop constraint tracker_docs_parent_id_check;
alter table public.tracker_docs add constraint tracker_docs_parent_id_check check (parent_id is null or length(parent_id) <= 100);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', true, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create policy "receipts: admin lists" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and public.is_admin());
create policy "receipts: admin uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_admin() and name ~ '^sb_[A-Za-z0-9_-]{1,120}$');
create policy "receipts: admin deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and public.is_admin());
