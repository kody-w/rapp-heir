const VERSION = "rapp-heir-shell-v1";
const BASE = "/rapp-heir/";
const SHELL = [
  BASE,
  `${BASE}manifest.webmanifest`,
  `${BASE}THIRD_PARTY_LICENSES.txt`,
  `${BASE}icons/apple-touch-icon.png`,
  `${BASE}icons/icon-192.png`,
  `${BASE}icons/icon-512.png`,
  `${BASE}agents/manifest.json`,
  `${BASE}agents/quest_master_agent.py`,
  `${BASE}agents/quest_turn_agent.py`,
  `${BASE}agents/party_memory_agent.py`,
  `${BASE}agents/quest_safety_agent.py`
];

async function precacheShell() {
  const cache = await caches.open(VERSION);
  await cache.addAll(SHELL);
  const indexResponse = await cache.match(BASE);
  if (indexResponse) {
    const html = await indexResponse.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => new URL(match[1], self.location.origin).pathname)
      .filter((path) => path.startsWith(`${BASE}assets/`));
    await cache.addAll([...new Set(assets)]);
  }
  await self.skipWaiting();
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("rapp-heir-") && key !== VERSION)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(VERSION).then((cache) => cache.put(BASE, copy));
          return response;
        })
        .catch(() => caches.match(BASE))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
