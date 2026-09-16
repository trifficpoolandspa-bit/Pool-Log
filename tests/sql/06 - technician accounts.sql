-- 06 - technician accounts
--
-- Technicians sign in to the field apps with a username and password. Every
-- Supabase account needs an email, so each technician's account gets a made-up
-- one that nobody sees or types; the username is what they use.
--
-- Usernames are unique within a company, so two companies can each have an
-- "alex". A phone learns which company it belongs to once, from the company's
-- code or a setup link, and remembers the company itself — so changing the
-- code later never locks out a phone that is already set up.
--
-- Who can see and change customers is decided here, by the database, not by
-- the apps:
--   owners and admin technicians  every customer in the company, full editing
--   technicians                   only customers assigned to them, and only to
--                                 record their visits — no adding, deleting or
--                                 reassigning
--
-- Owners manage accounts from the website: create, rename, admin access,
-- set a new password, remove.
--
-- Removing a technician takes effect at once: they see nothing, change
-- nothing, cannot sign in again, and their username is free for someone new.
-- For 7 days a phone that is still signed in may upload the visits it was
-- holding, and nothing else; after that the account is deleted. Visits already
-- recorded stay either way.
--
-- Needs 05 first. Safe to run more than once.

create extension if not exists pgcrypto with schema extensions;

alter table public.members
  add column if not exists username      text,
  add column if not exists technician_id text,
  add column if not exists is_admin      boolean not null default false,
  add column if not exists removed_at    timestamptz;

-- A version of this snippet made usernames unique across all companies
drop index if exists public.members_username_unique;
drop index if exists public.members_username_per_company;
create unique index if not exists members_username_active
  on public.members (company_id, lower(username)) where username is not null and removed_at is null;

-- ---- Company codes ----
alter table public.companies add column if not exists code text;

create or replace function public.new_company_code()
returns text language plpgsql volatile as $$
declare
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   -- no O/0, I/1
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.companies where code = v_code);
  end loop;
  return v_code;
end;
$$;

update public.companies set code = public.new_company_code() where code is null;
alter table public.companies alter column code set not null;
alter table public.companies alter column code set default public.new_company_code();
create unique index if not exists companies_code_unique on public.companies (upper(code));
drop index if exists public.members_company_technician;
create unique index if not exists members_technician_active
  on public.members (company_id, technician_id) where technician_id is not null and removed_at is null;

-- ---- Who is asking ----
-- A removed technician no longer counts as part of the company for anything
-- except uploading held visits during the grace period.

create or replace function public.my_company_id()
returns uuid language sql stable security definer set search_path = public as $$
  select m.company_id from public.members m where m.user_id = auth.uid() and m.removed_at is null
$$;

-- The 7 days a removed technician's phone has to upload what it was holding
create or replace function public.my_upload_grace_company()
returns uuid language sql stable security definer set search_path = public as $$
  select m.company_id from public.members m
  where m.user_id = auth.uid()
    and (m.removed_at is null or m.removed_at > now() - interval '7 days')
$$;

-- Accounts past their grace period are deleted whenever an owner manages accounts
create or replace function public.purge_removed_technicians()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with gone as (
    delete from auth.users u using public.members m
    where m.user_id = u.id and m.role = 'technician'
      and m.removed_at is not null and m.removed_at <= now() - interval '7 days'
    returning u.id)
  select count(*) into v_count from gone;
  return v_count;
end;
$$;

create or replace function public.my_full_access()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select m.role = 'owner' or m.is_admin from public.members m
                   where m.user_id = auth.uid() and m.removed_at is null), false)
$$;

create or replace function public.my_technician_id()
returns text language sql stable security definer set search_path = public as $$
  select m.technician_id from public.members m where m.user_id = auth.uid() and m.removed_at is null
$$;

create or replace function public.my_is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select m.role = 'owner' from public.members m
                   where m.user_id = auth.uid() and m.removed_at is null), false)
$$;

