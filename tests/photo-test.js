// Photo storage runs against a real IndexedDB, which needs its own process —
// the main suite keeps the event loop too busy for the async work to finish.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

const seed = {
  customers: [{id:'a', name:'Alpha One', active:true,
    equipmentTypeOptions:['Filter'],
    equipment:[{id:'e1', type:'Filter', photos:[
      {id:'p1', dataUrl:'data:image/jpeg;base64,AAAA', caption:''},
      {id:'p2', dataUrl:'data:image/jpeg;base64,BBBB', caption:''}
    ]}]}]
};

const dom = new JSDOM(fs.readFileSync('customer-intake.html','utf8'), {
  runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
  beforeParse(w){
    w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
    w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
    w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
    w.Element.prototype.scrollIntoView=function(){};
    w.console.warn=()=>{};
    w.indexedDB = global.indexedDB;
    w.IDBKeyRange = global.IDBKeyRange;
    Object.keys(seed).forEach(k=> w.localStorage.setItem('weir:'+k, JSON.stringify(seed[k])));
  }
});

setTimeout(async ()=>{
  const w = dom.window;
  console.log('\n=== Equipment photos move to IndexedDB ===');
  try{
    // The startup migration may already have run, which is the point of it
    await w.eval("migrateEquipmentPhotos({force:true})");

    check('  the image data is removed from the record',
          w.eval("customers[0].equipment[0].photos.every(p => !p.dataUrl)"),
          w.eval("JSON.stringify(customers[0].equipment[0].photos)"));
    check('  each photo is marked as stored',
          w.eval("customers[0].equipment[0].photos.every(p => p.stored === true)"));
    check('  both photo records survive',
          w.eval("customers[0].equipment[0].photos.length") === 2);

    const p1 = await w.eval("loadPhotoData('p1')");
    check('  the first image reads back intact', p1 === 'data:image/jpeg;base64,AAAA', p1);
    const p2 = await w.eval("photoDataUrl(customers[0].equipment[0].photos[1])");
    check('  the second reads back through the helper', p2 === 'data:image/jpeg;base64,BBBB', p2);

    await w.eval("savePhotoData('p3','data:image/jpeg;base64,CCCC')");
    const p3 = await w.eval("loadPhotoData('p3')");
    check('  a newly saved photo reads back', p3 === 'data:image/jpeg;base64,CCCC', p3);

    await w.eval("deletePhotoData('p3')");
    const gone = await w.eval("loadPhotoData('p3')");
    check('  a deleted photo is gone', gone === null, String(gone));

    check('  the migration is marked done', w.eval("lsGet('equipmentPhotosMigrated') === true"));
    await w.eval("migrateEquipmentPhotos()");
    check('  running it again changes nothing',
          w.eval("customers[0].equipment[0].photos.length") === 2);

    // The record is now tiny
    const size = w.eval("JSON.stringify(lsGet('customers')).length");
    check('  the customer record no longer holds image data', size < 400, size + ' chars');

    // A photo that was never migrated still displays
    const legacy = await w.eval("photoDataUrl({id:'x', dataUrl:'data:image/jpeg;base64,DDDD'})");
    check('  an unmigrated photo still displays', legacy === 'data:image/jpeg;base64,DDDD');
  }catch(e){
    check('  photo storage', false, e.message);
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}, 1800);
