// Offline readiness. The app has to open with no signal, so this checks both
// the service worker's rules and what the technician actually sees.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

console.log('\n=== the service worker ===');
{
  const sw = fs.readFileSync('sw.js', 'utf8');
  check('  it parses', (()=>{ try{ new Function(sw); return true; }catch(e){ return false; } })());
  check('  query strings do not break the cache lookup', sw.indexOf('ignoreSearch') !== -1);
  check('  one missing file no longer kills the whole precache',
        sw.indexOf('allSettled') !== -1 && sw.indexOf('cache.addAll') === -1);
  check('  opening a page falls back to a cached copy',
        sw.indexOf("request.mode === 'navigate'") !== -1);
  check('  and to a readable message if nothing is stored',
        sw.indexOf('not stored on this device yet') !== -1);
  check('  other origins are left to the browser',
        sw.indexOf('url.origin !== self.location.origin') !== -1);
  check('  every page is precached',
        ['technician-app.html','admin-readings-app.html','customer-intake.html','index.html']
          .every(p => sw.indexOf(p) !== -1));
  // A fresh name is what forces every device off the previous worker
  check('  the cache name is newer than the one that shipped',
        /poollog-cache-v([6-9]|[1-9][0-9])/.test(sw), (sw.match(/poollog-cache-v\d+/)||[''])[0]);
}

function boot(file){
  return new JSDOM(fs.readFileSync(file, 'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
      w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
      w.console.warn=()=>{}; w.console.error=()=>{};
      w.Element.prototype.scrollIntoView = function(){};
      w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
      w.localStorage.setItem('poollog:customers', '[]');
    }
  });
}

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html','customer-intake.html']){
    console.log('\n=== ' + file + ': what the technician sees ===');
    const dom = boot(file);
    await new Promise(r => setTimeout(r, 1400));
    const w = dom.window, d = w.document;

    try{
      const badge = d.getElementById('offlineBadge');
      check('  there is an offline indicator', !!badge);
      check('  hidden while online', badge.style.display === 'none');

      Object.defineProperty(w.navigator, 'onLine', {value:false, configurable:true});
      w.dispatchEvent(new w.Event('offline'));
      check('  it appears when the connection drops', badge.style.display === 'block');
      check('  and warns when nothing is stored yet',
            badge.textContent.indexOf('may not load') !== -1, badge.textContent);

      w.eval('offlineReady = true; showOfflineState();');
      check('  it reassures once the app is stored',
            badge.textContent.indexOf('working from this device') !== -1, badge.textContent);

      Object.defineProperty(w.navigator, 'onLine', {value:true, configurable:true});
      w.dispatchEvent(new w.Event('online'));
      check('  and disappears when the connection returns', badge.style.display === 'none');

      check('  Settings can report offline readiness',
            typeof w.eval('offlineStatusText') === 'function');
      check('  and has somewhere to show it', !!d.getElementById('offlineStatus'));

      // The card is filled when the settings view opens. Each app calls that
      // view something different, and pointing at the wrong name left the
      // admin app stuck on "Checking..." forever.
      const settingsView = ['settings','options']
        .find(v => d.getElementById('view-' + v));
      check('  the app has a settings view', !!settingsView, String(settingsView));
      w.eval("switchView('" + settingsView + "');");
      await new Promise(r => setTimeout(r, 600));

      // The readiness card is hidden now — it reported on offline rather than
      // doing anything, and meant little to anyone but us. Offline itself is
      // unchanged, and the header badge still warns when it matters.
      const card = d.getElementById('offlineStatus');
      const wrap = card ? card.closest('.card') : null;
      check('  the readiness card is hidden',
            wrap && wrap.style.display === 'none');
      check('  but it still fills in, ready to be shown again',
            card && card.textContent.trim() !== 'Checking…'
                && card.textContent.trim() !== 'Checking...',
            card ? card.textContent.trim() : '(missing)');

      const txt = await w.eval('offlineStatusText()');
      check('  the readout says something useful', typeof txt === 'string' && txt.length > 20, txt);
    }catch(e){
      check('  offline indicator', false, e.message);
    }
  }

  // Customer sync and company records, against real Postgres
  await serverCustomerSync();
  await serverCompanyRecords();
  await websiteCompanyRecords();

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();

