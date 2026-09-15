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


console.log('\n=== Beta testers can sign in on a fresh device ===');
{
  // There is no server, so accounts travel with the build. A tester opening a
  // link for the first time must be able to get in.
  // The field apps carry technician accounts; the site carries an owner account
  ['index.html','technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' carries the starter technician', src.indexOf('BETA_ACCOUNTS') !== -1);
    check(file + ' only seeds it on an empty device',
          src.indexOf('if(Array.isArray(existing) && existing.length) return;') !== -1);
  });
  {
    const src = fs.readFileSync('customer-intake.html', 'utf8');
    check('the site carries a separate owner account', src.indexOf('STARTER_OWNER') !== -1);
    check('and does not seed technicians', src.indexOf('BETA_ACCOUNTS') === -1);
  }

  // The landing page must not hand out a way past the sign-in
  const idx = fs.readFileSync('index.html', 'utf8');
  check('the landing page has no dev shortcut buttons',
        idx.indexOf('btnDevTech') === -1 && idx.indexOf('btnDevAdmin') === -1);
  check('and no ?dev=1 links', idx.indexOf('dev=1') === -1);
  check('but still offers the office site', idx.indexOf('btnOfficeSite') !== -1);

  // Signing in with a seeded account actually works
  const {dom} = load('technician-app.html', {seed: {customers: []}});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  deferred.push(()=>{
    try{
      d.getElementById('loginUsername').value = 'poollog';
      d.getElementById('loginPassword').value = 'letmein';
      d.getElementById('btnLogin').click();
      check('the starter account can sign in',
            w.eval('currentUser ? currentUser.username : null') === 'poollog',
            String(w.eval('currentUser ? currentUser.username : null')));
    }catch(e){ check('seeded sign-in', false, e.message); }
  });

  // A device with real accounts is never overwritten
  const own = load('technician-app.html', {seed: {
    customers: [],
    technicians: [{id:'x', name:'Their Own Person', username:'bob', password:'p'}]
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
  check('  the field apps keep their own local sign-in',
        fs.readFileSync('technician-app.html','utf8').indexOf('SUPABASE_URL') === -1);
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

setTimeout(()=>{
  deferred.forEach(fn => {
    try{ fn(); }catch(e){ check('deferred check', false, e.message); }
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}, 2500);
