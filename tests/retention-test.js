// Photo retention runs against a real IndexedDB, in its own process.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

const now = Date.now();
const yearsAgo = y => new Date(now - y*365*86400000).toISOString();

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': photos over three years are removed ===');
    const seed = {
      customers: [{id:'a', name:'Alpha', active:true, hasPool:true}],
      'readings:a': [
        {id:'r1', date: yearsAgo(0.1), chlorine:'3', photo:'idb:recent1'},
        {id:'r2', date: yearsAgo(2.95), chlorine:'3', photo:'idb:soon1'},
        {id:'r3', date: yearsAgo(4), chlorine:'3', photo:'idb:old1', gatePhoto:'idb:old2',
         customPhotos:{x:'idb:old3'}}
      ]
    };
    const dom = new JSDOM(fs.readFileSync(file,'utf8'), {
      runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
      beforeParse(w){
        w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
        w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
        w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
        w.console.warn=()=>{};
        w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
        Object.keys(seed).forEach(k=> w.localStorage.setItem('poollog:'+k, JSON.stringify(seed[k])));
      }
    });
    await new Promise(r => setTimeout(r, 1500));
    const w = dom.window;

    try{
      // Put real images behind the references
      for(const id of ['recent1','soon1','old1','old2','old3']){
        await w.eval("savePhotoData('" + id + "', 'data:image/webp;base64,AAAA')");
      }

      const removed = await w.eval("removeExpiredPhotos()");
      check('  it removes the expired ones', removed === 3, removed + ' removed');

      const after = JSON.parse(w.localStorage.getItem('poollog:readings:a'));
      const byId = {}; after.forEach(r => byId[r.id] = r);

      check('  a recent photo is untouched', byId.r1.photo === 'idb:recent1');
      check('  one just short of three years is kept', byId.r2.photo === 'idb:soon1');
      check('  a four-year-old photo is gone', byId.r3.photo === null);
      check('  its gate photo too', byId.r3.gatePhoto === null);
      check('  its custom photos too', byId.r3.customPhotos.x === null);

      check('  the readings themselves survive',
            after.length === 3 && after.every(r => r.chlorine === '3'));

      const gone = await w.eval("loadPhotoData('old1')");
      check('  the image is deleted from the database, not just unlinked', gone === null, String(gone));
      const kept = await w.eval("loadPhotoData('recent1')");
      check('  recent images stay in the database', kept !== null);

      check('  the run is recorded', !!w.eval("lsGet('lastPhotoCleanup')"));
    }catch(e){
      check('  photo retention', false, e.message);
    }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
