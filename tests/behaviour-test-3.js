// Part 3 of 4. The suite was one file until it grew past what could
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

console.log('\n=== Customer Customization is its own tab ===');
{
  const seed = {
    customers: [{id:'a', name:'Alpha One', active:true, hasPool:true, hasSpa:true}],
    chemConfig: {pool:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[]},
                 spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    const tabs = Array.from(d.querySelectorAll('.tab')).map(t => t.dataset.view);
    check('  the tab exists', tabs.indexOf('customerconfig') !== -1, tabs.join(','));
    check('  it sits after Route Scheduling',
          tabs.indexOf('customerconfig') === tabs.indexOf('map') + 1);
    check('  and before Technicians',
          tabs.indexOf('customerconfig') === tabs.indexOf('technicians') - 1);

    w.eval("switchView('customerconfig');");
    check('  opening it does not throw', true);
    check('  the heading changes',
          d.getElementById('chemConfigHeading').textContent === 'Customer Customization',
          d.getElementById('chemConfigHeading').textContent);
    check('  the body-of-water buttons are hidden',
          d.getElementById('chemConfigTypeControl').style.display === 'none');
    check('  it opens in custom mode', w.eval('selectedChemConfigType') === 'custom');
    check('  the customer picker is shown',
          d.getElementById('customConfigPicker').style.display !== 'none');
    check('  its own tab is highlighted',
          Array.from(d.querySelectorAll('.tab'))
            .find(t => t.dataset.view === 'customerconfig').classList.contains('active'));

    w.eval("switchView('chemconfig');");
    check('  Readings and Dosages still works',
          d.getElementById('chemConfigHeading').textContent === 'Readings and Dosages');
    check('  its body buttons come back',
          d.getElementById('chemConfigTypeControl').style.display !== 'none');
    check('  it returns to Pool', w.eval('selectedChemConfigType') === 'pool');
    check('  Custom is no longer a body-of-water option',
          !Array.from(d.querySelectorAll('#chemConfigTypeControl .history-type-btn'))
            .some(b => b.dataset.type === 'custom'));

    // Every other tab must still open
    ['customers','map','technicians','productsservices','workcenter','history','settings']
      .forEach(v => { w.eval("switchView('" + v + "');"); });
    check('  every other tab still opens', true);
  }catch(e){
    check('  Customer Customization tab', false, e.message);
  }
}


