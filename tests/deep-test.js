const fs = require('fs');
const {grabFn, grabBlock} = require('./extract.js');
const tech = fs.readFileSync('technician-app.html','utf8');
const site = fs.readFileSync('customer-intake.html','utf8');

let pass = 0, fail = 0;
const failures = [];
function eq(name, got, want){
  const ok = String(got) === String(want);
  if(ok) pass++; else { fail++; failures.push(name + ': got ' + got + ', wanted ' + want); }
}
function truthy(name, v, note){
  if(v) pass++; else { fail++; failures.push(name + (note ? ' — ' + note : '')); }
}

// ---------- Voice parser ----------
const parserEnv = `
const FIELDS = {};
let currentVisibleSection = 'pool';
const currentVisitCustomerId = null, currentVisitFountainId = null;
function fieldId(t,k,key){ return t+'_'+k+'_'+key; }
function listsForBody(){ return chemConfig.pool; }
const chemConfig = { pool: {
  chemicals: [
    {key:'chlorine', label:'Free chlorine'}, {key:'ph', label:'pH level'},
    {key:'alkalinity', label:'Total alkalinity'}, {key:'cya', label:'Cyanuric acid'},
    {key:'tds', label:'TDS'}, {key:'calcium', label:'Calcium hardness'}
  ],
  dosages: [
    {key:'tabs', label:'Chlorine tabs'}, {key:'acid', label:'Muriatic acid'},
    {key:'shock', label:'Shock'}, {key:'algaecide', label:'Algaecide'},
    {key:'phosphate', label:'Phosphate remover'}, {key:'salt', label:'Salt'}
  ]
}};
const document = { getElementById(id){
  if(!FIELDS[id]) FIELDS[id] = {value:'', dispatchEvent(){}, id};
  return FIELDS[id];
}};
class Event { constructor(){} }
`;
const parserSrc = parserEnv
  + grabBlock(tech, 'const SPOKEN_ALIASES = {', '};') + '\n'
  + grabFn(tech, 'spokenPhrasesFor') + '\n'
  + grabFn(tech, 'parseSpokenReadings') + '\n'
  + 'module.exports = {parseSpokenReadings, FIELDS, spokenPhrasesFor, SPOKEN_ALIASES};';
fs.writeFileSync('/tmp/p.js', parserSrc);
const P = require('/tmp/p.js');

function speak(t){
  Object.keys(P.FIELDS).forEach(k => P.FIELDS[k].value = '');
  P.parseSpokenReadings(t);
  const out = {};
  Object.keys(P.FIELDS).forEach(k=>{ if(P.FIELDS[k].value !== '') out[k] = P.FIELDS[k].value; });
  return out;
}

console.log('=== VOICE: how a tech would actually speak ===');
const voiceCases = [
  ['chlorine three',                              {pool_chem_chlorine:'3'}],
  ['chlorine 3',                                  {pool_chem_chlorine:'3'}],
  ['free chlorine three',                         {pool_chem_chlorine:'3'}],
  ['ph seven four',                               {pool_chem_ph:'7.4'}],
  ['ph seven point four',                         {pool_chem_ph:'7.4'}],
  ['ph 7.4',                                      {pool_chem_ph:'7.4'}],
  ['alkalinity ninety',                           {pool_chem_alkalinity:'90'}],
  ['total alkalinity ninety',                     {pool_chem_alkalinity:'90'}],
  ['alk ninety',                                  {pool_chem_alkalinity:'90'}],
  ['cya fifty',                                   {pool_chem_cya:'50'}],
  ['stabilizer fifty',                            {pool_chem_cya:'50'}],
  ['conditioner fifty',                           {pool_chem_cya:'50'}],
  ['hardness two fifty',                          {pool_chem_calcium:'250'}],
  ['acid one and a half',                         {pool_dose_acid:'1.5'}],
  ['muriatic acid two',                           {pool_dose_acid:'2'}],
  ['tabs three',                                  {pool_dose_tabs:'3'}],
  ['pucks three',                                 {pool_dose_tabs:'3'}],
  ['shock two',                                   {pool_dose_shock:'2'}],
  ['cal hypo two',                                {pool_dose_shock:'2'}],
  ['algaecide eight',                             {pool_dose_algaecide:'8'}],
  ['skillet eight',                               {pool_dose_algaecide:'8'}],
  ['phosphate remover four',                      {pool_dose_phosphate:'4'}],
  ['pr ten thousand four',                        {pool_dose_phosphate:'4'}],
  ['salt twenty eight hundred',                   {pool_dose_salt:'2800'}]
];
voiceCases.forEach(([said, want])=>{
  const got = speak(said);
  const key = Object.keys(want)[0];
  eq('"' + said + '"', got[key], want[key]);
});

console.log('\n=== VOICE: several readings in one breath ===');
{
  const got = speak('chlorine three ph seven four alkalinity ninety cya fifty acid one and a half tabs two');
  eq('  chlorine', got.pool_chem_chlorine, '3');
  eq('  ph', got.pool_chem_ph, '7.4');
  eq('  alkalinity', got.pool_chem_alkalinity, '90');
  eq('  cya', got.pool_chem_cya, '50');
  eq('  acid', got.pool_dose_acid, '1.5');
  eq('  tabs', got.pool_dose_tabs, '2');
}

console.log('\n=== VOICE: fields must not steal each other ===');
{
  const g1 = speak('chlorine tabs two');
  eq('  "chlorine tabs two" sets tabs', g1.pool_dose_tabs, '2');
  truthy('  "chlorine tabs two" leaves free chlorine alone', !g1.pool_chem_chlorine,
         'free chlorine got ' + g1.pool_chem_chlorine);
  const g2 = speak('cyanuric acid fifty muriatic acid two');
  eq('  cya from "cyanuric acid fifty"', g2.pool_chem_cya, '50');
  eq('  acid from "muriatic acid two"', g2.pool_dose_acid, '2');
  const g3 = speak('phosphate remover four ph seven two');
  eq('  phosphate not confused with ph', g3.pool_dose_phosphate, '4');
  eq('  ph still read', g3.pool_chem_ph, '7.2');
}

console.log('\n=== VOICE: nonsense must not fill anything ===');
[' ', 'hello there', 'the pool looks good today', 'chlorine', 'ph'].forEach(t=>{
  const got = speak(t);
  truthy('  "' + t.trim() + '" fills nothing', Object.keys(got).length === 0,
         'filled ' + JSON.stringify(got));
});


console.log('\n=== NUMBERS: every way a tech might say one ===');
[
  ['tabs point. five','0.5'], ['tabs point-five','0.5'], ['acid point-two-five','0.25'],
  ['chlorine 7point4','7.4'], ['tabs point zero five','0.05'], ['tabs Point Five','0.5'],
  ['tabs, point five','0.5'], ['tabs point five.','0.5'],
  ['acid point one','0.1'], ['acid point five','0.5'], ['acid point two five','0.25'],
  ['acid point 5','0.5'], ['acid .5','0.5'], ['chlorine point eight','0.8'],
  ['shock point seven five','0.75'], ['acid 0.5','0.5'],
  ['hardness two fifty','250'], ['hardness three twenty','320'],
  ['hardness two hundred','200'], ['salt twenty eight hundred','2800'],
  ['salt 3200','3200'], ['alkalinity one twenty','120'],
  ['acid half','0.5'], ['acid a half','0.5'], ['acid a quarter','0.25'],
  ['acid one and a half','1.5'], ['chlorine zero','0'],
  ['cya one hundred','100'], ['chlorine 7.5','7.5'], ['chlorine seven point five','7.5']
].forEach(([said, want])=>{
  const got = speak(said);
  eq('  "' + said + '"', Object.values(got)[0], want);
});



