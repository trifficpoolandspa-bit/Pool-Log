// Part 2 of 4. The suite was one file until it grew past what could
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
          w.localStorage.setItem('poollog:' + k, JSON.stringify(opts.seed[k]));
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

console.log('\n=== Adding equipment must not wipe default equipment ===');
{
  // A customer who has never had their equipment edited has NO saved list and
  // shows the five defaults. Writing a fresh list containing only the new item
  // replaced that implicit default and deleted their standard equipment.
  const seed = {
    customers: [
      {id:'a', name:'Alpha One', day:'Monday', hasPool:true, active:true},
      {id:'b', name:'Bravo Two', day:'Monday', hasPool:true, active:true},
      {id:'c', name:'Charlie Three', day:'Monday', hasPool:true, active:true,
       equipmentTypeOptions:['Filter','Pump']}
    ]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("viewCustomer(customers[0]);");
    check('  an unedited customer has no saved list',
          w.eval("customers.find(c=>c.id==='b').equipmentTypeOptions") === undefined
          || w.eval("customers.find(c=>c.id==='b').equipmentTypeOptions") === null);

    w.eval("addEquipmentTypeToCustomers('Salt System', ['b','c']);");
    const b = JSON.parse(w.eval("JSON.stringify(customers.find(c=>c.id==='b').equipmentTypeOptions)"));

    check('  their default Filter survives', b.includes('Filter'), b.join(','));
    check('  their default Pump survives', b.includes('Pump'));
    check('  their default Heater survives', b.includes('Heater'));
    check('  their default Chlorination survives', b.includes('Chlorination'));
    check('  their default Cleaning System survives', b.includes('Cleaning System'));
    check('  and the new item was added', b.includes('Salt System'));

    const cc = JSON.parse(w.eval("JSON.stringify(customers.find(c=>c.id==='c').equipmentTypeOptions)"));
    check('  a customer with a saved list keeps it', cc.includes('Filter') && cc.includes('Pump'));
    check('  and gets the new item too', cc.includes('Salt System'));
    check('  a saved list is not padded with defaults', !cc.includes('Heater'), cc.join(','));
  }catch(e){
    check('  defaults preserved when adding equipment', false, e.message);
  }
}


console.log('\n=== Reset equipment to default ===');
{
  const seed = {
    customers: [{id:'a', name:'Alpha One', day:'Monday', hasPool:true, active:true,
      equipmentTypeOptions:['Filter','Salt System','Booster Pump'],
      equipment:[
        {type:'Filter', filterTypeChoice:'Sand', photos:[{id:'p1', data:'img'}], notes:'backwash weekly'},
        {type:'Salt System', photos:[{id:'p2', data:'img'}]},
        {type:'Booster Pump', photos:[]}
      ]}]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("viewCustomer(customers[0]);");
    check('  starts with custom equipment',
          w.eval("currentEquipmentTypeOptions.includes('Salt System')"));

    // What the Reset to default button does
    w.eval("currentEquipmentTypeOptions = [...DEFAULT_EQUIPMENT_TYPES];"
         + "currentEquipmentItems = currentEquipmentItems.filter(i => DEFAULT_EQUIPMENT_TYPES.includes(i.type));"
         + "persistCurrentEquipmentTypeOptions(); persistCurrentEquipmentItems();");

    const after = JSON.parse(w.eval("JSON.stringify(currentEquipmentTypeOptions)"));
    check('  exactly five items remain', after.length === 5, after.join(','));
    ['Filter','Pump','Cleaning System','Chlorination','Heater'].forEach(t=>{
      check('  ' + t + ' is present', after.includes(t));
    });
    check('  added equipment is gone',
          !after.includes('Salt System') && !after.includes('Booster Pump'));

    const items = JSON.parse(w.eval("JSON.stringify(currentEquipmentItems)"));
    const filter = items.find(i => i.type === 'Filter');
    check('  a default item keeps its record', !!filter);
    check('  it keeps its photos', filter && filter.photos.length === 1);
    check('  it keeps its notes', filter && filter.notes === 'backwash weekly');
    check('  it keeps its type choice', filter && filter.filterTypeChoice === 'Sand');
    check('  a removed item takes its record with it',
          !items.some(i => i.type === 'Salt System'));

    check('  the change is saved to the customer',
          w.eval("customers.find(c=>c.id==='a').equipmentTypeOptions.length") === 5);
  }catch(e){
    check('  reset to default', false, e.message);
  }
}


