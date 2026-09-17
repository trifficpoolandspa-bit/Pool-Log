// Part 4 of 4. The suite was one file until it grew past what could
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

console.log('\n=== Tasks: several customers, and repeats ===');
{
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [
      {id:'a', name:'Alpha One', active:true},
      {id:'b', name:'Bravo Two', active:true},
      {id:'c', name:'Charlie Three', active:true}
    ],
    chemConfig: {pool:{chemicals:[],dosages:[]}, spa:{chemicals:[],dosages:[]},
                 fountain:{chemicals:[],dosages:[]}}
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("switchView('workcenter');");
    d.getElementById('btnTypeTask').click();

    const opts = Array.from(d.getElementById('taskRepeat').options).map(o => o.value);
    check('  repeat covers weekly through four-weekly',
          ['none','1','2','3','4','custom'].every(v => opts.indexOf(v) !== -1), opts.join(','));

    // Customers are picked by search and shown as chips, as a work order does
    const s = d.getElementById('taskCustomerSearch');
    s.value = 'brav';
    s.dispatchEvent(new w.Event('input', {bubbles:true}));
    const sug = d.getElementById('taskCustomerSuggest');
    check('  typing suggests customers', sug.style.display === 'block', sug.textContent);
    sug.querySelector('button').click();
    check('  picking one adds a chip',
          d.getElementById('taskCustomerChips').textContent.indexOf('Bravo') !== -1);
    check('  and clears the search', s.value === '');

    s.value = 'alph';
    s.dispatchEvent(new w.Event('input', {bubbles:true}));
    d.getElementById('taskCustomerSuggest').querySelector('button').click();
    check('  several can be picked', w.eval('taskPicked.size') === 2);

    d.getElementById('taskTitle').value = 'Check the salt cell';
    d.getElementById('taskTechnician').value = 't1';
    d.getElementById('taskDate').value = '2026-09-14';
    d.getElementById('taskRepeat').value = '2';
    d.getElementById('taskRepeat').dispatchEvent(new w.Event('change', {bubbles:true}));
    d.getElementById('taskRepeatUntil').value = '2026-11-09';
    d.getElementById('btnSaveTask').click();

    const saved = JSON.parse(w.eval("JSON.stringify(lsGet('tasks') || [])"));
    check('  a fortnightly repeat creates each date', saved.length === 5, saved.length + ' created');
    check('  two weeks apart',
          saved[0].date === '2026-09-14' && saved[1].date === '2026-09-28',
          saved.map(t => t.date).join(','));
    check('  it stops at the until date',
          saved[saved.length - 1].date === '2026-11-09',
          saved[saved.length - 1].date);
    check('  each carries both customers',
          saved.every(t => (t.customerIds || []).length === 2));
    check('  they share a series so they can be removed together',
          new Set(saved.map(t => t.seriesId)).size === 1);
    check('  the form clears afterwards',
          d.getElementById('taskTitle').value === '' && w.eval('taskPicked.size') === 0);
    check('  the list says how often it repeats',
          d.getElementById('wcTaskList').textContent.indexOf('every 2 weeks') !== -1);

    // A one-off stays a one-off
    d.getElementById('taskTitle').value = 'One time only';
    d.getElementById('taskTechnician').value = 't1';
    d.getElementById('taskDate').value = '2026-09-15';
    d.getElementById('btnSaveTask').click();
    const after = JSON.parse(w.eval("JSON.stringify(lsGet('tasks') || [])"));
    check('  a task with no repeat is created once',
          after.filter(t => t.title === 'One time only').length === 1);
    check('  and with nobody attached when none were ticked',
          after.find(t => t.title === 'One time only').customerIds.length === 0);
  }catch(e){ check('  task customers and repeats', false, e.message); }

  // The field apps read the new shape
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const dnow = new Date();
  const iso = new Date(dnow.getTime() - dnow.getTimezoneOffset()*60000).toISOString().slice(0,10);

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed: {
      technicians: [{id:'t1', name:'Alex'}],
      customers: [{id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1', hasPool:true}],
      tasks: [
        {id:'x1', title:'Loose job', technicianId:'t1', date: iso, customerIds:[], done:false},
        {id:'x2', title:'At Alpha', technicianId:'t1', date: iso, customerIds:['a'], done:false}
      ],
      chemConfig: {pool:{chemicals:[],dosages:[]}, spa:{chemicals:[],dosages:[]},
                   fountain:{chemicals:[],dosages:[]}}
    }});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser = {id:'t1', name:'Alex'}; renderHomeList();");
      const card = d.getElementById('routeTaskCard');
      check(file + ' shows a task with nobody attached at the top',
            card.textContent.indexOf('Loose job') !== -1);
      check(file + ' but not one tied to a customer',
            card.textContent.indexOf('At Alpha') === -1);
      check(file + ' which is found against that customer instead',
            w.eval("tasksForCustomer('a').length") === 1);
    }catch(e){ check(file + ' task shape', false, e.message); }
  });
}


console.log('\n=== The task form mirrors the work order ===');
{
  const {dom} = load('customer-intake.html', {seed: {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', active:true}],
    chemConfig: {pool:{chemicals:[],dosages:[]}, spa:{chemicals:[],dosages:[]},
                 fountain:{chemicals:[],dosages:[]}}
  }});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  const labels = el => Array.from(el.querySelectorAll('.field > label'))
    .map(l => l.textContent.replace(/\s+/g, ' ').trim());

  try{
    w.eval("switchView('workcenter');");
    d.getElementById('btnTypeTask').click();
    const task = labels(d.getElementById('wcTaskSection'));

    check('  the date comes first', task[0] === 'Scheduled date', task.join(' | '));
    check('  then the customer', task[1].indexOf('Customer') === 0, task.join(' | '));
    check('  then the task itself', task[2] === 'Task', task.join(' | '));
    check('  then the details', task[3].indexOf('Details') === 0, task.join(' | '));
    check('  then the technician', task[4] === 'Saved technician', task.join(' | '));

    check('  the date field is styled like the work order one',
          d.getElementById('taskDate').style.width === 'auto');

    const src = fs.readFileSync('customer-intake.html','utf8');
    check('  the work order says Saved technician too',
          src.indexOf('<label>Assign to technician</label>') === -1
          && (src.match(/<label>Saved technician<\/label>/g) || []).length === 2,
          (src.match(/<label>Saved technician<\/label>/g) || []).length + ' found');
  }catch(e){ check('  task form layout', false, e.message); }
}


console.log('\n=== Customer Customization opens blank each time ===');
{
  const {dom} = load('customer-intake.html', {seed: {
    customers: [{id:'a', name:'Alpha One', active:true, hasPool:true},
                {id:'b', name:'Bravo Two', active:true, hasPool:true}],
    chemConfig: {pool:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[]},
                 spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  }});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("switchView('customerconfig');");
    check('  it starts with nobody chosen', w.eval('customCustomerId') === null);

    // Picking a customer must leave the page where it is — jumping to the top
    // meant scrolling back down for every customer in a row
    w.__scrolls = [];
    const realScroll = w.scrollTo;
    w.scrollTo = (a)=>{ w.__scrolls.push(a); };
    w.eval("openCustomSetup(customers[0], ['pool'])");
    check('  choosing one does not jump to the top',
          w.__scrolls.length === 0, JSON.stringify(w.__scrolls));
    w.scrollTo = realScroll;

    w.eval("openCustomSetup(customers[0], ['pool']);");
    check('  choosing a customer loads them', w.eval("customCustomerId") === 'a');
    check('  and fills the search box',
          d.getElementById('customCustSearch').value.indexOf('Alpha') !== -1);
    check('  showing their own settings',
          d.getElementById('customerNotifyCard').style.display === 'block');

    w.eval("switchView('customers'); switchView('customerconfig');");
    check('  leaving and returning clears the customer',
          w.eval('customCustomerId') === null);
    check('  the search box is empty again',
          d.getElementById('customCustSearch').value === '');
    check('  the body of water is cleared too', w.eval('customBodyKey') === null);
    check('  and their settings card is hidden',
          d.getElementById('customerNotifyCard').style.display === 'none');
  }catch(e){
    check('  customer customization reset', false, e.message);
  }
}


console.log('\n=== Automatic on my way: app-wide, with per-customer override ===');
{
  // The setting exists and defaults to off
  {
    const {dom} = load('customer-intake.html', {seed: {customers: []}});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    check('  Settings offers it for every customer',
          !!d.getElementById('settingAutoNotifyAll'));
    check('  it is off by default', w.eval('appSettings.autoNotifyAll') !== true);
    check('  the stops setting is hidden while off',
          d.getElementById('settingAutoNotifyLeadField').style.display === 'none');

    d.getElementById('settingAutoNotifyAll').click();
    check('  turning it on saves', w.eval('appSettings.autoNotifyAll') === true);
    check('  and reveals the stops setting',
          d.getElementById('settingAutoNotifyLeadField').style.display === 'block');
  }

  // Precedence in the field
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];

  function fires(file, settings, custMods){
    const custs = ['A','B','C','D','E'].map((n,i)=>({
      id:'c'+i, name:'Cust '+n, day: today, active:true, technicianId:'t1',
      hasPool:true, phone:'5550'+i
    }));
    Object.keys(custMods || {}).forEach(k => Object.assign(custs[k], custMods[k]));

    const {dom} = load(file, {seed: {
      technicians: [{id:'t1', name:'Alex'}],
      customers: custs,
      afterPhotoDefaultFixed: true,
      settings: settings,
      chemConfig: {pool:{chemicals:[{key:'chlorine',label:'x'}],dosages:[]},
                   spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
    }});
    const w = dom.window;
    w.console.warn = ()=>{};
    w.eval("currentUser = {id:'t1', name:'Alex'}; renderHomeList();");
    w.eval("window.__sentTo = null; sendOnMyWay = (c)=>{ window.__sentTo = c.name; };");
    w.eval("checkHeadsUpAfter('c1');");
    return w.eval('window.__sentTo');
  }

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    check(file + ' nothing fires with everything off',
          fires(file, {autoNotifyAll:false}, {}) === null);
    check(file + ' the app-wide setting covers everyone',
          fires(file, {autoNotifyAll:true, autoNotifyAllLead:2}, {}) === 'Cust D');
    check(file + ' a customer turned off is respected',
          fires(file, {autoNotifyAll:true, autoNotifyAllLead:2}, {3:{autoNotify:false}}) === null);
    check(file + ' a customer turned on works with it off',
          fires(file, {autoNotifyAll:false}, {3:{autoNotify:true, autoNotifyLead:2}}) === 'Cust D');
  });
}


console.log('\n=== The task card has no redundant heading ===');
{
  const {dom} = load('customer-intake.html', {seed: {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', active:true}],
    tasks: [{id:'x1', title:'Check the salt cell', technicianId:'t1',
             date:'2026-09-14', customerIds:[], done:false}],
    chemConfig: {pool:{chemicals:[],dosages:[]}, spa:{chemicals:[],dosages:[]},
                 fountain:{chemicals:[],dosages:[]}}
  }});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("switchView('workcenter');");
    d.getElementById('btnTypeTask').click();

    const h = d.getElementById('wcTaskHeading');
    check('  nothing is shown when writing a new task', h.style.display === 'none');
    check('  the Saved tasks button is still there', !!d.getElementById('btnTaskTemplates'));
    check('  the card starts with the date',
          d.querySelector('#wcTaskSection .field label').textContent === 'Scheduled date');

    // Editing still says so, since that is the one time it matters
    Array.from(d.querySelectorAll('#wcTaskList button'))
      .find(b => b.textContent === 'Edit').click();
    check('  editing names the task being changed',
          h.style.display !== 'none' && h.textContent.indexOf('Check the salt cell') !== -1,
          h.textContent);

    d.getElementById('btnClearTask').click();
    check('  clearing hides it again', h.style.display === 'none');
  }catch(e){ check('  task heading', false, e.message); }
}


console.log('\n=== Quote and work order forms have no redundant heading ===');
{
  const {dom} = load('customer-intake.html', {seed: {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', active:true, email:'a@x.com'}],
    workOrders: [{id:'w1', type:'Quote', customerId:'a', customerIds:['a'],
                  lineItems:[{desc:'Filter clean', amount:'85'}], total:85,
                  notes:'', date:'2026-09-14', status:'draft'}],
    chemConfig: {pool:{chemicals:[],dosages:[]}, spa:{chemicals:[],dosages:[]},
                 fountain:{chemicals:[],dosages:[]}}
  }});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    const h = ()=> d.getElementById('wcFormHeading');
    w.eval("switchView('workcenter');");
    check('  nothing above the Quote form', h().style.display === 'none');
    check('  it starts at the date field',
          d.querySelector('#wcQuotesSection .field label').textContent === 'Date');

    d.getElementById('btnTypeWorkOrder').click();
    check('  nothing above the Work Order form either', h().style.display === 'none');

    d.getElementById('btnTypeTask').click();
    check('  still nothing on the Task tab', h().style.display === 'none');

    d.getElementById('btnTypeQuote').click();
    check('  and nothing coming back to Quote', h().style.display === 'none');

    // Editing is the one case worth labelling
    w.eval("loadWorkOrderIntoForm(workOrders[0]);");
    deferred.push(()=>{
      check('  editing a saved one says so',
            h().style.display !== 'none'
            && h().textContent.indexOf('Editing a saved') === 0, h().textContent);
      d.getElementById('btnClearWorkOrder').click();
      check('  and clearing hides it again', h().style.display === 'none');
    });
  }catch(e){ check('  work order heading', false, e.message); }
}


console.log('\n=== Arrow keys step between customers ===');
{
  const {dom} = load('customer-intake.html', {seed: {
    customers: [
      {id:'a', name:'Alpha One', active:true, hasPool:true},
      {id:'b', name:'Bravo Two', active:true, hasPool:true},
      {id:'c', name:'Charlie Three', active:true, hasPool:true}
    ],
    chemConfig: {pool:{chemicals:[],dosages:[]}, spa:{chemicals:[],dosages:[]},
                 fountain:{chemicals:[],dosages:[]}}
  }});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  const press = k => d.dispatchEvent(new w.KeyboardEvent('keydown',
    {key: k, bubbles:true, cancelable:true}));
  const who = ()=> w.eval('profileCustomerId');

  try{
    w.eval("switchView('customers'); viewCustomer(customers[0]);");
    const first = who();
    check('  a profile opens', !!first);

    press('ArrowRight');
    const second = who();
    check('  the right arrow moves on', second !== first, first + ' -> ' + second);

    press('ArrowLeft');
    check('  the left arrow moves back', who() === first, who() + ' vs ' + first);

    // It must match what the buttons do
    w.eval("viewCustomer(customers[0]);");
    d.getElementById('btnNextCustomer').click();
    const byButton = who();
    w.eval("viewCustomer(customers[0]);");
    press('ArrowRight');
    check('  the arrow matches the Next button', who() === byButton,
          who() + ' vs ' + byButton);

    // At the end it stops rather than wrapping
    for(let i = 0; i < 5; i++) press('ArrowRight');
    const atEnd = who();
    press('ArrowRight');
    check('  it stops at the last customer', who() === atEnd);

    // Typing is not hijacked
    w.eval("viewCustomer(customers[0]);");
    const before = who();
    const input = d.querySelector('#view-customers input');
    if(input){
      input.focus();
      press('ArrowRight');
      check('  typing in a field is left alone', who() === before);
      input.blur();
    }

    // Other views are unaffected
    w.eval("switchView('settings');");
    const onSettings = who();
    press('ArrowRight');
    check('  it does nothing on another page', who() === onSettings);

    // And not while a dialog is open
    w.eval("switchView('customers'); viewCustomer(customers[0]);");
    const beforeDialog = who();
    const overlay = d.createElement('div');
    overlay.className = 'confirm-overlay';
    d.body.appendChild(overlay);
    press('ArrowRight');
    check('  it does nothing while a dialog is up', who() === beforeDialog);
    d.body.removeChild(overlay);
  }catch(e){ check('  arrow key navigation', false, e.message); }
}


console.log('\n=== Required is a readings-only setting ===');
{
  const {dom} = load('customer-intake.html', {seed: {customers: []}});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("switchView('chemconfig');");
    const reqIn = id => Array.from(
      (d.getElementById(id) || {querySelectorAll: ()=>[]}).querySelectorAll('label')
    ).filter(l => /^Required/.test(l.textContent.trim())).length;
    const itemsIn = id => (d.getElementById(id) || {children: []}).children.length;

    check('  readings are listed', itemsIn('chemConfigChemicalsList') > 0);
    check('  dosages are listed', itemsIn('chemConfigDosagesList') > 0);
    check('  every reading keeps its Required box',
          reqIn('chemConfigChemicalsList') === itemsIn('chemConfigChemicalsList'),
          reqIn('chemConfigChemicalsList') + ' of ' + itemsIn('chemConfigChemicalsList'));
    check('  no dosage has one',
          reqIn('chemConfigDosagesList') === 0, String(reqIn('chemConfigDosagesList')));
  }catch(e){ check('  required checkbox placement', false, e.message); }
}


console.log('\n=== New technicians require an after photo ===');
{
  const {dom} = load('customer-intake.html', {seed: {customers: [], technicians: []}});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("switchView('technicians');");
    const show = d.getElementById('btnShowTechForm') || d.getElementById('btnNewTechnician');
    if(show) show.click();

    const name = d.getElementById('techName');
    name.value = 'Sam Rivera';
    name.dispatchEvent(new w.Event('input', {bubbles:true}));

    const save = d.getElementById('btnSaveTechnician') || d.getElementById('btnSaveTech');
    if(save) save.click();

    deferred.push(()=>{
      const techs = JSON.parse(w.eval("JSON.stringify(lsGet('technicians') || [])"));
      // The build seeds beta tester accounts on an empty device, so look for
      // the one just added rather than expecting a list of one
      const sam = techs.find(t => t.name === 'Sam Rivera');
      check('  the technician is created', !!sam, techs.length + ' saved');
      if(sam){
        check('  and requires an after photo by default',
              sam.requireAfterPhoto === true, String(sam.requireAfterPhoto));
      }
    });
  }catch(e){ check('  new technician defaults', false, e.message); }
}


