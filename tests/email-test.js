// Email sending is asynchronous, so it runs in its own process where each
// send can be awaited properly.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

const seed = {
  companyName: 'Blue Water Pools',
  customers: [
    {id:'a', name:'Alpha One', active:true, email:'alpha@x.com'},
    {id:'b', name:'Bravo Two', active:true, email:'bravo@x.com'},
    {id:'c', name:'Charlie Three', active:true, email:''}
  ],
  filterGroups: [
    {id:'g1', name:'Tuesday north', customerIds:['a','b','c'], date:'2026-09-22'},
    {id:'g2', name:'Thursday south', customerIds:['b'], date:'2026-10-06'}
  ]
};

function boot(){
  return new JSDOM(fs.readFileSync('customer-intake.html','utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
      w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
      w.console.warn=()=>{};
      w.Element.prototype.scrollIntoView=function(){};
      w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
      Object.keys(seed).forEach(k=> w.localStorage.setItem('poollog:'+k, JSON.stringify(seed[k])));
    }
  });
}

(async ()=>{
  // ---- The Email tab ----
  console.log('\n=== Email tab: one email per customer ===');
  {
    const dom = boot();
    await new Promise(r => setTimeout(r, 1500));
    const w = dom.window, d = w.document;
    try{
      w.eval("window.__sent = []; sendCustomerEmail = (to,s,m)=>{ window.__sent.push({to:to, subject:s, body:m}); return Promise.resolve(true); }; confirmDialog = ()=> Promise.resolve(true);");
      w.eval("switchView('workcenter');");
      Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
        .find(b => b.dataset.type === 'broadcast').click();
      d.getElementById('wcRecipientAll').click();
      d.getElementById('wcBroadcastOpen').click();
      await new Promise(r => setTimeout(r, 500));

      const sent = JSON.parse(w.eval("JSON.stringify(window.__sent)"));
      check('  each selected customer gets their own', sent.length === 2, sent.length + ' sent');
      check('  addressed individually',
            sent.map(s => s.to).sort().join(',') === 'alpha@x.com,bravo@x.com',
            sent.map(s => s.to).join(','));
      check('  the message is the one written',
            sent[0].body.indexOf('Turn your system on') !== -1);
      check('  the button goes back to normal',
            d.getElementById('wcBroadcastOpen').textContent === 'Send emails');
      check('  and it says what happened',
            d.getElementById('wcBroadcastNote').textContent.indexOf('Sent to 2') !== -1,
            d.getElementById('wcBroadcastNote').textContent);
    }catch(e){ check('  email tab send', false, e.message); }
  }

  // ---- The editable message ----
  console.log('\n=== Filter clean email can be edited ===');
  {
    const dom = boot();
    await new Promise(r => setTimeout(r, 1500));
    const w = dom.window, d = w.document;
    try{
      w.eval("switchView('workcenter');");
      Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
        .find(b => b.dataset.type === 'filters').click();
      d.getElementById('btnEmailFilterGroups').click();
      await new Promise(r => setTimeout(r, 250));

      const picker = d.querySelector('.confirm-overlay');
      const labels = Array.from(picker.querySelectorAll('.btn-row button')).map(b => b.textContent);
      check('  Edit email sits between Send and Cancel',
            labels.join('|') === 'Send emails|Edit email|Cancel', labels.join('|'));

      Array.from(picker.querySelectorAll('button')).find(b => b.textContent === 'Edit email').click();
      await new Promise(r => setTimeout(r, 250));

      const editor = Array.from(d.querySelectorAll('.confirm-overlay')).pop();
      check('  the editor opens', !!editor.querySelector('textarea'));
      check('  it offers reset',
            Array.from(editor.querySelectorAll('button')).some(b => b.textContent === 'Reset to default'));

      check('  there is no preview block', editor.textContent.indexOf('Preview') === -1);

      // It must keep the date placeholder
      const ta = editor.querySelector('textarea');
      ta.value = 'No placeholder at all';
      Array.from(editor.querySelectorAll('button')).find(b => b.textContent === 'Save').click();
      await new Promise(r => setTimeout(r, 200));
      check('  it refuses to save without {dates}', !!d.querySelector('textarea'));

      // A real edit saves
      ta.value = 'Custom wording. Your clean: {dates}. From {company}.';
      Array.from(editor.querySelectorAll('button')).find(b => b.textContent === 'Save').click();
      await new Promise(r => setTimeout(r, 250));
      const saved = JSON.parse(w.eval("JSON.stringify(loadFilterEmail())"));
      check('  a valid edit is kept', saved.body.indexOf('Custom wording') !== -1, saved.body.slice(0, 40));
    }catch(e){ check('  filter email editor', false, e.message); }
  }

  // ---- Filter clean groups ----
  console.log('\n=== Filter cleans: one email per customer per group ===');
  {
    const dom = boot();
    await new Promise(r => setTimeout(r, 1500));
    const w = dom.window, d = w.document;
    try{
      w.eval("window.__sent = []; sendCustomerEmail = (to,s,m)=>{ window.__sent.push({to:to, subject:s, body:m}); return Promise.resolve(true); };");
      w.eval("switchView('workcenter');");
      Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
        .find(b => b.dataset.type === 'filters').click();
      d.getElementById('btnEmailFilterGroups').click();
      await new Promise(r => setTimeout(r, 300));

      const ov = d.querySelector('.confirm-overlay');
      check('  the picker opens', !!ov);
      check('  with no account-email demand',
            ov && ov.textContent.indexOf('account settings') === -1);

      Array.from(ov.querySelectorAll('input[type=checkbox]')).forEach(cb => cb.click());
      Array.from(ov.querySelectorAll('button')).find(b => b.textContent === 'Send emails').click();
      await new Promise(r => setTimeout(r, 700));

      const sent = JSON.parse(w.eval("JSON.stringify(window.__sent)"));
      check('  one email per person, not per group', sent.length === 2, sent.length + ' sent');
      check('  a customer with no email is skipped',
            !sent.some(s => !s.to), sent.map(s => s.to).join(','));

      const alpha = sent.find(s => s.to === 'alpha@x.com');
      const bravo = sent.find(s => s.to === 'bravo@x.com');
      check('  someone in one group gets one date',
            alpha && alpha.body.indexOf('September 22') !== -1
            && alpha.body.indexOf('October 6') === -1);
      check('  someone in two groups gets both, in one email',
            bravo && bravo.body.indexOf('September 22') !== -1
            && bravo.body.indexOf('October 6') !== -1,
            bravo && bravo.body.split('\n').find(l => l.indexOf('scheduled') !== -1));
      check('  two dates read naturally',
            bravo && bravo.body.indexOf('September 22, 2026 and Tuesday, October 6') !== -1);

      // Any number of groups, not just two
      check('  one date needs no joining',
            w.eval("joinDates(['Mon'])") === 'Mon');
      check('  three dates list correctly',
            w.eval("joinDates(['A','B','C'])") === 'A, B, and C',
            w.eval("joinDates(['A','B','C'])"));
      check('  five dates list correctly',
            w.eval("joinDates(['A','B','C','D','E'])") === 'A, B, C, D, and E',
            w.eval("joinDates(['A','B','C','D','E'])"));
      check('  and it is signed with the company',
            sent[0].body.trim().split('\n').pop() === 'Blue Water Pools');
    }catch(e){ check('  filter group send', false, e.message); }
  }

  // ---- Scheduling groups onto routes ----
  console.log('\n=== Scheduling filter clean groups ===');
  {
    const schedSeed = {
      companyName: 'Blue Water Pools',
      technicians: [{id:'t1', name:'Alex'}],
      customers: [{id:'a', name:'Alpha', active:true, email:'a@x.com'},
                  {id:'b', name:'Bravo', active:true, email:'b@x.com'}],
      filterGroups: [
        {id:'g1', name:'Ready one', customerIds:['a','b'], date:'2026-09-22', technicianId:'t1', finalized:false},
        {id:'g2', name:'Already on route', customerIds:['a'], date:'2026-10-06', technicianId:'t1', finalized:true},
        {id:'g3', name:'No technician', customerIds:['a'], date:'2026-10-20', technicianId:'', finalized:false},
        {id:'g4', name:'No date', customerIds:['b'], date:'', technicianId:'t1', finalized:false}
      ],
      scheduledFilterCleans: [{id:'x1', groupId:'g2', customerId:'a', technicianId:'t1',
                               date:'2026-10-06', status:'scheduled'}]
    };
    const dom = new JSDOM(fs.readFileSync('customer-intake.html','utf8'), {
      runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
      beforeParse(w){
        w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
        w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
        w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
        w.console.warn=()=>{};
        w.Element.prototype.scrollIntoView=function(){};
        w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
        Object.keys(schedSeed).forEach(k=> w.localStorage.setItem('poollog:'+k, JSON.stringify(schedSeed[k])));
      }
    });
    await new Promise(r => setTimeout(r, 1500));
    const w = dom.window, d = w.document;

    try{
      w.eval("switchView('workcenter');");
      Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
        .find(b => b.dataset.type === 'filters').click();

      const head = d.querySelector('#wcFiltersSection .section-head');
      const labels = Array.from(head.querySelectorAll('button')).map(b => b.textContent);
      check('  Schedule is in the heading', labels.indexOf('Schedule') !== -1, labels.join(','));
      check('  New group comes first',
            labels.indexOf('+ New group') === 0, labels.join(','));
      check('  then Schedule, then Email',
            labels.indexOf('+ New group') < labels.indexOf('Schedule')
            && labels.indexOf('Schedule') < labels.indexOf('Email'), labels.join(','));

      const inCard = Array.from(d.querySelectorAll('#filterGroupList button')).map(b => b.textContent);
      check('  no Schedule button inside a group', inCard.indexOf('Schedule') === -1, inCard.join(','));
      check('  no Unschedule button either', inCard.indexOf('Unschedule') === -1, inCard.join(','));

      d.getElementById('btnScheduleFilterGroups').click();
      await new Promise(r => setTimeout(r, 300));

      const ov = d.querySelector('.confirm-overlay');
      check('  the picker opens', !!ov);
      const rows = Array.from(ov.querySelectorAll('label'));
      check('  every group is listed', rows.length === 4, rows.length + ' listed');
      check('  a group already on route starts ticked',
            rows[1].querySelector('input').checked === true);
      check('  and is marked as on route', rows[1].textContent.indexOf('ON ROUTE') !== -1);
      check('  a group missing a technician cannot be ticked',
            rows[2].querySelector('input').disabled === true);
      check('  and says what it needs', rows[2].textContent.indexOf('no technician') !== -1);
      check('  a group missing a date cannot be ticked either',
            rows[3].querySelector('input').disabled === true);

      // Tick one, untick the other
      rows[0].querySelector('input').click();
      rows[1].querySelector('input').click();
      w.eval("confirmDialog = ()=> Promise.resolve(true);");
      Array.from(ov.querySelectorAll('button')).find(b => b.textContent === 'Apply').click();
      await new Promise(r => setTimeout(r, 400));

      // The confirmation must be visible, not hidden behind the picker
      const overlays = Array.from(d.querySelectorAll('.confirm-overlay'));
      const conf = overlays.find(o => o.querySelector('.confirm-box'));
      if(conf){
        const pick = overlays.find(o => !o.querySelector('.confirm-box'));
        const zOf = el => el.style.zIndex ? parseInt(el.style.zIndex) : 300;
        check('  the confirmation sits above the picker',
              !pick || zOf(conf) > zOf(pick),
              'confirmation ' + zOf(conf) + ' vs picker ' + (pick ? zOf(pick) : 'none'));
      }

      check('  ticking schedules the group',
            w.eval("filterGroups.find(g=>g.id==='g1').finalized") === true);
      check('  unticking takes the other off',
            w.eval("filterGroups.find(g=>g.id==='g2').finalized") === false);

      const sched = JSON.parse(w.localStorage.getItem('poollog:scheduledFilterCleans'));
      check('  its route entries were created',
            sched.filter(s => s.groupId === 'g1').length === 2,
            sched.map(s => s.groupId).join(','));
      check('  and the removed one is gone from the route',
            sched.filter(s => s.groupId === 'g2').length === 0);
    }catch(e){ check('  filter group scheduling', false, e.message); }
  }

  // ---- The company name reaches every message ----
  console.log('\n=== The company name reaches mass emails ===');
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
        w.localStorage.setItem('poollog:customers',
          JSON.stringify([{id:'a', name:'Alpha', active:true, email:'a@x.com'}]));
      }
    });
    await new Promise(r => setTimeout(r, 1400));
    const w = dom.window, d = w.document;

    const openEmail = ()=>{
      w.eval("switchView('workcenter');");
      Array.from(d.querySelectorAll('#workCenterTypeControl .history-type-btn'))
        .find(b => b.dataset.type === 'broadcast').click();
    };
    const sign = ()=> d.getElementById('wcBroadcastBody').value.trim().split('\n').pop();
    const setName = async (n)=>{
      d.getElementById('btnAccount').click();
      const f = d.getElementById('acctCompanyName');
      f.value = n;
      f.dispatchEvent(new w.Event('change', {bubbles:true}));
      await new Promise(r => setTimeout(r, 150));
    };

    try{
      openEmail();
      check('  with no name set it falls back', sign() === 'Your pool service', sign());

      await setName('Trifific Pool and Spa');
      openEmail();
      check('  entering a name reaches an open message',
            sign() === 'Trifific Pool and Spa', sign());

      await setName('Clearwater Pools');
      openEmail();
      check('  renaming updates it again', sign() === 'Clearwater Pools', sign());

      check('  every template carries the name',
            w.eval("loadBroadcastTemplates().every(t => t.body.indexOf('Clearwater Pools') !== -1)"));
      check('  and none still shows the placeholder',
            w.eval("loadBroadcastTemplates().every(t => t.body.indexOf('{company}') === -1)"));

      // Picking a template afterwards must be right too
      const tpl = Array.from(d.querySelectorAll('#wcBroadcastTemplates button'))
        .find(b => /Freeze/.test(b.textContent));
      if(tpl){
        tpl.click();
        await new Promise(r => setTimeout(r, 150));
        check('  a template picked later is correct too', sign() === 'Clearwater Pools', sign());
      }

      // Something written by hand must survive a rename untouched
      d.getElementById('wcBroadcastBody').value = 'Something I wrote entirely myself.';
      await setName('Blue Water');
      openEmail();
      check('  a hand-written message is never rewritten',
            d.getElementById('wcBroadcastBody').value === 'Something I wrote entirely myself.',
            d.getElementById('wcBroadcastBody').value);
    }catch(e){ check('  company name in mass emails', false, e.message); }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
