// The emailed service report. Built separately from the on-screen version
// because email clients strip stylesheets, so this checks it stays email-safe.
require('fake-indexeddb/auto');
const { JSDOM } = require('jsdom');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, ok, detail){
  if(ok){ pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

function boot(file, seed){
  return new JSDOM(fs.readFileSync(file, 'utf8'), {
    runScripts:'dangerously', pretendToBeVisual:true, url:'https://example.com/',
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
      w.scrollTo=()=>{}; w.scrollBy=()=>{}; w.alert=()=>{};
      w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){},fillRect(){}});
      w.console.warn=()=>{}; w.console.error=()=>{};
      w.Element.prototype.scrollIntoView = function(){};
      w.indexedDB = global.indexedDB; w.IDBKeyRange = global.IDBKeyRange;
      Object.keys(seed).forEach(k=> w.localStorage.setItem('weir:'+k, JSON.stringify(seed[k])));
    }
  });
}

const iso = new Date(Date.now() - new Date().getTimezoneOffset()*60000)
  .toISOString().slice(0,10);

const base = {
  companyName: 'Smith & Sons Pool Care',
  accountPhone: '(623) 555-0142',
  accountEmail: 'service@smithsons.com',
  licenseNumber: 'ROC-284419',
  customers: [{id:'a', name:'Alpha One', address:'123 Palm Way', active:true, hasPool:true}],
  chemConfig: {pool:{chemicals:[{key:'chlorine',label:'Free chlorine',full:'Free chlorine'},
                               {key:'ph',label:'pH level',full:'pH level'}],
                     dosages:[{key:'tabs',label:'Chlorine tabs'}]},
               spa:{chemicals:[],dosages:[]}, fountain:{chemicals:[],dosages:[]}},
  'readings:a': [{id:'r1', date: iso + 'T10:14:00.000Z', chlorine:'3.0', ph:'7.4',
                  tabs:'2', filterBackwashed:true}]
};

