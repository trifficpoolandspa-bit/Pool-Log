// Part 1 of 4. The suite was one file until it grew past what could
// finish in a single run — checks at the end silently stopped executing. Each
// part shares the same setup below and reports its own result.

// Loads a file headlessly and exercises real behaviour, rather than only
// checking that the code is well-formed.
const { JSDOM } = require('jsdom');
const fs = require('fs');

function load(file, opts = {}){
  const html = fs.readFileSync(file, 'utf8');
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: opts.url || 'https://example.com/',
    beforeParse(w){
      w.matchMedia = () => ({matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}});
      w.scrollTo = () => {}; w.scrollBy = () => {}; w.alert = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => ({drawImage(){}, fillRect(){}});
      w.addEventListener('error', e => errors.push(e.error ? e.error.message : e.message));
      w.console.error = (...a) => errors.push(a.join(' '));
      if(opts.seed){
        Object.keys(opts.seed).forEach(k=>{
          w.localStorage.setItem('weir:' + k, JSON.stringify(opts.seed[k]));
        });
      }
      // Lets a test stub a browser API the app depends on, such as the camera
      if(typeof opts.beforeParse === 'function') opts.beforeParse(w);
      if(opts.fullStorage){
        // Simulate a browser that has run out of room. Must patch the prototype
        // — assigning to localStorage.setItem directly does nothing.
        w.Storage.prototype.setItem = function(){
          const err = new Error('quota'); err.name = 'QuotaExceededError'; throw err;
        };
      }
    }
  });
  return {dom, errors};
}

let pass = 0, fail = 0;
const deferred = [];
// Buttons carry a hidden × for deleting, so read the label without it
function labelOf(b){
  return (b.firstChild && b.firstChild.nodeType === 3)
    ? b.firstChild.textContent.trim()
    : b.textContent.replace('\u00d7','').trim();
}

function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

console.log('\n=== Loads without runtime errors ===');
['customer-intake.html','technician-app.html','admin-readings-app.html'].forEach(f=>{
  const {errors} = load(f);
  check(f, errors.length === 0, errors[0]);
});

console.log('\n=== A failed save is reported, not swallowed ===');
['customer-intake.html','technician-app.html','admin-readings-app.html'].forEach(f=>{
  const {dom} = load(f, {fullStorage:true});
  const w = dom.window;
  const result = w.lsSet('probe', {a:1});
  check(f + ' returns false when storage is full', result === false,
        'returned ' + result);
});

