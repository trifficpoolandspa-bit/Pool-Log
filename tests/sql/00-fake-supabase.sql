-- Stand-in for what Supabase provides, so snippet 03 can be tested locally
create schema if not exists auth;
create table auth.users(id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.uid', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
end $$;
grant usage on schema public, auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;

create table public.companies(id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz not null default now());
create table public.members(user_id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  role text not null default 'technician', name text, created_at timestamptz not null default now());
create table public.customers(company_id uuid not null references public.companies(id) on delete cascade,
  id text not null, data jsonb not null, deleted boolean not null default false,
  updated_at timestamptz not null default now(), primary key(company_id, id));
create or replace function public.my_company_id() returns uuid language sql stable security definer set search_path = public as
$$ select company_id from public.members where user_id = auth.uid() $$;
alter table companies enable row level security; alter table members enable row level security; alter table customers enable row level security;
create policy c_sel on customers for select to authenticated using (company_id = my_company_id());
grant select on companies, members to authenticated;
grant select, insert, update, delete on customers to authenticated;

-- Stand-ins for the sign-in policies the real project already has, so the
-- office site can find its company
create policy m_sel on public.members for select to authenticated using (company_id = public.my_company_id());
create policy co_sel on public.companies for select to authenticated using (id = public.my_company_id());
