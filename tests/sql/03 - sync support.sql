-- 03 - sync support
--
-- Adds what customer sync needs on the server. Safe to run more than once.
--
-- 1. customers.edited_at / edited_by — when the change was actually made on
--    the device, and by whom. updated_at stays the server's own clock, which
--    is what devices use to ask "what changed since I last looked?".
-- 2. customer_versions — every version that loses a last-write-wins conflict
--    is kept here, so an overwritten gate code can always be recovered.
-- 3. push_customer() — the only way the app writes a customer. It does the
--    conflict check, keeps the losing version, and saves, all in one
--    transaction, so a dropped signal can never leave a half-written record.

alter table public.customers
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid;

create table if not exists public.customer_versions (
  version_id  bigint generated always as identity primary key,
  company_id  uuid not null references public.companies(id) on delete cascade,
  customer_id text not null,
  data        jsonb not null,
  deleted     boolean not null,
  edited_at   timestamptz,
  edited_by   uuid,
  kept_at     timestamptz not null default now(),
  reason      text not null
);

create index if not exists customer_versions_lookup
  on public.customer_versions (company_id, customer_id, kept_at desc);

create index if not exists customers_changed_since
  on public.customers (company_id, updated_at);

alter table public.customer_versions enable row level security;

drop policy if exists "versions readable by own company" on public.customer_versions;
create policy "versions readable by own company" on public.customer_versions
  for select to authenticated
  using (company_id = public.my_company_id());

-- Read only. Versions are written by push_customer and nothing else.
grant select on public.customer_versions to authenticated;

create or replace function public.push_customer(
  p_id        text,
  p_data      jsonb,
  p_deleted   boolean,
  p_edited_at timestamptz,
  p_base      timestamptz   -- the updated_at this device last saw; null if never
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company_id();
  v_user    uuid := auth.uid();
  v_row     public.customers%rowtype;
  v_now     timestamptz := clock_timestamp();
begin
  if v_company is null then
    raise exception 'This account is not attached to a company';
  end if;
  if p_id is null or length(p_id) = 0 or p_data is null or p_edited_at is null then
    raise exception 'A customer push needs an id, data and an edit time';
  end if;

  -- Lock the row so two pushes for the same customer cannot interleave
  select * into v_row from public.customers
   where company_id = v_company and id = p_id
   for update;

  if not found then
    insert into public.customers (company_id, id, data, deleted, updated_at, edited_at, edited_by)
    values (v_company, p_id, p_data, coalesce(p_deleted, false), v_now, p_edited_at, v_user);
    return jsonb_build_object('result', 'saved', 'updated_at', v_now);
  end if;

  -- Did the server copy change since this device last saw it?
  if p_base is null or v_row.updated_at > p_base then
    if coalesce(v_row.edited_at, v_row.updated_at) > p_edited_at then
      -- The server's edit is newer. Keep the incoming one, change nothing.
      insert into public.customer_versions
        (company_id, customer_id, data, deleted, edited_at, edited_by, reason)
      values (v_company, p_id, p_data, coalesce(p_deleted, false), p_edited_at, v_user,
              'older edit arrived after a newer one');
      return jsonb_build_object(
        'result', 'server_newer',
        'updated_at', v_row.updated_at,
        'data', v_row.data,
        'deleted', v_row.deleted,
        'edited_at', v_row.edited_at);
    end if;
    -- The incoming edit is newer. Keep the server copy it is about to replace.
    insert into public.customer_versions
      (company_id, customer_id, data, deleted, edited_at, edited_by, reason)
    values (v_company, p_id, v_row.data, v_row.deleted, v_row.edited_at, v_row.edited_by,
            'replaced by a newer edit from another device');
  end if;

  update public.customers
     set data = p_data,
         deleted = coalesce(p_deleted, false),
         updated_at = v_now,
         edited_at = p_edited_at,
         edited_by = v_user
   where company_id = v_company and id = p_id;

  return jsonb_build_object('result', 'saved', 'updated_at', v_now);
end;
$$;

revoke all on function public.push_customer(text, jsonb, boolean, timestamptz, timestamptz) from public, anon;
grant execute on function public.push_customer(text, jsonb, boolean, timestamptz, timestamptz) to authenticated;
