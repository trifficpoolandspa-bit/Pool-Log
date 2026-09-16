// Technician accounts and who may see or change which customers, run against
// real Postgres with the real snippets loaded. Needs: bash sync-test-setup.sh
const { Pool } = require('pg');
let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  — ' + detail : '')); }
}
const pool = new Pool({host: '127.0.0.1', user: 'postgres', password: 'pw', database: 'pl', max: 3});
const CO = 'aaaaaaaa-0000-0000-0000-000000000001', OTHER_CO = 'bbbbbbbb-0000-0000-0000-000000000002';
const OWNER = '11111111-1111-1111-1111-111111111111', OUTSIDER = '22222222-2222-2222-2222-222222222222';
const ALEX = '33333333-3333-3333-3333-333333333333', SAM = '44444444-4444-4444-4444-444444444444';
const OLD = '55555555-5555-5555-5555-555555555555', GMAIL = '66666666-6666-6666-6666-666666666666';
const T = '2026-09-16T10:00:00Z';

async function as(uid, sql, params){
  const c = await pool.connect();
  try{
    await c.query('begin');
    await c.query(uid === 'anon' ? 'set local role anon' : 'set local role authenticated');
    if(uid !== 'anon') await c.query("select set_config('request.uid', $1, true)", [uid]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return {ok: true, rows: r.rows};
  }catch(e){
    await c.query('rollback').catch(()=>{});
    return {ok: false, error: e.message};
  }finally{ c.release(); }
}
const val = r => r.ok && r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
const push = (uid, id, changes) => as(uid, 'select public.push_customer_fields($1, $2::jsonb, null) j', [id, JSON.stringify(changes)]);
const ids = async uid => { const r = await as(uid, "select coalesce(string_agg(id, ',' order by id), '') s from public.customers"); return val(r); };

(async ()=>{
  try{ await pool.query('select 1'); }
  catch(e){ console.log('Postgres is not reachable. Run: bash sync-test-setup.sh'); process.exit(1); }
  try{
    await pool.query('truncate public.customers, public.customer_versions');
    await pool.query('delete from public.members; delete from public.companies; delete from auth.users;');
    await pool.query(`insert into auth.users(id, email) values ($1,'john@triffic.test'),($2,'owner@affinity.test'),
      ($3,'tech-a1@accounts.poollog.invalid'),($4,'tech-b2@accounts.poollog.invalid'),
      ($5,'tech-c3@accounts.poollog.invalid'),($6,'someone@gmail.test')`, [OWNER, OUTSIDER, ALEX, SAM, OLD, GMAIL]);
    await pool.query(`update auth.users set created_at = now() - interval '1 day' where id = $1`, [OLD]);
    await pool.query(`insert into public.companies(id, name) values ($1,'Triffic'),($2,'Affinity')`, [CO, OTHER_CO]);
    await pool.query(`insert into public.members(user_id, company_id, role) values ($1,$2,'owner'),($3,$4,'owner')`, [OWNER, CO, OUTSIDER, OTHER_CO]);
    const attach = (uid, user, username, tech, admin) =>
      as(uid, 'select public.attach_technician($1, $2, $3, $4, $5) j', [user, username, tech, username, admin]);

    console.log('\n=== Owners create technician accounts ===');
    let r = await attach(OWNER, ALEX, 'alex.r', 't1', false);
    check('an owner creates a technician account', r.ok && val(r).username === 'alex.r', r.error);
    r = await attach(OWNER, SAM, 'Sam', 't2', true);
    check('and an admin technician', r.ok && val(r).is_admin === true, r.error);
    const confirmed = (await pool.query(`select count(*)::int n from auth.users where id in ($1,$2) and email_confirmed_at is not null`, [ALEX, SAM])).rows[0].n;
    check('new accounts are confirmed, so they can sign in straight away', confirmed === 2, confirmed);
    r = await attach(OWNER, OLD, 'ALEX.R', 't3', false);
    check('a username taken in the same company is refused, whatever its capitals', !r.ok && /already taken/.test(r.error), r.error);
    r = await attach(OWNER, OLD, 'a', 't3', false);
    check('a too-short username is refused', !r.ok && /3 to 40/.test(r.error), r.error);
    r = await attach(OWNER, OLD, 'olduser', 't3', false);
    check('an account that is not brand new cannot be attached', !r.ok && /cannot be attached/.test(r.error), r.error);
    r = await attach(OWNER, GMAIL, 'gmailuser', 't3', false);
    check('a real person\'s account cannot be taken over', !r.ok && /cannot be attached/.test(r.error), r.error);
    r = await attach(OWNER, ALEX, 'again', 't9', false);
    check('an account already in use cannot be attached twice', !r.ok, r.error);
    r = await attach(SAM, OLD, 'bysam', 't5', false);
    check('an admin technician cannot create accounts', !r.ok && /Only an owner/.test(r.error), r.error);
    r = await as('anon', 'select public.attach_technician($1,$2,$3,$4,$5)', [OLD, 'anonuser', 't6', 'x', false]);
    check('nobody signed out can create accounts', !r.ok, r.error);

    console.log('\n=== Two companies can use the same username ===');
    const OTHER_ALEX = '77777777-7777-7777-7777-777777777777';
    await pool.query(`insert into auth.users(id, email) values ($1, 'tech-z9@accounts.poollog.invalid')`, [OTHER_ALEX]);
    r = await as(OUTSIDER, 'select public.username_available($1) a', ['alex.r']);
    check('a username used by one company is free for another', val(r) === true);
    r = await attach(OUTSIDER, OTHER_ALEX, 'Alex.R', 'their-t1', false);
    check('so another company can create its own alex.r', r.ok, r.error);

    console.log('\n=== Setting up a phone and signing in ===');
    const codes = (await pool.query('select id, code from public.companies order by name')).rows;
    const trifficCode = codes.find(c => c.id === CO).code, affinityCode = codes.find(c => c.id === OTHER_CO).code;
    check('every company has a code', /^[A-HJ-NP-Z2-9]{6}$/.test(trifficCode) && /^[A-HJ-NP-Z2-9]{6}$/.test(affinityCode), trifficCode + ' ' + affinityCode);
    check('codes differ between companies', trifficCode !== affinityCode);
    r = await as('anon', 'select public.company_for_code($1) c', ['  ' + trifficCode.toLowerCase() + ' ']);
    check('a code, typed any way, finds the company and its name', r.ok && val(r) && val(r).id === CO && val(r).name === 'Triffic', JSON.stringify(r));
    r = await as('anon', 'select public.company_for_code($1) c', ['NOPE99']);
    check('a wrong code finds nothing', r.ok && val(r) === null, JSON.stringify(r));
    r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, '  ALEX.R ']);
    check('within a company, a username gives that account\'s sign-in address', val(r) === 'tech-a1@accounts.poollog.invalid', JSON.stringify(r));
    r = await as('anon', 'select public.sign_in_address($1, $2) a', [OTHER_CO, 'alex.r']);
    check('the same username in the other company gives the other account', val(r) === 'tech-z9@accounts.poollog.invalid', JSON.stringify(r));
    r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'nobody']);
    check('an unknown username gives nothing', r.ok && val(r) === null, JSON.stringify(r));
    r = await as(OWNER, 'select public.my_membership() m');
    check('an owner can see their company code, to give it out', r.ok && val(r).company_code === trifficCode, JSON.stringify(r));

    console.log('\n=== Owners can change the company code ===');
    r = await as(OWNER, 'select public.set_company_code($1) c', ['triffic']);
    check('an owner sets a memorable code', r.ok && val(r) === 'TRIFFIC', r.error);
    r = await as('anon', 'select public.company_for_code($1) c', ['Triffic']);
    check('the new code finds the company', r.ok && val(r) && val(r).id === CO);
    r = await as('anon', 'select public.company_for_code($1) c', [trifficCode]);
    check('the old code no longer does', r.ok && val(r) === null);
    r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.r']);
    check('a phone already set up still signs in after the code changes', val(r) === 'tech-a1@accounts.poollog.invalid');
    r = await as(OUTSIDER, 'select public.set_company_code($1) c', ['TRIFFIC']);
    check('another company cannot take a code in use', !r.ok && /already used/.test(r.error), r.error);
    r = await as(OWNER, 'select public.set_company_code($1) c', ['ab!']);
    check('a code has to be 4 to 12 letters or numbers', !r.ok && /4 to 12/.test(r.error), r.error);
    r = await as(SAM, 'select public.set_company_code($1) c', ['SAMCODE']);
    check('an admin technician cannot change it', !r.ok && /Only an owner/.test(r.error), r.error);
    r = await as('anon', 'select public.set_company_code($1) c', ['ANON']);
    check('nobody signed out can change it', !r.ok, r.error);
    r = await as(ALEX, 'select public.my_membership() m');
    check('a technician is not shown the code', r.ok && val(r).company_code === null, JSON.stringify(r));

    console.log('\n=== Who sees and changes which customers ===');
    for(const [id, tech] of [['c1', 't1'], ['c2', 't2'], ['c3', null]]){
      const ch = {id: {t: T, v: id}, name: {t: T, v: 'Pool ' + id}};
      if(tech) ch.technicianId = {t: T, v: tech};
      await push(OWNER, id, ch);
    }
    check('a technician sees only customers assigned to them', await ids(ALEX) === 'c1', await ids(ALEX));
    r = await as(ALEX, 'select public.my_membership() m');
    check('the app can tell it is a plain technician', r.ok && val(r).full_access === false && val(r).technician_id === 't1', JSON.stringify(r));
    r = await push(ALEX, 'c1', {lastServicedDate: {t: '2026-09-16T11:00:00Z', v: '2026-09-16'}});
    check('a technician records a visit on their own customer', r.ok && val(r).result === 'saved', r.error);
    r = await push(ALEX, 'c2', {notes: {t: '2026-09-16T11:00:00Z', v: 'x'}});
    check('but not on someone else\'s', !r.ok && /not assigned to you/.test(r.error), r.error);
    r = await push(ALEX, 'new1', {id: {t: T, v: 'new1'}});
    check('a technician cannot add a customer', !r.ok && /Only the office can add/.test(r.error), r.error);
    r = await push(ALEX, 'c1', {technicianId: {t: '2026-09-16T11:00:00Z', v: 't2'}});
    check('or reassign one', !r.ok && /reassign/.test(r.error), r.error);
    r = await push(ALEX, 'c1', {_deleted: {t: '2026-09-16T11:00:00Z', v: true}});
    check('or delete one', !r.ok && /delete/.test(r.error), r.error);
    r = await as(ALEX, "update public.customers set data = '{}' where id = 'c1'");
    check('or write to the table directly', !r.ok && /permission denied/.test(r.error), r.error);
    await push(OWNER, 'c1', {notes: {t: '2026-09-16T11:30:00Z', v: 'newer note'}});
    await push(OWNER, 'c1', {notes: {t: '2026-09-16T09:00:00Z', v: 'older note arriving late'}});   // loses, so it is kept
    r = await as(ALEX, 'select count(*)::int n from public.customer_versions');
    check('a technician cannot read replaced versions', r.ok && val(r) === 0, JSON.stringify(r));
    r = await as(OWNER, 'select count(*)::int n from public.customer_versions');
    check('an owner can', r.ok && val(r) >= 1, JSON.stringify(r));
    check('an admin technician sees every customer', await ids(SAM) === 'c1,c2,c3');
    r = await push(SAM, 'c1', {technicianId: {t: '2026-09-16T12:00:00Z', v: 't2'}});
    check('and can reassign', r.ok, r.error);
    r = await push(SAM, 'c4', {id: {t: T, v: 'c4'}, name: {t: T, v: 'Added by admin'}});
    check('and add customers', r.ok && val(r).result === 'saved', r.error);
    check('once reassigned, the old technician no longer sees it', await ids(ALEX) === '', await ids(ALEX));
    r = await push(ALEX, 'c1', {notes: {t: '2026-09-16T13:00:00Z', v: 'late'}});
    check('or can change it', !r.ok, r.error);
    check('another company sees none of them', await ids(OUTSIDER) === '');

    console.log('\n=== Owners manage accounts ===');
    await pool.query('insert into auth.sessions(user_id) values ($1)', [ALEX]);
    await pool.query('insert into auth.refresh_tokens(user_id, token) values ($1, $2)', [ALEX, 'tok']);
    r = await as(OWNER, 'select public.update_technician_account($1,$2,$3,$4) j', ['t1', 'alex.rivera', null, true]);
    check('an owner renames a technician and gives admin access', r.ok && val(r).username === 'alex.rivera' && val(r).is_admin === true, r.error);
    r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.rivera']);
    check('the new username signs in to the same account', val(r) === 'tech-a1@accounts.poollog.invalid');
    r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.r']);
    check('the old one no longer does', r.ok && val(r) === null);
    r = await as('anon', 'select public.sign_in_address($1, $2) a', [OTHER_CO, 'alex.r']);
    check('and the other company\'s alex.r is unaffected', val(r) === 'tech-z9@accounts.poollog.invalid');
    r = await as(OWNER, 'select public.update_technician_account($1,$2,$3,$4) j', ['t1', 'SAM', null, null]);
    check('renaming to a taken username is refused', !r.ok && /already taken/.test(r.error), r.error);
    check('admin access takes effect at once', await ids(ALEX) === 'c1,c2,c3,c4', await ids(ALEX));
    r = await as(OWNER, 'select public.set_technician_password($1,$2) j', ['t1', 'short']);
    check('a short password is refused', !r.ok && /8 characters/.test(r.error), r.error);
    r = await as(OWNER, 'select public.set_technician_password($1,$2) j', ['t1', 'brandnewpass']);
    check('an owner sets a new password', r.ok, r.error);
    const works = (await pool.query(`select encrypted_password = extensions.crypt('brandnewpass', encrypted_password) ok from auth.users where id = $1`, [ALEX])).rows[0].ok;
    check('the new password is the one that works', works === true);
    const left = (await pool.query(`select (select count(*) from auth.sessions where user_id = $1) + (select count(*) from auth.refresh_tokens where user_id = $1) n`, [ALEX])).rows[0].n;
    check('and the technician is signed out everywhere', Number(left) === 0, left);
    r = await as(OUTSIDER, 'select public.set_technician_password($1,$2) j', ['t1', 'hijacked123']);
    check('another company\'s owner cannot touch the account', !r.ok, r.error);
    r = await as(SAM, 'select public.set_technician_password($1,$2) j', ['t1', 'bysam12345']);
    check('an admin technician cannot set passwords', !r.ok && /Only an owner/.test(r.error), r.error);
    console.log('\n=== Removing a technician: 7 days to upload, nothing else ===');
    await pool.query('insert into auth.sessions(user_id) values ($1)', [ALEX]);
    // Alex is a plain technician again for this part
    await as(OWNER, 'select public.update_technician_account($1,$2,$3,$4) j', ['t1', null, null, false]);
    await push(OWNER, 'c3', {technicianId: {t: '2026-09-16T14:00:00Z', v: 't1'}});
    check('before removal he sees his customer', (await ids(ALEX)) === 'c3', await ids(ALEX));
    r = await as(OWNER, 'select public.remove_technician_account($1) j', ['t1']);
    check('an owner removes a technician', r.ok && val(r) && val(r).technician_id === 't1' && !!val(r).upload_until, r.error);
    check('at once he sees no customers', (await ids(ALEX)) === '', await ids(ALEX));
    r = await push(ALEX, 'c3', {notes: {t: '2026-09-16T15:00:00Z', v: 'after removal'}});
    check('and cannot change any', !r.ok, r.error);
    r = await as(ALEX, 'select count(*)::int n from public.members');
    check('or see who else works there', r.ok && val(r) === 0, JSON.stringify(r));
    r = await as(ALEX, 'select count(*)::int n from public.companies');
    check('or the company', r.ok && val(r) === 0, JSON.stringify(r));
    r = await as(ALEX, 'select public.my_membership() m');
    check('his app is told he was removed, and until when it can upload',
          r.ok && val(r).removed === true && !!val(r).upload_until && val(r).full_access === false && val(r).company_code === null, JSON.stringify(r));
    r = await as(ALEX, 'select public.my_upload_grace_company() c');
    check('for now his phone may still upload held visits', r.ok && val(r) === CO, JSON.stringify(r));
    const sessions = (await pool.query('select count(*)::int n from auth.sessions where user_id = $1', [ALEX])).rows[0].n;
    check('so his phone stays signed in for that', sessions === 1, sessions);
    r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.rivera']);
    check('but he cannot sign in again', r.ok && val(r) === null, JSON.stringify(r));
    r = await as(OWNER, 'select public.username_available($1) a', ['alex.rivera']);
    check('his username is free for someone new straight away', val(r) === true);
    r = await as(OWNER, 'select public.set_technician_password($1,$2) j', ['t1', 'anotherpass1']);
    check('a removed account cannot be given a new password', !r.ok, r.error);
    r = await as(OWNER, 'select public.remove_technician_account($1) j', ['t1']);
    check('removing twice does nothing', r.ok && val(r) === null, JSON.stringify(r));
    const NEW_ALEX = '88888888-8888-8888-8888-888888888888';
    await pool.query(`insert into auth.users(id, email) values ($1, 'tech-n8@accounts.poollog.invalid')`, [NEW_ALEX]);
    r = await attach(OWNER, NEW_ALEX, 'alex.rivera', 't1', false);
    check('the same profile and username can get a fresh account during the grace period', r.ok, r.error);
    r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.rivera']);
    check('which is the one that signs in', val(r) === 'tech-n8@accounts.poollog.invalid', JSON.stringify(r));
    check('the new account sees the customer', (await ids(NEW_ALEX)) === 'c3', await ids(NEW_ALEX));
    check('the removed one still does not', (await ids(ALEX)) === '');

    // Eight days later
    await pool.query(`update public.members set removed_at = now() - interval '8 days' where user_id = $1`, [ALEX]);
    r = await as(ALEX, 'select public.my_upload_grace_company() c');
    check('after 7 days his phone can no longer upload', r.ok && val(r) === null, JSON.stringify(r));
    let still = (await pool.query('select count(*)::int n from auth.users where id = $1', [ALEX])).rows[0].n;
    check('the account lingers only until an owner next manages accounts', still === 1, still);
    await as(OWNER, 'select public.update_technician_account($1,$2,$3,$4) j', ['t2', null, null, null]);
    still = (await pool.query('select (select count(*) from auth.users where id = $1) + (select count(*) from public.members where user_id = $1) + (select count(*) from auth.sessions where user_id = $1) n', [ALEX])).rows[0].n;
    check('then it is deleted, sessions and all', Number(still) === 0, still);
    const kept = (await pool.query(`select count(*)::int n from public.customers where company_id = $1`, [CO])).rows[0].n;
    check('customers and their visits are untouched throughout', kept === 4, kept);
    const newStill = (await pool.query('select count(*)::int n from auth.users where id = $1', [NEW_ALEX])).rows[0].n;
    check('the new account is not touched by the clean-up', newStill === 1);
  }catch(e){
    check('accounts suite', false, e.stack);
  }
  await pool.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
