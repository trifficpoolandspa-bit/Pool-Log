// Customer sync on the office site, driven through the real code against a
// stand-in server that behaves like snippet 03's push_customer. Needs its own
// process: it relies on IndexedDB and timers finishing.
require('fake-indexeddb/auto');
const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  — ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';

// ---------- stand-in server ----------
function makeServer(){
  const srv = {rows: new Map(), versions: [], calls: [], offline: false, failRpcAfter: null, rpcCount: 0, clock: Date.parse('2026-09-15T12:00:00Z')};
  srv.tick = () => new Date(srv.clock += 1000).toISOString().replace('Z', '+00:00');
  srv.put = (id, data, extra) => {
    const u = srv.tick();
    srv.rows.set(id, Object.assign({id, data, deleted: false, updated_at: u, edited_at: u}, extra || {}));
  };
  srv.handle = (url, opts) => {
    const o = opts || {};
    const u = new URL(url);
    srv.calls.push((o.method || 'GET') + ' ' + u.pathname);
    if(srv.offline) throw new TypeError('Failed to fetch');
    if(u.pathname === '/rest/v1/members'){
      return [200, [{user_id: 'u1', role: 'owner', name: 'John Tyler', company_id: COMPANY, companies: {name: 'Triffic Pool and Spa'}}]];
    }
    if(u.pathname === '/rest/v1/customers'){
      let list = Array.from(srv.rows.values());
      const since = u.searchParams.get('updated_at');
      if(since) list = list.filter(r => new Date(r.updated_at) >= new Date(since.replace(/^gte\./, '')));
      const idEq = u.searchParams.get('id');
      if(idEq && idEq.startsWith('eq.')) list = list.filter(r => r.id === idEq.slice(3));
      if(idEq && idEq.startsWith('in.(')){
        const ids = idEq.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, ''));
        list = list.filter(r => ids.includes(r.id));
      }
      list.sort((a,b)=> a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : (a.id < b.id ? -1 : 1));
      const off = +(u.searchParams.get('offset') || 0), lim = +(u.searchParams.get('limit') || 1e9);
      return [200, JSON.parse(JSON.stringify(list.slice(off, off + lim)))];
    }
    if(u.pathname === '/rest/v1/rpc/push_customer'){
      srv.rpcCount++;
      if(srv.failRpcAfter !== null && srv.rpcCount > srv.failRpcAfter) throw new TypeError('Failed to fetch');
      const b = JSON.parse(o.body);
      if(!b.p_id || !b.p_data || !b.p_edited_at) return [400, {message: 'A customer push needs an id, data and an edit time'}];
      const row = srv.rows.get(b.p_id);
      const now = srv.tick();
      if(!row){
        srv.rows.set(b.p_id, {id: b.p_id, data: b.p_data, deleted: !!b.p_deleted, updated_at: now, edited_at: b.p_edited_at});
        return [200, {result: 'saved', updated_at: now}];
      }
      if(b.p_base === null || new Date(row.updated_at) > new Date(b.p_base)){
        if(new Date(row.edited_at || row.updated_at) > new Date(b.p_edited_at)){
          srv.versions.push({id: b.p_id, data: b.p_data, deleted: !!b.p_deleted, reason: 'older edit arrived after a newer one'});
          return [200, {result: 'server_newer', updated_at: row.updated_at, data: row.data, deleted: row.deleted, edited_at: row.edited_at}];
        }
        srv.versions.push({id: b.p_id, data: row.data, deleted: row.deleted, reason: 'replaced by a newer edit from another device'});
      }
      srv.rows.set(b.p_id, {id: b.p_id, data: b.p_data, deleted: !!b.p_deleted, updated_at: now, edited_at: b.p_edited_at});
      return [200, {result: 'saved', updated_at: now}];
    }
    return [404, {message: 'not found'}];
  };
  return srv;
}

