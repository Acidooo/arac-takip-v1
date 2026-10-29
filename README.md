# Araç Takip

Teltonika FMB120 için canlı harita. Veriyi flespi alır; bu statik sayfa GitHub Pages'te çalışır ve konumu doğrudan flespi'den okur. Sunucu yok.

## Nasıl çalışır

- Açılışta son 1/6/24 saatin rotası flespi REST API'den çekilir.
- Yeni konumlar flespi MQTT (WebSocket) üzerinden anlık gelir.
- Harita: Sokak (OpenStreetMap) veya Hibrit (Esri uydu + yol/yer etiketleri).

## Güvenlik

- **Repoda hiçbir sır yok.** Token, IMEI, flespi kanal adresi ve SIM numarası koda/commit'lere girmez. Sadece cihazın flespi ID'si var; token olmadan tek başına işe yaramaz.
- Token sayfaya giriş ekranından yapıştırılır. "Bu cihazda hatırla" kapalıysa sekme kapanınca silinir.
- Kullanılan token **salt-okuma** ve **tek cihazla sınırlı** olmalı (ACL: `gw/devices`, sadece bu cihaz ID'si, sadece GET, `messages` + `telemetry`). Master token asla kullanılmaz.
- Kütüphaneler (Leaflet 1.9.4, mqtt.js 5.10.1) `vendor/` içinde; dış CDN'den kod yüklenmez.
- Content-Security-Policy: script ve stil sadece bu siteden; ağ bağlantısı sadece flespi'ye; görseller sadece harita sunucularından.
- Token sızarsa: flespi panelinde **Tokens** sayfasından silip yenisini oluştur.

## Ayarlar

`app.js` başındaki `DEVICE_ID` flespi cihaz ID'sidir.
