/* global precache, caches, fetch, event */
// ═══════════════════════════════════════════════════════
//  Service Worker — UMT Калькулятор PWA
//  Стратегии: Cache-First (статика), Network-First (API GET)
//  POST/DELETE обрабатываются на уровне app.js (customFetch)
// ═══════════════════════════════════════════════════════

const CACHE_NAME = 'umt-v1';
const STATIC_CACHE = 'umt-static-v1';

// ── Assets to precache (first-load shell) ──────────────
const PRECACHE_URLS = [
    '/',
    '/static/js/app.js',
    '/static/css/style.css',
    '/manifest.json',
    '/sw.js',
    '/static/icons/icon-192x192.png',
    '/static/icons/icon-512x512.png',
];

// ── install ────────────────────────────────────────────
self.addEventListener('install', event => {
    console.log('[SW] install');
    event.waitUntil(
        caches.open(STATIC_CACHE).then(cache => cache.addAll(PRECACHE_URLS))
    );
    self.skipWaiting(); // activate immediately on update
});

// ── activate ───────────────────────────────────────────
self.addEventListener('activate', event => {
    console.log('[SW] activate');
    event.waitUntil(
        caches.keys().then(names =>
            Promise.all(
                names.filter(n => n !== STATIC_CACHE && n !== CACHE_NAME)
                     .map(n => caches.delete(n))
            )
        )
    );
    self.clients.claim(); // claim open tabs immediately
});

// ── fetch ──────────────────────────────────────────────
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // ── 1. API GET  →  Network-First с fallback в кэш ──
    if (url.pathname.startsWith('/api/')) {
        if (event.request.method !== 'GET') {
            // POST/DELETE проходят напрямую (customFetch справится)
            event.respondWith(fetch(event.request));
            return;
        }
        event.respondWith(networkFirstApi(event.request));
        return;
    }

    // ── 2. Static assets  →  Cache-First ──
    event.respondWith(cacheFirstStatic(event.request));
});

// ── Strategy: Network-First (API) ──────────────────────
async function networkFirstApi(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const fresh = await fetch(request);
        if (fresh.ok) {
            // Копируем ответ в кэш для следующего офлайн-запроса
            cache.put(request, fresh.clone());
        }
        return fresh;
    } catch {
        // Нет сети → отдаём из кэша
        const cached = await cache.match(request);
        if (cached) {
            return cached;
        }
        // Ничего нет → fallback
        return new Response(JSON.stringify({ offline: true }), {
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

// ── Strategy: Cache-First (static) ─────────────────────
async function cacheFirstStatic(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
        const fresh = await fetch(request);
        if (fresh.ok && fresh.headers.get('content-length')) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, fresh.clone());
        }
        return fresh;
    } catch {
        // Полностью офлайн — отдать кэш-оболочку (index.html)
        return caches.match('/');
    }
}

// ── Background sync (если браузер поддерживает) ────────
self.addEventListener('sync', event => {
    if (event.tag === 'sync-offline-requests') {
        event.waitUntil(syncOfflineQueue());
    }
});

async function syncOfflineQueue() {
    // Считываем очередь из localStorage через client
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => {
        client.postMessage({ type: 'SYNC_OFFLINE_QUEUE' });
    });
}
