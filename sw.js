// Sadece bu sitenin kendi dosyaları önbelleğe alınır (çevrimdışı açılış için).
// flespi, harita karoları ve diğer dış adresler hiç dokunulmadan ağdan gelir.
const CACHE = "arac-takip-v4";
const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon.svg",
  "vendor/leaflet.css", "vendor/leaflet.js", "vendor/mqtt.min.js", "vendor/qrcode.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Önce ağ (güncel sürüm), ağ yoksa önbellek
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // no-cache: tarayıcının HTTP önbelleğini atla, sunucudan doğrula (eski sürüm karışmasın)
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});
