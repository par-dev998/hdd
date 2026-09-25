# dual-source-sync

İki farklı veri kaynağindan (A ve B) alınan iki fiyat noktası arasındaki
farkı izleyen, eşik aşılınca ilgili hesaptaki mevcut bakiyeleri kullanarak
iki tarafta eşzamanlı işlem gönderen, stok bazlı bir görev.

## Nasıl çalışıyor

Her turda köprü hesabına gidip gelmek yerine, hesapta zaten tutulan 4
bakiyeyi (A1, A2, B1, B2) kullanır:

- B tarafı daha yüksekse: B1'i B tarafında satar (B2 alır) + aynı anda A2
  ile A tarafında A1 alır.
- A tarafı daha yüksekse: A2'yi A tarafında satar (A1 alır) + aynı anda B2
  ile B tarafından B1 alır.

İki bacak da **kendi bakiyesinden** besleniyor, bu yüzden bir bacak
başarısız olursa fon kilitlenmez — sadece envanter oranı kayar (örneğin B1
azalır, A2 artar). Bu normal ve beklenen bir durumdur; zamanla ters yönde
işlemler bunu kendiliğinden dengeler.

## Periyodik bakiye transferi (relay hesabı)

- **Çıkış (B -> A)**: doğrulandı, varsayılan açık (`BAL_OUT_ENABLED=true`).
- **Giriş (A -> B)**: memo formatı doğrudan doğrulanamadı, varsayılan
  kapalı (`BAL_IN_ENABLED=false`). Açmadan önce küçük bir miktarla elle
  test edip doğru tarafa kredi geldiğini gördükten sonra aç.

Görev her `BAL_CHECK_MIN` dakikada bir (varsayılan 60) 4 bakiyeyi
kontrol eder; bir taraf `BAL_TRIGGER_*` eşiğinin altına düşerse ve karşı
tarafta yeterli fazlalık varsa `BAL_MOVE_*` kadar transfer eder.

## Kurulum

```
npm ci
```

Repo Secrets (Settings -> Secrets and variables -> Actions -> Secrets):
- `SVC_USER` - bu görevin çalışacağı hesap (ana hesaptan farklı olmalı)
- `SVC_KEY` - o hesabın private key'i

Repo Variables (aynı yer -> Variables), hepsi opsiyonel, varsayılanlar
kodda:
- `LIVE` (varsayılan true) - `false` yaparsan hiçbir şey gönderilmez,
  sadece loglar ("dry run")
- `MIN_GAP_PCT` (varsayılan 0.6) - relay maliyeti düşüldükten **sonraki
  net** farkın altındaysa işleme girmez (bkz. `RELAY_FEE_PCT` /
  `RELAY_LEGS`)
- `MAX_UNIT` (varsayılan 0 = sınırsız, sadece bakiyeyle sınırlı)
- `TOLERANCE_PCT` (varsayılan 1) - sapma payı
- `POLL_INTERVAL_SEC` (varsayılan 20)
- `ORDER_TIMEOUT_SEC` (varsayılan 12) - A tarafı emrinin geçerlilik süresi
- `MIN_RESERVE_A1` / `MIN_RESERVE_A2` / `MIN_RESERVE_B1` / `MIN_RESERVE_B2`
  (varsayılan 1'er) - bu miktarın altına dokunmaz
- `MAX_RUNTIME_MIN` (varsayılan 340)
- `RELAY_ACCOUNT` (varsayılan `graphene-swap`)
- `BAL_ENABLED` (varsayılan true)
- `BAL_OUT_ENABLED` (varsayılan true - doğrulandı)
- `BAL_IN_ENABLED` (varsayılan false - önce elle test et)
- `BAL_CHECK_MIN` (varsayılan 60)
- `BAL_TRIGGER_A1` / `BAL_TRIGGER_A2` / `BAL_TRIGGER_B1` / `BAL_TRIGGER_B2`
  (varsayılan 5'er) - bu eşiğin altına düşerse transfer tetiklenir
- `BAL_MOVE_A1` / `BAL_MOVE_A2` (varsayılan 10'ar) - her transferde
  taşınacak miktar
- `RELAY_FEE_PCT` (varsayılan 0.75) - relay hesabının tek bir transferde
  (çekim ya da yatırım, herhangi biri) kestiği yüzde.
- `RELAY_LEGS` (varsayılan 2) - tek yönde sürdürülen işlem akışının
  ayakta kalması için gereken köprü geçiş sayısı. Sürekli tek yönde
  arbitraj yapıldığında bir taraf biter, öbür taraf birikir; biteni
  **deposit** ile doldurmak, biriken tarafı **withdraw** ile boşaltmak
  gerekir — yani aynı akışı sürdürmek için 2 ayrı transfer (2 x %0.75)
  gerçekleşir. Karar mantığı `effective = RELAY_FEE_PCT x RELAY_LEGS`
  (varsayılan %1.5) kadarını ham fiyat farkından düşer, kalan net farkı
  `MIN_GAP_PCT` ile karşılaştırır. Sadece tek yönlü köprü kullanımından
  eminsen (örn. hep withdraw, deposit hiç açılmayacaksa) `RELAY_LEGS=1`
  yapabilirsin. Ayrıca her fiili relay transferinde gerçekleşen tek
  bacaklık ücret (`RELAY_FEE_PCT`) ayrıca loglanır, çalışma sonunda özet
  (`trades`, `gross~`, `relays`, `relayFee~`) gösterilir. Havuz ücreti
  (`POOL_FEE`, %0.25) ayrıca, zaten fiyat hesabına dahildi.

## Önce mutlaka dry-run ile test et

`LIVE=false` ile birkaç saat çalıştır, loglarda mantıklı değerler
görüyor musun kontrol et. Gerçek bakiyeyle geçmeden önce:

1. Hesapta her iki taraftan da (A1/A2 ve B1/B2) bakiye bulundur.
2. `MAX_UNIT` ile ilk başta küçük bir tavan koy, gözlemleyip sonra aç.
