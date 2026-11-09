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
- Tayyor rang palitralari, muqova rasmi, vaqt hisoblagichi, matn joylashuvi
- '1' shablonida 248 ta effekt: 29 ta GPU kadr filtri (glfx.js asosida + o'zimizniki), 208 ta gl-transitions zarb o'tishi va 11 ta ustki effekt; rasmda ham, videoda ham ishlaydi. Litsenziyalar: THIRD_PARTY_NOTICES.md
- Formatlar: 9:16, 1:1, 4:5, 16:9
- Fon: gradient, rang, rasm yoki **video** (qoraytirish, xiralashtirish)
- Sarlavha, kichik matn, logotip, vaqt chizig‘i
- MP4 eksport: 720p / 1080p / 4K, 30 yoki 60 kadr/soniya, watermark yo‘q

## Windows uchun yuklab olish
GitHub’dagi **Actions → Windows build** bo‘limida eng oxirgi muvaffaqiyatli buildni oching va
**Vizualizator-Windows** faylini yuklab oling. Ichida ikkita fayl bor:
- `Vizualizator Setup 1.0.0.exe` — o‘rnatuvchi
- `Vizualizator 1.0.0.exe` — o‘rnatmasdan ishlaydigan (portable) versiya

## Dasturchilar uchun
```bash
npm install
npm run dev     # brauzerda ishlab chiqish
npm start       # Electron oynasida ishga tushirish
npm run dist    # Windows .exe yig‘ish
```
