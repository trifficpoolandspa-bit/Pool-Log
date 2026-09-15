// Nothing typed into a service report may be lost, except when the technician
// deliberately cancels the report. This walks every way around a visit.
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

const seed = {
  technicians: [{id:'t1', name:'Alex'}],
  customers: [{id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1',
               hasPool:true, hasSpa:true, fountains:[{id:'f1', name:'Front fountain'}]}],
  afterPhotoDefaultFixed: true,
  chemConfig: {
    pool: {chemicals:[{key:'chlorine',label:'Free chlorine'},{key:'ph',label:'pH level'}],
           dosages:[{key:'tabs',label:'Chlorine tabs'}]},
    spa:  {chemicals:[{key:'chlorine',label:'Free chlorine'}], dosages:[{key:'tabs',label:'Tabs'}]},
    fountain: {chemicals:[{key:'chlorine',label:'Free chlorine'}], dosages:[]}
  }
};

function boot(file){
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

// Types two readings, runs the given steps, then checks they survived
async function survives(file, steps, opts){
  const dom = boot(file);
  await wait(1400);
  const w = dom.window, d = w.document;
  const keepReport = !(opts && opts.confirmCancel);
  w.eval("currentUser={id:'t1',name:'Alex'}; renderHomeList();");
  w.eval("confirmDialog = (m)=> Promise.resolve(" + (keepReport
    ? "!/remove all readings|cancel the report/i.test(m||'')" : "true") + ");");
  w.eval("openVisit('a');");
  await wait(350);

  const set = (id, v)=>{ const el = d.getElementById(id); if(!el) return false;
    el.value = v; el.dispatchEvent(new w.Event('input',{bubbles:true})); return true; };
  if(!set('pool_chem_chlorine','3.7')) return {skip:true};
  set('pool_chem_ph','7.55');

  for(const s of steps){ w.eval(s); await wait(140); }
  try{ w.eval("showVisitSection('pool'); goToVisitStep(1);"); }catch(e){}
  await wait(180);

  return {chlorine: (d.getElementById('pool_chem_chlorine')||{}).value,
          ph: (d.getElementById('pool_chem_ph')||{}).value};
}

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': readings survive every route around a visit ===');

    const cases = [
      ['moving forward and back through the steps',
       ["goToVisitStep(2)","goToVisitStep(3)","goToVisitStep(1)"]],
      ['switching to the spa and back',
       ["showVisitSection('spa')","showVisitSection('pool')"]],
      ['switching to a fountain and back',
       ["showVisitSection('fountain')","showVisitSection('pool')"]],
      ['spa, fountain, then back to the pool',
       ["showVisitSection('spa')","showVisitSection('fountain')","showVisitSection('pool')"]],
      ['the equipment tab and back',
       ["showVisitSection('equipment')","showVisitSection('pool')"]],
      ['every section in turn',
       ["showVisitSection('spa')","showVisitSection('equipment')","showVisitSection('fountain')",
        "showVisitSection('spa')","showVisitSection('pool')"]],
      ['flipping sections quickly',
       ["showVisitSection('spa')","showVisitSection('pool')","showVisitSection('spa')",
        "showVisitSection('pool')"]],
      ['leaving to the route and reopening',
       ["switchView('home')","openVisit('a')"]],
      ['leaving to another tab and coming back',
       ["switchView('options')","switchView('home')","openVisit('a')"]],
      ['pressing back and declining the cancel',
       ["window.dispatchEvent(new window.PopStateEvent('popstate'))"]],
      ['a dosage typed, then sections flipped',
       ["(function(){var e=document.getElementById('pool_dose_tabs'); if(e){e.value='4';"
        + "e.dispatchEvent(new Event('input',{bubbles:true}));}})()",
        "showVisitSection('fountain')","showVisitSection('pool')"]],
      ['a step change on the fountain, then back',
       ["showVisitSection('fountain')","goToVisitStep(2)","showVisitSection('pool')"]]
    ];

    for(const [label, steps] of cases){
      const r = await survives(file, steps);
      if(r.skip){ check('  ' + label, false, 'could not set up'); continue; }
      check('  ' + label, r.chlorine === '3.7' && r.ph === '7.55',
            'chlorine=' + JSON.stringify(r.chlorine) + ' ph=' + JSON.stringify(r.ph));
    }

    // The one case where losing it IS correct
    const cancelled = await survives(file,
      ["window.dispatchEvent(new window.PopStateEvent('popstate'))"], {confirmCancel: true});
    check('  cancelling the report DOES clear it, as it should',
          cancelled.chlorine === '' && cancelled.ph === '',
          'chlorine=' + JSON.stringify(cancelled.chlorine));

    // And the cause of the original bug, guarded directly
    const src = fs.readFileSync(file, 'utf8');
    check('  the fountain rebuild holds the rest of the visit',
          src.indexOf('captureVisitDraft();\n    renderAllConfigFields();\n'
                    + '    restoreVisitDraft(currentVisitCustomerId);') !== -1);
    // Cancelling must take back anything already saved during the visit
    {
      const dom = boot(file);
      await wait(1400);
      const w = dom.window, d = w.document;
      w.eval("currentUser={id:'t1',name:'Alex'}; renderHomeList(); openVisit('a');");
      // The app ignores taps for 400ms after a view change, as a mis-tap guard
      await wait(600);
      const el = d.getElementById('pool_chem_chlorine');
      el.value = '3.4'; el.dispatchEvent(new w.Event('input',{bubbles:true}));
      d.getElementById('btnSaveReading').click();
      await wait(800);

      // A section is now HELD, not written — the whole visit is one package
      const savedCount = (await w.eval("loadReadings('a','pool')")).length;
      check('  saving a section writes nothing to history yet',
            savedCount === 0, String(savedCount));
      check('  it is held in the package instead',
            w.eval("loadVisitPackage('a') !== null"));
      check('  and cancelling knows there is something to undo',
            w.eval('visitHasAnything()') === true);

      w.eval("goToVisitStep(1); confirmDialog = ()=> Promise.resolve(true);");
      await wait(200);
      const back = Array.from(d.querySelectorAll('button'))
        .find(b => /Return to route/.test(b.textContent));
      if(back) back.click();
      await wait(700);

      const left = (await w.eval("loadReadings('a','pool')")).length;
      check('  cancelling leaves history empty', left === 0, String(left));
      check('  and throws the held package away',
            w.eval("loadVisitPackage('a') === null"));
      check('  and returns to the route', w.eval('currentViewName') === 'home');
    }

    // Declining the cancel must keep it
    {
      const dom = boot(file);
      await wait(1400);
      const w = dom.window, d = w.document;
      w.eval("currentUser={id:'t1',name:'Alex'}; renderHomeList(); openVisit('a');");
      // The app ignores taps for 400ms after a view change, as a mis-tap guard
      await wait(600);
      const el = d.getElementById('pool_chem_chlorine');
      el.value = '3.4'; el.dispatchEvent(new w.Event('input',{bubbles:true}));
      d.getElementById('btnSaveReading').click();
      await wait(800);

      w.eval("goToVisitStep(1); confirmDialog = ()=> Promise.resolve(false);");
      await wait(200);
      const back = Array.from(d.querySelectorAll('button'))
        .find(b => /Return to route/.test(b.textContent));
      if(back) back.click();
      await wait(600);

      const left = (await w.eval("loadReadings('a','pool')")).length;
      check('  declining the cancel keeps what was held',
            w.eval("loadVisitPackage('a') !== null"));
      check('  and stays on the visit', w.eval('currentViewName') === 'visit');
    }


    // ---- Going back to a finished body shows what was recorded ----
    console.log('\n=== ' + file + ': a finished body shows its readings and photos ===');
    {
      const P = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4TBYAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
      const dom = boot(file);
      await wait(1400);
      const w = dom.window, d = w.document;
      const set = (id,v)=>{ const e = d.getElementById(id); if(!e) return;
        e.value = v; e.dispatchEvent(new w.Event('input',{bubbles:true})); };
      try{
        w.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); "
             + "alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
        await wait(400);

        set('pool_chem_chlorine','3.4');
        set('pool_chem_ph','7.5');
        w.eval("poolPhotoController.setData('" + P + "');");
        w.eval("beforeControllerFor('pool').setData('" + P + "');");
        await wait(200);
        d.getElementById('btnSaveReading').click();
        await wait(800);

        w.eval("showVisitSection('pool');");
        await wait(400);

        check('  the readings come back',
              (d.getElementById('pool_chem_chlorine') || {}).value === '3.4',
              String((d.getElementById('pool_chem_chlorine') || {}).value));
        check('  all of them, not just the first',
              (d.getElementById('pool_chem_ph') || {}).value === '7.5',
              String((d.getElementById('pool_chem_ph') || {}).value));
        check('  the after photo comes back',
              !!w.eval('poolPhotoController.getData()'));
        check('  and the before photo',
              !!w.eval("beforeControllerFor('pool').getData()"));
        check('  so it can be removed if it was wrong',
              (d.getElementById('btnRemovePhoto') || {}).style.display !== 'none');
      }catch(e){ check('  revisiting a finished body', false, e.message); }
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