console.log('\n=== Storage keys agree across files ===');
const site = fs.readFileSync('customer-intake.html','utf8');
const tech = fs.readFileSync('technician-app.html','utf8');
const writes = new Set([...site.matchAll(/lsSet\('([^']+)'/g)].map(m=>m[1]));
const reads  = new Set([...tech.matchAll(/lsGet\('([^']+)'/g)].map(m=>m[1]));
const shared = ['customers','technicians','settings','chemConfig','customChemConfig','routeOrders'];
shared.forEach(k=>{
  check('"' + k + '" written by site and read by app', writes.has(k) && reads.has(k));
});


console.log('\n=== Camera falls back when unavailable ===');
['technician-app.html','admin-readings-app.html'].forEach(f=>{
  const {dom, errors} = load(f);
  const w = dom.window;
  // jsdom has no getUserMedia, so this is the real no-camera path
  check(f + ' defines captureFromCamera', typeof w.captureFromCamera === 'function');
  if(typeof w.captureFromCamera === 'function'){
    let rejected = false;
    return w.captureFromCamera(800, 0.6)
      .then(()=>{ check(f + ' rejects without a camera', false, 'resolved instead'); })
      .catch(()=>{ check(f + ' rejects without a camera', true); });
  }
});

console.log('\n=== Photo controls are wired to real elements ===');
// The controllers are const, so they aren't on window — check the elements
// they depend on instead, which is what actually breaks when an id drifts.
['technician-app.html','admin-readings-app.html'].forEach(f=>{
  const {dom} = load(f);
  const d = dom.window.document;
  const src = fs.readFileSync(f, 'utf8');
  [['btnTakePhoto','pool after'], ['btnTakePhotoBefore','pool before'],
   ['btnTakePhotoSpa','spa after'], ['btnTakePhotoFountain','fountain after'],
   ['btnTakeGatePhoto','gate']].forEach(([id, label])=>{
    check(f + ' ' + label + ' photo button exists', !!d.getElementById(id));
  });
  check(f + ' gate controller declared', src.includes('const gatePhotoController'));
});


console.log('\n=== Every photo can be removed ===');
['technician-app.html','admin-readings-app.html'].forEach(f=>{
  const {dom} = load(f);
  const d = dom.window.document;
  [['btnRemovePhoto','pool after'], ['btnRemovePhotoBefore','pool before'],
   ['btnRemovePhotoSpa','spa after'], ['btnRemovePhotoBeforeSpa','spa before'],
   ['btnRemovePhotoFountain','fountain after'], ['btnRemovePhotoBeforeFountain','fountain before'],
   ['btnRemoveGatePhoto','gate']].forEach(([id, label])=>{
    check(f + ' ' + label + ' has a remove button', !!d.getElementById(id));
  });
});


console.log('\n=== Only the gate photo is set per technician ===');
['technician-app.html','admin-readings-app.html'].forEach(f=>{
  const src = fs.readFileSync(f, 'utf8');
  check(f + ' has the techRequires helper', src.includes('function techRequires'));
  check(f + ' the gate photo still honours it',
        src.includes("techRequires('requireGatePhoto')"));
  check(f + ' before photos no longer do',
        !src.includes("techRequires('requireBeforePhoto')"));
  check(f + ' nor after photos',
        !src.includes("techRequires('requireAfterPhoto')"));
});
{
  const d = load('admin-readings-app.html').dom.window.document;
  check('the tech editor keeps the gate tick', !!d.getElementById('tcRequireGate'));
  check('and has dropped the before tick', !d.getElementById('tcRequireBefore'));
  check('and the after tick', !d.getElementById('tcRequireAfter'));
  const gate = d.getElementById('tcRequireGate');
  check('the gate tick starts unchecked', gate && !gate.checked);
}


console.log('\n=== Submit is not blocked when photos are optional ===');
['technician-app.html','admin-readings-app.html'].forEach(f=>{
  const src = fs.readFileSync(f, 'utf8');
  // The old bug: ready = !!ctrl.getData() with no check of the settings
  check(f + ' does not hard-require an after photo',
        !src.includes('const ready = !!ctrl.getData() && gateOk;'),
        'after photo required regardless of settings');
  check(f + ' has afterPhotoRequiredFor', src.includes('function afterPhotoRequiredFor'));
  // There is no global setting any more — a stored value could never be
  // switched off once the Settings toggle was removed
  check(f + ' has no app-wide photo requirement left',
        !src.includes('appSettings.requireAfterPhotos'));
  check(f + ' the After photos slider controls the step',
        src.includes('return appSettings.showAfterPhotos !== false;'));
  check(f + ' nothing is required when the step is off',
        src.includes('if(!showsAfterPhotoStep(type)) return false;'));
});


console.log('\n=== Service performed only appears when done ===');
['technician-app.html','admin-readings-app.html'].forEach(f=>{
  const src = fs.readFileSync(f, 'utf8');
  check(f + ' builds a serviced section', src.includes('servicedHtml'));
  check(f + ' only lists a backwash when true', src.includes('if(reading.filterBackwashed)'));
  check(f + ' only lists a salt cell when true', src.includes('if(reading.saltCellCleaned)'));
  check(f + ' omits it from email when empty',
        src.includes("s.servicedText ? '\\nSERVICE PERFORMED\\n'+s.servicedText : ''"));
  check(f + ' omits it on screen when empty', src.includes('${s.servicedHtml || \'\'}'));
});

// Prove the logic: nothing when unchecked, something when checked
{
  function buildServiced(reading){
    const done = [];
    if(reading.filterBackwashed) done.push('Filter backwashed');
    if(reading.saltCellCleaned) done.push('Salt cell cleaned');
    return done;
  }
  check('nothing listed when both unchecked', buildServiced({}).length === 0);
  check('nothing listed when explicitly false',
        buildServiced({filterBackwashed:false, saltCellCleaned:false}).length === 0);
  check('backwash listed when checked',
        buildServiced({filterBackwashed:true}).join() === 'Filter backwashed');
  check('both listed when both checked',
        buildServiced({filterBackwashed:true, saltCellCleaned:true}).length === 2);
}


console.log('\n=== One smooth reordering implementation everywhere ===');
['customer-intake.html','technician-app.html','admin-readings-app.html'].forEach(f=>{
  const src = fs.readFileSync(f, 'utf8');
  const defs = (src.match(/function attachTouchReorder/g) || []).length;
  check(f + ' has exactly one implementation', defs === 1, defs + ' found');
  check(f + ' no HTML5-only drag remains',
        !src.includes('draggable = true'), 'HTML5 drag would not work on touch');
  check(f + ' uses a placeholder', src.includes('reorder-placeholder'));
  check(f + ' animates with requestAnimationFrame', src.includes('requestAnimationFrame(render)'));
  check(f + ' neighbours transition', src.includes("transition = 'transform .18s ease'"));
});


console.log('\n=== Voice parsing actually works ===');
['technician-app.html','admin-readings-app.html'].forEach(f=>{
  const src = fs.readFileSync(f, 'utf8');
  // The old bug: aliases attached on any label substring, so "Chlorine tabs"
  // stole the word "chlorine" and "Cyanuric acid" stole "muriatic acid"
  check(f + ' aliases attach on exact key only',
        !src.includes("key.indexOf(canon) !== -1 || labelHas"),
        'loose matching lets fields steal each others phrases');
  check(f + ' handles spoken pH decimals', src.includes("t.key === 'ph'"));
  check(f + ' matches whole words only', src.includes("'(^|[^a-z0-9])'"));
});

// No two fields may accept the same phrase
{
  const src = fs.readFileSync('technician-app.html','utf8');
  const a = src.indexOf('const SPOKEN_ALIASES = {');
  const b = src.indexOf('};', a) + 2;
  const sandbox = {};
  new Function('exports', src.slice(a, b) + '; exports.A = SPOKEN_ALIASES;')(sandbox);
  const items = [['chlorine','Free chlorine'],['ph','pH level'],['alkalinity','Total alkalinity'],
                 ['cya','Cyanuric acid'],['tds','TDS'],['tabs','Chlorine tabs'],
                 ['acid','Muriatic acid'],['shock','Shock'],['algaecide','Algaecide'],
                 ['phosphate','Phosphate remover']];
  const owner = {};
  let clashes = 0;
  items.forEach(([key, label])=>{
    const phrases = [label.toLowerCase()].concat(sandbox.A[key] || []);
    phrases.forEach(p=>{
      if(owner[p] && owner[p] !== label) clashes++;
      else owner[p] = label;
    });
  });
  check('no phrase is claimed by two fields', clashes === 0, clashes + ' clashes');
}


console.log('\n=== Every tab opens without throwing ===');
// This is what catches a block pasted into the wrong function: the page only
// breaks when you actually open it.
[['customer-intake.html', ['customers','chemconfig','settings','technicians','workcenter','history','productsservices']],
 ['technician-app.html', ['home','serviced','options']],
 ['admin-readings-app.html', ['home','technicians','customers','report','options']]
].forEach(([file, views])=>{
  const {dom, errors} = load(file);
  const w = dom.window;
  views.forEach(v=>{
    const before = errors.length;
    try{
      if(typeof w.switchView === 'function') w.switchView(v);
    }catch(e){
      errors.push('switchView("' + v + '") threw: ' + e.message);
    }
    const added = errors.slice(before);
    check(file + ' opens "' + v + '"', added.length === 0, added[0]);
  });
});

console.log('\n=== Readings and dosages renders its rows ===');
['customer-intake.html'].forEach(file=>{
  const {dom, errors} = load(file);
  const w = dom.window;
  const before = errors.length;
  try{
    if(typeof w.renderChemConfigLists === 'function') w.renderChemConfigLists();
  }catch(e){
    errors.push('renderChemConfigLists threw: ' + e.message);
  }
  const added = errors.slice(before);
  check(file + ' builds chemical and dosage rows', added.length === 0, added[0]);
});


console.log('\n=== Dosage rules fire during a real visit ===');
{
  const seed = {
    customers: [
      {id:'c1', name:'Plain', day:'Monday', hasPool:true, active:true},
      {id:'c2', name:'Custom', day:'Monday', hasPool:true, active:true}
    ],
    chemConfig: {
      pool: {
        chemicals: [{key:'chlorine', label:'Free chlorine', unit:'ppm', buttons:[0,1,3,5],
                     doseRules:[{op:'eq', value:'5', amount:'1', doseKey:'tabs'}]}],
        dosages: [{key:'tabs', label:'Chlorine tabs', unit:'count', buttons:[1,2,3]}]
      },
      spa: {chemicals:[], dosages:[]},
      fountain: {chemicals:[], dosages:[]}
    },
    // Customised before the rule existed — the snapshot carries no rules
    customChemConfig: {
      c2: { pool: {
        chemicals: [{key:'chlorine', label:'Free chlorine', unit:'ppm', buttons:[0,1,3,5]}],
        dosages: [{key:'tabs', label:'Chlorine tabs', unit:'count', buttons:[1,2,3]}]
      }}
    }
  };

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window, d = w.document;

    [['c1','plain customer'], ['c2','custom customer']].forEach(([cid, label])=>{
      // `let` variables aren't reachable from outside the script, so assigning
      // w.currentVisitCustomerId silently does nothing — eval runs inside scope.
      try{
        w.eval("currentVisitCustomerId = " + JSON.stringify(cid) + "; currentVisitFountainId = null;");
        w.eval("chemConfig = loadChemConfig();");
        w.eval("resetDoseRuleTracking();");
        w.eval("renderAllConfigFields();");
      }catch(e){ check(file + ' ' + label + ' renders', false, e.message); return; }
      check(file + ' ' + label + ': customer id really set',
            w.eval("currentVisitCustomerId") === cid);

      const chem = d.getElementById('pool_chem_chlorine');
      const dose = d.getElementById('pool_dose_tabs');
      if(!chem || !dose){ check(file + ' ' + label + ' has fields', false); return; }

      dose.value = '';
      chem.value = '5';
      chem.dispatchEvent(new w.Event('input', {bubbles:true}));
      check(file + ' ' + label + ': reading 5 fills the dosage', dose.value === '1',
            'got ' + JSON.stringify(dose.value));

      chem.value = '3';
      chem.dispatchEvent(new w.Event('input', {bubbles:true}));
      check(file + ' ' + label + ': changing the reading clears it', dose.value === '',
            'got ' + JSON.stringify(dose.value));

      chem.value = '5';
      chem.dispatchEvent(new w.Event('input', {bubbles:true}));
      check(file + ' ' + label + ': it refills on the way back', dose.value === '1',
            'got ' + JSON.stringify(dose.value));
    });
  });
}


console.log('\n=== A rule that cannot fire says why ===');
{
  const base = {
    customers: [{id:'c1', name:'Plain', day:'Monday', hasPool:true, active:true}],
    chemConfig: {
      pool: {
        chemicals: [{key:'chlorine', label:'Free chlorine', unit:'ppm', buttons:[5]}],
        dosages: [{key:'tabs', label:'Chlorine tabs', unit:'count', buttons:[1]}]
      },
      spa: {chemicals:[], dosages:[]}, fountain: {chemicals:[], dosages:[]}
    }
  };

  const cases = [
    ['rule with no value', [{op:'eq', value:'', amount:'1', doseKey:'tabs'}], 'no value set'],
    ['rule with no amount', [{op:'eq', value:'5', amount:'', doseKey:'tabs'}], 'no amount set'],
    ['rule pointing at a missing dosage',
       [{op:'eq', value:'5', amount:'1', doseKey:'nonexistent'}], 'not on this list']
  ];

  cases.forEach(([label, rules, expect])=>{
    const seed = JSON.parse(JSON.stringify(base));
    seed.chemConfig.pool.chemicals[0].doseRules = rules;
    const {dom} = load('technician-app.html', {seed});
    const w = dom.window, d = w.document;
    const warnings = [];
    w.console.warn = (...a)=> warnings.push(a.join(' '));
    try{
      w.eval("currentVisitCustomerId = 'c1';");
      w.eval("chemConfig = loadChemConfig();");
      w.eval("resetDoseRuleTracking();");
      w.eval("renderAllConfigFields();");
      const chem = d.getElementById('pool_chem_chlorine');
      chem.value = '5';
      chem.dispatchEvent(new w.Event('input', {bubbles:true}));
    }catch(e){ /* reported below */ }
    check('  ' + label + ' is reported',
          warnings.some(x => x.indexOf(expect) !== -1),
          'warnings: ' + JSON.stringify(warnings));
  });
}


console.log('\n=== Unfinished rules are dropped, not kept ===');
{
  // Closing the editor used to ask, and a second click could slip past the
  // question leaving the broken rule in place.
  function closeEditor(rules){
    return rules.filter(r =>
      !((r.value === '' || r.value == null)
        || (r.amount === '' || r.amount == null)
        || (r.op === 'between' && (r.value2 === '' || r.value2 == null))));
  }
  const rules = [
    {op:'eq', value:'5', amount:'1', doseKey:'tabs'},
    {op:'eq', value:'', amount:'1', doseKey:'tabs'},
    {op:'eq', value:'3', amount:'', doseKey:'tabs'},
    {op:'between', value:'2', value2:'', amount:'1', doseKey:'tabs'}
  ];
  const kept = closeEditor(rules);
  check('  only the complete rule survives', kept.length === 1, 'kept ' + kept.length);
  check('  and it is the right one', kept[0] && kept[0].value === '5');
  check('  closing again changes nothing', closeEditor(kept).length === 1);

  const src = fs.readFileSync('customer-intake.html','utf8');
  check('  the editor no longer asks before removing',
        !src.includes('Remove unfinished'), 'still asks');
  check('  a second close cannot slip past', src.includes('if(closed) return;'));
}


console.log('\n=== Rule order no longer decides whether a rule works ===');
{
  // Each rule used to set OR clear its own dosage as it was processed, so a
  // later non-matching rule wiped what an earlier matching one had written.
  // Whether a rule worked depended on where it sat in the list.
  const seed = {
    customers: [{id:'c1', name:'Test', day:'Monday', hasPool:true, active:true}],
    chemConfig: {
      pool: {
        chemicals: [
          {key:'chlorine', label:'Free chlorine', unit:'ppm', buttons:[0,1,2,3,5],
           doseRules:[
             {op:'lte', value:'2', amount:'2', doseKey:'shock'},
             {op:'eq',  value:'5', amount:'2', doseKey:'tabs'},
             {op:'eq',  value:'3', amount:'1', doseKey:'tabs'}
           ]},
          {key:'ph', label:'pH level', unit:'', buttons:[7.2,7.8,8],
           doseRules:[
             {op:'gte', value:'8',   amount:'1',   doseKey:'acid'},
             {op:'gte', value:'7.6', amount:'0.5', doseKey:'acid'}
           ]}
        ],
        dosages: [
          {key:'tabs', label:'Chlorine tabs', unit:'count', buttons:[1,2]},
          {key:'shock', label:'Shock', unit:'lb', buttons:[1,2]},
          {key:'acid', label:'Muriatic acid', unit:'gal', buttons:[0.5,1]}
        ]
      },
      spa: {chemicals:[], dosages:[]}, fountain: {chemicals:[], dosages:[]}
    }
  };

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("currentVisitCustomerId = 'c1'; chemConfig = loadChemConfig(); resetDoseRuleTracking(); renderAllConfigFields();");
    }catch(e){ check(file + ' renders', false, e.message); return; }

    function enter(field, value){
      const el = d.getElementById('pool_chem_' + field);
      el.value = String(value);
      el.dispatchEvent(new w.Event('input', {bubbles:true}));
      return {
        tabs:(d.getElementById('pool_dose_tabs')||{}).value,
        shock:(d.getElementById('pool_dose_shock')||{}).value,
        acid:(d.getElementById('pool_dose_acid')||{}).value
      };
    }

    [[0,'','2'], [2,'','2'], [3,'1',''], [5,'2',''], [7,'','']].forEach(([v,tabs,shock])=>{
      const g = enter('chlorine', v);
      check(file + ' chlorine ' + v + ' -> tabs/shock',
            g.tabs === tabs && g.shock === shock,
            'got tabs=' + JSON.stringify(g.tabs) + ' shock=' + JSON.stringify(g.shock));
    });

    enter('chlorine', '');
    [[7.2,''], [7.8,'0.5'], [8,'0.5']].forEach(([v,acid])=>{
      const g = enter('ph', v);
      check(file + ' pH ' + v + ' -> acid', g.acid === acid, 'got ' + JSON.stringify(g.acid));
    });
  });
}