console.log('\n=== Technician dropdown opens on the first tap ===');
{
  const seed = {
    customers: [{id:'a', name:'Alpha One', active:true, technicianId:'t1'}],
    technicians: [{id:'t1', name:'Alex Rivera'}, {id:'t2', name:'Sam Okafor'}]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};
  // Record whether the app asks the browser to open the list
  w.HTMLSelectElement.prototype.showPicker = function(){ this.__opened = true; };

  try{
    w.eval("viewCustomer(customers[0]);");
    check('  the assigned technician is shown',
          d.getElementById('profileTechName').textContent === 'Alex Rivera');

    d.getElementById('profileTechWrap').click();
    const sel = d.getElementById('profileTechWrap').nextElementSibling;
    check('  one tap creates the dropdown', sel && sel.tagName === 'SELECT');
    check('  and opens it without a second tap', !!(sel && sel.__opened));
    check('  every technician is listed',
          Array.from(sel.options).map(o=>o.textContent).join(',')
            === 'Unassigned,Alex Rivera,Sam Okafor');
    check('  the current one is preselected', sel.value === 't1');

    sel.value = 't2';
    sel.dispatchEvent(new w.Event('change', {bubbles:true}));
    deferred.push(()=>{
      check('  choosing another saves it',
            w.eval("customers.find(c=>c.id==='a').technicianId") === 't2');
    });
  }catch(e){
    check('  technician dropdown', false, e.message);
  }
}


console.log('\n=== Water body sizes, per body, with units ===');
{
  const seed = {
    customers: [{id:'a', name:'Alpha One', active:true, hasPool:true, hasSpa:true,
                 poolGallons:'18000',
                 fountains:[{id:'f1', name:'Front fountain'}]}],
    settings: {showPoolSizeInProfile:true}
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("viewCustomer(customers[0]);");
    const meta = d.getElementById('profileMeta').textContent;
    check('  the row is labelled Water body sizes', meta.includes('Water body sizes'));
    check('  an existing pool volume is carried over', meta.includes('18000'));

    const bodies = JSON.parse(w.eval("JSON.stringify(bodiesForSizes(customers[0]).map(b=>b.label))"));
    check('  every body of water is offered',
          bodies.join(',') === 'Pool,Spa,Front fountain', bodies.join(','));

    check('  the old poolGallons is read as the pool size',
          w.eval("waterBodySize(customers[0],'pool').amount") === '18000');
    check('  a body with no size set reads as nothing',
          w.eval("waterBodySize(customers[0],'spa')") === null);

    w.eval("customers[0].waterSizes = {pool:{amount:'18000',unit:'gallons'},"
         + "spa:{amount:'450',unit:'gallons'}, f1:{amount:'2',unit:'m\u00b3'}}; saveCustomers();");
    w.eval("viewCustomer(customers[0]);");
    const meta2 = d.getElementById('profileMeta').textContent;
    check('  the pool size is shown', meta2.includes('Pool: 18000 gallons'));
    check('  the spa size is shown', meta2.includes('Spa: 450 gallons'));
    check('  a fountain keeps its own unit', meta2.includes('Front fountain: 2 m\u00b3'));
  }catch(e){
    check('  water body sizes', false, e.message);
  }
}


console.log('\n=== Removing a body of water warns first ===');
{
  const seed = {
    customers: [{id:'a', name:'Alpha One', active:true, hasPool:true,
      fountains:[{id:'f1', name:'Front fountain'}, {id:'f2', name:'Koi pond'}],
      waterSizes:{f1:{amount:'200',unit:'gallons'}}}],
    'fountainReadings:a:f1': [
      {id:'r1', date:'2026-09-01T10:00:00Z'},
      {id:'r2', date:'2026-08-25T10:00:00Z'}
    ],
    customChemConfig: {a: {f1: {chemicals:[], dosages:[]}}}
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("viewCustomer(customers[0]);");

    const attached = JSON.parse(w.eval("JSON.stringify(fountainAttachments('f1'))"));
    check('  service reports are counted', attached.includes('2 service reports'), attached.join(','));
    check('  a custom setup is named', attached.includes('its custom readings and dosages'));
    check('  a recorded size is named', attached.includes('its recorded size'));
    check('  a body with nothing attached lists nothing',
          w.eval("fountainAttachments('f2').length") === 0);

    w.eval("showCustomerForm(); renderFountainFields();");
    const btns = d.querySelectorAll('#fountainList .fountain-remove');
    check('  each body has a remove button', btns.length === 2);

    btns[0].click();
    deferred.push(()=>{
      const overlay = d.querySelector('.confirm-overlay');
      check('  removing asks first', !!overlay);
      if(overlay){
        const said = overlay.textContent.replace(/\s+/g,' ');
        check('  the warning names the body of water', said.includes('Front fountain'), said.slice(0,80));
        check('  and says what else goes', said.includes('service report'), said.slice(0,120));
      }
      check('  nothing is removed until confirmed', w.eval("currentFountains.length") === 2);
    });
  }catch(e){
    check('  body of water removal warning', false, e.message);
  }
}


