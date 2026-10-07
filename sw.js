// AniMehList service worker: lets the website AND the app open without a connection.
// App shell + libraries + fonts are kept after the first online visit; cover images are kept as you browse.
const SHELL = "aml-shell-v1", IMGS = "aml-covers-v1", MAX_IMGS = 600;
const LIBS = ["esm.sh", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.add("./")).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== IMGS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const okRes = (r) => r && (r.ok || r.type === "opaque");

async function page(req) {
  const c = await caches.open(SHELL), u = new URL(req.url);
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000); // a stalled connection counts as offline
    const res = await fetch(req, { signal: ctl.signal });
    clearTimeout(t);
    if (res.ok) { c.put(u.origin + u.pathname, res.clone()); c.put("./", res.clone()); }
    return res;
  } catch {
    return (await c.match(u.origin + u.pathname)) || (await c.match("./")) || (await c.match("index.html")) || Response.error();
  }
}
async function fresh(req) { // answer from cache instantly, refresh it in the background
  const c = await caches.open(SHELL), hit = await c.match(req);
  const net = fetch(req).then((res) => { if (okRes(res)) c.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}
async function cover(req) {
  const c = await caches.open(IMGS), hit = await c.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (okRes(res)) {
      await c.put(req, res.clone());
      const ks = await c.keys();
      if (ks.length > MAX_IMGS) await Promise.all(ks.slice(0, ks.length - MAX_IMGS).map((k) => c.delete(k)));
    }
    return res;
  } catch { return Response.error(); }
}

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const u = new URL(r.url);
  if (u.hostname.endsWith("supabase.co")) return; // API, auth and realtime always go straight to the network
  if (r.mode === "navigate") return e.respondWith(page(r));
  if (r.destination === "image") return e.respondWith(cover(r));
  if (u.origin === self.location.origin || LIBS.includes(u.hostname)) e.respondWith(fresh(r));
});
