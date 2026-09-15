// A service report is one package covering every body of water. Nothing reaches
// the customer's history until the final submit — and nothing is lost if the
// app dies halfway through.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const today = DAYS[new Date().getDay()];

function seedFor(extra){
  return Object.assign({
    technicians: [{id:'t1', name:'Alex'}],
    customers: [
      {id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1', hasPool:true, hasSpa:true},
      {id:'b', name:'Bravo Two', day: today, active:true, technicianId:'t1', hasPool:true}
    ],
    afterPhotoDefaultFixed: true,
    chemConfig: {
      pool: {chemicals:[{key:'chlorine',label:'Free chlorine'}], dosages:[{key:'tabs',label:'Tabs'}]},
      spa:  {chemicals:[{key:'chlorine',label:'Free chlorine'}], dosages:[{key:'tabs',label:'Tabs'}]},
      fountain: {chemicals:[], dosages:[]}
    }
  }, extra || {});
}

function boot(file, seed, keepStorage){
  return new JSDOM(fs.readFileSync(file,'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/' + file,
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
      w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
      w.console.warn=()=>{}; w.console.error=()=>{};
      w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
      Object.keys(seed).forEach(k=> w.localStorage.setItem('poollog:'+k, JSON.stringify(seed[k])));
      if(keepStorage) Object.keys(keepStorage).forEach(k=>
        w.localStorage.setItem(k, keepStorage[k]));
    }
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': one report, not one per body ===');
    const dom = boot(file, seedFor());
    await wait(1400);
    const w = dom.window, d = w.document;
    const set = (id,v)=>{ const e = d.getElementById(id); if(!e) return false;
      e.value = v; e.dispatchEvent(new w.Event('input',{bubbles:true})); return true; };

    try{
      w.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
           + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
      await wait(400);

      // Submit the pool
      set('pool_chem_chlorine','3');
      set('pool_dose_tabs','2');
      d.getElementById('btnSaveReading').click();
      await wait(600);

      const stored = JSON.parse(w.eval("JSON.stringify(lsGet('readings:a') || [])"));
      check('  submitting the pool writes NOTHING to history',
            stored.length === 0, stored.length + ' readings found');

      const held = JSON.parse(w.eval("JSON.stringify(loadVisitPackage('a') || {})"));
      check('  it is held in the package instead',
            held.sections && held.sections.pool, JSON.stringify(Object.keys(held.sections || {})));
      check('  and the customer is not marked serviced',
            w.eval("(customers.find(c=>c.id==='a')||{}).lastServicedDate") !== w.eval('todayDateStr()'));

      // Now the spa — the last body
      set('spa_chem_chlorine','4');
      set('spa_dose_tabs','1');
      d.getElementById('btnSaveSpaReading').click();
      await wait(900);

      const pool = JSON.parse(w.eval("JSON.stringify(lsGet('readings:a') || [])"));
      const spa = JSON.parse(w.eval("JSON.stringify(lsGet('spaReadings:a') || [])"));
      check('  the final submit writes the pool', pool.length === 1, String(pool.length));
      check('  and the spa, together', spa.length === 1, String(spa.length));
      check('  the package is cleared afterwards',
            w.eval("loadVisitPackage('a') === null"));
      check('  and the customer counts as serviced',
            w.eval("(customers.find(c=>c.id==='a')||{}).lastServicedDate") === w.eval('todayDateStr()'));
    }catch(e){ check('  package flow', false, e.message); }

    // ---- Abandoning leaves nothing behind ----
    console.log('\n=== ' + file + ': an abandoned visit writes nothing ===');
    {
      const dom2 = boot(file, seedFor());
      await wait(1400);
      const w2 = dom2.window, d2 = w2.document;
      const set2 = (id,v)=>{ const e = d2.getElementById(id); if(!e) return false;
        e.value = v; e.dispatchEvent(new w2.Event('input',{bubbles:true})); return true; };
      try{
        w2.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
              + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
        await wait(400);
        set2('pool_chem_chlorine','3');
        set2('pool_dose_tabs','2');
        d2.getElementById('btnSaveReading').click();
        await wait(600);

        check('  nothing in history while only the pool is done',
              JSON.parse(w2.eval("JSON.stringify(lsGet('readings:a') || [])")).length === 0);

        w2.eval("discardVisitInProgress();");
        await wait(200);
        check('  cancelling clears what was held',
              w2.eval("loadVisitPackage('a') === null"));
        check('  and still nothing reached history',
              JSON.parse(w2.eval("JSON.stringify(lsGet('readings:a') || [])")).length === 0);
      }catch(e){ check('  abandoned visit', false, e.message); }
    }

    // ---- Surviving a crash ----
    console.log('\n=== ' + file + ': an interrupted visit is not lost ===');
    {
      const dom3 = boot(file, seedFor());
      await wait(1400);
      const w3 = dom3.window, d3 = w3.document;
      const set3 = (id,v)=>{ const e = d3.getElementById(id); if(!e) return false;
        e.value = v; e.dispatchEvent(new w3.Event('input',{bubbles:true})); return true; };
      let carried = null;
      try{
        w3.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
              + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
        await wait(400);
        set3('pool_chem_chlorine','3');
        set3('pool_dose_tabs','2');
        d3.getElementById('btnSaveReading').click();
        await wait(600);
        // Everything the browser would still have after a crash
        carried = {};
        for(let i = 0; i < w3.localStorage.length; i++){
          const k = w3.localStorage.key(i);
          carried[k] = w3.localStorage.getItem(k);
        }
      }catch(e){ check('  interrupted visit setup', false, e.message); }

      if(carried){
        const dom4 = boot(file, {}, carried);
        await wait(1400);
        const w4 = dom4.window;
        try{
          w4.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
                + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
          await wait(450);
          check('  the held pool survives a restart',
                w4.eval("loadVisitPackage('a') !== null"));
          check('  and counts as already filled in',
                w4.eval("pendingVisit.doneSections.pool !== undefined"),
                w4.eval("JSON.stringify(pendingVisit.doneSections)"));
          check('  so the visit resumes on the spa',
                w4.eval("currentVisibleSection") === 'spa',
                String(w4.eval('currentVisibleSection')));
        }catch(e){ check('  interrupted visit resume', false, e.message); }
      }
    }

    // ---- Switching customers warns first ----
    console.log('\n=== ' + file + ': switching customers warns first ===');
    {
      const dom5 = boot(file, seedFor());
      await wait(1400);
      const w5 = dom5.window, d5 = w5.document;
      const set5 = (id,v)=>{ const e = d5.getElementById(id); if(!e) return false;
        e.value = v; e.dispatchEvent(new w5.Event('input',{bubbles:true})); return true; };
      try{
        w5.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
              + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
        await wait(400);
        set5('pool_chem_chlorine','3');
        set5('pool_dose_tabs','2');
        d5.getElementById('btnSaveReading').click();
        await wait(600);

        // Decline the warning
        w5.eval("window.__asked = null; confirmDialog = (m)=>{ window.__asked = m; return Promise.resolve(false); };");
        w5.eval("openVisit('b');");
        await wait(400);
        const asked = w5.eval('window.__asked');
        check('  it warns before starting another customer',
              !!asked && /part-finished|throw that away/i.test(asked), String(asked).slice(0, 70));
        check('  declining keeps the first report',
              w5.eval("loadVisitPackage('a') !== null"));

        // Accept it
        w5.eval("confirmDialog = ()=> Promise.resolve(true);");
        w5.eval("openVisit('b');");
        await wait(450);
        check('  accepting throws the first one away',
              w5.eval("loadVisitPackage('a') === null"));
        check('  and nothing of it reached history',
              JSON.parse(w5.eval("JSON.stringify(lsGet('readings:a') || [])")).length === 0);
      }catch(e){ check('  switching customers', false, e.message); }
    }

    // ---- A redo starts from scratch ----
    console.log('\n=== ' + file + ': a redo does not inherit ticks ===');
    {
      const dom6 = boot(file, seedFor());
      await wait(1400);
      const w6 = dom6.window, d6 = w6.document;
      const set6 = (id,v)=>{ const e = d6.getElementById(id); if(!e) return false;
        e.value = v; e.dispatchEvent(new w6.Event('input',{bubbles:true})); return true; };
      try{
        w6.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
              + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
        await wait(400);
        set6('pool_chem_chlorine','3'); set6('pool_dose_tabs','2');
        d6.getElementById('btnSaveReading').click(); await wait(600);
        set6('spa_chem_chlorine','4'); set6('spa_dose_tabs','1');
        d6.getElementById('btnSaveSpaReading').click(); await wait(900);

        check('  the first report went out',
              JSON.parse(w6.eval("JSON.stringify(lsGet('readings:a') || [])")).length === 1);

        await w6.eval("reserviceCustomer(customers.find(c=>c.id==='a'))");
        await wait(400);
        check('  the customer is flagged for a redo',
              w6.eval("!!customers.find(c=>c.id==='a').pendingRedo"));

        w6.eval("pendingVisit = null; openVisit('a');");
        await wait(450);
        const ticked = JSON.parse(w6.eval("JSON.stringify(Object.keys(pendingVisit.doneSections))"));
        check('  NO body of water is pre-ticked on the redo',
              ticked.length === 0, ticked.join(','));
        check('  and it opens on the first one again',
              w6.eval('currentVisibleSection') === 'pool',
              String(w6.eval('currentVisibleSection')));
        check('  the original report is untouched',
              JSON.parse(w6.eval("JSON.stringify(lsGet('readings:a') || [])")).length === 1);
      }catch(e){ check('  redo', false, e.message); }
    }

    // ---- Cancelling leaves absolutely nothing behind ----
    console.log('\n=== ' + file + ': a cancelled visit starts over completely ===');
    {
      const dom7 = boot(file, seedFor());
      await wait(1400);
      const w7 = dom7.window, d7 = w7.document;
      const set7 = (id,v)=>{ const e = d7.getElementById(id); if(!e) return false;
        e.value = v; e.dispatchEvent(new w7.Event('input',{bubbles:true})); return true; };
      try{
        w7.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
              + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
        await wait(400);

        set7('pool_chem_chlorine','3'); set7('pool_dose_tabs','2');
        d7.getElementById('btnSaveReading').click(); await wait(700);
        check('  the pool is ticked after finishing it',
              w7.eval("pendingVisit.doneSections.pool !== undefined"));

        // Wander back to the pool, then cancel from the route button
        w7.eval("showVisitSection('pool'); goToVisitStep(1);"); await wait(250);
        const back = Array.from(d7.querySelectorAll('button'))
          .find(b => /Return to route/i.test(b.textContent));
        if(back) back.click(); else w7.eval('discardVisitInProgress();');
        await wait(800);

        check('  cancelling clears the held package',
              w7.eval("loadVisitPackage('a') === null"));
        check('  and writes nothing to history',
              JSON.parse(w7.eval("JSON.stringify(lsGet('readings:a') || [])")).length === 0);

        w7.eval("openVisit('a');");
        await wait(500);
        const ticks = JSON.parse(w7.eval("JSON.stringify(Object.keys(pendingVisit.doneSections))"));
        check('  reopening shows NO ticks at all', ticks.length === 0, ticks.join(','));
        check('  and starts on the first body again',
              w7.eval('currentVisibleSection') === 'pool',
              String(w7.eval('currentVisibleSection')));
        check('  with the fields empty',
              (d7.getElementById('pool_chem_chlorine') || {}).value === '',
              String((d7.getElementById('pool_chem_chlorine') || {}).value));
      }catch(e){ check('  cancelled visit', false, e.message); }
    }

    // ---- Going back to a finished body shows what was recorded ----
    console.log('\n=== ' + file + ': a finished body still shows its readings ===');
    {
      const PNG = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4TBYAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
      const dom8 = boot(file, seedFor());
      await wait(1400);
      const w8 = dom8.window, d8 = w8.document;
      const set8 = (id,v)=>{ const e = d8.getElementById(id); if(!e) return false;
        e.value = v; e.dispatchEvent(new w8.Event('input',{bubbles:true})); return true; };
      const get8 = id => (d8.getElementById(id) || {}).value;
      try{
        w8.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
              + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
        await wait(400);

        set8('pool_chem_chlorine','3.4');
        set8('pool_dose_tabs','2');
        w8.eval("poolPhotoController.setData('" + PNG + "');");
        await wait(150);
        d8.getElementById('btnSaveReading').click();
        await wait(800);

        check('  finishing the pool moves on to the spa',
              w8.eval('currentVisibleSection') === 'spa',
              String(w8.eval('currentVisibleSection')));

        w8.eval("showVisitSection('pool');");
        await wait(400);
        check('  going back shows the reading again', get8('pool_chem_chlorine') === '3.4',
              JSON.stringify(get8('pool_chem_chlorine')));
        check('  and the dosage', get8('pool_dose_tabs') === '2',
              JSON.stringify(get8('pool_dose_tabs')));
        check('  and the photo is still attached',
              !!w8.eval("poolPhotoController.getData()"));

        // A correction made on the way back must stick
        set8('pool_chem_chlorine','5.0');
        d8.getElementById('btnSaveReading').click();
        await wait(800);
        const pkg = JSON.parse(w8.eval("JSON.stringify(loadVisitPackage('a'))"));
        check('  a correction replaces the held reading',
              pkg.sections.pool.chlorine === '5.0',
              JSON.stringify(pkg.sections.pool.chlorine));
        check('  without adding a second pool entry',
              Object.keys(pkg.sections).length === 1,
              Object.keys(pkg.sections).join(','));
      }catch(e){ check('  revisiting a finished body', false, e.message); }
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
