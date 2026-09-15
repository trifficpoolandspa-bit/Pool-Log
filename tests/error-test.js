// The global error handler. Its whole job is to turn "it froze" into something
// actionable, so it is worth testing that it fires when it should and stays
// quiet when it should not.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

function boot(file){
  return new JSDOM(fs.readFileSync(file, 'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true,
    url:'https://example.com/' + file,
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
      w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
      w.console.warn=()=>{}; w.console.error=()=>{};
      w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
      w.localStorage.setItem('poollog:customers', '[]');
    }
  });
}


console.log('\n=== Closing the camera never raises an error ===');
{
  // Some Android devices reject the torch-off call with "setPhotoOptions
  // failed". It used to sit inside a try/catch that could not catch a promise,
  // so it reached the technician as an error banner while closing the camera.
  ['technician-app.html','admin-readings-app.html'].forEach(file=>{
    const src = fs.readFileSync(file, 'utf8');
    const i = src.indexOf('Turn the torch off before releasing the camera');
    const block = i === -1 ? '' : src.slice(i, i + 700);
    check(file + ' the torch-off call exists', i !== -1);
    check(file + ' and its rejection is swallowed',
          block.indexOf("p.catch(()=>{})") !== -1);
    check(file + ' no bare applyConstraints is left unhandled',
          (src.match(/^\s*track\.applyConstraints\(/gm) || []).length === 0);
  });
}

(async ()=>{
  for(const file of ['customer-intake.html','technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ' ===');
    const dom = boot(file);
    await new Promise(r => setTimeout(r, 1500));
    const w = dom.window, d = w.document;
    const banner = ()=> d.querySelector('[data-error-banner]');

    try{
      check('  nothing is shown at rest', !banner());
      check('  the build is stamped',
            /^(website|technician|admin)-\d{4}-\d{2}-\d{2}$/.test(w.eval('APP_VERSION')),
            w.eval('APP_VERSION'));

      // A real script error
      const err = new w.ErrorEvent('error', {
        message: "Cannot read properties of null (reading 'value')",
        filename: 'https://example.com/' + file,
        lineno: 4812, colno: 17, error: new Error('boom')
      });
      w.dispatchEvent(err);

      const b = banner();
      check('  an unhandled error raises a banner', !!b);
      if(b){
        check('  it says what broke',
              b.textContent.indexOf('Cannot read properties of null') !== -1);
        check('  it reassures about saved work',
              b.textContent.indexOf('saved work is not affected') !== -1);
        const btns = Array.from(b.querySelectorAll('button')).map(x => x.textContent);
        check('  it offers copy, reload and dismiss',
              btns.join('|') === 'Copy details|Reload|Dismiss', btns.join('|'));
      }

      w.dispatchEvent(err);
      check('  a repeat does not stack banners',
            d.querySelectorAll('[data-error-banner]').length === 1);

      // What actually gets sent
      const log = JSON.parse(w.localStorage.getItem('poollog:errorLog') || '[]');
      check('  errors are logged for later', log.length >= 1, log.length + ' logged');
      check('  with the line it failed on',
            log[0].where.indexOf('4812') !== -1, log[0].where);
      check('  and the version', !!log[0].version);
      check('  and the device', !!log[0].agent);

      const report = w.eval('errorText(JSON.parse(localStorage.getItem("poollog:errorLog"))[0])');
      ['Version:', 'Page:', 'Message:', 'Where:', 'Device:'].forEach(bit=>{
        check('  the copyable report has ' + bit.replace(':',''),
              report.indexOf(bit) !== -1);
      });

      // Dismiss and re-arm
      Array.from(banner().querySelectorAll('button'))
        .find(x => x.textContent === 'Dismiss').click();
      check('  dismiss clears it', !banner());

      const rej = new w.Event('unhandledrejection');
      Object.defineProperty(rej, 'reason', {value: new Error('Database write failed')});
      w.dispatchEvent(rej);
      check('  a failed background task is caught too', !!banner());
      check('  naming the failure',
            banner().textContent.indexOf('Database write failed') !== -1);

      // Noise that must stay quiet
      Array.from(banner().querySelectorAll('button'))
        .find(x => x.textContent === 'Dismiss').click();
      const img = d.createElement('img');
      d.body.appendChild(img);
      const imgErr = new w.Event('error');
      Object.defineProperty(imgErr, 'target', {value: img});
      w.dispatchEvent(imgErr);
      check('  a broken image raises nothing', !banner());

      // Saves that fail for an unexpected reason
      w.eval('reportStorageFailure("readings:a", new Error("disk gone"));');
      check('  a failed save is reported', !!banner());
      check('  and says saving is what failed',
            banner().textContent.indexOf('Saving failed') !== -1);

      // The log must not grow without limit
      w.eval('for(let i=0;i<40;i++) recordError("Error", "flood " + i, "", 0, 0, "");');
      const capped = JSON.parse(w.localStorage.getItem('poollog:errorLog') || '[]');
      check('  the log is capped', capped.length <= 20, capped.length + ' kept');
      check('  keeping the most recent',
            capped[capped.length - 1].message.indexOf('flood 39') !== -1,
            capped[capped.length - 1].message);
    }catch(e){
      check('  error handler', false, e.message);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