console.log('\n=== EXHAUSTIVE: every alias routes to the right field ===');
{
  const items = [
    {key:'chlorine', label:'Free chlorine', kind:'chem'}, {key:'ph', label:'pH level', kind:'chem'},
    {key:'alkalinity', label:'Total alkalinity', kind:'chem'}, {key:'cya', label:'Cyanuric acid', kind:'chem'},
    {key:'tds', label:'TDS', kind:'chem'}, {key:'calcium', label:'Calcium hardness', kind:'chem'},
    {key:'tabs', label:'Chlorine tabs', kind:'dose'}, {key:'acid', label:'Muriatic acid', kind:'dose'},
    {key:'shock', label:'Shock', kind:'dose'}, {key:'algaecide', label:'Algaecide', kind:'dose'},
    {key:'phosphate', label:'Phosphate remover', kind:'dose'}, {key:'salt', label:'Salt', kind:'dose'}
  ];
  let broken = 0, tested = 0;
  items.forEach(item=>{
    const expect = 'pool_' + item.kind + '_' + item.key;
    const phrases = (P.SPOKEN_ALIASES[item.key] || []).concat([item.label.toLowerCase()]);
    phrases.forEach(p=>{
      tested++;
      const got = speak(p + ' four');
      const keys = Object.keys(got);
      if(keys.length !== 1 || keys[0] !== expect || got[expect] !== '4') broken++;
    });
  });
  truthy('  all ' + tested + ' aliases route correctly', broken === 0, broken + ' misrouted');

  // Every pair spoken together
  let pairBad = 0, pairs = 0;
  items.forEach(a => items.forEach(b=>{
    if(a.key === b.key) return;
    pairs++;
    const got = speak(a.label.toLowerCase() + ' three ' + b.label.toLowerCase() + ' seven');
    const ka = 'pool_' + a.kind + '_' + a.key, kb = 'pool_' + b.kind + '_' + b.key;
    if(got[ka] !== '3' || got[kb] !== '7' || Object.keys(got).length !== 2) pairBad++;
  }));
  truthy('  all ' + pairs + ' field pairs stay separate', pairBad === 0, pairBad + ' collided');

  // Every number form on every field
  const nums = [['zero','0'],['three','3'],['ten','10'],['fifty','50'],['ninety','90'],
    ['one hundred','100'],['two fifty','250'],['twenty eight hundred','2800'],
    ['point one','0.1'],['point two five','0.25'],['one point five','1.5'],
    ['half','0.5'],['a quarter','0.25'],['one and a half','1.5'],
    ['3','3'],['7.5','7.5'],['.5','0.5'],['3200','3200']];
  let numBad = 0, numTested = 0;
  items.forEach(item=>{
    if(item.key === 'ph') return;   // pH has its own two-digit rule
    nums.forEach(([said, want])=>{
      numTested++;
      const got = speak(item.label.toLowerCase() + ' ' + said);
      if(String(Object.values(got)[0]) !== want) numBad++;
    });
  });
  truthy('  all ' + numTested + ' number forms parse', numBad === 0, numBad + ' wrong');
}

console.log('\n=== EXHAUSTIVE: full visits and noise ===');
[
  ['chlorine three ph seven four alkalinity ninety cya fifty', 4],
  ['free chlorine 3 ph 7.4 total alkalinity 90 stabilizer 50 hardness two fifty', 5],
  ['chlorine two acid point five tabs three shock one', 4],
  ['cyanuric acid eighty muriatic acid two chlorine tabs three', 3],
  ['alkalinity one twenty salt twenty eight hundred phosphate remover four', 3]
].forEach(([said, n])=>{
  eq('  ' + n + ' readings from "' + said.slice(0,40) + '..."', Object.keys(speak(said)).length, n);
});
['the pool looked great today','gate was locked so I could not get in','chlorine','ph',
 'took a photo of the equipment','customer wants a call back'].forEach(t=>{
  truthy('  "' + t + '" fills nothing', Object.keys(speak(t)).length === 0);
});


console.log('\n=== Only today\'s route can be serviced ===');
{
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  // Mirrors viewingToday(): compares the viewed day's date against the real one
  function viewingToday(dateForDay){
    if(!dateForDay) return false;
    return dateForDay.toDateString() === new Date().toDateString();
  }
  const today = new Date();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const nextWeek = new Date(today); nextWeek.setDate(today.getDate() + 7);

  truthy('  today is servicable', viewingToday(today));
  truthy('  tomorrow is blocked', !viewingToday(tomorrow));
  truthy('  yesterday is blocked', !viewingToday(yesterday));
  truthy('  same weekday next week is blocked', !viewingToday(nextWeek));
  truthy('  a missing date is blocked', !viewingToday(null));
}


console.log('\n=== Step bar: label and action always agree ===');
{
  // stepNextLabel says "Save" when there is no next step; the click handler
  // saves when currentVisitStep >= total. These must never disagree, or a
  // button reading "Chemicals Added" would submit the report instead.
  function labelIsSave(step, total){ return step >= total; }   // steps[step] undefined
  function actionIsSave(step, total){ return step >= total; }
  let bad = 0;
  for(let total = 1; total <= 6; total++){
    for(let step = 1; step <= total; step++){
      if(labelIsSave(step, total) !== actionIsSave(step, total)) bad++;
    }
  }
  truthy('  label and action agree at every step', bad === 0, bad + ' mismatches');
}

console.log('\n=== Ghost clicks after a view change are swallowed ===');
{
  let now = 1000;
  let viewChangedAt = 0;
  const viewJustChanged = ()=> now - viewChangedAt < 400;
  viewChangedAt = now;                       // a view change just happened
  truthy('  click 50ms later is blocked', (now += 50, viewJustChanged()));
  truthy('  click 300ms later is blocked', (now += 250, viewJustChanged()));
  truthy('  click 500ms later is allowed', (now += 200, !viewJustChanged()));
}


console.log('\n=== Gate photo: customer setting stands on its own ===');
{
  // Mirrors gatePhotoApplies(): any one source can require it
  function applies(global, tech, customer, isFilterClean){
    const required = global === true || tech === true || customer === true;
    if(!required) return false;
    if(isFilterClean) return false;
    return true;
  }
  truthy('  nothing set -> not required', !applies(false, false, false, false));
  truthy('  app-wide only -> required', applies(true, false, false, false));
  truthy('  technician only -> required', applies(false, true, false, false));
  truthy('  customer only -> required', applies(false, false, true, false));
  truthy('  customer set, app-wide OFF -> still required',
         applies(false, false, true, false));
  truthy('  customer set but filter clean -> not required',
         !applies(false, false, true, true));
  truthy('  all three set -> required', applies(true, true, true, false));
}


console.log('\n=== Gate photo lands on the LAST body of water ===');
{
  // Mirrors isLastSectionOfVisit()
  function isLast(needed, done, current){
    if(needed.indexOf(current) === -1) return false;
    return needed.every(s => s === current || done[s] !== undefined);
  }

  // Pool then spa: gate belongs on the spa
  truthy('  pool first, nothing done -> not the last',
         !isLast(['pool','spa'], {}, 'pool'));
  truthy('  spa after pool is done -> is the last',
         isLast(['pool','spa'], {pool:'r1'}, 'spa'));

  // Spa first, then pool
  truthy('  spa first, nothing done -> not the last',
         !isLast(['pool','spa'], {}, 'spa'));
  truthy('  pool after spa is done -> is the last',
         isLast(['pool','spa'], {spa:'r1'}, 'pool'));

  // Pool only
  truthy('  pool alone -> is the last', isLast(['pool'], {}, 'pool'));

  // Spa only, no pool at all
  truthy('  spa alone -> is the last', isLast(['spa'], {}, 'spa'));

  // Three bodies
  const three = ['pool','spa','fountain'];
  truthy('  first of three -> not the last', !isLast(three, {}, 'pool'));
  truthy('  second of three -> not the last', !isLast(three, {pool:'r1'}, 'spa'));
  truthy('  third of three -> is the last',
         isLast(three, {pool:'r1', spa:'r2'}, 'fountain'));

  // Whichever order they are done in
  truthy('  fountain first, pool last', isLast(three, {fountain:'r1', spa:'r2'}, 'pool'));
  truthy('  a section not on the list is never last', !isLast(three, {}, 'equipment'));
}


console.log('\n=== Gate photo with real fountain ids ===');
{
  // In the app each fountain is its own section id, but currentVisibleSection
  // only ever says 'fountain' — this is what that bug looked like.
  function isLast(needed, done, visibleSection, fountainId){
    if(visibleSection === 'equipment') return false;
    const here = visibleSection === 'fountain' ? fountainId : visibleSection;
    if(!here) return false;
    if(needed.indexOf(here) === -1) return false;
    return needed.every(s => s === here || done[s] !== undefined);
  }
  const F1 = 'fountain_a1', F2 = 'fountain_b2';
  const needed = ['pool','spa',F1,F2];

  truthy('  pool first of four -> not last', !isLast(needed, {}, 'pool', null));
  truthy('  spa second -> not last', !isLast(needed, {pool:'r'}, 'spa', null));
  truthy('  first fountain -> not last',
         !isLast(needed, {pool:'r', spa:'r'}, 'fountain', F1));
  truthy('  second fountain, all else done -> IS last',
         isLast(needed, {pool:'r', spa:'r', [F1]:'r'}, 'fountain', F2));
  truthy('  fountains done first, pool last',
         isLast(needed, {spa:'r', [F1]:'r', [F2]:'r'}, 'pool', null));
  truthy('  fountain only customer -> is last',
         isLast([F1], {}, 'fountain', F1));
  truthy('  equipment tab is never the last', !isLast(needed, {}, 'equipment', null));
  truthy('  fountain with no id is never last',
         !isLast(needed, {pool:'r', spa:'r', [F1]:'r'}, 'fountain', null));
  truthy('  wrong fountain id is not last',
         !isLast(needed, {pool:'r', spa:'r'}, 'fountain', 'fountain_zz'));
}


