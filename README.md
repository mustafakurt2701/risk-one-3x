# Risk One 2x

Bu proje ayri bir Next.js paper-trade panelidir.

Strateji:

- Dexscreener verisi ile sadece `solana` pair'lerini tarar
- Sadece son `6-24 saat` icinde acilan pair'leri degerlendirir
- Islem basi maksimum risk `%10`
- Stop loss `-50%`
- Take profit `2x`
- Pozisyon boyutu sermayenin `%20`'si olacak sekilde hesaplanir
- En fazla `3` acik pozisyon tutar
- Momentum kaybolursa `EARLY EXIT` yapar
- Rug ve sahte spike durumlarini filtrelemeye calisir

Calistirmak icin:

```bash
npm install
npm run dev
```

Varsayilan adres:

```text
http://localhost:3001
```
