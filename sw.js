const CACHE_NAME = 'kettei-karuta-v2';
const urlsToCache = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './game.js',
    './cpu.js',
    './renderer.js',
    './audio.js',
    './storage.js',
    './data/compounds.json',
    './data/clues.json',
    'https://cdn.jsdelivr.net/npm/smiles-drawer@2.1.7/dist/smiles-drawer.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
            .catch(err => {
                console.log('Cache install failed:', err);
                // キャッシュ失敗してもインストールは続行
                return self.skipWaiting();
            })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(names => 
            Promise.all(
                names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
            .catch(() => fetch(event.request))
    );
});