console.log('\n=== Neighborhood and yard gate codes ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', day: today, active:true, hasPool:true,
      technicianId:'t1', gateCode:'4821#', neighborhoodGateCode:'1234#',
      dogs:[{name:'Buddy'}]}]
  };

  // The website profile shows both, correctly labelled
  {
    const {dom} = load('customer-intake.html', {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    w.eval("viewCustomer(customers[0]);");
    const meta = d.getElementById('profileMeta').textContent;
    check('  website shows a Neighborhood gate code row', meta.includes('Neighborhood gate code'));
    check('  website shows a Yard gate code row', meta.includes('Yard gate code'));
    check('  both values appear', meta.includes('1234#') && meta.includes('4821#'));
  }

  // Both field apps show them in the same panel as the dogs
  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser = {id:'t1', name:'Alex'}; renderHomeList();");
      const rows = Array.from(d.querySelectorAll('.cust-row'));
      if(!rows.length){ check(file + ' route list has the customer', false); return; }
      rows[0].click();
      // Read the panel now — deferring lets other tests reuse these variables
      const t = d.body.textContent;
      check(file + ' shows the neighborhood gate', t.includes('Neighborhood gate'));
      check(file + ' shows the yard gate', t.includes('Yard gate'));
      check(file + ' shows them with the dogs', t.includes('Buddy'));
      check(file + ' shows both codes', t.includes('1234#') && t.includes('4821#'));
    }catch(e){
      check(file + ' gate codes', false, e.message);
    }
  });
}


console.log('\n=== On my way is on the row, Directions in the panel ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', day: today, active:true, hasPool:true,
                 technicianId:'t1', address:'123 Main St', phone:'6234146875'}]
  };

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser = {id:'t1', name:'Alex'}; renderHomeList();");
      const row = d.querySelector('.cust-row');
      if(!row){ check(file + ' has a route row', false); return; }

      const rowBtns = Array.from(row.querySelectorAll('button')).map(b=>b.textContent.trim());
      check(file + ' row button is On my way', rowBtns.includes('On my way'), rowBtns.join(','));
      check(file + ' row no longer shows Directions', !rowBtns.includes('Directions'));

      row.click();
      const all = Array.from(d.querySelectorAll('button')).map(b=>b.textContent.trim());
      check(file + ' the panel offers Directions', all.includes('Directions'));
      check(file + ' the panel still offers Skip Service', all.includes('Skip Service'));
    }catch(e){
      check(file + ' button swap', false, e.message);
    }
  });
}


console.log('\n=== Back retraces where you have been ===');
{
  // Each app has its own set of views
  [['technician-app.html','serviced'], ['admin-readings-app.html','customers']].forEach(([file, mid])=>{
    const {dom} = load(file, {seed: {customers: []}});
    const w = dom.window;
    w.console.warn = ()=>{};
    try{
      check(file + ' pushes an entry on every Back, not a counted buffer',
            fs.readFileSync(file,'utf8').indexOf('BACK_GUARD_DEPTH') === -1);
      check(file + ' keeps a navigation stack',
            typeof w.eval("typeof navStack") !== 'undefined' && w.eval("Array.isArray(navStack)"));

      w.eval("switchView('" + mid + "'); switchView('options');");
      check(file + ' records where you have been',
            w.eval("JSON.stringify(navStack.map(p=>p.view))") === '["home","' + mid + '"]',
            w.eval("JSON.stringify(navStack.map(p=>p.view))"));

      const a = JSON.parse(w.eval("JSON.stringify(goBackOnePlace())") || 'null');
      check(file + ' back goes to the previous place', a && a.view === mid,
            a && a.view);

      w.eval("currentViewName = '" + mid + "';");
      const b = JSON.parse(w.eval("JSON.stringify(goBackOnePlace())") || 'null');
      check(file + ' back again goes further back', b && b.view === 'home', b && b.view);

      w.eval("currentViewName = 'home';");
      check(file + ' an empty stack returns nothing rather than throwing',
            w.eval("goBackOnePlace()") === null);
    }catch(e){
      check(file + ' navigation stack', false, e.message);
    }
  });

  // The stack must not grow without bound
  {
    const {dom} = load('technician-app.html', {seed: {customers: []}});
    const w = dom.window;
    w.console.warn = ()=>{};
    w.eval("for(let i=0;i<200;i++){ switchView(i%2 ? 'serviced' : 'options'); }");
    check('  the stack is capped', w.eval("navStack.length") <= 40,
          'length ' + w.eval("navStack.length"));
  }
}