create or replace function public.my_membership()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', m.role, 'is_admin', m.is_admin, 'full_access', (m.role = 'owner' or m.is_admin),
    'technician_id', m.technician_id, 'username', m.username, 'name', m.name,
    'company_id', m.company_id, 'company_name', c.name,
    'company_code', case when m.role = 'owner' and m.removed_at is null then c.code end,
    'removed', m.removed_at is not null,
    'upload_until', case when m.removed_at is not null then m.removed_at + interval '7 days' end)
  from public.members m join public.companies c on c.id = m.company_id
  where m.user_id = auth.uid()
$$;

-- ---- Reading members and companies ----
-- Replaced with rules written here, so a removed technician is shut out of
-- these too rather than depending on however they were first written.

do $$
declare p record;
begin
  for p in select tablename, policyname from pg_policies
            where schemaname = 'public' and tablename in ('members', 'companies') loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create policy "members readable within the company" on public.members
  for select to authenticated using (company_id = public.my_company_id());
create policy "company readable by its members" on public.companies
  for select to authenticated using (id = public.my_company_id());
revoke insert, update, delete on public.members, public.companies from authenticated, anon;
grant select on public.members, public.companies to authenticated;

-- ---- Reading customers ----
-- Every existing read or write rule on customers is replaced. Writing only ever
-- goes through push_customer_fields, which checks the same rules.

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'customers' loop
    execute format('drop policy %I on public.customers', p.policyname);
  end loop;
end $$;

create policy "customers readable by who may see them" on public.customers
  for select to authenticated
  using (company_id = public.my_company_id()
         and (public.my_full_access() or data->>'technicianId' = public.my_technician_id()));

revoke insert, update, delete on public.customers from authenticated, anon;
grant select on public.customers to authenticated;

-- Replaced versions can hold any customer's details, so only full access
drop policy if exists "versions readable by own company" on public.customer_versions;
drop policy if exists "versions readable by full access" on public.customer_versions;
create policy "versions readable by full access" on public.customer_versions
  for select to authenticated
  using (company_id = public.my_company_id() and public.my_full_access());

-- ---- Signing in with a username ----

