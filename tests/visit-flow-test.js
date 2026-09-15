// End-to-end visits, not features in isolation. Walks a whole service report
// from opening a customer to submitting the last body of water, checking the
// technician is never dumped somewhere unexpected.
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
const iso = new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);

function seedFor(extra){
  return Object.assign({
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1',
                 hasPool:true, hasSpa:true}],
    afterPhotoDefaultFixed: true,
    chemConfig: {
      pool: {chemicals:[{key:'chlorine',label:'Free chlorine'}], dosages:[{key:'tabs',label:'Tabs'}]},
      spa:  {chemicals:[{key:'chlorine',label:'Free chlorine'}], dosages:[{key:'tabs',label:'Tabs'}]},
      fountain: {chemicals:[], dosages:[]}
    }
  }, extra || {});
}

function boot(file, seed){
  return new JSDOM(fs.readFileSync(file,'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/' + file,
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
      w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
      w.console.warn=()=>{}; w.console.error=()=>{};
      w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
      Object.keys(seed).forEach(k=> w.localStorage.setItem('poollog:'+k, JSON.stringify(seed[k])));
    }
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Presses Next until the visit ends, returning every place it passed through
async function walkVisit(w, d, maxPresses){
  const trail = [];
  for(let i = 0; i < (maxPresses || 10); i++){
    const btn = d.getElementById('stepBarNext');
    if(!btn || btn.disabled) break;
    btn.click();
    await wait(500);
    trail.push(w.eval('currentViewName') + '/' + w.eval('currentVisibleSection'));
    if(w.eval('currentViewName') !== 'visit') break;
  }
  return trail;
}

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){

    // ---- A whole visit, pool then spa ----
    console.log('\n=== ' + file + ': a full pool-and-spa visit ===');
    {
      const dom = boot(file, seedFor());
      await wait(1400);
      const w = dom.window, d = w.document;
      const set = (id,v)=>{ const e = d.getElementById(id); if(!e) return false;
        e.value = v; e.dispatchEvent(new w.Event('input',{bubbles:true})); return true; };
      try{
        w.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
             + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
        await wait(400);
        check('  it opens on the pool', w.eval('currentVisibleSection') === 'pool',
              String(w.eval('currentVisibleSection')));

        set('pool_chem_chlorine','3');
        set('pool_dose_tabs','2');
        const trail = await walkVisit(w, d);
        check('  submitting the pool moves on to the spa',
              trail.indexOf('visit/spa') !== -1, trail.join(' -> '));
        check('  it does not leave the visit early',
              trail.filter(t => t.indexOf('visit/') === 0).length >= 2, trail.join(' -> '));

        set('spa_chem_chlorine','4');
        set('spa_dose_tabs','1');
        const trail2 = await walkVisit(w, d);
        check('  finishing the spa returns to the route',
              trail2[trail2.length - 1] === 'home/null', trail2.join(' -> '));
        check('  and never lands on a customer form',
              trail2.every(t => t.indexOf('customers') === -1), trail2.join(' -> '));
      }catch(e){ check('  full visit', false, e.message); }
    }

    // ---- Reopened later, with the pool already sent ----
    console.log('\n=== ' + file + ': the pool was already sent this morning ===');
    {
      const dom = boot(file, seedFor({
        'readings:a': [{id:'r1', date: iso + 'T09:00:00.000Z', chlorine:'3', tabs:'2'}]
      }));
      await wait(1400);
      const w = dom.window, d = w.document;
      const set = (id,v)=>{ const e = d.getElementById(id); if(!e) return false;
        e.value = v; e.dispatchEvent(new w.Event('input',{bubbles:true})); return true; };
      try{
        w.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
             + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
        await wait(450);

        check('  the pool counts as already done',
              w.eval("pendingVisit.doneSections.pool !== undefined"),
              JSON.stringify(w.eval('JSON.stringify(pendingVisit.doneSections)')));
        check('  so it opens on the spa, not the finished pool',
              w.eval('currentVisibleSection') === 'spa',
              String(w.eval('currentVisibleSection')));

        set('spa_chem_chlorine','4');
        set('spa_dose_tabs','1');
        const trail = await walkVisit(w, d);
        check('  finishing the spa ends the visit',
              trail[trail.length - 1] === 'home/null', trail.join(' -> '));
        check('  it is NOT thrown back into the finished pool',
              trail.indexOf('visit/pool') === -1, trail.join(' -> '));
      }catch(e){ check('  reopened visit', false, e.message); }
    }
  }

  // ---- The button says what it actually does ----
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': the finish button names the next body ===');

    async function labels(bodies){
      const cust = {id:'a', name:'Alpha', day: today, active:true,
                    technicianId:'t1', hasPool:true};
      if(bodies.spa) cust.hasSpa = true;
      if(bodies.fountain) cust.fountains = [{id:'f1', name:'Front fountain'}];
      const dom = boot(file, Object.assign(seedFor(), {
        customers: [cust],
        settings: {showAfterPhotos:false, showBeforePhotos:false}
      }));
      await wait(1400);
      const w = dom.window, d = w.document;
      const set = (id,v)=>{ const e = d.getElementById(id); if(!e) return;
        e.value = v; e.dispatchEvent(new w.Event('input',{bubbles:true})); };
      w.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
           + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
      await wait(400);
      const out = {};
      set('pool_chem_chlorine','3'); set('pool_dose_tabs','2');
      await wait(150);
      out.pool = d.getElementById('btnSaveReading').textContent.trim();
      if(bodies.spa){
        d.getElementById('btnSaveReading').click(); await wait(650);
        set('spa_chem_chlorine','4'); set('spa_dose_tabs','1'); await wait(150);
        out.spa = d.getElementById('btnSaveSpaReading').textContent.trim();
        if(bodies.fountain){
          d.getElementById('btnSaveSpaReading').click(); await wait(650);
          set('fountain_chem_chlorine','2'); await wait(200);
          out.fountain = d.getElementById('btnSaveFountainReading').textContent.trim();
        }
      }
      return out;
    }

    try{
      let L = await labels({});
      check('  a pool-only customer says Submit straight away',
            L.pool === 'Submit service report', L.pool);

      L = await labels({spa: true});
      check('  with a spa to come, the pool says Continue',
            /^Continue to Spa/.test(L.pool), L.pool);
      check('  and the spa says Submit',
            L.spa === 'Submit service report', L.spa);

      L = await labels({spa: true, fountain: true});
      check('  with a fountain to come, the spa names it',
            /^Continue to Front fountain/.test(L.spa), L.spa);
      check('  the body of water name is capitalised',
            /^Continue to [A-Z]/.test(L.pool), L.pool);
      check('  and the last fountain says Submit',
            L.fountain === 'Submit service report', L.fountain);
    }catch(e){ check('  finish button labels', false, e.message); }
  }

  // ---- Skipping a body of water ----
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': a body of water can be skipped ===');
    const dom = boot(file, Object.assign(seedFor(), {
      customers: [{id:'a', name:'Alpha', email:'c@x.com', day: today, active:true,
                   technicianId:'t1', hasPool:true, hasSpa:true}]
    }));
    await wait(1400);
    const w = dom.window, d = w.document;
    const set = (id,v)=>{ const e = d.getElementById(id); if(!e) return;
      e.value = v; e.dispatchEvent(new w.Event('input',{bubbles:true})); };
    try{
      w.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
           + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
      await wait(400);

      const row = d.getElementById('poolSkipRow');
      const checks = d.getElementById('poolServiceChecks');
      check('  there is a skip button on the readings step', !!row);
      check('  above the backwash and salt cell checks',
            !!row && !!checks && !!(row.compareDocumentPosition(checks) & 4));
      check('  and one for every body of water',
            !!d.getElementById('btnSpaSkip') && !!d.getElementById('btnFountainSkip'));

      set('pool_chem_chlorine','3.2');
      set('pool_dose_tabs','2');
      d.getElementById('btnSaveReading').click();
      await wait(700);
      check('  the pool was done normally', w.eval('currentVisibleSection') === 'spa');

      d.getElementById('btnSpaSkip').click();
      await wait(900);

      check('  the pool still reaches history',
            JSON.parse(w.eval("JSON.stringify(lsGet('readings:a') || [])")).length === 1);
      check('  the skipped spa records nothing',
            JSON.parse(w.eval("JSON.stringify(lsGet('spaReadings:a') || [])")).length === 0);
      const html = w.eval('currentReportHtml') || '';
      check('  the report covers the pool', html.indexOf('3.2') !== -1);
      check('  and does not mention the spa', html.indexOf('Spa') === -1);
      check('  the visit finishes rather than stalling',
            w.eval('currentViewName') === 'home', String(w.eval('currentViewName')));
    }catch(e){ check('  skipping a body of water', false, e.message); }
  }

  // ---- The selected body of water slides into view ----
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': the selected tab scrolls to the left ===');
    const src = fs.readFileSync(file, 'utf8');
    check('  there is a helper for it',
          src.indexOf('function scrollSelectedSectionIntoView') !== -1);
    check('  the selected tab is marked so it can be found',
          src.indexOf("btn.dataset.selectedTab = '1';") !== -1);
    check('  it runs after the strip is drawn',
          src.indexOf('setTimeout(scrollSelectedSectionIntoView, 0);') !== -1);
    check('  and leaves a strip that already fits alone',
          src.indexOf('if(container.scrollWidth <= container.clientWidth + 1) return;') !== -1);

    // The maths, with widths faked because jsdom has no layout
    const dom = boot(file, seedFor());
    await wait(1200);
    const w = dom.window, d = w.document;
    try{
      const strip = d.getElementById('visitSectionButtons');
      const place = (scrollW, clientW, offset)=>{
        Object.defineProperty(strip, 'scrollWidth', {value: scrollW, configurable: true});
        Object.defineProperty(strip, 'clientWidth', {value: clientW, configurable: true});
        Object.defineProperty(strip, 'offsetLeft', {value: 0, configurable: true});
        strip.innerHTML = '';
        const b = d.createElement('button');
        b.dataset.selectedTab = '1';
        strip.appendChild(b);
        Object.defineProperty(b, 'offsetLeft', {value: offset, configurable: true});
        let to = null;
        strip.scrollTo = (o)=>{ to = o.left; };
        w.eval('scrollSelectedSectionIntoView();');
        return to;
      };
      check('  a strip that fits is not scrolled', place(300, 320, 0) === null);
      check('  an overflowing strip brings the tab to the left edge',
            place(900, 320, 190) === 186, String(place(900, 320, 190)));
      check('  and never scrolls to a negative position',
            place(900, 320, 0) === 0, String(place(900, 320, 0)));
    }catch(e){ check('  scroll maths', false, e.message); }
  }

  // ---- Skipping with proof required ----
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': a skip can require a photo and a note ===');

    // Not required — skips as before
    let dom = boot(file, Object.assign(seedFor(), {
      technicians: [{id:'t1', name:'Alex', requireSkipProof: false}],
      customers: [{id:'a', name:'Alpha', email:'c@x.com', day: today, active:true,
                   technicianId:'t1', hasPool:true, hasSpa:true}]
    }));
    await wait(1400);
    let w = dom.window, d = w.document;
    try{
      w.eval("currentUser={id:'t1',name:'Alex',requireSkipProof:false}; "
           + "confirmDialog=()=>Promise.resolve(true); alertDialog=()=>Promise.resolve(); "
           + "renderHomeList(); openVisit('a');");
      await wait(400);
      d.getElementById('btnSpaSkip').click();
      await wait(500);
      check('  without the requirement there is no extra dialog',
            !d.querySelector('#skipProofSave'));
      check('  and the spa is skipped',
            w.eval("pendingVisit ? pendingVisit.doneSections.spa : null") === 'skipped');
    }catch(e){ check('  skip without proof', false, e.message); }

    // Required — refuses until both are supplied
    dom = boot(file, Object.assign(seedFor(), {
      technicians: [{id:'t1', name:'Alex', requireSkipProof: true}],
      customers: [{id:'a', name:'Alpha', email:'c@x.com', day: today, active:true,
                   technicianId:'t1', hasPool:true, hasSpa:true}]
    }));
    await wait(1400);
    w = dom.window; d = w.document;
    try{
      w.eval("currentUser={id:'t1',name:'Alex',requireSkipProof:true}; "
           + "confirmDialog=()=>Promise.resolve(true); alertDialog=()=>Promise.resolve(); "
           + "renderHomeList(); openVisit('a');");
      await wait(400);
      d.getElementById('btnSpaSkip').click();
      await wait(500);
      check('  with the requirement it asks for proof', !!d.querySelector('#skipProofSave'));

      d.querySelector('#skipProofSave').click();
      await wait(200);
      check('  nothing supplied is refused',
            /photo is required/i.test(d.querySelector('#skipProofErr').textContent));
      check('  and nothing is skipped',
            w.eval("pendingVisit.doneSections.spa") === undefined);

      d.querySelector('#skipProofNote').value = 'Spa drained for repairs';
      d.querySelector('#skipProofSave').click();
      await wait(200);
      check('  a note without a photo is still refused',
            w.eval("pendingVisit.doneSections.spa") === undefined);

      // Supply the photo the way the file handler does
      w.eval("resizeImageFile = ()=> Promise.resolve('data:image/webp;base64,AAAA');");
      const fileEl = d.querySelector('#skipProofFile');
      Object.defineProperty(fileEl, 'files', {value: [{name:'x.jpg'}], configurable: true});
      fileEl.dispatchEvent(new w.Event('change', {bubbles:true}));
      await wait(300);

      // The photo behaves like every other photo in the app
      check('  the photo can be opened full size', !!d.querySelector('#skipProofImg'));
      check('  and removed again', !!d.querySelector('#skipProofRemove'));
      d.querySelector('#skipProofRemove').click();
      await wait(200);
      check('  removing hides the preview',
            d.querySelector('#skipProofPreview').style.display === 'none');
      d.querySelector('#skipProofSave').click();
      await wait(200);
      check('  and the skip is refused again',
            w.eval("pendingVisit.doneSections.spa") === undefined);

      // Put it back, then finish
      fileEl.dispatchEvent(new w.Event('change', {bubbles:true}));
      await wait(300);
      d.querySelector('#skipProofSave').click();
      await wait(600);

      check('  with both, the dialog closes', !d.querySelector('#skipProofSave'));
      check('  and the spa is skipped',
            w.eval("pendingVisit ? pendingVisit.doneSections.spa : null") === 'skipped');

      const saved = JSON.parse(w.eval("JSON.stringify(lsGet('skipProof:a') || [])"));
      check('  the reason is recorded', saved.length === 1, String(saved.length));
      if(saved.length){
        check('  with the note', saved[0].note === 'Spa drained for repairs');
        check('  the photo', !!saved[0].photo);
        check('  and who skipped it', saved[0].technician === 'Alex');
      }
    }catch(e){ check('  skip with proof', false, e.message); }
  }

  // The setting is offered in both editors
  {
    const site = fs.readFileSync('customer-intake.html', 'utf8');
    check('the website offers the setting', site.indexOf("'requireSkipProof'") !== -1);
    const admin = fs.readFileSync('admin-readings-app.html', 'utf8');
    check('the admin app offers it too', admin.indexOf('tcRequireSkipProof') !== -1);
    check('the admin app loads the saved value',
          admin.indexOf("document.getElementById('tcRequireSkipProof').checked = t.requireSkipProof === true;") !== -1);
    check('and saves it',
          admin.indexOf("t.requireSkipProof = document.getElementById('tcRequireSkipProof').checked;") !== -1);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
