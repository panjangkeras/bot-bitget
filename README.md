# 🤖 Bitget Scalping Santai v2.2

Bot scalping crypto yang tenang, selektif, dan **belajar dari histori trade-nya sendiri**.  
**Kualitas entry > kuantitas trade.**

---

## ⚡ Quick Start

### 1. Install dependency
```bash
npm install
```

### 2. Buat file `.env`
```bash
cp .env.example .env
```

Isi `.env` — **7 hal yang wajib diisi:**

| Key | Keterangan |
|-----|-----------|
| `BITGET_API_KEY` | API key dari Bitget |
| `BITGET_SECRET_KEY` | Secret key dari Bitget |
| `BITGET_PASSPHRASE` | Passphrase API Bitget |
| `GROQ_API_KEY` | Cerebras API key (gratis di [cerebras.ai](https://cerebras.ai)) |
| `SYMBOLS` | Pair yang mau di-trade, contoh: `BTCUSDT,ETHUSDT,SOLUSDT` |
| `USDT_PER_TRADE` | Modal per trade dalam USDT (minimal $5) |
| `MAX_DAILY_LOSS` | Bot berhenti jika rugi lebih dari ini per hari ($) |

### 3. Jalankan bot
```bash
npm start
```

---

## 🧠 AI Memory — Supabase Integration (Direkomendasikan)

Dengan Supabase, AI tidak lagi buta. Setiap trade tersimpan di cloud dan
dipakai sebagai konteks saat AI mengambil keputusan entry berikutnya.

**Yang AI "pelajari" dari histori:**
- Win-rate per symbol dan per side (LONG vs SHORT)
- Pola exit yang sering terjadi (SL hit, TP1, TP2, RSI extreme)
- Streak loss/win terkini → AI lebih konservatif saat sedang loss streak
- Apakah leverage yang dipakai terlalu tinggi untuk token tertentu

### Setup Supabase (5 menit)

**1. Buat project Supabase gratis**
- Daftar di [supabase.com](https://supabase.com) → New Project
- Tunggu project selesai provisioning (~1-2 menit)

**2. Jalankan schema SQL**
- Buka: Supabase Dashboard → **SQL Editor** → New query
- Copy-paste isi file `supabase_schema.sql` → klik **Run**
- Harusnya muncul tabel `trades`, `signals`, dan view `win_stats_by_symbol`

**3. Ambil credentials**
- Buka: Settings → **API**
- Copy **Project URL** → `SUPABASE_URL` di `.env`
- Copy **anon public** key → `SUPABASE_ANON_KEY` di `.env`

**4. Import histori trade lama (opsional)**
```bash
node importTrades.js
```

**5. Verifikasi**
```bash
npm start
# Harusnya muncul log: "✅ Supabase connected!"
# Atau: "⚠️ Supabase tidak aktif — mode lokal saja" (kalau belum dikonfigurasi)
```

> **Catatan:** Supabase sepenuhnya opsional. Bot tetap jalan normal tanpa Supabase,
> AI hanya tidak punya memori histori trade.

---

## 🚀 Deploy ke Railway

Railway adalah platform cloud yang cocok untuk bot Node.js — lebih murah dari VPS
dan auto-restart jika crash.

### Setup Railway

**1. Push ke GitHub dulu**
```bash
git init
git add .
git commit -m "initial"
git remote add origin https://github.com/username/repo-name.git
git push -u origin main
```

**2. Buat project Railway**
- Daftar di [railway.app](https://railway.app)
- New Project → Deploy from GitHub repo → pilih repo bot ini

**3. Set environment variables di Railway**
- Buka project → tab **Variables**
- Klik **Add Variable** untuk setiap key di `.env`
- Yang wajib: semua key Bitget, GROQ_API_KEY, SYMBOLS, USDT_PER_TRADE, MAX_DAILY_LOSS
- Jika pakai Supabase: tambahkan SUPABASE_URL dan SUPABASE_ANON_KEY

**4. Pastikan `railway.json` atau `Procfile` ada**

Buat file `Procfile` di root project:
```
worker: node --no-deprecation index.js
```

Atau buat `railway.json`:
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "node --no-deprecation index.js",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

**5. Deploy**
- Railway otomatis build dan deploy setelah push ke GitHub
- Lihat log di tab **Deployments**

### Monitoring di Railway
```
Tabs yang berguna:
- Deployments → lihat log real-time
- Variables    → edit env vars
- Metrics      → CPU dan memory usage
```

> **Penting:** Railway free tier punya limit $5/bulan. Bot scalping yang jalan
> 24/7 biasanya butuh plan Hobby (~$5/bulan) atau Pro.

---

## 🎯 Filosofi Scalping Santai

| Aspek | Nilai |
|-------|-------|
| Leverage | 10x – 30x (AI pilih otomatis) |
| Entry minimal | $5 |
| Interval tick | 45 detik |
| Min confidence | 65% |
| Max posisi bersamaan | 2 (default) |
| Skip entry jam | 19.01 – 22.59 WIB |

**Multi-Timeframe:**
- `30m` + `15m` → tentukan arah trend utama
- `5m` → konfirmasi momentum
- `1m` → entry presisi

---

## 📁 Struktur File

```
├── index.js              ← Main loop bot
├── groqAnalyzer.js       ← AI decision engine (Cerebras)
├── technicalAnalysis.js  ← Indikator teknikal (RSI, MACD, BB, dll)
├── positionManager.js    ← TP1/TP2/Trailing SL logic
├── pnlTracker.js         ← Track PnL + sync ke Supabase (v2.2)
├── supabaseClient.js     ← Koneksi ke Supabase REST API     [BARU]
├── tradeMemory.js        ← Build AI context dari histori     [BARU]
├── importTrades.js       ← Import trades.json ke Supabase   [BARU]
├── supabase_schema.sql   ← Schema tabel Supabase            [BARU]
├── bitgetClient.js       ← Bitget Futures REST API v2
├── fundingRate.js        ← Funding rate filter
├── newsFetcher.js        ← Ambil headline berita
├── notifier.js           ← Kirim notifikasi Telegram
├── slTpTable.js          ← SL/TP table berdasarkan leverage
├── scanTokens.js         ← Scan token dengan ATR terbaik
├── logger.js             ← Colored console logger
├── trades.json           ← Local trade history backup
└── ecosystem.config.js   ← PM2 config (opsional)
```

---

## 🔍 Scan Token Terbaik

Sebelum mulai, scan token yang ATR-nya cocok:
```bash
npm run scan
```

---

## 🛡 Fitur Keamanan

- **AI Memory** — AI belajar dari histori trade, tidak bodoh lagi
- **Max daily loss** — bot otomatis berhenti entry jika sudah rugi sesuai limit
- **Funding rate filter** — skip entry jika pasar sudah crowded satu arah
- **Correlation filter** — hindari posisi berlawanan di pair berkorelasi
- **Session filter** — skip entry jam sepi (19:01–22:59 WIB)
- **RSI extreme filter** — tidak masuk saat RSI terlalu overbought/oversold
- **Volume filter** — hanya entry saat volume cukup
- **Trailing stop** — SL otomatis naik setelah TP1 tercapai
- **Break even** — SL dipindah ke harga entry setelah TP1

---

## ⚠️ Disclaimer

Bot ini untuk edukasi. Trading crypto futures berisiko tinggi.  
Selalu gunakan modal yang siap hilang. Pantau bot secara berkala.