console.log('\n=== Message all customers ===');
{
  const seed = {
    customers: [
      {id:'a', name:'Alpha One', active:true, email:'alpha@example.com'},
      {id:'b', name:'Bravo Two', active:true, email:'bravo@example.com'},
      {id:'c', name:'Charlie Three', active:true, email:''},
      {id:'d', name:'Delta Four', active:false, email:'delta@example.com'},
      {id:'e', name:'Echo Five', active:true, email:'alpha@example.com'}
    ]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  const cats = ()=> Array.from(d.querySelectorAll('#wcBroadcastCategories button')).map(labelOf);
  const tpls = ()=> Array.from(d.querySelectorAll('#wcBroadcastTemplates button')).map(labelOf);

  try{
    w.eval("switchView('workcenter');");
    const tab = Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
      .find(b => b.dataset.type === 'broadcast');
    check('  the WorkCenter offers it', !!tab);
    if(!tab) return;
    check('  the tab is called Email', tab.textContent.trim() === 'Email', tab.textContent);
    tab.click();
    check('  its section opens', d.getElementById('wcBroadcastSection').style.display === 'block');

    // Nothing is selected until the user says so
    check('  nobody is selected to begin with',
          w.eval('broadcastRecipients().length') === 0);
    check('  and it says so plainly',
          d.getElementById('wcBroadcastCount').textContent.indexOf('Nobody selected yet') !== -1,
          d.getElementById('wcBroadcastCount').textContent);
    check('  there is no send-to toggle any more',
          !d.getElementById('wcAudienceAll') && !d.getElementById('wcAudiencePick'));
    check('  the customer list is always shown',
          d.getElementById('wcRecipientPicker').style.display !== 'none');
    check('  Select all uses the dark green style',
          d.getElementById('wcRecipientAll').className.indexOf('btn-primary') !== -1,
          d.getElementById('wcRecipientAll').className);
    const rows = Array.from(d.querySelectorAll('#wcRecipientList label')).map(l => l.textContent);
    // Three active customers have an email; two of them share one address, so
    // three people are listed but only two addresses are sent to
    check('  only customers with an email are listed', rows.length === 3, rows.length + ' listed');
    check('  a customer with no email is not listed', rows.join().indexOf('Charlie') === -1);
    check('  an inactive customer is not listed', rows.join().indexOf('Delta') === -1);
    const boxes = d.querySelectorAll('#wcRecipientList input[type=checkbox]');
    boxes[0].click();
    check('  ticking one selects it', w.eval('broadcastRecipients().length') === 1,
          w.eval('JSON.stringify(broadcastRecipients())'));
    check('  the count reflects the selection',
          d.getElementById('wcBroadcastCount').textContent.indexOf('1 of 3 selected') !== -1,
          d.getElementById('wcBroadcastCount').textContent);

    d.getElementById('wcRecipientNone').click();
    check('  Clear deselects everyone', w.eval('broadcastRecipients().length') === 0);

    d.getElementById('wcRecipientAll').click();
    check('  Select all picks everyone listed', w.eval('broadcastRecipients().length') === 2,
          w.eval('JSON.stringify(broadcastRecipients())'));

    // Searching then selecting all only takes the matches
    d.getElementById('wcRecipientNone').click();
    d.getElementById('wcRecipientSearch').value = 'alpha';
    d.getElementById('wcRecipientSearch').dispatchEvent(new w.Event('input', {bubbles:true}));
    d.getElementById('wcRecipientAll').click();
    check('  Select all respects the search',
          w.eval('broadcastRecipients().length') === 1,
          w.eval('JSON.stringify(broadcastRecipients())'));

    // Categories and templates
    check('  categories are offered', cats().indexOf('Weather') !== -1, cats().join(','));
    check('  a storm warning ships by default', tpls().indexOf('Storm warning') !== -1, tpls().join(','));
    check('  it loads on opening',
          d.getElementById('wcBroadcastSubject').value.indexOf('Storm') !== -1);
    check('  the message mentions running the system',
          d.getElementById('wcBroadcastBody').value.indexOf('Turn your system on') !== -1);
    check('  and emptying the baskets',
          d.getElementById('wcBroadcastBody').value.indexOf('baskets') !== -1);

    // Filtering by category
    Array.from(d.querySelectorAll('#wcBroadcastCategories button'))
      .find(b => labelOf(b) === 'Weather').click();
    check('  choosing a category filters the list',
          tpls().indexOf('Holiday schedule') === -1 && tpls().indexOf('Storm warning') !== -1,
          tpls().join(','));

    // Saving a new one
    w.eval("promptDialog = (q)=> Promise.resolve(q.indexOf('Category') !== -1 ? 'Green Pools' : 'Algae notice');");
    d.getElementById('wcBroadcastBody').value = 'Your pool has turned green.';
    d.getElementById('wcBroadcastSave').click();

    deferred.push(()=>{
      const stored = JSON.parse(w.eval("JSON.stringify(lsGet('broadcastTemplates') || [])"));
      check('  a saved template is stored',
            stored.some(t => t.name === 'Algae notice'), stored.map(t=>t.name).join(','));
      check('  with its category',
            stored.some(t => t.category === 'Green Pools'));
      check('  a new category appears', cats().indexOf('Green Pools') !== -1, cats().join(','));
      check('  the built-in ones survive alongside it',
            stored.some(t => t.name === 'Storm warning'));
      check('  update and delete become available',
            d.getElementById('wcBroadcastUpdate').style.display !== 'none'
            && d.getElementById('wcBroadcastDelete').style.display !== 'none');
    });

    // Privacy: each customer gets their own email, so no address is shared
    const src = fs.readFileSync('customer-intake.html','utf8');
    check('  it sends one email per customer', src.indexOf('for(const cust of chosen){') !== -1);
    check('  there is no recipient limit to work around', src.indexOf('link.length > 1800') === -1);
  }catch(e){
    check('  message all customers', false, e.message);
  }
}


console.log('\n=== Templates sign with the company name ===');
{
  function openBroadcast(company){
    const seed = {customers:[{id:'a', name:'Alpha', active:true, email:'a@example.com'}]};
    if(company !== null) seed.companyName = company;
    const {dom} = load('customer-intake.html', {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    w.eval("switchView('workcenter');");
    const tab = Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
      .find(b => b.dataset.type === 'broadcast');
    if(tab) tab.click();
    return {w, d};
  }

  try{
    const src = fs.readFileSync('customer-intake.html','utf8');
    check('  no company name is hardcoded in a template',
          src.indexOf("Thank you,\\nTrifific") === -1);
    check('  the company name lives on the Account page',
          src.indexOf('id="acctCompanyName"') !== -1);

    const a = openBroadcast('Blue Water Pools');
    const body = a.d.getElementById('wcBroadcastBody').value;
    check('  a set name is used to sign off',
          body.trim().split('\n').pop() === 'Blue Water Pools',
          body.trim().split('\n').pop());
    a.d.getElementById('btnAccount').click();
    check('  the Account page shows it',
          a.d.getElementById('acctCompanyName').value === 'Blue Water Pools',
          a.d.getElementById('acctCompanyName').value);

    const b = openBroadcast(null);
    const body2 = b.d.getElementById('wcBroadcastBody').value;
    check('  with none set it falls back sensibly',
          body2.trim().split('\n').pop() === 'Your pool service',
          body2.trim().split('\n').pop());
    check('  and never reads "undefined"', body2.indexOf('undefined') === -1);

    b.d.getElementById('btnAccount').click();
    const f = b.d.getElementById('acctCompanyName');
    f.value = 'Clearwater Pool Co';
    f.dispatchEvent(new b.w.Event('change', {bubbles:true}));
    check('  typing one saves it', b.w.eval("lsGet('companyName')") === 'Clearwater Pool Co');
    check('  and it is used from then on', b.w.eval('companyName()') === 'Clearwater Pool Co');
  }catch(e){
    check('  company name in templates', false, e.message);
  }
}


console.log('\n=== Making your own email categories ===');
{
  function openIt(store){
    const seed = Object.assign({companyName:'Blue Water Pools',
      customers:[{id:'a', name:'Alpha', active:true, email:'a@example.com'}]}, store||{});
    const {dom} = load('customer-intake.html', {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    w.eval("switchView('workcenter');");
    const tab = Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
      .find(b => b.dataset.type === 'broadcast');
    if(tab) tab.click();
    return {w, d};
  }
  const cats = d => Array.from(d.querySelectorAll('#wcBroadcastCategories button')).map(labelOf);

  try{
    const a = openIt();
    check('  an add-category button is offered', cats(a.d).indexOf('+') !== -1,
          cats(a.d).join(','));


    a.w.eval("promptDialog = ()=> Promise.resolve('Green Pools');");
    Array.from(a.d.querySelectorAll('#wcBroadcastCategories button'))
      .find(b => labelOf(b) === '+').click();

    deferred.push(()=>{
      check('  a new category appears', cats(a.d).indexOf('Green Pools') !== -1, cats(a.d).join(','));
      check('  it is saved', a.w.eval("JSON.stringify(lsGet('broadcastCategories'))").indexOf('Green Pools') !== -1);
      check('  and becomes the selected one', a.w.eval('broadcastCategory') === 'Green Pools');

      // An empty category survives a reload
      const b = openIt({broadcastCategories: ['Green Pools']});
      check('  an empty category survives a reload',
            cats(b.d).indexOf('Green Pools') !== -1, cats(b.d).join(','));
    });

    // Renaming carries its templates along
    const r = openIt();
    r.w.eval("confirmDialog = ()=> Promise.resolve(true); promptDialog = ()=> Promise.resolve('Storms');");
    r.w.eval("manageBroadcastCategory('Weather');");
    deferred.push(()=>{
      check('  renaming a category renames it', cats(r.d).indexOf('Storms') !== -1, cats(r.d).join(','));
      check('  its templates move with it',
            r.w.eval("loadBroadcastTemplates().filter(t=>t.category==='Storms').length") === 2);
      check('  the old name is gone', cats(r.d).indexOf('Weather') === -1);
    });

    // Removing via the visible × keeps the templates
    const x = openIt();
    x.w.eval("var first = true; confirmDialog = ()=>{ if(first){ first = false; return Promise.resolve(false); } return Promise.resolve(true); };");
    const weatherBtn = Array.from(x.d.querySelectorAll('#wcBroadcastCategories button'))
      .find(b => b.textContent.indexOf('Weather') === 0);
    const wx = weatherBtn && weatherBtn.querySelector('span');
    check('  a category carries a hidden remove control', !!wx);
    if(wx) wx.click();
    deferred.push(()=>{
      check('  removing a category removes it', cats(x.d).indexOf('Weather') === -1, cats(x.d).join(','));
      check('  its templates are kept, not deleted',
            x.w.eval("loadBroadcastTemplates().length") === 6,
            x.w.eval("loadBroadcastTemplates().length") + ' kept');
      check('  they move to Uncategorised',
            x.w.eval("loadBroadcastTemplates().filter(t=>t.category==='Uncategorised').length") === 2);
    });
  }catch(e){
    check('  custom categories', false, e.message);
  }
}


console.log('\n=== The email screen stays compact ===');
{
  const {dom} = load('customer-intake.html', {seed: {
    companyName: 'Blue Water Pools',
    customers: [{id:'a', name:'Alpha', active:true, email:'a@example.com'}]
  }});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("switchView('workcenter');");
    Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
      .find(b => b.dataset.type === 'broadcast').click();

    check('  the copy-addresses button is gone', !d.getElementById('wcBroadcastCopyAddresses'));
    check('  the copy-message button is gone', !d.getElementById('wcBroadcastCopyBody'));

    const shown = ()=> ['wcBroadcastOpen','wcBroadcastSave','wcBroadcastUpdate','wcBroadcastDelete']
      .map(id => d.getElementById(id))
      .filter(b => b && b.style.display !== 'none')
      .map(b => b.textContent.trim());

    const row = d.getElementById('wcBroadcastOpen').parentElement;
    check('  every action sits in one row',
          ['wcBroadcastSave','wcBroadcastUpdate','wcBroadcastDelete']
            .every(id => d.getElementById(id).parentElement === row));

    check('  a selected template offers save and delete',
          shown().join(',') === 'Send emails,Save changes,Delete', shown().join(','));

    const plus = Array.from(d.querySelectorAll('#wcBroadcastTemplates button'))
      .find(b => b.textContent === '+');
    check('  templates have their own add button', !!plus);
    plus.click();
    check('  pressing it clears the form', d.getElementById('wcBroadcastBody').value === '');
    check('  and offers save as new instead',
          shown().join(',') === 'Send emails,Save as new', shown().join(','));
  }catch(e){
    check('  compact email screen', false, e.message);
  }
}


console.log('\n=== Photos are WebP, and kept for three years ===');
{
  ['customer-intake.html','technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    check(file + ' encodes photos as WebP', src.indexOf("toDataURL('image/webp', quality)") !== -1);
    check(file + ' falls back to JPEG if refused',
          src.indexOf("out = canvas.toDataURL('image/jpeg', quality);") !== -1);
  });

  const now = Date.now();
  const yearsAgo = y => new Date(now - y*365*86400000).toISOString();
  const seed = {
    customers: [{id:'a', name:'Alpha', active:true, hasPool:true}],
    'readings:a': [
      {id:'r1', date: yearsAgo(0.1), chlorine:'3', photo:'idb:recent1'},
      {id:'r2', date: yearsAgo(2.95), chlorine:'3', photo:'idb:soon1', beforePhoto:'idb:soon2'},
      {id:'r3', date: yearsAgo(4), chlorine:'3', photo:'idb:old1', gatePhoto:'idb:old2'}
    ]
  };

  // The survey spots what is old
  {
    const {dom} = load('technician-app.html', {seed});
    const w = dom.window;
    w.console.warn = ()=>{};
    const s = JSON.parse(w.eval("JSON.stringify(surveyOldPhotos())"));
    check('  photos near three years are flagged', s.expiring === 2, JSON.stringify(s));
    check('  photos past three years are counted', s.expired === 2, JSON.stringify(s));
    check('  the keep window is three years', w.eval('PHOTO_KEEP_YEARS') === 3);
    check('  warnings start before deletion', w.eval('PHOTO_WARN_DAYS') > 0);
  }

  // The warning appears in Settings
  {
    const {dom} = load('customer-intake.html', {seed: {
      customers: [{id:'a', name:'Alpha', active:true}],
      'readings:a': [{id:'r2', date: yearsAgo(2.95), photo:'idb:soon1', beforePhoto:'idb:soon2'}]
    }});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    w.eval("switchView('settings');");
    const box = d.getElementById('photoRetentionNotice');
    check('  Settings warns before photos go', box && box.style.display !== 'none');
    if(box){
      const t = box.textContent;
      check('  it says how many', t.indexOf('2 photos') !== -1, t.slice(0, 40));
      check('  it advises a backup', t.indexOf('download a backup') !== -1);
      check('  it says the loss is permanent', t.indexOf('gone for good') !== -1);
      check('  it says reports are NOT affected',
            t.indexOf('service reports are NOT affected') !== -1, t.slice(0, 120));
      check('  it spells out what is kept',
            t.indexOf('every visit, reading, dosage and note') !== -1);
      check('  it says only the photographs go',
            t.indexOf('Only the photographs go') !== -1);
    }
  }
}


console.log('\n=== Emailing a filter clean group ===');
{
  const seed = {
    companyName: 'Blue Water Pools',
    accountEmail: 'me@bluewaterpools.com',
    customers: [
      {id:'a', name:'Alpha One', active:true, email:'alpha@x.com'},
      {id:'b', name:'Bravo Two', active:true, email:'bravo@x.com'},
      {id:'c', name:'Charlie Three', active:true, email:''}
    ],
    filterGroups: [
      {id:'g1', name:'Tuesday north', customerIds:['a','b','c'], date:'2026-09-22'},
      {id:'g2', name:'Thursday south', customerIds:['a'], date:''},
      {id:'g3', name:'Empty group', customerIds:[], date:'2026-10-01'}
    ]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("switchView('workcenter');");
    Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
      .find(b => b.dataset.type === 'filters').click();

    const head = d.querySelector('#wcFiltersSection .section-head');
    const labels = Array.from(head.querySelectorAll('button')).map(b => b.textContent);
    check('  an Email button is in the heading', labels.indexOf('Email') !== -1, labels.join(','));
    check('  New group sits first, then Schedule, then Email',
          labels.indexOf('+ New group') === 0
          && labels.indexOf('Schedule') === 1
          && labels.indexOf('Email') === 2, labels.join(','));

    // The message is built from the editable template
    const body = w.eval("fillFilterEmail(loadFilterEmail().body, ['Tuesday, September 22, 2026'])");
    check('  the message names the scheduled date',
          body.indexOf('September 22, 2026') !== -1, body.slice(0, 80));
    check('  and is signed with the company name',
          body.trim().split('\n').pop() === 'Blue Water Pools');
    check('  a group with no date reads sensibly',
          w.eval("filterGroupDateText(filterGroups[1])").indexOf('still to be confirmed') !== -1);
    check('  two dates are joined into one sentence',
          w.eval("joinDates(['Monday','Tuesday'])") === 'Monday and Tuesday');
    check('  three or more read naturally',
          w.eval("joinDates(['Mon','Tue','Wed'])") === 'Mon, Tue, and Wed');

    d.getElementById('btnEmailFilterGroups').click();
    deferred.push(()=>{
      const ov = d.querySelector('.confirm-overlay');
      check('  choosing groups opens a picker', !!ov);
      if(!ov) return;
      const rows = Array.from(ov.querySelectorAll('label')).map(l => l.textContent);
      check('  groups with customers are listed', rows.length === 2, rows.length + ' listed');
      check('  an empty group is left out', rows.join().indexOf('Empty group') === -1);
      check('  each row shows how many have an email',
            rows[0].indexOf('2 of 3') !== -1, rows[0].slice(0, 60));
      check('  and its own date', rows[0].indexOf('September 22') !== -1);
    });
  }catch(e){
    check('  filter group email', false, e.message);
  }
}


console.log('\n=== Delete controls appear on hover, consistently ===');
{
  const {dom} = load('customer-intake.html', {seed: {
    companyName: 'Blue Water',
    accountEmail: 'me@x.com',
    customers: [{id:'a', name:'Alpha', active:true, email:'a@x.com'}]
  }});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("switchView('workcenter');");
    Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
      .find(b => b.dataset.type === 'broadcast').click();

    const cat = Array.from(d.querySelectorAll('#wcBroadcastCategories button'))
      .find(b => b.textContent.indexOf('Weather') === 0);
    const cx = cat && cat.querySelector('span');
    check('  a category has a delete control', !!cx);
    check('  it is hidden at rest', cx && cx.style.opacity === '0', cx && cx.style.opacity);
    cat.dispatchEvent(new w.Event('mouseenter'));
    check('  hovering reveals it', cx.style.opacity === '1');
    cat.dispatchEvent(new w.Event('mouseleave'));
    check('  leaving hides it again', cx.style.opacity === '0');
    check('  it is the same red used elsewhere', cx.style.color === 'var(--rust)', cx.style.color);

    const tpl = Array.from(d.querySelectorAll('#wcBroadcastTemplates button'))
      .find(b => b.textContent.indexOf('Storm') === 0);
    const tx = tpl && tpl.querySelector('span');
    check('  a template has one too', !!tx);
    check('  hidden the same way', tx && tx.style.opacity === '0');
    tpl.dispatchEvent(new w.Event('mouseenter'));
    check('  revealed the same way', tx.style.opacity === '1');

    const all = Array.from(d.querySelectorAll('#wcBroadcastCategories button'))
      .find(b => b.textContent === 'All');
    check('  All has none', !all.querySelector('span'));
    const plus = Array.from(d.querySelectorAll('#wcBroadcastCategories button'))
      .find(b => b.textContent === '+');
    check('  the add button has none', !plus.querySelector('span'));

    // It actually deletes
    w.eval("confirmDialog = ()=> Promise.resolve(true);");
    tx.click();
    deferred.push(()=>{
      check('  pressing it deletes the template',
            w.eval("loadBroadcastTemplates().length") === 5,
            w.eval("loadBroadcastTemplates().length") + ' left');
      check('  and it leaves the row',
            Array.from(d.querySelectorAll('#wcBroadcastTemplates button'))
              .every(b => b.textContent.indexOf('Storm') !== 0));
    });
  }catch(e){
    check('  hover delete controls', false, e.message);
  }
}


console.log('\n=== The WorkCenter tab always matches what is shown ===');
{
  const {dom} = load('customer-intake.html', {seed: {
    companyName: 'Blue Water',
    customers: [{id:'a', name:'Alpha', active:true, email:'a@x.com'}]
  }});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  const ids = ['wcQuotesSection','wcQuotesHistoryCard','wcCallsSection',
               'wcCallsListCard','wcFiltersSection','wcBroadcastSection'];
  const shown = ()=> ids.filter(id => {
    const e = d.getElementById(id);
    return e && e.style.display !== 'none';
  });
  const activeTab = ()=>{
    const b = Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
      .find(x => x.classList.contains('active'));
    return b ? b.dataset.type : null;
  };
  const press = t => Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
    .find(b => b.dataset.type === t).click();

  try{
    w.eval("switchView('workcenter');");
    check('  it opens on Work Orders', activeTab() === 'quotes', activeTab());

    press('broadcast');
    check('  pressing Email selects it', activeTab() === 'broadcast');
    check('  and shows only the email section',
          shown().join(',') === 'wcBroadcastSection', shown().join(','));

    // The bug: leaving and returning left the email section on screen
    w.eval("switchView('customers'); switchView('workcenter');");
    check('  returning selects Work Orders again', activeTab() === 'quotes', activeTab());
    check('  and the email section is hidden',
          shown().indexOf('wcBroadcastSection') === -1, shown().join(','));
    check('  showing the work order sections instead',
          shown().join(',') === 'wcQuotesSection,wcQuotesHistoryCard', shown().join(','));

    // Same for filter cleans
    press('filters');
    check('  filter cleans shows only its own section',
          shown().join(',') === 'wcFiltersSection', shown().join(','));
    w.eval("switchView('settings'); switchView('workcenter');");
    check('  and is hidden on returning',
          shown().indexOf('wcFiltersSection') === -1, shown().join(','));

    // No mode may leave another's section visible
    let clean = true;
    [['quotes',2],['filters',1],['broadcast',1]].forEach(([m,n])=>{
      w.eval("applyWorkCenterMode('" + m + "');");
      if(shown().length !== n) clean = false;
    });
    check('  every mode shows only its own sections', clean);
  }catch(e){
    check('  workcenter mode consistency', false, e.message);
  }
}


console.log('\n=== Emails send directly, one per customer ===');
{
  // The sending itself is asynchronous, so it is exercised in email-test.js.
  // Here we only confirm the app no longer routes through a mail app.
  const src = fs.readFileSync('customer-intake.html','utf8');
  check('  nothing opens a mail app any more', src.indexOf('mailto:') === -1);
  check('  sending does not demand an account email',
        src.indexOf("if(!accountEmail()){") === -1);
  check('  both features send through one function',
        (src.match(/sendCustomerEmail\(/g) || []).length >= 3);
}


console.log('\n=== A confirmation always sits above what opened it ===');
{
  const src = fs.readFileSync('customer-intake.html','utf8');

  // Every overlay the app opens itself, and the shared confirmation's CSS
  const inline = (src.match(/z-index:(\d+);padding:18px/g) || [])
    .map(s => parseInt(s.match(/\d+/)[0]));
  const cssMatch = src.match(/\.confirm-overlay\{[^}]*z-index:(\d+)/);
  const confirmZ = cssMatch ? parseInt(cssMatch[1]) : null;

  check('  the shared confirmation has a z-index', confirmZ !== null, String(confirmZ));
  check('  pickers and editors sit below it',
        inline.length > 0 && inline.every(z => z < confirmZ),
        'pickers at ' + inline.join(',') + ' vs confirmation at ' + confirmZ);
}


console.log('\n=== Heads-up reminders before arriving ===');
{
  // The setting, on the website
  {
    const {dom} = load('customer-intake.html', {seed: {
      customers: [{id:'a', name:'Alpha One', active:true, hasPool:true, phone:'5551234'}],
      chemConfig: {pool:{chemicals:[],dosages:[]}, spa:{chemicals:[],dosages:[]},
                   fountain:{chemicals:[],dosages:[]}}
    }});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};

    try{
      w.eval("switchView('customerconfig');");
      check('  the card hides with no customer chosen',
            d.getElementById('customerNotifyCard').style.display === 'none');

      w.eval("customCustomerId = 'a'; renderChemConfigLists();");
      check('  it appears once one is picked',
            d.getElementById('customerNotifyCard').style.display === 'block');
      check('  it is called an automatic on my way message',
            d.getElementById('customerNotifyHeading').textContent
              .indexOf('Automatic on my way message') === 0,
            d.getElementById('customerNotifyHeading').textContent);
      check('  and names them',
            d.getElementById('customerNotifyHeading').textContent.indexOf('Alpha') !== -1);
      check('  the toggle says it sends automatically',
            fs.readFileSync('customer-intake.html','utf8')
              .indexOf('Send an automatic message to this customer') !== -1);
      check('  the stops setting is hidden while it is off',
            d.getElementById('autoNotifyLeadField').style.display === 'none');

      d.getElementById('chkAutoNotify').click();
      check('  turning it on saves against the customer',
            w.eval("customers[0].autoNotify") === true);
      check('  with a sensible default', w.eval("customers[0].autoNotifyLead") === 2);
      check('  and reveals the stops setting',
            d.getElementById('autoNotifyLeadField').style.display === 'block');
      check('  which explains what will happen',
            d.getElementById('autoNotifyExplain').textContent.indexOf('2 before') !== -1);

      const sel = d.getElementById('autoNotifyLead');
      sel.value = '4';
      sel.dispatchEvent(new w.Event('change', {bubbles:true}));
      check('  choosing a different number saves it',
            w.eval("customers[0].autoNotifyLead") === 4);
    }catch(e){ check('  heads-up setting', false, e.message); }
  }

  // The lookahead, in the field apps
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const custs = ['A','B','C','D','E'].map((n,i)=>({
    id:'c'+i, name:'Cust '+n, day: today, active:true, technicianId:'t1',
    hasPool:true, phone:'555000'+i
  }));
  custs[3].autoNotify = true;
  custs[3].autoNotifyLead = 2;

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const {dom} = load(file, {seed: {
      technicians: [{id:'t1', name:'Alex'}],
      customers: custs,
      afterPhotoDefaultFixed: true,
      chemConfig: {pool:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[]},
                   spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
    }});
    const w = dom.window;
    w.console.warn = ()=>{};
    try{
      w.eval("currentUser = {id:'t1', name:'Alex'}; renderHomeList();");
      check(file + ' reads the route in order',
            w.eval("JSON.stringify(routeOrderToday().map(c=>c.name))")
              === '["Cust A","Cust B","Cust C","Cust D","Cust E"]',
            w.eval("JSON.stringify(routeOrderToday().map(c=>c.name))"));

      w.eval("window.__prompted = false; confirmDialog = ()=>{ window.__prompted = true; return Promise.resolve(true); };");
      w.eval("window.__sentTo = null; sendOnMyWay = (c)=>{ window.__sentTo = c.name; };");

      // Two stops before D is B
      w.eval("checkHeadsUpAfter('c1');");
      deferred.push(()=>{
        check(file + ' sends two stops before the customer',
              w.eval('window.__sentTo') === 'Cust D', String(w.eval('window.__sentTo')));
        check(file + ' without asking first', w.eval('window.__prompted') === false);
        check(file + ' through one switchable function',
              w.eval("typeof dispatchHeadsUp") === 'function');
      });
    }catch(e){ check(file + ' heads-up lookahead', false, e.message); }
  });

  // And not at the wrong stop
  {
    const {dom} = load('technician-app.html', {seed: {
      technicians: [{id:'t1', name:'Alex'}],
      customers: custs,
      afterPhotoDefaultFixed: true,
      chemConfig: {pool:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[]},
                   spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
    }});
    const w = dom.window;
    w.console.warn = ()=>{};
    w.eval("currentUser = {id:'t1', name:'Alex'}; renderHomeList();");
    w.eval("window.__sentTo = null; sendOnMyWay = (c)=>{ window.__sentTo = c.name; };");
    w.eval("checkHeadsUpAfter('c0');");
    deferred.push(()=>{
      check('  it stays quiet three stops out', w.eval('window.__sentTo') === null,
            String(w.eval('window.__sentTo')));
    });
  }
}


