-- 09 - work records
--
-- Tasks, scheduled filter cleans, work order jobs and one-day moves. They join
-- the company records from snippet 07, so they merge field by field and are
-- marked deleted rather than removed.
--
--   task         a job for a technician, which they can tick off in the field
--   filter_clean a scheduled filter clean
--   work_order   a scheduled work order job
--   reschedule   a visit moved from one day to another
--
-- Who may do what:
--   owners and admin technicians  everything
--   technicians                   see their own tasks, filter cleans and work
--                                 orders, and the moves for their customers;
--                                 tick their own tasks off; move their own
--                                 customers' visits
--
-- Needs 07 first. Safe to run more than once.

alter table public.company_records drop constraint if exists company_records_kind_check;
alter table public.company_records add constraint company_records_kind_check
  check (kind in ('technician', 'company', 'setup', 'setting',
                  'task', 'filter_clean', 'work_order', 'reschedule'));

-- Is this record for the technician asking?
create or replace function public.record_is_mine(p_kind text, p_data jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.my_technician_id() is null then false
    when p_kind in ('task', 'filter_clean', 'work_order')
      then p_data->>'technicianId' = public.my_technician_id()
    when p_kind = 'reschedule'
      then exists (select 1 from public.customers c
                   where c.company_id = public.my_company_id()
                     and c.id = p_data->>'customerId'
                     and c.data->>'technicianId' = public.my_technician_id())
    else false
  end
$$;

drop policy if exists "records readable by who may see them" on public.company_records;
create policy "records readable by who may see them" on public.company_records
  for select to authenticated
  using (company_id = public.my_company_id()
         and (public.my_full_access()
              or kind in ('company', 'setup', 'setting')
              or (kind = 'technician' and id = public.my_technician_id())
              or public.record_is_mine(kind, data)));

-- What a technician may change: tick off their own task, and move a visit for
-- one of their customers. Everything else is the office's.
create or replace function public.check_record_write(p_kind text, p_id text, p_changes jsonb)
returns void language plpgsql stable security definer set search_path = public as $$
declare
  v_existing jsonb;
  v_found boolean;
  v_fields text[];
begin
  if public.my_full_access() then return; end if;
  if public.my_technician_id() is null then raise exception 'Only the office can change this'; end if;

  select data into v_existing from public.company_records
   where company_id = public.my_company_id() and kind = p_kind and id = p_id;
  v_found := found;
  select coalesce(array_agg(k), '{}') into v_fields from jsonb_object_keys(p_changes) k;

  if p_kind = 'task' then
    if not v_found then raise exception 'Only the office can add a task'; end if;
    if not public.record_is_mine('task', v_existing) then raise exception 'That task is not yours'; end if;
    if exists (select 1 from unnest(v_fields) f where f not in ('done', 'doneAt', 'doneBy')) then
      raise exception 'A technician can only tick a task off';
    end if;
    return;
  end if;

  if p_kind = 'reschedule' then
    -- Moving a visit for one of their own customers, new or changed
    if v_found and not public.record_is_mine('reschedule', v_existing) then
      raise exception 'That visit is not yours to move';
    end if;
    if not v_found and not public.record_is_mine('reschedule',
        jsonb_build_object('customerId', p_changes->'customerId'->>'v')) then
      raise exception 'That visit is not yours to move';
    end if;
    return;
  end if;

  raise exception 'Only the office can change this';
end;
$$;

revoke all on function public.record_is_mine(text, jsonb) from public, anon;
revoke all on function public.check_record_write(text, text, jsonb) from public, anon;
grant execute on function public.record_is_mine(text, jsonb) to authenticated;