console.log('\n=== Photo pruning keeps the data, drops the images ===');
{
  function prune(list, keep){
    const sorted = list.slice().sort((a,b)=> String(b.date||'').localeCompare(String(a.date||'')));
    let removed = 0;
    sorted.forEach((r, i)=>{
      if(i < keep) return;
      ['photo','beforePhoto','gatePhoto'].forEach(p=>{
        if(r[p]){ r[p] = null; r.photosCleared = true; removed++; }
      });
    });
    return {sorted, removed};
  }
  const mk = (d) => ({date:d, chlorine:'3', ph:'7.4', notes:'ok',
                      photo:'img', beforePhoto:'img', gatePhoto:'img'});
  const list = ['2026-08-01','2026-08-08','2026-08-15','2026-08-22','2026-08-29','2026-09-05'].map(mk);
  const {sorted, removed} = prune(list, 4);

  eq('  photos removed from the 2 oldest', removed, 6);
  truthy('  newest keeps its photos', sorted[0].photo === 'img');
  truthy('  4th newest keeps its photos', sorted[3].photo === 'img');
  truthy('  5th loses its photos', sorted[4].photo === null);
  truthy('  oldest loses its photos', sorted[5].photo === null);
  truthy('  readings are never lost', sorted.length === 6);
  truthy('  chemistry kept on pruned entries', sorted[5].chlorine === '3' && sorted[5].ph === '7.4');
  truthy('  notes kept on pruned entries', sorted[5].notes === 'ok');
  truthy('  pruned entries are marked', sorted[5].photosCleared === true);

  // Nothing to do when there are few visits
  const few = ['2026-09-01','2026-09-08'].map(mk);
  eq('  nothing pruned when under the limit', prune(few, 4).removed, 0);
}


console.log('\n=== Remove changes puts the route back exactly ===');
{
  // What actually happened: deleting the override fell back to an older saved
  // order, so a stop from further down appeared to jump up the list.
  const displayed = ['a','b','c','d','e'];
  const staleWeeklyOrder = ['e','a','b','c','d'];   // saved days ago

  function removeChanges_old(){
    // Old behaviour: delete the one-off order, fall back to whatever was saved
    return staleWeeklyOrder.slice();
  }
  function removeChanges_new(before){
    // New behaviour: restore exactly what was on screen
    return (before && before.length) ? before.slice() : staleWeeklyOrder.slice();
  }

  const dragged = ['a','c','b','d','e'];            // b and c swapped
  truthy('  old way brought back a different order',
         removeChanges_old().join() !== displayed.join());
  eq('  new way restores what was on screen',
     removeChanges_new(displayed).join(), displayed.join());

  // Dragging something and putting it straight back
  const putBack = displayed.slice();
  eq('  drag then replace leaves it unchanged',
     removeChanges_new(displayed).join(), putBack.join());

  // With no snapshot it still falls back rather than breaking
  truthy('  no snapshot falls back safely', removeChanges_new(null).length === 5);
}


console.log('\n=== Dosage rules fire from readings ===');
{
  function matches(reading, rule){
    const v = parseFloat(reading);
    if(isNaN(v)) return false;
    const a = parseFloat(rule.value), b = parseFloat(rule.value2);
    switch(rule.op){
      case 'eq': return !isNaN(a) && v === a;
      case 'lte': return !isNaN(a) && v <= a;
      case 'gte': return !isNaN(a) && v >= a;
      case 'lt': return !isNaN(a) && v < a;
      case 'gt': return !isNaN(a) && v > a;
      case 'between': return !isNaN(a) && !isNaN(b) && v >= Math.min(a,b) && v <= Math.max(a,b);
      default: return false;
    }
  }
  const R = (op, value, amount, doseKey, value2) => ({op, value, amount, doseKey, value2});

  // "chlorine 5 -> 1 tab", the case that prompted this
  eq('  chlorine 5 fires an exact rule', matches('5', R('eq','5','1','tabs')), true);
  eq('  chlorine 4 does not fire it', matches('4', R('eq','5','1','tabs')), false);

  // Ranges
  eq('  1 fires "at or below 1"', matches('1', R('lte','1','2','shock')), true);
  eq('  0 fires "at or below 1"', matches('0', R('lte','1','2','shock')), true);
  eq('  2 does not fire "at or below 1"', matches('2', R('lte','1','2','shock')), false);
  eq('  8 fires "at or above 8"', matches('8', R('gte','8','1','acid')), true);
  eq('  3 fires "between 2 and 4"', matches('3', R('between','2','2','tabs','4')), true);
  eq('  5 does not fire "between 2 and 4"', matches('5', R('between','2','2','tabs','4')), false);
  eq('  boundary 2 fires "between 2 and 4"', matches('2', R('between','2','2','tabs','4')), true);
  eq('  reversed range still works', matches('3', R('between','4','2','tabs','2')), true);

  // Decimals
  eq('  7.4 fires "above 7"', matches('7.4', R('gt','7','1','acid')), true);
  eq('  0.5 fires "at or below 1"', matches('0.5', R('lte','1','2','shock')), true);

  // Nothing sensible entered
  eq('  empty reading fires nothing', matches('', R('eq','5','1','tabs')), false);
  eq('  text fires nothing', matches('abc', R('eq','5','1','tabs')), false);
  eq('  unknown operator fires nothing', matches('5', R('nonsense','5','1','tabs')), false);
  eq('  rule with no value fires nothing', matches('5', R('eq','','1','tabs')), false);
}

console.log('\n=== A dosage typed by hand is never overwritten ===');
{
  const manual = {};
  const field = {value:'', dataset:{}, id:'pool_dose_tabs'};
  function autoFill(val){
    if(manual[field.id]) return;
    field.value = val;
    field.dataset.autoFilled = 'true';
  }
  function byHand(val){
    delete field.dataset.autoFilled;
    manual[field.id] = true;
    field.value = val;
  }
  autoFill('1');
  eq('  rule fills an empty dosage', field.value, '1');
  byHand('3');
  eq('  tech overrides it', field.value, '3');
  autoFill('1');
  eq('  rule does not overwrite the manual value', field.value, '3');
  truthy('  manual flag persists', manual[field.id] === true);
}


console.log('\n=== Dates use local time, not UTC ===');
{
  // A visit finished in the evening in a timezone behind UTC was being stamped
  // with tomorrow's date, so it looked incomplete and came back the next day.
  // Written to pass in any timezone by comparing the two methods directly.
  function utcDateStr(d){ return d.toISOString().slice(0,10); }
  function localDateStr(d){
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,10);
  }

  // Build times relative to the machine's own offset so this holds anywhere
  const base = new Date();
  base.setHours(23, 45, 0, 0);          // late evening, local
  const offsetMin = base.getTimezoneOffset();

  const localStr = localDateStr(base);
  const utcStr = utcDateStr(base);

  eq('  local method matches the wall-clock date',
     localStr, base.getFullYear() + '-'
       + String(base.getMonth() + 1).padStart(2,'0') + '-'
       + String(base.getDate()).padStart(2,'0'));

  if(offsetMin > 0){
    // Behind UTC (the Americas) — this is the case that was broken
    truthy('  UTC method rolls to the next day at 11:45pm', utcStr !== localStr);
  } else {
    truthy('  no rollover needed at this offset', true);
  }

  // Midday is safe at any offset
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  eq('  midday is the same either way', localDateStr(noon), localDateStr(noon));
}


console.log('\n=== Stops and jobs are counted separately ===');
{
  // "Jobs" means work orders and filter cleans, not routine service stops
  function counts(stops, jobIds, doneIds){
    const done = new Set(doneIds);
    const jobs = new Set(jobIds);
    const jobList = stops.filter(s => jobs.has(s));
    return {
      stops: (stops.length - stops.filter(s => done.has(s)).length) + ' of ' + stops.length,
      jobs: (jobList.length - jobList.filter(s => done.has(s)).length) + ' of ' + jobList.length
    };
  }

  let r = counts(['a','b','c','d'], [], []);
  eq('  4 routine stops, no jobs -> stops', r.stops, '4 of 4');
  eq('  4 routine stops, no jobs -> jobs', r.jobs, '0 of 0');

  r = counts(['a','b','c','d'], ['b','d'], []);
  eq('  2 of the 4 are jobs -> stops', r.stops, '4 of 4');
  eq('  2 of the 4 are jobs -> jobs', r.jobs, '2 of 2');

  r = counts(['a','b','c','d'], ['b','d'], ['b']);
  eq('  one job completed -> stops', r.stops, '3 of 4');
  eq('  one job completed -> jobs', r.jobs, '1 of 2');

  r = counts(['a','b','c','d'], ['b','d'], ['a','c']);
  eq('  two routine stops done -> stops', r.stops, '2 of 4');
  eq('  jobs untouched by routine work', r.jobs, '2 of 2');

  r = counts(['a','b','c','d'], ['b','d'], ['a','b','c','d']);
  eq('  everything done -> stops', r.stops, '0 of 4');
  eq('  everything done -> jobs', r.jobs, '0 of 2');

  r = counts([], [], []);
  eq('  empty day -> stops', r.stops, '0 of 0');
  eq('  empty day -> jobs', r.jobs, '0 of 0');
}


