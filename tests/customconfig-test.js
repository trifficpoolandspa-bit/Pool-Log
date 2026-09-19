require('fake-indexeddb/auto');
const {JSDOM} = require('jsdom');
const fs = require('fs');

// A customer with their own reading list must have those readings saved AND
// shown in the report. Both apps read the global list instead, so a custom
// spa saved nothing and the section came out blank in the email.
let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const today=DAYS[new Date().getDay()];
const seed={technicians:[{id:'t1',name:'Alex'}], companyName:'Trifific Pool and Spa',
  customers:[{id:'a',name:'John T Tyler',email:'c@x.com',day:today,active:true,
              technicianId:'t1',hasPool:true,hasSpa:true}],
  afterPhotoDefaultFixed:true,
  chemConfig:{pool:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[{key:'tabs',label:'Chlorine tabs'}]},
              spa:{chemicals:[{key:'chlorine',label:'Free chlorine'}],dosages:[{key:'tabs',label:'Chlorine tabs'}]},
              fountain:{chemicals:[],dosages:[]}},
  // THIS customer's spa uses its own reading, with a key nothing else has
  customChemConfig:{a:{spa:{
      chemicals:[{key:'spa_br', label:'Bromine'},{key:'spa_ph', label:'pH level'}],
      dosages:[{key:'spa_gran', label:'Bromine granules'}]}}}};
function boot(file){
  return new JSDOM(fs.readFileSync(file,'utf8'),{
    runScripts:'dangerously',pretendToBeVisual:true,url:'https://example.com/',
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.scrollTo=()=>{};w.scrollBy=()=>{};w.alert=()=>{};
      w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
      w.console.warn=()=>{};w.console.error=()=>{};
      w.indexedDB=global.indexedDB;w.IDBKeyRange=global.IDBKeyRange;
      w.addEventListener('error',e=>console.log('  UNCAUGHT:',e.error?e.error.message:e.message));
      Object.keys(seed).forEach(k=>w.localStorage.setItem('weir:'+k,JSON.stringify(seed[k])));
    }});
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ' — customer has a CUSTOM spa setup ===');
    const dom=boot(file); await wait(1500);
    const w=dom.window,d=w.document;
    const set=(id,v)=>{const e=d.getElementById(id); if(!e) return false; e.value=v; e.dispatchEvent(new w.Event('input',{bubbles:true})); return true;};
    w.eval("currentUser={id:'t1',name:'Alex'}; confirmDialog=()=>Promise.resolve(true); alertDialog=()=>Promise.resolve(); renderHomeList(); openVisit('a');");
    await wait(450);
    set('pool_chem_chlorine','1.5'); set('pool_dose_tabs','3');
    d.getElementById('btnSaveReading').click(); await wait(700);
    console.log('  spa fields present:', set('spa_chem_spa_br','4.0'), set('spa_chem_spa_ph','7.6'));
    set('spa_dose_spa_gran','2');
    d.getElementById('btnSaveSpaReading').click(); await wait(1200);
    const html=w.eval('currentReportHtml')||'';
    check('  a report is produced', html.length > 500, String(html.length));
    check('  the custom spa reading is named', html.indexOf('Bromine') !== -1);
    check('  with its value', html.indexOf('4.0') !== -1);
    check('  and its second reading', html.indexOf('7.6') !== -1);
    check('  the custom dosage too', html.indexOf('Bromine granules') !== -1);
    check('  and the pool is still there', html.indexOf('1.5') !== -1);
    const spaStored = JSON.parse(w.eval("JSON.stringify((lsGet('spaReadings:a')||[])[0]||{})"));
    check('  the custom keys reached storage',
          spaStored.spa_br === '4.0' && spaStored.spa_ph === '7.6',
          JSON.stringify(spaStored.spa_br) + ',' + JSON.stringify(spaStored.spa_ph));
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
