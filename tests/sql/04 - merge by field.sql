-- 04 - merge by field
--
-- Replaces whole-record last-write-wins with a merge per field, because a
-- technician and the owner can edit the same customer on the same day. Each
-- field of a customer (gate code, service day, notes, equipment, ...) keeps
-- its own newest edit, so two people changing different fields both keep
-- their change. Only when two people change the SAME field does the newer
-- edit win, and the value it replaced is kept in customer_versions.
--
-- Delete and edit follow "whichever happened later": a delete only takes
-- effect if it is newer than every edit on the customer, and an edit made
-- after a delete brings the customer back.
--
-- Safe to run more than once.

alter table public.customers
  add column if not exists field_times jsonb not null default '{}'::jsonb;

-- One way to write a customer, not two
drop function if exists public.push_customer(text, jsonb, boolean, timestamptz, timestamptz);

create or replace function public.push_customer_fields(
  p_id      text,
  p_changes jsonb,        -- {"gateCode": {"t": edit time, "v": value} | {"t": ..., "gone": true},
                          --  "_deleted": {"t": edit time, "v": true|false}}
  p_base    timestamptz   -- the updated_at this device last saw; null if never
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company  uuid := public.my_company_id();
  v_user     uuid := auth.uid();
  v_row      public.customers%rowtype;
  v_exists   boolean;
  v_now      timestamptz := clock_timestamp();
  v_data     jsonb;
  v_times    jsonb;
  v_deleted  boolean;
  v_fallback timestamptz;
  v_lost_in  jsonb := '{}'::jsonb;   -- incoming values that lost to newer ones
  v_lost_srv jsonb := '{}'::jsonb;   -- server values replaced by newer ones
  v_newest_applied timestamptz := '-infinity';
  v_newest_field   timestamptz;
  v_del_t    timestamptz;
  v_t        timestamptz;
  v_srv_t    timestamptz;
  v_changed  boolean := false;
  r          record;
begin
  if v_company is null then
    raise exception 'This account is not attached to a company';
  end if;
  if p_id is null or length(p_id) = 0 or p_changes is null
     or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'A customer push needs an id and at least one change';
  end if;
  if exists (select 1 from jsonb_each(p_changes) e
              where jsonb_typeof(e.value) <> 'object' or not (e.value ? 't')
                 or not (e.value ? 'v' or e.value ? 'gone')) then
    raise exception 'Every change needs an edit time and a value';
  end if;

  select * into v_row from public.customers
   where company_id = v_company and id = p_id
   for update;
  v_exists := found;

  if not v_exists then
    if not exists (select 1 from jsonb_object_keys(p_changes) k where k <> '_deleted') then
      return jsonb_build_object('result', 'missing');
    end if;
    v_data := '{}'::jsonb; v_times := '{}'::jsonb; v_deleted := false;
    v_fallback := '-infinity';
  else
    v_data := v_row.data; v_times := v_row.field_times; v_deleted := v_row.deleted;
    -- Rows saved before this snippet have no per-field times
    v_fallback := coalesce(v_row.edited_at, v_row.updated_at);
  end if;

  -- ---- Fields ----
  for r in select key, value from jsonb_each(p_changes) where key <> '_deleted' loop
    v_t := (r.value->>'t')::timestamptz;
    v_srv_t := coalesce((v_times->>r.key)::timestamptz, v_fallback);

    if v_srv_t > v_t then
      -- Someone changed this field more recently. Keep theirs; keep this one aside.
      if (r.value ? 'gone' and v_data ? r.key)
         or (r.value ? 'v' and (v_data->r.key) is distinct from (r.value->'v')) then
        v_lost_in := v_lost_in || jsonb_build_object(r.key, r.value);
      end if;
      continue;
    end if;

    -- Replacing a value this device never saw: keep the one being replaced
    if v_exists and v_data ? r.key
       and (p_base is null or v_srv_t > p_base)
       and ((r.value ? 'gone') or (v_data->r.key) is distinct from (r.value->'v')) then
      v_lost_srv := v_lost_srv || jsonb_build_object(r.key,
        jsonb_build_object('v', v_data->r.key, 't', v_srv_t));
    end if;

    if r.value ? 'gone' then
      v_data := v_data - r.key;
    else
      v_data := v_data || jsonb_build_object(r.key, r.value->'v');
    end if;
    v_times := v_times || jsonb_build_object(r.key, v_t);
    v_newest_applied := greatest(v_newest_applied, v_t);
    v_changed := true;
  end loop;

  -- ---- Deleted or not: whichever happened later ----
  v_del_t := coalesce((v_times->>'_deleted')::timestamptz, v_fallback);
  select coalesce(max((value)::timestamptz), v_fallback) into v_newest_field
    from jsonb_each_text(v_times) where key <> '_deleted';

  if p_changes ? '_deleted' then
    v_t := (p_changes->'_deleted'->>'t')::timestamptz;
    if (p_changes->'_deleted'->>'v')::boolean then
      if v_t > v_newest_field and v_t > v_del_t then
        v_deleted := true;
        v_times := v_times || jsonb_build_object('_deleted', v_t);
        v_changed := true;
      elsif not v_deleted then
        v_lost_in := v_lost_in || jsonb_build_object('_deleted', p_changes->'_deleted');
      end if;
    else
      if v_t > v_del_t then
        v_deleted := false;
        v_times := v_times || jsonb_build_object('_deleted', v_t);
        v_changed := true;
      end if;
    end if;
  end if;

  -- An edit made after the delete brings the customer back
  if v_deleted and v_newest_applied > v_del_t then
    v_deleted := false;
    v_times := v_times || jsonb_build_object('_deleted', v_newest_applied);
  end if;

  if not v_exists then
    insert into public.customers (company_id, id, data, deleted, updated_at, edited_at, edited_by, field_times)
    values (v_company, p_id, v_data, v_deleted, v_now, v_newest_applied, v_user, v_times);
  elsif v_changed then
    update public.customers
       set data = v_data, deleted = v_deleted, updated_at = v_now,
           edited_at = greatest(coalesce(edited_at, '-infinity'), v_newest_applied,
                                coalesce((p_changes->'_deleted'->>'t')::timestamptz, '-infinity')),
           edited_by = v_user, field_times = v_times
     where company_id = v_company and id = p_id;
  end if;

  if v_lost_srv <> '{}'::jsonb then
    insert into public.customer_versions (company_id, customer_id, data, deleted, edited_at, edited_by, reason)
    values (v_company, p_id, v_row.data, v_row.deleted, v_row.edited_at, v_row.edited_by,
            'fields replaced by a newer edit: ' || (select string_agg(k, ', ' order by k) from jsonb_object_keys(v_lost_srv) k));
  end if;
  if v_lost_in <> '{}'::jsonb then
    insert into public.customer_versions (company_id, customer_id, data, deleted, edited_at, edited_by, reason)
    values (v_company, p_id, v_lost_in, v_deleted, null, v_user,
            'older edits arrived after newer ones: ' || (select string_agg(k, ', ' order by k) from jsonb_object_keys(v_lost_in) k));
  end if;

  select * into v_row from public.customers where company_id = v_company and id = p_id;
  return jsonb_build_object(
    'result', 'saved',
    'updated_at', v_row.updated_at,
    'data', v_row.data,
    'deleted', v_row.deleted,
    'field_times', v_row.field_times,
    'kept_theirs', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(v_lost_in) k));
end;
$$;

revoke all on function public.push_customer_fields(text, jsonb, timestamptz) from public, anon;
grant execute on function public.push_customer_fields(text, jsonb, timestamptz) to authenticated;