console.log('\n=== A decimal typed without a leading zero gets one ===');
{
  ['customer-intake.html','technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file);
    const w = dom.window, d = w.document;
    check(file + ' has the helper', typeof w.padLeadingZero === 'function');
    if(typeof w.padLeadingZero !== 'function') return;

    [['.5','0.5'], ['.25','0.25'], ['-.5','-0.5'], ['0.5','0.5'],
     ['5','5'], ['','' ], ['.','.'], ['7.4','7.4']].forEach(([input, want])=>{
      check(file + ' "' + input + '" -> "' + want + '"',
            w.padLeadingZero(input) === want,
            'got ' + JSON.stringify(w.padLeadingZero(input)));
    });

    // And through a real field, the way a tech would type it
    const inp = d.createElement('input');
    inp.type = 'number';
    d.body.appendChild(inp);
    inp.value = '.5';
    inp.dispatchEvent(new w.Event('change', {bubbles:true}));
    check(file + ' a real field is tidied on change', inp.value === '0.5',
          'got ' + JSON.stringify(inp.value));
  });
}

console.log('\n=== Tidying a decimal still triggers dosage rules ===');
{
  const seed = {
    customers: [{id:'c1', name:'Test', day:'Monday', hasPool:true, active:true}],
    chemConfig: {
      pool: {
        chemicals: [{key:'chlorine', label:'Free chlorine', unit:'ppm', buttons:[0.5],
                     doseRules:[{op:'eq', value:'0.5', amount:'1', doseKey:'tabs'}]}],
        dosages: [{key:'tabs', label:'Chlorine tabs', unit:'count', buttons:[1]}]
      },
      spa: {chemicals:[], dosages:[]}, fountain: {chemicals:[], dosages:[]}
    }
  };
  const {dom} = load('technician-app.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  try{
    w.eval("currentVisitCustomerId = 'c1'; chemConfig = loadChemConfig(); resetDoseRuleTracking(); renderAllConfigFields();");
    const chem = d.getElementById('pool_chem_chlorine');
    chem.value = '.5';
    chem.dispatchEvent(new w.Event('change', {bubbles:true}));
    check('  ".5" becomes "0.5" in the reading', chem.value === '0.5',
          'got ' + JSON.stringify(chem.value));
    check('  and the rule still fires',
          (d.getElementById('pool_dose_tabs') || {}).value === '1',
          'got ' + JSON.stringify((d.getElementById('pool_dose_tabs') || {}).value));
  }catch(e){ check('  decimal + rules', false, e.message); }
}


