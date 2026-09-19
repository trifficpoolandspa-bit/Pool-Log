// Dosages scaled by pool volume. The risk here is a pool with no volume on file
// being treated as zero, so that case is checked hardest.
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

const DOSES = [{key:'tabs', label:'Chlorine tabs', unit:'count'},
               {key:'acid', label:'Acid', unit:'gal'},
               {key:'soda', label:'Soda ash', unit:'lbs'}];

function chemFor(scale){
  return [
    {key:'chlorine', label:'Free chlorine',
     doseRules:[{op:'eq', value:'1', amount:'2', doseKey:'tabs', scaleByVolume:scale}]},
    {key:'ph', label:'pH level',
     doseRules:[{op:'gt', value:'7.6', amount:'0.25', doseKey:'acid', scaleByVolume:scale}]},
    {key:'alkalinity', label:'Total alkalinity',
     doseRules:[{op:'lt', value:'80', amount:'4', doseKey:'soda', scaleByVolume:scale}]}
  ];
}

function doses(file, gallons, scale){
  const cust = {id:'a', name:'Test Pool', day: today, active:true,
                technicianId:'t1', hasPool:true};
  if(gallons !== null) cust.poolGallons = gallons;
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [cust],
    afterPhotoDefaultFixed: true,
    chemConfig: {pool:{chemicals: chemFor(scale), dosages: DOSES},
                 spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  };
  return new Promise(res=>{
    const dom = new JSDOM(fs.readFileSync(file,'utf8'), {
      runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
      beforeParse(w){
        w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
        w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
        w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
        w.console.warn=()=>{}; w.console.error=()=>{};
        w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
        Object.keys(seed).forEach(k=> w.localStorage.setItem('weir:'+k, JSON.stringify(seed[k])));
      }
    });
    setTimeout(()=>{
      const w = dom.window, d = w.document;
      w.eval("currentUser={id:'t1',name:'Alex'}; openVisit('a');");
      setTimeout(()=>{
        [['chlorine','1'],['ph','8.0'],['alkalinity','60']].forEach(([k,v])=>{
          const el = d.getElementById('pool_chem_' + k);
          if(el){ el.value = v; el.dispatchEvent(new w.Event('input',{bubbles:true})); }
        });
        setTimeout(()=>{
          res({tabs: (d.getElementById('pool_dose_tabs')||{}).value,
               acid: (d.getElementById('pool_dose_acid')||{}).value,
               soda: (d.getElementById('pool_dose_soda')||{}).value});
        }, 300);
      }, 400);
    }, 1400);
  });
}

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': dosages scaled by pool size ===');
    try{
      let r = await doses(file, 10000, true);
      check('  at the reference volume the amount is unchanged',
            r.tabs === '2' && r.acid === '0.25' && r.soda === '4', JSON.stringify(r));

      r = await doses(file, 20000, true);
      check('  double the pool doubles every dose',
            r.tabs === '4' && r.acid === '0.5' && r.soda === '8', JSON.stringify(r));

      r = await doses(file, 30000, true);
      check('  three times the pool triples them',
            r.tabs === '6' && r.acid === '0.75' && r.soda === '12', JSON.stringify(r));

      r = await doses(file, 8000, true);
      check('  a smaller pool gets less', r.soda === '3.2', JSON.stringify(r));
      check('  tabs are always whole, since nobody breaks one in half',
            r.tabs === '2', r.tabs);
      check('  liquids and powders keep their precision',
            r.acid === '0.2' && r.soda === '3.2', JSON.stringify(r));

      // The dangerous case
      r = await doses(file, null, true);
      check('  a pool with no volume is NOT treated as zero',
            r.tabs === '2' && r.acid === '0.25' && r.soda === '4', JSON.stringify(r));

      // Scaling off must change nothing
      r = await doses(file, 30000, false);
      check('  with scaling off the amount is used as written',
            r.tabs === '2' && r.acid === '0.25' && r.soda === '4', JSON.stringify(r));
    }catch(e){
      check('  dose scaling', false, e.message);
    }
  }

  console.log('\n=== the per-rule setting ===');
  {
    const dom = new JSDOM(fs.readFileSync('customer-intake.html','utf8'), {
      runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
      beforeParse(w){
        w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
        w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
        w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
        w.console.warn=()=>{}; w.console.error=()=>{};
        w.Element.prototype.scrollIntoView = function(){};
        w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
        w.localStorage.setItem('weir:customers','[]');
        w.localStorage.setItem('weir:chemConfig', JSON.stringify({
          pool:{chemicals: chemFor(false), dosages: DOSES},
          spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}));
      }
    });
    await new Promise(r => setTimeout(r, 1400));
    const w = dom.window, d = w.document;
    try{
      w.eval("switchView('chemconfig');");
      w.eval("openDoseRulesModal(chemConfig.pool.chemicals[0]);");
      await new Promise(r => setTimeout(r, 200));
      const ov = d.querySelector('.confirm-overlay');
      const boxes = Array.from(ov.querySelectorAll('input[type=checkbox]'));
      check('  each rule has a scaling tick', boxes.length >= 1, boxes.length + ' found');
      check('  it is off by default', boxes[boxes.length - 1].checked === false);

      boxes[boxes.length - 1].checked = true;
      boxes[boxes.length - 1].dispatchEvent(new w.Event('change', {bubbles:true}));
      await new Promise(r => setTimeout(r, 200));
      check('  ticking it saves against that rule',
            w.eval("chemConfig.pool.chemicals[0].doseRules[0].scaleByVolume") === true);
      check('  and the wording says what it means',
            ov.textContent.indexOf('per 10k gal') !== -1, ov.textContent.slice(0, 80));
    }catch(e){ check('  rule scaling setting', false, e.message); }
  }

  console.log('\n=== Tabs are never a fraction ===');
  {
    const file = 'technician-app.html';
    // 3 per 10,000 on a 15,000 gallon pool is the case that used to give 4.5
    const seed = (gallons, base)=>({
      technicians: [{id:'t1', name:'Alex'}],
      customers: [{id:'a', name:'T', day: today, active:true, technicianId:'t1',
                   hasPool:true, poolGallons: gallons}],
      afterPhotoDefaultFixed: true,
      chemConfig: {pool:{
        chemicals:[{key:'chlorine', label:'Free chlorine',
          doseRules:[{op:'eq', value:'1', amount:String(base), doseKey:'tabs',
                      scaleByVolume:true}]}],
        dosages: DOSES}, spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
    });

    function tabsFor(gallons, base){
      return new Promise(res=>{
        const s = seed(gallons, base);
        const dom = new JSDOM(fs.readFileSync(file,'utf8'), {
          runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
          beforeParse(w){
            w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
            w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
            w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
            w.console.warn=()=>{}; w.console.error=()=>{};
            w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
            Object.keys(s).forEach(k=> w.localStorage.setItem('weir:'+k, JSON.stringify(s[k])));
          }
        });
        setTimeout(()=>{
          const w = dom.window, d = w.document;
          w.eval("currentUser={id:'t1',name:'Alex'}; openVisit('a');");
          setTimeout(()=>{
            const el = d.getElementById('pool_chem_chlorine');
            el.value = '1'; el.dispatchEvent(new w.Event('input',{bubbles:true}));
            setTimeout(()=> res((d.getElementById('pool_dose_tabs')||{}).value), 250);
          }, 400);
        }, 1400);
      });
    }

    const cases = [[5000,2],[8000,2],[12000,2],[15000,2],[18000,2],
                   [15000,3],[25000,3],[7500,1]];
    let allWhole = true;
    for(const [g, b] of cases){
      const v = await tabsFor(g, b);
      if(!/^\d+$/.test(String(v))){ allWhole = false; check('  ' + g + ' gal at ' + b + '/10k', false, v); }
    }
    check('  every pool size gives a whole number of tabs', allWhole);

    check('  a half-tab rule is rounded up', await tabsFor(15000, 3) === '5');
    check('  a tiny pool still gets one tab, not zero', await tabsFor(2000, 2) === '1');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
