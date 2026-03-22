# Risk One 2x

Bu proje Dexscreener verisi ile yeni Solana pair'lerini tarayan ve uygun sinyalleri Telegram botuna bildiren bir Next.js panelidir.

Sinyal mantigi:

- Dexscreener verisi ile sadece `solana` pair'lerini tarar
- Sadece son `1-24 saat` icinde acilan pair'leri degerlendirir
- Likidite, hacim, alis/satis ve fiyat ivmesine gore skor uretir
- Sadece `NOW` giris sinyallerini bildirir
- Ayni pair icin tekrar tekrar Telegram mesaji gondermez

Calistirmak icin:

```bash
npm install
npm run dev
```

Telegram kurulumu:

1. BotFather uzerinden bir bot olustur ve token al.
2. Bot ile bir sohbet baslat.
3. `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` cagrisi ile `chat.id` degerini bul.
4. `.env.local` dosyasina su alanlari ekle:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Varsayilan adres:

```text
http://localhost:3001
```
