# Vizualizator

Musiqa vizualizatori — Windows uchun ilova (o‘zbekcha / русский).

## Imkoniyatlar
- Musiqa yuklash (MP3, WAV, M4A, OGG) va avtomatik tahlil: temp (BPM), zarblar, bass, spektr
- 6 ta shablon: Aylana spektr, Neon to‘lqin, Ekvalayzer, Radar, Rasm titrashi, Yulduzli tunnel
- Formatlar: 9:16, 1:1, 4:5, 16:9
- Fon: gradient, rang yoki rasm (qoraytirish, xiralashtirish)
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
