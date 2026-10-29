# Araç Takip

Teltonika FMB120 için canlı harita. Veriyi flespi alır; bu statik sayfa GitHub Pages'te çalışır ve konumu doğrudan flespi'den okur. Sunucu yok.

## Nasıl çalışır

- Açılışta son 1/6/24 saatin rotası flespi REST API'den çekilir.
- Yeni konumlar flespi MQTT (WebSocket) üzerinden anlık gelir.
- Harita: Sokak (OpenStreetMap) veya Hibrit (Esri uydu + yol/yer etiketleri).

## Arayüz

- Apple tarzı cam (buzlu cam, blur) pencereler: macOS gibi başlık çubuğu, kırmızı = kapat, sarı = küçült (ya da başlığa çift tıkla).
- Pencereler masaüstünde başlıktan sürüklenir; konumları bu tarayıcıda hatırlanır. Telefonda üstte tek pencere açık kalır.
- Alttaki Dock: Araç ve Harita pencerelerini açar/kapatır, aracı ortalar, çıkış yapar.
- Yeni panel eklemek: `index.html` içinde `#desktop` altına `<section class="window" data-win="ad">` ve Dock'a `data-toggle="ad"` düğmesi eklemek yeterli; pencere yöneticisi gerisini halleder.
- Açık/koyu tema sistem ayarına göre otomatik.

## Güvenlik

- **Repoda hiçbir sır yok.** Token, IMEI, flespi kanal adresi ve SIM numarası koda/commit'lere girmez. Sadece cihazın flespi ID'si var; token olmadan tek başına işe yaramaz.
- Token sayfaya giriş ekranından yapıştırılır. "Bu cihazda hatırla" kapalıysa sekme kapanınca silinir.
- Kullanılan token **salt-okuma** ve **tek cihazla sınırlı** olmalı (ACL: `gw/devices`, sadece bu cihaz ID'si, sadece GET, `messages` + `telemetry`). Master token asla kullanılmaz.
- Kütüphaneler (Leaflet 1.9.4, mqtt.js 5.10.1) `vendor/` içinde; dış CDN'den kod yüklenmez.
- Content-Security-Policy: script ve stil sadece bu siteden; ağ bağlantısı sadece flespi'ye; görseller sadece harita sunucularından.
- Token sızarsa: flespi panelinde **Tokens** sayfasından silip yenisini oluştur.

## Ayarlar

`app.js` başındaki `DEVICE_ID` flespi cihaz ID'sidir.

## Harita katmanları

- OSM: OpenStreetMap standart (eski adı "Sokak").
- CARTO: açık temada Positron, koyu temada Dark Matter (tema değişince kendiliğinden geçer).
- Hibrit: Esri uydu + yol/yer etiketleri.