// ======== sync-test (folded in) ========
async function serverCustomerSync(){
  // Customer sync on the office site, driven through the real page against a
  // real Postgres running the real snippets 03 to 06. Only the HTTP layer is
  // imitated, the way Supabase's Data API answers.
  //
  // Needs Postgres. In a fresh container:  bash sync-test-setup.sh
  // Runs as its own process — it relies on IndexedDB and timers finishing.
  const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
  const { JSDOM } = require('jsdom');
  const { Pool } = require('pg');
  const fs = require('fs');

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
  const OTHER_CO = 'bbbbbbbb-0000-0000-0000-000000000002';
  const OWNER = '11111111-1111-1111-1111-111111111111';
  const TECH = '33333333-3333-3333-3333-333333333333';
  const OUTSIDER = '22222222-2222-2222-2222-222222222222';

  const pool = new Pool({host: '127.0.0.1', user: 'postgres', password: 'pw', database: 'pl', max: 4});

  async function reset(){
    await pool.query('truncate public.customers, public.customer_versions');
    await pool.query("delete from public.members; delete from public.companies; delete from auth.users;");
    await pool.query(`insert into auth.users values ($1),($2),($3)`, [OWNER, TECH, OUTSIDER]);
    await pool.query(`insert into public.companies(id,name) values ($1,'Triffic Pool and Spa'),($2,'Someone Else')`, [COMPANY, OTHER_CO]);
    // Alex is an admin technician here, so he can edit the same customers as the
    // owner; what plain technicians may do is covered by accounts-test.js
    await pool.query(`insert into public.members(user_id,company_id,role,name,username,technician_id,is_admin) values ($1,$2,'owner','John',null,null,false),($3,$2,'technician','Alex','alex','t-alex',true),($4,$5,'owner','Other',null,null,false)`,
      [OWNER, COMPANY, TECH, OUTSIDER, OTHER_CO]);
  }

  // Run as a signed-in user, with row-level security in force
  async function asUser(uid, sql, params){
    const c = await pool.connect();
    try{
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query("select set_config('request.uid', $1, true)", [uid]);
      const r = await c.query(sql, params);
      await c.query('commit');
      return r;
    }catch(e){
      await c.query('rollback').catch(()=>{});
      throw e;
    }finally{ c.release(); }
  }

  const rows = async () => (await pool.query('select id, data, deleted, updated_at, field_times from public.customers where company_id = $1 order by id', [COMPANY])).rows;
  const row = async id => (await pool.query('select id, data, deleted from public.customers where company_id = $1 and id = $2', [COMPANY, id])).rows[0];
  const versions = async () => (await pool.query('select customer_id, data, reason from public.customer_versions order by version_id')).rows;

  // What Supabase's Data API would answer
  function makeServer(){
    const srv = {calls: [], offline: false, failRpcAfter: null, rpcCount: 0, broken: null};
    srv.handle = async (uid, url, opts) => {
      const o = opts || {};
      const u = new URL(url);
      srv.calls.push((o.method || 'GET') + ' ' + u.pathname);
      if(srv.offline) throw new TypeError('Failed to fetch');
      if(srv.broken && srv.broken(u)) return [500, {message: 'boom'}];
      if(u.pathname === '/rest/v1/members'){
        // As Supabase answers it: every row the reading rules allow, nothing more.
        // Filtering to the caller here once hid a real fault in the website.
        const r = await asUser(uid, `select coalesce(json_agg(t order by t.role desc), '[]') j from (
          select m.user_id, m.role, m.name, m.company_id, json_build_object('name', c.name) companies
          from public.members m join public.companies c on c.id = m.company_id) t`);
        return [200, r.rows[0].j];
      }
      if(u.pathname === '/rest/v1/rpc/my_membership'){
        const r = await asUser(uid, 'select public.my_membership() j');
        return [200, r.rows[0].j];
      }
      if(u.pathname === '/rest/v1/customers'){
        const where = []; const params = [];
        const since = u.searchParams.get('updated_at');
        if(since){ params.push(since.replace(/^gte\./, '')); where.push('updated_at >= $' + params.length); }
        const del = u.searchParams.get('deleted');
        if(del === 'eq.true') where.push('deleted = true');
        if(del === 'eq.false') where.push('deleted = false');
        const idf = u.searchParams.get('id');
        if(idf && idf.startsWith('eq.')){ params.push(idf.slice(3)); where.push('id = $' + params.length); }
        if(idf && idf.startsWith('in.(')){
          params.push(idf.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, '')));
          where.push('id = any($' + params.length + ')');
        }
        const limit = parseInt(u.searchParams.get('limit') || '100000', 10);
        const offset = parseInt(u.searchParams.get('offset') || '0', 10);
        const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
          select id, data, deleted, updated_at from public.customers
          ${where.length ? 'where ' + where.join(' and ') : ''}
          order by updated_at asc, id asc limit ${limit} offset ${offset}) t`, params);
        return [200, r.rows[0].j];
      }
      if(u.pathname === '/rest/v1/company_records'){
        const since = u.searchParams.get('updated_at');
        const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
          select kind, id, data, deleted, updated_at from public.company_records
          ${since ? 'where updated_at >= $1' : ''} order by updated_at, kind, id) t`,
          since ? [since.replace(/^gte\./, '')] : []);
        return [200, r.rows[0].j];
      }
      if(u.pathname === '/rest/v1/rpc/push_record_fields'){
        const b = JSON.parse(o.body);
        try{
          const r = await asUser(uid, 'select public.push_record_fields($1, $2, $3::jsonb, $4::timestamptz) j',
            [b.p_kind, b.p_id, JSON.stringify(b.p_changes), b.p_base]);
          return [200, r.rows[0].j];
        }catch(e){ return [400, {message: e.message}]; }
      }
      if(u.pathname === '/rest/v1/rpc/push_customer_fields'){
        srv.rpcCount++;
        if(srv.failRpcAfter !== null && srv.rpcCount > srv.failRpcAfter) throw new TypeError('Failed to fetch');
        const b = JSON.parse(o.body);
        try{
          const r = await asUser(uid, 'select public.push_customer_fields($1, $2::jsonb, $3::timestamptz) j',
            [b.p_id, JSON.stringify(b.p_changes), b.p_base]);
          return [200, r.rows[0].j];
        }catch(e){ return [400, {message: e.message}]; }
      }
      return [404, {message: 'not found'}];
    };
    return srv;
  }

  // Put rows on the server the way another device would
  async function serverPut(uid, id, data, when){
    const t = when || new Date().toISOString();
    const changes = {};
    Object.keys(data).forEach(k => { changes[k] = {t, v: data[k]}; });
    await asUser(uid, 'select public.push_customer_fields($1, $2::jsonb, null)', [id, JSON.stringify(changes)]);
  }
  async function serverSet(uid, id, changes){
    await asUser(uid, 'select public.push_customer_fields($1, $2::jsonb, null)', [id, JSON.stringify(changes)]);
  }

  // ---------- the office site on a device ----------
  async function boot(srv, seed, opts){
    const o = opts || {};
    const uid = o.uid || OWNER;
    const dialogs = [];
    const dom = new JSDOM(fs.readFileSync('customer-intake.html', 'utf8'), {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
      beforeParse(w){
        w.matchMedia = () => ({matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}});
        w.scrollTo = () => {}; w.scrollBy = () => {}; w.alert = () => {};
        w.HTMLCanvasElement.prototype.getContext = () => ({drawImage(){}, fillRect(){}});
        w.Element.prototype.scrollIntoView = function(){};
        w.console.warn = () => {}; w.console.error = () => {};
        w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
        w.indexedDB = new FDBFactory(); w.IDBKeyRange = global.IDBKeyRange;   // each device its own
        w.fetch = async (url, opts2) => {
          await sleep(1);
          const [status, body] = await srv.handle(uid, url, opts2);
          return {ok: status >= 200 && status < 300, status, json: async () => body};
        };
        if(o.signedIn !== false){
          w.localStorage.setItem('poollog:sbSession', JSON.stringify({access_token: 'tok', refresh_token: 'r'}));
        }
        Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)));
      }
    });
    const w = dom.window;
    w.__answer = o.answer || null;
    const iv = setInterval(()=>{
      // Only yes/no questions; the Deleted customers list is also an overlay
      const ov = Array.from(w.document.querySelectorAll('.confirm-overlay')).filter(o => o.querySelector('#confirmOk')).pop();
      if(ov && w.__answer){
        dialogs.push(ov.textContent);
        const btn = ov.querySelector(w.__answer === 'ok' ? '#confirmOk' : '#confirmCancel');
        if(btn) btn.click();
      }
    }, 5);
    await sleep(300);
    await idle(w);
    return {w, dialogs, close(){ clearInterval(iv); w.close(); }};
  }

  async function idle(w){
    for(let i = 0; i < 1500; i++){
      await sleep(10);
      if(!w.eval('syncRunning')){ await sleep(30); if(!w.eval('syncRunning')) return; }
    }
    throw new Error('sync never finished');
  }
  async function sync(w){ const r = await w.eval('syncCustomers()'); await idle(w); return r; }
  async function edit(w, js){ w.eval(js + '; saveCustomers();'); await sleep(15); }
  const local = w => JSON.parse(w.localStorage.getItem('poollog:customers') || '[]');
  const find = (w, id) => local(w).find(c => c.id === id);
  const cust = (id, name, extra) => Object.assign({id, name, active: true, gateCode: '1111', day: 'Monday'}, extra || {});
  const status = w => w.document.getElementById('syncStatus').textContent;

  return (async ()=>{
    try{
      await pool.query('select 1');
    }catch(e){
      check('Postgres is reachable for the server checks (run: bash sync-test-setup.sh)', false); await pool.end().catch(()=>{}); return;
    }
    try{
      console.log('\n=== The website knows who is signed in, with technicians in the company ===');
      {
        await reset(); const srv = makeServer();
        const d = await boot(srv, {'poollog:customers': []});
        check('the signed-in person is the owner, not a technician', d.w.eval('siteUser && siteUser.role') === 'owner',
              d.w.eval('JSON.stringify(siteUser)'));
        check('with the owner\'s own name', d.w.eval('siteUser && siteUser.name') === 'John', d.w.eval('JSON.stringify(siteUser)'));
        check('and the company name', d.w.eval('siteUser && siteUser.companyName') === 'Triffic Pool and Spa', d.w.eval('JSON.stringify(siteUser)'));
        d.close();
      }

      console.log('\n=== A brand-new device with an empty app only pulls ===');
      {
        await reset(); const srv = makeServer();
        for(let i = 1; i <= 10; i++) await serverPut(OWNER, 's' + i, cust('s' + i, 'Server ' + i));
        const d = await boot(srv, {'poollog:customers': []});
        check('the ten server customers arrive', local(d.w).length === 10, local(d.w).length);
        check('nothing at all is pushed', srv.rpcCount === 0, srv.rpcCount);
        check('the server still has all ten, none deleted', (await rows()).length === 10 && (await rows()).every(r => !r.deleted));
        check('the list on screen is replaced too', d.w.eval('customers.length') === 10);
        const r2 = await sync(d.w);
        check('a second sync is quiet', r2.ok && r2.pushed === 0 && srv.rpcCount === 0, JSON.stringify(r2));
        check('status says synced', /Synced/.test(status(d.w)), status(d.w));
        d.close();
      }

      console.log('\n=== A never-synced device whose pull fails pushes nothing ===');
      {
        await reset(); const srv = makeServer();
        srv.broken = u => u.pathname === '/rest/v1/customers';
        const d = await boot(srv, {'poollog:customers': [cust('n1', 'N1'), cust('n2', 'N2')]});
        check('no push happens without a completed pull', srv.rpcCount === 0, srv.rpcCount);
        check('the device keeps its customers', local(d.w).length === 2);
        check('the status says it could not reach the server', /could not reach/.test(status(d.w)), status(d.w));
        srv.broken = null;
        await sync(d.w);
        check('once a pull succeeds, they go up', (await rows()).length === 2);
        d.close();
      }

      console.log('\n=== Reinstall: storage wiped, server untouched ===');
      {
        await reset(); const srv = makeServer();
        for(let i = 1; i <= 8; i++) await serverPut(OWNER, 's' + i, cust('s' + i, 'Server ' + i));
        const d = await boot(srv, {});
        check('no question is asked', d.dialogs.length === 0, d.dialogs.join(' | '));
        check('no deletes reach the server', (await rows()).every(r => !r.deleted));
        check('all eight come back', local(d.w).length === 8, local(d.w).length);
        d.close();
      }

      console.log('\n=== First sync: pull before push, server copy wins, backup kept ===');
      {
        await reset(); const srv = makeServer();
        await serverPut(OWNER, 's1', cust('s1', 'Server One'));
        await serverPut(OWNER, 'shared', cust('shared', 'Shared', {gateCode: 'SERVER'}));
        const mine = [cust('m1', 'Mine One'), cust('m2', 'Mine Two'), cust('shared', 'Shared', {gateCode: 'STALE', notes: 'only here'})];
        const d = await boot(srv, {'poollog:customers': mine});
        const firstPush = srv.calls.findIndex(c => c.includes('push_customer'));
        const firstPull = srv.calls.findIndex(c => c.startsWith('GET /rest/v1/customers'));
        check('a pull happened', firstPull !== -1);
        check('the first push came after the pull', firstPush === -1 || firstPush > firstPull, srv.calls.join(', '));
        check('the device\'s own customers reach the server', !!(await row('m1')) && !!(await row('m2')));
        check('the server copy wins for a customer it already had',
              (await row('shared')).data.gateCode === 'SERVER' && find(d.w, 'shared').gateCode === 'SERVER');
        check('with no stray field carried over from the stale copy', find(d.w, 'shared').notes === undefined);
        check('four customers here', local(d.w).length === 4, local(d.w).length);
        const backup = await d.w.eval("loadFirstSyncBackup('" + COMPANY + "')");
        const bc = backup ? JSON.parse(backup.data.customers) : [];
        check('the pre-sync backup holds the device copy, stale gate code and all',
              bc.length === 3 && bc.find(c => c.id === 'shared').gateCode === 'STALE');
        await edit(d.w, "customers.push({id:'m3', name:'Mine Three'})");
        await sleep(2300); await idle(d.w);
        const again = await d.w.eval("loadFirstSyncBackup('" + COMPANY + "')");
        check('the backup is untouched by later syncs', JSON.parse(again.data.customers).length === 3);
        check('and never includes sync state', !Object.keys(backup.data).some(k => /poollogsync/.test(k)));
        d.close();
      }

      console.log('\n=== Everyday edits and deletes through the real screens ===');
      {
        await reset(); const srv = makeServer();
        const d = await boot(srv, {'poollog:customers': [cust('a', 'Alpha'), cust('b', 'Bravo')]});
        check('both reach the server', (await rows()).length === 2);
        const before = srv.rpcCount;
        await edit(d.w, "customers.find(c => c.id === 'a').gateCode = '9999'");
        await sleep(2300); await idle(d.w);
        check('an edit reaches the server without pressing anything', (await row('a')).data.gateCode === '9999');
        check('as one push', srv.rpcCount === before + 1, srv.rpcCount - before);
        const ft = (await rows()).find(r => r.id === 'a').field_times;
        check('only the changed field gets a new edit time', ft.gateCode > ft.name, JSON.stringify(ft));
        check('an ordinary edit keeps no version', (await versions()).length === 0);

        d.w.__answer = 'ok';
        d.w.eval("deleteCustomer(customers.find(c => c.id === 'b'))");
        await sleep(2400); await idle(d.w);
        const b = await row('b');
        check('a deleted customer is only marked deleted on the server', b && b.deleted === true);
        check('and still has its details', b && b.data.name === 'Bravo');
        check('it is gone from this device', !find(d.w, 'b'));
        await sync(d.w);
        check('and does not come back on the next sync', !find(d.w, 'b'));
        await edit(d.w, "delete customers.find(c => c.id === 'a').day");
        await sleep(2300); await idle(d.w);
        check('clearing a field removes it on the server too', !('day' in (await row('a')).data));
        d.close();
      }

      console.log('\n=== Technician and owner edit the same customer the same day ===');
      {
        await reset(); const srv = makeServer();
        const owner = await boot(srv, {'poollog:customers': [cust('c', 'Charlie', {gateCode: 'ORIG', day: 'Monday', notes: 'none'})]});
        const tech = await boot(srv, {'poollog:customers': []}, {uid: TECH});
        check('the technician\'s device has Charlie', !!find(tech.w, 'c'));

        // Both offline; different fields
        srv.offline = true;
        await edit(tech.w, "customers[0].gateCode = 'TECH-GATE'");
        await edit(owner.w, "customers[0].day = 'Friday'");
        await sleep(2300); await idle(owner.w); await idle(tech.w);
        check('offline edits wait on the device', (await row('c')).data.gateCode === 'ORIG');
        check('the status says so', /Offline/.test(status(owner.w)), status(owner.w));
        srv.offline = false;
        await sync(owner.w);
        await sync(tech.w);
        let r = await row('c');
        check('the technician\'s gate code survives', r.data.gateCode === 'TECH-GATE', JSON.stringify(r.data));
        check('and so does the owner\'s service day', r.data.day === 'Friday', JSON.stringify(r.data));
        check('nothing was treated as a conflict', (await versions()).length === 0, JSON.stringify(await versions()));
        await sync(owner.w);
        check('the owner\'s device shows both changes', find(owner.w, 'c').gateCode === 'TECH-GATE' && find(owner.w, 'c').day === 'Friday',
              JSON.stringify(find(owner.w, 'c')));
        check('the technician\'s device shows both changes', find(tech.w, 'c').gateCode === 'TECH-GATE' && find(tech.w, 'c').day === 'Friday',
              JSON.stringify(find(tech.w, 'c')));
        check('the owner\'s screen list is current too', owner.w.eval("customers[0].gateCode") === 'TECH-GATE');

        // Same field: older edit arrives second
        srv.offline = true;
        await edit(owner.w, "customers[0].gateCode = 'OWNER-OLDER'");
        await sleep(40);
        await edit(tech.w, "customers[0].gateCode = 'TECH-NEWER'");
        await sleep(2300); await idle(owner.w); await idle(tech.w);
        srv.offline = false;
        await sync(tech.w);
        await sync(owner.w);
        check('same field: the newer edit wins', (await row('c')).data.gateCode === 'TECH-NEWER', (await row('c')).data.gateCode);
        check('the owner\'s device takes it', find(owner.w, 'c').gateCode === 'TECH-NEWER', find(owner.w, 'c').gateCode);
        check('the losing value is kept on the server',
              (await versions()).some(v => JSON.stringify(v.data).indexOf('OWNER-OLDER') !== -1), JSON.stringify(await versions()));

        // Same field: newer edit arrives second
        srv.offline = true;
        await edit(tech.w, "customers[0].notes = 'tech note (older)'");
        await sleep(40);
        await edit(owner.w, "customers[0].notes = 'owner note (newer)'");
        await sleep(2300); await idle(owner.w); await idle(tech.w);
        srv.offline = false;
        await sync(tech.w);
        check('the first to arrive is saved', (await row('c')).data.notes === 'tech note (older)');
        await sync(owner.w);
        check('a newer edit arriving later replaces it', (await row('c')).data.notes === 'owner note (newer)');
        check('and the replaced value is kept',
              (await versions()).some(v => v.data.notes === 'tech note (older)'), JSON.stringify(await versions()));
        await sync(tech.w);
        check('the technician\'s device catches up', find(tech.w, 'c').notes === 'owner note (newer)');

        // A mix in one save: one field wins, the other loses
        srv.offline = true;
        await edit(owner.w, "customers[0].gateCode = 'OWNER-MIX'; customers[0].active = false");
        await sleep(40);
        await edit(tech.w, "customers[0].gateCode = 'TECH-MIX'");
        await sleep(2300); await idle(owner.w); await idle(tech.w);
        srv.offline = false;
        await sync(tech.w);
        await sync(owner.w);
        r = await row('c');
        check('in one save, the field nobody else touched goes through', r.data.active === false, JSON.stringify(r.data));
        check('and the field someone changed later keeps theirs', r.data.gateCode === 'TECH-MIX', r.data.gateCode);
        check('the owner\'s device matches the server', find(owner.w, 'c').gateCode === 'TECH-MIX' && find(owner.w, 'c').active === false);

        // Delete versus edit
        srv.offline = true;
        owner.w.__answer = 'ok';
        owner.w.eval("deleteCustomer(customers[0])");
        await sleep(80);
        await edit(tech.w, "customers[0].gateCode = 'KEEP-ME'");
        await sleep(2300); await idle(owner.w); await idle(tech.w);
        srv.offline = false;
        await sync(tech.w);
        await sync(owner.w);
        r = await row('c');
        check('an older delete does not beat a newer edit', r.deleted === false && r.data.gateCode === 'KEEP-ME', JSON.stringify(r));
        check('the customer comes back on the deleting device', find(owner.w, 'c') && find(owner.w, 'c').gateCode === 'KEEP-ME');

        srv.offline = true;
        await edit(tech.w, "customers[0].notes = 'edited before the delete'");
        await sleep(40);
        owner.w.eval("deleteCustomer(customers[0])");
        await sleep(2400); await idle(owner.w); await idle(tech.w);
        srv.offline = false;
        await sync(owner.w);
        await sync(tech.w);
        r = await row('c');
        check('a newer delete beats an older edit', r.deleted === true, JSON.stringify(r));
        check('and the customer leaves the technician\'s device', !find(tech.w, 'c'));
        owner.close(); tech.close();
      }

      console.log('\n=== Equipment, dogs and fountains merge one item at a time ===');
      {
        await reset(); const srv = makeServer();
        const start = cust('eq', 'Echo', {
          equipment: [{id: 'e1', type: 'Filter', photos: []}, {id: 'e2', type: 'Pump', photos: []}],
          dogs: [{id: 'd1', name: 'Rex'}],
          fountains: []});
        const owner = await boot(srv, {'poollog:customers': [start]});
        const tech = await boot(srv, {'poollog:customers': []}, {uid: TECH});
        check('the technician has the customer with both pieces of equipment', find(tech.w, 'eq') && find(tech.w, 'eq').equipment.length === 2);

        srv.offline = true;
        await edit(tech.w, "customers[0].equipment.push({id:'e3', type:'Heater', photos:[]})");
        await edit(owner.w, "customers[0].equipment = customers[0].equipment.filter(x => x.id !== 'e1')");
        await edit(tech.w, "customers[0].dogs.push({id:'d2', name:'Max'})");
        await edit(owner.w, "customers[0].dogs.push({id:'d3', name:'Bella'})");
        await edit(owner.w, "customers[0].fountains.push({id:'f1', name:'Front'})");
        await sleep(2300); await idle(owner.w); await idle(tech.w);
        srv.offline = false;
        await sync(tech.w); await sync(owner.w); await sync(tech.w);
        let r = await row('eq');
        const types = r.data.equipment.map(x => x.type).join(',');
        check('the technician\'s new heater is kept', types.indexOf('Heater') !== -1, types);
        check('and the owner\'s removed filter stays removed', types.indexOf('Filter') === -1, types);
        check('the pump nobody touched is still there', types.indexOf('Pump') !== -1, types);
        const dogs = r.data.dogs.map(x => x.name).sort().join(',');
        check('a dog added on each device: all three dogs kept', dogs === 'Bella,Max,Rex', dogs);
        check('a new fountain arrives', r.data.fountains.length === 1 && r.data.fountains[0].name === 'Front');
        check('none of this counted as a conflict', (await versions()).length === 0, JSON.stringify(await versions()));
        const ownerTypes = find(owner.w, 'eq').equipment.map(x => x.type).sort().join(',');
        const techTypes = find(tech.w, 'eq').equipment.map(x => x.type).sort().join(',');
        check('the owner\'s device matches', ownerTypes === 'Heater,Pump', ownerTypes);
        check('the technician\'s device matches', techTypes === 'Heater,Pump', techTypes);
        check('both devices have all three dogs',
              find(owner.w, 'eq').dogs.length === 3 && find(tech.w, 'eq').dogs.length === 3);
        check('the list on the owner\'s screen is current too', owner.w.eval("customers[0].dogs.length") === 3);

        // The same item, newer edit arriving second
        srv.offline = true;
        await edit(tech.w, "customers[0].equipment.find(x => x.id === 'e2').model = 'TECH-OLDER'");
        await sleep(40);
        await edit(owner.w, "customers[0].equipment.find(x => x.id === 'e2').model = 'OWNER-NEWER'");
        await sleep(2300); await idle(owner.w); await idle(tech.w);
        srv.offline = false;
        await sync(tech.w); await sync(owner.w); await sync(tech.w);
        r = await row('eq');
        check('the same item: newer edit wins', r.data.equipment.find(x => x.id === 'e2').model === 'OWNER-NEWER');
        check('the other item in that list is untouched', r.data.equipment.some(x => x.id === 'e3' && x.type === 'Heater'));
        check('the replaced item is kept', (await versions()).some(v => JSON.stringify(v.data).indexOf('TECH-OLDER') !== -1),
              JSON.stringify(await versions()));
        check('the technician\'s device takes the newer item', find(tech.w, 'eq').equipment.find(x => x.id === 'e2').model === 'OWNER-NEWER');

        // An older removal does not beat a newer edit of that item
        srv.offline = true;
        await edit(owner.w, "customers[0].equipment = customers[0].equipment.filter(x => x.id !== 'e3')");
        await sleep(40);
        await edit(tech.w, "customers[0].equipment.find(x => x.id === 'e3').model = 'KEEP'");
        await sleep(2300); await idle(owner.w); await idle(tech.w);
        srv.offline = false;
        await sync(tech.w); await sync(owner.w);
        r = await row('eq');
        check('an older removal does not remove a newer edit of that item', r.data.equipment.some(x => x.id === 'e3' && x.model === 'KEEP'),
              JSON.stringify(r.data.equipment));
        check('the item comes back on the owner\'s device', find(owner.w, 'eq').equipment.some(x => x.id === 'e3'));

        // Order is kept
        await edit(owner.w, "customers[0].dogs.reverse()");
        await sleep(2300); await idle(owner.w);
        await sync(tech.w);
        check('a reordered list keeps its order on the other device',
              find(tech.w, 'eq').dogs.map(x => x.id).join() === find(owner.w, 'eq').dogs.map(x => x.id).join(),
              find(tech.w, 'eq').dogs.map(x => x.id).join() + ' vs ' + find(owner.w, 'eq').dogs.map(x => x.id).join());
        const pushesBefore = srv.rpcCount;
        await sync(owner.w); await sync(tech.w);
        check('nothing keeps being re-sent afterwards', srv.rpcCount === pushesBefore, srv.rpcCount - pushesBefore);
        owner.close(); tech.close();
      }

      console.log('\n=== Customers uploaded by the first sync version ===');
      {
        await reset(); const srv = makeServer();
        // As the first version stored them: no per-field times at all
        await pool.query('insert into public.customers(company_id,id,data,edited_at,updated_at) values ($1,$2,$3,$4,$4)',
          [COMPANY, 'leg', cust('leg', 'Legacy', {gateCode: 'G1', day: 'Monday', equipment: [{id: 'x1', type: 'Filter'}]}), '2026-09-15T08:00:00+00:00']);
        const owner = await boot(srv, {'poollog:customers': []});
        const tech = await boot(srv, {'poollog:customers': []}, {uid: TECH});
        srv.offline = true;
        await edit(tech.w, "customers[0].day = 'Friday'");        // made first
        await sleep(40);
        await edit(owner.w, "customers[0].gateCode = 'G2'");      // made second, sent first
        await edit(owner.w, "customers[0].equipment.push({id:'x2', type:'Pump'})");
        await sleep(2300); await idle(owner.w); await idle(tech.w);
        srv.offline = false;
        await sync(owner.w);
        await sync(tech.w);
        const r = await row('leg');
        check('an earlier edit to a different field still goes through', r.data.day === 'Friday', JSON.stringify(r.data));
        check('alongside the later one', r.data.gateCode === 'G2');
        check('and the equipment added', r.data.equipment.length === 2, JSON.stringify(r.data.equipment));
        check('with nothing wrongly counted as lost', (await versions()).length === 0, JSON.stringify(await versions()));
        owner.close(); tech.close();
      }

      console.log('\n=== An edit made while a push is in flight is not lost ===');
      {
        await reset(); const srv = makeServer();
        const d = await boot(srv, {'poollog:customers': [cust('f', 'Foxtrot')]});
        const real = srv.handle;
        srv.handle = async (uid, url, o) => {
          if(url.includes('push_customer_fields') && !srv.edited){
            srv.edited = true;
            d.w.eval("customers[0].gateCode = 'DURING'; lsSet('customers', customers);");
          }
          return real(uid, url, o);
        };
        d.w.eval("customers[0].gateCode = 'BEFORE'; lsSet('customers', customers);");
        await sync(d.w);
        check('the edit made mid-push is still here', find(d.w, 'f').gateCode === 'DURING', find(d.w, 'f').gateCode);
        check('and still waiting to send', /waiting/.test(status(d.w)), status(d.w));
        srv.handle = real;
        await sync(d.w);
        check('the next sync sends it', (await row('f')).data.gateCode === 'DURING');
        d.close();
      }

      console.log('\n=== A dropped signal mid-sync resumes cleanly ===');
      {
        await reset(); const srv = makeServer();
        const list = [];
        for(let i = 1; i <= 6; i++) list.push(cust('p' + i, 'P' + i));
        srv.failRpcAfter = 2;
        const d = await boot(srv, {'poollog:customers': list});
        check('the first two are saved', (await rows()).length === 2);
        check('the rest are still waiting', /4 customers still waiting/.test(status(d.w)), status(d.w));
        srv.failRpcAfter = null;
        await sync(d.w);
        check('the next sync sends the rest', (await rows()).length === 6);
        check('with nothing duplicated or conflicted', (await versions()).length === 0);
        check('every record intact', (await rows()).every(r => /^P\d$/.test(r.data.name) && r.data.gateCode === '1111'));
        d.close();
      }

      console.log('\n=== Many customers vanishing here stops and asks ===');
      {
        await reset(); const srv = makeServer();
        const list = [];
        for(let i = 1; i <= 9; i++) list.push(cust('v' + i, 'V' + i));
        const d = await boot(srv, {'poollog:customers': list});
        d.w.__answer = 'cancel';
        await edit(d.w, "customers = customers.slice(0, 2)");
        await sleep(2300); await idle(d.w);
        check('a question was asked', d.dialogs.some(t => /7 customers are missing/.test(t)), d.dialogs.join(' | '));
        check('nothing was deleted on the server', (await rows()).every(r => !r.deleted));
        check('answering Keep brings them back here', local(d.w).length === 9, local(d.w).length);
        await sync(d.w);
        check('and they stay back', local(d.w).length === 9 && (await rows()).every(r => !r.deleted));
        d.w.__answer = 'ok';
        await edit(d.w, "customers = customers.slice(0, 2)");
        await sleep(2300); await idle(d.w);
        const del = (await rows()).filter(r => r.deleted);
        check('answering Delete marks them deleted', del.length === 7, del.length);
        check('with their details kept', del.every(r => r.data && r.data.name));
        d.close();
      }

      console.log('\n=== Five or fewer deletes go through without a question ===');
      {
        await reset(); const srv = makeServer();
        const list = [];
        for(let i = 1; i <= 7; i++) list.push(cust('f' + i, 'F' + i));
        const d = await boot(srv, {'poollog:customers': list});
        await edit(d.w, "customers = customers.slice(0, 2)");
        await sleep(2300); await idle(d.w);
        check('no question for exactly five', d.dialogs.length === 0, d.dialogs.join(' | '));
        check('five marked deleted', (await rows()).filter(r => r.deleted).length === 5);
        d.close();
      }

      console.log('\n=== Many deletions arriving from another device stops and asks ===');
      {
        await reset(); const srv = makeServer();
        for(let i = 1; i <= 8; i++) await serverPut(OWNER, 'x' + i, cust('x' + i, 'X' + i));
        const d = await boot(srv, {'poollog:customers': []});
        check('device has all eight', local(d.w).length === 8);
        for(let i = 1; i <= 7; i++) await serverSet(TECH, 'x' + i, {_deleted: {t: new Date().toISOString(), v: true}});
        d.w.__answer = 'cancel';
        await sync(d.w);
        check('a question was asked', d.dialogs.some(t => /server says 7 customers were deleted/.test(t)), d.dialogs.join(' | '));
        check('Keep leaves them on this device', local(d.w).length === 8, local(d.w).length);
        check('and puts them back on the server', (await rows()).every(r => !r.deleted), JSON.stringify((await rows()).map(r => r.deleted)));
        await sleep(20);
        for(let i = 1; i <= 7; i++) await serverSet(TECH, 'x' + i, {_deleted: {t: new Date().toISOString(), v: true}});
        d.w.__answer = 'ok';
        await sync(d.w);
        check('Remove takes them off this device', local(d.w).length === 1, local(d.w).length);
        d.close();
      }

      console.log('\n=== A customer name cannot inject into the question ===');
      {
        await reset(); const srv = makeServer();
        for(let i = 1; i <= 7; i++) await serverPut(OWNER, 'h' + i, cust('h' + i, '<img src=x onerror=alert(1)>'));
        const d = await boot(srv, {'poollog:customers': []});
        for(let i = 1; i <= 7; i++) await serverSet(OWNER, 'h' + i, {_deleted: {t: new Date().toISOString(), v: true}});
        let injected = false;
        const iv2 = setInterval(()=>{ if(d.w.document.querySelector('.confirm-overlay img')) injected = true; }, 1);
        d.w.__answer = 'ok';
        await sync(d.w);
        clearInterval(iv2);
        check('the name is shown as text, not markup', !injected && d.dialogs.some(t => t.indexOf('<img') !== -1));
        d.close();
      }

      console.log('\n=== Another company never sees or touches these customers ===');
      {
        await reset(); const srv = makeServer();
        const mine = await boot(srv, {'poollog:customers': [cust('iso', 'Mine', {gateCode: 'SECRET'})]});
        const theirs = await boot(srv, {'poollog:customers': [cust('iso', 'Theirs', {gateCode: 'THEIRS'})]}, {uid: OUTSIDER});
        check('the other company\'s device does not receive mine', !local(theirs.w).some(c => c.gateCode === 'SECRET'));
        check('and its own customer with the same id does not overwrite mine', (await row('iso')).data.gateCode === 'SECRET');
        await sync(mine.w);
        check('my device is unaffected', find(mine.w, 'iso').gateCode === 'SECRET');
        mine.close(); theirs.close();
      }

      console.log('\n=== Signed out, nothing talks to the server ===');
      {
        await reset(); const srv = makeServer();
        const d = await boot(srv, {'poollog:customers': [cust('z', 'Zulu')]}, {signedIn: false});
        const r = await d.w.eval('syncCustomers()');
        check('sync refuses', r.ok === false && r.reason === 'signed-out');
        check('no customer calls made', !srv.calls.some(c => c.includes('customers') || c.includes('rpc')), srv.calls.join(', '));
        d.close();
      }

      console.log('\n=== Backups and restores never carry sync state ===');
      {
        await reset(); const srv = makeServer();
        const d = await boot(srv, {'poollog:customers': [cust('k', 'Kilo')]});
        const keys = []; for(let i = 0; i < d.w.localStorage.length; i++) keys.push(d.w.localStorage.key(i));
        check('sync state exists', keys.some(k => k.startsWith('poollogsync:')));
        const b = d.w.eval('collectBackup()');
        check('a downloaded backup does not include it', !Object.keys(b.data).some(k => /poollogsync|^state:/.test(k)), Object.keys(b.data).join(','));
        d.close();
      }

      console.log('\n=== Sync state from the earlier whole-record version is not trusted ===');
      {
        await reset(); const srv = makeServer();
        await serverPut(OWNER, 'old1', cust('old1', 'From Server'));
        const stale = {pulledOnce: true, cursor: '2030-01-01T00:00:00+00:00', known: {old1: {h: 'x', u: '2030-01-01', d: false}}, seen: {}, edits: {}};
        const d = await boot(srv, {'poollog:customers': [], ['poollogsync:state:' + COMPANY]: stale});
        check('it starts over with a full pull', local(d.w).some(c => c.id === 'old1'));
        check('nothing was deleted', (await rows()).every(r => !r.deleted));
        d.close();
      }

      console.log('\n=== Upgrading from the first sync version keeps unsent edits ===');
      {
        await reset(); const srv = makeServer();
        // Rows as the first version left them: no per-field times
        const saved = '2026-09-15T22:20:00+00:00';
        for(const c of [cust('u1', 'Uniform', {gateCode: 'ON-SERVER'}), cust('u2', 'Victor'), cust('u3', 'Whiskey')]){
          await pool.query('insert into public.customers(company_id,id,data,edited_at,updated_at) values ($1,$2,$3,$4,$4)', [COMPANY, c.id, c, saved]);
        }
        const unsentAt = '2026-09-15T22:30:00.000Z';
        const v1state = {pulledOnce: true, cursor: saved, backupAt: '2026-09-15T22:17:40.000Z',
          known: {u1: {h: 'a', u: saved, d: false}, u2: {h: 'b', u: saved, d: false}, u3: {h: 'c', u: saved, d: false}},
          seen: {}, edits: {u1: unsentAt, u3: unsentAt}};
        const here = [cust('u1', 'Uniform', {gateCode: 'EDITED-NOT-SENT'}), cust('u2', 'Victor')];   // u3 deleted here, not sent
        const d = await boot(srv, {'poollog:customers': here, ['poollogsync:state:' + COMPANY]: v1state});
        check('no question is asked', d.dialogs.length === 0, d.dialogs.join(' | '));
        check('the unsent edit is not overwritten by the server', find(d.w, 'u1').gateCode === 'EDITED-NOT-SENT', find(d.w, 'u1').gateCode);
        check('it reaches the server', (await row('u1')).data.gateCode === 'EDITED-NOT-SENT', (await row('u1')).data.gateCode);
        check('the unsent delete reaches the server as a delete', (await row('u3')).deleted === true);
        check('and does not come back here', !find(d.w, 'u3'));
        check('untouched customers are left alone', (await row('u2')).data.name === 'Victor' && (await row('u2')).deleted === false);
        check('everything is sent', /Synced/.test(status(d.w)), status(d.w));
        d.close();
      }

      console.log('\n=== More than one page of customers ===');
      {
        await reset(); const srv = makeServer();
        const values = [];
        const t = new Date().toISOString();
        for(let i = 1; i <= 1203; i++){
          const data = cust('bulk' + i, 'Bulk ' + i);
          values.push(pool.query(`insert into public.customers(company_id,id,data,field_times,edited_at) values ($1,$2,$3,$4,$5)`,
            [COMPANY, 'bulk' + i, data, Object.fromEntries(Object.keys(data).map(k => [k, t])), t]));
        }
        await Promise.all(values);
        const d = await boot(srv, {'poollog:customers': []});
        check('all 1,203 arrive across pages', local(d.w).length === 1203, local(d.w).length);
        check('without pushing any back', srv.rpcCount === 0, srv.rpcCount);
        d.close();
      }

      console.log('\n=== Deleted customers can be found and restored ===');
      {
        await reset(); const srv = makeServer();
        const d = await boot(srv, {'poollog:customers': [cust('r1', 'Romeo', {address: '1 Palm Way', gateCode: 'R-GATE'}), cust('r2', 'Sierra', {address: '2 Palm Way'}), cust('r3', 'Tango')]});
        const other = await boot(srv, {'poollog:customers': []}, {uid: TECH});
        d.w.__answer = 'ok';
        d.w.eval("deleteCustomer(customers.find(c => c.id === 'r1'))"); await sleep(60);
        d.w.eval("deleteCustomer(customers.find(c => c.id === 'r2'))"); await sleep(60);
        await sleep(2300); await idle(d.w);
        await sync(other.w);
        check('both deletions reached the other device', !find(other.w, 'r1') && !find(other.w, 'r2'));

        const doc = d.w.document;
        const restoreBtn = doc.getElementById('btnRestoreCustomers');
        check('there is a Restore customers button', !!restoreBtn && restoreBtn.textContent.trim() === 'Restore customers',
              restoreBtn ? restoreBtn.textContent : 'missing');
        const restoreRow = restoreBtn && restoreBtn.parentNode;
        check('it sits in the top row with Add a customer and Import customers',
              !!restoreRow && restoreRow.parentNode.id === 'addCustomerCard'
              && !!restoreRow.querySelector('#btnAddCustomer') && !!restoreRow.querySelector('#btnImportCustomers'), restoreRow ? restoreRow.outerHTML.slice(0, 120) : '');
        check('it comes after them', !!restoreRow && restoreRow.lastElementChild === restoreBtn
              && (restoreBtn.compareDocumentPosition(doc.getElementById('btnImportCustomers')) & 2) === 2);
        check('pushed to the far right', !!restoreBtn && restoreBtn.style.marginLeft === 'auto', restoreBtn ? restoreBtn.style.cssText : '');
        check('the old button at the bottom of the list is gone',
              !doc.getElementById('btnDeletedCustomers')
              && !Array.from(doc.querySelectorAll('#allCustomersCard button')).some(b => /Deleted customers|Restore customers/.test(b.textContent)));
        doc.getElementById('btnRestoreCustomers').click();
        await sleep(200);
        const ov = doc.getElementById('deletedCustomersOverlay');
        check('it opens a list', !!ov);
        const names = () => Array.from(ov.querySelectorAll('.deleted-customer')).map(x => x.textContent);
        check('both deleted customers are listed', names().length === 2 && names().some(t => /Romeo/.test(t)) && names().some(t => /Sierra/.test(t)), names().join(' | '));
        check('customers not deleted are not', !names().some(t => /Tango/.test(t)));
        check('each shows when it was deleted', names().every(t => /Deleted /.test(t)), names().join(' | '));
        check('and its address', names().some(t => /1 Palm Way/.test(t)));
        const search = ov.querySelector('#deletedSearch');
        search.value = 'sierra'; search.dispatchEvent(new d.w.Event('input'));
        check('search narrows the list', names().length === 1 && /Sierra/.test(names()[0]), names().join(' | '));
        search.value = ''; search.dispatchEvent(new d.w.Event('input'));

        const romeo = Array.from(ov.querySelectorAll('.deleted-customer')).find(x => /Romeo/.test(x.textContent));
        romeo.querySelector('button').click();
        await sleep(400);
        check('a question is asked first', d.dialogs.some(t => /Restore Romeo/.test(t)), d.dialogs.join(' | '));
        check('Romeo is back on this device', !!find(d.w, 'r1'));
        check('with every detail', find(d.w, 'r1') && find(d.w, 'r1').gateCode === 'R-GATE' && find(d.w, 'r1').address === '1 Palm Way');
        check('and on the screen list', d.w.eval("customers.some(c => c.id === 'r1')"));
        check('the server no longer marks him deleted', (await row('r1')).deleted === false);
        check('he leaves the deleted list', names().length === 1 && /Sierra/.test(names()[0]), names().join(' | '));
        check('Sierra is still deleted', (await row('r2')).deleted === true && !find(d.w, 'r2'));
        const pushes = srv.rpcCount;
        await sync(d.w);
        check('the next sync does not undo the restore', !!find(d.w, 'r1') && (await row('r1')).deleted === false);
        check('and has nothing left to send', srv.rpcCount === pushes, srv.rpcCount - pushes);
        await sync(other.w);
        check('the other device gets Romeo back', find(other.w, 'r1') && find(other.w, 'r1').gateCode === 'R-GATE');

        ov.querySelector('#deletedClose').click();
        check('Close shuts the list', !doc.getElementById('deletedCustomersOverlay'));

        srv.offline = true;
        doc.getElementById('btnRestoreCustomers').click();
        await sleep(200);
        check('offline, it says a connection is needed', /offline/i.test(doc.getElementById('deletedCustomersOverlay').textContent));
        doc.getElementById('deletedCustomersOverlay').querySelector('#deletedClose').click();
        srv.offline = false;

        // A restore does not overwrite an edit made meanwhile to other fields
        await serverSet(TECH, 'r2', {notes: {t: new Date().toISOString(), v: 'note added while deleted'}});
        doc.getElementById('btnRestoreCustomers').click();
        await sleep(200);
        const ov2 = doc.getElementById('deletedCustomersOverlay');
        const sierra = Array.from(ov2.querySelectorAll('.deleted-customer')).find(x => /Sierra/.test(x.textContent));
        check('a customer edited after deletion is back on its own (the edit restored it)', !sierra);
        ov2.querySelector('#deletedClose').click();
        await sync(d.w);
        check('and syncs down with the new note', find(d.w, 'r2') && find(d.w, 'r2').notes === 'note added while deleted');
        d.close(); other.close();
      }

      console.log('\n=== The Settings card is wired ===');
      {
        await reset(); const srv = makeServer();
        const d = await boot(srv, {'poollog:customers': [cust('q', 'Quebec')]});
        const doc = d.w.document;
        check('Sync now button exists', !!doc.getElementById('btnSyncNow'));
        check('pre-sync backup button exists', !!doc.getElementById('btnSyncBackup'));
        await serverPut(TECH, 'late', cust('late', 'Arrived Late'));
        doc.getElementById('btnSyncNow').click();
        await sleep(50); await idle(d.w);
        check('pressing Sync now pulls', !!find(d.w, 'late'));
        check('the card explains the field-by-field merge',
              /each keeps the fields they changed/.test(fs.readFileSync('customer-intake.html', 'utf8')));
        d.close();
      }
    }catch(e){
      check('sync suite', false, e.stack);
    }
    await pool.end();
  })();
}

