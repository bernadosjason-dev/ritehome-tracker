-- Two new roles (sales, bookkeeper) and a new pipeline stage (site visit, between consultation and
-- design). On their own because Postgres can't use a new enum value in the transaction that adds it.
alter type public.staff_role add value if not exists 'sales' after 'designer';
alter type public.staff_role add value if not exists 'bookkeeper' after 'sales';
alter type public.stage_key add value if not exists 'site_visit' after 'consultation';
