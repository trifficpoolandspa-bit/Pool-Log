// Offline readiness. The app has to open with no signal, so this checks both
// the service worker's rules and what the technician actually sees.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

console.log('\n=== the service worker ===');
{
  const sw = fs.readFileSync('sw.js', 'utf8');
  check('  it parses', (()=>{ try{ new Function(sw); return true; }catch(e){ return false; } })());
  check('  query strings do not break the cache lookup', sw.indexOf('ignoreSearch') !== -1);
  check('  one missing file no longer kills the whole precache',
        sw.indexOf('allSettled') !== -1 && sw.indexOf('cache.addAll') === -1);
  check('  opening a page falls back to a cached copy',
        sw.indexOf("request.mode === 'navigate'") !== -1);
  check('  and to a readable message if nothing is stored',
        sw.indexOf('not stored on this device yet') !== -1);
  check('  other origins are left to the browser',
        sw.indexOf('url.origin !== self.location.origin') !== -1);
  check('  every page is precached',
        ['technician-app.html','admin-readings-app.html','customer-intake.html','index.html']
          .every(p => sw.indexOf(p) !== -1));
  // A fresh name is what forces every device off the previous worker
  check('  the cache name is newer than the one that shipped',
        /poollog-cache-v([6-9]|[1-9][0-9])/.test(sw), (sw.match(/poollog-cache-v\d+/)||[''])[0]);
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

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html','customer-intake.html']){
    console.log('\n=== ' + file + ': what the technician sees ===');
    const dom = boot(file);
    await new Promise(r => setTimeout(r, 1400));
    const w = dom.window, d = w.document;

    try{
      const badge = d.getElementById('offlineBadge');
      check('  there is an offline indicator', !!badge);
      check('  hidden while online', badge.style.display === 'none');

      Object.defineProperty(w.navigator, 'onLine', {value:false, configurable:true});
      w.dispatchEvent(new w.Event('offline'));
      check('  it appears when the connection drops', badge.style.display === 'block');
      check('  and warns when nothing is stored yet',
            badge.textContent.indexOf('may not load') !== -1, badge.textContent);

      w.eval('offlineReady = true; showOfflineState();');
      check('  it reassures once the app is stored',
            badge.textContent.indexOf('working from this device') !== -1, badge.textContent);

      Object.defineProperty(w.navigator, 'onLine', {value:true, configurable:true});
      w.dispatchEvent(new w.Event('online'));
      check('  and disappears when the connection returns', badge.style.display === 'none');

      check('  Settings can report offline readiness',
            typeof w.eval('offlineStatusText') === 'function');
      check('  and has somewhere to show it', !!d.getElementById('offlineStatus'));

      // The card is filled when the settings view opens. Each app calls that
      // view something different, and pointing at the wrong name left the
      // admin app stuck on "Checking..." forever.
      const settingsView = ['settings','options']
        .find(v => d.getElementById('view-' + v));
      check('  the app has a settings view', !!settingsView, String(settingsView));
      w.eval("switchView('" + settingsView + "');");
      await new Promise(r => setTimeout(r, 600));

      // The readiness card is hidden now — it reported on offline rather than
      // doing anything, and meant little to anyone but us. Offline itself is
      // unchanged, and the header badge still warns when it matters.
      const card = d.getElementById('offlineStatus');
      const wrap = card ? card.closest('.card') : null;
      check('  the readiness card is hidden',
            wrap && wrap.style.display === 'none');
      check('  but it still fills in, ready to be shown again',
            card && card.textContent.trim() !== 'Checking…'
                && card.textContent.trim() !== 'Checking...',
            card ? card.textContent.trim() : '(missing)');

      const txt = await w.eval('offlineStatusText()');
      check('  the readout says something useful', typeof txt === 'string' && txt.length > 20, txt);
    }catch(e){
      check('  offline indicator', false, e.message);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
