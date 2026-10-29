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
L.control.zoom({ position: "bottomright" }).addTo(map);
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
const esri = (name, opts) => L.tileLayer(ESRI + name + "/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, ...opts });
const baseLayers = {
  "Sokak": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }),
  "Hibrit": L.layerGroup([
    esri("World_Imagery", { attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" }),
    esri("Reference/World_Transportation"),
    esri("Reference/World_Boundaries_and_Places"),
  ]),
};
const LAYER_KEY = "mapLayer";
let layerName = "Sokak";
try { layerName = baseLayers[localStorage.getItem(LAYER_KEY)] ? localStorage.getItem(LAYER_KEY) : "Sokak"; } catch {}
baseLayers[layerName].addTo(map);
L.control.layers(baseLayers, null, { position: "bottomright" }).addTo(map);
map.on("baselayerchange", (e) => { try { localStorage.setItem(LAYER_KEY, e.name); } catch {} });
const route = L.polyline([], { color: "#2563eb", weight: 4, opacity: .75 }).addTo(map);
const marker = L.marker([0, 0], { icon: L.divIcon({ className: "", html: '<div class="car"></div>', iconSize: [22, 22] }) });
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
function status(kind, text) { $("dot").className = "dot " + kind; $("msg").textContent = text || ""; }

function toPoint(m) {
  const lat = m["position.latitude"], lon = m["position.longitude"];
  if (typeof lat !== "number" || typeof lon !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { t: m.timestamp, lat, lon, speed: m["position.speed"] ?? null };
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
  const hours = +$("hours").value;
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
  route.setLatLngs(points.length > 1 ? points.map(p => [p.lat, p.lon]) : []);
  if (points.length) update(points[points.length - 1]);
  else status("wait", "Son 7 günde konum bulunamadı.");
}

function update(p) {
  lastTs = p.t;
  marker.setLatLng([p.lat, p.lon]);
  if (!map.hasLayer(marker)) marker.addTo(map);
  $("speed").textContent = p.speed == null ? "–" : Math.round(p.speed) + " km/sa";
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
    route.setLatLngs(points.length > 1 ? points.map(q => [q.lat, q.lon]) : []);
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
$("hours").addEventListener("change", () => { if (token) loadHistory().catch(e => status("err", e.message)); });

token ? start() : askToken();
