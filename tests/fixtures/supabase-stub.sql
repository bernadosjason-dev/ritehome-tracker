-- Minimal stand-ins for the parts of Supabase the portal migrations rely on,
-- so their row-level security can be tested on a plain local PostgreSQL.
-- auth.uid() reads the signed-in user's id the same way Supabase does.

create role anon nologin;
create role authenticated nologin;

create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}',
  last_sign_in_at timestamptz, created_at timestamptz not null default now());
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text,
  name text not null, owner_id text default auth.uid()::text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;

grant usage on schema auth, storage, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
-- Supabase grants every new public table and function to both API roles.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