console.log('\n=== Tasks sent to a route ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha One', day: today, active:true, technicianId:'t1', hasPool:true}],
    chemConfig: {pool:{chemicals:[],dosages:[]}, spa:{chemicals:[],dosages:[]},
                 fountain:{chemicals:[],dosages:[]}}
  };

  // Creating one on the website
  let saved = null;
  {
    const {dom} = load('customer-intake.html', {seed});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.Element.prototype.scrollIntoView = function(){};
    try{
      w.eval("switchView('workcenter');");
      const types = Array.from(d.querySelectorAll('#wcTypeToggle [data-wctype]')).map(b => b.textContent);
      check('  Task sits alongside Quote and Work Order',
            types.join('|') === 'Quote|Work Order|Task', types.join('|'));

      d.getElementById('btnTypeTask').click();
      check('  choosing it shows the task form',
            d.getElementById('wcTaskSection').style.display === 'block');
      check('  and hides the quote history',
            d.getElementById('wcQuotesHistoryCard').style.display === 'none');
      check('  the day is prefilled', !!d.getElementById('taskDate').value);
      check('  technicians are listed',
            d.getElementById('taskTechnician').options.length > 0);
      check('  the customer label is just "Customer"',
            fs.readFileSync('customer-intake.html','utf8')
              .indexOf('<label>Customer <span') !== -1);
      check('  customers use the same chip picker as a work order',
            !!d.getElementById('taskCustomerChips') && !!d.getElementById('taskCustomerSuggest'));
      check('  and start empty, so they stay optional',
            w.eval('taskPicked.size') === 0);
      check('  a repeat option is offered', !!d.getElementById('taskRepeat'));

      d.getElementById('taskTitle').value = 'Photograph the heater model plate';
      d.getElementById('taskDetails').value = 'Customer wants a quote.';
      d.getElementById('taskTechnician').value = 't1';
      d.getElementById('btnSaveTask').click();

      saved = JSON.parse(w.eval("JSON.stringify(lsGet('tasks') || [])"));
      check('  saving stores the task', saved.length === 1, saved.length + ' stored');
      check('  with what was typed', saved[0].title.indexOf('heater') !== -1);
      check('  the form clears afterwards', d.getElementById('taskTitle').value === '');
      check('  and it appears in the list',
            d.getElementById('wcTaskList').textContent.indexOf('heater') !== -1);

      d.getElementById('btnTypeQuote').click();
      check('  switching back hides the task form',
            d.getElementById('wcTaskSection').style.display === 'none');
      check('  and restores the quote history',
            d.getElementById('wcQuotesHistoryCard').style.display === 'block');
    }catch(e){ check('  task creation', false, e.message); }
  }

  // Seeing it in the field
  if(saved){
    ['technician-app.html','admin-readings-app.html'].forEach(file=>{
      const {dom} = load(file, {seed: Object.assign({tasks: saved}, seed)});
      const w = dom.window, d = w.document;
      w.console.warn = ()=>{};
      try{
        w.eval("currentUser = {id:'t1', name:'Alex'}; renderHomeList();");
        const card = d.getElementById('routeTaskCard');
        check(file + ' shows the task on the route', card && card.style.display === 'block');
        check(file + ' with what needs doing',
              card.textContent.indexOf('heater') !== -1, card.textContent.slice(0, 50));
        check(file + ' and its details', card.textContent.indexOf('wants a quote') !== -1);
      }catch(e){ check(file + ' route tasks', false, e.message); }
    });

    // A task for someone else stays hidden
    const {dom} = load('technician-app.html', {seed: Object.assign({
      tasks: [Object.assign({}, saved[0], {technicianId: 'someone-else'})]
    }, seed)});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.eval("currentUser = {id:'t1', name:'Alex'}; renderHomeList();");
    check('  another technician\u2019s task is not shown',
          d.getElementById('routeTaskCard').style.display === 'none');
  }
}


