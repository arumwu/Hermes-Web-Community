const CACHE = 'hermes-web-static-v3';
const ASSETS = ['/mobile/', '/mobile/index.html', '/mobile/styles.css', '/mobile/app.js', '/mobile/manifest.webmanifest',
  '/mobile/assistant.svg', '/mobile/assistant.svg', '/mobile/assistant.svg', '/mobile/assistant.svg',
  '/mobile/assistant.svg', '/mobile/file.svg', '/mobile/nav-home.svg', '/mobile/nav-history.svg',
  '/mobile/nav-tasks.svg', '/mobile/nav-files.svg', '/mobile/nav-profile.svg', '/mobile/nav-search.svg', '/mobile/nav-settings.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(Promise.all([caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))), self.clients.claim()])));
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode === 'navigate') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.match(request, { ignoreSearch: true }).then(hit => hit || fetch(request)));
});