-- A phone being set up: the code, typed or from a link, gives the company it
-- belongs to. The name is shown so the technician can see it is the right one.
create or replace function public.company_for_code(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', c.id, 'name', c.name)
  from public.companies c where upper(c.code) = upper(trim(p_code))
$$;

-- The sign-in screen swaps the username for the account's hidden address,
-- within the company the phone belongs to. Nothing for an unknown username.
drop function if exists public.sign_in_address(text);
create or replace function public.sign_in_address(p_company_id uuid, p_username text)
returns text language sql stable security definer set search_path = public as $$
  select u.email from public.members m join auth.users u on u.id = m.user_id
  where m.company_id = p_company_id and m.removed_at is null
    and m.username is not null and lower(m.username) = lower(trim(p_username))
$$;

-- Within the owner's own company
create or replace function public.username_available(p_username text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.members m
                     where m.company_id = public.my_company_id() and m.removed_at is null
                       and m.username is not null and lower(m.username) = lower(trim(p_username)))
$$;

-- An owner picks a code that is easier to give out than the random one
create or replace function public.set_company_code(p_code text)
returns text language plpgsql security definer set search_path = public as $$
declare v_code text := upper(trim(coalesce(p_code, '')));
begin
  if not public.my_is_owner() then raise exception 'Only an owner can change the company code'; end if;
  if v_code !~ '^[A-Z0-9]{4,12}$' then raise exception 'Company codes are 4 to 12 letters or numbers'; end if;
  if exists (select 1 from public.companies where upper(code) = v_code and id <> public.my_company_id()) then
    raise exception 'That code is already used by another company';
  end if;
  update public.companies set code = v_code where id = public.my_company_id();
  return v_code;
end;
$$;

create or replace function public.valid_username(p_username text)
returns boolean language sql immutable as $$
  select p_username ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$'
$$;

-- ---- Owners managing accounts ----

-- Attaches an account the website has just created to this company. Only a
-- brand-new account with a technician's hidden address can be attached, so an
-- owner can never take over anyone else's account.
create or replace function public.attach_technician(
  p_user_id uuid, p_username text, p_technician_id text, p_name text, p_is_admin boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_company uuid := public.my_company_id();
  v_user auth.users%rowtype;
begin
  if not public.my_is_owner() then raise exception 'Only an owner can create technician accounts'; end if;
  perform public.purge_removed_technicians();
  if not public.valid_username(coalesce(p_username, '')) then
    raise exception 'Usernames are 3 to 40 letters, numbers, dots, dashes or underscores';
  end if;
  if coalesce(p_technician_id, '') = '' then raise exception 'A technician profile is needed'; end if;
  if not public.username_available(p_username) then raise exception 'That username is already taken'; end if;
  if exists (select 1 from public.members where company_id = v_company and technician_id = p_technician_id
             and removed_at is null) then
    raise exception 'That technician already has an account';
  end if;

  select * into v_user from auth.users where id = p_user_id;
  if not found then raise exception 'That account does not exist'; end if;
  if v_user.email not like 'tech-%@accounts.poollog.invalid'
     or v_user.created_at < now() - interval '15 minutes'
     or exists (select 1 from public.members where user_id = p_user_id) then
    raise exception 'That account cannot be attached';
  end if;

  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_user_id;
  insert into public.members (user_id, company_id, role, name, username, technician_id, is_admin)
  values (p_user_id, v_company, 'technician', nullif(trim(coalesce(p_name, '')), ''), trim(p_username), p_technician_id, coalesce(p_is_admin, false));
  return public.technician_account(p_technician_id);
end;
$$;

create or replace function public.technician_account(p_technician_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('technician_id', m.technician_id, 'username', m.username,
                            'name', m.name, 'is_admin', m.is_admin)
  from public.members m
  where m.company_id = public.my_company_id() and m.technician_id = p_technician_id
    and m.removed_at is null and public.my_full_access()
$$;

create or replace function public.update_technician_account(
  p_technician_id text, p_username text, p_name text, p_is_admin boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_member public.members%rowtype;
begin
  if not public.my_is_owner() then raise exception 'Only an owner can change technician accounts'; end if;
  perform public.purge_removed_technicians();
  select * into v_member from public.members
   where company_id = public.my_company_id() and technician_id = p_technician_id and role = 'technician'
     and removed_at is null;
  if not found then raise exception 'That technician has no account'; end if;
  if p_username is not null and lower(trim(p_username)) <> lower(v_member.username) then
    if not public.valid_username(p_username) then
      raise exception 'Usernames are 3 to 40 letters, numbers, dots, dashes or underscores';
    end if;
    if not public.username_available(p_username) then raise exception 'That username is already taken'; end if;
  end if;
  update public.members
     set username = coalesce(trim(p_username), username),
         name = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
         is_admin = coalesce(p_is_admin, is_admin)
   where user_id = v_member.user_id;
  return public.technician_account(p_technician_id);
end;
$$;

-- Sets a new password and signs the technician out of every device
create or replace function public.set_technician_password(p_technician_id text, p_password text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_member public.members%rowtype;
begin
  if not public.my_is_owner() then raise exception 'Only an owner can set a technician''s password'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Passwords need at least 8 characters'; end if;
  select * into v_member from public.members
   where company_id = public.my_company_id() and technician_id = p_technician_id and role = 'technician'
     and removed_at is null;
  if not found then raise exception 'That technician has no account'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = v_member.user_id;
  delete from auth.sessions where user_id = v_member.user_id;
  delete from auth.refresh_tokens where user_id = v_member.user_id;
  return true;
end;
$$;

-- An earlier draft returned true/false; the return type changed
drop function if exists public.remove_technician_account(text);

-- Removes the technician at once. Their phone stays signed in only so it can
-- upload held visits for 7 days; the account is deleted after that.
create or replace function public.remove_technician_account(p_technician_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_member public.members%rowtype;
begin
  if not public.my_is_owner() then raise exception 'Only an owner can remove technician accounts'; end if;
  perform public.purge_removed_technicians();
  select * into v_member from public.members
   where company_id = public.my_company_id() and technician_id = p_technician_id and role = 'technician'
     and removed_at is null;
  if not found then return null; end if;
  update public.members set removed_at = now(), is_admin = false where user_id = v_member.user_id;
  return jsonb_build_object('technician_id', p_technician_id, 'upload_until', now() + interval '7 days');
end;
$$;

-- ---- Writing customers: the same rules ----

create or replace function public.check_customer_write(p_id text, p_changes jsonb)
returns void language plpgsql stable security definer set search_path = public as $$
declare
  v_tech text;
  v_assigned text;
  v_found boolean;
begin
  if public.my_full_access() then return; end if;
  v_tech := public.my_technician_id();
  if v_tech is null then raise exception 'This account has no technician profile'; end if;
  select data->>'technicianId' into v_assigned from public.customers
   where company_id = public.my_company_id() and id = p_id;
  v_found := found;
  if not v_found then raise exception 'Only the office can add customers'; end if;
  if v_assigned is distinct from v_tech then raise exception 'This customer is not assigned to you'; end if;
  if p_changes ? 'technicianId' and (p_changes->'technicianId'->>'v') is distinct from v_tech then
    raise exception 'Only the office can reassign a customer';
  end if;
  if p_changes ? '_deleted' then
    raise exception 'Only the office can delete or restore a customer';
  end if;
end;
$$;

-- push_customer_fields as in 05, plus the check above after the row is locked
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

  -- Technicians may only record visits on their own customers (snippet 06)
  perform public.check_customer_write(p_id, p_changes);

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


-- ---- Grants ----
revoke all on function public.my_full_access() from public, anon;
revoke all on function public.my_technician_id() from public, anon;
revoke all on function public.my_is_owner() from public, anon;
revoke all on function public.my_membership() from public, anon;
revoke all on function public.username_available(text) from public, anon;
revoke all on function public.attach_technician(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.technician_account(text) from public, anon;
revoke all on function public.update_technician_account(text, text, text, boolean) from public, anon;
revoke all on function public.set_technician_password(text, text) from public, anon;
revoke all on function public.remove_technician_account(text) from public, anon;
revoke all on function public.check_customer_write(text, jsonb) from public, anon;
revoke all on function public.my_upload_grace_company() from public, anon;
revoke all on function public.purge_removed_technicians() from public, anon, authenticated;
revoke all on function public.sign_in_address(uuid, text) from public;
revoke all on function public.company_for_code(text) from public;
revoke all on function public.set_company_code(text) from public, anon;
revoke all on function public.new_company_code() from public, anon, authenticated;

grant execute on function public.my_full_access() to authenticated;
grant execute on function public.my_technician_id() to authenticated;
grant execute on function public.my_is_owner() to authenticated;
grant execute on function public.my_membership() to authenticated;
grant execute on function public.my_upload_grace_company() to authenticated;
grant execute on function public.username_available(text) to authenticated;
grant execute on function public.attach_technician(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.technician_account(text) to authenticated;
grant execute on function public.update_technician_account(text, text, text, boolean) to authenticated;
grant execute on function public.set_technician_password(text, text) to authenticated;
grant execute on function public.remove_technician_account(text) to authenticated;
grant execute on function public.sign_in_address(uuid, text) to anon, authenticated;
grant execute on function public.company_for_code(text) to anon, authenticated;
grant execute on function public.set_company_code(text) to authenticated;
grant execute on function public.valid_username(text) to anon, authenticated;

revoke all on function public.push_customer_fields(text, jsonb, timestamptz) from public, anon;
grant execute on function public.push_customer_fields(text, jsonb, timestamptz) to authenticated;
