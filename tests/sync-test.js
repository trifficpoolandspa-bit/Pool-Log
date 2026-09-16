// Customer sync on the office site, driven through the real page against a
// real Postgres running the real snippets 03 to 06. Only the HTTP layer is
// imitated, the way Supabase's Data API answers.
//
// Needs Postgres. In a fresh container:  bash sync-test-setup.sh
// Runs as its own process — it relies on IndexedDB and timers finishing.
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
      const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
        select m.user_id, m.role, m.name, m.company_id, json_build_object('name', c.name) companies
        from public.members m join public.companies c on c.id = m.company_id where m.user_id = auth.uid()) t`);
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

(async ()=>{
  try{
    await pool.query('select 1');
  }catch(e){
    console.log('Postgres is not reachable. Run: bash sync-test-setup.sh\n  ' + e.message);
    process.exit(1);
  }
  try{
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
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
