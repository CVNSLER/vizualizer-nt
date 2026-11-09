# Vizualizator

Musiqa vizualizatori — Windows uchun ilova (o‘zbekcha / русский).

## Imkoniyatlar
- Musiqa yuklash (MP3, WAV, M4A, OGG) va avtomatik tahlil: temp (BPM), zarblar, bass, spektr
- 28 ta shablon, 5 guruhda:
  - **Aylana:** Aylana spektr, Nuqtali aylana, To‘lqinli disk, Neon halqalar, HUD, Yaltiroq zarralar
  - **Chiziq va spektr:** Neon to‘lqin, Elektr chiziq, Spektr tog‘i, Ekvalayzer, LED ekran, 3D to‘lqin yuzasi
  - **Kosmos va 3D:** Yulduzli tunnel, Neon tunnel, Neon shakl, Girdob, Simli shar, Pufakchalar, Kaleydoskop
  - **Retro:** Synthwave, Plastinka, Kasseta, Yurak urishi, Radar
  - **Promo va rasm:** Albom promo, Podkast, Glitch, Rasm titrashi
- Har bir shablonning o‘z sozlamalari: ranglar, hajm, nur, chiziq qalinligi, animatsiya tezligi, sezgirlik, zarbda kattalashish, joylashuv, burilish, aylanish, ko‘zgu
- Muqova rasmi, vaqt hisoblagichi, matn joylashuvi
- **Sifat va yaxshilash**: kamchiliklarni topish va yaxshilash; Standart / **Yuqori** daraja, kuch slayderi (0–100%),
  har bir o‘zgarishni yoqish/o‘chirish va kuchini sozlash, har bir bosqich uchun ↻ qayta ko‘rib chiqish, «Qayta yaxshilash», versiyalar tarixi
- **Studiya** (Musiqa bo‘limidagi tugma):
  - *Mikser* — Musiqa va Master faderlari (0.1 dB qadam, 3 soniyadan keyin qo‘llanadi), panorama; **aqlli rejim**: ovoz ko‘tarilganda limiter (−1 dBTP, oldinga qarovchi), kompressor, bass, tembr, effektlar miqdori o‘zi moslashadi
  - *Parametrik ekvalayzer* — 8 polosa, jonli spektr, nuqtalarni sichqoncha bilan surish, «yoqimsiz tovushni topish» rejimi
  - *Effektlar* — 3 panel: asliga (keyin yaxshilash), yaxshilanganiga, effektlardan keyin yaxshilash; ekvalayzer, kompressor, de-esser, saturatsiya, xorus, delay (temp bo‘yicha), reverb, stereo kenglik, filtr + 10 ta yoqib-o‘chiriladigan tayyor to‘plam (Bassboost bilan)
- Ilova dizayni: 7 ta tayyor rang mavzusi (yorug‘ mavzu ham) yoki o‘z ranglaringiz
- Formatlar: 9:16, 1:1, 4:5, 16:9
- Fon: gradient, rang, rasm yoki **video** (qoraytirish, xiralashtirish)
- Sarlavha, kichik matn, logotip, vaqt chizig‘i
- MP4 eksport: 720p / 1080p / 4K, 30 yoki 60 kadr/soniya, watermark yo‘q

## Windows uchun yuklab olish
GitHub’dagi **Actions → Windows build** bo‘limida eng oxirgi muvaffaqiyatli buildni oching va
**Vizualizator-v1.0-Windows** faylini yuklab oling. Ichida ikkita fayl bor:
- `Vizualizator v1.0 Setup 1.0.0.exe` — o‘rnatuvchi
- `Vizualizator v1.0 1.0.0.exe` — o‘rnatmasdan ishlaydigan (portable) versiya

## Dasturchilar uchun
```bash
npm install
npm run dev     # brauzerda ishlab chiqish
npm start       # Electron oynasida ishga tushirish
npm run dist    # Windows .exe yig‘ish
```
