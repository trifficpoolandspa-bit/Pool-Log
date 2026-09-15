// Water balance (LSI). The formula is published chemistry, so these checks are
// against the standard tables rather than against the implementation.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
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

const CHEM = [
  {key:'ph', label:'pH level'},
  {key:'alkalinity', label:'Total alkalinity'},
  {key:'calcium', label:'Calcium hardness'},
  {key:'cya', label:'Cyanuric acid'},
  {key:'tds', label:'TDS'},
  {key:'temp', label:'Water temperature'}
];

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html','customer-intake.html']){
    console.log('\n=== ' + file + ': water balance ===');
    const dom = boot(file);
    await new Promise(r => setTimeout(r, 1400));
    const w = dom.window;
    const lsi = (r, chem)=> w.eval('lsiFor(' + JSON.stringify(r) + ',' +
                                   JSON.stringify(chem || CHEM) + ')');
    const tf = t => w.eval('tempFactor(' + t + ')');

    try{
      // The published temperature table
      [[32,0.0],[46,0.2],[60,0.4],[76,0.6],[84,0.7],[94,0.8],[105,0.9]].forEach(([t,v])=>{
        check('  ' + t + 'F gives ' + v, Math.abs(tf(t) - v) < 0.001, String(tf(t)));
      });
      check('  it interpolates between table points', Math.abs(tf(80) - 0.65) < 0.001, String(tf(80)));
      check('  and clamps outside it', tf(10) === 0.0 && tf(130) === 0.9);

      // Known water
      let r = lsi({ph:'7.5', alkalinity:'100', calcium:'300', cya:'50', tds:'1000', temp:'80'});
      check('  balanced water reads near zero', Math.abs(r.value) < 0.15, String(r.value));
      check('  and is called balanced', r.balance === 'balanced');

      r = lsi({ph:'7.0', alkalinity:'60', calcium:'120', cya:'30', tds:'500', temp:'55'});
      check('  cold soft low-pH water is corrosive', r.balance === 'corrosive', String(r.value));

      r = lsi({ph:'8.2', alkalinity:'180', calcium:'600', cya:'40', tds:'1500', temp:'95'});
      check('  hot hard high-pH water scales', r.balance === 'scaling', String(r.value));

      // Cyanuric acid has to be taken out of alkalinity
      const hi = lsi({ph:'7.5', alkalinity:'100', calcium:'300', cya:'90', tds:'1000', temp:'80'});
      const lo = lsi({ph:'7.5', alkalinity:'100', calcium:'300', cya:'0', tds:'1000', temp:'80'});
      check('  cyanuric acid is corrected out', hi.value < lo.value,
            hi.value + ' vs ' + lo.value);

      // Salt water carries a different TDS factor
      const salt = lsi({ph:'7.5', alkalinity:'100', calcium:'300', cya:'50', tds:'5000', temp:'80'});
      check('  a salt pool uses a higher TDS factor', salt.value < lo.value);

      // It must never guess
      r = lsi({ph:'7.5', alkalinity:'100'});
      check('  it refuses to calculate when readings are missing', r.value === null);
      check('  and names what is missing',
            r.missing.indexOf('water temperature') !== -1
            && r.missing.indexOf('calcium hardness') !== -1, r.missing.join(', '));

      r = lsi({ph:'7.5', alkalinity:'20', calcium:'300', cya:'90', temp:'80'});
      check('  it catches cyanuric acid exceeding alkalinity', r.value === null);

      // Readings are user-configurable, so matching must not depend on key names
      const custom = [
        {key:'c1', label:'pH'}, {key:'c2', label:'Total Alkalinity'},
        {key:'c3', label:'Calcium Hardness'}, {key:'c4', label:'Cyanuric Acid'},
        {key:'c5', label:'Water Temperature'}
      ];
      r = lsi({c1:'7.5', c2:'100', c3:'300', c4:'50', c5:'80'}, custom);
      check('  custom reading names are matched by label',
            Math.abs(r.value - 0.05) < 0.05, String(r.value));

      // A stock PoolLog setup has neither calcium nor temperature
      const dflt = [{key:'chlorine',label:'Free chlorine'}, {key:'ph',label:'pH level'},
                    {key:'alkalinity',label:'Total alkalinity'},
                    {key:'cya',label:'Cyanuric acid'}, {key:'tds',label:'TDS'}];
      r = lsi({chlorine:'3', ph:'7.5', alkalinity:'100', cya:'50', tds:'1000'}, dflt);
      check('  a default setup says what it still needs',
            r.value === null && r.missing.length === 2, r.missing.join(', '));

      check('  wording matches the verdict',
            w.eval("lsiWording('corrosive')").indexOf('Aggressive') === 0);
    }catch(e){
      check('  water balance', false, e.message);
    }
  }

  // ---- It must stay optional ----
  console.log('\n=== Water balance is opt-in ===');
  {
    const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const today = DAYS[new Date().getDay()];
    const chem = [{key:'ph',label:'pH level'},{key:'alkalinity',label:'Total alkalinity'},
                  {key:'calcium',label:'Calcium hardness'},{key:'cya',label:'Cyanuric acid'},
                  {key:'temp',label:'Water temperature'}];

    function show(file, on, fill){
      const seed = {
        technicians: [{id:'t1', name:'Alex'}],
        customers: [{id:'a', name:'Test', day: today, active:true,
                     technicianId:'t1', hasPool:true}],
        afterPhotoDefaultFixed: true,
        settings: on === null ? {} : {showWaterBalance: on},
        chemConfig: {pool:{chemicals: chem, dosages:[]}, spa:{chemicals:[],dosages:[]},
                     fountain:{chemicals:[],dosages:[]}}
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
            Object.keys(seed).forEach(k=> w.localStorage.setItem('poollog:'+k, JSON.stringify(seed[k])));
          }
        });
        setTimeout(()=>{
          const w = dom.window, d = w.document;
          w.eval("currentUser={id:'t1',name:'Alex'}; openVisit('a');");
          setTimeout(()=>{
            Object.keys(fill).forEach(k=>{
              const el = d.getElementById('pool_chem_' + k);
              if(el){ el.value = fill[k]; el.dispatchEvent(new w.Event('input',{bubbles:true})); }
            });
            setTimeout(()=>{
              const host = d.getElementById('pool_waterBalance');
              res({hidden: !host || host.style.display === 'none',
                   text: host ? host.textContent.replace(/\s+/g,' ').trim() : ''});
            }, 250);
          }, 400);
        }, 1400);
      });
    }

    const full = {ph:'7.5', alkalinity:'100', calcium:'300', cya:'50', temp:'80'};

    for(const file of ['technician-app.html','admin-readings-app.html']){
      let r = await show(file, null, full);
      check(file + ' is hidden when the setting was never touched', r.hidden, r.text);

      r = await show(file, false, full);
      check(file + ' stays hidden when switched off', r.hidden, r.text);

      r = await show(file, true, full);
      check(file + ' appears when switched on', !r.hidden);
      check(file + ' showing the index', r.text.indexOf('0.05') !== -1, r.text);

      r = await show(file, true, {ph:'7.0', alkalinity:'60', calcium:'120', cya:'30', temp:'55'});
      check(file + ' warns on aggressive water',
            r.text.indexOf('Aggressive') !== -1, r.text);

      r = await show(file, true, {ph:'7.5', alkalinity:'100', calcium:'300', cya:'50'});
      check(file + ' names a missing reading rather than demanding it',
            r.text.indexOf('needs water temperature') !== -1, r.text);
    }

    // The setting itself
    for(const file of ['technician-app.html','admin-readings-app.html','customer-intake.html']){
      const src = fs.readFileSync(file, 'utf8');
      // Kept in the page but hidden until calcium hardness and water
      // temperature are part of the readings — restoring it is one line
      check(file + ' still has the setting', src.indexOf('id="settingWaterBalance"') !== -1);
      check(file + ' but the card is hidden',
            src.indexOf('Water balance (LSI) is hidden until calcium hardness') !== -1);
      check(file + ' and the calculator is untouched',
            src.indexOf('function calcLSI') !== -1);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
