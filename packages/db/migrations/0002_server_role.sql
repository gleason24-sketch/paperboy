-- The role the Paperboy server connects as.
-- It bypasses row-level security because it runs the article pipeline, billing and admin views for every customer.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'paperboy_server') then
    create role paperboy_server login bypassrls noinherit;
  end if;
end $$;

grant usage on schema public to paperboy_server;
grant select, insert, update, delete on all tables in schema public to paperboy_server;
grant usage, select on all sequences in schema public to paperboy_server;
alter default privileges in schema public grant select, insert, update, delete on tables to paperboy_server;
alter default privileges in schema public grant usage, select on sequences to paperboy_server;

