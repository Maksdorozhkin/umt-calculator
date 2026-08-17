// Инкрементируйте версию при КАЖДОМ изменении кода (v1 -> v2 -> v3)
const CACHE_NAME = "umt-v3.20";
const STATIC_CACHE = "umt-static-v3.20";

// ── Assets to precache (ВНИМАНИЕ: '/sw.js' отсюда УДАЛЕН!) ──
const PRECACHE_URLS = [
  "/",
  "/static/js/app.js",
  "/static/css/style.css",
  "/manifest.json",
  "/static/icons/icon-192x192.png",
  "/static/icons/icon-512x512.png",
];

// ── install ────────────────────────────────────────────
self.addEventListener("install", (event) => {
  console.log("[SW] install");
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting(); // Принудительно активируем новый SW сразу
});

// ── activate ───────────────────────────────────────────
self.addEventListener("activate", (event) => {
  console.log("[SW] activate");
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n !== STATIC_CACHE && n !== CACHE_NAME)
          .map((n) => {
            console.log("[SW] Deleting old cache:", n);
            return caches.delete(n);
          }),
      ),
    ),
  );
  self.clients.claim(); // Перехватываем управление вкладками немедленно
});

// ── fetch ──────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Игнорируем POST, DELETE и прочие запросы
  if (event.request.method !== "GET") {
    event.respondWith(fetch(event.request));
    return;
  }

  // ── 1. API GET  →  Network-First ──
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirstApi(event.request));
    return;
  }

  // ── 2. Static assets  →  Stale-While-Revalidate (Надежнее для обновлений) ──
  event.respondWith(staleWhileRevalidateStatic(event.request));
});

// ── Strategy: Network-First (API) ──────────────────────
async function networkFirstApi(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ offline: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── Strategy: Stale-While-Revalidate (Идеально для калькулятора) ──
// Сначала мгновенно выдает старую версию из кэша, но в ФОНЕ скачивает новую.
// При следующем открытии приложения пользователь гарантированно увидит обновления.
async function staleWhileRevalidateStatic(request) {
  const cached = await caches.match(request);

  // 1. Есть кэш → отдаём сразу, в фоне обновляем (SWR)
  if (cached) {
    void fetch(request)
      .then((fresh) => {
        if (fresh.ok) {
          return caches
            .open(STATIC_CACHE)
            .then((cache) => cache.put(request, fresh.clone()));
        }
      })
      .catch(() => {}); // фоновая ошибка не важна
    return cached;
  }

  // 2. Нет кэша → пробуем сеть
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      const cache = await caches.open(STATIC_CACHE);
      await cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    // 3. Офлайн и нет кэша → fallback вместо null
    if (request.mode === "navigate") {
      // Навигация (открытие страницы) → отдаём кэшированный "/"
      return (
        (await caches.match("/")) ||
        new Response("Offline", { status: 503, statusText: "Offline" })
      );
    }
    // Ассет (js/css/иконка) → честная 503, браузер просто не загрузит файл
    return new Response("Offline", { status: 503, statusText: "Offline" });
  }
}

// ── Background sync ────────────────────────────────────
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-offline-requests") {
    event.waitUntil(syncOfflineQueue());
  }
});

async function syncOfflineQueue() {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((client) => {
    client.postMessage({ type: "SYNC_OFFLINE_QUEUE" });
  });
}
