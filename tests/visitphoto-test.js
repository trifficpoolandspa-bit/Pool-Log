// Visit photo storage runs against a real IndexedDB, in its own process.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

const big = 'data:image/jpeg;base64,' + 'A'.repeat(2000);

function boot(file){
  const seed = {
    customers: [{id:'a', name:'Alpha One', active:true, hasPool:true}],
    'readings:a': [{id:'r1', date:'2026-09-01T10:00:00Z', chlorine:'3',
                    photo: big, beforePhoto: big, gatePhoto: big,
                    customPhotos: {p1: big}}]
  };
  return new JSDOM(fs.readFileSync(file,'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
      w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
      w.console.warn=()=>{};
      w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
      Object.keys(seed).forEach(k=> w.localStorage.setItem('weir:'+k, JSON.stringify(seed[k])));
    }
  });
}

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': visit photos in IndexedDB ===');
    const dom = boot(file);
    await new Promise(r => setTimeout(r, 1500));
    const w = dom.window;
    try{
      // The startup migration runs on its own after about a second, which is
      // the whole point of it — so by now the photo may already have moved.
      await w.eval("migrateVisitPhotos()");

      const after = JSON.parse(w.localStorage.getItem('weir:readings:a'))[0];
      check('  the visit photo is now a reference',
            after.photo.indexOf('idb:') === 0, after.photo.slice(0, 30));
      check('  the before photo too', after.beforePhoto.indexOf('idb:') === 0);
      check('  the gate photo too', after.gatePhoto.indexOf('idb:') === 0);
      check('  custom photos too', after.customPhotos.p1.indexOf('idb:') === 0);
      check('  the reading itself is small', JSON.stringify(after).length < 400,
            JSON.stringify(after).length + ' chars');
      check('  the chemistry survives', after.chlorine === '3');

      const back = await w.eval("resolvePhoto(" + JSON.stringify(after.photo) + ")");
      check('  the image reads back intact', back === big, String(back).slice(0, 30));

      check('  the migration is marked done', w.eval("lsGet('visitPhotosMigrated') === true"));
      await w.eval("migrateVisitPhotos()");
      const twice = JSON.parse(w.localStorage.getItem('weir:readings:a'))[0];
      check('  running it twice is harmless', twice.photo === after.photo);

      // An unmigrated photo still displays
      const legacy = await w.eval("resolvePhoto('data:image/jpeg;base64,ZZZZ')");
      check('  an inline photo still resolves', legacy === 'data:image/jpeg;base64,ZZZZ');

      // Saving a new reading stores a reference
      await w.eval("saveReadings('a', [{id:'r2', date:'2026-09-02T10:00:00Z', photo:'data:image/jpeg;base64,QQQQ'}], 'pool')");
      const saved = JSON.parse(w.localStorage.getItem('weir:readings:a'))[0];
      check('  a newly saved photo is stored by reference',
            saved.photo.indexOf('idb:') === 0, saved.photo.slice(0, 30));
      const savedBack = await w.eval("resolvePhoto(" + JSON.stringify(saved.photo) + ")");
      check('  and reads back', savedBack === 'data:image/jpeg;base64,QQQQ');
    }catch(e){
      check('  visit photo storage', false, e.message);
    }
  }

  console.log('\n=== Photo previews are thumbnails, tap to enlarge ===');
  {
    const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const today = DAYS[new Date().getDay()];
    const PNG = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4TBYAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
    const seed = {
      technicians: [{id:'t1', name:'Alex'}],
      customers: [{id:'a', name:'Alpha', day: today, active:true, technicianId:'t1',
                   hasPool:true, hasSpa:true}],
      afterPhotoDefaultFixed: true,
      chemConfig: {pool:{chemicals:[{key:'chlorine',label:'FC'}],dosages:[]},
                   spa:{chemicals:[{key:'chlorine',label:'FC'}],dosages:[]},
                   fountain:{chemicals:[],dosages:[]}}
    };
  
    for(const file of ['technician-app.html','admin-readings-app.html']){
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
      await new Promise(r => setTimeout(r, 1400));
      const w = dom.window, d = w.document;
  
      try{
        w.eval("currentUser={id:'t1',name:'Alex'}; renderHomeList(); openVisit('a');");
        await new Promise(r => setTimeout(r, 400));
  
        ['poolPhotoController','spaPhotoController','fountainPhotoController','gatePhotoController']
          .forEach(cn => w.eval(cn + ".setData('" + PNG + "');"));
        ['pool','spa','fountain']
          .forEach(t => w.eval("beforeControllerFor('" + t + "').setData('" + PNG + "');"));
        await new Promise(r => setTimeout(r, 250));
  
        const previews = ['photoPreview','photoPreviewSpa','photoPreviewFountain','gatePhotoPreview',
                          'photoPreviewBefore','photoPreviewBeforeSpa','photoPreviewBeforeFountain'];
        const small = previews.filter(id => {
          const el = d.getElementById(id);
          return el && el.style.maxWidth === '25%';
        });
        check(file + ' every photo shows as a thumbnail',
              small.length === previews.length, small.length + ' of ' + previews.length);
  
        const tappable = previews.filter(id => {
          const el = d.getElementById(id);
          return el && el.style.cursor === 'zoom-in';
        });
        check(file + ' and every one invites a tap',
              tappable.length === previews.length, tappable.length + ' of ' + previews.length);
  
        d.getElementById('photoPreviewSpa').click();
        await new Promise(r => setTimeout(r, 200));
        const ov = Array.from(d.querySelectorAll('.confirm-overlay')).pop();
        check(file + ' tapping one opens it full size', !!ov);
        if(ov){
          // Laid out like the camera: photo above, a bar with Back at the foot
          check(file + ' the photo fills the space above the bar',
                /^1 /.test((ov.querySelector('img') || {}).style.flex || ''),
                (ov.querySelector('img') || {}).style.flex);
          check(file + ' and says how to close it',
                ov.textContent.indexOf('Tap the photo to close') !== -1);
          ov.click();
          await new Promise(r => setTimeout(r, 150));
          check(file + ' tapping closes it again',
                d.querySelectorAll('.confirm-overlay').length === 0);
        }

        // No button — tapping anywhere closes it, so the instruction just has to
        // be big enough to notice against a full-screen photo
        d.getElementById('photoPreviewSpa').click();
        await new Promise(r => setTimeout(r, 200));
        const viewer = Array.from(d.querySelectorAll('.confirm-overlay')).pop();
        check(file + ' the viewer has no buttons to hunt for',
              viewer && viewer.querySelectorAll('button').length === 0);
        // The innermost one — the bar around it also contains that text
        const hintEl = viewer
          ? Array.from(viewer.querySelectorAll('div'))
              .filter(x => /Tap the photo/.test(x.textContent))
              .pop()
          : null;
        // Styled like the camera's own buttons rather than plain text, which is
        // what makes it read as a control instead of a caption
        check(file + ' the instruction looks like the camera buttons',
              hintEl && hintEl.style.fontSize === '15px'
                     && hintEl.style.background === 'rgba(255, 255, 255, 0.15)'
                     && hintEl.style.borderRadius === '10px',
              hintEl ? hintEl.style.fontSize + ' / ' + hintEl.style.background : 'not found');
        if(viewer){
          viewer.click();
          await new Promise(r => setTimeout(r, 150));
          check(file + ' and tapping closes it',
                d.querySelectorAll('.confirm-overlay').length === 0);
        }

        d.getElementById('photoPreviewSpa').click();
        await new Promise(r => setTimeout(r, 200));
        w.eval("window.__cancelAsked = 0; confirmDialog = ()=>{ window.__cancelAsked++; return Promise.resolve(true); };");
        w.eval("window.dispatchEvent(new window.PopStateEvent('popstate'))");
        await new Promise(r => setTimeout(r, 250));
        check(file + ' the phone Back closes the photo',
              d.querySelectorAll('.confirm-overlay').length === 0);
        check(file + ' without offering to cancel the report',
              w.eval('window.__cancelAsked') === 0,
              String(w.eval('window.__cancelAsked')));
      }catch(e){ check(file + ' photo thumbnails', false, e.message); }
    }
  }
  
  
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
