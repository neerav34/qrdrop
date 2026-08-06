/* eslint-disable no-undef */
/**
 * QRDrop service worker.
 *
 * Its job is narrow on purpose: make the UI open instantly and survive a dead
 * connection, without ever serving a stale build.
 *
 * - Navigations are **network-first**. A cached HTML shell that references chunk
 *   hashes from a previous deploy is the classic way a PWA bricks itself, so the
 *   network always wins when it can and the cache is only a fallback for offline.
 * - `/_next/static/*` is **cache-first**, because those filenames contain a
 *   content hash and can never change meaning.
 * - Cross-origin requests are left completely alone. The signaling server lives
 *   on another origin and its traffic must never be touched or cached.
 *
 * There is deliberately no `skipWaiting()`: a new worker taking over mid-session
 * could hand a running page assets from a different build, and a transfer in
 * flight is exactly the wrong moment for that. Updates apply on the next visit.
 */

const VERSION = "v1";
const SHELL_CACHE = `qrdrop-shell-${VERSION}`;
const ASSET_CACHE = `qrdrop-assets-${VERSION}`;

// The UI is useful offline even though transfers are not — you can still open
// the app, see it, and be told what's wrong.
const SHELL = ["/", "/send", "/receive", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Individually, so one 404 can't fail the whole install.
      Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {}),
        ),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("qrdrop-") && !keep.has(n)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isImmutableAsset(url) {
  return url.pathname.startsWith("/_next/static/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never interfere with the signaling server or any other origin.
  if (url.origin !== self.location.origin) return;

  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSET_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  const isNavigation =
    req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        } catch {
          // Offline: the exact page, else any shell page, else the home page.
          return (
            (await caches.match(req)) ||
            (await caches.match("/send")) ||
            (await caches.match("/")) ||
            new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } })
          );
        }
      })(),
    );
    return;
  }

  // Everything else same-origin: network, falling back to whatever we have.
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
