// The website's Technicians tab creating and managing sign-ins, driven through
// the real page against real Postgres with the real snippets. Supabase's
// sign-up and data endpoints are imitated; everything they call is real.
// Needs: bash sync-test-setup.sh
require('fake-indexeddb/auto');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const { JSDOM } = require('jsdom');
const { Pool } = require('pg');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  — ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CO = 'aaaaaaaa-0000-0000-0000-000000000001', OTHER_CO = 'bbbbbbbb-0000-0000-0000-000000000002';
const OWNER = '11111111-1111-1111-1111-111111111111', OUTSIDER = '22222222-2222-2222-2222-222222222222';
const pool = new Pool({host: '127.0.0.1', user: 'postgres', password: 'pw', database: 'pl', max: 4});

async function reset(){
  await pool.query('truncate public.customers, public.customer_versions');
  await pool.query('delete from public.members; delete from public.companies; delete from auth.users;');
  await pool.query(`insert into auth.users(id, email) values ($1, 'john@triffic.test'), ($2, 'owner@affinity.test')`, [OWNER, OUTSIDER]);
  await pool.query(`insert into public.companies(id, name, code) values ($1, 'Triffic Pool and Spa', 'K7WQ2M'), ($2, 'Affinity Pools', 'AFFIN1')`, [CO, OTHER_CO]);
  await pool.query(`insert into public.members(user_id, company_id, role, name) values ($1, $2, 'owner', 'John'), ($3, $4, 'owner', 'Mike')`, [OWNER, CO, OUTSIDER, OTHER_CO]);
}

async function asUser(uid, sql, params){
  const c = await pool.connect();
  try{
    await c.query('begin');
    await c.query('set local role authenticated');
    await c.query("select set_config('request.uid', $1, true)", [uid]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  }catch(e){ await c.query('rollback').catch(()=>{}); throw e; }
  finally{ c.release(); }
}

// Named inputs for each database function the tab calls, in order
const RPC = {
  my_membership: [],
  username_available: [['p_username', 'text']],
  attach_technician: [['p_user_id', 'uuid'], ['p_username', 'text'], ['p_technician_id', 'text'], ['p_name', 'text'], ['p_is_admin', 'boolean']],
  update_technician_account: [['p_technician_id', 'text'], ['p_username', 'text'], ['p_name', 'text'], ['p_is_admin', 'boolean']],
  set_technician_password: [['p_technician_id', 'text'], ['p_password', 'text']],
  remove_technician_account: [['p_technician_id', 'text']],
  set_company_code: [['p_code', 'text']],
  push_customer_fields: [['p_id', 'text'], ['p_changes', 'jsonb'], ['p_base', 'timestamptz']]
};

function makeServer(){
  const srv = {calls: [], offline: false, signupFails: null};
  srv.handle = async (uid, url, opts) => {
    const o = opts || {};
    const u = new URL(url);
    srv.calls.push((o.method || 'GET') + ' ' + u.pathname);
    if(srv.offline) throw new TypeError('Failed to fetch');
    if(u.pathname === '/auth/v1/signup'){
      const b = JSON.parse(o.body);
      srv.lastSignup = {body: b, headers: o.headers || {}};
      if(srv.signupFails) return [400, {code: 400, msg: srv.signupFails}];
      const r = await pool.query(`insert into auth.users(id, email, encrypted_password)
        values (gen_random_uuid(), $1, extensions.crypt($2, extensions.gen_salt('bf'))) returning id`, [b.email, b.password]);
      return [200, {access_token: 'new-account-token', user: {id: r.rows[0].id, email: b.email}}];
    }
    if(u.pathname === '/rest/v1/members'){
      const where = [];
      if(u.searchParams.get('technician_id') === 'not.is.null') where.push('technician_id is not null');
      if(u.searchParams.get('removed_at') === 'is.null') where.push('removed_at is null');
      const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
        select m.user_id, m.role, m.name, m.company_id, m.technician_id, m.username, m.is_admin
        from public.members m ${where.length ? 'where ' + where.join(' and ') : ''}) t`);
      return [200, r.rows[0].j];
    }
    if(u.pathname === '/rest/v1/customers'){
      const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (select id, data, deleted, updated_at from public.customers order by updated_at) t`);
      return [200, r.rows[0].j];
    }
    const m = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if(m && RPC[m[1]]){
      const args = JSON.parse(o.body || '{}');
      const sig = RPC[m[1]];
      const params = sig.map(([k, type]) => type === 'jsonb' ? JSON.stringify(args[k]) : (args[k] === undefined ? null : args[k]));
      const sql = `select public.${m[1]}(${sig.map(([k, type], i) => `${k} => $${i + 1}::${type}`).join(', ')}) j`;
      try{
        const r = await asUser(uid, sql, params);
        return [200, r.rows[0].j];
      }catch(e){ return [400, {message: e.message}]; }
    }
    return [404, {message: 'not found'}];
  };
  return srv;
}

