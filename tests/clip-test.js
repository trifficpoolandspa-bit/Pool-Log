// Short video clips. The recording itself needs a real camera, so these checks
// cover the parts that can go wrong without one: the cap, format selection,
// graceful absence, and what gets handed to the share sheet.
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
    customers: [{id:'a', name:'Alpha One', address:'123 Palm Way', day: today,
                 active:true, technicianId:'t1', hasPool:true}],
    afterPhotoDefaultFixed: true,
    chemConfig: {pool:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[]},
                 spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}}
  };
  return new JSDOM(fs.readFileSync(file,'utf8'), {
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
}

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': short clips ===');
    const dom = boot(file);
    await new Promise(r => setTimeout(r, 1400));
    const w = dom.window, d = w.document;

    try{
      check('  the cap is 15 seconds', w.eval('CLIP_MAX_SECONDS') === 15);

      // A browser with no MediaRecorder must hide the feature, not break
      check('  it knows recording is unavailable', w.eval('canRecordClips()') === false);
      w.eval("currentUser={id:'t1',name:'Alex'}; openVisit('a');");
      await new Promise(r => setTimeout(r, 400));
      check('  the card stays hidden without support',
            d.getElementById('visitClipSection').style.display === 'none');

      // Now with support
      w.eval("window.MediaRecorder = function(){}; "
           + "MediaRecorder.isTypeSupported = (t)=> t.indexOf('mp4') !== -1;");
      w.eval("navigator.mediaDevices = {getUserMedia: ()=> Promise.resolve({getTracks:()=>[]})};");
      w.eval("renderClipSection();");
      check('  it appears once recording is possible',
            d.getElementById('visitClipSection').style.display === 'block');
      check('  and there is a button', !!d.getElementById('btnRecordClip'));

      check('  it picks mp4 where that is what is supported',
            w.eval("clipMimeType()").indexOf('mp4') !== -1, w.eval("clipMimeType()"));

      w.eval("MediaRecorder.isTypeSupported = (t)=> t.indexOf('webm') !== -1;");
      check('  and webm where that is', w.eval("clipMimeType()").indexOf('webm') !== -1,
            w.eval("clipMimeType()"));

      // What the share sheet is handed
      w.eval("window.__shared = null; "
           + "navigator.share = (o)=>{ window.__shared = o; return Promise.resolve(); }; "
           + "navigator.canShare = (o)=> !!(o && o.files);");
      await w.eval("shareClip(new File([new Blob(['x'],{type:'video/mp4'})], "
                 + "'clip.mp4', {type:'video/mp4'}), customers[0])");
      const shared = JSON.parse(w.eval("JSON.stringify({title: window.__shared.title, "
        + "text: window.__shared.text, files: window.__shared.files.length})"));
      check('  the clip itself is shared', shared.files === 1);
      check('  named for the customer', shared.title.indexOf('Alpha One') !== -1, shared.title);
      check('  with their address, so the office knows where',
            shared.text.indexOf('123 Palm Way') !== -1, shared.text);

      // Cancelling the share sheet must not look like an error
      w.eval("navigator.share = ()=> Promise.reject(Object.assign(new Error('x'), {name:'AbortError'}));");
      let threw = false;
      try{
        await w.eval("shareClip(new File([new Blob(['x'],{type:'video/mp4'})], "
                   + "'clip.mp4', {type:'video/mp4'}), customers[0])");
      }catch(e){ threw = true; }
      check('  cancelling the share sheet is handled quietly', !threw);

      // Nothing is stored — this is deliberate until there is a backend
      const src = fs.readFileSync(file, 'utf8');
      check('  clips are never written to storage',
            src.indexOf('savePhotoData(') !== -1
            && src.split('async function recordClip')[1].split('async function shareClip')[0]
                  .indexOf('lsSet(') === -1);
    }catch(e){
      check('  clips', false, e.message);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