console.log('\n=== Clearing a dosage does not lock the rules out ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1', hasPool:true}],
    chemConfig: {
      pool: {
        chemicals: [{key:'chlorine', label:'Free chlorine', unit:'ppm', buttons:[1,3,5],
          doseRules:[
            {op:'eq', value:'5', amount:'1', doseKey:'tabs'},
            {op:'eq', value:'1', amount:'2', doseKey:'tabs'}
          ]}],
        dosages: [{key:'tabs', label:'Chlorine tabs', unit:'count', buttons:[1,2]}]
      },
      spa: {chemicals:[], dosages:[]}, fountain: {chemicals:[], dosages:[]}
    }
  };

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser = {id:'t1', name:'Alex'}; openVisit('a');");
      const chem = d.getElementById('pool_chem_chlorine');
      const dose = d.getElementById('pool_dose_tabs');
      const setReading = v => { chem.value = v; chem.dispatchEvent(new w.Event('input', {bubbles:true})); };
      const clearDose = () => { dose.value = ''; dose.dispatchEvent(new w.Event('input', {bubbles:true})); };

      setReading('5');
      check(file + ' the rule fills the dosage', dose.value === '1', dose.value);

      clearDose();
      check(file + ' clearing it sticks', dose.value === '', dose.value);
      check(file + ' clearing is not treated as a manual entry',
            w.eval("Object.keys(manuallyEditedDoses).length") === 0);

      setReading('1');
      check(file + ' a new reading fills it again', dose.value === '2', dose.value);

      // Typing a value by hand should still win
      dose.value = '9';
      dose.dispatchEvent(new w.Event('input', {bubbles:true}));
      setReading('5');
      check(file + ' a hand-typed dosage is still protected', dose.value === '9', dose.value);
    }catch(e){
      check(file + ' cleared dosage handling', false, e.message);
    }
  });
}


console.log('\n=== Saving one body opens the next at its readings ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1',
      hasPool:true, hasSpa:true, fountains:[{id:'f1', name:'Front fountain'}]}],
    settings: {showAfterPhotos:false, showBeforePhotos:false,
               requireAfterPhotos:false, requireBeforePhotos:false},
    afterPhotoDefaultFixed: true,
    chemConfig: {
      pool: {chemicals:[{key:'chlorine',label:'Free chlorine',unit:'ppm'}], dosages:[]},
      spa:  {chemicals:[{key:'chlorine',label:'Free chlorine',unit:'ppm'}], dosages:[]},
      fountain: {chemicals:[{key:'chlorine',label:'Free chlorine',unit:'ppm'}], dosages:[]}
    }
  };

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window;
    w.console.warn = ()=>{};
    const cardNow = ()=> w.eval("(function(){var t = currentVisibleSection === 'fountain' ? 'fountain' : currentVisibleSection;"
      + "var s = visitStepCardsFor(t)[currentVisitStep - 1];"
      + "return Array.isArray(s) ? s[0] : s; })()");

    try{
      w.eval("currentUser = {id:'t1', name:'Alex'}; openVisit('a');");
      check(file + ' starts on the pool readings', cardNow() === 'visitPoolSection', cardNow());

      w.eval("markSectionDone('pool','r1');");
      check(file + ' moves to the spa', w.eval('currentVisibleSection') === 'spa');
      check(file + ' at its chemical readings', cardNow() === 'visitSpaSection', cardNow());

      w.eval("markSectionDone('spa','r2');");
      check(file + ' then moves to the fountain', w.eval('currentVisibleSection') === 'fountain');
      check(file + ' with the right fountain selected', w.eval('currentVisitFountainId') === 'f1');
      check(file + ' at its chemical readings', cardNow() === 'visitFountainSection', cardNow());
    }catch(e){
      check(file + ' auto-advance between bodies', false, e.message);
    }
  });
}


console.log('\n=== The Report tab opens on Serviced today ===');
{
  const {dom} = load('admin-readings-app.html', {seed: {customers: []}});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  const showing = ()=> d.getElementById('reportModeServiced').style.display !== 'none'
    ? 'serviced' : 'reports';

  try{
    w.eval("switchView('report');");
    check('  tapping the tab shows Serviced today', showing() === 'serviced', showing());

    // A previous choice must not stick
    w.eval("setReportMode('reports'); switchView('home'); switchView('report');");
    check('  coming back still shows Serviced today', showing() === 'serviced', showing());

    // Opening a specific report goes to Reports
    w.eval("switchView('home'); switchView('report', {skipRefresh: true});");
    check('  opening a report directly shows Reports', showing() === 'reports', showing());

    // And the buttons reflect it
    check('  the Serviced button is highlighted when it should be',
          (function(){
            w.eval("switchView('home'); switchView('report');");
            return d.getElementById('btnReportModeServiced').className.indexOf('btn-primary') !== -1;
          })());
  }catch(e){
    check('  report tab default', false, e.message);
  }
}