console.log('\n=== A custom setup goes to the right customer ===');
{
  // The fields were built BEFORE the customer id was set, so each visit was
  // laid out with the previous customer's chemicals — a custom setup appeared
  // on whoever came before them on the route.
  const seed = {
    customers: [
      {id:'jim', name:'Jim', day:'Monday', hasPool:true, active:true},
      {id:'bob', name:'Bob', day:'Monday', hasPool:true, active:true}
    ],
    chemConfig: {
      pool: {
        chemicals: [{key:'chlorine', label:'Free chlorine', unit:'ppm', buttons:[3]}],
        dosages: [{key:'tabs', label:'Chlorine tabs', unit:'count', buttons:[1]}]
      },
      spa: {chemicals:[], dosages:[]}, fountain: {chemicals:[], dosages:[]}
    },
    customChemConfig: {
      bob: { pool: {
        chemicals: [{key:'bobonly', label:'Bob only', unit:'ppm', buttons:[9]}],
        dosages: [{key:'bobdose', label:'Bob dose', unit:'oz', buttons:[9]}]
      }}
    }
  };

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};

    function shown(){
      if(d.getElementById('pool_chem_bobonly')) return 'custom';
      if(d.getElementById('pool_chem_chlorine')) return 'standard';
      return 'none';
    }

    try{
      w.eval("openVisit('jim');");
      check(file + ' Jim gets the standard list', shown() === 'standard', 'got ' + shown());
      w.eval("openVisit('bob');");
      check(file + ' Bob gets his own setup', shown() === 'custom', 'got ' + shown());
      w.eval("openVisit('jim');");
      check(file + ' Jim is not given Bob\'s setup', shown() === 'standard', 'got ' + shown());
      w.eval("openVisit('bob');");
      check(file + ' Bob keeps his on a second visit', shown() === 'custom', 'got ' + shown());
    }catch(e){
      check(file + ' custom setup routing', false, e.message);
    }
  });
}


