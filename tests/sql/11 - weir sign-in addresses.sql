-- 11 - Weir sign-in addresses
--
-- A technician's sign-in uses a hidden address that no mail can ever reach.
-- They were made on poollog.invalid; the app is called Weir now, so new ones
-- are made on weir.invalid and the ones that exist are moved across.
--
-- Nobody's username or password changes and nobody is signed out: signing in
-- looks the address up from the username, so moving it is invisible.
--
-- Needs 06 first. Safe to run more than once.

-- Move the addresses that already exist
update auth.users
   set email = replace(email, '@accounts.poollog.invalid', '@accounts.weir.invalid')
 where email like 'tech-%@accounts.poollog.invalid';

-- Setting up a technician: the same rules as before, on the new address
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
  -- The app is called Weir now. Accounts made before the rename are on the old
  -- address and still work; new ones arrive on the new one.
  if (v_user.email not like 'tech-%@accounts.weir.invalid'
      and v_user.email not like 'tech-%@accounts.poollog.invalid')
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