console.log('\n=== Photo requirements are not set per technician ===');
{
  // Before and after requirements live per body of water on Readings and
  // Dosages. Having them settable per technician as well meant two places to
  // check when a photo was unexpectedly demanded.
  const {dom} = load('admin-readings-app.html', {seed: {
    customers: [], technicians: [{id:'t1', name:'Alex'}]
  }});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  try{
    w.eval('loadAdminTechnicians();');
    w.eval("openTechEditor(adminTechnicians[0])");
    check('  the before photo tick is gone', !d.getElementById('tcRequireBefore'));
    check('  the after photo tick is gone', !d.getElementById('tcRequireAfter'));
    check('  the gate photo tick remains', !!d.getElementById('tcRequireGate'));

    ['technician-app.html','admin-readings-app.html'].forEach(file=>{
      const src = fs.readFileSync(file, 'utf8');
      check(file + ' no longer reads a per-technician before requirement',
            src.indexOf("techRequires('requireBeforePhoto')") === -1);
      check(file + ' nor a per-technician after requirement',
            src.indexOf("techRequires('requireAfterPhoto')") === -1);
    });
  }catch(e){ check('  technician photo requirements', false, e.message); }
}

console.log('\n=== Password fields can be revealed ===');
{
  [['technician-app.html','loginPassword'],
   ['admin-readings-app.html','loginPassword'],
   ['customer-intake.html','techPassword']].forEach(([file, fieldId])=>{
    const {dom} = load(file, {seed: {customers: []}});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    try{
      const input = d.getElementById(fieldId);
      check(file + ' has its password field', !!input);
      if(!input) return;

      const btn = input.parentElement.querySelector('button');
      check(file + ' with an eye button beside it', !!btn);
      check(file + ' hidden to begin with', input.type === 'password');

      input.value = 'secret123';
      btn.click();
      check(file + ' pressing it shows the password', input.type === 'text');
      check(file + ' and the button says so now', btn.title === 'Hide password');

      btn.click();
      check(file + ' pressing again hides it', input.type === 'password');
      check(file + ' without losing what was typed', input.value === 'secret123');
    }catch(e){ check(file + ' password reveal', false, e.message); }
  });

  // The landing page has a password field too, and was missed first time
  ['index.html','technician-app.html','admin-readings-app.html','customer-intake.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' can reveal a password', src.indexOf('function addPasswordReveal') !== -1);

    // A revealed password must never survive leaving the page — it would sit
    // there in plain text for whoever picks the device up next
    check(file + ' hides it again when the field is left',
          src.indexOf("input.addEventListener('blur', hide)") !== -1);
    check(file + ' and when the app is switched away from',
          src.indexOf("if(document.hidden) hide()") !== -1);
    check(file + ' and on leaving the page',
          src.indexOf("window.addEventListener('pagehide', hide)") !== -1);
  });

  // Driven, not just read from the source
  [['customer-intake.html','sitePassword'],
   ['index.html','loginPassword']].forEach(([file, fieldId])=>{
    const {dom} = load(file, {seed: {customers: []}});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    const el = d.getElementById(fieldId);
    if(!el){ check(file + ' has ' + fieldId, false); return; }
    const btn = el.parentElement.querySelector('button');
    el.value = 'secret123';
    btn.click();
    check(file + ' revealing shows the password', el.type === 'text');
    el.dispatchEvent(new w.Event('blur'));
    check(file + ' leaving the field hides it again', el.type === 'password', el.type);
    btn.click();
    Object.defineProperty(d, 'hidden', {value: true, configurable: true});
    d.dispatchEvent(new w.Event('visibilitychange'));
    check(file + ' switching away hides it too', el.type === 'password', el.type);
  });

  // Nothing should be left uncovered
  ['technician-app.html','admin-readings-app.html','customer-intake.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' covers every password field automatically',
          src.indexOf("document.querySelectorAll('input[type=\"password\"]')") !== -1);
  });
}


console.log('\n=== Photo requirements are per body of water, independently ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    // The technician record still carries the old flag, as a real one would
    // after today's change — it must be ignored entirely.
    const {dom} = load(file, {seed: {
      technicians: [{id:'t1', name:'Alex', requireAfterPhoto:true, requireBeforePhoto:true}],
      customers: [{id:'a', name:'Alpha', day: today, active:true, technicianId:'t1',
                   hasPool:true, hasSpa:true, fountains:[{id:'f1', name:'Front'}]}],
      afterPhotoDefaultFixed: true,
      settings: {requireAfterPhotos:false, requireBeforePhotos:false},
      chemConfig: {
        pool: {chemicals:[{key:'chlorine',label:'FC'}], dosages:[], requireAfterPhoto:true},
        spa:  {chemicals:[{key:'chlorine',label:'FC'}], dosages:[]},
        fountain: {chemicals:[{key:'chlorine',label:'FC'}], dosages:[]}
      }
    }});
    const w = dom.window;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser={id:'t1',name:'Alex'}; renderHomeList(); openVisit('a');");
      deferred.push(()=>{
        check(file + ' the pool tick applies to the pool',
              w.eval('afterPhotoRequiredFor("pool")') === true);
        check(file + ' but NOT to the spa',
              w.eval('afterPhotoRequiredFor("spa")') === false);
        w.eval("currentVisitFountainId='f1';");
        check(file + ' nor to a fountain',
              w.eval('afterPhotoRequiredFor("fountain")') === false);
        check(file + ' a stale technician flag is ignored',
              w.eval('afterPhotoRequiredFor("spa")') === false);
      });
    }catch(e){ check(file + ' per-body photo requirements', false, e.message); }
  });
}

console.log('\n=== Coming back to a finished body shows what was recorded ===');
{
  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' restores a finished section',
          src.indexOf('function restoreFinishedSection') !== -1);
    check(file + ' and does it when switching sections',
          src.indexOf('restoreFinishedSection(currentVisibleSection)') !== -1);
  });
}


console.log('\n=== Visit headings and buttons read consistently ===');
['technician-app.html','admin-readings-app.html'].forEach(file=>{
  const src = fs.readFileSync(file, 'utf8');
  // Every body of water calls the readings step the same thing
  check(file + ' no spa-only wording', src.indexOf("Today's spa strip") === -1);
  check(file + ' no fountain-only wording',
        src.indexOf("sectionLabel(customer, sectionId) + ' readings'") === -1);
  check(file + ' all three say Chemical Readings',
        (src.match(/<h2[^>]*>Chemical Readings<\/h2>/g) || []).length === 3,
        String((src.match(/<h2[^>]*>Chemical Readings<\/h2>/g) || []).length));

  // Photos capitalised like Chemicals Added
  check(file + ' Before Photos is capitalised',
        src.indexOf('<h2>Before photos</h2>') === -1
        && src.indexOf('<h2>Before Photos</h2>') !== -1);
  check(file + ' After Photos is capitalised',
        src.indexOf('<h2>After photos</h2>') === -1
        && src.indexOf('<h2>After Photos</h2>') !== -1);
  check(file + ' and in the step bar too',
        src.indexOf("'After photos \\u2192'") === -1
        && src.indexOf("'After Photos \\u2192'") !== -1);

  check(file + ' the next body of water is capitalised',
        src.indexOf('capitaliseFirst(nextBodyLabel())') !== -1);
});


console.log('\n=== Turning a photo step on does NOT force the requirement ===');
{
  // The app-wide requirement is inherited by every body of water whose own tick
  // is not set. Forcing it on when the step is enabled made spa and fountain
  // demand a photo while their boxes looked unticked.
  [['admin-readings-app.html','options'], ['customer-intake.html','settings']].forEach(([file, view])=>{
    const {dom} = load(file, {seed: {
      customers: [],
      settings: {showBeforePhotos:false, showAfterPhotos:false, showGatePhoto:false,
                 requireBeforePhotos:false, requireAfterPhotos:false, requireGatePhoto:false}
    }});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    try{
      w.eval("switchView('" + view + "');");
      [['settingBeforePhotos','showBeforePhotos','requireBeforePhotos'],
       ['settingAfterPhotos','showAfterPhotos','requireAfterPhotos'],
       ['settingGatePhoto','showGatePhoto','requireGatePhoto']].forEach(([toggleId, showKey, reqKey])=>{
        const step = d.getElementById(toggleId);
        if(!step){ check(file + ' has ' + toggleId, false); return; }
        step.checked = true;
        step.dispatchEvent(new w.Event('change', {bubbles:true}));
        check(file + ' the step turns on', w.eval('appSettings.' + showKey) === true);
        check(file + ' without forcing ' + reqKey,
              w.eval('appSettings.' + reqKey) !== true,
              String(w.eval('appSettings.' + reqKey)));
      });
    }catch(e){ check(file + ' photo step toggles', false, e.message); }
  });

  ['admin-readings-app.html','customer-intake.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' has no app-wide requireAfterPhotos default at all',
          src.indexOf('requireAfterPhotos') === -1);
  });
}


console.log('\n=== Photo settings point at Readings and Dosages ===');
{
  // Required is set per body of water, in one place. Having it in Settings too
  // meant an app-wide value every unset body silently inherited.
  [['admin-readings-app.html','options'], ['customer-intake.html','settings']].forEach(([file, view])=>{
    const {dom} = load(file, {seed: {customers: []}});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    try{
      w.eval("switchView('" + view + "');");
      ['settingRequireBeforePhotos','settingRequireAfterPhotos','settingRequireGatePhoto']
        .forEach(id => check(file + ' no ' + id + ' in Settings', !d.getElementById(id)));

      ['settingBeforePhotos','settingAfterPhotos','settingGatePhoto']
        .forEach(id => check(file + ' but ' + id + ' is still there', !!d.getElementById(id)));

      const src = fs.readFileSync(file, 'utf8');
      check(file + ' before photos points at Readings and Dosages',
            src.indexOf('tick Required next to that body of water on Readings and Dosages') !== -1);
      check(file + ' the gate points at the Pool tab specifically',
            src.indexOf('tick Required on the Pool tab of Readings and Dosages') !== -1);
      check(file + ' and explains why the gate has no Spa tick',
            src.indexOf('no separate tick on Spa or Extra') !== -1);
    }catch(e){ check(file + ' photo settings', false, e.message); }
  });
}

console.log('\n=== The route can be reversed ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed: {
      technicians: [{id:'t1', name:'Alex'}],
      customers: ['Alpha','Bravo','Charlie','Delta'].map((n,i)=>
        ({id:'c'+i, name:n, day: today, active:true, technicianId:'t1', hasPool:true})),
      afterPhotoDefaultFixed: true
    }});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser={id:'t1',name:'Alex'}; renderHomeList();");
      const order = ()=> JSON.parse(w.eval('JSON.stringify(routeOrderToday().map(c=>c.name))'));

      check(file + ' has a reverse button', !!d.getElementById('btnReverseRoute'));
      const before = order();
      check(file + ' the route starts in order',
            before.join(',') === 'Alpha,Bravo,Charlie,Delta', before.join(','));

      d.getElementById('btnReverseRoute').click();
      const after = order();
      check(file + ' pressing it puts the last stop first',
            after.join(',') === 'Delta,Charlie,Bravo,Alpha', after.join(','));

      d.getElementById('btnReverseRoute').click();
      check(file + ' pressing it again restores the original',
            order().join(',') === before.join(','), order().join(','));

      check(file + ' and the order is saved, not just displayed',
            w.eval("JSON.stringify(lsGet('fieldRouteOrder') || {})") !== '{}');

      // It offers the same choice a drag reorder does
      w.eval("confirmDialog = ()=> Promise.resolve(true);");
      d.getElementById('btnReverseRoute').click();
      const banner = d.getElementById('orderBanner');
      check(file + ' reversing raises the keep-it banner',
            banner && banner.style.display !== 'none');
      check(file + ' offering today, every week, or put it back',
            banner && /Just today/.test(banner.textContent)
                   && /Every week/.test(banner.textContent)
                   && /Remove changes/.test(banner.textContent));
    }catch(e){ check(file + ' reverse route', false, e.message); }
  });
}


console.log('\n=== A photo step switched off disables its per-body tick ===');
{
  function pool(settings){
    const {dom} = load('customer-intake.html', {seed: {customers: [], settings: settings}});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    w.eval("switchView('chemconfig'); selectedChemConfigType='pool'; renderPhotoRequirements();");
    return {
      gate: d.getElementById('chkRequireGatePhoto'),
      before: d.getElementById('chkRequireBeforePhoto'),
      after: d.getElementById('chkRequireAfterPhoto'),
      note: d.getElementById('photoRequireNote')
    };
  }

  try{
    let p = pool({showGatePhoto:true, showBeforePhotos:true, showAfterPhotos:true});
    check('  with every step on, all three ticks are usable',
          !p.gate.disabled && !p.before.disabled && !p.after.disabled);

    p = pool({showGatePhoto:false, showBeforePhotos:true, showAfterPhotos:true});
    check('  the gate step off disables the gate tick', p.gate.disabled === true);
    check('  and leaves the others alone',
          !p.before.disabled && !p.after.disabled);
    check('  with a note naming the gate photo',
          p.note.style.display !== 'none' && /Gate photo/.test(p.note.textContent),
          p.note.textContent);

    p = pool({showGatePhoto:true, showBeforePhotos:false, showAfterPhotos:true});
    check('  the before step off disables only that one',
          p.before.disabled === true && p.gate.disabled === false);
  }catch(e){ check('  per-body photo ticks', false, e.message); }
}


console.log('\n=== No development shortcuts remain ===');
{
  // These were fine while only I was using the app. They are not fine on a
  // link handed to beta testers.
  ['customer-intake.html','technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' has no Skip sign-in button', src.indexOf('btnDevSkip') === -1);
    check(file + ' has no ?dev=1 bypass', src.indexOf("get('dev') === '1'") === -1);
    check(file + ' has no devMode flag', src.indexOf('devMode') === -1);
    check(file + ' has no manual photo migration button',
          src.indexOf('btnMovePhotos') === -1);
  });

  // And signing in is genuinely required
  [['technician-app.html','https://example.com/t.html?dev=1'],
   ['admin-readings-app.html','https://example.com/a.html?dev=1']].forEach(([file, url])=>{
    const {dom} = load(file, {seed: {
      customers: [],
      technicians: [{id:'t1', name:'Alex', username:'alex', password:'pw1', isAdmin:true}]
    }, url: url});
    const d = dom.window.document;
    // Checked after startup: the login screen is shown by init, not by the
    // markup, so reading it immediately catches it mid-setup
    deferred.push(()=>{
      const login = d.getElementById('view-login') || d.getElementById('loginScreen');
      check(file + ' still asks for a sign-in with ?dev=1',
            !!login && login.style.display !== 'none',
            login ? login.style.display : 'no login element');
      check(file + ' and nobody is signed in',
            dom.window.eval('currentUser') === null);
    });
  });
}


console.log('\n=== The starter account is gone; the field apps sign in against the server ===');
{
  // The field apps used to carry a starter login in the public files. Sign-in
  // is now a server account per technician (fieldauth-test.js drives it).
  ['index.html','technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' carries no starter account', src.indexOf('BETA_ACCOUNTS') === -1 && src.indexOf('letmein') === -1);
    check(file + ' never compares a password stored on the phone', src.indexOf('t.password === p') === -1);
    check(file + ' signs in against the server', src.indexOf('async function fieldSignIn') !== -1
          && src.indexOf("grant_type=password") !== -1);
  });

  // The landing page must not hand out a way past the sign-in
  const idx = fs.readFileSync('index.html', 'utf8');
  check('the landing page has no dev shortcut buttons',
        idx.indexOf('btnDevTech') === -1 && idx.indexOf('btnDevAdmin') === -1);
  check('and no ?dev=1 links', idx.indexOf('dev=1') === -1);
  check('but still offers the office site', idx.indexOf('btnOfficeSite') !== -1);

  // Nothing is created on a fresh phone any more
  const {dom} = load('technician-app.html', {seed: {customers: []}});
  deferred.push(()=>{
    check('a fresh phone gets no technicians made up for it',
          dom.window.localStorage.getItem('poollog:technicians') === null,
          String(dom.window.localStorage.getItem('poollog:technicians')));
    check('and nobody is signed in', dom.window.eval('currentUser') === null);
  });

  // A device's own technician profiles are left alone
  const own = load('technician-app.html', {seed: {
    customers: [],
    technicians: [{id:'x', name:'Their Own Person', username:'bob'}]
  }});
  deferred.push(()=>{
    const list = JSON.parse(own.dom.window.localStorage.getItem('poollog:technicians'));
    check('an existing technician list is left alone',
          list.length === 1 && list[0].name === 'Their Own Person',
          JSON.stringify(list.map(t=>t.name)));
  });
}


console.log('\n=== The office account lives on the server ===');
{
  // The office site signs in against Supabase now, so the Plan tab shows the
  // account rather than offering to edit a local username and password that
  // no longer control anything.
  const src = fs.readFileSync('customer-intake.html', 'utf8');
  check('  there is no local username box', src.indexOf('id="acctUsername"') === -1);
  check('  nor a local password box', src.indexOf('id="acctPassword"') === -1);
  check('  the account is shown instead', src.indexOf('id="acctSignInWho"') !== -1);
  check('  sign-in goes to the server', src.indexOf('grant_type=password') !== -1);
  check('  the session is checked, not trusted', src.indexOf('async function sbWhoAmI') !== -1);
  check('  an expired token is refreshed', src.indexOf('grant_type=refresh_token') !== -1);
  check('  and a dead connection does not throw',
        src.indexOf('return {ok: false, status: 0, body: null, offline: true};') !== -1);
  check('  the field apps sign in against the same server',
        fs.readFileSync('technician-app.html','utf8').indexOf("FIELD_SUPABASE_URL = 'https://myxxahrlmzvrbcmopwyo.supabase.co'") !== -1);
}