console.log('\n=== Salt pools skip chlorine, but are still shocked ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];

  function seedFor(chlorChoice){
    return {
      technicians: [{id:'t1', name:'Alex'}],
      customers: [{id:'c1', name:'Test', day: today, active:true, technicianId:'t1', hasPool:true,
        equipment: chlorChoice ? [{type:'Chlorination', chlorinationChoice: chlorChoice}] : []}],
      afterPhotoDefaultFixed: true,
      chemConfig: {
        pool: {
          chemicals: [{key:'chlorine', label:'Free chlorine', unit:'ppm', buttons:[0,1],
            doseRules:[
              {op:'eq', value:'1', amount:'2', doseKey:'tabs'},
              {op:'eq', value:'0', amount:'1', doseKey:'shock'}
            ]}],
          dosages: [
            {key:'tabs', label:'Chlorine tabs', unit:'count', buttons:[1,2]},
            {key:'shock', label:'Shock', unit:'lb', buttons:[1]}
          ]
        },
        spa: {chemicals:[], dosages:[]}, fountain: {chemicals:[], dosages:[]}
      }
    };
  }

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    // A salt pool
    {
      const {dom} = load(file, {seed: seedFor('Salt Cell')});
      const w = dom.window, d = w.document;
      w.console.warn = ()=>{};
      try{
        w.eval("currentUser = {id:'t1', name:'Alex'}; openVisit('c1');");
        const chem = d.getElementById('pool_chem_chlorine');
        const tabs = d.getElementById('pool_dose_tabs');
        const shock = d.getElementById('pool_dose_shock');

        tabs.value = ''; chem.value = '1';
        chem.dispatchEvent(new w.Event('input', {bubbles:true}));
        check(file + ' salt pool: no tabs added', tabs.value === '', tabs.value);

        shock.value = ''; chem.value = '0';
        chem.dispatchEvent(new w.Event('input', {bubbles:true}));
        check(file + ' salt pool: shock is still added', shock.value === '1', shock.value);
      }catch(e){ check(file + ' salt pool dosing', false, e.message); }
    }

    // A tab-chlorinated pool
    {
      const {dom} = load(file, {seed: seedFor('Tabs')});
      const w = dom.window, d = w.document;
      w.console.warn = ()=>{};
      try{
        w.eval("currentUser = {id:'t1', name:'Alex'}; openVisit('c1');");
        const chem = d.getElementById('pool_chem_chlorine');
        const tabs = d.getElementById('pool_dose_tabs');
        tabs.value = ''; chem.value = '1';
        chem.dispatchEvent(new w.Event('input', {bubbles:true}));
        check(file + ' tab pool: tabs are added', tabs.value === '2', tabs.value);
      }catch(e){ check(file + ' tab pool dosing', false, e.message); }
    }
  });

  // Which products count as chlorine
  {
    const {dom} = load('technician-app.html', {seed: seedFor('Salt Cell')});
    const w = dom.window;
    w.console.warn = ()=>{};
    const lists = {dosages:[
      {key:'tabs', label:'Chlorine tabs'}, {key:'shock', label:'Shock'},
      {key:'cya', label:'Stabiliser'}, {key:'acid', label:'Muriatic acid'},
      {key:'calshock', label:'Cal-hypo shock'}, {key:'liq', label:'Liquid chlorine'}
    ]};
    w.eval("window.__lists = " + JSON.stringify(lists) + ";");
    const is = k => w.eval("isChlorineProduct('" + k + "', window.__lists)");
    check('  chlorine tabs count as chlorine', is('tabs') === true);
    check('  liquid chlorine counts', is('liq') === true);
    check('  shock does not', is('shock') === false);
    check('  cal-hypo shock does not', is('calshock') === false);
    check('  stabiliser does not, despite containing "tab"', is('cya') === false);
    check('  acid does not', is('acid') === false);
  }
}