// ---------- the office site on a device ----------
async function boot(srv, localStorageSeed, opts){
  const o = opts || {};
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
      // Each device gets its own browser database
      w.indexedDB = new FDBFactory(); w.IDBKeyRange = global.IDBKeyRange;
      w.fetch = async (url, opts2) => {
        await sleep(1);
        const [status, body] = srv.handle(url, opts2);
        return {ok: status >= 200 && status < 300, status, json: async () => body};
      };
      if(o.signedIn !== false){
        w.localStorage.setItem('poollog:sbSession', JSON.stringify({access_token: 'tok', refresh_token: 'r'}));
      }
      Object.entries(localStorageSeed || {}).forEach(([k, v]) => w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)));
    }
  });
  const w = dom.window;
  // Answer any sync question the way the test says
  w.__answer = o.answer || null;
  const iv = setInterval(()=>{
    const ov = w.document.querySelector('.confirm-overlay');
    if(ov){
      dialogs.push(ov.textContent);
      const btn = ov.querySelector(w.__answer === 'ok' ? '#confirmOk' : '#confirmCancel');
      if(btn) btn.click();
    }
  }, 5);
  await sleep(400);
  await idle(w);
  return {w, dialogs, close(){ clearInterval(iv); w.close(); }};
}

async function idle(w){
  for(let i = 0; i < 400; i++){
    await sleep(10);
    if(!w.eval('syncRunning')) { await sleep(20); if(!w.eval('syncRunning')) return; }
  }
  throw new Error('sync never finished');
}
async function sync(w){ const r = await w.eval('syncCustomers()'); await idle(w); return r; }
const local = w => JSON.parse(w.localStorage.getItem('poollog:customers') || '[]');
const cust = (id, name, extra) => Object.assign({id, name, active: true, gateCode: '1111'}, extra || {});
const syncKeys = w => { const k = []; for(let i=0;i<w.localStorage.length;i++){ const x = w.localStorage.key(i); if(x.startsWith('poollogsync:')) k.push(x); } return k; };