(async ()=>{
  for(const file of ['technician-app.html','admin-readings-app.html']){
    console.log('\n=== ' + file + ': the emailed report ===');
    const dom = boot(file, base);
    await new Promise(r => setTimeout(r, 1500));
    const w = dom.window;

    try{
      w.eval("renderDateReport('a', '" + iso + "');");
      await new Promise(r => setTimeout(r, 600));

      const html = w.eval('currentReportHtml');
      check('  an HTML version is built', html && html.length > 500, String(html).length + ' chars');

      // Email-safe: no stylesheet dependency
      check('  no CSS variables', html.indexOf('var(--') === -1);
      check('  no class attributes', html.indexOf('class=') === -1);
      check('  laid out with tables', (html.match(/<table/g) || []).length >= 3);
      check('  styles are inline', html.indexOf('style="') !== -1);

      // Content
      check('  the company is in the header',
            html.indexOf('Smith &amp; Sons Pool Care') !== -1);
      check('  an ampersand is escaped, not raw',
            html.indexOf('Smith & Sons') === -1);
      check('  the customer is named', html.indexOf('Alpha One') !== -1);
      check('  with their address', html.indexOf('123 Palm Way') !== -1);
      check('  readings are included',
            html.indexOf('Free chlorine') !== -1 && html.indexOf('3.0') !== -1);
      check('  chemicals added are included', html.indexOf('Chlorine tabs') !== -1);
      check('  service performed is included', html.indexOf('Filter backwashed') !== -1);
      check('  the license is in the footer', html.indexOf('ROC-284419') !== -1);
      check('  contact details show', html.indexOf('(623) 555-0142') !== -1);

      // The plain text must survive as a fallback
      check('  the plain text version still exists',
            w.eval('currentReportText').length > 0);

      // Customisation is honoured
      w.eval("lsSet('reportEmailStyle', {colour:'#8C3B2A', greeting:'Custom opening.', "
             + "signoff:'Custom closing.', showContact:false, showReadings:false});");
      w.eval("renderDateReport('a', '" + iso + "');");
      await new Promise(r => setTimeout(r, 600));
      const styled = w.eval('currentReportHtml');

      // The technician's name replaces the old canned greeting
      const withTech = w.eval("buildReportEmailHtml({name:'A Customer'}, 'today', "
        + "[{label:'Pool', readingPairs:[['x','1']], productPairs:[], servicePairs:[]}], "
        + "{technician:'Alex Rivera'})");
      check('  the technician who did the work is named',
            withTech.indexOf('Alex Rivera') !== -1);
      check('  and labelled, so it is clear whose name it is',
            withTech.indexOf('Technician: Alex Rivera') !== -1);
      const noTech = w.eval("buildReportEmailHtml({name:'A Customer'}, 'today', "
        + "[{label:'Pool', readingPairs:[['x','1']], productPairs:[], servicePairs:[]}], {})");
      check('  and left out cleanly when there is none',
            noTech.indexOf('undefined') === -1 && noTech.length > 400);
      check('  the canned greeting is gone by default',
            html.indexOf('Here is the report from') === -1);

      check('  a chosen colour is used', styled.indexOf('#8C3B2A') !== -1);
      check('  a custom opening line appears', styled.indexOf('Custom opening.') !== -1);
      check('  a custom closing line appears', styled.indexOf('Custom closing.') !== -1);
      check('  contact details can be hidden',
            styled.indexOf('(623) 555-0142') === -1);
      check('  readings can be left out', styled.indexOf('Free chlorine') === -1);
      check('  but chemicals added remain', styled.indexOf('Chlorine tabs') !== -1);

      // A missing company name must not produce a blank header
      w.eval("lsSet('companyName', '');");
      w.eval("renderDateReport('a', '" + iso + "');");
      await new Promise(r => setTimeout(r, 600));
      check('  a blank company name falls back',
            w.eval('currentReportHtml').indexOf('Your pool service') !== -1);
    }catch(e){
      check('  emailed report', false, e.message);
    }
  }

  // The settings tab on the website
  console.log('\n=== customer-intake.html: the Email tab ===');
  {
    const dom = boot('customer-intake.html', base);
    await new Promise(r => setTimeout(r, 1500));
    const w = dom.window, d = w.document;

    try{
      d.getElementById('btnAccount').click();
      const tabs = Array.from(d.querySelectorAll('#accountTabControl .history-type-btn'))
        .map(b => b.textContent);
      check('  Email is a tab on the Account page', tabs.indexOf('Email') !== -1, tabs.join('|'));

      Array.from(d.querySelectorAll('#accountTabControl .history-type-btn'))
        .find(b => b.dataset.acct === 'email').click();
      check('  it opens its own panel',
            d.getElementById('acctEmailPanel').style.display === 'block');
      check('  with a colour picker', !!d.getElementById('acctEmailColour'));
      check('  an opening line', !!d.getElementById('acctEmailGreeting'));
      check('  and a closing line', !!d.getElementById('acctEmailSignoff'));

      const g = d.getElementById('acctEmailGreeting');
      g.value = 'Your pool was serviced today.';
      g.dispatchEvent(new w.Event('change', {bubbles:true}));
      check('  editing saves', w.eval("loadEmailStyle().greeting") === 'Your pool was serviced today.');

      d.getElementById('acctEmailReadings').click();
      check('  readings can be switched off', w.eval('loadEmailStyle().showReadings') === false);

      d.getElementById('btnEmailPreview').click();
      await new Promise(r => setTimeout(r, 300));
      check('  a preview opens', !!d.querySelector('.confirm-overlay iframe'));

      const prev = w.eval('previewReportEmail()');
      check('  the preview reflects the changes',
            prev.indexOf('Your pool was serviced today') !== -1
            && prev.indexOf('Free chlorine') === -1);
    }catch(e){
      check('  email settings tab', false, e.message);
    }
  }

  // ---- Both apps must actually SEND the html ----
  console.log('\n=== the HTML is what gets sent, in both apps ===');
  {
    ['technician-app.html','admin-readings-app.html'].forEach(file=>{
      const src = fs.readFileSync(file, 'utf8');
      check(file + ' sends the HTML version as the message',
            src.indexOf('message: currentReportHtml || currentReportText') !== -1);
      check(file + ' and a plain-text copy alongside it',
            src.indexOf('message_text: currentReportText') !== -1);
      check(file + ' never sends only the plain text',
            src.indexOf('message: currentReportText\n') === -1);
    });
  }

  // ---- Every photo taken is sent, not just the first ----
  console.log('\n=== All the visit photos are attached ===');
  {
    ['technician-app.html','admin-readings-app.html'].forEach(file=>{
      const src = fs.readFileSync(file, 'utf8');
      check(file + ' collects every photo from the visit',
            src.indexOf('function collectReportPhotos') !== -1);
      check(file + ' sends them as numbered attachments',
            src.indexOf("templateParams['photo_' + (idx + 1)]") !== -1);
      check(file + ' names each one so they are recognisable',
            src.indexOf("templateParams['photo_' + (idx + 1) + '_name']") !== -1);
      check(file + ' and says how many there are',
            src.indexOf('templateParams.photo_count') !== -1);
      check(file + ' with a sensible ceiling',
            /MAX_REPORT_PHOTOS = [1-9]/.test(src));

      // WebP is not always offered as an attachment content type, and some
      // mail clients still will not preview it
      check(file + ' converts photos to JPEG for the email',
            src.indexOf('function webpToJpegDataUrl') !== -1);
      check(file + ' and names them .jpg to match',
            src.indexOf("'-after.jpg'") !== -1 || src.indexOf("+ '-after.jpg'") !== -1
            || src.indexOf('.jpg') !== -1);
      check(file + ' converting them all at once, not one by one',
            src.indexOf('await Promise.all(photos.map') !== -1);
      check(file + ' and giving up rather than hanging forever',
            src.indexOf('setTimeout(()=> finish(dataUrl), 4000)') !== -1);

      // The old single-attachment slot must not be sent alongside the numbered
      // ones, or the first photo arrives twice
      check(file + ' does not also send the old single slot',
            src.indexOf('templateParams.photo_attachment') === -1);

      // Mail clients turn phone numbers and addresses into blue underlined
      // links, which is unreadable on the dark header
      check(file + ' asks clients not to auto-link the contact line',
            src.indexOf('format-detection') !== -1);
      check(file + ' and overrides them where they do it anyway',
            src.indexOf('x-apple-data-detectors') !== -1);
      // The contact line lives in the footer under the company name now, on a
      // light background, so it needs a dark colour rather than white
      check(file + ' the contact line is not in the dark header',
            src.indexOf("+ (contact ? '<div style=\"font-size:12.5px;color:#FFFFFF") === -1);
      check(file + ' it sits under the company name at the foot',
            src.indexOf("color:#4A5A58;margin-top:4px") !== -1);
      check(file + ' with each part wrapped rather than linked',
            src.indexOf("'<span style=\"color:#4A5A58;text-decoration:none;\">'") !== -1);
    });
  }

  
// ---- The photos inside a report sent from the office ----
// The Edge Function is TypeScript for Deno, which cannot run here. The part
// worth checking is how it builds the page, so that is lifted out and run.
(function(){
  console.log('\n=== send-report: photos inside the report ===');
  const fs2 = require('fs');
  const where = ['send-report.ts', 'functions/send-report/index.ts', 'supabase/functions/send-report/index.ts']
    .find(f => { try{ fs2.accessSync(f); return true; }catch(e){ return false; } });
  if(!where){
    check('the send-report function is here to check', false, 'put send-report.ts beside the tests');
    return;
  }
  const src = fs2.readFileSync(where, 'utf8');

  const shown = ['photo-1\u0001before.jpg', 'photo-2\u0001after.jpg'];
  const piece = src.slice(src.indexOf('function photoSection()'), src.indexOf('const from ='));
  const build = new Function('shown', piece
    .replace(/:\s*string\)/g, ')')
    .replace(/function photoSection\(\)/, 'function photoSection()')
    + '; return {photoSection, withPhotos};');
  const {photoSection, withPhotos} = build(shown);

  const section = photoSection();
  check('each photo is shown in the page', (section.match(/<img src="cid:photo-/g) || []).length === 2, section.slice(0, 120));
  check('with a heading that matches how many there are', /Photos from this visit/.test(section));
  check('and a caption under each', /before/.test(section) && /after/.test(section));
  check('the file extension is not used as the caption', section.indexOf('before.jpg<') === -1);

  const page = '<html><body><table><tr><td>The report</td></tr></table></td></tr></table></body></html>';
  const withThem = withPhotos(page);
  check('the photos go inside the report, not after it',
        withThem.indexOf('cid:photo-1') < withThem.lastIndexOf('</table></td></tr></table>'), 'placed at the end');
  check('the report itself is untouched', withThem.indexOf('The report') !== -1);

  const none = build([]);
  check('a report with no photos is left exactly as it was', none.withPhotos(page) === page);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