console.log('\n=== Today reopens a report only if it was left open ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [
      {id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1', hasPool:true},
      {id:'b', name:'Bravo Two', day: today, active:true, technicianId:'t1', hasPool:true}
    ],
    chemConfig: {pool:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[]},
                 spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  };

  function tapToday(w, d){
    w.eval("stepBarPressedAt = 0; viewChangedAt = 0;");
    const tab = Array.from(d.querySelectorAll('.tab')).find(t => t.dataset.view === 'home');
    if(tab) tab.click();
  }

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    // A report open when another tab was tapped
    {
      const {dom} = load(file, {seed});
      const w = dom.window, d = w.document;
      w.console.warn = ()=>{};
      try{
        w.eval("currentUser = {id:'t1', name:'Alex'}; openVisit('a');");
        w.eval("switchView('options');");
        tapToday(w, d);
        // Today means the route. Reopening the visit dropped technicians back
        // inside a report they were trying to leave.
        check(file + ' Today shows the route, not the open report',
              w.eval('currentViewName') === 'home', w.eval('currentViewName'));
        check(file + ' and the draft is kept so the visit can resume',
              w.eval("visitDraft && visitDraft.customerId") === 'a',
              String(w.eval("visitDraft && visitDraft.customerId")));
      }catch(e){ check(file + ' leaving an open report', false, e.message); }
    }

    // Nothing opened at all
    {
      const {dom} = load(file, {seed});
      const w = dom.window, d = w.document;
      w.console.warn = ()=>{};
      try{
        w.eval("currentUser = {id:'t1', name:'Alex'}; renderHomeList();");
        w.eval("switchView('options');");
        tapToday(w, d);
        check(file + ' shows the route when nothing was open',
              w.eval('currentViewName') === 'home', w.eval('currentViewName'));
      }catch(e){ check(file + ' nothing open', false, e.message); }
    }

    // Opened a report, went back to the route, then to another tab
    {
      const {dom} = load(file, {seed});
      const w = dom.window, d = w.document;
      w.console.warn = ()=>{};
      try{
        w.eval("currentUser = {id:'t1', name:'Alex'}; openVisit('a');");
        w.eval("switchView('home');");
        w.eval("switchView('options');");
        tapToday(w, d);
        check(file + ' shows the route when the report was closed first',
              w.eval('currentViewName') === 'home', w.eval('currentViewName'));
      }catch(e){ check(file + ' report closed first', false, e.message); }
    }
  });
}

console.log('\n=== Search suggestions only appear once you type ===');
{
  const seed = {
    customers: [
      {id:'a', name:'Alpha One', active:true},
      {id:'b', name:'Bravo Two', active:true},
      {id:'c', name:'Charlie Three', active:true}
    ]
  };

  // Website: three separate customer searches
  {
    const {dom} = load('customer-intake.html', {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};

    [['renderCustomerSearchSuggestions','customerSearchSuggestions','the customer list search'],
     ['renderWcSuggest','wcCustomerSuggest','the work centre search'],
     ['renderCustomCustSuggest','customCustSuggest','the custom tab search']
    ].forEach(([fn, boxId, label])=>{
      try{
        w.eval(fn + "('');");
        const box = d.getElementById(boxId);
        check('  ' + label + ' stays closed when empty',
              !box || box.style.display === 'none', box ? box.style.display : 'missing');

        w.eval(fn + "('alph');");
        check('  ' + label + ' opens once you type',
              box && box.style.display !== 'none' && box.textContent.indexOf('Alpha') !== -1,
              box ? box.textContent.slice(0, 40) : 'missing');

        w.eval(fn + "('   ');");
        check('  ' + label + ' treats spaces as empty',
              box && box.style.display === 'none', box ? box.style.display : 'missing');
      }catch(e){
        check('  ' + label, false, e.message);
      }
    });
  }

  // Admin app: the report customer search
  {
    const {dom} = load('admin-readings-app.html', {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("renderReportCustomerSuggestions('');");
      const box = d.getElementById('reportCustomerSuggestions');
      check('  the report search stays closed when empty',
            box && box.style.display === 'none', box ? box.style.display : 'missing');

      w.eval("renderReportCustomerSuggestions('brav');");
      check('  the report search opens once you type',
            box && box.style.display !== 'none' && box.textContent.indexOf('Bravo') !== -1,
            box ? box.textContent.slice(0, 40) : 'missing');
    }catch(e){
      check('  the report search', false, e.message);
    }
  }
}


console.log('\n=== Camera controls: flash replaces flip ===');
{
  function withCamera(file, hasTorch){
    const {dom} = load(file, {seed: {customers: []}, beforeParse(w){
      w.__torchCalls = [];
      const track = {
        getCapabilities: ()=> hasTorch ? {torch:true} : {},
        applyConstraints: (cfg)=>{
          const adv = (cfg && cfg.advanced && cfg.advanced[0]) || {};
          if('torch' in adv) w.__torchCalls.push(adv.torch);
          return Promise.resolve();
        },
        stop: ()=>{}
      };
      w.navigator.mediaDevices = {
        getUserMedia: ()=> Promise.resolve({getTracks:()=>[track], getVideoTracks:()=>[track]}),
        enumerateDevices: ()=> Promise.resolve([])
      };
    }});
    return dom;
  }

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const dom = withCamera(file, true);
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.eval("captureFromCamera(900, 0.5).catch(()=>{});");

    deferred.push(()=>{
      check(file + ' the flip button is gone', !d.getElementById('camFlip'));
      const btn = d.getElementById('camFlash');
      check(file + ' a flash button is in its place', !!btn);
      if(!btn) return;
      check(file + ' visible when the camera has a torch', btn.style.visibility === 'visible',
            btn.style.visibility);
      check(file + ' starts off', btn.textContent.trim() === 'Flash off', btn.textContent);
      check(file + ' the shutter is still there', !!d.getElementById('camShutter'));
      check(file + ' cancel is still there', !!d.getElementById('camCancel'));
    });

    const dom2 = withCamera(file, false);
    const w2 = dom2.window, d2 = w2.document;
    w2.console.warn = ()=>{};
    w2.eval("captureFromCamera(900, 0.5).catch(()=>{});");
    deferred.push(()=>{
      const btn2 = d2.getElementById('camFlash');
      check(file + ' hidden when there is no torch',
            btn2 && btn2.style.visibility === 'hidden', btn2 ? btn2.style.visibility : 'missing');
      check(file + ' the camera still opens without one', !!d2.getElementById('camShutter'));
    });
  });
}