async function boot(srv, seed){
  const dialogs = [];
  const dom = new JSDOM(fs.readFileSync('customer-intake.html', 'utf8'), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://trifficpoolandspa-bit.github.io/Pool-Log/customer-intake.html',
    beforeParse(w){
      w.matchMedia = () => ({matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}});
      w.scrollTo = () => {}; w.scrollBy = () => {}; w.alert = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => ({drawImage(){}, fillRect(){}});
      w.Element.prototype.scrollIntoView = function(){};
      w.console.warn = () => {}; w.console.error = () => {};
      w.indexedDB = new FDBFactory(); w.IDBKeyRange = global.IDBKeyRange;
      w.fetch = async (url, o2) => {
        await sleep(1);
        const [status, body] = await srv.handle(OWNER, url, o2);
        return {ok: status >= 200 && status < 300, status, json: async () => body};
      };
      w.localStorage.setItem('poollog:sbSession', JSON.stringify({access_token: 'owner-token', refresh_token: 'r'}));
      Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem('poollog:' + k, JSON.stringify(v)));
    }
  });
  const w = dom.window;
  w.__answer = 'ok';
  const iv = setInterval(()=>{
    const ov = Array.from(w.document.querySelectorAll('.confirm-overlay')).filter(x => x.querySelector('#confirmOk')).pop();
    if(ov){ dialogs.push(ov.textContent); ov.querySelector(w.__answer === 'ok' ? '#confirmOk' : '#confirmCancel').click(); }
  }, 5);
  await sleep(700);
  return {w, d: w.document, dialogs, close(){ clearInterval(iv); w.close(); }};
}

const toasts = w => { const t = w.document.getElementById('toast'); return t ? t.textContent : ''; };
async function openTechTab(w){ w.eval("switchView('technicians')"); await sleep(250); }
function fill(d, w, vals){
  Object.entries(vals).forEach(([id, v]) => {
    const el = d.getElementById(id);
    if(el.type === 'checkbox') el.checked = v; else el.value = v;
    el.dispatchEvent(new w.Event('input', {bubbles: true}));
  });
}
async function saveForm(d){ d.getElementById('btnSaveTech').click(); await sleep(450); }
const members = async () => (await pool.query(`select m.technician_id, m.username, m.is_admin, m.removed_at, u.email, u.email_confirmed_at, u.encrypted_password
  from public.members m join auth.users u on u.id = m.user_id where m.company_id = $1 and m.role = 'technician' order by m.created_at`, [CO])).rows;
const rowText = (d, name) => { const r = Array.from(d.querySelectorAll('#technicianList .cust-row')).find(x => x.textContent.indexOf(name) !== -1); return r ? r.textContent : ''; };