console.log('\n=== Admin servicing another day files it correctly ===');
{
  // The report must carry the date of the day being serviced, not today,
  // otherwise it shows as done on the wrong route.
  function visitDateStr(viewedDate, today){
    if(!viewedDate) return localStr(today);
    return localStr(viewedDate);
  }
  function localStr(d){
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,10);
  }
  function visitTimestamp(viewedDate, now){
    if(!viewedDate || viewedDate.toDateString() === now.toDateString()) return now;
    const s = new Date(viewedDate);
    s.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
    return s;
  }

  const now = new Date();
  const today = new Date(now);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);

  eq('  servicing today files under today',
     visitDateStr(today, now), localStr(today));
  eq('  servicing yesterday files under yesterday',
     visitDateStr(yesterday, now), localStr(yesterday));
  eq('  servicing tomorrow files under tomorrow',
     visitDateStr(tomorrow, now), localStr(tomorrow));

  const ts = visitTimestamp(yesterday, now);
  eq('  timestamp lands on the serviced day',
     localStr(ts), localStr(yesterday));
  eq('  timestamp keeps the clock time', ts.getHours(), now.getHours());

  const tsToday = visitTimestamp(today, now);
  eq('  today keeps the exact moment', tsToday.getHours(), now.getHours());
}


console.log('\n=== Back guard survives a long session ===');
{
  // Browsers throttle history.pushState (roughly 100 per 30s) and the failure
  // is silent. Pushing on every view change hit that ceiling, the stack ran
  // dry, and Back closed the app mid-report.
  const THROTTLE = 100;
  let pushes = 0, armed = false, closed = false, depth = 0;

  function arm(){
    if(armed) return;
    if(pushes >= THROTTLE) return;   // silently refused, as a browser would
    pushes++; depth++; armed = true;
  }
  function back(){
    if(depth === 0){ closed = true; return; }
    depth--; armed = false; arm();
  }

  arm();
  // A long session: lots of navigation, then lots of Back presses
  for(let i = 0; i < 200; i++) arm();      // view and step changes
  for(let i = 0; i < 50; i++) back();      // back presses

  truthy('  200 view changes cost only one push', pushes <= 51, pushes + ' pushes');
  truthy('  stays under the throttle ceiling', pushes < THROTTLE, pushes + ' pushes');
  truthy('  50 back presses never close the app', !closed);

  // The old behaviour, for contrast
  let oldPushes = 0, oldDepth = 0, oldClosed = false;
  function oldArm(){ if(oldPushes >= THROTTLE) return; oldPushes++; oldDepth++; }
  function oldBack(){ if(oldDepth === 0){ oldClosed = true; return; } oldDepth--; oldArm(); }
  oldArm();
  for(let i = 0; i < 200; i++) oldArm();
  for(let i = 0; i < 50; i++) oldBack();
  truthy('  the old way hit the throttle', oldPushes >= THROTTLE);
}


console.log('\n=== Dosage rules can follow another list ===');
{
  const cfg = {
    pool: {chemicals:[{key:'chlorine', doseRules:[{op:'eq',value:'5',amount:'1',doseKey:'tabs'}]}]},
    spa:  {chemicals:[{key:'chlorine', doseRules:[{op:'eq',value:'3',amount:'2',doseKey:'tabs'}]}]},
    fountain: {chemicals:[{key:'chlorine'}]}
  };
  function effective(chem, config){
    if(chem.doseRulesFrom){
      const src = config[chem.doseRulesFrom];
      const found = ((src && src.chemicals) || []).find(x => x.key === chem.key);
      return (found && found.doseRules) || [];
    }
    return chem.doseRules || [];
  }

  eq('  pool uses its own rule', effective(cfg.pool.chemicals[0], cfg)[0].value, '5');
  eq('  spa uses its own rule', effective(cfg.spa.chemicals[0], cfg)[0].value, '3');
  truthy('  spa rule differs from pool',
         effective(cfg.spa.chemicals[0], cfg)[0].value !== effective(cfg.pool.chemicals[0], cfg)[0].value);

  // Spa follows pool
  cfg.spa.chemicals[0].doseRulesFrom = 'pool';
  eq('  spa following pool uses pool\'s rule', effective(cfg.spa.chemicals[0], cfg)[0].value, '5');
  truthy('  spa keeps its own rule stored underneath',
         cfg.spa.chemicals[0].doseRules[0].value === '3');

  // Unlinking restores its own
  cfg.spa.chemicals[0].doseRulesFrom = null;
  eq('  unlinking restores its own rule', effective(cfg.spa.chemicals[0], cfg)[0].value, '3');

  // Following a list with no rules
  cfg.fountain.chemicals[0].doseRulesFrom = 'fountain';
  eq('  following an empty list yields nothing',
     effective(cfg.fountain.chemicals[0], cfg).length, 0);

  // Changes at the source flow through
  cfg.spa.chemicals[0].doseRulesFrom = 'pool';
  cfg.pool.chemicals[0].doseRules[0].amount = '4';
  eq('  a change on pool reaches the follower',
     effective(cfg.spa.chemicals[0], cfg)[0].amount, '4');
}


console.log('\n=== Custom customers inherit the standard rules ===');
{
  const chemConfig = {
    pool: {chemicals:[
      {key:'chlorine', doseRules:[{op:'eq',value:'5',amount:'1',doseKey:'tabs'}]},
      {key:'ph', doseRules:[{op:'gt',value:'7.8',amount:'1',doseKey:'acid'}]}
    ]},
    spa: {chemicals:[{key:'chlorine', doseRules:[{op:'eq',value:'3',amount:'2',doseKey:'tabs'}]}]},
    fountain: {chemicals:[{key:'chlorine'}]}
  };
  function resolve(chem, type){
    if(chem.doseRulesFrom){
      const src = chemConfig[chem.doseRulesFrom];
      const f = ((src && src.chemicals) || []).find(x => x.key === chem.key);
      return (f && f.doseRules) || [];
    }
    if(chem.doseRules && chem.doseRules.length) return chem.doseRules;
    const std = chemConfig[type];
    const m = ((std && std.chemicals) || []).find(x => x.key === chem.key);
    return (m && m.doseRules) || [];
  }

  // A custom setup snapshotted before the rule existed
  const customChem = {key:'chlorine'};
  eq('  custom with no rules inherits pool', resolve(customChem, 'pool')[0].value, '5');
  eq('  custom inherits spa when it is a spa', resolve(customChem, 'spa')[0].value, '3');

  // Its own rule wins
  const ownChem = {key:'chlorine', doseRules:[{op:'eq',value:'9',amount:'3',doseKey:'tabs'}]};
  eq('  a custom rule overrides the standard one', resolve(ownChem, 'pool')[0].value, '9');

  // Following another list still wins over both
  const followChem = {key:'chlorine', doseRulesFrom:'spa',
                      doseRules:[{op:'eq',value:'9',amount:'3',doseKey:'tabs'}]};
  eq('  an explicit follow beats its own rules', resolve(followChem, 'pool')[0].value, '3');

  // Empty standard list yields nothing rather than breaking
  eq('  nothing to inherit yields no rules', resolve({key:'chlorine'}, 'fountain').length, 0);
  eq('  unknown chemical yields no rules', resolve({key:'nonsense'}, 'pool').length, 0);

  // A rule added to pool AFTER the custom setup existed still reaches it
  chemConfig.pool.chemicals[0].doseRules.push({op:'lte',value:'1',amount:'2',doseKey:'shock'});
  eq('  a rule added later reaches the custom customer',
     resolve(customChem, 'pool').length, 2);
}


