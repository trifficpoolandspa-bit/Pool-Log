-- 10 - photos
--
-- Photos move to the server so the office can see what was photographed and a
-- lost phone no longer loses them.
--
-- The files themselves go in Supabase Storage, in a private bucket, under a
-- folder per company. This table is the record of what exists: which customer
-- and visit each photo belongs to, when it was taken, and who by.
--
-- Rules:
--   owners and admin technicians  see every photo; remove one
--   technicians                   see photos for their own customers, and add
--                                 photos
--   removed technicians           may finish uploading for 7 days, see nothing
--
-- Phones delete their own copy after 30 days and fetch one back from here when
-- a report needs it. The server keeps photos for 3 years, matching the phones.
--
-- Needs 08 first. Safe to run more than once.

create table if not exists public.photos (
  company_id  uuid not null references public.companies(id) on delete cascade,
  id          text not null,
  customer_id text not null,
  kind        text not null,               -- 'before', 'after', 'gate', 'equipment', 'custom'
  body        text,                        -- 'pool', 'spa', 'fountain:<id>' where it applies
  visit_id    text,                        -- the reading or skip it belongs to
  equipment_id text,                       -- for equipment photos
  path        text not null,               -- where the file sits in the bucket
  bytes       integer,
  taken_at    timestamptz not null,
  service_date date,
  technician_id text,
  uploaded_by uuid,
  deleted     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (company_id, id)
);

create index if not exists photos_for_customer on public.photos (company_id, customer_id, taken_at desc);
create index if not exists photos_changed_since on public.photos (company_id, updated_at);

alter table public.photos enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'photos' loop
    execute format('drop policy %I on public.photos', p.policyname);
  end loop;
end $$;

create policy "photos readable by who may see the customer" on public.photos
  for select to authenticated
  using (company_id = public.my_company_id()
         and (public.my_full_access()
              or exists (select 1 from public.customers c
                         where c.company_id = photos.company_id and c.id = photos.customer_id
                           and c.data->>'technicianId' = public.my_technician_id())));

revoke insert, update, delete on public.photos from authenticated, anon;
grant select on public.photos to authenticated;

-- Where a company's photos live in the bucket. The path is decided here rather
-- than by the phone, so nothing can be written into another company's folder.
create or replace function public.photo_path(p_customer_id text, p_id text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(public.my_company_id()::text, public.my_upload_grace_company()::text)
         || '/' || p_customer_id || '/' || p_id
$$;

-- Recording a photo once its file is in the bucket. Sending the same one twice
-- changes nothing, so a phone that loses signal mid-upload simply tries again.
create or replace function public.push_photo(
  p_id text, p_customer_id text, p_kind text, p_body text, p_visit_id text,
  p_equipment_id text, p_path text, p_bytes integer, p_taken_at timestamptz, p_service_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company uuid := coalesce(public.my_company_id(), public.my_upload_grace_company());
  v_tech    text := public.my_technician_id();
begin
  if v_company is null then raise exception 'This account is not attached to a company'; end if;
  if coalesce(p_id, '') = '' or coalesce(p_customer_id, '') = '' or coalesce(p_path, '') = ''
     or p_taken_at is null then
    raise exception 'A photo needs an id, a customer, a file and when it was taken';
  end if;
  if p_kind not in ('before', 'after', 'gate', 'equipment', 'custom') then
    raise exception 'That is not a kind of photo this app takes';
  end if;
  if p_path <> v_company::text || '/' || p_customer_id || '/' || p_id then
    raise exception 'A photo can only be filed under its own company and customer';
  end if;
  perform 1 from public.customers c where c.company_id = v_company and c.id = p_customer_id;
  if not found then raise exception 'That customer is not on the server yet'; end if;

  if exists (select 1 from public.photos where company_id = v_company and id = p_id) then
    return jsonb_build_object('result', 'already there');
  end if;

  insert into public.photos (company_id, id, customer_id, kind, body, visit_id, equipment_id,
                             path, bytes, taken_at, service_date, technician_id, uploaded_by)
  values (v_company, p_id, p_customer_id, p_kind, p_body, nullif(p_visit_id, ''), nullif(p_equipment_id, ''),
          p_path, p_bytes, p_taken_at, p_service_date, v_tech, auth.uid());
  return jsonb_build_object('result', 'saved', 'path', p_path);
end;
$$;

-- Removing a photo: the office only. The record is marked, so every phone
-- learns it has gone rather than keeping its own copy for ever.
create or replace function public.remove_photo(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_company uuid := public.my_company_id();
begin
  if v_company is null or not public.my_full_access() then
    raise exception 'Only the office can remove a photo';
  end if;
  update public.photos set deleted = true, updated_at = now()
   where company_id = v_company and id = p_id;
  if not found then return jsonb_build_object('result', 'missing'); end if;
  return jsonb_build_object('result', 'removed');
end;
$$;

-- Photos older than three years, for the clean-up to delete from the bucket
create or replace function public.photos_past_keeping()
returns setof public.photos
language sql stable security definer set search_path = public as $$
  select * from public.photos
   where company_id = public.my_company_id() and public.my_full_access()
     and taken_at < now() - interval '3 years'
$$;

revoke all on function public.photo_path(text, text) from public, anon;
revoke all on function public.push_photo(text, text, text, text, text, text, text, integer, timestamptz, date) from public, anon;
revoke all on function public.remove_photo(text) from public, anon;
revoke all on function public.photos_past_keeping() from public, anon;
grant execute on function public.photo_path(text, text) to authenticated;
grant execute on function public.push_photo(text, text, text, text, text, text, text, integer, timestamptz, date) to authenticated;
grant execute on function public.remove_photo(text) to authenticated;
grant execute on function public.photos_past_keeping() to authenticated;


-- ---- The bucket the files go in ----
-- Private: nothing is reachable without signing in, and only people in the
-- company can touch that company's folder. Skipped harmlessly where Supabase
-- Storage is not installed, which is how the test database runs.
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'Supabase Storage not present here; bucket setup skipped';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit)
  values ('visit-photos', 'visit-photos', false, 5242880)
  on conflict (id) do update set public = false, file_size_limit = 5242880;

  -- Replace any earlier rules of ours, leaving other buckets' rules alone
  execute 'drop policy if exists "photos readable within the company" on storage.objects';
  execute 'drop policy if exists "photos written within the company" on storage.objects';
  execute 'drop policy if exists "photos removed by the office" on storage.objects';

  execute $p$
    create policy "photos readable within the company" on storage.objects
      for select to authenticated
      using (bucket_id = 'visit-photos'
             and (storage.foldername(name))[1] = coalesce(public.my_company_id()::text, ''))
  $p$;

  execute $p$
    create policy "photos written within the company" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'visit-photos'
                  and (storage.foldername(name))[1] = coalesce(
                        public.my_company_id()::text,
                        public.my_upload_grace_company()::text, ''))
  $p$;

  execute $p$
    create policy "photos removed by the office" on storage.objects
      for delete to authenticated
      using (bucket_id = 'visit-photos'
             and (storage.foldername(name))[1] = coalesce(public.my_company_id()::text, '')
             and public.my_full_access())
  $p$;
end $$;
