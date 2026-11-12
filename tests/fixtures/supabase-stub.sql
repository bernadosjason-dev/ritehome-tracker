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

-- The service role the Edge Functions use (PostgREST switches to it and sets the JWT claims).
create role service_role nologin bypassrls;
grant usage on schema auth, storage, public to service_role;
grant execute on function auth.uid() to service_role;

-- pg_net stand-in: records each request instead of sending it, so tests can see the database
-- asked for one. The real extension sends it after the transaction commits.
create schema net;
create table net.http_requests (id bigint generated always as identity primary key, url text, body jsonb,
  headers jsonb, at timestamptz not null default now());
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint
language sql as $$ insert into net.http_requests (url, body, headers) values (url, body, headers) returning id $$;
grant usage on schema net to anon, authenticated, service_role;
-- Supabase grants every new public table and function to the service role too.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant execute on functions to service_role;
