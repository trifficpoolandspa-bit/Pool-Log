-- 05 - merge list items
--
-- Equipment, dogs and fountains are lists inside a customer. Until now a whole
-- list counted as one field, so two people changing different items in it
-- meant the newer list won. This merges them item by item instead: adding a
-- pump on one device and removing a filter on another both survive. Only two
-- people changing the SAME item comes down to the newer edit, and the value it
-- replaced is kept in customer_versions, as before.
--
-- The app decides which lists go item by item and sends them as
--   {"equipment": {"items": {"<item id>": {"t": ..., "v": {...}} | {"t": ..., "gone": true}},
--                  "order": {"t": ..., "v": ["<item id>", ...]}}}
-- Anything else is still one field, exactly as in snippet 04.
--
-- Also fixes a flaw in 04 for customers saved before per-field times existed
-- (everything the first version of sync uploaded): their untouched fields
-- were dated by the customer's newest edit, which moves forward with every
-- save, so a later edit to a different field could wrongly lose. Those rows
-- now keep the edit time they had when first touched, in "__legacy". Nothing
-- was ever deleted by the flaw; a value that lost was kept in
-- customer_versions.
--
-- Same function name and inputs as 04, so nothing else changes. Safe to run
-- more than once.

-- The newest edit time recorded for one field: a plain time, or the newest of
-- the per-item times for a list
create or replace function public.sync_field_newest(p_time jsonb, p_fallback timestamptz)
returns timestamptz
language sql
immutable
as $$
  select case jsonb_typeof(p_time)
    when 'string' then (p_time #>> '{}')::timestamptz
    when 'object' then coalesce(
      (select max((e.value #>> '{}')::timestamptz) from jsonb_each(p_time) e
        where jsonb_typeof(e.value) = 'string'),
      p_fallback)
    else p_fallback
  end
$$;

create or replace function public.push_customer_fields(
  p_id      text,
  p_changes jsonb,
  p_base    timestamptz
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
  v_lost_in  jsonb := '{}'::jsonb;
  v_lost_srv jsonb := '{}'::jsonb;
  v_newest_applied timestamptz := '-infinity';
  v_newest_field   timestamptz;
  v_del_t    timestamptz;
  v_t        timestamptz;
  v_srv_t    timestamptz;
  v_changed  boolean := false;
  r          record;
  it         record;
  -- list merging
  v_ltimes   jsonb;
  v_lfall    timestamptz;
  v_arr      jsonb;
  v_map      jsonb;
  v_orig     text[];
  v_order    text[];
  v_new_ids  text[];
  v_out      jsonb;
  v_id       text;
begin
  if v_company is null then
    raise exception 'This account is not attached to a company';
  end if;
  if p_id is null or length(p_id) = 0 or p_changes is null
     or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'A customer push needs an id and at least one change';
  end if;
  if exists (select 1 from jsonb_each(p_changes) e
              where jsonb_typeof(e.value) <> 'object'
                 or (not (e.value ? 'items') and (not (e.value ? 't') or not (e.value ? 'v' or e.value ? 'gone'))))
     or exists (select 1 from jsonb_each(p_changes) e, jsonb_each(e.value->'items') i
              where jsonb_typeof(e.value->'items') = 'object'
                and (jsonb_typeof(i.value) <> 'object' or not (i.value ? 't') or not (i.value ? 'v' or i.value ? 'gone'))) then
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
    -- A field with no recorded time: on a customer from before per-field times,
    -- the edit time it had when first touched here; otherwise it never existed.
    if v_times ? '__legacy' then
      v_fallback := (v_times->>'__legacy')::timestamptz;
    elsif v_times = '{}'::jsonb then
      v_fallback := coalesce(v_row.edited_at, v_row.updated_at);
      v_times := jsonb_build_object('__legacy', v_fallback);
    else
      v_fallback := '-infinity';
    end if;
  end if;

  for r in select key, value from jsonb_each(p_changes) where key <> '_deleted' loop

    if r.value ? 'items' then
      -- ---- A list, item by item ----
      -- A list last saved whole keeps that time for every item not yet edited
      v_ltimes := case jsonb_typeof(v_times->r.key)
                    when 'object' then v_times->r.key
                    when 'string' then jsonb_build_object('__all', v_times->r.key)
                    else '{}'::jsonb end;
      v_lfall  := coalesce((v_ltimes->>'__all')::timestamptz, v_fallback);
      v_arr    := case when jsonb_typeof(v_data->r.key) = 'array' then v_data->r.key else '[]'::jsonb end;

      -- Items with no usable id cannot be matched; they are kept untouched
      v_map := '{}'::jsonb; v_orig := '{}';
      for it in select value, ordinality from jsonb_array_elements(v_arr) with ordinality loop
        v_id := case when jsonb_typeof(it.value) = 'object' and jsonb_typeof(it.value->'id') in ('string','number')
                     then it.value->>'id' else '__noid_' || it.ordinality end;
        if v_map ? v_id then v_id := v_id || '__dup_' || it.ordinality; end if;
        v_map := v_map || jsonb_build_object(v_id, it.value);
        v_orig := v_orig || v_id;
      end loop;

      v_new_ids := '{}';
      for it in select key, value from jsonb_each(r.value->'items') loop
        v_t := (it.value->>'t')::timestamptz;
        v_srv_t := coalesce((v_ltimes->>it.key)::timestamptz, v_lfall);
        if v_srv_t > v_t then
          if (it.value ? 'gone' and v_map ? it.key)
             or (it.value ? 'v' and (v_map->it.key) is distinct from (it.value->'v')) then
            v_lost_in := v_lost_in || jsonb_build_object(r.key || ' ' || it.key, it.value);
          end if;
          continue;
        end if;
        if v_exists and v_map ? it.key and (p_base is null or v_srv_t > p_base)
           and ((it.value ? 'gone') or (v_map->it.key) is distinct from (it.value->'v')) then
          v_lost_srv := v_lost_srv || jsonb_build_object(r.key || ' ' || it.key,
            jsonb_build_object('v', v_map->it.key, 't', v_srv_t));
        end if;
        if it.value ? 'gone' then
          v_map := v_map - it.key;
        else
          if not (v_map ? it.key) then v_new_ids := v_new_ids || it.key; end if;
          v_map := v_map || jsonb_build_object(it.key, it.value->'v');
        end if;
        v_ltimes := v_ltimes || jsonb_build_object(it.key, v_t);
        v_newest_applied := greatest(v_newest_applied, v_t);
        v_changed := true;
      end loop;

      -- Order: newest arrangement wins; nothing is dropped by it
      v_order := v_orig;
      if r.value ? 'order' and jsonb_typeof(r.value->'order'->'v') = 'array' then
        v_t := (r.value->'order'->>'t')::timestamptz;
        v_srv_t := coalesce((v_ltimes->>'__order')::timestamptz, v_lfall);
        if v_t >= v_srv_t then
          select coalesce(array_agg(x), '{}') into v_order from jsonb_array_elements_text(r.value->'order'->'v') x;
          v_ltimes := v_ltimes || jsonb_build_object('__order', v_t);
          v_newest_applied := greatest(v_newest_applied, v_t);
          v_changed := true;
        end if;
      end if;

      v_out := '[]'::jsonb;
      foreach v_id in array (v_order || v_orig || v_new_ids) loop
        if v_map ? v_id then
          v_out := v_out || jsonb_build_array(v_map->v_id);
          v_map := v_map - v_id;
        end if;
      end loop;
      v_data := v_data || jsonb_build_object(r.key, v_out);
      v_times := v_times || jsonb_build_object(r.key, v_ltimes);
      continue;
    end if;

    -- ---- A plain field ----
    v_t := (r.value->>'t')::timestamptz;
    v_srv_t := public.sync_field_newest(v_times->r.key, v_fallback);

    if v_srv_t > v_t then
      if (r.value ? 'gone' and v_data ? r.key)
         or (r.value ? 'v' and (v_data->r.key) is distinct from (r.value->'v')) then
        v_lost_in := v_lost_in || jsonb_build_object(r.key, r.value);
      end if;
      continue;
    end if;

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
  select coalesce(max(public.sync_field_newest(e.value, v_fallback)), v_fallback) into v_newest_field
    from jsonb_each(v_times) e where e.key not in ('_deleted', '__legacy');

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
            'replaced by a newer edit: ' || (select string_agg(k, ', ' order by k) from jsonb_object_keys(v_lost_srv) k));
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
revoke all on function public.sync_field_newest(jsonb, timestamptz) from public, anon;
grant execute on function public.sync_field_newest(jsonb, timestamptz) to authenticated;