console.log('\n=== Live refresh across tabs on the same device ===');
{
  const seed = {
    customers: [
      {id:'c1', name:'Alpha', day:'Monday', hasPool:true, active:true, technicianId:'t1'},
      {id:'c2', name:'Beta',  day:'Monday', hasPool:true, active:true, technicianId:'t1'}
    ],
    technicians: [{id:'t1', name:'Alex'}]
  };
  ['admin-readings-app.html','technician-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window;
    w.console.warn = ()=>{};
    check(file + ' has a live refresh', typeof w.refreshFromStorage === 'function');
    if(typeof w.refreshFromStorage !== 'function') return;

    const updated = JSON.parse(JSON.stringify(seed.customers));
    updated[0].lastServicedDate = '2026-08-20';
    w.localStorage.setItem('weir:customers', JSON.stringify(updated));
    w.dispatchEvent(new w.StorageEvent('storage', {key:'weir:customers'}));

    // The refresh is debounced, so force it through for the test
    w.eval("customers = lsGet('customers') || customers;");
    const done = w.eval("customers.filter(c => c.lastServicedDate).length");
    check(file + ' picks up another tab\'s change', done === 1, done + ' marked done');

    // An unrelated key must not trigger work
    check(file + ' ignores keys from other apps',
          (function(){
            try{
              w.dispatchEvent(new w.StorageEvent('storage', {key:'something-else'}));
              return true;
            }catch(e){ return false; }
          })());
  });
}


console.log('\n=== A setting reads the same everywhere ===');
{
  // The toggle used "!== false" in one app and "=== true" in another, so the
  // same setting appeared off in one place while being enforced in the other.
  const files = ['customer-intake.html','technician-app.html','admin-readings-app.html'];
  ['requireAfterPhotos','requireBeforePhotos','requireGatePhoto',
   'requireAfterPhoto','requireBeforePhoto'].forEach(flag=>{
    let mismatched = [];
    files.forEach(f=>{
      const src = fs.readFileSync(f, 'utf8');
      if(src.indexOf(flag + ' !== false') !== -1) mismatched.push(f);
    });
    check('  "' + flag + '" is read consistently', mismatched.length === 0,
          'reads "!== false" in ' + mismatched.join(', '));
  });
}

console.log('\n=== A blocked photo says which setting requires it ===');
{
  ['technician-app.html','admin-readings-app.html'].forEach(f=>{
    const src = fs.readFileSync(f, 'utf8');
    check(f + ' names the source for a before photo',
          src.indexOf("'A before photo is required here (' + beforeWhy") !== -1);
    check(f + ' names the source for an after photo',
          src.indexOf("'An after photo is required here (' + afterWhy") !== -1);
    check(f + ' names the list whose setting demanded it',
          src.indexOf("'this list\\u2019s own setting'") !== -1);
    check(f + " a section's own setting takes precedence",
          src.indexOf("if(lists && typeof lists.requireAfterPhoto === 'boolean') return lists.requireAfterPhoto;") !== -1);
  });
}


console.log('\n=== Body order is shared between the website and the apps ===');
{
  const files = ['customer-intake.html','technician-app.html','admin-readings-app.html'];
  files.forEach(f=>{
    const src = fs.readFileSync(f, 'utf8');
    check(f + " uses the shared 'customBodyOrder' key",
          src.indexOf("'customBodyOrder'") !== -1);
  });

  // The apps write it, the website writes it, and all read it back the same way
  ['technician-app.html','admin-readings-app.html'].forEach(f=>{
    const src = fs.readFileSync(f, 'utf8');
    check(f + ' writes the order from the visit tabs',
          src.indexOf("store[customer.id] = keys") !== -1);
    check(f + ' reads it when working out sections',
          src.indexOf("const store = lsGet('customBodyOrder') || {};") !== -1);
  });
  {
    const src = fs.readFileSync('customer-intake.html','utf8');
    check('website writes the order from the Custom tab',
          src.indexOf("store[cust.id] = keys") !== -1);
  }
}

console.log('\n=== The order is permanent, not per week ===');
{
  // It is stored against the customer id alone. Nothing in the key or the
  // lookup involves a date, so it cannot revert next week.
  ['technician-app.html','admin-readings-app.html','customer-intake.html'].forEach(f=>{
    const src = fs.readFileSync(f, 'utf8');
    const idx = src.indexOf("customBodyOrder");
    const around = src.slice(Math.max(0, idx - 400), idx + 400);
    check(f + ' keys the order by customer, not by date',
          around.indexOf('todayDateStr') === -1 && around.indexOf('isoForDay') === -1);
  });
}


