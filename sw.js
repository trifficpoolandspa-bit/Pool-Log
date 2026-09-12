// PoolLog offline cache.
//
// The app has to open with no signal — technicians work in back yards with bad
// coverage, and a demo should never fail because a hotspot dropped. This keeps
// a copy of every page so the app loads from the device, then quietly refreshes
// it whenever there is a connection.
//
// Bump the version to force every device to take a fresh copy.
const CACHE_NAME = 'poollog-cache-v6';

const PRECACHE_URLS = [
  './',
  './index.html',
  './technician-app.html',
  './admin-readings-app.html',
  './customer-intake.html',
  './manifest.json',
  './icon.svg'
];

// Cached one at a time rather than with addAll, which is all-or-nothing: one
// missing file used to mean nothing at all got cached, and the app silently
// stayed online-only.
async function precache(){
  const cache = await caches.open(CACHE_NAME);
  const results = await Promise.allSettled(
    PRECACHE_URLS.map(async (url)=>{
      const res = await fetch(url, {cache: 'reload'});
      if(!res || !res.ok) throw new Error('skipped ' + url);
      await cache.put(url, res);
    })
  );
  const failed = results.filter(r => r.status === 'rejected').length;
  if(failed) console.warn('[PoolLog] ' + failed + ' file(s) could not be cached');
}

self.addEventListener('install', (event)=>{
  // skipWaiting so a device stuck on the previous cache-first worker takes this
  // one immediately rather than on some later visit.
  event.waitUntil(precache().then(()=> self.skipWaiting()));
});

self.addEventListener('activate', (event)=>{
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(()=> self.clients.claim())
      // Take over open tabs and reload them, so the technician is not left
      // looking at the old app until they close and reopen it.
      .then(()=> self.clients.matchAll({type: 'window'}))
      .then(clients => clients.forEach(c => { try{ c.navigate(c.url); }catch(e){} }))
  );
});

// Find a cached copy, ignoring anything after the ? — otherwise opening
// technician-app.html?dev=1 misses the cache and fails offline.
async function findCached(request){
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(request))
      || (await cache.match(request, {ignoreSearch: true}))
      || null;
}

self.addEventListener('fetch', (event)=>{
  const request = event.request;
  if(request.method !== 'GET') return;

  const url = new URL(request.url);

  // Anything on another origin — fonts, the email library — is left to the
  // browser. Those must never stop a page loading.
  if(url.origin !== self.location.origin) return;

  // Opening a page: try the network so an update is picked up, but fall back to
  // the cached copy, and then to the app itself, rather than a browser error.
  if(request.mode === 'navigate'){
    event.respondWith((async ()=>{
      try{
        const fresh = await fetch(request);
        if(fresh && fresh.ok){
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, fresh.clone());
          return fresh;
        }
        throw new Error('bad response');
      }catch(e){
        return (await findCached(request))
            || (await caches.match('./technician-app.html', {ignoreSearch: true}))
            || (await caches.match('./index.html', {ignoreSearch: true}))
            || new Response(
                 '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
                 + '<div style="font-family:-apple-system,sans-serif;padding:28px;line-height:1.5;">'
                 + '<h2 style="margin:0 0 8px;">PoolLog is not stored on this device yet</h2>'
                 + '<p style="color:#555;">Open the app once while you have a connection, and it '
                 + 'will work offline from then on.</p></div>',
                 {headers: {'Content-Type': 'text/html'}});
      }
    })());
    return;
  }

  // Everything else: serve from cache at once, refresh in the background.
  event.respondWith((async ()=>{
    const cached = await findCached(request);
    const network = fetch(request).then(async (res)=>{
      if(res && res.ok && res.type === 'basic'){
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, res.clone());
      }
      return res;
    }).catch(()=> cached);
    return cached || network;
  })());
});