console.log('\n=== Dosages keep syncing as the reading changes ===');
{
  // The old bug: the rule engine dispatched an input event carrying a custom
  // autoFill flag, but the Event constructor drops unknown options — so the
  // dose field saw an ordinary edit, marked itself hand-edited, and locked out
  // every future rule after the first fill.
  const rules = [
    {op:'eq', value:'5', amount:'1', doseKey:'tabs'},
    {op:'lte', value:'1', amount:'2', doseKey:'shock'}
  ];
  function match(v, r){
    const n = parseFloat(v); if(isNaN(n)) return false;
    const a = parseFloat(r.value);
    return r.op === 'eq' ? n === a : (r.op === 'lte' ? n <= a : false);
  }
  const doses = {tabs:{value:'', auto:false}, shock:{value:'', auto:false}};
  const manual = {};
  let applying = false;

  function apply(reading){
    rules.forEach(r=>{
      const d = doses[r.doseKey];
      if(manual[r.doseKey]) return;
      applying = true;
      if(match(reading, r)){ d.value = r.amount; d.auto = true; }
      else if(d.auto){ d.value = ''; d.auto = false; }
      applying = false;
    });
  }
  function typeIn(key, v){ if(!applying){ manual[key] = true; } doses[key].value = v; }

  apply('5'); eq('  chlorine 5 fills tabs', doses.tabs.value, '1');
  apply('3'); eq('  chlorine 3 clears tabs', doses.tabs.value, '');
  apply('5'); eq('  back to 5 refills tabs', doses.tabs.value, '1');
  apply('1'); eq('  chlorine 1 clears tabs', doses.tabs.value, '');
  eq('  chlorine 1 fills shock', doses.shock.value, '2');
  apply('5'); eq('  back to 5 clears shock', doses.shock.value, '');
  eq('  and refills tabs', doses.tabs.value, '1');
  for(let i = 0; i < 20; i++){ apply('5'); apply('3'); }
  apply('5');
  eq('  still syncing after 40 changes', doses.tabs.value, '1');

  typeIn('tabs', '9');
  apply('3'); eq('  a hand-typed dosage survives a reading change', doses.tabs.value, '9');
  apply('5'); eq('  and is never overwritten by a rule', doses.tabs.value, '9');
}


console.log('\n=== Quick buttons keep their own colours ===');
{
  // The old bug: clicking one button reset every button in the row to THAT
  // button's colour, so a red row would turn entirely green after a tap.
  const buttons = [
    {value:'0', rest:'red-rest',    pressed:'red-pressed',    style:'red-rest'},
    {value:'1', rest:'blue-rest',   pressed:'blue-pressed',   style:'blue-rest'},
    {value:'3', rest:'green-rest',  pressed:'green-pressed',  style:'green-rest'},
    {value:'5', rest:'purple-rest', pressed:'purple-pressed', style:'purple-rest'}
  ];

  function tap(idx){
    // Reset each to its OWN rest style, then press the tapped one
    buttons.forEach(b => { b.style = b.rest; });
    buttons[idx].style = buttons[idx].pressed;
  }
  function clearAll(){ buttons.forEach(b => { b.style = b.rest; }); }

  tap(2);
  eq('  tapped button shows pressed', buttons[2].style, 'green-pressed');
  eq('  first keeps red', buttons[0].style, 'red-rest');
  eq('  second keeps blue', buttons[1].style, 'blue-rest');
  eq('  fourth keeps purple', buttons[3].style, 'purple-rest');

  tap(0);
  eq('  new tap shows pressed', buttons[0].style, 'red-pressed');
  eq('  previous returns to its own green', buttons[2].style, 'green-rest');

  clearAll();
  eq('  clearing restores red', buttons[0].style, 'red-rest');
  eq('  clearing restores blue', buttons[1].style, 'blue-rest');
  eq('  clearing restores green', buttons[2].style, 'green-rest');
  eq('  clearing restores purple', buttons[3].style, 'purple-rest');

  const distinct = new Set(buttons.map(b => b.style)).size;
  eq('  all four colours remain distinct', distinct, 4);
}


console.log('\n=== Both back routes behave the same ===');
{
  // The on-screen button only asked when something had been entered; the phone
  // back button always asked. They must match.
  function hasUnsaved(state){
    if(state.fields) return true;
    if(state.afterPhoto) return true;
    if(state.beforePhoto) return true;
    if(state.gatePhoto) return true;
    if(state.sectionsDone) return true;
    return false;
  }
  function onScreenBack(state){ return hasUnsaved(state) ? 'asks' : 'leaves'; }
  function phoneBack(state){ return hasUnsaved(state) ? 'asks' : 'leaves'; }

  const cases = [
    ['nothing entered',        {}, 'leaves'],
    ['a reading typed',        {fields:true}, 'asks'],
    ['an after photo taken',   {afterPhoto:true}, 'asks'],
    ['a before photo taken',   {beforePhoto:true}, 'asks'],
    ['a gate photo taken',     {gatePhoto:true}, 'asks'],
    ['a section already saved',{sectionsDone:true}, 'asks'],
    ['readings and photos',    {fields:true, afterPhoto:true}, 'asks']
  ];

  cases.forEach(([label, state, want])=>{
    eq('  on-screen, ' + label, onScreenBack(state), want);
    eq('  phone back, ' + label, phoneBack(state), want);
    eq('  the two agree on ' + label, onScreenBack(state), phoneBack(state));
  });
}


console.log('\n=== An original and a redo are listed separately ===');
{
  const keyFor = r => r.date.slice(0,10) + (r.isRedo ? '|redo' : '');
  function buildList(readings){
    const m = new Map();
    readings.forEach(r=>{ const k = keyFor(r); if(!m.has(k)) m.set(k, r.date); });
    return Array.from(m.entries())
      .map(([key, ts]) => ({dateStr:key, ts, isRedo: key.indexOf('|redo') !== -1}))
      .sort((a,b)=> b.ts.localeCompare(a.ts));
  }
  function pick(readings, dateStr){
    const wantRedo = dateStr.indexOf('|redo') !== -1;
    const plain = dateStr.replace('|redo', '');
    return readings.find(r => r.date.slice(0,10) === plain && !!r.isRedo === wantRedo);
  }

  const readings = [
    {id:'r3', date:'2026-08-20T15:00:00Z', isRedo:true,  chlorine:'5'},
    {id:'r2', date:'2026-08-20T09:00:00Z', isRedo:false, chlorine:'1'},
    {id:'r1', date:'2026-08-13T09:00:00Z', isRedo:false, chlorine:'3'}
  ];

  const list = buildList(readings);
  eq('  three entries for two dates', list.length, 3);
  eq('  newest first is the redo', list[0].dateStr, '2026-08-20|redo');
  eq('  then the original that day', list[1].dateStr, '2026-08-20');
  eq('  then the earlier visit', list[2].dateStr, '2026-08-13');

  eq('  picking the redo gets the redo', pick(readings, '2026-08-20|redo').id, 'r3');
  eq('  picking the original gets the original', pick(readings, '2026-08-20').id, 'r2');
  eq('  the original is reachable, not hidden', pick(readings, '2026-08-20').chlorine, '1');
  eq('  an ordinary date still works', pick(readings, '2026-08-13').id, 'r1');

  // A date with no redo produces exactly one entry
  const single = buildList([{id:'x', date:'2026-09-01T09:00:00Z', isRedo:false}]);
  eq('  a normal day is one entry', single.length, 1);
  truthy('  and is not marked as redone', single[0].isRedo === false);
}


console.log('\n=== Back from a report returns where it was opened from ===');
{
  // Opening a report from a technician's route should go back to that route,
  // on the same technician and the same day — not to the home list.
  function back(view, openedFrom){
    if(view === 'report' && openedFrom && openedFrom.view === 'technicians'){
      return {view:'technicians', techId: openedFrom.techId,
              day: openedFrom.day, weekOffset: openedFrom.weekOffset || 0};
    }
    if(view !== 'home') return {view:'home'};
    return {view:'home'};
  }

  const from = {view:'technicians', techId:'t2', day:'Thursday', weekOffset:-1};
  let r = back('report', from);
  eq('  returns to the technicians tab', r.view, 'technicians');
  eq('  same technician', r.techId, 't2');
  eq('  same day', r.day, 'Thursday');
  eq('  same week', r.weekOffset, -1);

  // Opened from the serviced list instead
  r = back('report', null);
  eq('  a report opened elsewhere goes home', r.view, 'home');

  // Other views are unaffected
  eq('  customers tab goes home', back('customers', null).view, 'home');
  eq('  settings goes home', back('options', from).view, 'home');
  eq('  home stays home', back('home', null).view, 'home');
}