console.log('\n=== A photo can be required to skip a service ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];

  function seedFor(requirePhoto){
    return {
      technicians: [{id:'t1', name:'Alex'}],
      customers: [{id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1', hasPool:true}],
      settings: {requireSkipReason:false, requireSkipPhoto: requirePhoto},
      afterPhotoDefaultFixed: true
    };
  }

  // The setting exists on the website
  {
    const {dom} = load('customer-intake.html', {seed: {customers: []}});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    check('  the website offers the setting', !!d.getElementById('settingRequireSkipPhoto'));
    check('  it defaults to off', w.eval('appSettings.requireSkipPhoto') !== true);
  }

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    // Required
    {
      const {dom} = load(file, {seed: seedFor(true)});
      const w = dom.window, d = w.document;
      w.console.warn = ()=>{};
      try{
        w.eval("window.__r = 'pending';");
        w.eval("openSkipReasonModal({id:'a', name:'Alpha One'}).then(x => { window.__r = x ? 'skipped' : 'cancelled'; });");
        deferred.push(()=>{
          const btn = d.getElementById('skipPhotoBtn');
          check(file + ' the photo button says it is required',
                btn && btn.textContent.indexOf('required') !== -1,
                btn ? btn.textContent : 'missing');

          d.getElementById('skipReasonText').value = 'Gate was locked';
          d.getElementById('skipReasonSave').click();
          check(file + ' skipping is blocked without a photo',
                w.eval('window.__r') === 'pending', w.eval('window.__r'));

          // With a photo it goes through
          w.eval("photoData = 'data:image/jpeg;base64,AAAA';");
          d.getElementById('skipReasonSave').click();
        });
      }catch(e){ check(file + ' skip photo required', false, e.message); }
    }

    // Not required
    {
      const {dom} = load(file, {seed: seedFor(false)});
      const w = dom.window, d = w.document;
      w.console.warn = ()=>{};
      try{
        w.eval("window.__r = 'pending';");
        w.eval("openSkipReasonModal({id:'a', name:'Alpha One'}).then(x => { window.__r = x ? 'skipped' : 'cancelled'; });");
        deferred.push(()=>{
          const btn = d.getElementById('skipPhotoBtn');
          check(file + ' the photo button is optional',
                btn && btn.textContent.indexOf('required') === -1, btn ? btn.textContent : 'missing');

          d.getElementById('skipReasonText').value = 'Gate was locked';
          d.getElementById('skipReasonSave').click();
          // The promise resolves a tick later, so check the screen closed —
          // that only happens once the save is accepted
          check(file + ' skipping works without a photo',
                !d.getElementById('skipReasonSave'),
                d.getElementById('skipReasonSave') ? 'still open' : 'closed');
        });
      }catch(e){ check(file + ' skip photo optional', false, e.message); }
    }
  });
}