console.log('\n=== Account page ===');
{
  const seed = {
    companyName: 'Blue Water Pools',
    accountEmail: 'me@bluewaterpools.com',
    technicians: [{id:'t1', name:'Alex'}, {id:'t2', name:'Sam'}],
    customers: [
      {id:'a', name:'Alpha One', active:true, hasPool:true, hasSpa:true, fountains:[{id:'f1',name:'Front'}]},
      {id:'b', name:'Bravo Two', active:true, hasPool:true},
      {id:'c', name:'Charlie', active:false, hasPool:true}
    ]
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    check('  there is a button top right', !!d.getElementById('btnAccount'));
    check('  it shows the company name at load',
          d.getElementById('accountButtonLabel').textContent === 'Blue Water Pools',
          d.getElementById('accountButtonLabel').textContent);
    check('  with its initials',
          d.getElementById('accountInitials').textContent === 'BW',
          d.getElementById('accountInitials').textContent);

    d.getElementById('btnAccount').click();
    const tabs = Array.from(d.querySelectorAll('#accountTabControl .history-type-btn'))
      .map(b => b.textContent);
    check('  it opens an account page with tabs',
          tabs.join('|') === 'Business|Contact|Plan|Email|Data', tabs.join('|'));

    check('  business details are prefilled',
          d.getElementById('acctCompanyName').value === 'Blue Water Pools');
    check('  contact details too',
          d.getElementById('acctEmail').value === 'me@bluewaterpools.com');

    const press = t => Array.from(d.querySelectorAll('#accountTabControl .history-type-btn'))
      .find(b => b.dataset.acct === t).click();

    press('plan');
    const plan = d.getElementById('acctPlanSummary').textContent;
    check('  the plan tab counts active customers', plan.indexOf('2') !== -1, plan);
    check('  and counts every body of water', plan.indexOf('4') !== -1, plan);
    check('  it is honest that there is no subscription yet',
          d.getElementById('acctPlanNote').textContent.indexOf('nothing to pay') !== -1);

    press('data');
    check('  the data tab shows what is stored',
          d.getElementById('acctDataSummary').textContent.indexOf('Customers on file') !== -1);
    check('  and offers a backup', !!d.getElementById('btnAcctBackup'));

    press('business');
    const owner = d.getElementById('acctOwnerName');
    owner.value = 'Tyrus';
    owner.dispatchEvent(new w.Event('change', {bubbles:true}));
    check('  editing a field saves it', w.eval("lsGet('ownerName')") === 'Tyrus');

    const cn = d.getElementById('acctCompanyName');
    cn.value = 'Clearwater Pool Co';
    cn.dispatchEvent(new w.Event('change', {bubbles:true}));
    check('  renaming the company updates the button',
          d.getElementById('accountButtonLabel').textContent === 'Clearwater Pool Co');

    // Settings must not still carry the same fields
    const src = fs.readFileSync('customer-intake.html','utf8');
    check('  company name is no longer duplicated in Settings',
          src.indexOf('id="settingCompanyName"') === -1);
    check('  nor the email', src.indexOf('id="settingAccountEmail"') === -1);

    // The startup calls must be top level, not trapped in a handler
    check('  the photo migration runs at startup, not on a click',
          /\}\);\n\n\/\/ The account button carries/.test(src));
  }catch(e){
    check('  account page', false, e.message);
  }
}