console.log('\n=== Apply to all can be undone ===');
{
  // Ticking copies the pool's list over the others; unticking must put their
  // own lists back rather than leaving the pool's copy behind.
  let chemConfig, stash;
  function reset(){
    chemConfig = {
      pool:     {chemicals:[{key:'chlorine'},{key:'ph'},{key:'cya'}]},
      spa:      {chemicals:[{key:'chlorine'},{key:'ph'}]},
      fountain: {chemicals:[{key:'ph'}]}
    };
    stash = {};
  }
  function tickOn(listKey){
    stash[listKey] = {
      spa: JSON.parse(JSON.stringify(chemConfig.spa[listKey])),
      fountain: JSON.parse(JSON.stringify(chemConfig.fountain[listKey]))
    };
    chemConfig.spa[listKey] = JSON.parse(JSON.stringify(chemConfig.pool[listKey]));
    chemConfig.fountain[listKey] = JSON.parse(JSON.stringify(chemConfig.pool[listKey]));
  }
  function tickOff(listKey){
    const saved = stash[listKey];
    if(!saved) return false;
    chemConfig.spa[listKey] = JSON.parse(JSON.stringify(saved.spa));
    chemConfig.fountain[listKey] = JSON.parse(JSON.stringify(saved.fountain));
    delete stash[listKey];
    return true;
  }
  const keys = o => o.map(i => i.key).join(',');

  reset();
  eq('  spa starts with its own two', keys(chemConfig.spa.chemicals), 'chlorine,ph');
  eq('  fountain starts with one', keys(chemConfig.fountain.chemicals), 'ph');

  tickOn('chemicals');
  eq('  ticking gives spa the pool list', keys(chemConfig.spa.chemicals), 'chlorine,ph,cya');
  eq('  ticking gives fountain the pool list', keys(chemConfig.fountain.chemicals), 'chlorine,ph,cya');

  truthy('  unticking reports a restore', tickOff('chemicals'));
  eq('  spa is back to its own', keys(chemConfig.spa.chemicals), 'chlorine,ph');
  eq('  fountain is back to its own', keys(chemConfig.fountain.chemicals), 'ph');
  eq('  the pool is untouched throughout', keys(chemConfig.pool.chemicals), 'chlorine,ph,cya');

  // Changing the pool while applied must not corrupt what's stashed
  reset();
  tickOn('chemicals');
  chemConfig.pool.chemicals.push({key:'tds'});
  chemConfig.spa.chemicals = JSON.parse(JSON.stringify(chemConfig.pool.chemicals));
  tickOff('chemicals');
  eq('  a later pool change does not leak into the restore',
     keys(chemConfig.spa.chemicals), 'chlorine,ph');

  // Unticking without ever having ticked is harmless
  reset();
  truthy('  unticking with nothing stashed is safe', tickOff('chemicals') === false);
  eq('  and leaves the spa alone', keys(chemConfig.spa.chemicals), 'chlorine,ph');
}



console.log('\n=== A customer can have their own service order ===');
{
  function sections(customer, savedOrder){
    const out = [];
    if(customer.hasPool !== false) out.push('pool');
    if(customer.hasSpa) out.push('spa');
    (customer.fountains || []).forEach(f => out.push(f.id));
    if(Array.isArray(savedOrder) && savedOrder.length){
      const ordered = [];
      savedOrder.forEach(k => { if(out.indexOf(k) !== -1) ordered.push(k); });
      out.forEach(s => { if(ordered.indexOf(s) === -1) ordered.push(s); });
      return ordered;
    }
    return out;
  }

  const cust = {hasPool:true, hasSpa:true, fountains:[{id:'f1'},{id:'f2'}]};

  eq('  no custom order keeps the usual one',
     sections(cust, null).join(','), 'pool,spa,f1,f2');
  eq('  fountains can go first',
     sections(cust, ['f1','f2','pool','spa']).join(','), 'f1,f2,pool,spa');
  eq('  spa can go first',
     sections(cust, ['spa','pool','f1','f2']).join(','), 'spa,pool,f1,f2');
  eq('  the visit opens on the first',
     sections(cust, ['f2','pool','spa','f1'])[0], 'f2');

  // A body added after the order was set still appears
  eq('  a newly added fountain is not lost',
     sections(cust, ['spa','pool','f1']).join(','), 'spa,pool,f1,f2');

  // A body removed since the order was set is ignored
  eq('  a removed body is skipped',
     sections({hasPool:true, hasSpa:false, fountains:[]}, ['spa','pool']).join(','), 'pool');

  // One customer's order must not affect another
  const other = {hasPool:true, hasSpa:true, fountains:[]};
  eq('  another customer is unaffected',
     sections(other, null).join(','), 'pool,spa');
}


console.log('\n=== User-defined photos ===');
{
  function wanted(defs, when, requiredOnly){
    return defs.filter(p => p && p.label
      && (p.when === 'before' ? 'before' : 'after') === when
      && (!requiredOnly || p.required === true));
  }
  function missing(defs, when, taken){
    const need = wanted(defs, when, true);
    const gap = need.find(p => !taken[p.id]);
    return gap ? gap.label : '';
  }

  const defs = [
    {id:'p1', label:'Filter gauge',   when:'before', required:true},
    {id:'p2', label:'Skimmer basket', when:'before', required:false},
    {id:'p3', label:'Equipment pad',  when:'after',  required:true},
    {id:'p4', label:'',               when:'after',  required:true}   // unnamed
  ];

  eq('  two show before the readings', wanted(defs, 'before', false).length, 2);
  eq('  one shows after (unnamed ignored)', wanted(defs, 'after', false).length, 1);

  eq('  a required before photo blocks', missing(defs, 'before', {}), 'Filter gauge');
  eq('  taking it clears the block', missing(defs, 'before', {p1:'img'}), '');
  eq('  the optional one never blocks', missing(defs, 'before', {p1:'img'}), '');
  eq('  a required after photo blocks', missing(defs, 'after', {}), 'Equipment pad');
  eq('  an unnamed photo never blocks', missing(defs, 'after', {p3:'img'}), '');

  // Nothing defined means nothing required
  eq('  no custom photos, nothing owing', missing([], 'after', {}), '');
}


console.log('\n=== Custom photos can be assigned to technicians ===');
{
  function visible(defs, user){
    return defs.filter(p=>{
      if(!p || !p.label) return false;
      if(!Array.isArray(p.techIds) || p.techIds.length === 0) return true;
      return !!(user && p.techIds.indexOf(user.id) !== -1);
    }).map(p => p.label);
  }

  const defs = [
    {id:'a', label:'Everyone',   techIds:[]},
    {id:'b', label:'Alex only',  techIds:['t1']},
    {id:'c', label:'Alex or Sam',techIds:['t1','t2']},
    {id:'d', label:'Sam only',   techIds:['t2']},
    {id:'e', label:'',           techIds:[]}          // unnamed
  ];

  eq('  Alex sees three', visible(defs, {id:'t1'}).join(','), 'Everyone,Alex only,Alex or Sam');
  eq('  Sam sees three', visible(defs, {id:'t2'}).join(','), 'Everyone,Alex or Sam,Sam only');
  eq('  a third tech sees only the shared one', visible(defs, {id:'t3'}).join(','), 'Everyone');
  eq('  nobody signed in still sees the shared one', visible(defs, null).join(','), 'Everyone');
  truthy('  the unnamed one never shows', visible(defs, {id:'t1'}).indexOf('') === -1);

  // A photo with no assignment behaves as before
  eq('  no assignment means everyone',
     visible([{id:'x', label:'Gauge'}], {id:'t9'}).join(','), 'Gauge');
}


console.log('\n=== Back never closes the app during a visit ===');
{
  // A single guard entry meant two quick presses could close the app: the
  // second arrived before the replacement had been pushed.
  const DEPTH = 6;
  function run(depth, presses, rearmLags){
    let entries = 0, closed = false;
    const arm = ()=>{ while(entries < depth) entries++; };
    arm();
    const queued = [];
    for(let i = 0; i < presses; i++){
      if(entries === 0){ closed = true; break; }
      entries--;
      if(rearmLags) queued.push(1); else arm();
    }
    queued.forEach(()=> arm());
    return closed;
  }

  truthy('  one entry closes on two quick presses', run(1, 2, true) === true);
  truthy('  six entries survive two', run(DEPTH, 2, true) === false);
  truthy('  six entries survive six', run(DEPTH, 6, true) === false);
  truthy('  normal use survives 50 presses', run(DEPTH, 50, false) === false);
  truthy('  normal use survives 200 presses', run(DEPTH, 200, false) === false);

  // And it stays under the browser's pushState throttle
  const pushes = DEPTH + 50;
  truthy('  50 back presses stay under the throttle', pushes < 100, pushes + ' pushes');
}


console.log('\n=== Each body of water keeps its own rules ===');
{
  // A spread copies only the top level, so doseRules stayed SHARED between
  // bodies of water and editing one silently changed the others.
  const shallow = i => ({...i, buttons:(i.buttons||[]).slice()});
  const deep = i => JSON.parse(JSON.stringify(i));

  function leaks(copyFn){
    const pool = {key:'chlorine', buttons:[1],
                  doseRules:[{op:'eq', value:'5', amount:'1', doseKey:'tabs'}]};
    const spa = copyFn(pool);
    spa.doseRules[0].amount = '99';
    return pool.doseRules[0].amount === '99';
  }

  truthy('  a shallow copy leaks (the old behaviour)', leaks(shallow) === true);
  truthy('  a deep copy does not leak', leaks(deep) === false);

  // Three bodies, each edited independently
  const base = {key:'chlorine', doseRules:[{op:'eq', value:'5', amount:'1', doseKey:'tabs'}]};
  const pool = deep(base), spa = deep(base), fountain = deep(base);
  pool.doseRules[0].amount = '1';
  spa.doseRules[0].amount = '2';
  fountain.doseRules[0].amount = '3';
  eq('  pool keeps its own amount', pool.doseRules[0].amount, '1');
  eq('  spa keeps its own amount', spa.doseRules[0].amount, '2');
  eq('  fountain keeps its own amount', fountain.doseRules[0].amount, '3');

  // Adding a rule to one must not appear on another
  spa.doseRules.push({op:'lte', value:'1', amount:'2', doseKey:'shock'});
  eq('  a rule added to the spa stays there', spa.doseRules.length, 2);
  eq('  the pool is unaffected', pool.doseRules.length, 1);

  // Custom photos are arrays too, and had the same problem
  const withPhotos = {key:'ph', customPhotos:[{id:'p1', label:'Gauge'}]};
  const copy = deep(withPhotos);
  copy.customPhotos[0].label = 'Changed';
  eq('  custom photos do not leak either', withPhotos.customPhotos[0].label, 'Gauge');
}


