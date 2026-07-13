const VERSION = "rapp-heir-shell-v3";
const BASE = "/rapp-heir/";
const AUTH_ORIGIN = "https://rapp-auth.kwildfeuer.workers.dev";
const NEVER_CACHE_HOSTS = new Set([
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net"
]);
const COPILOT_HOSTS = new Set([
  "api.githubcopilot.com",
  "api.individual.githubcopilot.com",
  "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com",
  "copilot-proxy.githubusercontent.com"
]);
const SHELL = [
  BASE,
  `${BASE}manifest.webmanifest`,
  `${BASE}agent-cell.html`,
  `${BASE}asset-manifest.json`,
  `${BASE}THIRD_PARTY_LICENSES.txt`,
  `${BASE}NOTICE.md`,
  `${BASE}LICENSE`,
  `${BASE}ROADMAP.md`,
  `${BASE}SECURITY.md`,
  `${BASE}PRIVACY.md`,
  `${BASE}PROTOCOL.md`,
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
  const manifestResponse = await cache.match(`${BASE}asset-manifest.json`);
  if (!manifestResponse?.ok) {
    throw new Error("Built asset manifest is unavailable");
  }
  const manifest = await manifestResponse.json();
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.some(
      (path) =>
        typeof path !== "string" ||
        !path.startsWith(`${BASE}assets/`) ||
        !/\.(?:css|js)$/.test(path)
    )
  ) {
    throw new Error("Built asset manifest is invalid");
  }
  await cache.addAll([...new Set(manifest.assets)]);
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
  if (
    url.origin === AUTH_ORIGIN ||
    COPILOT_HOSTS.has(url.hostname) ||
    NEVER_CACHE_HOSTS.has(url.hostname)
  ) {
    return;
  }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

  if (request.mode === "navigate" && url.pathname === BASE) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(VERSION).then((cache) => cache.put(BASE, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(BASE)) || Response.error())
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
