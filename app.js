const DEVICE_ID = 9363738;
const API = "https://flespi.io";
const MQTT_URL = "wss://mqtt.flespi.io:443";
// Booster çıkışı ~11,3 V; bunun altı hücre bitmek üzere demek
const PACK_LOW = 10.5;
const FIELDS = "timestamp,position.latitude,position.longitude,position.speed,position.direction,engine.ignition.status,external.powersource.voltage,vehicle.mileage";
const TOKEN_KEY = "flespiToken";
// index.html'deki ?v=N ile aynı tutulur; sayfanın sol altında görünür
const APP_VERSION = 18;

// Başka bir sitenin içine (iframe) gömülmeyi reddet: GitHub Pages frame-ancestors başlığı gönderemiyor
if (window.top !== window.self) { document.documentElement.hidden = true; throw new Error("framed"); }

const $ = (id) => document.getElementById(id);
$("ver").textContent = "v" + APP_VERSION;
let token = load();
let mqttClient = null;
let points = [];   // [{t, lat, lon, speed}]
let lastTs = 0;
let lastMoveTs = null;  // son "seyirde" mesajı (null: bilinmiyor, 0: son 2 günde yok); park süresi buradan hesaplanır

const map = L.map("map", { zoomControl: false }).setView([39.0, 35.0], 6);
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const esri = (name, opts) => L.tileLayer(ESRI + name + "/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, ...opts });
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const dark = matchMedia("(prefers-color-scheme: dark)");
// Sade: açık temada Esri Light Gray, koyu temada Dark Gray Canvas (anahtarsız; CARTO artık API anahtarı istiyor)
const CANVAS_ATTR = "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS User Community";
const canvas = (tone) => [
  esri("Canvas/World_" + tone + "_Gray_Base", { maxNativeZoom: 16, attribution: CANVAS_ATTR }),
  esri("Canvas/World_" + tone + "_Gray_Reference", { maxNativeZoom: 16 }),
];
const plain = L.layerGroup();
const fillPlain = () => { plain.clearLayers(); canvas(dark.matches ? "Dark" : "Light").forEach(l => plain.addLayer(l)); };
fillPlain();
dark.addEventListener("change", fillPlain);
const baseLayers = {
  "OSM": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: OSM_ATTR }),
  "Sade": plain,
  // OpenTopoMap: eş yükselti eğrili topoğrafik harita; karolar z17'ye kadar, sonrası büyütülür
  "Topo": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, maxNativeZoom: 17, subdomains: "abc",
    attribution: OSM_ATTR + ', SRTM | Stil: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
  }),
  "Hibrit": L.layerGroup([
    esri("World_Imagery", { attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" }),
    esri("Reference/World_Transportation"),
    esri("Reference/World_Boundaries_and_Places"),
  ]),
};
const LAYER_KEY = "mapLayer";
let layerName = "OSM";
try {
  const OLD = { Sokak: "OSM", CARTO: "Sade" };  // eski adlar
  const saved = OLD[localStorage.getItem(LAYER_KEY)] || localStorage.getItem(LAYER_KEY);
  if (baseLayers[saved]) layerName = saved;
} catch {}
function setLayer(name) {
  if (!baseLayers[name]) return;
  if (map.hasLayer(baseLayers[layerName])) map.removeLayer(baseLayers[layerName]);
  layerName = name;
  baseLayers[name].addTo(map);
  setSeg("layerSeg", name);
  try { localStorage.setItem(LAYER_KEY, name); } catch {}
}
setLayer(layerName);
const route = L.polyline([], { color: "#0a84ff", weight: 5, opacity: .85, lineCap: "round", lineJoin: "round" }).addTo(map);
const marker = L.marker([0, 0], { icon: L.divIcon({ className: "",
  html: '<div class="car"><svg viewBox="0 0 24 24"><path d="M12 2l7 19-7-4-7 4z"/></svg></div>', iconSize: [30, 30] }) });
let fitted = false;

// Token: "hatırla" seçiliyse localStorage, değilse sadece bu sekme (sessionStorage)
function load() {
  try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
function save(v, remember) {
  try {
    localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY);
    if (v) (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, v);
  } catch {}
}
const PILL = { live: "Canlı", wait: "Bekleniyor", err: "Hata" };
function status(kind, text) {
  $("pill").className = "pill " + kind;
  $("pillText").textContent = PILL[kind] || "";
  $("msg").textContent = kind === "live" ? "" : (text || "");
}
// Segmented control: seçili düğmeyi işaretler
function setSeg(id, v) {
  for (const b of $(id).querySelectorAll("button")) {
    const on = b.dataset.v === String(v);
    b.classList.toggle("on", on); b.setAttribute("aria-checked", on);
  }
}
const segValue = (id) => $(id).querySelector("button.on").dataset.v;

function toPoint(m) {
  const lat = m["position.latitude"], lon = m["position.longitude"];
  if (typeof lat !== "number" || typeof lon !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const ign = m["engine.ignition.status"];
  return { t: m.timestamp, lat, lon, speed: m["position.speed"] ?? null, dir: m["position.direction"] ?? null,
    ign: typeof ign === "boolean" ? ign : null, volt: m["external.powersource.voltage"] ?? null,
    mil: typeof m["vehicle.mileage"] === "number" ? m["vehicle.mileage"] : null };
}

async function api(path, data) {
  const url = API + path + (data ? "?data=" + encodeURIComponent(JSON.stringify(data)) : "");
  const res = await fetch(url, { headers: { Authorization: "FlespiToken " + token } });
  if (res.status === 401 || res.status === 403) throw new Error("auth");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return (await res.json()).result || [];
}

async function loadHistory() {
  const now = Math.floor(Date.now() / 1000);
  const hours = +segValue("hours");
  let msgs = await api(`/gw/devices/${DEVICE_ID}/messages`,
    { from: now - hours * 3600, to: now, fields: FIELDS, filter: "position.latitude" });
  points = msgs.map(toPoint).filter(Boolean);
  if (!points.length) {
    // Rota penceresinde veri yoksa en azından son bilinen konumu göster
    msgs = await api(`/gw/devices/${DEVICE_ID}/messages`,
      { from: now - 7 * 86400, to: now, fields: FIELDS, filter: "position.latitude" });
    const last = msgs.map(toPoint).filter(Boolean).pop();
    if (last) points = [last];
  }
  drawRoute();
  if (points.length) update(points[points.length - 1]);
  else status("wait", "Son 7 günde konum bulunamadı.");
}

// Kontak bilgisi varsa onu, yoksa hızı esas al
// Cihaz araç aküsüne değil harici pile bağlı: kontak bilgisi güvenilmez, hız da tek başına sürüş sayılır
const isDriving = (p) => p.ign === true || (p.speed || 0) > 3;

// Park süresi için son seyir anını bul (son 2 gün, en yeniden geriye)
async function loadLastMove() {
  const now = Math.floor(Date.now() / 1000);
  const msgs = await api(`/gw/devices/${DEVICE_ID}/messages`,
    { from: now - 2 * 86400, to: now, fields: FIELDS, filter: "position.latitude", reverse: true, count: 2000 });
  const moving = msgs.map(toPoint).filter(Boolean).filter(isDriving);
  lastMoveTs = moving.length ? Math.max(...moving.map(p => p.t)) : 0;
  renderState();
}

function renderState() {
  const p = points[points.length - 1];
  const el = $("state");
  if (!p) { el.className = "state"; $("stateText").textContent = "–"; return; }
  if (isDriving(p) && (p.speed || 0) > 3) { el.className = "state drive"; $("stateText").textContent = "Seyirde"; }
  else if (p.ign === true) { el.className = "state idle"; $("stateText").textContent = "Kontak açık, duruyor"; }
  else {
    el.className = "state park";
    $("stateText").textContent = lastMoveTs ? "Park halinde · " + dur(Date.now() / 1000 - lastMoveTs)
      : lastMoveTs === 0 ? "Park halinde · 2 günden uzun" : "Park halinde";
  }
}

function dur(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d} gün ${h} sa` : h ? `${h} sa ${m} dk` : `${m} dk`;
}

function drawRoute() {
  route.setLatLngs(points.length > 1 ? points.map(p => [p.lat, p.lon]) : []);
}

function update(p) {
  lastTs = p.t;
  marker.setLatLng([p.lat, p.lon]);
  if (!map.hasLayer(marker)) marker.addTo(map);
  $("speed").textContent = p.speed == null ? "–" : Math.round(p.speed);
  $("speed").parentElement.classList.toggle("over", (p.speed || 0) > speedLimit);
  if (typeof p.dir === "number") {
    // CSP inline stil özniteliğine izin vermez; CSSOM ile döndürmek serbest
    const rot = "rotate(" + p.dir + "deg)";
    $("compass").style.transform = rot;
    const icon = marker.getElement() && marker.getElement().querySelector("svg");
    if (icon) icon.style.transform = rot;
  }
  if (isDriving(p)) lastMoveTs = Math.max(lastMoveTs || 0, p.t);
  if (typeof p.volt === "number") {
    // Harici pil + booster: çıkış sabit kalır, PACK_LOW altına düşmesi hücrenin bittiğini gösterir
    setTile("batt", p.volt.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " V",
      p.volt < PACK_LOW ? "bad" : "");
  }
  if (p.mil != null) { deviceMil = p.mil; renderService(); }
  renderAgo();
  renderState();
  if (zones.length) renderZones();
  if (replay) return;  // geçmiş oynatılırken harita canlı konuma kaymasın
  if (!fitted) { map.setView([p.lat, p.lon], 15); fitted = true; }
  else if ($("follow").checked) map.panTo([p.lat, p.lon]);
}

function renderAgo() {
  if (!lastTs) return;
  const s = Math.max(0, Math.floor(Date.now() / 1000 - lastTs));
  $("ago").textContent = s < 60 ? "az önce" : s < 3600 ? Math.floor(s / 60) + " dk önce"
    : s < 86400 ? Math.floor(s / 3600) + " sa önce" : Math.floor(s / 86400) + " gün önce";
  $("ago").title = new Date(lastTs * 1000).toLocaleString("tr-TR");
}
setInterval(() => { renderAgo(); renderState(); }, 15000);

function connectLive() {
  if (mqttClient) mqttClient.end(true);
  mqttClient = mqtt.connect(MQTT_URL, { username: token, password: "", clean: true, reconnectPeriod: 5000 });
  mqttClient.on("connect", () => {
    mqttClient.subscribe(`flespi/message/gw/devices/${DEVICE_ID}`);
    status("live", "Canlı bağlantı açık.");
  });
  mqttClient.on("message", (_topic, payload) => {
    let m; try { m = JSON.parse(payload.toString()); } catch { return; }
    devMessage(m);  // konumsuz mesajlar da cihaz durumunu günceller
    const p = toPoint(m);
    if (!p || p.t < lastTs) return;
    points.push(p);
    if ($("day").value === ymd(new Date())) { dayPoints.push(p); renderZoneLog(); }
    drawRoute();
    update(p);
  });
  mqttClient.on("reconnect", () => status("wait", "Canlı bağlantı yeniden kuruluyor…"));
  mqttClient.on("error", (e) => {
    if (/auth|Not authorized|Bad username/i.test(String(e && e.message))) askToken("Token geçersiz görünüyor.");
    else status("err", "Canlı bağlantı hatası: " + e.message);
  });
}

async function start() {
  status("wait", "Yükleniyor…");
  try {
    await loadHistory();
    loadLastMove().catch(() => {});
    loadDay();
    loadReport();
    loadDevice().catch(() => {}).then(() => loadAlarms()).catch(() => {});
    status("wait", "Canlı bağlantı kuruluyor…");
    connectLive();
  } catch (e) {
    if (e.message === "auth") askToken("Token geçersiz veya yetkisiz.");
    else status("err", "Veri alınamadı: " + e.message);
  }
}

function askToken(note) {
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }
  status("err", note || "");
  $("loginNote").textContent = note || "";
  $("login").style.display = "flex";
  $("tokenInput").focus();
}

$("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  token = $("tokenInput").value.replace(/[^A-Za-z0-9]/g, "");
  if (!token) return;
  save(token, $("remember").checked);
  $("tokenInput").value = "";
  $("login").style.display = "none";
  start();
});
$("logout").addEventListener("click", () => { save(""); token = ""; askToken("Token silindi."); });
$("hours").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b || b.classList.contains("on")) return;
  setSeg("hours", b.dataset.v);
  if (token) loadHistory().catch(err => status("err", err.message));
});
$("layerSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setLayer(b.dataset.v); });
$("zoomIn").addEventListener("click", () => map.zoomIn());
$("zoomOut").addEventListener("click", () => map.zoomOut());
$("fitRoute").addEventListener("click", () => {
  if (points.length > 1) map.fitBounds(route.getBounds(), { padding: [60, 60] });
  else if (points.length) map.setView([points[0].lat, points[0].lon], 15);
});
$("recenter").addEventListener("click", () => {
  if (points.length) { const p = points[points.length - 1]; map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15)); }
});

// ---------- Yolculuklar ----------
// Seçilen günün mesajları çekilir, sayfada yolculuklara bölünür (sunucu veya flespi hesaplayıcısı gerekmez).
// Yolculuk: kontak açık (yoksa hız > 3 km/sa) olan kesintisiz dönem; 3 dk'dan kısa duruşlar aynı yolculuk sayılır.
const STOP_GAP = 180, MIN_TRIP_M = 300;
const tripLayer = L.polyline([], { color: "#ff9f0a", weight: 5, opacity: .9, lineCap: "round", lineJoin: "round" });
const ghost = L.marker([0, 0], { icon: L.divIcon({ className: "", html: '<div class="ghost"></div>', iconSize: [16, 16] }) });
let trips = [], dayPoints = [], replay = null;
const OVER_STYLE = { color: "#ff453a", weight: 6, opacity: .95, lineCap: "round", lineJoin: "round" };
const overLayer = L.layerGroup();
const LIMIT_KEY = "speedLimit";
let speedLimit = 120;
try { const v = +localStorage.getItem(LIMIT_KEY); if (v >= 30 && v <= 250) speedLimit = v; } catch {}  // replay: {trip, t, playing}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (t) => { const d = new Date(t * 1000); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const km = (m) => (m / 1000).toLocaleString("tr-TR", { maximumFractionDigits: 1 }) + " km";

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function splitTrips(pts) {
  const out = [];
  let cur = null, lastActive = 0;
  for (const p of pts) {
    const active = isDriving(p);
    if (cur && (p.t - lastActive > STOP_GAP) ) { out.push(cur); cur = null; }
    if (active) {
      if (!cur) cur = { pts: [] };
      lastActive = p.t;
    }
    if (cur) cur.pts.push(p);
  }
  if (cur) out.push(cur);
  return out.map(tr => {
    // Sondaki park noktalarını at, mesafe ve süreyi hesapla
    let end = tr.pts.length - 1;
    while (end > 0 && !isDriving(tr.pts[end])) end--;
    const ps = tr.pts.slice(0, end + 1);
    let dist = 0, vmax = 0, overN = 0, overS = 0;
    for (let i = 1; i < ps.length; i++) {
      const d = haversine(ps[i - 1], ps[i]);
      if (d < 5000) dist += d;  // GPS sıçramalarını sayma
      vmax = Math.max(vmax, ps[i].speed || 0);
      // Limit aşımı: limitin üstüne her çıkış bir aşım; süre için nokta aralığı en fazla 60 sn sayılır
      const over = (ps[i].speed || 0) > speedLimit, wasOver = (ps[i - 1].speed || 0) > speedLimit;
      if (over && !wasOver) overN++;
      if (over) overS += Math.min(60, ps[i].t - ps[i - 1].t);
    }
    if ((ps[0].speed || 0) > speedLimit) overN++;
    return { pts: ps, t0: ps[0].t, t1: ps[ps.length - 1].t, dist, vmax, overN, overS };
  }).filter(tr => tr.dist >= MIN_TRIP_M && tr.pts.length > 1);
}

async function loadDay() {
  const d = new Date($("day").value + "T00:00:00");
  if (isNaN(d)) return;
  const from = Math.floor(d / 1000), to = from + 86400 - 1;
  $("dayNext").disabled = ymd(d) >= ymd(new Date());
  $("tripList").innerHTML = "<p>Yükleniyor…</p>";
  stopReplay();
  try {
    const msgs = await api(`/gw/devices/${DEVICE_ID}/messages`, { from, to, fields: FIELDS, filter: "position.latitude" });
    dayPoints = msgs.map(toPoint).filter(Boolean);
    trips = splitTrips(dayPoints);
    renderZoneLog();
  } catch (e) {
    trips = [];
    $("tripList").innerHTML = "";
    const p = document.createElement("p"); p.textContent = e.message === "auth" ? "Token yetkisiz." : "Veri alınamadı: " + e.message;
    $("tripList").append(p);
    return;
  }
  $("tripCount").textContent = trips.length;
  $("tripKm").textContent = km(trips.reduce((a, t) => a + t.dist, 0));
  const list = $("tripList"); list.innerHTML = "";
  if (!trips.length) { list.innerHTML = "<p>Bu gün için yolculuk yok.</p>"; return; }
  trips.forEach((tr, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "trip"; b.dataset.i = i;
    b.innerHTML = `<b>${hm(tr.t0)} – ${hm(tr.t1)}</b><b class="r">${km(tr.dist)}</b>` +
      `<span>${dur(tr.t1 - tr.t0)}</span><span class="r">maks ${Math.round(tr.vmax)} km/sa</span>` +
      (tr.overN ? `<span class="over">${tr.overN} limit aşımı · ${tr.overS < 60 ? tr.overS + " sn" : dur(tr.overS)}</span>` : "");
    list.append(b);
  });
}

function selectTrip(i) {
  const tr = trips[i]; if (!tr) return;
  for (const b of $("tripList").children) b.classList.toggle("on", b.dataset.i === String(i));
  $("follow").checked = false;
  route.setStyle({ opacity: .25 });
  tripLayer.setLatLngs(tr.pts.map(p => [p.lat, p.lon])).addTo(map);
  // Limit üstü kısımları kırmızı çiz
  overLayer.clearLayers();
  let seg = [];
  for (const p of tr.pts) {
    if ((p.speed || 0) > speedLimit) seg.push([p.lat, p.lon]);
    else { if (seg.length) { seg.push([p.lat, p.lon]); L.polyline(seg, OVER_STYLE).addTo(overLayer); } seg = []; }
  }
  if (seg.length > 1) L.polyline(seg, OVER_STYLE).addTo(overLayer);
  overLayer.addTo(map);
  // Telefonda pencere haritanın üstünü kapatır; rotayı altta kalan alana sığdır
  const top = narrow.matches ? document.querySelector('.window[data-win="trips"]').getBoundingClientRect().bottom + 20 : 60;
  map.fitBounds(tripLayer.getBounds(), { paddingTopLeft: [40, top], paddingBottomRight: [40, 90] });
  replay = { trip: tr, t: tr.t0, playing: false };
  ghost.addTo(map);
  $("player").hidden = false;
  renderReplay();
}

// t anındaki konumu iki nokta arasında doğrusal hesapla
function posAt(tr, t) {
  const ps = tr.pts;
  let i = 1; while (i < ps.length - 1 && ps[i].t < t) i++;
  const a = ps[i - 1], b = ps[i], f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 1;
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, speed: f < .5 ? a.speed : b.speed };
}

function renderReplay() {
  const { trip: tr, t } = replay, p = posAt(tr, t);
  ghost.setLatLng([p.lat, p.lon]);
  $("scrub").value = Math.round((t - tr.t0) / Math.max(1, tr.t1 - tr.t0) * 1000);
  const d = new Date(t * 1000);
  $("playTime").textContent = d.toLocaleTimeString("tr-TR");
  $("playSpeed").textContent = p.speed == null ? "–" : Math.round(p.speed) + " km/sa";
  $("play").textContent = replay.playing ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", replay.playing ? "Duraklat" : "Oynat");
}

let lastFrame = 0;
function tick(now) {
  if (!replay || !replay.playing) return;
  const dt = lastFrame ? (now - lastFrame) / 1000 : 0; lastFrame = now;
  replay.t = Math.min(replay.trip.t1, replay.t + dt * +segValue("rate"));
  if (replay.t >= replay.trip.t1) replay.playing = false;
  renderReplay();
  if (!map.getBounds().pad(-.1).contains(ghost.getLatLng())) map.panTo(ghost.getLatLng());
  if (replay.playing) requestAnimationFrame(tick);
}

function stopReplay() {
  replay = null;
  tripLayer.remove(); ghost.remove(); overLayer.remove();
  route.setStyle({ opacity: .85 });
  $("player").hidden = true;
  for (const b of $("tripList").querySelectorAll(".trip")) b.classList.remove("on");
}

$("speedLimit").value = speedLimit;
$("speedLimit").addEventListener("change", () => {
  const v = Math.round(+$("speedLimit").value / 10) * 10;
  if (!(v >= 30 && v <= 250)) { $("speedLimit").value = speedLimit; return; }
  speedLimit = v; $("speedLimit").value = v;
  try { localStorage.setItem(LIMIT_KEY, v); } catch {}
  if (token) { loadDay(); loadReport(); }
});
$("day").value = ymd(new Date());
$("day").max = ymd(new Date());
$("day").addEventListener("change", () => { if (token) loadDay(); });
const shiftDay = (n) => { const d = new Date($("day").value + "T12:00:00"); d.setDate(d.getDate() + n); $("day").value = ymd(d); loadDay(); };
$("dayPrev").addEventListener("click", () => shiftDay(-1));
$("dayNext").addEventListener("click", () => shiftDay(1));
$("tripList").addEventListener("click", (e) => { const b = e.target.closest(".trip"); if (b) selectTrip(+b.dataset.i); });
$("play").addEventListener("click", () => {
  if (!replay) return;
  if (!replay.playing && replay.t >= replay.trip.t1) replay.t = replay.trip.t0;
  replay.playing = !replay.playing; lastFrame = 0;
  renderReplay();
  if (replay.playing) requestAnimationFrame(tick);
});
$("scrub").addEventListener("input", () => {
  if (!replay) return;
  replay.t = replay.trip.t0 + (replay.trip.t1 - replay.trip.t0) * $("scrub").value / 1000;
  renderReplay();
});
$("rate").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSeg("rate", b.dataset.v); });
$("backLive").addEventListener("click", () => {
  stopReplay();
  $("follow").checked = true;
  $("recenter").click();
});

// ---------- Bölgeler (geofence) ----------
// Bölgeler sadece bu tarayıcının localStorage'ında durur; repoya veya flespi'ye gitmez.
// Giriş/çıkışlar seçili günün mesajlarından sayfada hesaplanır. Sınırda GPS titremesi için 30 m pay bırakılır.
const ZONE_KEY = "zones", ZONE_HYST = 30;
let zones = [];
try {
  zones = (JSON.parse(localStorage.getItem(ZONE_KEY)) || []).filter(z =>
    z && typeof z.name === "string" && Number.isFinite(z.lat) && Number.isFinite(z.lon) && Number.isFinite(z.r));
} catch {}
const zoneLayer = L.layerGroup().addTo(map);
let picking = false;
const saveZones = () => { try { localStorage.setItem(ZONE_KEY, JSON.stringify(zones)); } catch {} };
const inZone = (z, p) => haversine(z, p) <= z.r;
const rLabel = (r) => r >= 1000 ? r / 1000 + " km" : r + " m";

function renderZones() {
  zoneLayer.clearLayers();
  const list = $("zoneList"); list.innerHTML = "";
  const last = points[points.length - 1];
  zones.forEach((z, i) => {
    L.circle([z.lat, z.lon], { radius: z.r, color: "#0a84ff", weight: 2, dashArray: "6 6", fillOpacity: .08 })
      .bindTooltip(document.createTextNode(z.name), { direction: "top" })  // metin olarak: HTML yorumlanmasın
      .addTo(zoneLayer);
    const row = document.createElement("div");
    row.className = "zone" + (last && inZone(z, last) ? " in" : "");
    const go = document.createElement("button");
    go.type = "button"; go.className = "zn"; go.dataset.i = i;
    const b = document.createElement("b"); b.textContent = z.name;
    const sp = document.createElement("span"); sp.textContent = rLabel(z.r) + (last && inZone(z, last) ? " · araç içinde" : "");
    go.append(b, sp);
    const del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.dataset.del = i; del.textContent = "×";
    del.setAttribute("aria-label", z.name + " bölgesini sil");
    row.append(go, del);
    list.append(row);
  });
  renderZoneNow();
  renderZoneLog();
}

function renderZoneNow() {
  const last = points[points.length - 1], el = $("zoneNow");
  if (!zones.length) { el.className = "state"; $("zoneNowText").textContent = "Henüz bölge yok"; return; }
  if (!last) { el.className = "state"; $("zoneNowText").textContent = "–"; return; }
  const inside = zones.filter(z => inZone(z, last)).map(z => z.name);
  el.className = "state " + (inside.length ? "drive" : "park");
  $("zoneNowText").textContent = inside.length ? "Şu an: " + inside.join(", ") : "Şu an hiçbir bölgede değil";
}

function zoneEvents(pts) {
  const ev = [];
  for (const z of zones) {
    let state = null;
    for (const p of pts) {
      const d = haversine(z, p);
      const next = d <= z.r ? true : d > z.r + ZONE_HYST ? false : state;
      if (state !== null && next !== state) ev.push({ t: p.t, name: z.name, enter: next });
      state = next;
    }
  }
  return ev.sort((a, b) => a.t - b.t);
}

function renderZoneLog() {
  $("zoneDay").textContent = $("day").value ? new Date($("day").value + "T12:00:00").toLocaleDateString("tr-TR", { day: "numeric", month: "long" }) : "–";
  const log = $("zoneLog"); log.innerHTML = "";
  const p = document.createElement("p");
  if (!zones.length) { p.textContent = "Bölge ekleyince giriş ve çıkışlar burada görünür."; log.append(p); return; }
  const ev = zoneEvents(dayPoints);
  if (!ev.length) { p.textContent = "Bu gün giriş veya çıkış yok."; log.append(p); return; }
  for (const e of ev.reverse()) {
    const row = document.createElement("div");
    const t = document.createElement("b"); t.textContent = hm(e.t);
    const n = document.createElement("span"); n.textContent = e.name;
    const k = document.createElement("span"); k.className = e.enter ? "in" : "out"; k.textContent = e.enter ? "giriş" : "çıkış";
    row.append(t, n, k); log.append(row);
  }
}

function setPicking(on) {
  picking = on;
  // Telefonda pencere haritanın çoğunu kapatır: seçim sırasında küçült, alttaki çubukla yönlendir
  const w = document.querySelector('.window[data-win="zones"]');
  if (narrow.matches) w.classList.toggle("min", on);
  $("pickBar").hidden = !on;
  if (on) document.activeElement?.blur();
  $("zoneAdd").classList.toggle("picking", on);
  $("zoneAdd").textContent = on ? "İptal" : "Haritada yer seç";
  $("zoneHint").textContent = on ? "Haritada bölgenin merkezine dokun." : "Bölgeler sadece bu tarayıcıda saklanır.";
  map.getContainer().classList.toggle("picking", on);
}

$("zoneForm").addEventListener("submit", (e) => {
  e.preventDefault();
  setPicking(!picking);
});
$("pickCancel").addEventListener("click", () => setPicking(false));
$("zoneRadius").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSeg("zoneRadius", b.dataset.v); });
map.on("click", (e) => {
  if (!picking) return;
  const name = $("zoneName").value.trim().slice(0, 24) || "Bölge " + (zones.length + 1);
  zones.push({ name, lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6), r: +segValue("zoneRadius") });
  saveZones();
  $("zoneName").value = "";
  setPicking(false);
  renderZones();
});
$("zoneList").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    const z = zones[+del.dataset.del];
    if (z && confirm(z.name + " bölgesi silinsin mi?")) { zones.splice(+del.dataset.del, 1); saveZones(); renderZones(); }
    return;
  }
  const go = e.target.closest("[data-i]");
  if (go) { const z = zones[+go.dataset.i]; $("follow").checked = false; map.fitBounds(L.latLng(z.lat, z.lon).toBounds(z.r * 2), { padding: [60, 60] }); }
});
renderZones();

// ---------- Rapor ----------
// Son 7/30 günün mesajları gün gün yolculuklara bölünür; km, sürüş süresi ve maks hız sayfada hesaplanır.
async function loadReport() {
  const days = +segValue("repDays");
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - days + 1);
  $("repNote").textContent = "Yükleniyor…";
  let pts;
  try {
    const msgs = await api(`/gw/devices/${DEVICE_ID}/messages`,
      { from: Math.floor(start / 1000), to: Math.floor(Date.now() / 1000), fields: FIELDS, filter: "position.latitude" });
    pts = msgs.map(toPoint).filter(Boolean);
  } catch (e) { $("repNote").textContent = "Veri alınamadı: " + e.message; return; }
  const byDay = new Map();
  for (let i = 0; i < days; i++) { const d = new Date(start); d.setDate(d.getDate() + i); byDay.set(ymd(d), []); }
  for (const p of pts) byDay.get(ymd(new Date(p.t * 1000)))?.push(p);
  let totalM = 0, secs = 0, n = 0, vmax = 0, overN = 0;
  const rows = [...byDay].map(([day, dp]) => {
    const tr = splitTrips(dp), m = tr.reduce((a, t) => a + t.dist, 0);
    totalM += m; n += tr.length;
    for (const t of tr) { secs += t.t1 - t.t0; vmax = Math.max(vmax, t.vmax); overN += t.overN; }
    return { day, m, trips: tr.length };
  });
  $("repKm").textContent = Math.round(totalM / 1000) + " km";
  $("repTime").textContent = dur(secs);
  $("repTrips").textContent = n;
  $("repAvg").textContent = (totalM / 1000 / days).toLocaleString("tr-TR", { maximumFractionDigits: 1 }) + " km";
  $("repMax").textContent = vmax ? Math.round(vmax) + " km/sa" : "–";
  $("repOver").textContent = overN;
  $("repOverTile").classList.toggle("bad", overN > 0);
  $("repOverTile").title = speedLimit + " km/sa üstü";
  const chart = $("repChart"); chart.innerHTML = "";
  const top = Math.max(1, ...rows.map(r => r.m)), today = ymd(new Date());
  for (const r of rows) {
    const d = new Date(r.day + "T12:00:00");
    const bar = document.createElement("div");
    bar.className = "bar" + (r.m ? "" : " zero") + (r.day === today ? " today" : "");
    bar.title = d.toLocaleDateString("tr-TR", { weekday: "short", day: "numeric", month: "short" }) +
      ": " + km(r.m) + ", " + r.trips + " yolculuk";
    const fill = document.createElement("div"); fill.className = "fill";
    fill.style.height = Math.round(r.m / top * 100) + "%";  // CSSOM: CSP'ye takılmaz
    const lab = document.createElement("small");
    lab.textContent = days <= 7 ? d.toLocaleDateString("tr-TR", { weekday: "short" }) : (d.getDate() % 5 === 1 ? d.getDate() : "");
    bar.append(fill, lab); chart.append(bar);
  }
  const first = pts.length ? new Date(pts[0].t * 1000) : null;
  $("repNote").textContent = first && first > new Date(start.getTime() + 86400000)
    ? "flespi'de " + first.toLocaleDateString("tr-TR") + " öncesine ait veri yok." : "";
}
$("repDays").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b || b.classList.contains("on")) return;
  setSeg("repDays", b.dataset.v); if (token) loadReport();
});

// Ana ekrana eklenebilir uygulama: kabuk dosyaları önbelleğe alınır, flespi verisi asla önbelleğe girmez
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// ---------- Bakım hatırlatma ----------
// Kullanıcı göstergedeki km'yi girer. Cihaz toplam km (vehicle.mileage) gönderiyorsa sonraki km'ler ondan
// otomatik ilerler; göndermiyorsa km elle güncellenir. Her şey bu tarayıcının localStorage'ında.
const SVC_KEY = "service", SOON_KM = 1000, SOON_DAYS = 30;
let deviceMil = null;
let svc = { odo: null, odoDevice: null, odoAt: null, items: null };
try { Object.assign(svc, JSON.parse(localStorage.getItem(SVC_KEY)) || {}); } catch {}
if (!Array.isArray(svc.items)) svc.items = [
  { name: "Yağ ve filtre", type: "km", every: 10000, last: null },
  { name: "Muayene", type: "months", every: 24, last: null },
  { name: "Trafik sigortası", type: "months", every: 12, last: null },
];
const saveSvc = () => { try { localStorage.setItem(SVC_KEY, JSON.stringify(svc)); } catch {} };
const fmtKm = (n) => Math.round(n).toLocaleString("tr-TR") + " km";

function currentOdo() {
  if (svc.odo == null) return null;
  if (deviceMil != null && svc.odoDevice != null) return svc.odo + Math.max(0, deviceMil - svc.odoDevice);
  return svc.odo;
}
function addMonths(ts, n) { const d = new Date(ts); d.setMonth(d.getMonth() + n); return d.getTime(); }

function renderService() {
  const odo = currentOdo();
  $("odoNote").textContent = odo == null ? "Önce göstergedeki km'yi gir."
    : "Şu an yaklaşık " + fmtKm(odo) + (deviceMil != null && svc.odoDevice != null ? " (cihazdan otomatik ilerliyor)" : " (elle güncellenir)");
  const list = $("svcList"); list.innerHTML = "";
  let alert = false;
  svc.items.forEach((it, i) => {
    let left = "", cls = "", lastTxt;
    if (it.type === "km") {
      lastTxt = it.last == null ? "Son yapılış girilmedi" : "Son: " + fmtKm(it.last);
      if (it.last != null && odo != null) {
        const rem = it.last + it.every - odo;
        left = rem <= 0 ? fmtKm(-rem) + " geçti" : fmtKm(rem) + " kaldı";
        cls = rem <= 0 ? "due" : rem <= SOON_KM ? "soon" : "";
      }
    } else {
      lastTxt = it.last == null ? "Son yapılış girilmedi" : "Son: " + new Date(it.last).toLocaleDateString("tr-TR");
      if (it.last != null) {
        const days = Math.ceil((addMonths(it.last, it.every) - Date.now()) / 86400000);
        left = days <= 0 ? -days + " gün geçti" : days + " gün kaldı (" + new Date(addMonths(it.last, it.every)).toLocaleDateString("tr-TR") + ")";
        cls = days <= 0 ? "due" : days <= SOON_DAYS ? "soon" : "";
      }
    }
    if (cls) alert = true;
    const row = document.createElement("div"); row.className = "svc " + cls;
    const b = document.createElement("b"); b.textContent = it.name;
    const every = document.createElement("span"); every.textContent = "Her " + (it.type === "km" ? fmtKm(it.every) : it.every + " ay") + " · " + lastTxt;
    const l = document.createElement("span"); l.className = "left"; l.textContent = left;
    const done = document.createElement("button"); done.type = "button"; done.className = "done"; done.dataset.done = i; done.textContent = "Yapıldı";
    done.title = "Son yapıldığı km'yi veya tarihi kaydet";
    const del = document.createElement("button"); del.type = "button"; del.className = "del"; del.dataset.del = i; del.textContent = "×";
    del.setAttribute("aria-label", it.name + " hatırlatmasını sil");
    row.append(b, done, del, every); if (left) row.append(l);
    list.append(row);
  });
  $("svcBadge").hidden = !alert;
}

$("odoForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = Math.round(+$("odoInput").value);
  if (!(v >= 0 && v < 2e6)) return;
  Object.assign(svc, { odo: v, odoDevice: deviceMil, odoAt: Date.now() });
  saveSvc(); $("odoInput").value = ""; renderService();
});
$("svcType").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSeg("svcType", b.dataset.v); });
$("svcForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const every = Math.round(+$("svcEvery").value), type = segValue("svcType");
  if (!(every > 0)) return;
  svc.items.push({ name: $("svcName").value.trim().slice(0, 30) || "Hatırlatma", type, every, last: null });
  saveSvc(); $("svcName").value = ""; $("svcEvery").value = ""; renderService();
});
$("svcList").addEventListener("click", (e) => {
  const d = e.target.closest("[data-done]"), x = e.target.closest("[data-del]");
  if (d) {
    const it = svc.items[+d.dataset.done];
    // Varsayılan şimdiki km / bugün; geçmişte yapıldıysa kullanıcı düzeltir
    if (it.type === "km") {
      const odo = currentOdo();
      const v = prompt(it.name + " kaçıncı km'de yapıldı?", odo == null ? "" : Math.round(odo));
      if (v == null || !(+v >= 0)) return;
      it.last = Math.round(+v);
    } else {
      const v = prompt(it.name + " hangi tarihte yapıldı? (GG.AA.YYYY)", new Date().toLocaleDateString("tr-TR"));
      const m = v && v.trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
      if (!m) return;
      const t = new Date(+m[3], +m[2] - 1, +m[1]).getTime();
      if (!(t > 0) || t > Date.now() + 86400000) return;
      it.last = t;
    }
    saveSvc(); renderService();
  } else if (x) {
    const it = svc.items[+x.dataset.del];
    if (it && confirm(it.name + " silinsin mi?")) { svc.items.splice(+x.dataset.del, 1); saveSvc(); renderService(); }
  }
});
renderService();

// ---------- Cihaz durumu ----------
// Hat (GSM), GPS, güç ve bağlantı bilgileri. İlk değerler flespi telemetry'den (her parametrenin son değeri),
// sonra her MQTT mesajıyla güncellenir. Parametre adları flespi'nin Teltonika adlarıdır; yanında FMB AVL ID'si.
const devTele = {};  // ad -> { v, ts }
const SENSITIVE = /ident|imei|iccid|imsi|peer|phone|msisdn|sim\.number|password/i;
const OPERATORS = { "28601": "Turkcell", "28602": "Vodafone", "28603": "Türk Telekom", "28604": "Türk Telekom" };
const SIG_TEXT = ["Yok", "Çok zayıf", "Zayıf", "Orta", "İyi", "Çok iyi"];
const GNSS_TEXT = ["Kapalı", "Açık", "Açık, konum yok", "Uykuda", "Açık, veri geçersiz"];  // AVL 69
const SLEEP_TEXT = ["Uyanık", "GPS uykusu", "Derin uyku", "Online uyku", "Ultra derin uyku"];  // AVL 200
const DATA_MODE = ["Yurt içi", "Yurt içi", "Dolaşım", "Dolaşım", "Bilinmiyor", "Bilinmiyor"];  // AVL 80 (çift: duruyor, tek: hareketli)

// İlk bulunan anahtarın değeri; flespi adı sürüme göre değişebildiği için birkaç aday denenir
function dv(...keys) {
  for (const k of keys) {
    if (k instanceof RegExp) { const f = Object.keys(devTele).find(x => k.test(x) && devTele[x].v != null); if (f) return devTele[f].v; }
    else if (devTele[k] && devTele[k].v != null) return devTele[k].v;
  }
  return null;
}
const num = (v) => typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(v) ? +v : null;
const nf = (n, d = 1) => n.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
const ago = (s) => s < 60 ? "az önce" : s < 3600 ? Math.floor(s / 60) + " dk önce" : s < 86400 ? Math.floor(s / 3600) + " sa önce" : Math.floor(s / 86400) + " gün önce";

async function loadDevice() {
  const r = await api(`/gw/devices/${DEVICE_ID}/telemetry/all`);
  const t = r[0]?.telemetry || {};
  for (const k in t) devTele[k] = { v: t[k].value, ts: t[k].ts };
  renderDevice();
}
function devMessage(m) {
  const ts = m.timestamp || Date.now() / 1000;
  for (const k in m) if (!devTele[k] || devTele[k].ts <= ts) devTele[k] = { v: m[k], ts };
  renderDevice();
  liveAlarm(m);
}

function setTile(id, text, cls) {
  $(id).textContent = text;
  const tile = $(id).closest(".tile");
  if (tile) { tile.classList.remove("good", "warn", "bad"); if (cls) tile.classList.add(cls); }
}

function renderDevice() {
  const keys = Object.keys(devTele);
  if (!keys.length) return;
  const now = Date.now() / 1000;
  const alerts = [];  // [seviye, metin]

  // --- Hat ---
  // AVL 21 cihazda 0–5; flespi bunu yüzdeye çeviriyor (0–100). 5'ten büyükse yüzde say, 20'şerlik basamağa indir.
  const sigRaw = num(dv("gsm.signal.level"));
  const sig = sigRaw == null ? null : sigRaw > 5 ? Math.min(5, Math.round(sigRaw / 20)) : sigRaw;
  $("dvBars").className = "sigbars l" + (sig ?? 0);
  $("dvSig").textContent = sig == null ? "–" : SIG_TEXT[sig] ?? sig;
  $("dvSigTile").title = sigRaw == null ? "" : sigRaw > 5 ? "%" + sigRaw : sigRaw + "/5";
  $("dvSigTile").classList.toggle("bad", sig != null && sig <= 1);
  $("dvSigTile").classList.toggle("warn", sig === 2);
  if (sig != null && sig <= 1) alerts.push(["warn", "GSM sinyali çok zayıf: veri gecikebilir, SMS geç ulaşabilir."]);

  const opRaw = dv("gsm.operator.code", /operator\.code/);  // AVL 241, MCC+MNC (ör. 28601)
  const op = opRaw == null ? "" : String(opRaw);
  const mcc = op.slice(0, 3);
  $("dvOp").textContent = !op || op === "0" ? "–" : OPERATORS[op] || "Kod " + op;
  $("dvOp").title = op ? "MCC " + mcc + " · MNC " + op.slice(3) : "";

  const dm = num(dv("data.mode.enum", "data.mode", /^(gsm\.)?data\.mode/));  // AVL 80
  const roaming = dm != null ? dm === 2 || dm === 3 : op && op !== "0" ? mcc !== "286" : null;
  setTile("dvNet", roaming == null ? "–" : roaming ? "Dolaşım" : dm != null ? DATA_MODE[dm] : "Yurt içi",
    roaming ? "warn" : roaming === false ? "good" : "");
  if (dm === 4 || dm === 5) $("dvNet").textContent = "Bilinmiyor";
  if (roaming) alerts.push(["warn", "SIM dolaşımda (yurt dışı ağ): veri ücreti yüksek olabilir."]);

  const cell = dv("gsm.cellid", /cell\.?id/i), lac = dv("gsm.lac", /\.lac$|area\.code/i);  // AVL 205, 206
  $("dvCell").textContent = cell == null ? "–" : (lac != null ? lac + " / " : "") + cell;
  $("dvCell").title = "LAC (bölge kodu) / Cell ID";

  // --- GPS ---
  const gs = num(dv("gnss.state.enum", /^gnss\.state/));  // AVL 69
  const valid = dv("position.valid");
  const sat = num(dv("position.satellites"));
  const hdop = num(dv("position.hdop")), pdop = num(dv("position.pdop"));  // AVL 182, 181
  const fix = gs != null ? gs === 1 : valid != null ? !!valid : sat != null ? sat >= 4 : null;
  setTile("dvFix", fix == null ? "–" : fix ? "Bulundu" : gs === 3 ? "GPS uykuda" : gs === 0 ? "GPS kapalı" : "Aranıyor",
    fix ? "good" : fix === false ? (gs === 3 ? "" : "bad") : "");
  if (fix === false && gs !== 3 && gs !== 0) alerts.push(["bad", "GPS konum bulamıyor: kapalı otopark, anten kapalı veya cihaz yeni uyandı."]);
  setTile("dvSat", sat == null ? "–" : sat + (sat >= 8 ? " · iyi" : sat >= 5 ? " · orta" : " · zayıf"),
    sat == null ? "" : sat >= 8 ? "good" : sat >= 5 ? "warn" : "bad");
  // HDOP × ~5 m ≈ yatay konum hatası (kaba tahmin)
  setTile("dvDop", hdop == null ? "–" : "≈ " + Math.max(2, Math.round(hdop * 5)) + " m",
    hdop == null ? "" : hdop <= 1.5 ? "good" : hdop <= 3 ? "warn" : "bad");
  $("dvDop").title = (hdop != null ? "HDOP " + nf(hdop) : "") + (pdop != null ? " · PDOP " + nf(pdop) : "");
  if (hdop != null && hdop > 5 && fix) alerts.push(["warn", "GPS hassasiyeti düşük (HDOP " + nf(hdop) + "): konum birkaç on metre kayabilir."]);
  $("dvGnss").textContent = gs == null ? "–" : GNSS_TEXT[gs] ?? gs;
  // GNSS jammer (AVL 318): 0 yok, 1 uyarı, 2 kritik; flespi adı doğrulanmadı, "jamming" geçen alan aranır
  const jam = num(dv("gnss.jamming.status", "gnss.jamming.state", /gnss.*jamm/));
  if (jam === 2) alerts.push(["bad", "GPS sinyali bastırılıyor (jammer): konum alınamıyor, haritadaki konum son geçerli konum."]);
  else if (jam === 1) alerts.push(["warn", "GPS sinyalinde jammer belirtisi: konum kayabilir."]);

  // --- Güç ---
  const ext = num(dv("external.powersource.voltage"));  // AVL 66
  const bat = num(dv("battery.voltage"));  // AVL 67, cihazın kendi küçük pili
  const cur = num(dv("battery.current"));  // AVL 68
  const ign = dv("engine.ignition.status"), mov = dv("movement.status");  // AVL 239, 240
  // Cihaz araç aküsüne değil harici pile bağlı: araç aküsü eşikleri (12 V, şarj) uygulanmaz
  setTile("dvExt", ext == null ? "–" : nf(ext) + " V", ext == null ? "" : ext < PACK_LOW ? "bad" : "good");
  if (ext != null && ext < 6) alerts.push(["bad", "Harici güç yok (" + nf(ext) + " V): pil bitmiş veya kablo çıkmış olabilir, cihaz dahili pille çalışıyor."]);
  else if (ext != null && ext < PACK_LOW) alerts.push(["bad", "Harici pil bitiyor (" + nf(ext) + " V): booster çıkışı düştü, pili şarja götür."]);
  setTile("dvBat", bat == null ? "–" : nf(bat, 2) + " V" + (cur != null && cur > 0.005 ? " · şarj" : ""),
    bat == null ? "" : bat < 3.6 ? "bad" : bat < 3.8 ? "warn" : "good");
  if (bat != null && bat < 3.6) alerts.push(["warn", "Cihazın dahili pili düşük (" + nf(bat, 2) + " V): araç gücü kesilirse uzun dayanmaz."]);
  const yn = (b, on, off) => b == null ? "?" : b ? on : off;
  $("dvIgn").textContent = ign == null && mov == null ? "–" : yn(ign, "Açık", "Kapalı") + " · " + yn(mov, "Var", "Yok");

  const sl = num(dv("sleep.mode.enum", /^sleep\.mode/));  // AVL 200
  $("dvSleep").textContent = sl == null ? "–" : SLEEP_TEXT[sl] ?? sl;

  // --- Bağlantı ---
  const last = Math.max(...keys.map(k => devTele[k].ts || 0));
  const silent = now - last;
  setTile("dvLast", ago(silent), silent < 600 ? "good" : silent < 3 * 3600 ? "warn" : "bad");
  $("dvLast").title = new Date(last * 1000).toLocaleString("tr-TR");
  const dts = num(dv("timestamp")), sts = num(dv("server.timestamp"));
  const lag = dts != null && sts != null ? sts - dts : null;
  setTile("dvLag", lag == null ? "–" : lag < 60 ? "Yok" : lag < 3600 ? Math.round(lag / 60) + " dk" : dur(lag), lag == null ? "" : lag < 120 ? "good" : "warn");
  $("dvLag").title = "Kaydın oluşması ile flespi'ye ulaşması arasındaki süre";
  if (lag != null && lag > 300) alerts.push(["warn", "Son kayıt " + dur(lag) + " gecikmeyle geldi: cihaz o sırada hatta bağlanamamış, kayıtları sonradan gönderdi."]);
  if (silent > 3 * 3600 && ign === true) alerts.push(["bad", "Kontak açık görünüyor ama " + dur(silent) + " veri yok: hat/kontör veya cihaz arızası olabilir."]);
  else if (silent > 26 * 3600) alerts.push(["bad", dur(silent) + " veri yok: SIM'in internet paketini ve cihazın gücünü kontrol et."]);

  let pill = "live", pillText = "Çevrimiçi";
  if (silent > 26 * 3600) { pill = "err"; pillText = "Sessiz"; }
  else if (silent > 600) { pill = "wait"; pillText = sl > 0 ? "Uykuda" : ign === false ? "Park" : "Bekleniyor"; }
  $("devPill").className = "pill " + pill; $("devPillText").textContent = pillText;

  // --- Uyarılar ---
  const box = $("devAlerts"); box.innerHTML = "";
  for (const [lvl, text] of alerts) {
    const p = document.createElement("p"); p.className = "alert " + lvl; p.textContent = text; box.append(p);
  }
  if (!alerts.length) { const p = document.createElement("p"); p.className = "alert ok"; p.textContent = "Her şey normal görünüyor."; box.append(p); }
  $("devBadge").hidden = !alerts.some(a => a[0] === "bad");

  // --- Ham liste (kimlik bilgileri hariç) ---
  const shown = keys.filter(k => !SENSITIVE.test(k)).sort();
  $("dvRawN").textContent = "(" + shown.length + ")";
  if ($("dvRaw").closest("details").open) renderRaw(shown);
}
function renderRaw(shown) {
  const list = $("dvRaw"); list.innerHTML = "";
  for (const k of shown || Object.keys(devTele).filter(k => !SENSITIVE.test(k)).sort()) {
    const row = document.createElement("div");
    const a = document.createElement("span"), b = document.createElement("b");
    a.textContent = k;
    const v = devTele[k].v;
    b.textContent = typeof v === "object" ? JSON.stringify(v) : String(v);
    row.title = new Date(devTele[k].ts * 1000).toLocaleString("tr-TR");
    row.append(a, b); list.append(row);
  }
}
$("dvRaw").closest("details").addEventListener("toggle", (e) => { if (e.target.open) renderRaw(); });
$("dvRefresh").addEventListener("click", () => {
  if (token) loadDevice().catch(e => { $("devAlerts").textContent = "Veri alınamadı: " + e.message; });
});
setInterval(renderDevice, 30000);

// ---------- Park alarmı ----------
// Cihazın çekici (towing) senaryosu sadece kontak kapalıyken çalışır (kontak kaynağı ivmeölçer, 101:2):
// araç 5 dk durunca devreye girer, darbe/eğilmede kayıt (AVL 246 = 1) ve SMS gönderir. flespi adı doğrulanmadı,
// "towing" geçen alan aranır. Hızlı (> 3 km/sa) kayıtlar alarm sayılmaz.
const ALARM_SEEN = "alarmSeen";
const TOWING = /towing/i;
let alarms = [];  // [{t, speed}]
let alarmKey = null;
let alarmSeen = 0;
try { alarmSeen = +localStorage.getItem(ALARM_SEEN) || 0; } catch {}
const parked = (a) => (a.speed || 0) <= 3;
const dayTime = (t) => new Date(t * 1000).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function alarmOf(m) {
  alarmKey ||= Object.keys(m).find(k => TOWING.test(k)) || null;
  const v = alarmKey && m[alarmKey];
  if (!(v === true || v === 1 || v === "1") || typeof m.timestamp !== "number") return null;
  return { t: m.timestamp, speed: num(m["position.speed"]) };
}
async function loadAlarms() {
  alarmKey ||= Object.keys(devTele).find(k => TOWING.test(k)) || null;
  if (alarmKey) {
    const now = Math.floor(Date.now() / 1000);
    const msgs = await api(`/gw/devices/${DEVICE_ID}/messages`,
      { from: now - 7 * 86400, to: now, fields: "timestamp,position.speed," + alarmKey, filter: alarmKey });
    alarms = msgs.map(alarmOf).filter(Boolean).sort((x, y) => x.t - y.t);
  }
  renderAlarms();
}
function liveAlarm(m) {
  const a = alarmOf(m);
  if (!a || alarms.some(x => x.t === a.t)) return;
  alarms.push(a); alarms.sort((x, y) => x.t - y.t);
  renderAlarms();
  // Cihaz hat yokken biriktirdiği eski kayıtlar için bildirim atma
  if (parked(a) && Date.now() / 1000 - a.t < 900) notifyAlarm(a);
}

function renderAlarms() {
  const now = Date.now() / 1000;
  const real = alarms.filter(parked);
  const last = real[real.length - 1];
  const box = $("alarmNow"); box.innerHTML = "";
  const p = document.createElement("p");
  if (last && now - last.t < 6 * 3600) {
    p.className = "alert bad";
    p.textContent = "Park halindeyken darbe veya hareket algılandı · " + hm(last.t) + " (" + ago(now - last.t) + ")";
  } else {
    p.className = "alert ok";
    p.textContent = alarmKey ? "Son 6 saatte alarm yok." : "Henüz alarm kaydı gelmedi. Cihazda çekici uyarısı açık olmalı (11600).";
  }
  box.append(p);

  const log = $("alarmLog"); log.innerHTML = "";
  if (!alarms.length) { const e = document.createElement("p"); e.textContent = "Kayıt yok."; log.append(e); }
  for (const a of [...alarms].reverse()) {
    const row = document.createElement("div");
    const t = document.createElement("b"); t.textContent = dayTime(a.t); t.className = "wide";
    const k = document.createElement("span");
    k.className = parked(a) ? "out" : "drive";
    k.textContent = parked(a) ? "park halinde darbe/hareket" : "sürüşte (sayılmadı)";
    row.append(t, k); log.append(row);
  }
  $("alarmBadge").hidden = !real.some(a => a.t > alarmSeen);
}
function seeAlarms() {
  const t = Math.max(0, ...alarms.map(a => a.t));
  if (t > alarmSeen) { alarmSeen = t; try { localStorage.setItem(ALARM_SEEN, String(t)); } catch {} }
  renderAlarms();
}
// Pencere yöneticisinin tıklama işleyicisi sonra çalışır: pencerenin açıldığını bir tur sonra kontrol et
document.querySelector('.dock-item[data-toggle="alarm"]').addEventListener("click", () => setTimeout(() => {
  if (!document.querySelector('.window[data-win="alarm"]').classList.contains("closed")) seeAlarms();
}));

// Sayfa (veya ana ekrandaki uygulama) açıkken telefon bildirimi; kapalıyken cihazın SMS'i devrede
function renderNotifyBtn() {
  const b = $("alarmNotify");
  if (!("Notification" in window)) { b.hidden = true; return; }
  b.hidden = Notification.permission === "granted";
  b.disabled = Notification.permission === "denied";
  b.textContent = b.disabled ? "Bildirimler tarayıcıda engelli" : "Bildirimlere izin ver";
}
$("alarmNotify").addEventListener("click", async () => { await Notification.requestPermission(); renderNotifyBtn(); });
renderNotifyBtn();
async function notifyAlarm(a) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  // Konum yazılmaz: bildirim kilit ekranında görünebilir
  const opts = { body: "Araç park halindeyken darbe veya hareket algılandı · " + hm(a.t), icon: "icons/icon-192.png", tag: "park-alarm", renotify: true };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification("Park alarmı", opts);
  } catch {}
  try { new Notification("Park alarmı", opts); } catch {}  // Android'de sadece service worker yolu çalışır
}

// ---------- Pencere yöneticisi ----------
// Her .window[data-win]: başlıktan sürüklenir, sarı düğme küçültür, kırmızı kapatır, Dock geri açar.
// Konum/durum bu tarayıcıda hatırlanır (sadece arayüz tercihi, hassas veri yok).
const WIN_KEY = "windows";
const narrow = matchMedia("(max-width: 640px)");
let winState = {};
try { winState = JSON.parse(localStorage.getItem(WIN_KEY)) || {}; } catch {}
let zTop = 10;
const wins = [...document.querySelectorAll(".window[data-win]")];
const saveWins = () => { try { localStorage.setItem(WIN_KEY, JSON.stringify(winState)); } catch {} };

function clamp(w) {
  if (narrow.matches) return;
  const r = w.getBoundingClientRect();
  const x = Math.min(Math.max(0, r.left), innerWidth - Math.min(r.width, 120));
  const y = Math.min(Math.max(0, r.top), innerHeight - 40);
  w.style.left = x + "px"; w.style.top = y + "px"; w.style.right = "auto";
}
function focusWin(w) { w.style.zIndex = ++zTop; }
function setOpen(w, open) {
  const id = w.dataset.win;
  // Telefonda pencereler üst üste biner; aynı anda tek pencere açık kalır
  if (open && narrow.matches) for (const o of wins) if (o !== w) setOpen(o, false);
  w.classList.toggle("closed", !open);
  if (open) { w.classList.remove("min"); focusWin(w); }
  document.querySelector(`.dock-item[data-toggle="${id}"]`)?.classList.toggle("open", open);
  (winState[id] ||= {}).closed = !open; winState[id].min = w.classList.contains("min");
  saveWins();
}

for (const w of wins) {
  const id = w.dataset.win, st = winState[id] || {};
  if (st.x != null && !narrow.matches) { w.style.left = st.x + "px"; w.style.top = st.y + "px"; w.style.right = "auto"; clamp(w); }
  if (st.min) w.classList.add("min");
  // İlk açılışta sadece Araç (masaüstünde Harita da) açık; diğerleri Dock'tan açılır
  const closed = st.closed ?? (narrow.matches ? id !== "vehicle" : !["vehicle", "layers"].includes(id));
  w.classList.toggle("closed", closed);
  document.querySelector(`.dock-item[data-toggle="${id}"]`)?.classList.toggle("open", !closed);

  w.addEventListener("pointerdown", () => focusWin(w));
  w.querySelector('[data-act="close"]').addEventListener("click", () => setOpen(w, false));
  w.querySelector('[data-act="min"]').addEventListener("click", () => {
    w.classList.toggle("min"); (winState[id] ||= {}).min = w.classList.contains("min"); saveWins();
  });

  const bar = w.querySelector(".titlebar");
  bar.addEventListener("dblclick", (e) => { if (!e.target.closest(".lights")) w.querySelector('[data-act="min"]').click(); });
  bar.addEventListener("pointerdown", (e) => {
    if (narrow.matches || e.button !== 0 || e.target.closest("button")) return;
    const r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    bar.setPointerCapture(e.pointerId); w.classList.add("dragging");
    const move = (ev) => {
      w.style.left = Math.min(Math.max(0, ev.clientX - dx), innerWidth - 80) + "px";
      w.style.top = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 40) + "px";
      w.style.right = "auto";
    };
    const up = () => {
      bar.removeEventListener("pointermove", move); w.classList.remove("dragging");
      const rr = w.getBoundingClientRect();
      Object.assign(winState[id] ||= {}, { x: Math.round(rr.left), y: Math.round(rr.top) }); saveWins();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up, { once: true });
    bar.addEventListener("pointercancel", up, { once: true });
  });
}
for (const b of document.querySelectorAll(".dock-item[data-toggle]")) {
  const w = document.querySelector(`.window[data-win="${b.dataset.toggle}"]`);
  b.addEventListener("click", () => setOpen(w, w.classList.contains("closed") || w.classList.contains("min")));
}
addEventListener("resize", () => wins.forEach(clamp));

// ---------- Konum paylaşma ----------
// Link: <site>/#share=<token>. # sonrası sunucuya (GitHub) gitmez. Paylaşım token'ı sadece telemetri okuyabilmeli;
// görünümde geçmiş/rota/bölge yok, token hiçbir yere kaydedilmez.
async function tokenCan(tok, path) {
  const res = await fetch(API + path, { headers: { Authorization: "FlespiToken " + tok } });
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new Error("HTTP " + res.status);
  return true;
}
// Paylaşım token'ı bir kez kaydedilir (bu cihazın localStorage'ı). Her paylaşımda link'e bitiş zamanı (exp) eklenir;
// izleyici sayfası exp geçince veri çekmeyi bırakır. Not: bitiş tarayıcıda uygulanır, token flespi'de silinene
// kadar geçerlidir; tüm linkleri hemen kapatmak için token flespi'den silinip yenisi kaydedilir.
const SHARE_KEY = "shareToken";
let ownShare = "";
try { ownShare = localStorage.getItem(SHARE_KEY) || ""; } catch {}
function renderShareSetup() {
  $("shareSetup").hidden = !!ownShare;
  $("shareReady").hidden = !ownShare;
  if (!ownShare) $("shareOut").hidden = true;
}
renderShareSetup();
$("shareReset").addEventListener("click", () => {
  ownShare = ""; try { localStorage.removeItem(SHARE_KEY); } catch {}
  $("shareNote").textContent = ""; renderShareSetup();
});
$("shareDur").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSeg("shareDur", b.dataset.v); });
$("shareMake").addEventListener("click", () => {
  const exp = Math.floor(Date.now() / 1000) + +segValue("shareDur") * 3600;
  $("shareLink").value = location.origin + location.pathname + "#share=" + ownShare + "&exp=" + exp;
  drawQr($("shareQr"), $("shareLink").value);
  $("shareUntil").textContent = "Bitiş: " + new Date(exp * 1000).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
  $("shareOut").hidden = false;
  $("shareSend").hidden = !navigator.share;
});
$("shareForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tok = $("shareToken").value.replace(/[^A-Za-z0-9]/g, "");
  $("shareOut").hidden = true; $("shareNote").textContent = "";
  if (!tok) return;
  if (tok === token) { $("shareNote").textContent = "Bu senin ana token'ın. Paylaşım için flespi'de ayrı bir token oluştur."; return; }
  $("shareNote").textContent = "Token kontrol ediliyor…";
  try {
    if (!await tokenCan(tok, `/gw/devices/${DEVICE_ID}/telemetry/position.latitude`)) {
      $("shareNote").textContent = "Bu token aracın konumunu okuyamıyor (süresi dolmuş veya ACL eksik)."; return;
    }
    // Geçmişi de okuyabiliyorsa paylaşma: link sızarsa tüm rota görünür
    if (await tokenCan(tok, `/gw/devices/${DEVICE_ID}/messages?data=` + encodeURIComponent(JSON.stringify({ count: 1, fields: "timestamp" })))) {
      $("shareNote").textContent = "Bu token geçmiş mesajları da okuyabiliyor. Güvenlik için ACL'de sadece telemetry bırak."; return;
    }
  } catch (err) { $("shareNote").textContent = "Kontrol edilemedi: " + err.message; return; }
  $("shareNote").textContent = "";
  $("shareToken").value = "";
  ownShare = tok; try { localStorage.setItem(SHARE_KEY, tok); } catch {}
  renderShareSetup();
});
// QR: vendor/qrcode.js (MIT) ile canvas'a çizilir; bağlantı dışarı gönderilmez
function drawQr(cv, text) {
  const qr = qrcode(0, "M"); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), q = 4, s = Math.floor(cv.width / (n + 2 * q)), off = Math.floor((cv.width - s * n) / 2);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(off + c * s, off + r * s, s, s);
}
$("shareSave").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = $("shareQr").toDataURL("image/png"); a.download = "arac-konum-qr.png"; a.click();
});
$("shareCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("shareLink").value); $("shareCopy").textContent = "Kopyalandı"; }
  catch { $("shareLink").select(); $("shareCopy").textContent = "Seçildi, kopyala"; }
  setTimeout(() => { $("shareCopy").textContent = "Kopyala"; }, 2000);
});
$("shareSend").addEventListener("click", () => {
  navigator.share({ title: "Araç konumu", url: $("shareLink").value }).catch(() => {});
});

async function startShare(tok, exp) {
  document.body.classList.add("share");
  $("shareCard").hidden = false;
  route.remove(); zoneLayer.remove();
  const expired = () => {
    $("shareErr").textContent = "Bu paylaşım linkinin süresi dolmuş veya iptal edilmiş.";
    $("shareAgo").textContent = ""; $("shareSpeed").textContent = "–"; marker.remove(); clearInterval(timer);
  };
  const tick = async () => {
    if (exp && Date.now() / 1000 > exp) return expired();
    try {
      const res = await fetch(API + `/gw/devices/${DEVICE_ID}/telemetry/position.latitude,position.longitude,position.speed,position.direction`,
        { headers: { Authorization: "FlespiToken " + tok } });
      if (res.status === 401 || res.status === 403) return expired();
      if (!res.ok) throw new Error("HTTP " + res.status);
      const t = ((await res.json()).result || [])[0]?.telemetry || {};
      const v = (k) => t[k]?.value;
      const p = toPoint({ "position.latitude": v("position.latitude"), "position.longitude": v("position.longitude"),
        "position.speed": v("position.speed"), "position.direction": v("position.direction"), timestamp: t["position.latitude"]?.ts });
      if (!p) { $("shareAgo").textContent = "Konum yok"; return; }
      points = [p]; lastMoveTs = null;
      update(p);
      $("shareSpeed").textContent = p.speed == null ? "–" : Math.round(p.speed);
      $("shareAgo").textContent = $("ago").textContent +
        (exp ? " · bitiş " + new Date(exp * 1000).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
      $("shareErr").textContent = "";
    } catch (e) { $("shareErr").textContent = "Bağlantı hatası: " + e.message; }
  };
  const timer = setInterval(tick, 10000);
  tick();
}

const shareMatch = location.hash.match(/^#share=([A-Za-z0-9]+)(?:&exp=(\d{9,11}))?$/);
// Aynı sekmede link değişirse (paylaşım ↔ normal) sayfayı baştan kur
addEventListener("hashchange", () => location.reload());
if (shareMatch) startShare(shareMatch[1], shareMatch[2] ? +shareMatch[2] : 0);
else token ? start() : askToken();