(async ()=>{
  try{ await pool.query('select 1'); }
  catch(e){ console.log('Postgres is not reachable. Run: bash sync-test-setup.sh'); process.exit(1); }
  try{
    await reset();
    const srv = makeServer();
    const {w, d, dialogs, close} = await boot(srv, {technicians: [{id: 'tech_old', name: 'Old Local', username: 'oldlocal', password: 'localpass'}], customers: []});

    console.log('\n=== The company code and setup link ===');
    check('the website signed in as the owner', w.eval('siteUser && siteUser.role') === 'owner', w.eval('JSON.stringify(siteUser)'));
    await openTechTab(w);
    check('the Technicians tab shows the company code', d.getElementById('techCompanyCode').textContent === 'K7WQ2M', d.getElementById('techCompanyCode').textContent);
    check('and a setup link for it', d.getElementById('techSetupLink').textContent === 'https://trifficpoolandspa-bit.github.io/Pool-Log/index.html?company=K7WQ2M',
          d.getElementById('techSetupLink').textContent);
    let copied = null;
    w.navigator.clipboard = {writeText: async t => { copied = t; }};
    d.getElementById('btnCopySetupLink').click(); await sleep(50);
    check('Copy link copies it', copied === 'https://trifficpoolandspa-bit.github.io/Pool-Log/index.html?company=K7WQ2M', copied);
    check('a technician with no sign-in says so', /No sign-in yet/.test(rowText(d, 'Old Local')), rowText(d, 'Old Local'));

    d.getElementById('btnChangeCompanyCode').click();
    fill(d, w, {techCompanyCodeInput: 'triffic'});
    d.getElementById('btnSaveCompanyCode').click(); await sleep(400);
    check('changing the code asks first', dialogs.some(t => /Change your company code to TRIFFIC/.test(t)), dialogs.join(' | '));
    const code = (await pool.query('select code from public.companies where id = $1', [CO])).rows[0].code;
    check('the new code is saved on the server', code === 'TRIFFIC', code);
    check('and shown, with its link', d.getElementById('techCompanyCode').textContent === 'TRIFFIC' && /company=TRIFFIC$/.test(d.getElementById('techSetupLink').textContent));
    d.getElementById('btnChangeCompanyCode').click();
    fill(d, w, {techCompanyCodeInput: 'AFFIN1'});
    d.getElementById('btnSaveCompanyCode').click(); await sleep(400);
    check('a code another company uses is refused', /already used/.test(toasts(w)), toasts(w));
    check('and nothing changes', (await pool.query('select code from public.companies where id = $1', [CO])).rows[0].code === 'TRIFFIC');
    d.getElementById('btnCancelCompanyCode').click();

    console.log('\n=== Adding a technician creates their sign-in ===');
    d.getElementById('btnAddTech').click(); await sleep(50);
    fill(d, w, {techName: 'Alex Rivera', techUsername: 'alex', techPassword: 'goodpassword', techIsAdmin: false});
    await saveForm(d);
    let ms = await members();
    check('a sign-in is created on the server', ms.length === 1 && ms[0].username === 'alex', JSON.stringify(ms));
    check('linked to the technician profile', ms.length === 1 && ms[0].technician_id === w.eval("technicians.find(t => t.name === 'Alex Rivera').id"));
    check('using a hidden address on the reserved domain', ms.length === 1 && /^tech-[a-z0-9]{24}@accounts\.poollog\.invalid$/.test(ms[0].email), ms[0] && ms[0].email);
    check('confirmed, so it works straight away', ms.length === 1 && !!ms[0].email_confirmed_at);
    const pwOk = (await pool.query(`select encrypted_password = extensions.crypt('goodpassword', encrypted_password) ok from auth.users where email = $1`, [ms[0].email])).rows[0].ok;
    check('with the password the owner typed', pwOk === true);
    check('sign-up did not carry the owner\'s session', !('Authorization' in srv.lastSignup.headers) && !('authorization' in srv.lastSignup.headers), JSON.stringify(srv.lastSignup.headers));
    check('and the owner is still signed in as themselves', JSON.parse(w.localStorage.getItem('poollog:sbSession')).access_token === 'owner-token');
    check('the list shows who they sign in as', /Signs in as alex/.test(rowText(d, 'Alex Rivera')), rowText(d, 'Alex Rivera'));
    check('the toast says so', /sign in as alex/.test(toasts(w)), toasts(w));

    console.log('\n=== Mistakes are caught before anything is saved ===');
    const before = w.eval('technicians.length');
    d.getElementById('btnAddTech').click(); await sleep(50);
    fill(d, w, {techName: 'Duplicate', techUsername: 'ALEX', techPassword: 'goodpassword'});
    await saveForm(d);
    check('a username already used in the company is refused', /already taken/.test(toasts(w)), toasts(w));
    check('and the technician is not added', w.eval('technicians.length') === before);
    fill(d, w, {techName: 'Shorty', techUsername: 'shorty', techPassword: 'short'});
    await saveForm(d);
    check('a short password is refused', /8 characters/.test(toasts(w)) && w.eval('technicians.length') === before, toasts(w));
    fill(d, w, {techName: 'Badname', techUsername: 'a b', techPassword: 'goodpassword'});
    await saveForm(d);
    check('a username with spaces is refused', /3 to 40/.test(toasts(w)) && w.eval('technicians.length') === before, toasts(w));
    srv.signupFails = 'Signups not allowed for this instance';
    fill(d, w, {techName: 'Blocked', techUsername: 'blocked', techPassword: 'goodpassword'});
    await saveForm(d);
    check('if Supabase refuses the sign-up, its reason is shown', /Signups not allowed/.test(toasts(w)), toasts(w));
    check('and nothing is added', w.eval('technicians.length') === before && (await members()).length === 1);
    srv.signupFails = null;
    srv.offline = true;
    fill(d, w, {techName: 'Offline Olly', techUsername: 'olly', techPassword: 'goodpassword'});
    await saveForm(d);
    check('offline, it says a connection is needed', /offline/i.test(toasts(w)), toasts(w));
    check('and nothing is added', w.eval('technicians.length') === before);
    srv.offline = false;
    w.eval('resetTechForm(); hideTechForm();');

    console.log('\n=== Another company can use the same username ===');
    const THEIR = (await pool.query(`insert into auth.users(id, email) values (gen_random_uuid(), 'tech-other@accounts.poollog.invalid') returning id`)).rows[0].id;
    await asUser(OUTSIDER, 'select public.attach_technician($1, $2, $3, $4, $5)', [THEIR, 'sam', 'their_sam', 'Sam', false]);
    d.getElementById('btnAddTech').click(); await sleep(50);
    fill(d, w, {techName: 'Sam Admin', techUsername: 'sam', techPassword: 'adminpass1', techIsAdmin: true});
    await saveForm(d);
    ms = await members();
    check('"sam" works here even though Affinity has a sam', ms.some(m => m.username === 'sam' && m.is_admin === true), JSON.stringify(ms.map(m => m.username)));
    check('the admin shows as Admin', /Signs in as sam · Admin/.test(rowText(d, 'Sam Admin')), rowText(d, 'Sam Admin'));

    console.log('\n=== Editing a technician ===');
    const alex = () => w.eval("technicians.find(t => t.name.indexOf('Alex') === 0)");
    w.eval("editTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(50);
    check('the password is never shown back', d.getElementById('techPassword').value === '');
    check('the form says blank keeps it', /Leave blank/.test(d.getElementById('techPassword').placeholder));
    check('and who they sign in as', /sign in as alex/.test(d.getElementById('techAccountHint').textContent), d.getElementById('techAccountHint').textContent);
    const oldHash = (await members()).find(m => m.username === 'alex').encrypted_password;
    fill(d, w, {techPhone: '(623) 555-0100'});
    await saveForm(d);
    check('saving other details leaves the password alone', (await members()).find(m => m.username === 'alex').encrypted_password === oldHash);
    check('and saves the details', alex().phone === '(623) 555-0100');

    await pool.query('insert into auth.sessions(user_id) select user_id from public.members where username = $1', ['alex']);
    w.eval("editTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(50);
    fill(d, w, {techUsername: 'alex.rivera', techPassword: 'resetpass99', techIsAdmin: true});
    await saveForm(d);
    const a2 = (await members()).find(m => m.technician_id === alex().id);
    check('renaming changes their username on the server', a2.username === 'alex.rivera', a2.username);
    check('admin access is switched on', a2.is_admin === true);
    const pw2 = (await pool.query(`select encrypted_password = extensions.crypt('resetpass99', encrypted_password) ok from auth.users where email = $1`, [a2.email])).rows[0].ok;
    check('a new password is set', pw2 === true);
    const sess = (await pool.query('select count(*)::int n from auth.sessions s join public.members m on m.user_id = s.user_id where m.username = $1', ['alex.rivera'])).rows[0].n;
    check('which signs them out of every phone', sess === 0, sess);
    check('the list shows the new username', /Signs in as alex.rivera · Admin/.test(rowText(d, 'Alex Rivera')), rowText(d, 'Alex Rivera'));

    w.eval("editTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(50);
    fill(d, w, {techUsername: 'sam'});
    await saveForm(d);
    check('renaming to a username in use is refused', /already taken/.test(toasts(w)) && (await members()).find(m => m.technician_id === alex().id).username === 'alex.rivera', toasts(w));
    w.eval('resetTechForm(); hideTechForm();');

    console.log('\n=== A technician who existed before sign-ins ===');
    w.eval("editTechnician(technicians.find(t => t.name === 'Old Local'))"); await sleep(50);
    check('the form says they have no sign-in yet', /No sign-in yet/.test(d.getElementById('techAccountHint').textContent));
    fill(d, w, {techPhone: '(623) 555-0199'});
    await saveForm(d);
    check('saving without a password keeps them as a profile only', !(await members()).some(m => m.technician_id === 'tech_old') && w.eval("technicians.find(t => t.id === 'tech_old').phone") === '(623) 555-0199');
    w.eval("editTechnician(technicians.find(t => t.name === 'Old Local'))"); await sleep(50);
    fill(d, w, {techPassword: 'freshpass1'});
    await saveForm(d);
    check('typing a password creates their sign-in with their username', (await members()).some(m => m.technician_id === 'tech_old' && m.username === 'oldlocal'), JSON.stringify((await members()).map(m => m.username)));

    console.log('\n=== Deleting a technician ===');
    w.eval("deleteTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(500);
    check('the question explains the 7 days', dialogs.some(t => /upload visits it was holding for 7 days/.test(t)), dialogs.join(' | '));
    const removed = (await pool.query(`select removed_at from public.members where username = 'alex.rivera'`)).rows[0];
    check('their sign-in is stopped on the server', removed && !!removed.removed_at);
    check('and they are gone from the list', !rowText(d, 'Alex Rivera') && !w.eval("technicians.some(t => t.name === 'Alex Rivera')"));
    check('their username is free again', (await asUser(OWNER, 'select public.username_available($1) a', ['alex.rivera'])).rows[0].a === true);

    srv.offline = true;
    w.eval("deleteTechnician(technicians.find(t => t.name === 'Sam Admin'))"); await sleep(500);
    check('offline, a technician with a sign-in is not deleted', w.eval("technicians.some(t => t.name === 'Sam Admin')") && /offline/i.test(toasts(w)), toasts(w));
    srv.offline = false;
    const ownerStill = w.eval('siteUser && siteUser.role');
    check('throughout, the website still knows it is the owner', ownerStill === 'owner');
    close();
  }catch(e){
    check('technicians tab suite', false, e.stack);
  }
  await pool.end();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
