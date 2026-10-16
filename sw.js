/* AniMehList service worker (aml5)
 *
 * What it does
 *   - keeps the page itself (index.html), the manifest and the logos, so the site opens with NO connection
 *   - keeps the libraries and fonts the page loads from CDNs, so that works offline too
 *   - keeps the cover images, so the shelf still has its pictures offline
 * What it never touches: the database and every API (Supabase, AniList, ...). Those always go straight to the network.
 *
 * In the Android app the page and the libraries are bundled inside the app, so there the worker only keeps cover images
 * (it deliberately ignores the app's own files, which are served locally and are always there).
 *
 * Emergency off switch: open the site with ?nosw in the address bar (it removes the worker and its caches).
 */
"use strict";

const VERSION = "aml5-1";
const SHELL = "aml-shell-" + VERSION; // the page, manifest, logos
const LIBS = "aml-libs-" + VERSION; // CDN libraries + fonts
const COVERS = "aml-covers-v1"; // cover images (survive app updates)
const KEEP = new Set([SHELL, LIBS, COVERS]);

const ROOT = new URL("./", self.registration.scope).href;
const PRECACHE = ["./", "manifest.webmanifest", "assets/logo.png", "assets/wide_logo.png"];
const LIB_HOSTS = new Set(["esm.sh", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com", "unpkg.com"]);
const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(self.location.hostname); // the Android app / a dev server
const NAV_TIMEOUT = 4000; // ms to wait for the network before showing the saved page
const MAX_COVERS = 1500; // oldest pictures go first
const PARALLEL = 4; // background downloads at a time
let switchedOff = false; // set by the page's ?nosw switch: from then on this worker does nothing at all

async function wipeCaches() {
  for (const k of await caches.keys()) if (k.startsWith("aml-")) await caches.delete(k);
}

// ---------------------------------------------------------------- install / activate
self.addEventListener("install", (event) => {
  self.skipWaiting();
  if (LOCAL) return;
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      // one missing file must not stop the worker from installing
      Promise.allSettled(PRECACHE.map((u) => cache.add(new Request(new URL(u, ROOT).href, { cache: "reload" }))))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) {
        if (k.startsWith("aml-") && !KEEP.has(k)) await caches.delete(k);
      }
      await self.clients.claim();
    })()
  );
});

// ---------------------------------------------------------------- fetch
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (switchedOff || req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  if (url.origin === self.location.origin) {
    if (LOCAL) return; // the app's own files are bundled: leave them to the app
    event.respondWith(req.mode === "navigate" ? onNavigate(event) : onSameOrigin(event));
    return;
  }
  if (LIB_HOSTS.has(url.hostname)) {
    event.respondWith(onLib(event));
    return;
  }
  if (req.destination === "image") {
    event.respondWith(onCover(event));
    return;
  }
  // everything else (database, APIs, websockets): untouched
});

// The page: newest copy from the network (it is only a few hundred KB), the saved copy when there is no network or it is slow.
async function onNavigate(event) {
  const cache = await caches.open(SHELL);
  let saving = Promise.resolve();
  const fresh = fetch(event.request, { cache: "no-cache" }).then((res) => {
    if (res && res.ok && res.type === "basic") {
      const p = new URL(event.request.url).pathname;
      if (p === new URL(ROOT).pathname || p.endsWith("/index.html")) saving = cache.put(ROOT, res.clone()).catch(() => {});
    }
    return res;
  });
  event.waitUntil(fresh.then(() => saving, () => {}));
  const saved = await cache.match(ROOT, { ignoreSearch: true });
  if (!saved) return fresh; // first visit: nothing to fall back on
  const winner = await Promise.race([fresh.catch(() => null), new Promise((r) => setTimeout(() => r(null), NAV_TIMEOUT))]);
  if (winner && (winner.ok || winner.type === "opaqueredirect" || winner.status < 500)) return winner;
  return saved;
}

// The site's own small files (manifest, logos): network first, saved copy as the fallback.
async function onSameOrigin(event) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(event.request);
    if (res && res.ok && res.type === "basic") event.waitUntil(cache.put(event.request, res.clone()).catch(() => {}));
    return res;
  } catch (err) {
    const hit = await cache.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

// CDN libraries and fonts: saved copy at once, refreshed in the background.
// A plain <script>/<link> asks without CORS and would get an opaque (unreadable) copy; these CDNs all allow CORS, so ask
// that way first: the copy is then readable (a stylesheet can be searched for its font files) and takes little space.
async function fetchLib(request) {
  if (request.mode === "no-cors") {
    try {
      return await fetch(request.url, { mode: "cors", credentials: "omit" });
    } catch (e) {
      // fall through to the page's own kind of request
    }
  }
  return fetch(request);
}
async function onLib(event) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(event.request, { ignoreVary: true });
  const update = fetchLib(event.request).then((res) => {
    if (res && (res.ok || res.type === "opaque")) event.waitUntil(cache.put(event.request, res.clone()).catch(() => {}));
    return res;
  });
  if (hit) {
    event.waitUntil(update.catch(() => {}));
    return hit;
  }
  return update;
}