// ======== records-test (folded in) ========
async function serverCompanyRecords(){
  // Company records (snippet 07): technician profiles, company details, setup and
  // settings. Who can read and change which, and that they merge field by field.
  // Real Postgres with the real snippets. Needs: bash sync-test-setup.sh
  const { Pool } = require('pg');
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

  return (async ()=>{
    try{ await pool.query('select 1'); }
    catch(e){ check('Postgres is reachable for the server checks (run: bash sync-test-setup.sh)', false); await pool.end().catch(()=>{}); return; }
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
  })();
}


// ======== the website sending and receiving company records ========
async function websiteCompanyRecords(){
  const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
  const { JSDOM } = require('jsdom');
  const { Pool } = require('pg');
  const pool = new Pool({host: '127.0.0.1', user: 'postgres', password: 'pw', database: 'pl', max: 3});
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const CO = 'aaaaaaaa-0000-0000-0000-000000000001', OTHER_CO = 'bbbbbbbb-0000-0000-0000-000000000002';
  const OWNER = '11111111-1111-1111-1111-111111111111', OUTSIDER = '22222222-2222-2222-2222-222222222222';

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

  const RPC = {
    my_membership: [],
    push_customer_fields: [['p_id','text'], ['p_changes','jsonb'], ['p_base','timestamptz']],
    push_record_fields: [['p_kind','text'], ['p_id','text'], ['p_changes','jsonb'], ['p_base','timestamptz']]
  };

  function makeServer(){
    const srv = {offline: false, calls: []};
    srv.handle = async (uid, url, opts) => {
      const o = opts || {};
      const u = new URL(url);
      srv.calls.push((o.method || 'GET') + ' ' + u.pathname);
      if(srv.offline) throw new TypeError('Failed to fetch');
      if(u.pathname === '/rest/v1/rpc/my_membership'){
        const r = await asUser(uid, 'select public.my_membership() j');
        return [200, r.rows[0].j];
      }
      if(u.pathname === '/rest/v1/customers'){
        const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
          select id, data, deleted, updated_at from public.customers order by updated_at, id) t`);
        return [200, r.rows[0].j];
      }
      if(u.pathname === '/rest/v1/company_records'){
        const since = u.searchParams.get('updated_at');
        const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
          select kind, id, data, deleted, updated_at from public.company_records
          ${since ? "where updated_at >= $1" : ''} order by updated_at, kind, id) t`,
          since ? [since.replace(/^gte\./, '')] : []);
        return [200, r.rows[0].j];
      }
      if(u.pathname === '/rest/v1/members'){
        const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
          select technician_id, username, is_admin from public.members where technician_id is not null and removed_at is null) t`);
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
    const dom = new JSDOM(fs.readFileSync('customer-intake.html', 'utf8'), {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/',
      beforeParse(w){
        w.matchMedia = () => ({matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}});
        w.scrollTo = () => {}; w.scrollBy = () => {}; w.alert = () => {};
        w.HTMLCanvasElement.prototype.getContext = () => ({drawImage(){}, fillRect(){}});
        w.Element.prototype.scrollIntoView = function(){};
        w.console.warn = () => {}; w.console.error = (...a) => { (w.__errs = w.__errs || []).push(a.map(String).join(' ')); };
        w.indexedDB = new FDBFactory(); w.IDBKeyRange = global.IDBKeyRange;
        w.fetch = async (url, o2) => {
          await sleep(1);
          const [status, body] = await srv.handle(OWNER, url, o2);
          return {ok: status >= 200 && status < 300, status, json: async () => body};
        };
        w.localStorage.setItem('poollog:sbSession', JSON.stringify({access_token: 'tok', refresh_token: 'r'}));
        Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem('poollog:' + k, JSON.stringify(v)));
      }
    });
    const w = dom.window;
    await sleep(700);
    for(let i = 0; i < 400 && w.eval('syncRunning'); i++) await sleep(10);
    return {w, d: w.document, close(){ w.close(); }};
  }
  const idle = async w => { for(let i = 0; i < 600; i++){ await sleep(10); if(!w.eval('syncRunning')){ await sleep(20); if(!w.eval('syncRunning')) return; } } };
  const syncNow = async w => { await w.eval('syncCustomers()'); await idle(w); };
  const record = async (kind, id) => (await pool.query('select data, deleted from public.company_records where company_id = $1 and kind = $2 and id = $3', [CO, kind, id])).rows[0];
  const local = (w, key) => JSON.parse(w.localStorage.getItem('poollog:' + key) || 'null');

  console.log('\n=== the website puts company records on the server ===');
  try{
    await pool.query('truncate public.customers, public.customer_versions, public.company_records, public.record_versions');
    await pool.query('delete from public.members; delete from public.companies; delete from auth.users;');
    await pool.query(`insert into auth.users(id, email) values ($1,'john@triffic.test'),($2,'mike@affinity.test')`, [OWNER, OUTSIDER]);
    await pool.query(`insert into public.companies(id, name, code) values ($1,'Triffic Pool and Spa','TRIFFIC'),($2,'Affinity','AFFIN1')`, [CO, OTHER_CO]);
    await pool.query(`insert into public.members(user_id, company_id, role, name) values ($1,$2,'owner','John'),($3,$4,'owner','Mike')`, [OWNER, CO, OUTSIDER, OTHER_CO]);

    const srv = makeServer();
    const site = await boot(srv, {
      customers: [],
      technicians: [{id: 't1', name: 'Alex', phone: '(623) 555-0100', canPhotoEquipment: true,
                     requireSkipProof: true, requireGatePhoto: false, username: 'alex', password: 'secret123'}],
      companyName: 'Triffic Pool and Spa',
      accountPhone: '(623) 555-0142',
      licenseNumber: 'ROC-284419',
      chemConfig: {pool: {chemicals: [{key: 'chlorine'}], dosages: []}},
      settings: {showBeforePhotos: true, showAfterPhotos: true, showGatePhoto: false,
                 voiceModeEnabled: true, storePhotos: false, micSide: 'left'}
    });
    const w = site.w;

    const tech = await record('technician', 't1');
    check('  a technician profile reaches the server', !!tech && tech.data.name === 'Alex', JSON.stringify(tech));
    check('  with the settings from their page',
          tech && tech.data.canPhotoEquipment === true && tech.data.requireSkipProof === true && tech.data.requireGatePhoto === false);
    check('  but never their password', tech && !('password' in tech.data), JSON.stringify(tech && tech.data));
    const details = await record('company', 'details');
    check('  company details reach the server',
          details && details.data.companyName === 'Triffic Pool and Spa' && details.data.licenseNumber === 'ROC-284419', JSON.stringify(details));
    const setup = await record('setup', 'chemConfig');
    check('  the chemical setup reaches the server', setup && setup.data.value.pool.chemicals[0].key === 'chlorine', JSON.stringify(setup));
    const setting = await record('setting', 'company');
    check('  company-wide settings reach the server',
          setting && setting.data.showBeforePhotos === true && setting.data.showGatePhoto === false, JSON.stringify(setting));
    check('  settings about the phone itself do not',
          setting && !('voiceModeEnabled' in setting.data) && !('storePhotos' in setting.data) && !('micSide' in setting.data),
          JSON.stringify(setting && setting.data));

    console.log('\n=== changes on the website go up on their own ===');
    w.eval("lsSet('companyName', 'Triffic Pools LLC')");
    await sleep(2300); await idle(w);
    check('  a changed company name goes up without pressing anything', (await record('company', 'details')).data.companyName === 'Triffic Pools LLC');
    w.eval("technicians[0].requireGatePhoto = true; saveTechnicians();");
    await sleep(2300); await idle(w);
    check('  a changed technician setting goes up', (await record('technician', 't1')).data.requireGatePhoto === true);
    w.eval("technicians.push({id:'t2', name:'Sam'}); saveTechnicians();");
    await sleep(2300); await idle(w);
    check('  a new technician goes up', !!(await record('technician', 't2')));
    w.eval("technicians = technicians.filter(t => t.id !== 't2'); saveTechnicians();");
    await sleep(2300); await idle(w);
    const gone = await record('technician', 't2');
    check('  a deleted technician is only marked deleted, details kept', gone && gone.deleted === true && gone.data.name === 'Sam', JSON.stringify(gone));

    console.log('\n=== changes made elsewhere come down ===');
    const t = new Date().toISOString();
    await asUser(OWNER, 'select public.push_record_fields($1,$2,$3::jsonb,null)',
      ['setting', 'company', JSON.stringify({showGatePhoto: {t, v: true}})]);
    await asUser(OWNER, 'select public.push_record_fields($1,$2,$3::jsonb,null)',
      ['technician', 't1', JSON.stringify({phone: {t, v: '(623) 555-0999'}})]);
    await asUser(OWNER, 'select public.push_record_fields($1,$2,$3::jsonb,null)',
      ['company', 'details', JSON.stringify({accountEmail: {t, v: 'service@triffic.test'}})]);
    await syncNow(w);
    check('  a setting changed elsewhere arrives', local(w, 'settings').showGatePhoto === true, JSON.stringify(local(w, 'settings')));
    check('  and the app is using it', w.eval('appSettings.showGatePhoto') === true);
    check('  this phone\'s own settings are untouched',
          local(w, 'settings').voiceModeEnabled === true && local(w, 'settings').micSide === 'left', JSON.stringify(local(w, 'settings')));
    check('  a technician change arrives', local(w, 'technicians').find(x => x.id === 't1').phone === '(623) 555-0999');
    check('  without losing the password kept here', local(w, 'technicians').find(x => x.id === 't1').password === 'secret123');
    check('  a company detail arrives', local(w, 'accountEmail') === 'service@triffic.test');
    const before = srv.calls.length;
    await syncNow(w);
    check('  a second sync sends nothing new', srv.calls.filter(c => c.indexOf('push_record_fields') !== -1).length === 0
          || srv.calls.slice(before).every(c => c.indexOf('push_record_fields') === -1), srv.calls.slice(before).join(', '));

    console.log('\n=== two people, different fields ===');
    srv.offline = true;
    w.eval("lsSet('licenseNumber', 'ROC-999999')");
    await sleep(2300); await idle(w);
    const t2 = new Date().toISOString();
    await asUser(OWNER, 'select public.push_record_fields($1,$2,$3::jsonb,null)',
      ['company', 'details', JSON.stringify({accountPhone: {t: t2, v: '(623) 555-1111'}})]);
    srv.offline = false;
    await syncNow(w);
    const merged = await record('company', 'details');
    check('  the change made here goes up', merged.data.licenseNumber === 'ROC-999999', JSON.stringify(merged.data));
    check('  and the one made elsewhere survives', merged.data.accountPhone === '(623) 555-1111', JSON.stringify(merged.data));
    check('  both are on this device now',
          local(w, 'licenseNumber') === 'ROC-999999' && local(w, 'accountPhone') === '(623) 555-1111');

    console.log('\n=== offline ===');
    srv.offline = true;
    w.eval("lsSet('companyName', 'Saved While Offline')");
    await sleep(2300); await idle(w);
    check('  a change made offline stays on the website', local(w, 'companyName') === 'Saved While Offline');
    check('  and has not reached the server', (await record('company', 'details')).data.companyName === 'Triffic Pools LLC');
    srv.offline = false;
    await syncNow(w);
    check('  it goes up when the connection is back', (await record('company', 'details')).data.companyName === 'Saved While Offline');
    site.close();
  }catch(e){
    check('  website company records', false, e.stack);
  }
  await pool.end();
}