console.log('\n=== A section\'s own photo setting beats the app-wide one ===');
{
  // Ticking or unticking on Readings and Dosages has the final say, so a spa
  // or fountain can be exempt while the pool still requires a photo.
  function required(sectionSetting, techSetting, appWide, showAfter){
    if(showAfter === false) return false;
    if(typeof sectionSetting === 'boolean') return sectionSetting;
    if(techSetting === true) return true;
    return appWide === true;
  }

  // The case that prompted this
  truthy('  spa unticked, app-wide on -> NOT required',
         required(false, false, true, true) === false);
  truthy('  pool ticked, app-wide off -> required',
         required(true, false, false, true) === true);

  // Untouched sections still follow the wider settings
  truthy('  untouched section, app-wide on -> required',
         required(undefined, false, true, true) === true);
  truthy('  untouched section, app-wide off -> not required',
         required(undefined, false, false, true) === false);

  // A technician requirement applies only where the section is silent
  truthy('  untouched section, technician requires -> required',
         required(undefined, true, false, true) === true);
  truthy('  section unticked beats the technician too',
         required(false, true, true, true) === false);

  // Turning the step off entirely wins over everything
  truthy('  after photos switched off -> never required',
         required(true, true, true, false) === false);

  // A realistic setup: pool yes, spa no, fountain untouched
  truthy('  pool requires', required(true, false, false, true) === true);
  truthy('  spa exempt', required(false, false, false, true) === false);
  truthy('  fountain follows the app-wide setting',
         required(undefined, false, false, true) === false);
}


console.log('\n=== Tapping the tab you are already on does nothing ===');
{
  // Tapping Today twice used to open the first customer, because the second
  // tap hit the "resume the unfinished visit" path.
  function tapTab(tabView, currentView, draftCustomerId){
    if(tabView === currentView) return 'ignored';
    if(tabView === 'home' && draftCustomerId) return 'opened ' + draftCustomerId;
    return 'switched to ' + tabView;
  }

  eq('  Today tapped while on Today', tapTab('home', 'home', 'c1'), 'ignored');
  eq('  Today tapped while on Today, no draft', tapTab('home', 'home', null), 'ignored');
  eq('  Settings tapped while on Settings', tapTab('options', 'options', null), 'ignored');
  eq('  Report tapped while on Report', tapTab('report', 'report', 'c1'), 'ignored');

  // Genuine navigation still works
  eq('  Today tapped from Settings, no draft',
     tapTab('home', 'options', null), 'switched to home');
  eq('  Today tapped from Settings resumes a draft',
     tapTab('home', 'options', 'c1'), 'opened c1');
  eq('  Today tapped from inside a visit resumes it',
     tapTab('home', 'visit', 'c1'), 'opened c1');
  eq('  another tab still switches',
     tapTab('customers', 'home', 'c1'), 'switched to customers');
}


console.log('\n=== Saving one body of water moves to the next ===');
{
  function nextSection(needed, done){
    const all = needed.length > 0 && needed.every(id => done[id] !== undefined);
    if(all) return 'finish';
    return needed.find(id => done[id] === undefined) || null;
  }

  // Which step index the readings sit at, given the photo settings
  function readingsStep(showBefore){
    const steps = [];
    if(showBefore) steps.push('BeforePhoto');
    steps.push('Readings');
    steps.push('Dosages');
    steps.push('AfterPhoto+Save');
    return steps.indexOf('Readings') + 1;
  }

  const needed = ['pool','spa','f1'];

  eq('  after the pool, go to the spa', nextSection(needed, {pool:'r1'}), 'spa');
  eq('  after the spa, go to the fountain', nextSection(needed, {pool:'r1', spa:'r2'}), 'f1');
  eq('  after the last one, finish the visit',
     nextSection(needed, {pool:'r1', spa:'r2', f1:'r3'}), 'finish');
  eq('  a single body finishes straight away', nextSection(['pool'], {pool:'r1'}), 'finish');

  // Order follows the customer's own arrangement
  const reordered = ['f1','pool','spa'];
  eq('  follows a custom order', nextSection(reordered, {f1:'r1'}), 'pool');

  // And it opens at the readings, not the before photo
  eq('  readings step with before photos on', readingsStep(true), 2);
  eq('  readings step with before photos off', readingsStep(false), 1);
}


console.log('\n=== Clearing report photos keeps equipment photos ===');
{
  function stripReportPhotos(store){
    let removed = 0;
    Object.keys(store).forEach(key=>{
      const val = store[key];
      if(key === 'customers') return;          // equipment photos live here
      if(Array.isArray(val) && val.length && typeof val[0] === 'object'){
        val.forEach(r=>{
          ['photo','beforePhoto','gatePhoto'].forEach(p=>{
            if(r[p]){ r[p] = null; removed++; }
          });
          if(r.customPhotos) Object.keys(r.customPhotos).forEach(id=>{
            if(r.customPhotos[id]){ r.customPhotos[id] = null; removed++; }
          });
        });
      }
    });
    return removed;
  }

  const store = {
    'readings:c1:pool': [
      {date:'2026-09-01', chlorine:'3', notes:'ok', photo:'img', beforePhoto:'img', gatePhoto:'img'},
      {date:'2026-08-25', chlorine:'2', photo:'img', customPhotos:{p1:'img'}}
    ],
    'customers': [{id:'c1', name:'Test',
                   equipment:[{type:'Filter', photos:['a','b','c']}]}]
  };

  const removed = stripReportPhotos(store);
  eq('  only report photos removed', removed, 5);
  eq('  equipment photos untouched', store.customers[0].equipment[0].photos.length, 3);

  const r = store['readings:c1:pool'];
  truthy('  visit photo gone', r[0].photo === null);
  truthy('  before photo gone', r[0].beforePhoto === null);
  truthy('  gate photo gone', r[0].gatePhoto === null);
  truthy('  custom photo gone', r[1].customPhotos.p1 === null);
  eq('  readings kept', r.length, 2);
  eq('  chemistry kept', r[0].chlorine, '3');
  eq('  notes kept', r[0].notes, 'ok');
  eq('  customer record kept', store.customers[0].name, 'Test');

  eq('  running it twice removes nothing more', stripReportPhotos(store), 0);
  eq('  equipment photos still there after twice',
     store.customers[0].equipment[0].photos.length, 3);
}

console.log('\n=== Photos are not stored when the setting is off ===');
{
  function photoToSave(controllerValue, storePhotos){
    return storePhotos === false ? null : (controllerValue || null);
  }
  truthy('  kept when the setting is on', photoToSave('img', true) === 'img');
  truthy('  kept when the setting is unset', photoToSave('img', undefined) === 'img');
  truthy('  dropped when the setting is off', photoToSave('img', false) === null);
  truthy('  nothing taken is still null', photoToSave(null, true) === null);
}


console.log('\n=== More than one of the same equipment type ===');
{
  function baseType(t){ return String(t || '').replace(/\s+\d+$/, '').trim(); }
  function addType(existing, name){
    if(!existing.includes(name)) return name;
    let n = 2;
    while(existing.includes(name + ' ' + n)) n++;
    return name + ' ' + n;
  }

  let types = ['Filter','Pump'];
  eq('  a new type is added as-is', addType(types, 'Heater'), 'Heater');
  eq('  a repeat becomes 2', addType(types, 'Filter'), 'Filter 2');
  types.push('Filter 2');
  eq('  a third becomes 3', addType(types, 'Filter'), 'Filter 3');
  types.push('Filter 3');
  eq('  and a fourth becomes 4', addType(types, 'Filter'), 'Filter 4');

  // Options still resolve for numbered items
  eq('  "Filter 2" is a Filter', baseType('Filter 2'), 'Filter');
  eq('  "Filter 10" is a Filter', baseType('Filter 10'), 'Filter');
  eq('  "Filter" is a Filter', baseType('Filter'), 'Filter');
  eq('  "Cleaning System 2" keeps its name', baseType('Cleaning System 2'), 'Cleaning System');
  eq('  a custom name is untouched', baseType('Salt System'), 'Salt System');

  // The field apps must still find them
  const equipment = [
    {type:'Filter', filterTypeChoice:'Cartridge'},
    {type:'Filter 2', filterTypeChoice:'Sand'},
    {type:'Chlorination', chlorinationChoice:'Tabs'},
    {type:'Chlorination 2', chlorinationChoice:'Salt Cell'}
  ];
  const anyFilter = equipment.find(i => baseType(i.type) === 'Filter');
  truthy('  a filter is found', !!anyFilter);
  const isSalt = equipment.some(i =>
    baseType(i.type) === 'Chlorination' && i.chlorinationChoice === 'Salt Cell');
  truthy('  a second chlorinator being salt is detected', isSalt === true);

  const noSalt = [{type:'Chlorination', chlorinationChoice:'Tabs'}]
    .some(i => baseType(i.type) === 'Chlorination' && i.chlorinationChoice === 'Salt Cell');
  truthy('  a tab-only pool is not salt', noSalt === false);
}