console.log('\n=== A customer moved in for the day drops off when serviced ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayName = DAYS[new Date().getDay()];
  const otherDay = DAYS[(new Date().getDay() + 3) % 7];
  const dnow = new Date();
  const iso = new Date(dnow.getTime() - dnow.getTimezoneOffset()*60000).toISOString().slice(0,10);

  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [
      {id:'a', name:'Alpha One', day: todayName, active:true, technicianId:'t1', hasPool:true},
      {id:'m', name:'Moved Mike', day: otherDay, active:true, technicianId:'t1', hasPool:true}
    ],
    rescheduledVisits: [{id:'r1', customerId:'m', fromDate:'2026-01-01', toDate: iso}],
    afterPhotoDefaultFixed: true
  };

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window, doc = w.document;
    w.console.warn = ()=>{};
    const box = ()=> doc.getElementById('homeCustomerList') || doc.getElementById('adminCustomerList');
    const onRoute = name => { const b = box(); return !!b && b.textContent.indexOf(name) !== -1; };

    try{
      w.eval("currentUser = {id:'t1', name:'Alex'}; adminViewTechId = 't1'; renderHomeList();");
      check(file + ' a moved-in customer appears on the route', onRoute('Moved'));
      check(file + ' alongside the regular ones', onRoute('Alpha'));

      w.eval("customers.find(c=>c.id==='a').lastServicedDate = todayDateStr();");
      w.eval("customers.find(c=>c.id==='m').lastServicedDate = todayDateStr();");
      w.eval("renderHomeList();");

      check(file + ' a regular customer drops off once serviced', !onRoute('Alpha'));
      check(file + ' a moved-in customer drops off too', !onRoute('Moved'),
            'still listed');
    }catch(e){
      check(file + ' moved-in customer handling', false, e.message);
    }
  });
}


console.log('\n=== Back never leaves the app ===');
{
  // The old cushion counted history entries in a variable and drifted out of
  // step with the browser. It is replaced by one guard entry that is pushed
  // back the instant it is consumed, so Back can never walk out.
  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' no longer counts history entries',
          src.indexOf('backEntries') === -1);
    check(file + ' tops the guard up on user gestures',
          src.indexOf("['pointerdown','touchstart','mousedown','keydown'].forEach") !== -1);
    check(file + ' remembers five places',
          src.indexOf('NAV_STACK_LIMIT = 5') !== -1);
    check(file + ' and does not record new places while going back',
          src.indexOf('if(navigatingBack) return;') !== -1);
  });
  // The behaviour itself is exercised in back-test.js, which needs real timing.
}

console.log('\n=== Readings are required per reading, not app-wide ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];

  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'c1', name:'Test', day: today, active:true, technicianId:'t1', hasPool:true}],
    settings: {showAfterPhotos:false, showBeforePhotos:false},
    afterPhotoDefaultFixed: true,
    chemConfig: {
      pool: {
        chemicals: [{key:'chlorine', label:'Free chlorine', required:true},
                    {key:'ph', label:'pH level'}],
        dosages: [{key:'tabs', label:'Chlorine tabs'}]
      },
      spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}
    }
  };

  ['customer-intake.html','technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' no longer offers the app-wide setting',
          src.indexOf('settingRequireReadings') === -1);
    check(file + ' and nothing reads it',
          src.indexOf('appSettings.requireReadings') === -1);
  });

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser={id:'t1',name:'Alex'}; openVisit('c1');");
      w.eval("currentVisibleSection='pool'; currentVisitStep=1;");
      check(file + ' a reading ticked Required is still enforced',
            w.eval('missingReadingFields().length') === 1,
            String(w.eval('missingReadingFields().length')));

      const el = d.getElementById('pool_chem_chlorine');
      if(el){ el.value = '3'; el.dispatchEvent(new w.Event('input', {bubbles:true})); }
      check(file + ' and satisfied once filled in',
            w.eval('missingReadingFields().length') === 0,
            String(w.eval('missingReadingFields().length')));
    }catch(e){ check(file + ' per-reading required', false, e.message); }
  });
}

console.log('\n=== New equipment photos go to the database, not the record ===');
{
  ['customer-intake.html','technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' saves a reference, not the image',
          src.indexOf("item.photos.push({id: photoId, stored: true, caption: ''});") !== -1);
    check(file + ' no save path writes dataUrl straight in',
          src.indexOf("      id: 'eqphoto_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),\n      dataUrl,") === -1);
    check(file + ' keeps the photo inline if the database refuses',
          src.indexOf("item.photos.push({id: photoId, dataUrl, caption: ''});") !== -1);
  });
}


console.log('\n=== Route Scheduling works without the map library ===');
{
  // Leaflet is loaded from the internet. Without it the whole view used to
  // throw and show nothing, taking the route list down with it.
  const seed = {
    customers: [
      {id:'a', name:'Alpha One', day:'Monday', active:true, address:'1 Main St'},
      {id:'b', name:'Bravo Two', day:'Monday', active:true, address:'2 Main St'}
    ],
    technicians: [{id:'t1', name:'Alex'}]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    check('  Leaflet is genuinely absent in this test', w.eval("typeof L") === 'undefined');
    w.eval("switchView('map');");
    check('  opening the view does not throw', true);

    const txt = d.getElementById('view-map').textContent.replace(/\s+/g, ' ');
    check('  a plain explanation replaces the map',
          txt.indexOf('needs an internet connection') !== -1, txt.slice(0, 60));
    check('  the rest of the page still renders',
          txt.indexOf('Route Scheduling') !== -1);
  }catch(e){
    check('  Route Scheduling without a map', false, e.message);
  }
}