console.log('\n=== The Account page opens on Business after leaving it ===');
{
  const {dom} = load('customer-intake.html', {seed: {companyName: 'Blue Water Pools', customers: []}});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};
  try{
    const press = t => Array.from(d.querySelectorAll('#accountTabControl .history-type-btn'))
      .find(b => b.dataset.acct === t).click();
    const shown = () => ['acctBusiness','acctContact','acctPlan','acctEmailPanel','acctData']
      .filter(id => d.getElementById(id) && d.getElementById(id).style.display === 'block');
    const activeBtn = () => { const b = d.querySelector('#accountTabControl .history-type-btn.active'); return b ? b.dataset.acct : ''; };

    d.getElementById('btnAccount').click();
    check('  it opens on Business', shown().join() === 'acctBusiness' && activeBtn() === 'business', shown().join() + ' ' + activeBtn());

    // Every other tab, left through the real navigation buttons
    const navs = Array.from(d.querySelectorAll('.tab[data-view]')).map(t => t.dataset.view);
    check('  there are other tabs to leave through', navs.length >= 3, navs.join());
    ['plan','contact','email','data'].forEach((acct, i)=>{
      const view = navs[i % navs.length];
      press(acct);
      check('  ' + acct + ' is showing before leaving', shown().join().length > 0 && activeBtn() === acct);
      d.querySelector('.tab[data-view="' + view + '"]').click();
      d.getElementById('btnAccount').click();
      check('  after ' + acct + ', leaving to ' + view + ' and coming back shows Business',
            shown().join() === 'acctBusiness', shown().join());
      check('  with the Business button highlighted', activeBtn() === 'business', activeBtn());
    });

    // Settings is reached from its own button, not the tab row
    press('plan');
    w.eval("switchView('settings')");
    d.getElementById('btnAccount').click();
    check('  leaving to Settings and back shows Business too', shown().join() === 'acctBusiness', shown().join());
  }catch(e){
    check('  account tab reset', false, e.message);
  }
}