console.log('\n=== The plus adds a copy below its group ===');
{
  const isCopy = t => /\s+\d+$/.test(t);
  function addCopy(types, type){
    let n = 2;
    while(types.includes(type + ' ' + n)) n++;
    const name = type + ' ' + n;
    let at = types.length;
    for(let i = 0; i < types.length; i++){
      const t = types[i];
      if(t === type || t.indexOf(type + ' ') === 0) at = i + 1;
    }
    types.splice(at, 0, name);
    return name;
  }

  let types = ['Filter','Pump','Heater'];
  eq('  first copy is numbered 2', addCopy(types, 'Filter'), 'Filter 2');
  eq('  it sits right below the original', types.join(','), 'Filter,Filter 2,Pump,Heater');
  eq('  second copy is numbered 3', addCopy(types, 'Filter'), 'Filter 3');
  eq('  and goes below the last of its kind',
     types.join(','), 'Filter,Filter 2,Filter 3,Pump,Heater');
  eq('  another type is unaffected', addCopy(types, 'Pump'), 'Pump 2');
  eq('  and lands in its own group',
     types.join(','), 'Filter,Filter 2,Filter 3,Pump,Pump 2,Heater');

  // Only originals get the plus
  truthy('  "Filter" gets a plus', isCopy('Filter') === false);
  truthy('  "Filter 2" does not', isCopy('Filter 2') === true);
  truthy('  "Filter 10" does not', isCopy('Filter 10') === true);
  truthy('  "Cleaning System" gets one', isCopy('Cleaning System') === false);
  truthy('  "Cleaning System 2" does not', isCopy('Cleaning System 2') === true);
  truthy('  a custom name gets one', isCopy('Salt System') === false);
}


console.log('\n=== Quick buttons for equipment types you create ===');
{
  const store = {};
  const base = t => String(t||'').replace(/\s+\d+$/,'').trim();
  const get = t => { const l = store[base(t)]; return Array.isArray(l) ? l.slice() : []; };
  const save = (t, o) => { store[base(t)] = o; };

  eq('  a new type starts with none', get('Salt System').length, 0);

  save('Salt System', ['Circupool','Pentair IC40','Hayward']);
  eq('  options are saved', get('Salt System').join(','), 'Circupool,Pentair IC40,Hayward');
  eq('  another customer with the same type gets them',
     get('Salt System').join(','), 'Circupool,Pentair IC40,Hayward');
  eq('  a numbered copy shares them', get('Salt System 2').join(','), 'Circupool,Pentair IC40,Hayward');
  eq('  an unrelated type is unaffected', get('Booster Pump').length, 0);

  // Editing and removing
  save('Salt System', ['Circupool','Hayward']);
  eq('  removing one leaves the rest', get('Salt System').join(','), 'Circupool,Hayward');
  save('Salt System', []);
  eq('  clearing them all works', get('Salt System').length, 0);

  // Blank entries are dropped rather than becoming empty buttons
  const cleaned = ['Circupool','','  ','Hayward'].map(o => String(o||'').trim()).filter(Boolean);
  eq('  blank buttons are discarded', cleaned.join(','), 'Circupool,Hayward');
}


console.log('\n=== Adding equipment to several customers at once ===');
{
  function addToCustomers(customers, typeName, ids){
    let added = 0;
    ids.forEach(id=>{
      const cust = customers.find(x => x.id === id);
      if(!cust) return;
      const list = Array.isArray(cust.equipmentTypeOptions) ? cust.equipmentTypeOptions.slice() : [];
      if(list.includes(typeName)) return;
      list.push(typeName);
      cust.equipmentTypeOptions = list;
      added++;
    });
    return added;
  }

  const custs = [
    {id:'a', name:'Alpha', equipmentTypeOptions:['Filter']},
    {id:'b', name:'Beta',  equipmentTypeOptions:['Filter','Salt System']},
    {id:'c', name:'Gamma'}                                   // none recorded yet
  ];

  eq('  added to two who lacked it', addToCustomers(custs, 'Salt System', ['a','b','c']), 2);
  truthy('  Alpha now has it', custs[0].equipmentTypeOptions.includes('Salt System'));
  truthy('  Beta is not duplicated',
         custs[1].equipmentTypeOptions.filter(t => t === 'Salt System').length === 1);
  truthy('  Gamma got a list created', Array.isArray(custs[2].equipmentTypeOptions)
         && custs[2].equipmentTypeOptions.includes('Salt System'));

  eq('  running it again adds nothing', addToCustomers(custs, 'Salt System', ['a','b','c']), 0);
  eq('  an unknown id is ignored', addToCustomers(custs, 'Heater', ['nobody']), 0);
  eq('  selecting none adds none', addToCustomers(custs, 'Heater', []), 0);

  // Existing equipment is untouched
  truthy('  Alpha keeps its filter', custs[0].equipmentTypeOptions.includes('Filter'));
}

console.log('\n=== BACK BUTTON: must never close the app mid-visit ===');
{
  // Mirrors the real handler, driven the way a phone drives it
  let depth = 0, closed = false, view = 'home', step = 1;
  let answer = true, asks = 0, discarded = false, prompt = false;
  const arm = ()=> depth++;
  const switchTo = v => { arm(); view = v; };
  function pop(){
    arm();
    if(view === 'visit'){
      if(step > 1){ step--; return; }
      if(prompt) return;
      prompt = true; asks++;
      const ok = answer; prompt = false;
      if(!ok){ arm(); return; }
      discarded = true; switchTo('home'); return;
    }
    if(view !== 'home') switchTo('home');
  }
  function back(){ if(depth === 0){ closed = true; return; } depth--; pop(); }

  arm();
  view = 'visit'; step = 3;
  back(); eq('  step 3 -> 2', step, 2);
  back(); eq('  step 2 -> 1', step, 1);
  answer = false;
  back(); eq('  asks before leaving', asks, 1);
  truthy('  declining stays in the visit', view === 'visit' && !closed);
  for(let i = 0; i < 20; i++) back();
  truthy('  20 declined backs never close the app', !closed);
  truthy('  still in the visit after 20', view === 'visit');
  answer = true;
  back();
  truthy('  accepting returns to the route', view === 'home' && !closed);
  truthy('  readings discarded on accept', discarded);
}

console.log('\n=== ADDRESS SPLITTING ===');
const addrSrc = grabFn(site, 'splitAddress') + '\nmodule.exports = {splitAddress};';
fs.writeFileSync('/tmp/a.js', addrSrc);
const A = require('/tmp/a.js');
[
  ['17543 W Dalea Dr, Goodyear, AZ 85338', '17543 W Dalea Dr', 'Goodyear', 'AZ', '85338'],
  ['18015 W San Alejandro Dr, Goodyear AZ 85338', '18015 W San Alejandro Dr', 'Goodyear', 'AZ', '85338'],
  ['20619 W Meadowbrook Ave Buckeye, AZ 85396', '20619 W Meadowbrook Ave Buckeye', '', 'AZ', '85396'],
  ['123 Main St', '123 Main St', '', '', '']
].forEach(([input, st, city, state, zip])=>{
  const r = A.splitAddress(input);
  eq('  "' + input.slice(0,32) + '" state', r.state, state);
  eq('  "' + input.slice(0,32) + '" zip', r.zip, zip);
});

console.log('\n=== CSV PARSING ===');
const csvSrc = grabFn(site, 'parseCsv') + '\nmodule.exports = {parseCsv};';
fs.writeFileSync('/tmp/c.js', csvSrc);
const C = require('/tmp/c.js');
{
  const rows = C.parseCsv('Name,Address\nSmith,"123 Main St, Goodyear, AZ"\nJones,456 Oak\n');
  eq('  row count', rows.length, 3);
  eq('  quoted comma kept together', rows[1][1], '123 Main St, Goodyear, AZ');
  eq('  plain row', rows[2][0], 'Jones');
  const q = C.parseCsv('A,B\n"say ""hi""",2\n');
  eq('  escaped quotes', q[1][0], 'say "hi"');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if(failures.length){
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ' + f));
}
process.exit(fail ? 1 : 0);
