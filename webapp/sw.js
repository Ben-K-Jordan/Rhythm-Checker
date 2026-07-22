// Offline-first service worker: after one visit, the whole app works with no
// network — backstage wifi is not a dependency.
//
// Strategy: network-first with cache fallback. Online users pick up new
// deploys on the next load without anyone remembering to bump a version;
// offline (the backstage case) everything serves from cache.

const CACHE = 'rhythm-checker-v26';
const ASSETS = [
  '.',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/audio.js',
  'js/calibrate.js',
  'js/dsp.js',
  'js/feel.js',
  'js/home.js',
  'js/theme.js',
  'js/history.js',
  'js/meter.js',
  'js/metronome.js',
  'js/show.js',
  'js/showflow.js',
  'js/rudiments.js',
  'js/rudiment-data.js',
  'js/notation.js',
  'js/store.js',
  'js/timing.js',
  'js/tuner.js',
  'worklet/capture.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-512.png',
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
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { // never pin a transient 404/500 as the permanent answer
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
