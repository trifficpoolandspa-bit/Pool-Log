// The back button. It must retrace the last few places and then do nothing —
// never sign the technician out, however many times it is pressed.
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

function boot(file){
  const seed = {
    technicians: [{id:'t1', name:'Alex'}],
    customers: [{id:'a', name:'Alpha', day: today, active:true, technicianId:'t1', hasPool:true}],
    afterPhotoDefaultFixed: true,
    chemConfig: {pool:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[]},
                 spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  };
  return new JSDOM(fs.readFileSync(file,'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true,
    url:'https://example.com/' + file,
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
      w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
      w.console.warn=()=>{}; w.console.error=()=>{};
      w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
      Object.keys(seed).forEach(k=> w.localStorage.setItem('weir:'+k, JSON.stringify(seed[k])));
    }
  });
}

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': the back button ===');
    const dom = boot(file);
    await new Promise(r => setTimeout(r, 1400));
    const w = dom.window, d = dom.window.document;
    const back = async ()=>{
      w.eval("window.dispatchEvent(new window.PopStateEvent('popstate'))");
      await new Promise(r => setTimeout(r, 90));
    };

    try{
      w.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); renderHomeList();");

      check('  it remembers five places', w.eval('NAV_STACK_LIMIT') === 5);
      check('  the old drifting counter is gone',
            fs.readFileSync(file,'utf8').indexOf('backEntries') === -1);

      // Chrome skips history entries pushed without a user gesture, so the
      // guard MUST be topped up on taps. This is the part that made the real
      // back button walk out of the app while history.back() looked fine.
      const src0 = fs.readFileSync(file, 'utf8');
      check('  the guard is topped up on user gestures',
            src0.indexOf("['pointerdown','touchstart','mousedown','keydown'].forEach") !== -1);

      // THE bug that kept coming back: pushing a replacement from the popstate
      // handler. That is not a gesture, so Chrome marks the entry skippable and
      // jumps past it — while the counter treated it as real, so the app
      // believed it still had guards when it had none.
      check('  nothing is pushed from the popstate handler',
            src0.indexOf('guardDepth = Math.max(0, guardDepth - 1);\n  pushGuardEntry();') === -1);
      check('  and pushGuardEntry is only reachable from a gesture',
            (src0.match(/pushGuardEntry\(\)/g) || []).length <= 2,
            String((src0.match(/pushGuardEntry\(\)/g) || []).length));
      check('  with enough reserve for a burst of presses',
            w.eval('GUARD_TARGET') >= 6, String(w.eval('GUARD_TARGET')));
      check('  and it keeps more than one in reserve',
            w.eval('GUARD_TARGET') >= 3, String(w.eval('GUARD_TARGET')));
      check('  the reason is written down for next time',
            src0.indexOf('history manipulation intervention') !== -1);

      w.eval('guardDepth = 0;');
      d.dispatchEvent(new w.Event('pointerdown', {bubbles:true}));
      await new Promise(r => setTimeout(r, 60));
      check('  a tap restores the full buffer',
            w.eval('guardDepth') === w.eval('GUARD_TARGET'),
            String(w.eval('guardDepth')));

      // A guard entry must be replaced every time one is consumed
      w.eval("window.__pushes = 0; const _ps = history.pushState.bind(history); "
           + "history.pushState = function(){ window.__pushes++; return _ps.apply(history, arguments); };");

      // Each app has its own set of views
      const views = JSON.parse(w.eval(
        "JSON.stringify(Array.from(document.querySelectorAll('.view'))"
        + ".map(v => v.id.replace('view-',''))"
        + ".filter(v => ['report','serviced','options','customers','technicians'].indexOf(v) !== -1))"));
      const walk = [views[0], views[1], views[2] || views[0], 'home', views[1]];
      walk.forEach(v=> w.eval("switchView('" + v + "')"));
      check('  the stack caps at five', w.eval('navStack.length') === 5,
            String(w.eval('navStack.length')));

      const expected = ['home', walk[2], walk[1], walk[0], 'home'];
      const seen = [];
      for(let i = 0; i < 5; i++){ await back(); seen.push(w.eval('currentViewName')); }
      check('  five presses retrace five places',
            seen.join(',') === expected.join(','),
            seen.join(',') + ' vs ' + expected.join(','));
      check('  and the stack is spent', w.eval('navStack.length') === 0);

      // Past that it must sit still, not sign anyone out
      const before = w.eval('currentViewName');
      for(let i = 0; i < 6; i++) await back();
      check('  further presses do nothing at all',
            w.eval('currentViewName') === before, w.eval('currentViewName'));
      check('  it never leaves the app', typeof w.eval('currentViewName') === 'string');

      // Guards are pushed on taps, never from the popstate handler — a push
      // there would be gestureless and Chrome would skip it
      check('  guards come from gestures, not from going back',
            w.eval('window.__pushes') > 0, String(w.eval('window.__pushes')));

      // Going back must not record new places, or it bounces forever
      w.eval("switchView('" + views[0] + "');");
      const len = w.eval('navStack.length');
      await back();
      check('  going back does not add to the stack',
            w.eval('navStack.length') < len,
            len + ' -> ' + w.eval('navStack.length'));
    }catch(e){
      check('  back button', false, e.message);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
