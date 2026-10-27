// Offline-first service worker: after one visit, the whole app works with no
// network — backstage wifi is not a dependency.
//
// Strategy: network-first with cache fallback. Online users pick up new
// deploys on the next load without anyone remembering to bump a version;
// offline (the backstage case) everything serves from cache.

const CACHE = 'rhythm-checker-v38';
const ASSETS = [
  '.',
  'index.html',
  'css/base.css',
  'css/shell.css',
  'css/home.css',
  'css/tuner.css',
  'css/rudiments.css',
  'css/timing.css',
  'css/calibrate.css',
  'css/history.css',
  'js/app.js',
  'js/audio.js',
  'js/calibrate.js',
  'js/dsp.js',
  'js/feel.js',
  'js/home.js',
  'js/theme.js',
  'js/history.js',
  'js/highway.js',
  'js/meter.js',
  'js/metronome.js',
  'js/rudiments.js',
  'js/rudiment-data.js',
  'js/notation.js',
  'js/store.js',
  'js/timing.js',
  'js/tuner.js',
  'js/ui.js',
  'worklet/capture.js',
  'manifest.webmanifest',
  'icons/icon-32.png',
  'icons/icon-192.png',
  'icons/apple-touch-icon-180.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'fonts/Anton-Regular.ttf',
  'fonts/Oswald-400.ttf',
  'fonts/Oswald-600.ttf',
  'fonts/Oswald-700.ttf',
  'fonts/SpaceMono-400.ttf',
  'fonts/SpaceMono-700.ttf',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  // extensions and other non-http schemes are not ours to answer
  if (e.request.method !== 'GET' || !e.request.url.startsWith('http')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { // never pin a transient 404/500 as the permanent answer
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request, { ignoreSearch: true });
        if (hit) return hit;
        // offline navigation to a URL never cached (e.g. a deep link with a
        // path) still gets the app shell instead of the browser error page
        if (e.request.mode === 'navigate') {
          const shell = await caches.match('index.html');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