console.log('\n=== Technicians cannot open the office site ===');
{
  // The site holds every customer, price and setting. A technician's login is
  // for the field apps only.
  const {dom} = load('customer-intake.html');
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};
  try{
    deferred.push(()=>{
      const screen = d.getElementById('loginScreen');
      check('  the site asks for a sign-in',
            !!screen && screen.style.display === 'flex');

      // Add a technician, then try their login on the site
      w.eval("technicians.push({id:'t9', name:'Sam Tech', username:'sam', password:'sampass'}); saveTechnicians();");
      // Signing in needs a server now, so this is checked from the source
      // rather than driven; the live paths are covered by a stubbed run.
      const siteSrc = fs.readFileSync('customer-intake.html', 'utf8');
      check('  the site asks for an email, not a username',
            siteSrc.indexOf('id="siteUsername" type="email"') !== -1);
      check('  a technician list is never consulted for the office login',
            siteSrc.indexOf("say('No owner account set up on this device yet.')") === -1);

      check('  the site keeps its own session, not the field apps\u2019',
            fs.readFileSync('customer-intake.html','utf8').indexOf("lsGet('sbSession')") !== -1);
      check('  and the owner is stored separately from technicians',
            w.eval("JSON.stringify(lsGet('ownerAccount'))").indexOf('poollog') !== -1);

      // Signing out still returns the page to the customer list. Signing back
      // in needs a server, so that half is covered by the stubbed run.
      w.eval("switchView('account');");
      w.eval('siteLogout();');
      check('  signing out puts the screen back',
            d.getElementById('loginScreen').style.display === 'flex');
    });

    check('  there is a sign out on the Account page', !!d.getElementById('btnSiteLogout'));
  }catch(e){ check('  office site sign-in', false, e.message); }
}




// Checks that had to wait for an app to finish starting up.

console.log('\n=== Phone numbers format themselves ===');
{
  ['customer-intake.html','technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' has the formatter', src.indexOf('function formatPhoneNumber') !== -1);
    check(file + ' and finds every phone field',
          src.indexOf('input[type="tel"]') !== -1);
  });

  const {dom} = load('customer-intake.html', {seed: {customers: []}});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};
  try{
    const f = (raw)=> w.eval('formatPhoneNumber(' + JSON.stringify(raw) + ')');
    check('  ten digits become a formatted number',
          f('6235550142') === '(623) 555-0142', f('6235550142'));
    check('  spaces and dashes are tidied the same way',
          f('623 555 0142') === '(623) 555-0142' && f('623-555-0142') === '(623) 555-0142');
    check('  an already formatted number is left alone',
          f('(623) 555-0142') === '(623) 555-0142');
    check('  a leading country code is dropped',
          f('16235550142') === '(623) 555-0142', f('16235550142'));
    check('  an overseas number is not mangled',
          f('+44 20 7946 0958') === '+44 20 7946 0958', f('+44 20 7946 0958'));
    check('  an extension is left as typed',
          f('555-0142 ext 12') === '555-0142 ext 12', f('555-0142 ext 12'));
    check('  a half typed number formats as far as it goes',
          f('623555') === '(623) 555', f('623555'));
    check('  and empty stays empty', f('') === '');

    // Typing into a real field
    const el = d.getElementById('icPhone');
    check('  the field is a phone field', el && el.type === 'tel');
    check('  with a numeric keypad', el && el.getAttribute('inputmode') === 'tel');
    if(el){
      '6235550142'.split('').forEach(ch=>{
        el.value += ch;
        el.selectionStart = el.selectionEnd = el.value.length;
        el.dispatchEvent(new w.Event('input', {bubbles:true}));
      });
      check('  typing digits produces a formatted number',
            el.value === '(623) 555-0142', el.value);

      // Backspace must not fight the person
      el.value = el.value.slice(0, -1);
      el.dispatchEvent(new w.Event('input', {bubbles:true}));
      check('  deleting a character actually deletes it',
            el.value === '(623) 555-014', el.value);
    }
  }catch(e){ check('  phone formatting', false, e.message); }
}

console.log('\n=== Serviced today lists the most recent visit first ===');
['technician-app.html', 'admin-readings-app.html'].forEach(file=>{
  const {dom} = load(file, {seed: {customers: [
    {id:'early',  name:'Early Pool',  active:true},
    {id:'late',   name:'Late Pool',   active:true},
    {id:'nostamp',name:'Untimed Pool',active:true},
    {id:'middle', name:'Middle Pool', active:true},
    {id:'old',    name:'Yesterday Pool', active:true},
    {id:'off',    name:'Inactive Pool', active:false}
  ]}});
  deferred.push(()=>{
    const w = dom.window, d = w.document;
    w.eval(`
      (function(){
        const today = todayDateStr();
        // Hours before now, so the order never depends on what time the test runs
        const ago = h => new Date(Date.now() - h * 3600000).toISOString();
        const set = (id, date, stamp)=>{ const c = customers.find(x => x.id === id); c.lastServicedDate = date; if(stamp) c.lastServicedAt = stamp; };
        set('early',  today, ago(5));
        set('late',   today, ago(1));
        set('middle', today, ago(3));
        set('nostamp', today, null);
        set('old', '2000-01-01', ago(2));
        set('off', today, ago(0.5));
        renderServicedList();
      })();
    `);
    const names = Array.from(d.querySelectorAll('#servicedList .cust-name'))
      .map(n => n.firstChild.textContent.trim());
    check(file + ' the most recently serviced pool is at the top', names[0] === 'Late Pool', names.join(' | '));
    check(file + ' newest to oldest down the list',
          names.slice(0, 3).join('|') === 'Late Pool|Middle Pool|Early Pool', names.join(' | '));
    check(file + ' a visit logged without a time sits at the bottom', names[names.length - 1] === 'Untimed Pool', names.join(' | '));
    check(file + ' only today\'s active visits are listed', names.length === 4, names.join(' | '));

    // A visit finished just now goes straight to the top
    w.eval(`(function(){ const c = customers.find(x => x.id === 'old'); c.lastServicedDate = todayDateStr(); c.lastServicedAt = new Date().toISOString(); renderServicedList(); })();`);
    const after = Array.from(d.querySelectorAll('#servicedList .cust-name')).map(n => n.firstChild.textContent.trim());
    check(file + ' a pool serviced just now goes straight to the top', after[0] === 'Yesterday Pool', after.join(' | '));
  });
});

console.log('\n=== Admin app: a past day hides the customers finished that day ===');
{
  const {dom} = load('admin-readings-app.html', {seed: {customers: [
    {id:'done',     name:'Done That Day',      day:'Monday', active:true},
    {id:'missed',   name:'Never Serviced',     day:'Monday', active:true},
    {id:'again',    name:'Serviced Again Since', day:'Monday', active:true},
    {id:'skipped',  name:'Skipped That Day',   day:'Monday', active:true},
    {id:'reserv',   name:'Reserviced',         day:'Monday', active:true},
    {id:'evening',  name:'Evening Visit',      day:'Monday', active:true},
    {id:'tuesday',  name:'Other Day',          day:'Tuesday', active:true}
  ]}});
  deferred.push(()=>{
    const w = dom.window, d = w.document;
    const shown = () => Array.from(d.querySelectorAll('#homeCustomerList .cust-name')).map(n => n.textContent.trim());
    const setup = (offset) => w.eval(`
      (function(){
        selectedHomeDay = 'Monday'; weekOffset = ${offset};
        const iso = visitDateStr();
        const day = dateForWeekday('Monday');
        const at = (h, m)=>{ const t = new Date(day); t.setHours(h, m, 0, 0); return t.toISOString(); };
        const later = new Date(day); later.setDate(later.getDate() + 7);
        const laterIso = new Date(later.getTime() - later.getTimezoneOffset()*60000).toISOString().slice(0,10);
        const c = id => customers.find(x => x.id === id);
        customers.forEach(x => { delete x.lastServicedDate; });
        ['readings:done','readings:again','readings:reserv','readings:evening','skippedVisits:skipped'].forEach(k => localStorage.removeItem('poollog:' + k));
        readingsCache = {};
        c('done').lastServicedDate = iso;
        lsSet('readings:done', [{id:'r1', date: at(9, 0), chlorine:'3'}]);
        c('again').lastServicedDate = laterIso;
        lsSet('readings:again', [{id:'r2', date: at(10, 0)}, {id:'r3', date: laterIso + 'T16:00:00.000Z'}]);
        c('skipped').lastServicedDate = laterIso;
        lsSet('skippedVisits:skipped', [{id:'s1', date: iso, timestamp: at(11, 0)}]);
        c('reserv').lastServicedDate = null;
        lsSet('readings:reserv', [{id:'r4', date: at(12, 0)}]);
        // 7:30 pm local: in Arizona that is already the next day in UTC
        c('evening').lastServicedDate = laterIso;
        lsSet('readings:evening', [{id:'r5', date: at(19, 30)}]);
        saveCustomers && lsSet('customers', customers);
        renderHomeList();
      })();`);

    // Last week's Monday
    setup(-1);
    let names = shown();
    check('last week: a customer finished that day is not listed', names.indexOf('Done That Day') === -1, names.join(' | '));
    check('last week: one serviced that day and again since is not listed', names.indexOf('Serviced Again Since') === -1, names.join(' | '));
    check('last week: one skipped that day is not listed', names.indexOf('Skipped That Day') === -1, names.join(' | '));
    check('last week: an evening visit counts for its own day', names.indexOf('Evening Visit') === -1, names.join(' | '));
    check('last week: a customer never serviced is still listed', names.indexOf('Never Serviced') !== -1, names.join(' | '));
    check('last week: a customer sent back with Reservice is listed again', names.indexOf('Reserviced') !== -1, names.join(' | '));
    check('last week: another day\'s customers are not mixed in', names.indexOf('Other Day') === -1, names.join(' | '));
    const stops = d.getElementById('homeStopCount').textContent;
    check('last week: the stop count matches, 2 left of 6', stops === '2 of 6', stops);

    // Today's tab still works as before
    w.eval(`(function(){
      selectedHomeDay = DAYS_OF_WEEK[new Date().getDay()]; weekOffset = 0;
      customers.forEach(x => { x.day = selectedHomeDay; delete x.lastServicedDate; });
      customers.find(x => x.id === 'done').lastServicedDate = todayDateStr();
      ['readings:done','readings:again','readings:reserv','readings:evening','skippedVisits:skipped'].forEach(k => localStorage.removeItem('poollog:' + k));
      readingsCache = {};
      lsSet('customers', customers);
      renderHomeList();
    })();`);
    names = shown();
    check('today: a customer finished today drops off', names.indexOf('Done That Day') === -1, names.join(' | '));
    check('today: everyone else is listed', names.length === 6, names.join(' | '));
    check('today: the count still includes the finished one', d.getElementById('homeStopCount').textContent === '6 of 7',
          d.getElementById('homeStopCount').textContent);

    // Next week nobody is hidden
    w.eval(`weekOffset = 1; renderHomeList();`);
    names = shown();
    check('next week: everyone is listed', names.length === 7, names.join(' | '));
  });
}

setTimeout(async ()=>{
  deferred.forEach(fn => {
    try{ fn(); }catch(e){ check('deferred check', false, e.message); }
  });
  // Accounts, the Technicians tab and field sign-in, against real Postgres
  await serverAccounts();
  await serverTechniciansTab();
  await serverFieldSignIn();
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}, 2500);

