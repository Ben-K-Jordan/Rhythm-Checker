// Offline-first service worker: after one visit, the whole app works with no
// network — backstage wifi is not a dependency.

const CACHE = 'rhythm-checker-v3';
const ASSETS = [
  '.',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/audio.js',
  'js/calibrate.js',
  'js/dsp.js',
  'js/groove.js',
  'js/history.js',
  'js/meter.js',
  'js/metronome.js',
  'js/preshow.js',
  'js/rudiments.js',
  'js/store.js',
  'js/timing.js',
  'js/tuner.js',
  'worklet/capture.js',
  'manifest.webmanifest',
  'icons/icon.svg',
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
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) => hit
        || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        }),
    ),
  );
});