console.log('\n=== Salt pool skipping can be turned off ===');
{
  const seed = {
    customers: [{id:'a', name:'Alpha', active:true, hasPool:true}],
    chemConfig: {pool:{chemicals:[
        {key:'chlorine', label:'Free chlorine', doseRules:[{op:'eq',value:'1',amount:'2',doseKey:'tabs'}]},
        {key:'ph', label:'pH level', doseRules:[]}],
      dosages:[{key:'tabs', label:'Chlorine tabs'}]},
      spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  };
  const {dom} = load('customer-intake.html', {seed});
  const w = dom.window, d = w.document;
  w.console.warn = ()=>{};
  w.Element.prototype.scrollIntoView = function(){};

  try{
    w.eval("switchView('chemconfig');");
    w.eval("openDoseRulesModal(chemConfig.pool.chemicals[0]);");
    let ov = d.querySelector('.confirm-overlay');

    check('  chlorine rules offer the toggle',
          ov.querySelector('#ruleSaltRow').style.display === 'block');
    check('  it is on by default', ov.querySelector('#ruleSaltSkip').checked === true);
    check('  and explains what that means',
          ov.querySelector('#ruleSaltNote').textContent.indexOf('will not fire') !== -1);

    const t = ov.querySelector('#ruleSaltSkip');
    t.checked = false;
    t.dispatchEvent(new w.Event('change', {bubbles:true}));
    check('  turning it off saves against the reading',
          w.eval('chemConfig.pool.chemicals[0].saltSkip') === false);
    check('  and the wording changes',
          ov.querySelector('#ruleSaltNote').textContent.indexOf('will fire on salt pools') !== -1);

    ov.querySelector('#ruleDone').click();
    w.eval("openDoseRulesModal(chemConfig.pool.chemicals[1]);");
    ov = d.querySelector('.confirm-overlay');
    check('  a non-chlorine reading does not show it',
          ov.querySelector('#ruleSaltRow').style.display === 'none');
  }catch(e){ check('  salt skip toggle', false, e.message); }

  // And the field apps honour it, including per customer
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = DAYS[new Date().getDay()];
  const chem = {key:'chlorine', label:'Free chlorine',
    doseRules:[{op:'eq', value:'1', amount:'2', doseKey:'tabs'}]};
  const fieldSeed = (extraSeed)=> Object.assign({
    technicians: [{id:'t1', name:'Alex'}],
    customers: [
      {id:'salt', name:'Salt Pool', day: today, active:true, technicianId:'t1', hasPool:true,
       equipment:[{type:'Chlorination', chlorinationChoice:'Salt Cell'}]},
      {id:'salt2', name:'Salt Two', day: today, active:true, technicianId:'t1', hasPool:true,
       equipment:[{type:'Chlorination', chlorinationChoice:'Salt Cell'}]}
    ],
    afterPhotoDefaultFixed: true,
    chemConfig: {pool:{chemicals:[chem], dosages:[{key:'tabs', label:'Chlorine tabs'}]},
                 spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  }, extraSeed || {});

  function dosed(file, seedObj, custId){
    const {dom} = load(file, {seed: seedObj});
    const w = dom.window, d = w.document;
    w.console.warn = ()=>{};
    w.eval("currentUser = {id:'t1', name:'Alex'}; openVisit('" + custId + "');");
    const ch = d.getElementById('pool_chem_chlorine');
    const dose = d.getElementById('pool_dose_tabs');
    dose.value = ''; ch.value = '1';
    ch.dispatchEvent(new w.Event('input', {bubbles:true}));
    return dose.value;
  }

  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    check(file + ' skips chlorine on a salt pool by default',
          dosed(file, fieldSeed(), 'salt') === '', dosed(file, fieldSeed(), 'salt'));

    const off = JSON.parse(JSON.stringify(fieldSeed().chemConfig));
    off.pool.chemicals[0].saltSkip = false;
    check(file + ' fires on salt pools once turned off',
          dosed(file, fieldSeed({chemConfig: off}), 'salt') === '2');

    // Per customer
    const custom = {salt2: {pool: {
      chemicals: [Object.assign({}, chem, {saltSkip:false})],
      dosages: [{key:'tabs', label:'Chlorine tabs'}]}}};
    check(file + ' a per-customer override fires for that customer',
          dosed(file, fieldSeed({customChemConfig: custom}), 'salt2') === '2');
    check(file + ' and leaves other salt pools skipping',
          dosed(file, fieldSeed({customChemConfig: custom}), 'salt') === '');
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