// ======== accounts-test (folded in) ========
async function serverAccounts(){
  // Technician accounts and who may see or change which customers, run against
  // real Postgres with the real snippets loaded. Needs: bash sync-test-setup.sh
  const { Pool } = require('pg');
  const pool = new Pool({host: '127.0.0.1', user: 'postgres', password: 'pw', database: 'pl', max: 3});
  const CO = 'aaaaaaaa-0000-0000-0000-000000000001', OTHER_CO = 'bbbbbbbb-0000-0000-0000-000000000002';
  const OWNER = '11111111-1111-1111-1111-111111111111', OUTSIDER = '22222222-2222-2222-2222-222222222222';
  const ALEX = '33333333-3333-3333-3333-333333333333', SAM = '44444444-4444-4444-4444-444444444444';
  const OLD = '55555555-5555-5555-5555-555555555555', GMAIL = '66666666-6666-6666-6666-666666666666';
  const T = '2026-09-16T10:00:00Z';

  async function as(uid, sql, params){
    const c = await pool.connect();
    try{
      await c.query('begin');
      await c.query(uid === 'anon' ? 'set local role anon' : 'set local role authenticated');
      if(uid !== 'anon') await c.query("select set_config('request.uid', $1, true)", [uid]);
      const r = await c.query(sql, params);
      await c.query('commit');
      return {ok: true, rows: r.rows};
    }catch(e){
      await c.query('rollback').catch(()=>{});
      return {ok: false, error: e.message};
    }finally{ c.release(); }
  }
  const val = r => r.ok && r.rows[0] ? Object.values(r.rows[0])[0] : undefined;
  const push = (uid, id, changes) => as(uid, 'select public.push_customer_fields($1, $2::jsonb, null) j', [id, JSON.stringify(changes)]);
  const ids = async uid => { const r = await as(uid, "select coalesce(string_agg(id, ',' order by id), '') s from public.customers"); return val(r); };

  return (async ()=>{
    try{ await pool.query('select 1'); }
    catch(e){ check('Postgres is reachable for the server checks (run: bash sync-test-setup.sh)', false); await pool.end().catch(()=>{}); return; }
    try{
      await pool.query('truncate public.customers, public.customer_versions');
      await pool.query('delete from public.members; delete from public.companies; delete from auth.users;');
      await pool.query(`insert into auth.users(id, email) values ($1,'john@triffic.test'),($2,'owner@affinity.test'),
        ($3,'tech-a1@accounts.poollog.invalid'),($4,'tech-b2@accounts.poollog.invalid'),
        ($5,'tech-c3@accounts.poollog.invalid'),($6,'someone@gmail.test')`, [OWNER, OUTSIDER, ALEX, SAM, OLD, GMAIL]);
      await pool.query(`update auth.users set created_at = now() - interval '1 day' where id = $1`, [OLD]);
      await pool.query(`insert into public.companies(id, name) values ($1,'Triffic'),($2,'Affinity')`, [CO, OTHER_CO]);
      await pool.query(`insert into public.members(user_id, company_id, role) values ($1,$2,'owner'),($3,$4,'owner')`, [OWNER, CO, OUTSIDER, OTHER_CO]);
      const attach = (uid, user, username, tech, admin) =>
        as(uid, 'select public.attach_technician($1, $2, $3, $4, $5) j', [user, username, tech, username, admin]);

      console.log('\n=== Owners create technician accounts ===');
      let r = await attach(OWNER, ALEX, 'alex.r', 't1', false);
      check('an owner creates a technician account', r.ok && val(r).username === 'alex.r', r.error);
      r = await attach(OWNER, SAM, 'Sam', 't2', true);
      check('and an admin technician', r.ok && val(r).is_admin === true, r.error);
      const confirmed = (await pool.query(`select count(*)::int n from auth.users where id in ($1,$2) and email_confirmed_at is not null`, [ALEX, SAM])).rows[0].n;
      check('new accounts are confirmed, so they can sign in straight away', confirmed === 2, confirmed);
      r = await attach(OWNER, OLD, 'ALEX.R', 't3', false);
      check('a username taken in the same company is refused, whatever its capitals', !r.ok && /already taken/.test(r.error), r.error);
      r = await attach(OWNER, OLD, 'a', 't3', false);
      check('a too-short username is refused', !r.ok && /3 to 40/.test(r.error), r.error);
      r = await attach(OWNER, OLD, 'olduser', 't3', false);
      check('an account that is not brand new cannot be attached', !r.ok && /cannot be attached/.test(r.error), r.error);
      r = await attach(OWNER, GMAIL, 'gmailuser', 't3', false);
      check('a real person\'s account cannot be taken over', !r.ok && /cannot be attached/.test(r.error), r.error);
      r = await attach(OWNER, ALEX, 'again', 't9', false);
      check('an account already in use cannot be attached twice', !r.ok, r.error);
      r = await attach(SAM, OLD, 'bysam', 't5', false);
      check('an admin technician cannot create accounts', !r.ok && /Only an owner/.test(r.error), r.error);
      r = await as('anon', 'select public.attach_technician($1,$2,$3,$4,$5)', [OLD, 'anonuser', 't6', 'x', false]);
      check('nobody signed out can create accounts', !r.ok, r.error);

      console.log('\n=== Two companies can use the same username ===');
      const OTHER_ALEX = '77777777-7777-7777-7777-777777777777';
      await pool.query(`insert into auth.users(id, email) values ($1, 'tech-z9@accounts.poollog.invalid')`, [OTHER_ALEX]);
      r = await as(OUTSIDER, 'select public.username_available($1) a', ['alex.r']);
      check('a username used by one company is free for another', val(r) === true);
      r = await attach(OUTSIDER, OTHER_ALEX, 'Alex.R', 'their-t1', false);
      check('so another company can create its own alex.r', r.ok, r.error);

      console.log('\n=== Setting up a phone and signing in ===');
      const codes = (await pool.query('select id, code from public.companies order by name')).rows;
      const trifficCode = codes.find(c => c.id === CO).code, affinityCode = codes.find(c => c.id === OTHER_CO).code;
      check('every company has a code', /^[A-HJ-NP-Z2-9]{6}$/.test(trifficCode) && /^[A-HJ-NP-Z2-9]{6}$/.test(affinityCode), trifficCode + ' ' + affinityCode);
      check('codes differ between companies', trifficCode !== affinityCode);
      r = await as('anon', 'select public.company_for_code($1) c', ['  ' + trifficCode.toLowerCase() + ' ']);
      check('a code, typed any way, finds the company and its name', r.ok && val(r) && val(r).id === CO && val(r).name === 'Triffic', JSON.stringify(r));
      r = await as('anon', 'select public.company_for_code($1) c', ['NOPE99']);
      check('a wrong code finds nothing', r.ok && val(r) === null, JSON.stringify(r));
      r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, '  ALEX.R ']);
      check('within a company, a username gives that account\'s sign-in address', val(r) === 'tech-a1@accounts.poollog.invalid', JSON.stringify(r));
      r = await as('anon', 'select public.sign_in_address($1, $2) a', [OTHER_CO, 'alex.r']);
      check('the same username in the other company gives the other account', val(r) === 'tech-z9@accounts.poollog.invalid', JSON.stringify(r));
      r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'nobody']);
      check('an unknown username gives nothing', r.ok && val(r) === null, JSON.stringify(r));
      r = await as(OWNER, 'select public.my_membership() m');
      check('an owner can see their company code, to give it out', r.ok && val(r).company_code === trifficCode, JSON.stringify(r));

      console.log('\n=== Owners can change the company code ===');
      r = await as(OWNER, 'select public.set_company_code($1) c', ['triffic']);
      check('an owner sets a memorable code', r.ok && val(r) === 'TRIFFIC', r.error);
      r = await as('anon', 'select public.company_for_code($1) c', ['Triffic']);
      check('the new code finds the company', r.ok && val(r) && val(r).id === CO);
      r = await as('anon', 'select public.company_for_code($1) c', [trifficCode]);
      check('the old code no longer does', r.ok && val(r) === null);
      r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.r']);
      check('a phone already set up still signs in after the code changes', val(r) === 'tech-a1@accounts.poollog.invalid');
      r = await as(OUTSIDER, 'select public.set_company_code($1) c', ['TRIFFIC']);
      check('another company cannot take a code in use', !r.ok && /already used/.test(r.error), r.error);
      r = await as(OWNER, 'select public.set_company_code($1) c', ['ab!']);
      check('a code has to be 4 to 12 letters or numbers', !r.ok && /4 to 12/.test(r.error), r.error);
      r = await as(SAM, 'select public.set_company_code($1) c', ['SAMCODE']);
      check('an admin technician cannot change it', !r.ok && /Only an owner/.test(r.error), r.error);
      r = await as('anon', 'select public.set_company_code($1) c', ['ANON']);
      check('nobody signed out can change it', !r.ok, r.error);
      r = await as(ALEX, 'select public.my_membership() m');
      check('a technician is not shown the code', r.ok && val(r).company_code === null, JSON.stringify(r));

      console.log('\n=== Who sees and changes which customers ===');
      for(const [id, tech] of [['c1', 't1'], ['c2', 't2'], ['c3', null]]){
        const ch = {id: {t: T, v: id}, name: {t: T, v: 'Pool ' + id}};
        if(tech) ch.technicianId = {t: T, v: tech};
        await push(OWNER, id, ch);
      }
      check('a technician sees only customers assigned to them', await ids(ALEX) === 'c1', await ids(ALEX));
      r = await as(ALEX, 'select public.my_membership() m');
      check('the app can tell it is a plain technician', r.ok && val(r).full_access === false && val(r).technician_id === 't1', JSON.stringify(r));
      r = await push(ALEX, 'c1', {lastServicedDate: {t: '2026-09-16T11:00:00Z', v: '2026-09-16'}});
      check('a technician records a visit on their own customer', r.ok && val(r).result === 'saved', r.error);
      r = await push(ALEX, 'c2', {notes: {t: '2026-09-16T11:00:00Z', v: 'x'}});
      check('but not on someone else\'s', !r.ok && /not assigned to you/.test(r.error), r.error);
      r = await push(ALEX, 'new1', {id: {t: T, v: 'new1'}});
      check('a technician cannot add a customer', !r.ok && /Only the office can add/.test(r.error), r.error);
      r = await push(ALEX, 'c1', {technicianId: {t: '2026-09-16T11:00:00Z', v: 't2'}});
      check('or reassign one', !r.ok && /reassign/.test(r.error), r.error);
      r = await push(ALEX, 'c1', {_deleted: {t: '2026-09-16T11:00:00Z', v: true}});
      check('or delete one', !r.ok && /delete/.test(r.error), r.error);
      r = await as(ALEX, "update public.customers set data = '{}' where id = 'c1'");
      check('or write to the table directly', !r.ok && /permission denied/.test(r.error), r.error);
      await push(OWNER, 'c1', {notes: {t: '2026-09-16T11:30:00Z', v: 'newer note'}});
      await push(OWNER, 'c1', {notes: {t: '2026-09-16T09:00:00Z', v: 'older note arriving late'}});   // loses, so it is kept
      r = await as(ALEX, 'select count(*)::int n from public.customer_versions');
      check('a technician cannot read replaced versions', r.ok && val(r) === 0, JSON.stringify(r));
      r = await as(OWNER, 'select count(*)::int n from public.customer_versions');
      check('an owner can', r.ok && val(r) >= 1, JSON.stringify(r));
      check('an admin technician sees every customer', await ids(SAM) === 'c1,c2,c3');
      r = await push(SAM, 'c1', {technicianId: {t: '2026-09-16T12:00:00Z', v: 't2'}});
      check('and can reassign', r.ok, r.error);
      r = await push(SAM, 'c4', {id: {t: T, v: 'c4'}, name: {t: T, v: 'Added by admin'}});
      check('and add customers', r.ok && val(r).result === 'saved', r.error);
      check('once reassigned, the old technician no longer sees it', await ids(ALEX) === '', await ids(ALEX));
      r = await push(ALEX, 'c1', {notes: {t: '2026-09-16T13:00:00Z', v: 'late'}});
      check('or can change it', !r.ok, r.error);
      check('another company sees none of them', await ids(OUTSIDER) === '');

      console.log('\n=== Owners manage accounts ===');
      await pool.query('insert into auth.sessions(user_id) values ($1)', [ALEX]);
      await pool.query('insert into auth.refresh_tokens(user_id, token) values ($1, $2)', [ALEX, 'tok']);
      r = await as(OWNER, 'select public.update_technician_account($1,$2,$3,$4) j', ['t1', 'alex.rivera', null, true]);
      check('an owner renames a technician and gives admin access', r.ok && val(r).username === 'alex.rivera' && val(r).is_admin === true, r.error);
      r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.rivera']);
      check('the new username signs in to the same account', val(r) === 'tech-a1@accounts.poollog.invalid');
      r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.r']);
      check('the old one no longer does', r.ok && val(r) === null);
      r = await as('anon', 'select public.sign_in_address($1, $2) a', [OTHER_CO, 'alex.r']);
      check('and the other company\'s alex.r is unaffected', val(r) === 'tech-z9@accounts.poollog.invalid');
      r = await as(OWNER, 'select public.update_technician_account($1,$2,$3,$4) j', ['t1', 'SAM', null, null]);
      check('renaming to a taken username is refused', !r.ok && /already taken/.test(r.error), r.error);
      check('admin access takes effect at once', await ids(ALEX) === 'c1,c2,c3,c4', await ids(ALEX));
      r = await as(OWNER, 'select public.set_technician_password($1,$2) j', ['t1', 'short']);
      check('a short password is refused', !r.ok && /8 characters/.test(r.error), r.error);
      r = await as(OWNER, 'select public.set_technician_password($1,$2) j', ['t1', 'brandnewpass']);
      check('an owner sets a new password', r.ok, r.error);
      const works = (await pool.query(`select encrypted_password = extensions.crypt('brandnewpass', encrypted_password) ok from auth.users where id = $1`, [ALEX])).rows[0].ok;
      check('the new password is the one that works', works === true);
      const left = (await pool.query(`select (select count(*) from auth.sessions where user_id = $1) + (select count(*) from auth.refresh_tokens where user_id = $1) n`, [ALEX])).rows[0].n;
      check('and the technician is signed out everywhere', Number(left) === 0, left);
      r = await as(OUTSIDER, 'select public.set_technician_password($1,$2) j', ['t1', 'hijacked123']);
      check('another company\'s owner cannot touch the account', !r.ok, r.error);
      r = await as(SAM, 'select public.set_technician_password($1,$2) j', ['t1', 'bysam12345']);
      check('an admin technician cannot set passwords', !r.ok && /Only an owner/.test(r.error), r.error);
      console.log('\n=== Removing a technician: 7 days to upload, nothing else ===');
      await pool.query('insert into auth.sessions(user_id) values ($1)', [ALEX]);
      // Alex is a plain technician again for this part
      await as(OWNER, 'select public.update_technician_account($1,$2,$3,$4) j', ['t1', null, null, false]);
      await push(OWNER, 'c3', {technicianId: {t: '2026-09-16T14:00:00Z', v: 't1'}});
      check('before removal he sees his customer', (await ids(ALEX)) === 'c3', await ids(ALEX));
      r = await as(OWNER, 'select public.remove_technician_account($1) j', ['t1']);
      check('an owner removes a technician', r.ok && val(r) && val(r).technician_id === 't1' && !!val(r).upload_until, r.error);
      check('at once he sees no customers', (await ids(ALEX)) === '', await ids(ALEX));
      r = await push(ALEX, 'c3', {notes: {t: '2026-09-16T15:00:00Z', v: 'after removal'}});
      check('and cannot change any', !r.ok, r.error);
      r = await as(ALEX, 'select count(*)::int n from public.members');
      check('or see who else works there', r.ok && val(r) === 0, JSON.stringify(r));
      r = await as(ALEX, 'select count(*)::int n from public.companies');
      check('or the company', r.ok && val(r) === 0, JSON.stringify(r));
      r = await as(ALEX, 'select public.my_membership() m');
      check('his app is told he was removed, and until when it can upload',
            r.ok && val(r).removed === true && !!val(r).upload_until && val(r).full_access === false && val(r).company_code === null, JSON.stringify(r));
      r = await as(ALEX, 'select public.my_upload_grace_company() c');
      check('for now his phone may still upload held visits', r.ok && val(r) === CO, JSON.stringify(r));
      const sessions = (await pool.query('select count(*)::int n from auth.sessions where user_id = $1', [ALEX])).rows[0].n;
      check('so his phone stays signed in for that', sessions === 1, sessions);
      r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.rivera']);
      check('but he cannot sign in again', r.ok && val(r) === null, JSON.stringify(r));
      r = await as(OWNER, 'select public.username_available($1) a', ['alex.rivera']);
      check('his username is free for someone new straight away', val(r) === true);
      r = await as(OWNER, 'select public.set_technician_password($1,$2) j', ['t1', 'anotherpass1']);
      check('a removed account cannot be given a new password', !r.ok, r.error);
      r = await as(OWNER, 'select public.remove_technician_account($1) j', ['t1']);
      check('removing twice does nothing', r.ok && val(r) === null, JSON.stringify(r));
      const NEW_ALEX = '88888888-8888-8888-8888-888888888888';
      await pool.query(`insert into auth.users(id, email) values ($1, 'tech-n8@accounts.poollog.invalid')`, [NEW_ALEX]);
      r = await attach(OWNER, NEW_ALEX, 'alex.rivera', 't1', false);
      check('the same profile and username can get a fresh account during the grace period', r.ok, r.error);
      r = await as('anon', 'select public.sign_in_address($1, $2) a', [CO, 'alex.rivera']);
      check('which is the one that signs in', val(r) === 'tech-n8@accounts.poollog.invalid', JSON.stringify(r));
      check('the new account sees the customer', (await ids(NEW_ALEX)) === 'c3', await ids(NEW_ALEX));
      check('the removed one still does not', (await ids(ALEX)) === '');

      // Eight days later
      await pool.query(`update public.members set removed_at = now() - interval '8 days' where user_id = $1`, [ALEX]);
      r = await as(ALEX, 'select public.my_upload_grace_company() c');
      check('after 7 days his phone can no longer upload', r.ok && val(r) === null, JSON.stringify(r));
      let still = (await pool.query('select count(*)::int n from auth.users where id = $1', [ALEX])).rows[0].n;
      check('the account lingers only until an owner next manages accounts', still === 1, still);
      await as(OWNER, 'select public.update_technician_account($1,$2,$3,$4) j', ['t2', null, null, null]);
      still = (await pool.query('select (select count(*) from auth.users where id = $1) + (select count(*) from public.members where user_id = $1) + (select count(*) from auth.sessions where user_id = $1) n', [ALEX])).rows[0].n;
      check('then it is deleted, sessions and all', Number(still) === 0, still);
      const kept = (await pool.query(`select count(*)::int n from public.customers where company_id = $1`, [CO])).rows[0].n;
      check('customers and their visits are untouched throughout', kept === 4, kept);
      const newStill = (await pool.query('select count(*)::int n from auth.users where id = $1', [NEW_ALEX])).rows[0].n;
      check('the new account is not touched by the clean-up', newStill === 1);
    }catch(e){
      check('accounts suite', false, e.stack);
    }
    await pool.end();
  })();
}

