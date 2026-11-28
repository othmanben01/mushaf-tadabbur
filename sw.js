/* مصحف التدبر — offline cache.
   Pages: network first (updates arrive at once), cache when offline.
   Quran text, tafsir, fonts: cache first, refreshed in the background.
   Verses audio: cache first, the 250 most recent kept. */
const V = "v3", SHELL = "shell-" + V, DATA = "data-" + V, AUDIO = "audio-" + V, MAX_AUDIO = 250;
self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then(c => c.addAll(["./", "audio-engine.js"]).catch(() => {}))) });
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (![SHELL, DATA, AUDIO].includes(k)) await caches.delete(k);
  await self.clients.claim() })()));
async function trim(name, max) { const c = await caches.open(name), keys = await c.keys(); for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]) }
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  const p = url.pathname;
  if (req.mode === "navigate") {
    e.respondWith((async () => { try { const r = await fetch(req); if (r.ok) (await caches.open(SHELL)).put("./", r.clone()); return r }
      catch (err) { return (await caches.match("./")) || Response.error() } })()); return }
  if (p.endsWith("/audio-engine.js") || p === "/audio-engine.js") {
    e.respondWith((async () => { try { const r = await fetch(req); if (r.ok) (await caches.open(SHELL)).put(req, r.clone()); return r }
      catch (err) { return (await caches.match(req)) || Response.error() } })()); return }
  if (p.startsWith("/audio/")) { if (req.headers.has("range")) return; /* media element streaming: leave it to the network */
    e.respondWith((async () => { const c = await caches.open(AUDIO), hit = await c.match(req); if (hit) return hit;
      const r = await fetch(req); if (r.ok && r.status === 200) { c.put(req, r.clone()).then(() => trim(AUDIO, MAX_AUDIO)) } return r })()); return }
  if (/^\/(s|tm|ts|tk|fonts|m1|qf)\//.test(p) || p === "/quran.json") {
    e.respondWith((async () => { const c = await caches.open(DATA), hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit } return (await net) || Response.error() })()) }
});
