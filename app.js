const DEVICE_ID = 9363738;
const API = "https://flespi.io";
const MQTT_URL = "wss://mqtt.flespi.io:443";
const FIELDS = "timestamp,position.latitude,position.longitude,position.speed,position.direction";
const TOKEN_KEY = "flespiToken";

const $ = (id) => document.getElementById(id);
let token = load();
let mqttClient = null;
let points = [];   // [{t, lat, lon, speed}]
let lastTs = 0;

const map = L.map("map", { zoomControl: false }).setView([39.0, 35.0], 6);
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const esri = (name, opts) => L.tileLayer(ESRI + name + "/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, ...opts });
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const dark = matchMedia("(prefers-color-scheme: dark)");
// CARTO: açık temada Positron, koyu temada Dark Matter
const cartoUrl = () => "https://{s}.basemaps.cartocdn.com/" + (dark.matches ? "dark_all" : "light_all") + "/{z}/{x}/{y}{r}.png";
const carto = L.tileLayer(cartoUrl(), {
  maxZoom: 20, subdomains: "abcd", attribution: OSM_ATTR + ' &copy; <a href="https://carto.com/attributions">CARTO</a>'
});
dark.addEventListener("change", () => carto.setUrl(cartoUrl()));
const baseLayers = {
  "OSM": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: OSM_ATTR }),
  "CARTO": carto,
  "Hibrit": L.layerGroup([
    esri("World_Imagery", { attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" }),
    esri("Reference/World_Transportation"),
    esri("Reference/World_Boundaries_and_Places"),
  ]),
};
const LAYER_KEY = "mapLayer";
let layerName = "OSM";
try {
  const saved = localStorage.getItem(LAYER_KEY) === "Sokak" ? "OSM" : localStorage.getItem(LAYER_KEY);  // eski ad
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
  return { t: m.timestamp, lat, lon, speed: m["position.speed"] ?? null, dir: m["position.direction"] ?? null };
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

function drawRoute() {
  route.setLatLngs(points.length > 1 ? points.map(p => [p.lat, p.lon]) : []);
  $("count").textContent = points.length || "–";
}

function update(p) {
  lastTs = p.t;
  marker.setLatLng([p.lat, p.lon]);
  if (!map.hasLayer(marker)) marker.addTo(map);
  $("speed").textContent = p.speed == null ? "–" : Math.round(p.speed);
  if (typeof p.dir === "number") {
    // CSP inline stil özniteliğine izin vermez; CSSOM ile döndürmek serbest
    const rot = "rotate(" + p.dir + "deg)";
    $("compass").style.transform = rot;
    const icon = marker.getElement() && marker.getElement().querySelector("svg");
    if (icon) icon.style.transform = rot;
  }
  renderAgo();
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
setInterval(renderAgo, 15000);

function connectLive() {
  if (mqttClient) mqttClient.end(true);
  mqttClient = mqtt.connect(MQTT_URL, { username: token, password: "", clean: true, reconnectPeriod: 5000 });
  mqttClient.on("connect", () => {
    mqttClient.subscribe(`flespi/message/gw/devices/${DEVICE_ID}`);
    status("live", "Canlı bağlantı açık.");
  });
  mqttClient.on("message", (_topic, payload) => {
    let m; try { m = JSON.parse(payload.toString()); } catch { return; }
    const p = toPoint(m);
    if (!p || p.t < lastTs) return;
    points.push(p);
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
  const closed = st.closed ?? (narrow.matches && id !== "vehicle");
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

token ? start() : askToken();
