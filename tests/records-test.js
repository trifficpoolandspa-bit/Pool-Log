// Company records (snippet 07): technician profiles, company details, setup and
// settings. Who can read and change which, and that they merge field by field.
// Real Postgres with the real snippets. Needs: bash sync-test-setup.sh
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

async function as(uid, sql, params){
  const c = await pool.connect();
  try{
    await c.query('begin');
    await c.query(uid ? 'set local role authenticated' : 'set local role anon');
    if(uid) await c.query("select set_config('request.uid', $1, true)", [uid]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return {ok: true, rows: r.rows};
  }catch(e){ await c.query('rollback').catch(()=>{}); return {ok: false, error: e.message}; }
  finally{ c.release(); }
}
const val = r => r.ok && r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
const push = (uid, kind, id, changes, base) => as(uid, 'select public.push_record_fields($1, $2, $3::jsonb, $4) j', [kind, id, JSON.stringify(changes), base || null]);
const visible = async uid => { const r = await as(uid, "select coalesce(string_agg(kind || ':' || id, ',' order by kind, id), '') s from public.company_records"); return val(r); };
const rec = async (kind, id) => (await pool.query('select data, deleted from public.company_records where company_id = $1 and kind = $2 and id = $3', [CO, kind, id])).rows[0];
// Edit times a few minutes in the past, in order, like real devices with right clocks
const START = Date.now() - 20 * 60000;
const T = n => new Date(START + n * 60000).toISOString();
// What a device last saw of a record, as a real phone or the website sends it
const seen = async (kind, id) => (await pool.query("select to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') u from public.company_records where company_id = $1 and kind = $2 and id = $3", [CO, kind, id])).rows[0].u;
const versionCount = async () => Number((await pool.query('select count(*) from public.record_versions')).rows[0].count);

(async ()=>{
  try{ await pool.query('select 1'); }
  catch(e){ console.log('Postgres is not reachable. Run: bash sync-test-setup.sh'); process.exit(1); }
  try{
    await pool.query('truncate public.customers, public.customer_versions, public.company_records, public.record_versions');
    await pool.query('delete from public.members; delete from public.companies; delete from auth.users;');
    await pool.query(`insert into auth.users(id, email) values ($1,'john@triffic.test'),($2,'mike@affinity.test'),($3,'tech-a@accounts.poollog.invalid'),($4,'tech-s@accounts.poollog.invalid')`, [OWNER, OUTSIDER, ALEX, SAM]);
    await pool.query(`insert into public.companies(id, name, code) values ($1,'Triffic','TRIFFIC'),($2,'Affinity','AFFIN1')`, [CO, OTHER_CO]);
    await pool.query(`insert into public.members(user_id, company_id, role, name) values ($1,$2,'owner','John'),($3,$4,'owner','Mike')`, [OWNER, CO, OUTSIDER, OTHER_CO]);
    await as(OWNER, 'select public.attach_technician($1,$2,$3,$4,$5)', [ALEX, 'alex', 't_alex', 'Alex', false]);
    await as(OWNER, 'select public.attach_technician($1,$2,$3,$4,$5)', [SAM, 'sam', 't_sam', 'Sam', true]);

    console.log('\n=== The office puts company records on the server ===');
    let r = await push(OWNER, 'technician', 't_alex', {id: {t: T(0), v: 't_alex'}, name: {t: T(0), v: 'Alex'}, phone: {t: T(0), v: '(623) 555-0100'},
      canPhotoEquipment: {t: T(0), v: true}, requireSkipProof: {t: T(0), v: true}, requireGatePhoto: {t: T(0), v: false}});
    check('an owner saves a technician profile', r.ok && val(r).result === 'saved', r.error);
    await push(OWNER, 'technician', 't_sam', {id: {t: T(0), v: 't_sam'}, name: {t: T(0), v: 'Sam'}});
    r = await push(OWNER, 'company', 'details', {companyName: {t: T(0), v: 'Triffic Pool and Spa'}, accountPhone: {t: T(0), v: '(623) 555-0142'}});
    check('company details', r.ok, r.error);
    r = await push(OWNER, 'setup', 'chemConfig', {pool: {t: T(0), v: {chemicals: [{key: 'chlorine'}]}}});
    check('setup', r.ok, r.error);
    r = await push(OWNER, 'setting', 'company', {showBeforePhotos: {t: T(0), v: true}, showAfterPhotos: {t: T(0), v: true}, showGatePhoto: {t: T(0), v: false}});
    check('and settings', r.ok, r.error);
    r = await push(OWNER, 'other', 'x', {a: {t: T(0), v: 1}});
    check('an unknown kind of record is refused', !r.ok, r.error);

    console.log('\n=== Who reads what ===');
    check('an owner reads every record', await visible(OWNER) === 'company:details,setting:company,setup:chemConfig,technician:t_alex,technician:t_sam', await visible(OWNER));
    check('an admin technician reads every record', await visible(SAM) === await visible(OWNER), await visible(SAM));
    check('a technician reads company, setup, settings and only their own profile',
          await visible(ALEX) === 'company:details,setting:company,setup:chemConfig,technician:t_alex', await visible(ALEX));
    check('another company reads none of it', await visible(OUTSIDER) === '', await visible(OUTSIDER));
    check('nobody signed out reads any of it', !(await as(null, 'select count(*) from public.company_records')).ok || val(await as(null, 'select count(*)::int n from public.company_records')) === 0);

    console.log('\n=== Who changes what ===');
    r = await push(ALEX, 'technician', 't_alex', {requireSkipProof: {t: T(1), v: false}});
    check('a technician cannot change even their own profile', !r.ok && /Only the office/.test(r.error), r.error);
    r = await push(ALEX, 'setting', 'company', {showGatePhoto: {t: T(1), v: true}});
    check('or a company setting', !r.ok, r.error);
    r = await as(ALEX, "update public.company_records set data = '{}'");
    check('or write to the table directly', !r.ok && /permission denied/.test(r.error), r.error);
    r = await push(SAM, 'setting', 'company', {showGatePhoto: {t: T(2), v: true}});
    check('an admin technician changes a company setting', r.ok && (await rec('setting', 'company')).data.showGatePhoto === true, r.error);
    r = await push(OUTSIDER, 'technician', 't_alex', {name: {t: T(3), v: 'Hijacked'}});
    check('another company writing the same id only touches its own records', r.ok && (await rec('technician', 't_alex')).data.name === 'Alex');

    console.log('\n=== Switches merge one at a time ===');
    // Admin flips Gate photo on a phone; the owner flips After photos on the website,
    // both working from the same copy
    const v0 = await versionCount();
    const both = await seen('setting', 'company');
    await push(SAM, 'setting', 'company', {showGatePhoto: {t: T(4), v: false}}, both);
    await push(OWNER, 'setting', 'company', {showAfterPhotos: {t: T(5), v: false}}, both);
    let s = (await rec('setting', 'company')).data;
    check('two people flipping different switches both stick', s.showGatePhoto === false && s.showAfterPhotos === false && s.showBeforePhotos === true, JSON.stringify(s));
    check('without counting as a conflict', await versionCount() === v0, (await versionCount()) + ' vs ' + v0);
    const same = await seen('setting', 'company');
    await push(OWNER, 'setting', 'company', {showBeforePhotos: {t: T(7), v: false}}, same);
    await push(SAM, 'setting', 'company', {showBeforePhotos: {t: T(6), v: true}}, same);
    s = (await rec('setting', 'company')).data;
    check('the same switch goes to the newer change', s.showBeforePhotos === false, JSON.stringify(s));
    r = await as(OWNER, "select count(*)::int n from public.record_versions where reason like '%showBeforePhotos%'");
    check('the older change is kept, for the office to see', val(r) === 1, JSON.stringify(r));
    r = await as(ALEX, 'select count(*)::int n from public.record_versions');
    check('but not for technicians', val(r) === 0, JSON.stringify(r));

    console.log('\n=== Removing a technician profile ===');
    r = await push(OWNER, 'technician', 't_sam', {_deleted: {t: T(8), v: true}});
    check('the office deletes a technician profile', r.ok && (await rec('technician', 't_sam')).deleted === true, r.error);
    check('it is only marked deleted, with its details kept', (await rec('technician', 't_sam')).data.name === 'Sam');

    console.log('\n=== A removed technician ===');
    await as(OWNER, 'select public.remove_technician_account($1)', ['t_alex']);
    check('sees no company records at all', await visible(ALEX) === '', await visible(ALEX));
  }catch(e){ check('records suite', false, e.stack); }
  await pool.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