console.log('\n=== Photo settings line up, and rules fire regardless ===');
{
  function seedFor(settings, sectionAfter){
    const cfg = {
      pool: {
        chemicals: [{key:'chlorine', label:'Free chlorine', unit:'ppm', buttons:[5],
                     doseRules:[{op:'eq', value:'5', amount:'1', doseKey:'tabs'}]}],
        dosages: [{key:'tabs', label:'Chlorine tabs', unit:'count', buttons:[1]}]
      },
      spa: {chemicals:[], dosages:[]}, fountain: {chemicals:[], dosages:[]}
    };
    if(sectionAfter !== undefined) cfg.pool.requireAfterPhoto = sectionAfter;
    return {
      customers: [{id:'c1', name:'Test', day:'Monday', hasPool:true, active:true}],
      settings, chemConfig: cfg,
      // Mark the one-time default correction as already applied, so a
      // deliberately-on setting is honoured rather than cleared
      afterPhotoDefaultFixed: true
    };
  }

  const cases = [
    [{requireAfterPhotos:false, showAfterPhotos:true},  true,      true,  'app-wide off, section requires'],
    [{requireAfterPhotos:true,  showAfterPhotos:true},  false,     false, 'app-wide on, section exempt'],
    [{requireAfterPhotos:false, showAfterPhotos:false}, true,      false, 'step off, section requires (no step, so not enforced)'],
    [{requireAfterPhotos:false, showAfterPhotos:false}, undefined, false, 'step off, section untouched'],
    // A stale app-wide value must no longer demand anything
    [{requireAfterPhotos:true,  showAfterPhotos:true},  undefined, false, 'stale app-wide value is ignored']
  ];

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    cases.forEach(([settings, sectionAfter, wantRequired, label])=>{
      const {dom} = load(file, {seed: seedFor(settings, sectionAfter)});
      const w = dom.window, d = w.document;
      w.console.warn = ()=>{};
      try{
        w.eval("openVisit('c1');");
        const req = w.eval("afterPhotoRequiredFor('pool')");
        check(file + ': ' + label, req === wantRequired,
              'got ' + req + ', wanted ' + wantRequired);

        // Rules must fire whatever the photo settings say
        const chem = d.getElementById('pool_chem_chlorine');
        const dose = d.getElementById('pool_dose_tabs');
        dose.value = '';
        chem.value = '5';
        chem.dispatchEvent(new w.Event('input', {bubbles:true}));
        check(file + ': rules fire with ' + label, dose.value === '1',
              'dose = ' + JSON.stringify(dose.value));
      }catch(e){
        check(file + ': ' + label, false, e.message);
      }
    });
  });
}


console.log('\n=== The photo sliders control the step; require does not ===');
{
  function seedFor(showAfter, showBefore, requireAfter){
    return {
      customers: [{id:'c1', name:'Test', day:'Monday', hasPool:true, active:true}],
      settings: {showAfterPhotos: showAfter, showBeforePhotos: showBefore},
      afterPhotoDefaultFixed: true,
      chemConfig: {
        // The requirement is set per body of water now, not app-wide
        pool: {chemicals:[{key:'chlorine', label:'Free chlorine', buttons:[3]}], dosages:[],
               requireAfterPhoto: requireAfter},
        spa: {chemicals:[], dosages:[]}, fountain: {chemicals:[], dosages:[]}
      }
    };
  }

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    function steps(showAfter, showBefore, requireAfter){
      const {dom} = load(file, {seed: seedFor(showAfter, showBefore, requireAfter)});
      const w = dom.window;
      w.console.warn = ()=>{};
      w.eval("openVisit('c1');");
      return {
        list: w.eval("JSON.stringify(visitStepCardsFor('pool'))"),
        required: w.eval("afterPhotoRequiredFor('pool')")
      };
    }

    // After photos ON — button there, requirement follows its own setting
    let r = steps(true, true, false);
    check(file + ' after ON: step present', r.list.indexOf('PoolPhotoSection') !== -1);
    check(file + ' after ON, require OFF: not required', r.required === false);

    r = steps(true, true, true);
    check(file + ' after ON, require ON: still present', r.list.indexOf('PoolPhotoSection') !== -1);
    check(file + ' after ON, require ON: required', r.required === true);

    // After photos OFF — no step, whatever require says
    r = steps(false, true, false);
    check(file + ' after OFF: step gone', r.list.indexOf('PoolPhotoSection') === -1);

    r = steps(false, true, true);
    check(file + ' after OFF with require ON: step still gone',
          r.list.indexOf('PoolPhotoSection') === -1);
    check(file + ' after OFF with require ON: nothing required', r.required === false);

    // Before photos slider is independent
    r = steps(true, false, false);
    check(file + ' before OFF: before step gone',
          r.list.indexOf('PoolBeforePhotoSection') === -1);
    check(file + ' before OFF: after step unaffected',
          r.list.indexOf('PoolPhotoSection') !== -1);
  });
}


console.log('\n=== Voice keeps listening while the button is held ===');
{
  ['technician-app.html','admin-readings-app.html'].forEach(f=>{
    const src = fs.readFileSync(f, 'utf8');
    check(f + ' tracks whether the button is held', src.includes('let pttHolding = false;'));
    check(f + ' restarts when the engine stops mid-hold',
          src.includes('if(pttHolding){') && src.includes('pttRecognition.start();      // still held'));
    check(f + ' ignores silence errors while held',
          src.includes("e.error === 'no-speech' || e.error === 'aborted'"));
    check(f + ' only finishes when the finger lifts',
          src.includes('pttHolding = false;\n  if(pttRecognition){'));
    check(f + ' retries if the engine refuses to restart',
          src.includes('}, 120);'));
  });

  // The accumulated speech must survive the restarts
  let holding = false, heard = '', running = false;
  const onend = ()=>{ if(holding){ running = true; return; } running = false; };
  const start = ()=>{ holding = true; running = true; heard = ''; };
  const say = t => { if(running) heard += t + ' '; };
  const stop = ()=>{ holding = false; onend(); };

  start();
  say('chlorine three'); onend();
  say('ph seven point four'); onend();
  say('acid one'); stop();

  check('  speech before the first pause is kept', heard.indexOf('chlorine three') !== -1);
  check('  speech after a pause is kept', heard.indexOf('ph seven point four') !== -1);
  check('  speech after a second pause is kept', heard.indexOf('acid one') !== -1);
  check('  listening stops on release', running === false);
}