console.log('\n=== Backwash and salt cell sit on the readings step ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1', hasPool:true,
      equipment:[{type:'Filter', filterTypeChoice:'Sand'},
                 {type:'Chlorination', chlorinationChoice:'Salt Cell'}]}],
    afterPhotoDefaultFixed: true,
    chemConfig: {pool:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[]},
                 spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  };

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser={id:'t1',name:'Alex'}; openVisit('a');");

      const box = d.getElementById('poolServiceChecks');
      const readings = d.getElementById('visitPoolSection');
      const fields = d.getElementById('poolChemFields');

      check(file + ' the checks exist', !!box);
      check(file + ' they are inside the readings card', readings && readings.contains(box));
      check(file + ' they sit above the reading fields',
            box && fields && (box.compareDocumentPosition(fields) & 4) !== 0);
      check(file + ' they are not in the after photo card',
            !d.getElementById('visitPoolPhotoSection').contains(box));

      deferred.push(()=>{
        check(file + ' backwash is offered for a sand filter',
              box.textContent.indexOf('Filter backwashed') !== -1, box.textContent.slice(0,60));
        check(file + ' salt cell is offered for a salt pool',
              box.textContent.indexOf('Salt cell cleaned') !== -1);

        const bw = d.getElementById('chkBackwashed');
        const sc = d.getElementById('chkSaltCell');
        if(bw && sc){
          const cellA = bw.parentElement, cellB = sc.parentElement;
          const row = cellA.parentElement;
          check(file + ' both sit on one row', row === cellB.parentElement);
          check(file + ' that row is a flex row', row.style.display === 'flex', row.style.display);
          check(file + ' each takes equal width', cellA.style.flexGrow === '1'
                && cellB.style.flexGrow === '1');
          check(file + ' the last-done note sits under each button',
                cellA.style.flexDirection === 'column');
          check(file + ' the buttons fill their half', bw.style.width === '100%');

          bw.click();
          check(file + ' tapping one records it', bw.dataset.on === 'true');
          check(file + ' and does not affect the other', sc.dataset.on === 'false');
          sc.click();
          check(file + ' the other toggles independently', sc.dataset.on === 'true');
        }
      });
    }catch(e){
      check(file + ' service checks placement', false, e.message);
    }
  });
}


console.log('\n=== Quick button colours ===');
{
  const seed = {
    customers: [{id:'a', name:'Alpha One', active:true}],
    chemConfig: {pool:{chemicals:[{key:'chlorine', label:'Free chlorine', buttons:[1,3]}], dosages:[]},
                 spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  };

  // The website can set a colour
  {
    const {dom} = load('customer-intake.html', {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    try{
      check('  a colour picker exists', w.eval("typeof openColorPicker") === 'function');
      check('  the editor offers a swatch',
            fs.readFileSync('customer-intake.html','utf8').indexOf("swatch.title = 'Change colour'") !== -1);

      w.eval("openColorPicker(chemConfig.pool.chemicals[0], 1, function(){});");
      const grid = d.getElementById('colorGrid');
      check('  the palette opens', !!grid);
      if(grid){
        const swatches = Array.from(grid.querySelectorAll('button'));
        check('  nine colours are offered', swatches.length === 9, swatches.length + ' offered');
        const red = swatches.find(b => /red/i.test(b.textContent));
        if(red){
          red.click();
          check('  picking one saves it against that button',
                w.eval("chemConfig.pool.chemicals[0].buttons[1].c") === 'red',
                w.eval("JSON.stringify(chemConfig.pool.chemicals[0].buttons[1])"));
        }
      }
    }catch(e){ check('  colour picker', false, e.message); }
  }

  // The field apps render it
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed: {
      technicians:[{id:'t1', name:'Alex'}],
      customers:[{id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1', hasPool:true}],
      afterPhotoDefaultFixed:true, settings:{showDosageSuggestions:true},
      chemConfig:{pool:{chemicals:[{key:'chlorine', label:'Free chlorine',
        buttons:[1, {v:3,c:'red'}, {v:5,c:'green'}]}], dosages:[]},
        spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
    }});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser={id:'t1',name:'Alex'}; openVisit('a');");
      const field = d.getElementById('pool_chem_chlorine').closest('.field');
      const btns = Array.from(field.querySelectorAll('button'))
        .filter(b => /^[0-9]/.test(b.textContent.trim()));
      const colours = btns.map(b => b.style.background || b.style.backgroundColor);
      check(file + ' renders each button in its own colour',
            new Set(colours).size === 3, colours.join(' | '));
      check(file + ' the values are unaffected',
            btns.map(b=>b.textContent.trim()).join(',') === '1,3,5');
    }catch(e){ check(file + ' coloured buttons', false, e.message); }
  });
}




// Checks that had to wait for an app to finish starting up.
setTimeout(()=>{
  deferred.forEach(fn => {
    try{ fn(); }catch(e){ check('deferred check', false, e.message); }
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}, 2500);