// Cover pictures: saved copy first. When a picture has to be fetched, ask for it WITH cors where the host allows it
// (a normal, small cache entry). Hosts without CORS fall back to an opaque copy, which the page can still show.
const corsHosts = new Map(); // host -> true (readable) | false (not readable)
let puts = 0;
async function fetchCover(url) {
  const host = new URL(url).hostname;
  if (corsHosts.get(host) !== false) {
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit" });
      corsHosts.set(host, true); // the host answered with CORS headers (even if it answered 404)
      return res;
    } catch (e) {
      // offline, or the host does not send CORS headers: the next try tells which
    }
  }
  try {
    const res = await fetch(new Request(url, { mode: "no-cors", credentials: "omit" }));
    if (corsHosts.get(host) === undefined) corsHosts.set(host, false);
    return res;
  } catch (e) {
    return null; // really offline
  }
}
async function onCover(event) {
  const cache = await caches.open(COVERS);
  const hit = await cache.match(event.request.url, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetchCover(event.request.url);
  if (!res) return Response.error();
  if (res.ok || res.type === "opaque") event.waitUntil(cache.put(event.request.url, res.clone()).then(() => (++puts % 25 === 0 ? trim(cache, MAX_COVERS) : null)).catch(() => {}));
  return res;
}

// ---------------------------------------------------------------- messages from the page
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "nosw") {
    // emergency off switch (the page was opened with ?nosw): stop caching, drop everything saved, remove this worker
    switchedOff = true;
    event.waitUntil(wipeCaches().then(() => self.registration.unregister()).catch(() => {}));
  } else if (switchedOff) return;
  else if (msg.type === "cache-covers" && Array.isArray(msg.urls)) event.waitUntil(warmCovers(msg.urls).catch(() => {}));
  else if (msg.type === "cache-libs" && Array.isArray(msg.urls)) event.waitUntil(warmLibs(msg.urls).catch(() => {}));
  else if (msg.type === "ping" && event.source) event.source.postMessage({ type: "pong", version: VERSION, local: LOCAL });
});

async function pool(items, worker, n) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n || PARALLEL, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          await worker(item);
        } catch (e) {}
      }
    })
  );
}
const httpsUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" ? x : null;
  } catch (e) {
    return null;
  }
};

// Every cover on the shelf, fetched quietly in the background (only the ones that are not saved yet)
async function warmCovers(urls) {
  const cache = await caches.open(COVERS);
  const todo = [];
  for (const u of new Set(urls.filter(httpsUrl))) if (!(await cache.match(u, { ignoreVary: true }))) todo.push(u);
  await pool(todo, async (u) => {
    const res = await fetchCover(u);
    if (res && (res.ok || res.type === "opaque")) await cache.put(u, res);
  });
  await trim(cache, MAX_COVERS);
}

// The libraries / fonts the page said it loaded, plus the font files their stylesheets point at (browsers do not report
// those to the page, and they are only requested once the first icon / letter needs them).
const isCss = (u, res) => /\.css(\?|$)/i.test(u) || /text\/css/i.test((res && res.headers && res.headers.get("content-type")) || "") || new URL(u).hostname === "fonts.googleapis.com";
function fontFiles(css, base) {
  const out = [];
  // Google marks every block with its alphabet (/* latin */ ...): only latin + latin-ext are kept. One format (woff2) is enough.
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1] && !/^latin(-ext)?$/.test(m[1])) continue;
    for (const u of m[2].matchAll(/url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g)) {
      if (!/\.woff2(\?|#|$)/i.test(u[1])) continue;
      try {
        out.push(new URL(u[1], base).href);
      } catch (e) {}
    }
  }
  return out;
}
async function warmLibs(urls) {
  const cache = await caches.open(LIBS);
  const isLib = (u) => {
    const x = httpsUrl(u);
    return !!x && LIB_HOSTS.has(x.hostname);
  };
  const found = [];
  const keep = async (u) => {
    let res = await cache.match(u, { ignoreVary: true });
    if (!res || res.type === "opaque") {
      res = await fetch(u, { mode: "cors", credentials: "omit" });
      if (!res.ok) return;
      await cache.put(u, res.clone());
    }
    if (res.type !== "opaque" && isCss(u, res)) {
      for (const f of fontFiles(await res.clone().text(), u)) if (isLib(f)) found.push(f);
    }
  };
  const first = [...new Set(urls)].filter(isLib);
  await pool(first, keep);
  await pool([...new Set(found)].filter((u) => !first.includes(u)), keep);
}

async function trim(cache, max) {
  const keys = await cache.keys(); // oldest first
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