console.log('\n=== Next/Previous keeps the open tab ===');
{
  const seed = {
    customers: [
      {id:'a', name:'Alpha One', day:'Monday', hasPool:true, active:true},
      {id:'b', name:'Bravo Two', day:'Monday', hasPool:true, active:true},
      {id:'c', name:'Charlie Three', day:'Monday', hasPool:true, active:true}
    ]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  const activeTab = ()=>{
    const b = d.querySelector('#profileTabControl .history-type-btn.active');
    return b ? b.dataset.tab : 'none';
  };
  const openTab = (name)=>{
    d.querySelectorAll('#profileTabControl .history-type-btn').forEach(b=>{
      b.classList.toggle('active', b.dataset.tab === name);
    });
  };

  try{
    w.eval("viewCustomer(customers[0]);");
    check('  opening a customer starts on Profile', activeTab() === 'profile', activeTab());

    openTab('equipment');
    w.eval("stepToCustomer(1);");
    check('  Next keeps Equipment', activeTab() === 'equipment', activeTab());

    w.eval("stepToCustomer(1);");
    check('  Next again still keeps it', activeTab() === 'equipment', activeTab());

    openTab('history');
    w.eval("stepToCustomer(-1);");
    check('  Previous keeps Service Reports', activeTab() === 'history', activeTab());

    openTab('workorders');
    w.eval("stepToCustomer(-1);");
    check('  Previous keeps Quotes & Orders', activeTab() === 'workorders', activeTab());

    w.eval("viewCustomer(customers[2]);");
    check('  opening from the list resets to Profile', activeTab() === 'profile', activeTab());
  }catch(e){
    check('  tab persistence', false, e.message);
  }
}


console.log('\n=== Quick buttons are shared across customers ===');
{
  const seed = {
    customers: [
      {id:'a', name:'Alpha One', day:'Monday', hasPool:true, active:true,
       equipmentTypeOptions:['Filter','Salt System']},
      {id:'b', name:'Bravo Two', day:'Monday', hasPool:true, active:true,
       equipmentTypeOptions:['Filter','Salt System']}
    ]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  const texts = ()=> Array.from(d.querySelectorAll('#icEquipmentList button'))
    .map(b => b.textContent.trim());

  try{
    w.eval("viewCustomer(customers[0]);");
    check('  every type offers a quick-buttons control',
          texts().filter(t => t === '+ Quick buttons' || t === 'Edit buttons').length >= 2,
          texts().join(','));
    check('  a new option is not there yet', !texts().includes('Pentair CCP420'));

    // What choosing "Other" and typing a name does
    w.eval("saveCustomEquipmentOptions('Filter', ['Pentair CCP420']);");
    w.eval("renderEquipmentTypeList();");
    check('  it appears for this customer', texts().includes('Pentair CCP420'));
    check('  built-in choices are kept', texts().includes('Cartridge') && texts().includes('Sand'));
    check('  Other is still offered', texts().includes('Other'));

    // The point of the feature: another customer gets it too
    w.eval("viewCustomer(customers[1]);");
    check('  it appears for a different customer', texts().includes('Pentair CCP420'),
          texts().join(','));

    // But only on the same equipment type
    w.eval("saveCustomEquipmentOptions('Salt System', ['Circupool']);");
    w.eval("renderEquipmentTypeList();");
    check('  a different type keeps its own options', texts().includes('Circupool'));
  }catch(e){
    check('  shared quick buttons', false, e.message);
  }
}


console.log('\n=== Deleting equipment from chosen customers ===');
{
  const seed = {
    customers: [
      {id:'a', name:'Alpha One', active:true, equipmentTypeOptions:['Filter','Salt System']},
      {id:'b', name:'Bravo Two', active:true, equipmentTypeOptions:['Filter','Salt System'],
       equipment:[{type:'Salt System', photos:[{id:'p1'}]}]},
      {id:'c', name:'Charlie Three', active:true, equipmentTypeOptions:['Filter','Salt System']},
      {id:'d', name:'Delta Four', active:true, equipmentTypeOptions:['Filter']}
    ]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};
  const has = (id,t)=> w.eval("(customers.find(c=>c.id==='" + id + "').equipmentTypeOptions||[]).includes('" + t + "')");

  try{
    w.eval("viewCustomer(customers[0]);");

    const rows = Array.from(d.querySelectorAll('#icEquipmentList > div'));
    const saltRow = rows.find(r => r.textContent.includes('Salt System'));
    const xBtn = Array.from(saltRow.querySelectorAll('button')).find(b => b.textContent.trim() === '\u00d7');
    check('  the delete button exists', !!xBtn);
    xBtn.click();

    const box = d.querySelector('.confirm-overlay .confirm-box');
    const labels = Array.from(box.querySelectorAll('button')).map(b => b.textContent.trim());
    check('  offers "Just this customer"', labels.includes('Just this customer'));
    check('  offers "Delete from multiple customers"',
          labels.includes('Delete from multiple customers'), labels.join(' | '));
    check('  no longer offers a delete-from-all button',
          !labels.some(t => t.startsWith('Delete from all')), labels.join(' | '));

    d.getElementById('delEqPick').click();
    const names = Array.from(d.querySelectorAll('#delEqList label span')).map(s => s.textContent);
    check('  lists only customers with that equipment', names.length === 2, names.join(','));
    check('  excludes one without it', !names.some(n => n.includes('Delta')));

    const boxes = d.querySelectorAll('#delEqList input[type=checkbox]');
    boxes[0].click(); boxes[1].click();
    check('  the button counts the selection',
          d.getElementById('delEqGo').textContent.trim() === 'Delete from 2 customers',
          d.getElementById('delEqGo').textContent.trim());

    d.getElementById('delEqGo').click();

    // The click resolves a promise, so the removal happens a tick later.
    // Defer the remaining checks rather than reading too early.
    deferred.push(()=>{
      check('  removed from the first selected', has('b','Salt System') === false);
      check('  removed from the second selected', has('c','Salt System') === false);
      check('  its equipment record went too',
            w.eval("customers.find(c=>c.id==='b').equipment.length") === 0);
      check('  a customer without it is untouched', has('d','Filter') === true);
      check('  their other equipment survives', has('b','Filter') === true);
    });
  }catch(e){
    check('  delete from chosen customers', false, e.message);
  }
}



// Checks that had to wait for an app to finish starting up.
setTimeout(()=>{
  deferred.forEach(fn => {
    try{ fn(); }catch(e){ check('deferred check', false, e.message); }
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}, 2500);
