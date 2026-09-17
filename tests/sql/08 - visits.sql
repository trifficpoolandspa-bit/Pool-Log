-- 08 - visits
--
-- Every visit a technician records: the readings for each body of water, and
-- skipped visits. Append-only, so two technicians can never overwrite each
-- other and a visit already recorded cannot be quietly changed from a phone.
--
--   kind      'reading' or 'skip'
--   body      'pool', 'spa', or 'fountain:<id>'
--   id        the id the phone gave it, so the same visit uploaded twice
--             lands once
--
-- Photos stay on the phone for now, so what arrives here is the readings,
-- notes and what was done, with a note of whether photos exist on the phone.
--
-- Who may do what:
--   owners and admin technicians  read every visit; correct or remove one
--   technicians                   read visits for their own customers, and add
--                                 visits; they cannot change or remove one
--   removed technicians           may still upload visits they were holding,
--                                 for 7 days, and read nothing
--
-- Needs 07 first. Safe to run more than once.

create table if not exists public.visits (
  company_id    uuid not null references public.companies(id) on delete cascade,
  customer_id   text not null,
  kind          text not null check (kind in ('reading', 'skip')),
  body          text not null default 'pool',
  id            text not null,
  data          jsonb not null,
  occurred_at   timestamptz not null,
  service_date  date not null,
  technician_id text,
  recorded_by   uuid,
  deleted       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (company_id, customer_id, kind, body, id)
);

create index if not exists visits_changed_since on public.visits (company_id, updated_at);
create index if not exists visits_by_customer on public.visits (company_id, customer_id, service_date desc);

alter table public.visits enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'visits' loop
    execute format('drop policy %I on public.visits', p.policyname);
  end loop;
end $$;

-- A technician sees the visits for the customers they have, whoever recorded them
create policy "visits readable by who may see the customer" on public.visits
  for select to authenticated
  using (company_id = public.my_company_id()
         and (public.my_full_access()
              or exists (select 1 from public.customers c
                         where c.company_id = visits.company_id and c.id = visits.customer_id
                           and c.data->>'technicianId' = public.my_technician_id())));

revoke insert, update, delete on public.visits from authenticated, anon;
grant select on public.visits to authenticated;

-- Adding a visit. The same visit sent twice lands once, so a phone that loses
-- signal mid-upload can simply send it again.
create or replace function public.push_visit(
  p_customer_id text,
  p_kind        text,
  p_body        text,
  p_id          text,
  p_data        jsonb,
  p_occurred_at timestamptz,
  p_service_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company_id();
  v_grace   uuid := public.my_upload_grace_company();
  v_tech    text := public.my_technician_id();
  v_exists  boolean;
begin
  -- A technician removed in the last 7 days may still send what their phone held
  if v_company is null and v_grace is not null then
    v_company := v_grace;
    select m.technician_id into v_tech from public.members m where m.user_id = auth.uid();
  end if;
  if v_company is null then raise exception 'This account is not attached to a company'; end if;
  if p_kind not in ('reading', 'skip') then raise exception 'A visit is a reading or a skip'; end if;
  if coalesce(p_customer_id, '') = '' or coalesce(p_id, '') = '' or p_data is null
     or p_occurred_at is null or p_service_date is null then
    raise exception 'A visit needs a customer, an id, its details and when it happened';
  end if;

  perform 1 from public.customers c where c.company_id = v_company and c.id = p_customer_id;
  if not found then raise exception 'That customer is not on the server yet'; end if;
  -- A technician may add a visit for any customer in their company, not only
  -- the ones they hold now: a visit recorded before a customer was handed to
  -- someone else, or while they were being removed, still has to arrive. The
  -- visit is stamped with who recorded it either way.

  select true into v_exists from public.visits
   where company_id = v_company and customer_id = p_customer_id and kind = p_kind
     and body = coalesce(p_body, 'pool') and id = p_id;
  if v_exists then
    return jsonb_build_object('result', 'already there');
  end if;

  insert into public.visits (company_id, customer_id, kind, body, id, data, occurred_at,
                             service_date, technician_id, recorded_by)
  values (v_company, p_customer_id, p_kind, coalesce(p_body, 'pool'), p_id, p_data,
          p_occurred_at, p_service_date, v_tech, auth.uid());
  return jsonb_build_object('result', 'saved');
end;
$$;

-- Correcting or removing a visit: the office only
create or replace function public.amend_visit(
  p_customer_id text, p_kind text, p_body text, p_id text, p_data jsonb, p_deleted boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_company uuid := public.my_company_id();
begin
  if v_company is null or not public.my_full_access() then
    raise exception 'Only the office can change or remove a visit';
  end if;
  update public.visits
     set data = coalesce(p_data, data),
         deleted = coalesce(p_deleted, deleted),
         updated_at = now()
   where company_id = v_company and customer_id = p_customer_id and kind = p_kind
     and body = coalesce(p_body, 'pool') and id = p_id;
  if not found then return jsonb_build_object('result', 'missing'); end if;
  return jsonb_build_object('result', 'saved');
end;
$$;

revoke all on function public.push_visit(text, text, text, text, jsonb, timestamptz, date) from public, anon;
revoke all on function public.amend_visit(text, text, text, text, jsonb, boolean) from public, anon;
grant execute on function public.push_visit(text, text, text, text, jsonb, timestamptz, date) to authenticated;
grant execute on function public.amend_visit(text, text, text, text, jsonb, boolean) to authenticated;
