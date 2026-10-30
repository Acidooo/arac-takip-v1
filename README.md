# Araç Takip

Teltonika FMB120 için canlı harita. Veriyi flespi alır; bu statik sayfa GitHub Pages'te çalışır ve konumu doğrudan flespi'den okur. Sunucu yok.

## Nasıl çalışır

- Açılışta son 1/6/24 saatin rotası flespi REST API'den çekilir.
- Yeni konumlar flespi MQTT (WebSocket) üzerinden anlık gelir.
- Harita: Sokak (OpenStreetMap) veya Hibrit (Esri uydu + yol/yer etiketleri).
- Araç penceresinde durum: Seyirde / Kontak açık, duruyor / Park halinde ve park süresi (kontak bilgisi `engine.ignition.status`, yoksa hız).
- Yolculuklar penceresi: gün seçilir, o günün mesajları sayfada yolculuklara bölünür (saat, süre, km, maks hız). Bir yolculuk seçilince rota turuncu çizilir ve zaman çubuğuyla 30×/120×/600× hızda oynatılır. Adres çözümleme yok; konum üçüncü bir servise gönderilmez.
- Hız limiti (Yolculuklar penceresinde, varsayılan 120 km/sa, bu tarayıcıda saklanır): her yolculukta limit aşımı sayısı ve süresi, oynatmada limit üstü kısımlar kırmızı, Raporda toplam aşım, canlı hız limit üstündeyse kırmızı.
- Paylaş penceresi: bir kez flespi'de sadece `telemetry` okuyabilen bir paylaşım token'ı oluşturulup kaydedilir (bu cihazın localStorage'ı). Sonra her paylaşımda süre seçilir (1 saat / 1 gün / 1 hafta) ve `.../#share=<token>&exp=<bitiş>` linki + QR üretilir. İzleyici sadece canlı konum ve hızı görür (10 sn'de bir), bitiş geçince sayfa veri çekmeyi bırakır. Bitiş tarayıcıda uygulanır: token flespi'de silinene kadar teknik olarak geçerlidir; tüm linkleri hemen kapatmak için token flespi'den silinip yenisi kaydedilir. Geçmişi de okuyabilen veya ana token reddedilir. `#` sonrası GitHub'a gönderilmez.
- Bölgeler penceresi (geofence): ad + yarıçap seçilip haritaya dokunularak bölge eklenir. Şu an hangi bölgede olduğu ve seçili günün giriş/çıkışları gösterilir. Bölgeler sadece bu tarayıcının localStorage'ında durur; repoya veya flespi'ye gitmez. Sayfa kapalıyken bildirim yok (ileride flespi + Telegram).
- Akü kutusu: cihazın beslendiği araç aküsü voltajı (`external.powersource.voltage`). Kontak kapalıyken 12,0 V altı kırmızı görünür.
- Rapor penceresi: son 7 veya 30 günün toplam km, sürüş süresi, yolculuk sayısı, günlük ortalama, maks hız ve günlük km grafiği. Hepsi sayfada hesaplanır.
- Bakım penceresi: göstergedeki km girilir; cihaz toplam km (`vehicle.mileage`) gönderiyorsa sonrası otomatik ilerler. Km veya ay aralıklı hatırlatmalar (yağ, muayene, sigorta + özel); yaklaşan/geçen olanlar renklenir, Dock simgesinde kırmızı nokta çıkar. Bilgiler sadece bu tarayıcıda saklanır.
- Ana ekrana eklenebilir (PWA): telefonda tarayıcı menüsünden "Ana ekrana ekle". `sw.js` sadece sitenin kendi dosyalarını önbelleğe alır; flespi verisi ve token önbelleğe girmez. Yeni sürüm yayınlarken `index.html` içindeki `app.js?v=N` / `style.css?v=N` numarasını artır; yoksa tarayıcı yeni HTML ile eski JS'yi karıştırabilir.

## Arayüz

- Apple tarzı cam (buzlu cam, blur) pencereler: macOS gibi başlık çubuğu, kırmızı = kapat, sarı = küçült (ya da başlığa çift tıkla).
- Pencereler masaüstünde başlıktan sürüklenir; konumları bu tarayıcıda hatırlanır. Telefonda üstte tek pencere açık kalır.
- Alttaki Dock: Araç, Harita, Yolculuklar, Bölgeler, Rapor, Bakım ve Paylaş pencerelerini açar/kapatır (ilk açılışta sadece Araç ve Harita açık), aracı ortalar, çıkış yapar.
- Yeni panel eklemek: `index.html` içinde `#desktop` altına `<section class="window" data-win="ad">` ve Dock'a `data-toggle="ad"` düğmesi eklemek yeterli; pencere yöneticisi gerisini halleder.
- Açık/koyu tema sistem ayarına göre otomatik.

## Güvenlik

- **Repoda hiçbir sır yok.** Token, IMEI, flespi kanal adresi ve SIM numarası koda/commit'lere girmez. Sadece cihazın flespi ID'si var; token olmadan tek başına işe yaramaz.
- Token sayfaya giriş ekranından yapıştırılır. "Bu cihazda hatırla" kapalıysa sekme kapanınca silinir.
- Kullanılan token **salt-okuma** ve **tek cihazla sınırlı** olmalı (ACL: `gw/devices`, sadece bu cihaz ID'si, sadece GET, `messages` + `telemetry`). Master token asla kullanılmaz.
- Kütüphaneler (Leaflet 1.9.4, mqtt.js 5.10.1, qrcode-generator 1.4.4) `vendor/` içinde; dış CDN'den kod yüklenmez.
- Content-Security-Policy: script ve stil sadece bu siteden; ağ bağlantısı sadece flespi'ye; görseller sadece harita sunucularından.
- Token sızarsa: flespi panelinde **Tokens** sayfasından silip yenisini oluştur.

## Ayarlar

`app.js` başındaki `DEVICE_ID` flespi cihaz ID'sidir.

## Harita katmanları

- OSM: OpenStreetMap standart (eski adı "Sokak").
- Sade: açık temada Esri Light Gray, koyu temada Esri Dark Gray Canvas (tema değişince kendiliğinden geçer). CARTO artık API anahtarı istediği için kaldırıldı; anahtar repoya konmaz.
- Hibrit: Esri uydu + yol/yer etiketleri.