(async ()=>{
  try{
    console.log('\n=== A brand-new device with an empty app only pulls ===');
    {
      const srv = makeServer();
      for(let i = 1; i <= 10; i++) srv.put('s' + i, cust('s' + i, 'Server ' + i));
      const d = await boot(srv, {'poollog:customers': []});
      check('the ten server customers arrive', local(d.w).length === 10, local(d.w).length);
      check('nothing at all is pushed', srv.rpcCount === 0, srv.rpcCount);
      check('the server still has all ten, none deleted',
            srv.rows.size === 10 && Array.from(srv.rows.values()).every(r => !r.deleted));
      check('the list on screen is replaced too', d.w.eval('customers.length') === 10);
      const r2 = await sync(d.w);
      check('a second sync is quiet', r2.ok && r2.pushed === 0 && srv.rpcCount === 0, JSON.stringify(r2));
      check('status says synced', /Synced/.test(d.w.document.getElementById('syncStatus').textContent),
            d.w.document.getElementById('syncStatus').textContent);
      d.close();
    }

    console.log('\n=== A never-synced device whose pull fails pushes nothing ===');
    {
      const srv = makeServer();
      const realHandle = srv.handle;
      srv.handle = (url, o) => (url.includes('/rest/v1/customers') ? [500, {message: 'boom'}] : realHandle(url, o));
      const d = await boot(srv, {'poollog:customers': [cust('n1', 'N1'), cust('n2', 'N2')]});
      check('no push happens without a completed pull', srv.rpcCount === 0, srv.rpcCount);
      check('the device keeps its customers', local(d.w).length === 2);
      check('the status says it could not reach the server', /could not reach/.test(d.w.document.getElementById('syncStatus').textContent));
      srv.handle = realHandle;
      await sync(d.w);
      check('once a pull succeeds, they go up', srv.rows.size === 2, srv.rows.size);
      d.close();
    }

    console.log('\n=== Reinstall: storage wiped, server untouched ===');
    {
      const srv = makeServer();
      for(let i = 1; i <= 8; i++) srv.put('s' + i, cust('s' + i, 'Server ' + i));
      // A device that had synced before, then lost everything including sync state
      const d = await boot(srv, {});
      check('no question is asked', d.dialogs.length === 0, d.dialogs.join(' | '));
      check('no deletes reach the server', Array.from(srv.rows.values()).every(r => !r.deleted));
      check('all eight come back', local(d.w).length === 8, local(d.w).length);
      d.close();
    }

    console.log('\n=== First sync: the device pulls BEFORE it pushes, and keeps a backup ===');
    {
      const srv = makeServer();
      srv.put('s1', cust('s1', 'Server One'));
      srv.put('shared', cust('shared', 'Shared', {gateCode: 'SERVER'}));
      const mine = [cust('m1', 'Mine One'), cust('m2', 'Mine Two'), cust('shared', 'Shared', {gateCode: 'STALE'})];
      const d = await boot(srv, {'poollog:customers': mine});
      const firstPush = srv.calls.findIndex(c => c.includes('push_customer'));
      const firstPull = srv.calls.findIndex(c => c.startsWith('GET /rest/v1/customers'));
      check('a pull happened', firstPull !== -1);
      check('the first push came after the pull', firstPush === -1 || firstPush > firstPull, srv.calls.join(', '));
      check('the device\'s own customers reach the server',
            srv.rows.has('m1') && srv.rows.has('m2'));
      check('the server copy wins for a customer it already had',
            srv.rows.get('shared').data.gateCode === 'SERVER' && local(d.w).find(c => c.id === 'shared').gateCode === 'SERVER');
      check('every device customer and the server one are here', local(d.w).length === 4, local(d.w).length);
      const backup = await d.w.eval("loadFirstSyncBackup('" + COMPANY + "')");
      check('a pre-sync backup exists', !!backup && !!backup.data);
      const bc = backup ? JSON.parse(backup.data.customers) : [];
      check('it holds the device copy from before sync, stale gate code and all',
            bc.length === 3 && bc.find(c => c.id === 'shared').gateCode === 'STALE');
      // The backup is never overwritten by later syncs
      d.w.eval("customers.push({id:'m3', name:'Mine Three'}); saveCustomers();");
      await sync(d.w);
      const again = await d.w.eval("loadFirstSyncBackup('" + COMPANY + "')");
      check('the backup is untouched by later syncs', JSON.parse(again.data.customers).length === 3);
      check('the backup never includes sync state', !Object.keys(backup.data).some(k => k.startsWith('sync') || k.indexOf('poollogsync') !== -1));
      d.close();
    }

    console.log('\n=== Everyday edits and deletes through the real screens ===');
    {
      const srv = makeServer();
      const d = await boot(srv, {'poollog:customers': [cust('a', 'Alpha'), cust('b', 'Bravo')]});
      check('both reach the server', srv.rows.size === 2);
      const w = d.w;
      w.eval("customers.find(c => c.id === 'a').gateCode = '9999'; saveCustomers();");
      await sleep(2300); await idle(w);   // the save schedules its own sync
      check('an edit reaches the server without pressing anything', srv.rows.get('a').data.gateCode === '9999',
            srv.rows.get('a').data.gateCode);
      check('an ordinary edit keeps no conflict version', srv.versions.length === 0, srv.versions.length);

      w.__answer = 'ok';
      w.eval("deleteCustomer(customers.find(c => c.id === 'b'))");
      await sleep(100);
      await sleep(2300); await idle(w);
      const b = srv.rows.get('b');
      check('a deleted customer is only marked deleted on the server', b && b.deleted === true);
      check('and still has its details', b && b.data && b.data.name === 'Bravo');
      check('it is gone from this device', !local(w).some(c => c.id === 'b'));
      await sync(w);
      check('and does not come back on the next sync', !local(w).some(c => c.id === 'b'));
      d.close();
    }

    console.log('\n=== Two devices: the newer edit wins and the loser is kept ===');
    {
      const srv = makeServer();
      const A = await boot(srv, {'poollog:customers': [cust('c', 'Charlie', {gateCode: 'ORIG'})]});
      const B = await boot(srv, {'poollog:customers': []});
      check('device B has Charlie', local(B.w).some(c => c.id === 'c'));

      // A edits first, B edits later, both offline, then both sync
      srv.offline = true;
      A.w.eval("customers[0].gateCode = 'FROM-A'; saveCustomers();");
      await sleep(30);
      B.w.eval("customers[0].gateCode = 'FROM-B'; saveCustomers();");
      await sleep(2300); await idle(A.w); await idle(B.w);
      check('offline edits wait on the device', srv.rows.get('c').data.gateCode === 'ORIG');
      check('the status says so', /Offline/.test(A.w.document.getElementById('syncStatus').textContent),
            A.w.document.getElementById('syncStatus').textContent);
      srv.offline = false;
      await sync(B.w);   // the newer edit arrives first
      await sync(A.w);   // then the older one
      check('the newer edit is on the server', srv.rows.get('c').data.gateCode === 'FROM-B', srv.rows.get('c').data.gateCode);
      check('the older device takes the newer edit', local(A.w)[0].gateCode === 'FROM-B', local(A.w)[0].gateCode);
      check('the losing edit is kept on the server',
            srv.versions.some(v => v.id === 'c' && v.data.gateCode === 'FROM-A'), JSON.stringify(srv.versions));

      // Now the other order: older arrives first, newer overwrites it
      srv.offline = true;
      A.w.eval("customers[0].gateCode = 'A2'; saveCustomers();");
      await sleep(30);
      B.w.eval("customers[0].gateCode = 'B2'; saveCustomers();");
      await sleep(2300); await idle(A.w); await idle(B.w);
      srv.offline = false;
      await sync(A.w);
      check('the first to arrive is saved', srv.rows.get('c').data.gateCode === 'A2');
      await sync(B.w);
      check('a newer edit arriving later replaces it', srv.rows.get('c').data.gateCode === 'B2');
      check('and the replaced one is kept',
            srv.versions.some(v => v.id === 'c' && v.data.gateCode === 'A2'), JSON.stringify(srv.versions));
      await sync(A.w);
      check('device A catches up', local(A.w)[0].gateCode === 'B2', local(A.w)[0].gateCode);

      // A newer edit elsewhere beats an older delete
      srv.offline = true;
      A.w.__answer = 'ok';
      A.w.eval("deleteCustomer(customers[0])");
      await sleep(60);
      B.w.eval("customers[0].gateCode = 'KEEP-ME'; saveCustomers();");
      await sleep(2300); await idle(A.w); await idle(B.w);
      srv.offline = false;
      await sync(B.w);
      await sync(A.w);
      check('an older delete does not beat a newer edit', srv.rows.get('c').deleted === false && srv.rows.get('c').data.gateCode === 'KEEP-ME');
      check('the customer comes back on the deleting device', local(A.w).some(c => c.id === 'c' && c.gateCode === 'KEEP-ME'));
      A.close(); B.close();
    }

    console.log('\n=== A dropped signal mid-sync resumes cleanly ===');
    {
      const srv = makeServer();
      const list = [];
      for(let i = 1; i <= 6; i++) list.push(cust('p' + i, 'P' + i));
      srv.failRpcAfter = 2;
      const d = await boot(srv, {'poollog:customers': list});
      check('the first two are saved', srv.rows.size === 2, srv.rows.size);
      check('the rest are still waiting', /4 changes still waiting/.test(d.w.document.getElementById('syncStatus').textContent),
            d.w.document.getElementById('syncStatus').textContent);
      srv.failRpcAfter = null;
      await sync(d.w);
      check('the next sync sends the rest', srv.rows.size === 6, srv.rows.size);
      check('with nothing duplicated or conflicted', srv.versions.length === 0, srv.versions.length);
      check('every record intact', Array.from(srv.rows.values()).every(r => /^P\d$/.test(r.data.name)));
      d.close();
    }

    console.log('\n=== Many customers vanishing here stops and asks ===');
    {
      const srv = makeServer();
      const list = [];
      for(let i = 1; i <= 9; i++) list.push(cust('v' + i, 'V' + i));
      const d = await boot(srv, {'poollog:customers': list});
      d.w.__answer = 'cancel';
      // Something empties the list — the bug case
      d.w.eval("customers = customers.slice(0, 2); saveCustomers();");
      await sleep(2300); await idle(d.w);
      check('a question was asked', d.dialogs.some(t => /7 customers are missing/.test(t)), d.dialogs.join(' | '));
      check('nothing was deleted on the server', Array.from(srv.rows.values()).every(r => !r.deleted));
      check('answering Keep brings them back here', local(d.w).length === 9, local(d.w).length);
      await sync(d.w);
      check('and they stay back', local(d.w).length === 9 && Array.from(srv.rows.values()).every(r => !r.deleted));

      d.w.__answer = 'ok';
      d.w.eval("customers = customers.slice(0, 2); saveCustomers();");
      await sleep(2300); await idle(d.w);
      check('answering Delete marks them deleted', Array.from(srv.rows.values()).filter(r => r.deleted).length === 7);
      check('with their details kept', Array.from(srv.rows.values()).filter(r => r.deleted).every(r => r.data && r.data.name));
      d.close();
    }

    console.log('\n=== Five or fewer deletes go through without a question ===');
    {
      const srv = makeServer();
      const list = [];
      for(let i = 1; i <= 7; i++) list.push(cust('f' + i, 'F' + i));
      const d = await boot(srv, {'poollog:customers': list});
      d.w.eval("customers = customers.slice(0, 2); saveCustomers();");
      await sleep(2300); await idle(d.w);
      check('no question for exactly five', d.dialogs.length === 0, d.dialogs.join(' | '));
      check('five marked deleted', Array.from(srv.rows.values()).filter(r => r.deleted).length === 5);
      d.close();
    }

    console.log('\n=== Many deletions arriving from another device stops and asks ===');
    {
      const srv = makeServer();
      for(let i = 1; i <= 8; i++) srv.put('x' + i, cust('x' + i, 'X' + i));
      const d = await boot(srv, {'poollog:customers': []});
      check('device has all eight', local(d.w).length === 8);
      for(let i = 1; i <= 7; i++){ const r = srv.rows.get('x' + i); r.deleted = true; r.updated_at = srv.tick(); r.edited_at = r.updated_at; }
      d.w.__answer = 'cancel';
      await sync(d.w);
      check('a question was asked', d.dialogs.some(t => /server says 7 customers were deleted/.test(t)), d.dialogs.join(' | '));
      check('Keep leaves them on this device', local(d.w).length === 8, local(d.w).length);
      check('and puts them back on the server', Array.from(srv.rows.values()).every(r => !r.deleted));
      for(let i = 1; i <= 7; i++){ const r = srv.rows.get('x' + i); r.deleted = true; r.updated_at = srv.tick(); r.edited_at = new Date(Date.now() + 60000).toISOString(); }
      d.w.__answer = 'ok';
      await sync(d.w);
      check('Remove takes them off this device', local(d.w).length === 1, local(d.w).length);
      d.close();
    }

    console.log('\n=== A customer name cannot inject into the question ===');
    {
      const srv = makeServer();
      for(let i = 1; i <= 7; i++) srv.put('h' + i, cust('h' + i, '<img src=x onerror=alert(1)>'));
      const d = await boot(srv, {'poollog:customers': []});
      for(let i = 1; i <= 7; i++){ const r = srv.rows.get('h' + i); r.deleted = true; r.updated_at = srv.tick(); }
      let injected = false;
      const iv2 = setInterval(()=>{ if(d.w.document.querySelector('.confirm-overlay img')) injected = true; }, 1);
      d.w.__answer = 'ok';
      await sync(d.w);
      clearInterval(iv2);
      check('the name is shown as text, not markup', !injected && d.dialogs.some(t => t.indexOf('<img') !== -1));
      d.close();
    }

    console.log('\n=== Signed out, nothing talks to the server ===');
    {
      const srv = makeServer();
      const d = await boot(srv, {'poollog:customers': [cust('z', 'Zulu')]}, {signedIn: false});
      const r = await d.w.eval('syncCustomers()');
      check('sync refuses', r.ok === false && r.reason === 'signed-out');
      check('no customer calls made', !srv.calls.some(c => c.includes('customers') || c.includes('rpc')), srv.calls.join(', '));
      d.close();
    }

    console.log('\n=== Backups and restores never carry sync state ===');
    {
      const srv = makeServer();
      const d = await boot(srv, {'poollog:customers': [cust('k', 'Kilo')]});
      check('sync state exists', syncKeys(d.w).length === 1, syncKeys(d.w).join(','));
      const b = d.w.eval('collectBackup()');
      check('a downloaded backup does not include it', !Object.keys(b.data).some(k => /sync/i.test(k) && k !== 'syncStatus'), Object.keys(b.data).join(','));
      d.close();
    }

    console.log('\n=== More than one page of customers ===');
    {
      const srv = makeServer();
      for(let i = 1; i <= 1203; i++) srv.put('bulk' + i, cust('bulk' + i, 'Bulk ' + i));
      const d = await boot(srv, {'poollog:customers': []});
      check('all 1,203 arrive across pages', local(d.w).length === 1203, local(d.w).length);
      d.close();
    }

    console.log('\n=== The Settings card is wired ===');
    {
      const srv = makeServer();
      const d = await boot(srv, {'poollog:customers': [cust('q', 'Quebec')]});
      const doc = d.w.document;
      check('Sync now button exists', !!doc.getElementById('btnSyncNow'));
      check('pre-sync backup button exists', !!doc.getElementById('btnSyncBackup'));
      srv.put('late', cust('late', 'Arrived Late'));
      doc.getElementById('btnSyncNow').click();
      await sleep(50); await idle(d.w);
      check('pressing Sync now pulls', local(d.w).some(c => c.id === 'late'));
      d.close();
    }
  }catch(e){
    check('sync suite', false, e.stack);
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