// ======== techtab-test (folded in) ========
async function serverTechniciansTab(){
  // The website's Technicians tab creating and managing sign-ins, driven through
  // the real page against real Postgres with the real snippets. Supabase's
  // sign-up and data endpoints are imitated; everything they call is real.
  // Needs: bash sync-test-setup.sh
  const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
  const { JSDOM } = require('jsdom');
  const { Pool } = require('pg');
  const fs = require('fs');

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const CO = 'aaaaaaaa-0000-0000-0000-000000000001', OTHER_CO = 'bbbbbbbb-0000-0000-0000-000000000002';
  const OWNER = '11111111-1111-1111-1111-111111111111', OUTSIDER = '22222222-2222-2222-2222-222222222222';
  const pool = new Pool({host: '127.0.0.1', user: 'postgres', password: 'pw', database: 'pl', max: 4});

  async function reset(){
    await pool.query('truncate public.customers, public.customer_versions');
    await pool.query('delete from public.members; delete from public.companies; delete from auth.users;');
    await pool.query(`insert into auth.users(id, email) values ($1, 'john@triffic.test'), ($2, 'owner@affinity.test')`, [OWNER, OUTSIDER]);
    await pool.query(`insert into public.companies(id, name, code) values ($1, 'Triffic Pool and Spa', 'K7WQ2M'), ($2, 'Affinity Pools', 'AFFIN1')`, [CO, OTHER_CO]);
    await pool.query(`insert into public.members(user_id, company_id, role, name) values ($1, $2, 'owner', 'John'), ($3, $4, 'owner', 'Mike')`, [OWNER, CO, OUTSIDER, OTHER_CO]);
  }

  async function asUser(uid, sql, params){
    const c = await pool.connect();
    try{
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query("select set_config('request.uid', $1, true)", [uid]);
      const r = await c.query(sql, params);
      await c.query('commit');
      return r;
    }catch(e){ await c.query('rollback').catch(()=>{}); throw e; }
    finally{ c.release(); }
  }

  // Named inputs for each database function the tab calls, in order
  const RPC = {
    my_membership: [],
    username_available: [['p_username', 'text']],
    attach_technician: [['p_user_id', 'uuid'], ['p_username', 'text'], ['p_technician_id', 'text'], ['p_name', 'text'], ['p_is_admin', 'boolean']],
    update_technician_account: [['p_technician_id', 'text'], ['p_username', 'text'], ['p_name', 'text'], ['p_is_admin', 'boolean']],
    set_technician_password: [['p_technician_id', 'text'], ['p_password', 'text']],
    remove_technician_account: [['p_technician_id', 'text']],
    set_company_code: [['p_code', 'text']],
    push_customer_fields: [['p_id', 'text'], ['p_changes', 'jsonb'], ['p_base', 'timestamptz']]
  };

  function makeServer(){
    const srv = {calls: [], offline: false, signupFails: null};
    srv.handle = async (uid, url, opts) => {
      const o = opts || {};
      const u = new URL(url);
      srv.calls.push((o.method || 'GET') + ' ' + u.pathname);
      if(srv.offline) throw new TypeError('Failed to fetch');
      if(u.pathname === '/auth/v1/signup'){
        const b = JSON.parse(o.body);
        srv.lastSignup = {body: b, headers: o.headers || {}};
        if(srv.signupFails) return [400, {code: 400, msg: srv.signupFails}];
        const r = await pool.query(`insert into auth.users(id, email, encrypted_password)
          values (gen_random_uuid(), $1, extensions.crypt($2, extensions.gen_salt('bf'))) returning id`, [b.email, b.password]);
        return [200, {access_token: 'new-account-token', user: {id: r.rows[0].id, email: b.email}}];
      }
      if(u.pathname === '/rest/v1/members'){
        const where = [];
        if(u.searchParams.get('technician_id') === 'not.is.null') where.push('technician_id is not null');
        if(u.searchParams.get('removed_at') === 'is.null') where.push('removed_at is null');
        const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
          select m.user_id, m.role, m.name, m.company_id, m.technician_id, m.username, m.is_admin
          from public.members m ${where.length ? 'where ' + where.join(' and ') : ''}) t`);
        return [200, r.rows[0].j];
      }
      if(u.pathname === '/rest/v1/customers'){
        const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (select id, data, deleted, updated_at from public.customers order by updated_at) t`);
        return [200, r.rows[0].j];
      }
      const m = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
      if(m && RPC[m[1]]){
        const args = JSON.parse(o.body || '{}');
        const sig = RPC[m[1]];
        const params = sig.map(([k, type]) => type === 'jsonb' ? JSON.stringify(args[k]) : (args[k] === undefined ? null : args[k]));
        const sql = `select public.${m[1]}(${sig.map(([k, type], i) => `${k} => $${i + 1}::${type}`).join(', ')}) j`;
        try{
          const r = await asUser(uid, sql, params);
          return [200, r.rows[0].j];
        }catch(e){ return [400, {message: e.message}]; }
      }
      return [404, {message: 'not found'}];
    };
    return srv;
  }

  async function boot(srv, seed){
    const dialogs = [];
    const dom = new JSDOM(fs.readFileSync('customer-intake.html', 'utf8'), {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://trifficpoolandspa-bit.github.io/Pool-Log/customer-intake.html',
      beforeParse(w){
        w.matchMedia = () => ({matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}});
        w.scrollTo = () => {}; w.scrollBy = () => {}; w.alert = () => {};
        w.HTMLCanvasElement.prototype.getContext = () => ({drawImage(){}, fillRect(){}});
        w.Element.prototype.scrollIntoView = function(){};
        w.console.warn = () => {}; w.console.error = () => {};
        w.indexedDB = new FDBFactory(); w.IDBKeyRange = global.IDBKeyRange;
        w.fetch = async (url, o2) => {
          await sleep(1);
          const [status, body] = await srv.handle(OWNER, url, o2);
          return {ok: status >= 200 && status < 300, status, json: async () => body};
        };
        w.localStorage.setItem('poollog:sbSession', JSON.stringify({access_token: 'owner-token', refresh_token: 'r'}));
        Object.entries(seed || {}).forEach(([k, v]) => w.localStorage.setItem('poollog:' + k, JSON.stringify(v)));
      }
    });
    const w = dom.window;
    w.__answer = 'ok';
    const iv = setInterval(()=>{
      const ov = Array.from(w.document.querySelectorAll('.confirm-overlay')).filter(x => x.querySelector('#confirmOk')).pop();
      if(ov){ dialogs.push(ov.textContent); ov.querySelector(w.__answer === 'ok' ? '#confirmOk' : '#confirmCancel').click(); }
    }, 5);
    await sleep(700);
    return {w, d: w.document, dialogs, close(){ clearInterval(iv); w.close(); }};
  }

  const toasts = w => { const t = w.document.getElementById('toast'); return t ? t.textContent : ''; };
  async function openTechTab(w){ w.eval("switchView('technicians')"); await sleep(250); }
  function fill(d, w, vals){
    Object.entries(vals).forEach(([id, v]) => {
      const el = d.getElementById(id);
      if(el.type === 'checkbox') el.checked = v; else el.value = v;
      el.dispatchEvent(new w.Event('input', {bubbles: true}));
    });
  }
  async function saveForm(d){ d.getElementById('btnSaveTech').click(); await sleep(450); }
  const members = async () => (await pool.query(`select m.technician_id, m.username, m.is_admin, m.removed_at, u.email, u.email_confirmed_at, u.encrypted_password
    from public.members m join auth.users u on u.id = m.user_id where m.company_id = $1 and m.role = 'technician' order by m.created_at`, [CO])).rows;
  const rowText = (d, name) => { const r = Array.from(d.querySelectorAll('#technicianList .cust-row')).find(x => x.textContent.indexOf(name) !== -1); return r ? r.textContent : ''; };

  return (async ()=>{
    try{ await pool.query('select 1'); }
    catch(e){ check('Postgres is reachable for the server checks (run: bash sync-test-setup.sh)', false); await pool.end().catch(()=>{}); return; }
    try{
      await reset();
      const srv = makeServer();
      const {w, d, dialogs, close} = await boot(srv, {technicians: [{id: 'tech_old', name: 'Old Local', username: 'oldlocal', password: 'localpass'}], customers: []});

      console.log('\n=== The company code and setup link ===');
      check('the website signed in as the owner', w.eval('siteUser && siteUser.role') === 'owner', w.eval('JSON.stringify(siteUser)'));
      await openTechTab(w);
      check('the Technicians tab shows the company code', d.getElementById('techCompanyCode').textContent === 'K7WQ2M', d.getElementById('techCompanyCode').textContent);
      check('and a setup link for it', d.getElementById('techSetupLink').textContent === 'https://trifficpoolandspa-bit.github.io/Pool-Log/index.html?company=K7WQ2M',
            d.getElementById('techSetupLink').textContent);
      let copied = null;
      w.navigator.clipboard = {writeText: async t => { copied = t; }};
      d.getElementById('btnCopySetupLink').click(); await sleep(50);
      check('Copy link copies it', copied === 'https://trifficpoolandspa-bit.github.io/Pool-Log/index.html?company=K7WQ2M', copied);
      check('a technician with no sign-in says so', /No sign-in yet/.test(rowText(d, 'Old Local')), rowText(d, 'Old Local'));

      d.getElementById('btnChangeCompanyCode').click();
      fill(d, w, {techCompanyCodeInput: 'triffic'});
      d.getElementById('btnSaveCompanyCode').click(); await sleep(400);
      check('changing the code asks first', dialogs.some(t => /Change your company code to TRIFFIC/.test(t)), dialogs.join(' | '));
      const code = (await pool.query('select code from public.companies where id = $1', [CO])).rows[0].code;
      check('the new code is saved on the server', code === 'TRIFFIC', code);
      check('and shown, with its link', d.getElementById('techCompanyCode').textContent === 'TRIFFIC' && /company=TRIFFIC$/.test(d.getElementById('techSetupLink').textContent));
      d.getElementById('btnChangeCompanyCode').click();
      fill(d, w, {techCompanyCodeInput: 'AFFIN1'});
      d.getElementById('btnSaveCompanyCode').click(); await sleep(400);
      check('a code another company uses is refused', /already used/.test(toasts(w)), toasts(w));
      check('and nothing changes', (await pool.query('select code from public.companies where id = $1', [CO])).rows[0].code === 'TRIFFIC');
      d.getElementById('btnCancelCompanyCode').click();

      console.log('\n=== Adding a technician creates their sign-in ===');
      d.getElementById('btnAddTech').click(); await sleep(50);
      fill(d, w, {techName: 'Alex Rivera', techUsername: 'alex', techPassword: 'goodpassword', techIsAdmin: false});
      await saveForm(d);
      let ms = await members();
      check('a sign-in is created on the server', ms.length === 1 && ms[0].username === 'alex', JSON.stringify(ms));
      check('linked to the technician profile', ms.length === 1 && ms[0].technician_id === w.eval("technicians.find(t => t.name === 'Alex Rivera').id"));
      check('using a hidden address on the reserved domain', ms.length === 1 && /^tech-[a-z0-9]{24}@accounts\.poollog\.invalid$/.test(ms[0].email), ms[0] && ms[0].email);
      check('confirmed, so it works straight away', ms.length === 1 && !!ms[0].email_confirmed_at);
      const pwOk = (await pool.query(`select encrypted_password = extensions.crypt('goodpassword', encrypted_password) ok from auth.users where email = $1`, [ms[0].email])).rows[0].ok;
      check('with the password the owner typed', pwOk === true);
      check('sign-up did not carry the owner\'s session', !('Authorization' in srv.lastSignup.headers) && !('authorization' in srv.lastSignup.headers), JSON.stringify(srv.lastSignup.headers));
      check('and the owner is still signed in as themselves', JSON.parse(w.localStorage.getItem('poollog:sbSession')).access_token === 'owner-token');
      check('the list shows who they sign in as', /Signs in as alex/.test(rowText(d, 'Alex Rivera')), rowText(d, 'Alex Rivera'));
      check('the toast says so', /sign in as alex/.test(toasts(w)), toasts(w));

      console.log('\n=== The form has the skip and gate requirements ===');
      d.getElementById('btnAddTech').click(); await sleep(50);
      const skipBox = d.getElementById('techRequireSkipProof'), gateBox = d.getElementById('techRequireGatePhoto');
      check('Add technician has "Require a photo and note to skip a body of water"', !!skipBox && /Require a photo and note to skip a body of water/.test(skipBox.closest('label').textContent));
      check('and "Require closed gate photo"', !!gateBox && /Require closed gate photo/.test(gateBox.closest('label').textContent));
      check('both start unticked, as on the profile page', skipBox && gateBox && !skipBox.checked && !gateBox.checked);
      fill(d, w, {techName: 'Rule Follower', techRequireSkipProof: true, techRequireGatePhoto: true});
      await saveForm(d);
      const rf = () => w.eval("technicians.find(t => t.name === 'Rule Follower')");
      check('ticking them saves both requirements on the technician', rf() && rf().requireSkipProof === true && rf().requireGatePhoto === true, JSON.stringify(rf()));
      w.eval("openTechDetail(technicians.find(t => t.name === 'Rule Follower'))"); await sleep(100);
      const profileBox = label => { const row = Array.from(d.querySelectorAll('#techProfileMeta .access-row')).find(r => r.textContent.indexOf(label) !== -1); return row && row.querySelector('input'); };
      check('the profile page shows them ticked', profileBox('Require a photo and note to skip') && profileBox('Require a photo and note to skip').checked && profileBox('Require closed gate photo').checked);
      w.eval("switchView('technicians')"); await sleep(250);
      w.eval("editTechnician(technicians.find(t => t.name === 'Rule Follower'))"); await sleep(50);
      check('Edit shows them ticked', d.getElementById('techRequireSkipProof').checked && d.getElementById('techRequireGatePhoto').checked);
      fill(d, w, {techRequireGatePhoto: false});
      await saveForm(d);
      check('unticking one in Edit turns just that one off', rf().requireGatePhoto === false && rf().requireSkipProof === true, JSON.stringify(rf()));
      d.getElementById('btnAddTech').click(); await sleep(50);
      check('the next new technician starts unticked again', !d.getElementById('techRequireSkipProof').checked && !d.getElementById('techRequireGatePhoto').checked);
      w.eval('resetTechForm(); hideTechForm();');

      console.log('\n=== Mistakes are caught before anything is saved ===');
      const before = w.eval('technicians.length');
      d.getElementById('btnAddTech').click(); await sleep(50);
      fill(d, w, {techName: 'Duplicate', techUsername: 'ALEX', techPassword: 'goodpassword'});
      await saveForm(d);
      check('a username already used in the company is refused', /already taken/.test(toasts(w)), toasts(w));
      check('and the technician is not added', w.eval('technicians.length') === before);
      fill(d, w, {techName: 'Shorty', techUsername: 'shorty', techPassword: 'short'});
      await saveForm(d);
      check('a short password is refused', /8 characters/.test(toasts(w)) && w.eval('technicians.length') === before, toasts(w));
      fill(d, w, {techName: 'Badname', techUsername: 'a b', techPassword: 'goodpassword'});
      await saveForm(d);
      check('a username with spaces is refused', /3 to 40/.test(toasts(w)) && w.eval('technicians.length') === before, toasts(w));
      srv.signupFails = 'Signups not allowed for this instance';
      fill(d, w, {techName: 'Blocked', techUsername: 'blocked', techPassword: 'goodpassword'});
      await saveForm(d);
      check('if Supabase refuses the sign-up, its reason is shown', /Signups not allowed/.test(toasts(w)), toasts(w));
      check('and nothing is added', w.eval('technicians.length') === before && (await members()).length === 1);
      srv.signupFails = null;
      srv.offline = true;
      fill(d, w, {techName: 'Offline Olly', techUsername: 'olly', techPassword: 'goodpassword'});
      await saveForm(d);
      check('offline, it says a connection is needed', /offline/i.test(toasts(w)), toasts(w));
      check('and nothing is added', w.eval('technicians.length') === before);
      srv.offline = false;
      w.eval('resetTechForm(); hideTechForm();');

      console.log('\n=== Another company can use the same username ===');
      const THEIR = (await pool.query(`insert into auth.users(id, email) values (gen_random_uuid(), 'tech-other@accounts.poollog.invalid') returning id`)).rows[0].id;
      await asUser(OUTSIDER, 'select public.attach_technician($1, $2, $3, $4, $5)', [THEIR, 'sam', 'their_sam', 'Sam', false]);
      d.getElementById('btnAddTech').click(); await sleep(50);
      fill(d, w, {techName: 'Sam Admin', techUsername: 'sam', techPassword: 'adminpass1', techIsAdmin: true});
      await saveForm(d);
      ms = await members();
      check('"sam" works here even though Affinity has a sam', ms.some(m => m.username === 'sam' && m.is_admin === true), JSON.stringify(ms.map(m => m.username)));
      check('the admin shows as Admin', /Signs in as sam · Admin/.test(rowText(d, 'Sam Admin')), rowText(d, 'Sam Admin'));

      console.log('\n=== Editing a technician ===');
      const alex = () => w.eval("technicians.find(t => t.name.indexOf('Alex') === 0)");
      w.eval("editTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(50);
      check('the password is never shown back', d.getElementById('techPassword').value === '');
      check('the form says blank keeps it', /Leave blank/.test(d.getElementById('techPassword').placeholder));
      check('and who they sign in as', /sign in as alex/.test(d.getElementById('techAccountHint').textContent), d.getElementById('techAccountHint').textContent);
      const oldHash = (await members()).find(m => m.username === 'alex').encrypted_password;
      fill(d, w, {techPhone: '(623) 555-0100'});
      await saveForm(d);
      check('saving other details leaves the password alone', (await members()).find(m => m.username === 'alex').encrypted_password === oldHash);
      check('and saves the details', alex().phone === '(623) 555-0100');

      await pool.query('insert into auth.sessions(user_id) select user_id from public.members where username = $1', ['alex']);
      w.eval("editTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(50);
      fill(d, w, {techUsername: 'alex.rivera', techPassword: 'resetpass99', techIsAdmin: true});
      await saveForm(d);
      const a2 = (await members()).find(m => m.technician_id === alex().id);
      check('renaming changes their username on the server', a2.username === 'alex.rivera', a2.username);
      check('admin access is switched on', a2.is_admin === true);
      const pw2 = (await pool.query(`select encrypted_password = extensions.crypt('resetpass99', encrypted_password) ok from auth.users where email = $1`, [a2.email])).rows[0].ok;
      check('a new password is set', pw2 === true);
      const sess = (await pool.query('select count(*)::int n from auth.sessions s join public.members m on m.user_id = s.user_id where m.username = $1', ['alex.rivera'])).rows[0].n;
      check('which signs them out of every phone', sess === 0, sess);
      check('the list shows the new username', /Signs in as alex.rivera · Admin/.test(rowText(d, 'Alex Rivera')), rowText(d, 'Alex Rivera'));

      w.eval("editTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(50);
      fill(d, w, {techUsername: 'sam'});
      await saveForm(d);
      check('renaming to a username in use is refused', /already taken/.test(toasts(w)) && (await members()).find(m => m.technician_id === alex().id).username === 'alex.rivera', toasts(w));
      w.eval('resetTechForm(); hideTechForm();');

      console.log('\n=== The Edit form offline ===');
      srv.offline = true;
      w.eval("editTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(50);
      w.eval('techAccounts = null');
      fill(d, w, {techUsername: 'offline.rename'});
      await saveForm(d);
      check('offline, changing a username in Edit is refused', /offline/i.test(toasts(w)) && alex().username !== 'offline.rename', toasts(w));
      w.eval("editTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(50);
      w.eval('techAccounts = null');
      fill(d, w, {techPhone: '(623) 555-0111'});
      await saveForm(d);
      check('but offline, changing only their phone number still saves', alex().phone === '(623) 555-0111', toasts(w));
      srv.offline = false;
      w.eval('resetTechForm(); hideTechForm();');
      await w.eval('loadTechAccounts()');

      console.log('\n=== The profile page changes the real sign-in ===');
      const openProfile = async name => { w.eval(`openTechDetail(technicians.find(t => t.name === ${JSON.stringify(name)}))`); await sleep(400); };
      const profileRow = label => Array.from(d.querySelectorAll('#techProfileMeta .profile-meta-row')).find(r => r.querySelector('.profile-meta-label') && r.querySelector('.profile-meta-label').textContent === label);
      const editRow = async (label, value) => {
        profileRow(label).click(); await sleep(30);
        const input = profileRow(label).querySelector('input');
        input.value = value;
        input.dispatchEvent(new w.Event('blur')); await sleep(450);
      };
      const adminBox = () => { const r = Array.from(d.querySelectorAll('#techProfileMeta .access-row')).find(x => /Admin access/.test(x.textContent)); return r && r.querySelector('input'); };
      const acctOf = async techId => (await members()).find(m => m.technician_id === techId);

      await openProfile('Alex Rivera');
      check('the profile shows the username they really sign in with', /alex.rivera/.test(profileRow('Username').textContent), profileRow('Username').textContent);
      check('and that a password is set, without showing it', /••••••••/.test(profileRow('Password').textContent));
      profileRow('Password').click(); await sleep(30);
      check('editing the password starts empty, never showing the old one', profileRow('Password').querySelector('input').value === '' && profileRow('Password').querySelector('input').type === 'password');
      profileRow('Password').querySelector('input').dispatchEvent(new w.Event('blur')); await sleep(200);
      const hashBefore = (await acctOf(alex().id)).encrypted_password;
      check('leaving it empty changes nothing', (await acctOf(alex().id)).encrypted_password === hashBefore);

      await openProfile('Alex Rivera');
      await editRow('Username', 'alex.profile');
      check('changing the username on the profile changes their sign-in', (await acctOf(alex().id)).username === 'alex.profile', (await acctOf(alex().id)).username);
      check('and the profile', alex().username === 'alex.profile');
      await openProfile('Alex Rivera');
      await editRow('Username', 'sam');
      check('a username already in use is refused on the profile too', /already taken/.test(toasts(w)) && (await acctOf(alex().id)).username === 'alex.profile' && alex().username === 'alex.profile', toasts(w));

      await pool.query('insert into auth.sessions(user_id) select user_id from public.members where username = $1', ['alex.profile']);
      await openProfile('Alex Rivera');
      await editRow('Password', 'profilepass1');
      const pw3 = (await pool.query(`select encrypted_password = extensions.crypt('profilepass1', encrypted_password) ok from auth.users where email = $1`, [(await acctOf(alex().id)).email])).rows[0].ok;
      check('setting a password on the profile sets their real password', pw3 === true);
      const sess3 = (await pool.query('select count(*)::int n from auth.sessions s join public.members m on m.user_id = s.user_id where m.username = $1', ['alex.profile'])).rows[0].n;
      check('and signs them out of every phone', sess3 === 0, sess3);
      await openProfile('Alex Rivera');
      await editRow('Password', 'short');
      check('a short password is refused on the profile', /8 characters/.test(toasts(w)), toasts(w));

      await openProfile('Alex Rivera');
      adminBox().click(); await sleep(450);
      check('unticking Admin access on the profile turns it off on their sign-in', (await acctOf(alex().id)).is_admin === false && alex().isAdmin === false, JSON.stringify(await acctOf(alex().id)));
      srv.offline = true;
      await openProfile('Alex Rivera');
      adminBox().click(); await sleep(450);
      check('offline, Admin access cannot be changed and the box goes back', adminBox().checked === false && alex().isAdmin === false && /offline/i.test(toasts(w)), toasts(w));
      srv.offline = false;
      await openProfile('Alex Rivera');
      adminBox().click(); await sleep(450);
      check('back online it works', (await acctOf(alex().id)).is_admin === true && alex().isAdmin === true);

      srv.offline = true;
      await openProfile('Alex Rivera');
      w.eval('techAccounts = null');
      await editRow('Username', 'offline.profile');
      check('offline, the username on the profile is refused too', /offline/i.test(toasts(w)) && alex().username === 'alex.profile', toasts(w));
      srv.offline = false;
      await w.eval('loadTechAccounts()');

      await openProfile('Alex Rivera');
      await editRow('Name', 'Alex R. Rivera');
      await sleep(300);
      const nm = (await pool.query('select name from public.members where username = $1', ['alex.profile'])).rows[0].name;
      check('a new name on the profile reaches their sign-in, so the phone shows it', nm === 'Alex R. Rivera', nm);
      w.eval("technicians.find(t => t.name === 'Alex R. Rivera').name = 'Alex Rivera'");

      w.eval("technicians.push({id:'tech_pat', name:'Profile Pat', username:'pat'}); saveTechnicians();");
      await openProfile('Profile Pat');
      check('a technician with no sign-in is offered one', /Set a password to create their sign-in/.test(profileRow('Password').textContent), profileRow('Password').textContent);
      await editRow('Password', 'patpassword');
      check('setting a password on the profile creates their sign-in', (await members()).some(m => m.technician_id === 'tech_pat' && m.username === 'pat'), toasts(w));
      w.eval("technicians.push({id:'tech_nouser', name:'No Username'}); saveTechnicians();");
      await openProfile('No Username');
      await editRow('Password', 'somepassword');
      check('without a username it asks for one first', /Enter a username/.test(toasts(w)) && !(await members()).some(m => m.technician_id === 'tech_nouser'), toasts(w));
      w.eval("switchView('technicians')"); await sleep(250);

      console.log('\n=== A technician who existed before sign-ins ===');
      w.eval("editTechnician(technicians.find(t => t.name === 'Old Local'))"); await sleep(50);
      check('the form says they have no sign-in yet', /No sign-in yet/.test(d.getElementById('techAccountHint').textContent));
      fill(d, w, {techPhone: '(623) 555-0199'});
      await saveForm(d);
      check('saving without a password keeps them as a profile only', !(await members()).some(m => m.technician_id === 'tech_old') && w.eval("technicians.find(t => t.id === 'tech_old').phone") === '(623) 555-0199');
      w.eval("editTechnician(technicians.find(t => t.name === 'Old Local'))"); await sleep(50);
      fill(d, w, {techPassword: 'freshpass1'});
      await saveForm(d);
      check('typing a password creates their sign-in with their username', (await members()).some(m => m.technician_id === 'tech_old' && m.username === 'oldlocal'), JSON.stringify((await members()).map(m => m.username)));

      console.log('\n=== Deleting a technician ===');
      const alexId = alex().id;
      w.eval("deleteTechnician(technicians.find(t => t.name === 'Alex Rivera'))"); await sleep(500);
      check('the question explains the 7 days', dialogs.some(t => /upload visits it was holding for 7 days/.test(t)), dialogs.join(' | '));
      const removed = (await pool.query(`select removed_at from public.members where technician_id = $1`, [alexId])).rows[0];
      check('their sign-in is stopped on the server', removed && !!removed.removed_at);
      check('and they are gone from the list', !rowText(d, 'Alex Rivera') && !w.eval("technicians.some(t => t.name === 'Alex Rivera')"));
      check('their username is free again', (await asUser(OWNER, 'select public.username_available($1) a', ['alex.profile'])).rows[0].a === true);

      srv.offline = true;
      w.eval("deleteTechnician(technicians.find(t => t.name === 'Sam Admin'))"); await sleep(500);
      check('offline, a technician with a sign-in is not deleted', w.eval("technicians.some(t => t.name === 'Sam Admin')") && /offline/i.test(toasts(w)), toasts(w));
      srv.offline = false;
      const ownerStill = w.eval('siteUser && siteUser.role');
      check('throughout, the website still knows it is the owner', ownerStill === 'owner');
      close();
    }catch(e){
      check('technicians tab suite', false, e.stack);
    }
    await pool.end();
  })();
}

// ======== fieldauth-test (folded in) ========
async function serverFieldSignIn(){
  // Signing in to the field apps: company code or setup link, username and
  // password, staying signed in offline, and being signed out when an owner
  // resets or removes the account. Real pages, real Postgres with the real
  // snippets; Supabase's sign-in endpoints are imitated.
  // Needs: bash sync-test-setup.sh
  const FDBFactory = require('fake-indexeddb/lib/FDBFactory');
  const { JSDOM } = require('jsdom');
  const { Pool } = require('pg');
  const fs = require('fs');
  const crypto = require('crypto');

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const CO = 'aaaaaaaa-0000-0000-0000-000000000001', OTHER_CO = 'bbbbbbbb-0000-0000-0000-000000000002';
  const OWNER = '11111111-1111-1111-1111-111111111111', OUTSIDER = '22222222-2222-2222-2222-222222222222';
  const pool = new Pool({host: '127.0.0.1', user: 'postgres', password: 'pw', database: 'pl', max: 4});

  async function asUser(uid, sql, params){
    const c = await pool.connect();
    try{
      await c.query('begin');
      await c.query(uid ? 'set local role authenticated' : 'set local role anon');
      if(uid) await c.query("select set_config('request.uid', $1, true)", [uid]);
      const r = await c.query(sql, params);
      await c.query('commit');
      return r;
    }catch(e){ await c.query('rollback').catch(()=>{}); throw e; }
    finally{ c.release(); }
  }

  async function reset(){
    await pool.query('truncate public.customers, public.customer_versions');
    await pool.query('delete from public.members; delete from public.companies; delete from auth.users;');
    await pool.query(`insert into auth.users(id, email) values ($1, 'john@triffic.test'), ($2, 'mike@affinity.test')`, [OWNER, OUTSIDER]);
    await pool.query(`insert into public.companies(id, name, code) values ($1, 'Triffic Pool and Spa', 'TRIFFIC'), ($2, 'Affinity Pools', 'AFFIN1')`, [CO, OTHER_CO]);
    await pool.query(`insert into public.members(user_id, company_id, role, name) values ($1, $2, 'owner', 'John'), ($3, $4, 'owner', 'Mike')`, [OWNER, CO, OUTSIDER, OTHER_CO]);
  }

  // A technician account the way the website makes one
  async function makeTech(ownerUid, username, password, techId, name, admin){
    const email = 'tech-' + crypto.randomBytes(8).toString('hex') + '@accounts.poollog.invalid';
    const id = (await pool.query(`insert into auth.users(id, email, encrypted_password) values (gen_random_uuid(), $1, extensions.crypt($2, extensions.gen_salt('bf'))) returning id`, [email, password])).rows[0].id;
    await asUser(ownerUid, 'select public.attach_technician($1, $2, $3, $4, $5)', [id, username, techId, name, !!admin]);
    return id;
  }

  // Supabase's auth and data endpoints, backed by the database
  function makeServer(){
    const srv = {offline: false, tokens: new Map(), refresh: new Map(), calls: []};
    srv.expireAccessTokens = () => srv.tokens.clear();
    srv.handle = async (url, opts) => {
      const o = opts || {};
      const u = new URL(url);
      const h = o.headers || {};
      srv.calls.push((o.method || 'GET') + ' ' + u.pathname + (u.search || ''));
      if(srv.offline) throw new TypeError('Failed to fetch');
      const bearer = (h.Authorization || '').replace(/^Bearer /, '');
      const uid = bearer ? srv.tokens.get(bearer) : null;
      if(bearer && !uid && !u.pathname.startsWith('/auth/v1/token')) return [401, {message: 'JWT expired'}];

      if(u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password'){
        const b = JSON.parse(o.body);
        const r = await pool.query(`select id from auth.users where email = $1 and encrypted_password = extensions.crypt($2, encrypted_password)`, [b.email, b.password]);
        if(!r.rows.length) return [400, {error: 'invalid_grant', error_description: 'Invalid login credentials'}];
        const id = r.rows[0].id;
        const sess = (await pool.query('insert into auth.sessions(user_id) values ($1) returning id', [id])).rows[0].id;
        const at = 'at-' + crypto.randomBytes(6).toString('hex'), rt = 'rt-' + crypto.randomBytes(6).toString('hex');
        srv.tokens.set(at, id); srv.refresh.set(rt, {id, sess});
        return [200, {access_token: at, refresh_token: rt, user: {id}}];
      }
      if(u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token'){
        const b = JSON.parse(o.body);
        const rec = srv.refresh.get(b.refresh_token);
        const alive = rec && (await pool.query('select 1 from auth.sessions where id = $1', [rec.sess])).rows.length;
        if(!alive) return [400, {error: 'invalid_grant', error_description: 'Invalid Refresh Token'}];
        srv.refresh.delete(b.refresh_token);
        const at = 'at-' + crypto.randomBytes(6).toString('hex'), rt = 'rt-' + crypto.randomBytes(6).toString('hex');
        srv.tokens.set(at, rec.id); srv.refresh.set(rt, rec);
        return [200, {access_token: at, refresh_token: rt, user: {id: rec.id}}];
      }
      if(u.pathname === '/auth/v1/logout'){
        if(uid) await pool.query('delete from auth.sessions where user_id = $1', [uid]);
        return [204, null];
      }
      if(u.pathname === '/rest/v1/company_records'){
        const since = u.searchParams.get('updated_at');
        const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
          select kind, id, data, deleted, updated_at from public.company_records
          ${since ? 'where updated_at >= $1' : ''} order by updated_at, kind, id) t`,
          since ? [since.replace(/^gte\./, '')] : []);
        return [200, r.rows[0].j];
      }
      if(u.pathname === '/rest/v1/customers'){
        const select = u.searchParams.get('select') || '';
        const idf = u.searchParams.get('id');
        const where = [];
        const params = [];
        if(idf && idf.startsWith('in.(')){
          params.push(idf.slice(4, -1).split(',').map(x => x.replace(/^"|"$/g, '')));
          where.push('id = any($' + params.length + ')');
        }
        const cols = select.indexOf('data') !== -1 ? 'id, data, deleted, updated_at' : 'id, updated_at, deleted';
        const r = await asUser(uid, `select coalesce(json_agg(t), '[]') j from (
          select ${cols} from public.customers ${where.length ? 'where ' + where.join(' and ') : ''} order by id) t`, params);
        return [200, r.rows[0].j];
      }
      const m = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
      if(m){
        const args = JSON.parse(o.body || '{}');
        const sigs = {
          company_for_code: ['p_code::text'],
          sign_in_address: ['p_company_id::uuid', 'p_username::text'],
          my_membership: [],
          push_customer_fields: ['p_id::text', 'p_changes::jsonb', 'p_base::timestamptz'],
          push_visit: ['p_customer_id::text', 'p_kind::text', 'p_body::text', 'p_id::text',
                       'p_data::jsonb', 'p_occurred_at::timestamptz', 'p_service_date::date'],
          push_record_fields: ['p_kind::text', 'p_id::text', 'p_changes::jsonb', 'p_base::timestamptz']
        };
        if(!sigs[m[1]]) return [404, {message: 'unknown function'}];
        const names = sigs[m[1]].map(x => x.split('::')[0]);
        const sql = `select public.${m[1]}(${sigs[m[1]].map((x, i) => `${x.split('::')[0]} => $${i + 1}::${x.split('::')[1]}`).join(', ')}) j`;
        try{
          const r = await asUser(uid, sql, names.map(n => {
            const v = args[n];
            if(v === undefined) return null;
            return (n === 'p_changes') ? JSON.stringify(v) : v;
          }));
          return [200, r.rows[0].j];
        }catch(e){ return [400, {message: e.message}]; }
      }
      if(o.method === 'HEAD') return [200, null];
      return [404, {message: 'not found'}];
    };
    return srv;
  }

  async function boot(srv, file, opts){
    const o = opts || {};
    const dialogs = [];
    const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
      runScripts: 'dangerously', pretendToBeVisual: true,
      url: 'https://trifficpoolandspa-bit.github.io/Pool-Log/' + file + (o.query || ''),
      beforeParse(w){
        w.matchMedia = () => ({matches:false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}});
        w.scrollTo = () => {}; w.scrollBy = () => {}; w.alert = () => {};
        w.HTMLCanvasElement.prototype.getContext = () => ({drawImage(){}, fillRect(){}});
        w.Element.prototype.scrollIntoView = function(){};
        w.console.warn = () => {}; w.console.error = () => {};
        w.indexedDB = new FDBFactory(); w.IDBKeyRange = global.IDBKeyRange;
        // Browsers have this; jsdom does not, and offline sign-in scrambles passwords with it
        Object.defineProperty(w, 'crypto', {value: require('crypto').webcrypto, configurable: true});
        w.TextEncoder = TextEncoder;
        w.confirm = () => { dialogs.push('native confirm'); return w.__answer !== 'cancel'; };
        w.fetch = async (url, o2) => {
          await sleep(1);
          const [status, body] = await srv.handle(String(url).startsWith('http') ? url : 'https://trifficpoolandspa-bit.github.io/Pool-Log/' + url, o2);
          return {ok: status >= 200 && status < 300, status, json: async () => { if(body === null) throw new Error('no body'); return body; }};
        };
        Object.entries(o.storage || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      }
    });
    const w = dom.window;
    w.__answer = 'ok';
    const iv = setInterval(()=>{
      const ov = Array.from(w.document.querySelectorAll('.confirm-overlay')).filter(x => x.querySelector('#confirmOk')).pop();
      if(ov){ dialogs.push(ov.textContent); ov.querySelector(w.__answer === 'ok' ? '#confirmOk' : '#confirmCancel').click(); }
    }, 5);
    await sleep(o.wait || 900);
    return {w, d: w.document, dialogs, close(){ clearInterval(iv); w.close(); },
            storage(){ const out = {}; for(let i = 0; i < w.localStorage.length; i++){ const k = w.localStorage.key(i); out[k] = w.localStorage.getItem(k); } return out; }};
  }

  const shown = el => !!el && el.style.display !== 'none';
  const loginVisible = d => d.getElementById('loginScreen').style.display !== 'none';
  const errorText = d => { const e = d.getElementById('loginError'); return e && e.style.display !== 'none' ? e.textContent : ''; };
  async function typeCode(p, code){
    p.d.getElementById('loginCompanyCode').value = code;
    p.d.getElementById('btnLoginCompany').click(); await sleep(150);
  }
  async function signIn(p, user, pw){
    p.d.getElementById('loginUsername').value = user;
    p.d.getElementById('loginPassword').value = pw;
    p.d.getElementById('btnLogin').click(); await sleep(350);
  }
  const seedStorage = extra => Object.assign({
    'poollog:technicians': JSON.stringify([{id: 't_alex', name: 'Alex (phone copy)', requireAfterPhoto: true}]),
    'poollog:customers': JSON.stringify([
      {id: 'c1', name: 'Alex Pool', day: today, active: true, technicianId: 't_alex', hasPool: true},
      {id: 'c2', name: 'Sam Pool', day: today, active: true, technicianId: 't_sam', hasPool: true}])
  }, extra || {});
  const routeNames = d => Array.from(d.querySelectorAll('#homeCustomerList .cust-name')).map(n => n.textContent.trim());

  return (async ()=>{
    try{ await pool.query('select 1'); }
    catch(e){ check('Postgres is reachable for the server checks (run: bash sync-test-setup.sh)', false); await pool.end().catch(()=>{}); return; }
    try{
      await reset();
      const srv = makeServer();
      await makeTech(OWNER, 'alex', 'alexpass1', 't_alex', 'Alex Rivera', false);
      await makeTech(OWNER, 'sam', 'sampass12', 't_sam', 'Sam Admin', true);
      await makeTech(OUTSIDER, 'alex', 'theirpass1', 'aff_alex', 'Affinity Alex', false);

      console.log('\n=== technician-app.html: a new phone learns its company from the code ===');
      let p = await boot(srv, 'technician-app.html', {storage: seedStorage()});
      check('the sign-in screen shows', loginVisible(p.d));
      check('it asks for the company code first', shown(p.d.getElementById('loginCompanyStep')));
      check('username and password wait until the company is known',
            !shown(p.d.getElementById('loginUsername').closest('.field')) && !shown(p.d.getElementById('btnLogin')));
      await typeCode(p, 'NOPE99');
      check('a wrong code says so', /wasn't found/.test(errorText(p.d)), errorText(p.d));
      await typeCode(p, '  triffic ');
      check('the right code, typed any way, shows the company name', /Triffic Pool and Spa/.test(p.d.getElementById('loginCompanyFound').textContent), p.d.getElementById('loginCompanyFound').textContent);
      check('and asks to confirm it', p.d.getElementById('btnLoginCompany').textContent === 'Use this company');
      p.d.getElementById('btnLoginCompany').click(); await sleep(100);
      check('then the company is shown above the sign-in', shown(p.d.getElementById('loginCompanyRow')) && p.d.getElementById('loginCompanyName').textContent === 'Triffic Pool and Spa');
      check('and username and password appear', shown(p.d.getElementById('loginUsername').closest('.field')) && shown(p.d.getElementById('btnLogin')));
      check('the phone remembers the company itself', JSON.parse(p.storage()['poollogdevice:company']).id === CO);

      console.log('\n=== technician-app.html: signing in ===');
      await signIn(p, 'alex', 'wrongpass');
      check('a wrong password is refused', /don't match/.test(errorText(p.d)) && loginVisible(p.d), errorText(p.d));
      await signIn(p, 'nobody', 'alexpass1');
      check('an unknown username gets the same answer, giving nothing away', /don't match/.test(errorText(p.d)), errorText(p.d));
      srv.offline = true;
      await signIn(p, 'alex', 'alexpass1');
      check('without signal the first sign-in says a connection is needed', /need a connection/.test(errorText(p.d)), errorText(p.d));
      srv.offline = false;
      await signIn(p, 'ALEX ', 'alexpass1');
      check('the right username and password sign in', !loginVisible(p.d), errorText(p.d));
      check('as the technician the server says', p.w.eval('currentUser && currentUser.id') === 't_alex' && p.w.eval('currentUser.name') === 'Alex Rivera', p.w.eval('JSON.stringify(currentUser)'));
      check('keeping their settings from this phone', p.w.eval('currentUser.requireAfterPhoto') === true);
      check('their route shows their customers', routeNames(p.d).join() === 'Alex Pool', routeNames(p.d).join(' | '));
      const st = p.storage();
      check('the sign-in is kept apart from company data, so backups never carry it',
            !!st['poollogdevice:session'] && !st['poollog:session'] && !Object.keys(st).some(k => k.startsWith('poollog:') && /at-|rt-/.test(st[k])));
      check('no password is stored on the phone', !Object.values(st).some(v => v.indexOf('alexpass1') !== -1));

      console.log('\n=== technician-app.html: another company\'s alex ===');
      const other = await boot(srv, 'technician-app.html', {storage: seedStorage()});
      await typeCode(other, 'AFFIN1'); other.d.getElementById('btnLoginCompany').click(); await sleep(100);
      await signIn(other, 'alex', 'alexpass1');
      check('our alex\'s password does not open Affinity\'s alex', loginVisible(other.d) && /don't match/.test(errorText(other.d)), errorText(other.d));
      await signIn(other, 'alex', 'theirpass1');
      check('Affinity\'s alex signs in to Affinity', !loginVisible(other.d) && other.w.eval('currentUser.id') === 'aff_alex', other.w.eval('JSON.stringify(currentUser)'));
      other.close();

      console.log('\n=== technician-app.html: opening the app again with no signal ===');
      const saved = p.storage(); p.close();
      srv.offline = true;
      p = await boot(srv, 'technician-app.html', {storage: saved});
      check('it opens straight into the route', !loginVisible(p.d) && p.w.eval('currentUser && currentUser.id') === 't_alex');
      check('with the customers', routeNames(p.d).join() === 'Alex Pool');
      srv.offline = false;

      console.log('\n=== technician-app.html: the owner resets the password ===');
      await asUser(OWNER, 'select public.set_technician_password($1, $2)', ['t_alex', 'resetpass99']);
      srv.expireAccessTokens();
      p.w.dispatchEvent(new p.w.Event('online')); await sleep(500);
      check('the phone is signed out once it has signal', loginVisible(p.d) && p.w.eval('currentUser') === null);
      check('and told why', /signed out/.test(errorText(p.d)), errorText(p.d));
      check('the company is still remembered', p.d.getElementById('loginCompanyName').textContent === 'Triffic Pool and Spa');
      await signIn(p, 'alex', 'alexpass1');
      check('the old password no longer works', loginVisible(p.d));
      await signIn(p, 'alex', 'resetpass99');
      check('the new one does', !loginVisible(p.d));

      console.log('\n=== technician-app.html: signing out ===');
      p.w.eval('logout()'); await sleep(200);
      check('Sign out goes back to the sign-in screen', loginVisible(p.d) && p.w.eval('currentUser') === null);
      check('the session is gone from the phone', !p.storage()['poollogdevice:session']);
      check('the company stays', shown(p.d.getElementById('loginCompanyRow')));

      console.log('\n=== technician-app.html: the owner removes the technician ===');
      await signIn(p, 'alex', 'resetpass99');
      const kept = p.storage();
      await asUser(OWNER, 'select public.remove_technician_account($1)', ['t_alex']);
      p.w.document.dispatchEvent(new p.w.Event('visibilitychange')); await sleep(500);
      check('the phone is signed out when it next checks', loginVisible(p.d) && p.w.eval('currentUser') === null);
      check('and told the sign-in was removed', /removed/.test(errorText(p.d)), errorText(p.d));
      await signIn(p, 'alex', 'resetpass99');
      check('they cannot sign in again', loginVisible(p.d));
      // The phone clears itself once what it was holding has reached the office
    for(let i = 0; i < 400 && p.w.eval("!!deviceGet('wipe')"); i++) await sleep(20);
    check('the company\'s customers are cleared off this phone',
          !p.storage()['poollog:customers'] || JSON.parse(p.storage()['poollog:customers']).length === 0,
          p.storage()['poollog:customers']);
      p.close();
      srv.offline = true;
      p = await boot(srv, 'technician-app.html', {storage: kept});
      check('a removed technician\'s phone with no signal still opens (nothing can reach it)', !loginVisible(p.d));
      srv.offline = false;
      p.w.dispatchEvent(new p.w.Event('online')); await sleep(500);
      check('and signs out as soon as it has signal', loginVisible(p.d) && /removed/.test(errorText(p.d)), errorText(p.d));
      p.close();

      console.log('\n=== technician-app.html: signing in again with no signal ===');
    {
      // Ray works this phone; Sam has never signed in on it
      await makeTech(OWNER, 'ray', 'raypass123', 't_ray', 'Ray Field', false);
      await asUser(OWNER, 'select public.push_customer_fields($1, $2::jsonb, null)',
        ['c1', JSON.stringify({technicianId: {t: new Date().toISOString(), v: 't_ray'}})]);
      p = await boot(srv, 'technician-app.html', {storage: seedStorage({
        'poollog:technicians': JSON.stringify([{id: 't_ray', name: 'Ray (phone copy)'}]),
        'poollog:customers': JSON.stringify([{id: 'c1', name: 'Alex Pool', day: today, active: true, technicianId: 't_ray', hasPool: true}])})});
      await typeCode(p, 'TRIFFIC'); p.d.getElementById('btnLoginCompany').click(); await sleep(100);
      await signIn(p, 'ray', 'raypass123');
      check('signed in with signal first', !loginVisible(p.d));
      const remembered = JSON.parse(p.storage()['poollogdevice:logins'] || '[]');
      check('the phone remembers that technician', remembered.length === 1 && remembered[0].username === 'ray', JSON.stringify(remembered.map(x => x.username)));
      check('without keeping the password', !JSON.stringify(remembered).includes('raypass123'));
      check('and not in a backup-able place', !Object.keys(p.storage()).some(k => k.startsWith('poollog:') && p.storage()[k].indexOf('scrambled') !== -1));

      p.w.eval('logout()'); await sleep(200);
      srv.offline = true;
      await signIn(p, 'ray', 'nottherightone');
      check('offline, a wrong password is still refused', loginVisible(p.d) && /don't match/.test(errorText(p.d)), errorText(p.d));
      await signIn(p, 'sam', 'sampass12');
      check('offline, someone who never signed in here is told they need a connection',
            loginVisible(p.d) && /need a connection the first time/.test(errorText(p.d)), errorText(p.d));
      await signIn(p, 'ray', 'raypass123');
      check('offline, the right password signs them back in', !loginVisible(p.d) && p.w.eval('currentUser && currentUser.id') === 't_ray', errorText(p.d));
      check('with their route', routeNames(p.d).join() === 'Alex Pool', routeNames(p.d).join(' | '));
      srv.offline = false;

      // A reset password must not keep opening the phone offline
      await asUser(OWNER, 'select public.set_technician_password($1, $2)', ['t_ray', 'newestpass1']);
      srv.expireAccessTokens();
      p.w.dispatchEvent(new p.w.Event('online')); await sleep(500);
      check('when the password is reset, the phone signs out', loginVisible(p.d));
      check('and forgets them, so the old password cannot be used offline either',
            JSON.parse(p.storage()['poollogdevice:logins'] || '[]').length === 0, p.storage()['poollogdevice:logins']);
      srv.offline = true;
      await signIn(p, 'ray', 'raypass123');
      check('the old password is refused offline', loginVisible(p.d) && /need a connection the first time/.test(errorText(p.d)), errorText(p.d));
      srv.offline = false;
      await signIn(p, 'ray', 'newestpass1');
      check('the new password works once there is signal', !loginVisible(p.d));
      srv.offline = true;
      p.w.eval('logout()'); await sleep(200);
      await signIn(p, 'ray', 'newestpass1');
      check('and from then on offline too', !loginVisible(p.d));
      srv.offline = false;

      // A phone two technicians share
      await signIn(p, 'sam', 'sampass12');
      check('a second technician signs in with signal', p.w.eval('currentUser && currentUser.id') === 't_sam');
      srv.offline = true;
      p.w.eval('logout()'); await sleep(200);
      await signIn(p, 'ray', 'newestpass1');
      check('offline, the phone still knows the first one', p.w.eval('currentUser && currentUser.id') === 't_ray');
      p.w.eval('logout()'); await sleep(200);
      await signIn(p, 'sam', 'sampass12');
      check('and the second', p.w.eval('currentUser && currentUser.id') === 't_sam');
      check('both are remembered', JSON.parse(p.storage()['poollogdevice:logins']).length === 2);
      srv.offline = false;
      p.close();
    }

    console.log('\n=== admin-readings-app.html: offline sign-in is admins only ===');
    {
      const a = await boot(srv, 'admin-readings-app.html', {storage: seedStorage({'poollogdevice:company': JSON.stringify({id: CO, name: 'Triffic Pool and Spa'})})});
      await signIn(a, 'sam', 'sampass12');
      check('an admin signs in with signal', !loginVisible(a.d));
      srv.offline = true;
      a.w.eval('adminLogout()'); await sleep(200);
      await signIn(a, 'sam', 'sampass12');
      check('and again offline', !loginVisible(a.d) && a.w.eval('currentUser && currentUser.id') === 't_sam');
      srv.offline = false;
      a.w.eval('adminLogout()'); await sleep(200);
      await asUser(OWNER, 'select public.update_technician_account($1, $2, $3, $4)', ['t_sam', null, null, false]);
      await signIn(a, 'sam', 'sampass12');
      check('with admin access off, the admin app refuses them', loginVisible(a.d) && /for admins/.test(errorText(a.d)), errorText(a.d));
      srv.offline = true;
      await signIn(a, 'sam', 'sampass12');
      check('and refuses them offline too', loginVisible(a.d), errorText(a.d));
      srv.offline = false;
      await asUser(OWNER, 'select public.update_technician_account($1, $2, $3, $4)', ['t_sam', null, null, true]);
      a.close();
    }

    console.log('\n=== technician-app.html: a removed technician\'s phone is cleared ===');
    {
      await makeTech(OWNER, 'wes', 'wespass123', 't_wes', 'Wes Field', false);
      const t = new Date().toISOString();
      await asUser(OWNER, 'select public.push_customer_fields($1,$2::jsonb,null)',
        ['w1', JSON.stringify({id: {t, v: 'w1'}, name: {t, v: 'Wes Pool'}, day: {t, v: today},
                               active: {t, v: true}, hasPool: {t, v: true}, technicianId: {t, v: 't_wes'},
                               gateCode: {t, v: 'SECRET-GATE'}})]);
      const wes = await boot(srv, 'technician-app.html', {storage: {
        'poollogdevice:company': JSON.stringify({id: CO, name: 'Triffic Pool and Spa'})}});
      await signIn(wes, 'wes', 'wespass123');
      for(let i = 0; i < 600 && wes.w.eval('syncRunning'); i++) await sleep(10);
      check('their customer is on the phone', JSON.parse(wes.storage()['poollog:customers'] || '[]').some(x => x.id === 'w1'));

      // A visit recorded just before being removed, with no signal
      srv.offline = true;
      wes.w.eval(`lsSet('readings:w1', [{id:'read_last', date: new Date().toISOString(), chlorine:'3.2'}]);`);
      await sleep(2400);
      for(let i = 0; i < 400 && wes.w.eval('syncRunning'); i++) await sleep(10);
      await asUser(OWNER, 'select public.remove_technician_account($1)', ['t_wes']);
      wes.w.dispatchEvent(new wes.w.Event('online')); await sleep(200);
      srv.offline = false;
      wes.w.document.dispatchEvent(new wes.w.Event('visibilitychange'));
      for(let i = 0; i < 900 && (wes.w.eval('syncRunning') || wes.w.eval("!!deviceGet('wipe')")); i++) await sleep(20);
      await sleep(200);

      const held = (await pool.query("select data from public.visits where id = 'read_last'")).rows[0];
      check('the visit it was holding reaches the office first', held && held.data.chlorine === '3.2', JSON.stringify(held));
      check('then the customers are gone from the phone', !wes.storage()['poollog:customers']
            || JSON.parse(wes.storage()['poollog:customers']).length === 0, wes.storage()['poollog:customers']);
      check('and so is the visit history', !wes.storage()['poollog:readings:w1'], wes.storage()['poollog:readings:w1']);
      check('nothing of the company is left on it',
            !Object.entries(wes.storage()).some(([k, v]) => k.indexOf('poollog:') === 0 && String(v).indexOf('SECRET-GATE') !== -1),
            Object.keys(wes.storage()).filter(k => k.indexOf('poollog:') === 0).join(','));
      check('the phone is signed out', loginVisible(wes.d) && wes.w.eval('currentUser') === null);
      check('with a message saying why', /sign-in was removed/i.test(errorText(wes.d)), errorText(wes.d));
      check('and it cannot be signed into offline any more',
            !(JSON.parse(wes.storage()['poollogdevice:logins'] || '[]')).some(l => l.username === 'wes'));
      wes.close();
    }

    console.log('\n=== technician-app.html: a phone that cannot send yet is not cleared ===');
    {
      await makeTech(OWNER, 'ivy', 'ivypass1234', 't_ivy', 'Ivy Field', false);
      const t = new Date().toISOString();
      await asUser(OWNER, 'select public.push_customer_fields($1,$2::jsonb,null)',
        ['i1', JSON.stringify({id: {t, v: 'i1'}, name: {t, v: 'Ivy Pool'}, day: {t, v: today},
                               active: {t, v: true}, hasPool: {t, v: true}, technicianId: {t, v: 't_ivy'}})]);
      const ivy = await boot(srv, 'technician-app.html', {storage: {
        'poollogdevice:company': JSON.stringify({id: CO, name: 'Triffic Pool and Spa'})}});
      await signIn(ivy, 'ivy', 'ivypass1234');
      for(let i = 0; i < 600 && ivy.w.eval('syncRunning'); i++) await sleep(10);
      ivy.w.eval(`lsSet('readings:i1', [{id:'read_stuck', date: new Date().toISOString(), chlorine:'4.4'}]);`);
      await sleep(2400);
      for(let i = 0; i < 400 && ivy.w.eval('syncRunning'); i++) await sleep(10);
      // The office removes them while the phone has no signal
      await asUser(OWNER, 'select public.remove_technician_account($1)', ['t_ivy']);
      srv.offline = true;
      ivy.w.eval("lsSet('readings:i1', (lsGet('readings:i1')||[]).concat([{id:'read_offline_last', date: new Date().toISOString(), chlorine:'5.5'}]));");
      await sleep(2400);
      for(let i = 0; i < 400 && ivy.w.eval('syncRunning'); i++) await sleep(10);
      ivy.w.eval("fieldStartWipe('removed')");
      await ivy.w.eval('fieldFinishWipe()');
      await sleep(100);
      check('with no signal, the phone keeps what it has not sent',
            JSON.parse(ivy.storage()['poollog:readings:i1'] || '[]').some(x => x.id === 'read_offline_last'),
            ivy.storage()['poollog:readings:i1']);
      check('and remembers it still has to clear itself', !!ivy.storage()['poollogdevice:wipe']);
      srv.offline = false;
      await ivy.w.eval('fieldFinishWipe()');
      await sleep(200);
      const late = (await pool.query("select data from public.visits where id = 'read_offline_last'")).rows[0];
      check('once signal returns the last visit goes up', late && late.data.chlorine === '5.5', JSON.stringify(late));
      check('and then the phone is cleared', !ivy.storage()['poollog:readings:i1'] && !ivy.storage()['poollogdevice:wipe']);
      ivy.close();
    }

    console.log('\n=== technician-app.html: changing company ===');
      p = await boot(srv, 'technician-app.html', {storage: seedStorage()});
      await typeCode(p, 'TRIFFIC'); p.d.getElementById('btnLoginCompany').click(); await sleep(100);
      p.d.getElementById('btnLoginChangeCompany').click(); await sleep(50);
      check('Change asks for a code again', shown(p.d.getElementById('loginCompanyStep')));
      check('with a way back', shown(p.d.getElementById('btnLoginCompanyBack')));
      p.d.getElementById('btnLoginCompanyBack').click(); await sleep(50);
      check('Back keeps the company', p.d.getElementById('loginCompanyName').textContent === 'Triffic Pool and Spa');
      p.d.getElementById('btnLoginChangeCompany').click(); await sleep(50);
      await typeCode(p, 'AFFIN1'); p.d.getElementById('btnLoginCompany').click(); await sleep(100);
      check('a new code switches the company', p.d.getElementById('loginCompanyName').textContent === 'Affinity Pools' && JSON.parse(p.storage()['poollogdevice:company']).id === OTHER_CO);
      p.close();

      console.log('\n=== technician-app.html: a setup link ===');
      p = await boot(srv, 'technician-app.html', {storage: seedStorage(), query: '?company=triffic'});
      check('opening the link sets the company, no typing', p.d.getElementById('loginCompanyName').textContent === 'Triffic Pool and Spa', p.d.getElementById('loginCompanyName').textContent);
      check('and takes the code off the address', p.w.location.search.indexOf('company') === -1, p.w.location.href);
      await signIn(p, 'sam', 'sampass12');
      check('an admin technician can use the technician app too', !loginVisible(p.d) && p.w.eval('currentUser.isAdmin') === true);
      const samSaved = p.storage(); p.close();
      p = await boot(srv, 'technician-app.html', {storage: samSaved, query: '?company=AFFIN1'});
      check('a link for a different company asks before switching', p.dialogs.some(t => /set up for Triffic Pool and Spa. Switch it to Affinity Pools/.test(t)), p.dialogs.join(' | '));
      check('switching signs out whoever was in', loginVisible(p.d) && p.w.eval('currentUser') === null && !p.storage()['poollogdevice:session']);
      p.close();
      p = await boot(srv, 'technician-app.html', {storage: samSaved, query: '?company=AFFIN1', wait: 50});
      p.w.__answer = 'cancel';
      await sleep(900);
      check('saying no leaves the phone as it was', !loginVisible(p.d) && JSON.parse(p.storage()['poollogdevice:company']).id === CO, p.storage()['poollogdevice:company']);
      p.close();

      console.log('\n=== technician-app.html: what the office sets reaches the phone ===');
    {
      const t = new Date().toISOString();
      const put = (kind, id, fields) => asUser(OWNER, 'select public.push_record_fields($1,$2,$3::jsonb,null)',
        [kind, id, JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, {t, v}])))]);
      await makeTech(OWNER, 'nina', 'ninapass12', 't_nina', 'Nina Field', false);
      await put('technician', 't_nina', {id: 't_nina', name: 'Nina Field', requireGatePhoto: true, requireSkipProof: true, canPhotoEquipment: true});
      await put('company', 'details', {companyName: 'Triffic Pool and Spa', accountPhone: '(623) 555-0142', licenseNumber: 'ROC-284419'});
      await put('setup', 'chemConfig', {value: {pool: {chemicals: [{key: 'chlorine', label: 'Free chlorine'}], dosages: []}, spa: {chemicals: [], dosages: []}, fountain: {chemicals: [], dosages: []}}});
      await put('setting', 'company', {showGatePhoto: true, showBeforePhotos: false, requireSkipReason: true});
      for(const [id, tech] of [['n1', 't_nina'], ['n2', 't_nina'], ['n3', 't_sam']]){
        await asUser(OWNER, 'select public.push_customer_fields($1,$2::jsonb,null)',
          [id, JSON.stringify({id: {t, v: id}, name: {t, v: 'Pool ' + id}, day: {t, v: today},
                               active: {t, v: true}, hasPool: {t, v: true}, technicianId: {t, v: tech}})]);
      }

      const phone = await boot(srv, 'technician-app.html', {storage: {
        'poollogdevice:company': JSON.stringify({id: CO, name: 'Triffic Pool and Spa'}),
        'poollog:settings': JSON.stringify({voiceModeEnabled: true, micSide: 'left', storePhotos: false, showGatePhoto: false})
      }});
      await signIn(phone, 'nina', 'ninapass12');
      for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
      await sleep(200);
      const st = phone.storage();
      const localOf = key => JSON.parse(st[key] || 'null');

      for(let i = 0; i < 900 && phone.w.eval('syncRunning'); i++) await sleep(20);
      await sleep(100);
      check('their own profile arrives', (localOf('poollog:technicians') || []).some(x => x.id === 't_nina' && x.requireGatePhoto === true),
            st['poollog:technicians']);
      check('and is what the app uses for them', phone.w.eval('currentUser && currentUser.requireGatePhoto') === true);
      check('nobody else\'s profile arrives', (localOf('poollog:technicians') || []).every(x => x.id === 't_nina'), st['poollog:technicians']);
      check('company details arrive', localOf('poollog:companyName') === 'Triffic Pool and Spa' && localOf('poollog:licenseNumber') === 'ROC-284419');
      check('the chemical setup arrives', localOf('poollog:chemConfig').pool.chemicals[0].label === 'Free chlorine');
      check('company settings arrive', localOf('poollog:settings').showGatePhoto === true && localOf('poollog:settings').requireSkipReason === true,
            st['poollog:settings']);
      check('and the app is using them', phone.w.eval('appSettings.showGatePhoto') === true);
      check('this phone\'s own settings are left alone',
            localOf('poollog:settings').voiceModeEnabled === true && localOf('poollog:settings').micSide === 'left'
            && localOf('poollog:settings').storePhotos === false, st['poollog:settings']);
      check('only their own customers arrive', (localOf('poollog:customers') || []).map(x => x.id).sort().join() === 'n1,n2',
            st['poollog:customers']);
      check('and show on their route', routeNames(phone.d).sort().join() === 'Pool n1,Pool n2', routeNames(phone.d).join(' | '));

      console.log('\n=== technician-app.html: what happens on the phone reaches the office ===');
      phone.w.eval("customers.find(c => c.id === 'n1').lastServicedDate = '2026-09-17'; customers.find(c => c.id === 'n1').gateCode = 'FROM-PHONE'; lsSet('customers', customers);");
      await sleep(2400);
      for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
      const served = (await pool.query("select data from public.customers where id = 'n1'")).rows[0].data;
      check('a finished visit reaches the server', served.lastServicedDate === '2026-09-17', JSON.stringify(served));
      check('along with anything else changed there', served.gateCode === 'FROM-PHONE');

      console.log('\n=== technician-app.html: the office changes things back at the desk ===');
      await asUser(OWNER, 'select public.push_customer_fields($1,$2::jsonb,null)',
        ['n2', JSON.stringify({notes: {t: new Date().toISOString(), v: 'Office note'}})]);
      await put('technician', 't_nina', {requireGatePhoto: false});
      await phone.w.eval('fieldSync()');
      for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
      check('a customer change from the office arrives', (JSON.parse(phone.storage()['poollog:customers']).find(x => x.id === 'n2') || {}).notes === 'Office note');
      check('a profile change from the office arrives', JSON.parse(phone.storage()['poollog:technicians'])[0].requireGatePhoto === false);

      console.log('\n=== technician-app.html: tasks and day moves ===');
      {
        const t = new Date().toISOString();
        const putRec = (kind, id, fields) => asUser(OWNER, 'select public.push_record_fields($1,$2,$3::jsonb,null)',
          [kind, id, JSON.stringify(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, {t, v}])))]);
        await putRec('task', 'task_p1', {id: 'task_p1', title: 'Drop off tabs', technicianId: 't_nina', done: false});
        await putRec('task', 'task_p2', {id: 'task_p2', title: 'Someone else', technicianId: 't_sam', done: false});
        await putRec('filter_clean', 'fc_p1', {id: 'fc_p1', customerId: 'n1', technicianId: 't_nina', date: '2026-09-20'});
        await putRec('reschedule', 'res_p1', {id: 'res_p1', customerId: 'n1', fromDate: '2026-09-17', toDate: '2026-09-18'});
        await phone.w.eval('fieldSync()');
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        const localList = key => JSON.parse(phone.storage()['poollog:' + key] || '[]');
        check('their own task arrives on the phone', localList('tasks').some(x => x.id === 'task_p1'), phone.storage()['poollog:tasks']);
        check('somebody else\'s does not', !localList('tasks').some(x => x.id === 'task_p2'));
        check('their scheduled filter clean arrives', localList('scheduledFilterCleans').some(x => x.id === 'fc_p1'));
        check('a one-day move for their customer arrives', localList('rescheduledVisits').some(x => x.id === 'res_p1'));

        // Ticking it off in the field
        // Count what goes up, so a refused item is not retried forever
        await phone.w.eval(`
          window.__pushCount = 0;
          const realAuthed = fieldAuthed;
          fieldAuthed = async (path, opts) => {
            if(String(path).indexOf('push_record_fields') !== -1) window.__pushCount++;
            return realAuthed(path, opts);
          };
          'ready';`);
        phone.w.eval(`
          const all = lsGet('tasks') || [];
          const hit = all.find(x => x.id === 'task_p1');
          hit.done = true; hit.doneAt = new Date().toISOString();
          lsSet('tasks', all);
        `);
        await sleep(2400);
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        const serverTask = (await pool.query("select data from public.company_records where kind='task' and id='task_p1'")).rows[0];
        check('ticking a task off reaches the office', serverTask && serverTask.data.done === true, JSON.stringify(serverTask));
        check('and its title is untouched', serverTask && serverTask.data.title === 'Drop off tabs');

        // Moving a visit in the field
        phone.w.eval(`lsSet('rescheduledVisits', (lsGet('rescheduledVisits') || []).concat([
          {id:'res_phone', customerId:'n1', fromDate:'2026-09-24', toDate:'2026-09-25', createdAt: new Date().toISOString()}]))`);
        await sleep(2400);
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        const moved = (await pool.query("select data from public.company_records where kind='reschedule' and id='res_phone'")).rows[0];
        check('a visit moved in the field reaches the office', moved && moved.data.toDate === '2026-09-25', JSON.stringify(moved));

        // Something the office does not allow does not jam everything behind it
        phone.w.eval(`
          const all = lsGet('tasks') || [];
          all.push({id:'task_invented', title:'Made up on the phone', technicianId:'t_nina', done:false});
          lsSet('tasks', all);
        `);
        await sleep(2400);
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        const invented = (await pool.query("select count(*)::int n from public.company_records where id='task_invented'")).rows[0].n;
        check('a task invented on a phone is not accepted', invented === 0, String(invented));
        phone.w.eval(`
          const all = lsGet('tasks') || [];
          const hit = all.find(x => x.id === 'task_p1');
          hit.doneBy = 't_nina';
          lsSet('tasks', all);
        `);
        await sleep(2400);
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        const stillFine = (await pool.query("select data from public.company_records where kind='task' and id='task_p1'")).rows[0];
        check('and a later change still gets through', stillFine && stillFine.data.doneBy === 't_nina',
              JSON.stringify(stillFine));

        // The refused one is set aside rather than retried every minute
        const pushesBefore = phone.w.eval('window.__pushCount');
        await phone.w.eval('fieldSync()');
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        await phone.w.eval('fieldSync()');
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        check('a refused item is not sent again and again', phone.w.eval('window.__pushCount') === pushesBefore,
              pushesBefore + ' then ' + phone.w.eval('window.__pushCount'));
      }

      console.log('\n=== technician-app.html: visits reach the office ===');
      {
        const visitsOf = async () => (await pool.query(
          "select customer_id, kind, body, id, data, service_date, technician_id from public.visits order by id")).rows;
        phone.w.eval(`
          lsSet('readings:n1', [{id:'read_a', date: new Date().toISOString(), chlorine:'3.0', notes:'all good',
                                 filterBackwashed:true, photo:'data:image/jpeg;base64,AAAA',
                                 beforePhoto:'data:image/jpeg;base64,BBBB', customPhotos:{x:'data:image/jpeg;base64,CCCC'}}]);
          lsSet('spaReadings:n1', [{id:'read_b', date: new Date().toISOString(), chlorine:'4.0'}]);
          lsSet('skippedVisits:n1', [{id:'skip_a', date:'2026-09-16', reason:'locked gate'}]);
        `);
        await sleep(2400);
        for(let i = 0; i < 600 && phone.w.eval('syncRunning'); i++) await sleep(10);
        const v = await visitsOf();
        check('the pool reading reaches the office', v.some(x => x.id === 'read_a' && x.body === 'pool' && x.data.chlorine === '3.0'), JSON.stringify(v.map(x => x.id)));
        check('with the notes and what was done', v.some(x => x.id === 'read_a' && x.data.notes === 'all good' && x.data.filterBackwashed === true));
        check('but no photos, which stay on the phone',
              v.filter(x => x.id === 'read_a').every(x => !('photo' in x.data) && !('beforePhoto' in x.data) && !('customPhotos' in x.data)),
              JSON.stringify(v.find(x => x.id === 'read_a').data));
        check('noting that photos exist on the phone', v.some(x => x.id === 'read_a' && x.data.photosOnPhone === true));
        check('the spa reading is its own visit', v.some(x => x.id === 'read_b' && x.body === 'spa'));
        check('a skipped visit reaches the office too', v.some(x => x.id === 'skip_a' && x.kind === 'skip' && x.data.reason === 'locked gate'));
        check('on the day it was skipped', (v.find(x => x.id === 'skip_a') || {}).service_date instanceof Date
              ? true : String((v.find(x => x.id === 'skip_a') || {}).service_date).indexOf('2026-09-16') !== -1,
              String((v.find(x => x.id === 'skip_a') || {}).service_date));
        check('stamped with who recorded it', v.filter(x => x.customer_id === 'n1').every(x => x.technician_id === 't_nina'));
        check('and the photos are still on the phone', JSON.parse(phone.storage()['poollog:readings:n1'])[0].photo === 'data:image/jpeg;base64,AAAA');

        // Nothing is sent twice, and a correction at the office is not undone
        await asUser(OWNER, "select public.amend_visit('n1','reading','pool','read_a','{\"chlorine\":\"3.5\"}'::jsonb,null)");
        await phone.w.eval('fieldSync()');
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        const after = await visitsOf();
        check('a visit already sent is not sent again', after.filter(x => x.customer_id === 'n1').length === 3,
              JSON.stringify(after.filter(x => x.customer_id === 'n1').map(x => x.id)));
        check('so an office correction stands', (after.find(x => x.id === 'read_a') || {}).data.chlorine === '3.5');

        // A visit recorded with no signal waits, then goes up
        srv.offline = true;
        phone.w.eval("lsSet('readings:n1', (lsGet('readings:n1') || []).concat([{id:'read_offline', date: new Date().toISOString(), chlorine:'2.8'}]));");
        await sleep(2400);
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        check('a visit recorded offline waits on the phone', !(await visitsOf()).some(x => x.id === 'read_offline'));
        srv.offline = false;
        await phone.w.eval('fieldSync()');
        for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
        check('and goes up when signal is back', (await visitsOf()).some(x => x.id === 'read_offline' && x.data.chlorine === '2.8'));
      }

      console.log('\n=== technician-app.html: a customer given to someone else ===');
      await asUser(OWNER, 'select public.push_customer_fields($1,$2::jsonb,null)',
        ['n2', JSON.stringify({technicianId: {t: new Date().toISOString(), v: 't_sam'}})]);
      await phone.w.eval('fieldSync()');
      for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
      check('comes off this phone', !JSON.parse(phone.storage()['poollog:customers']).some(x => x.id === 'n2'),
            phone.storage()['poollog:customers']);
      check('and the one still theirs stays', JSON.parse(phone.storage()['poollog:customers']).some(x => x.id === 'n1'));

      console.log('\n=== technician-app.html: offline, and a settings change mid-visit ===');
      srv.offline = true;
      phone.w.eval("customers.find(c => c.id === 'n1').gateCode = 'OFFLINE-EDIT'; lsSet('customers', customers);");
      await sleep(2400);
      for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
      check('an edit made offline stays on the phone', JSON.parse(phone.storage()['poollog:customers']).find(x => x.id === 'n1').gateCode === 'OFFLINE-EDIT');
      const serverBefore = (await pool.query("select data from public.customers where id = 'n1'")).rows[0].data;
      check('and has not reached the server', serverBefore.gateCode === 'FROM-PHONE');
      srv.offline = false;
      await phone.w.eval('fieldSync()');
      for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
      check('it goes up when signal is back', (await pool.query("select data from public.customers where id = 'n1'")).rows[0].data.gateCode === 'OFFLINE-EDIT');

      phone.w.eval("currentVisitCustomerId = 'n1'");
      await put('setting', 'company', {showAfterPhotos: false});
      await phone.w.eval('fieldSync()');
      for(let i = 0; i < 400 && phone.w.eval('syncRunning'); i++) await sleep(10);
      check('a settings change during a visit does not change the rules mid-pool', phone.w.eval('appSettings.showAfterPhotos') !== false,
            String(phone.w.eval('appSettings.showAfterPhotos')));
      phone.w.eval("currentVisitCustomerId = null; syncApplyHeldSettings();");
      await sleep(50);
      check('and takes effect once the visit ends', phone.w.eval('appSettings.showAfterPhotos') === false);
      const backedUp = await phone.w.eval(`(async ()=>{
        const db = await fieldBackupDb();
        return await new Promise(r=>{
          const q = db.transaction('backups','readonly').objectStore('backups').get('before-first-sync:${CO}');
          q.onsuccess = ()=> r(q.result ? Object.keys(q.result.payload.data).length : 0);
          q.onerror = ()=> r(0);
        });
      })()`);
      check('a copy of this phone was kept before its first sync', backedUp > 0, String(backedUp));
      phone.close();
    }

    console.log('\n=== admin-readings-app.html: admin technicians only ===');
      p = await boot(srv, 'admin-readings-app.html', {storage: seedStorage({'poollogdevice:company': JSON.stringify({id: CO, name: 'Triffic Pool and Spa'})})});
      check('the admin app asks for a sign-in', loginVisible(p.d));
      await makeTech(OWNER, 'plain', 'plainpass1', 't_plain', 'Plain Tech', false);
      await signIn(p, 'plain', 'plainpass1');
      check('a plain technician is turned away', loginVisible(p.d) && /for admins/.test(errorText(p.d)), errorText(p.d));
      check('and not left signed in', !p.storage()['poollogdevice:session']);
      await signIn(p, 'sam', 'sampass12');
      check('an admin technician gets in', !loginVisible(p.d) && p.w.eval('currentUser && currentUser.id') === 't_sam');
      check('shown by name', p.d.getElementById('adminSignedInAs').textContent === 'Sam Admin', p.d.getElementById('adminSignedInAs').textContent);
      await asUser(OWNER, 'select public.update_technician_account($1, $2, $3, $4)', ['t_sam', null, null, false]);
      p.w.dispatchEvent(new p.w.Event('online')); await sleep(500);
      check('turning admin access off signs them out of the admin app', loginVisible(p.d) && /Admin access was turned off/.test(errorText(p.d)), errorText(p.d));
      await asUser(OWNER, 'select public.update_technician_account($1, $2, $3, $4)', ['t_sam', null, null, true]);
      await signIn(p, 'sam', 'sampass12');
      const adminSaved = p.storage();
      p.d.getElementById('btnAdminLogout').click(); await sleep(200);
      check('Sign out works in the admin app', loginVisible(p.d) && !p.storage()['poollogdevice:session']);
      p.close();
      srv.offline = true;
      p = await boot(srv, 'admin-readings-app.html', {storage: adminSaved});
      check('the admin app opens without signal once signed in', !loginVisible(p.d) && p.w.eval('currentUser.id') === 't_sam');
      srv.offline = false;
      p.close();

      console.log('\n=== index.html: the landing page ===');
      p = await boot(srv, 'index.html', {storage: {}, query: '?company=TRIFFIC&app=service'});
      const went = [];
      p.w.eval('goTo = function(u){ window.__went = u; }');
      check('a setup link opened on the landing page sets the company', p.d.getElementById('loginCompanyName').textContent === 'Triffic Pool and Spa');
      p.d.getElementById('loginUsername').value = 'sam'; p.d.getElementById('loginPassword').value = 'sampass12';
      p.d.getElementById('btnLogin').click(); await sleep(400);
      check('an admin technician is sent to the admin app', p.w.__went === './admin-readings-app.html', String(p.w.__went));
      p.d.getElementById('loginUsername').value = 'plain'; p.d.getElementById('loginPassword').value = 'plainpass1';
      p.d.getElementById('btnLogin').click(); await sleep(400);
      check('a technician is sent to the technician app', p.w.__went === './technician-app.html', String(p.w.__went));
      p.d.getElementById('loginUsername').value = 'plain'; p.d.getElementById('loginPassword').value = 'nope';
      p.w.__went = null;
      p.d.getElementById('btnLogin').click(); await sleep(400);
      check('a wrong password goes nowhere', p.w.__went === null && /don't match/.test(p.d.getElementById('loginError').textContent), p.d.getElementById('loginError').textContent);
      p.close();
    }catch(e){
      check('field sign-in suite', false, e.stack);
    }
    await pool.end();
  })();
}
