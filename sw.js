/* Service worker: офлайн-оболочка приложения */
const CACHE_NAME = 'obezd-ab29312a1e';

function lod1Paths(dir) {
  const paths = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      paths.push('./' + dir + '/lod1/' + row + '_' + col + '.webp');
    }
  }
  return paths;
}

const APP_SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/cities.json',
  './js/stores.json',
  './js/stores-bryansk.json',
  './js/stores-zheleznogorsk.json',
  './js/routes-seed.json',
  './map/oryol-base.webp',
  './map/labels.json',
  './map/layers.json',
  ...lod1Paths('map'),
  './map/bryansk/base.webp',
  './map/bryansk/labels.json',
  './map/bryansk/layers.json',
  ...lod1Paths('map/bryansk'),
  './map/zheleznogorsk/base.webp',
  './map/zheleznogorsk/labels.json',
  './map/zheleznogorsk/layers.json',
  ...lod1Paths('map/zheleznogorsk'),
  './manifest.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/logo-tile-192.png',
  './icons/icon.svg',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet-markercluster/leaflet.markercluster.js',
  './vendor/leaflet-markercluster/MarkerCluster.css'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(APP_SHELL.map((url) =>
        fetch(url, { cache: 'reload' })
          .then((response) => {
            if (response && response.ok) return cache.put(url, response);
            return null;
          })
          .catch(() => null)
      ))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => key === CACHE_NAME ? null : caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (error) { return; }

  // Карты, Overpass, Nominatim и Firebase не кешируем.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response || !response.ok) {
            return caches.match('./index.html').then((cached) => cached || caches.match('./'));
          }
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      // Страницы подключают файлы с ?v=2.9 для сброса кеша. В офлайн-оболочке
      // они лежат без параметра, поэтому сначала ищем тот же путь без query.
      let normalized = null;
      try {
        const url = new URL(request.url);
        if (url.search) {
          url.search = '';
          normalized = url.href;
        }
      } catch (error) { /* ignore */ }
      if (normalized) {
        return caches.match(normalized).then((fallback) => {
          if (fallback) return fallback;
          return fetchAndCache(request);
        });
      }
      return fetchAndCache(request);
    })
  );
});

function fetchAndCache(request) {
  return fetch(request).then((response) => {
    if (response && response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  });
}
