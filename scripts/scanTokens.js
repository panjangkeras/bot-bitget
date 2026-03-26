require('dotenv').config();
const { BitgetClient } = require('../src/core/bitgetClient');
const c = new BitgetClient({
  apiKey    : process.env.BITGET_API_KEY,
  secretKey : process.env.BITGET_SECRET_KEY,
  passphrase: process.env.BITGET_PASSPHRASE,
});

// ═══════════════════════════════════════════════════════════════════════════
//  SCANNER CONFIG — 1m entry | 5m konfirmasi | 15/30m trend
//  Target: Market tidak liar, liquidity tinggi, momentum terukur
// ═══════════════════════════════════════════════════════════════════════════

// ─── BLUECHIP ONLY (tidak ada altcoin liar) ──────────────────────────────
const BLUECHIP = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOTUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT',
  'MATICUSDT', 'UNIUSDT', 'ATOMUSDT', 'NEARUSDT', 'FILUSDT',
  'APTUSDT', 'OPUSDT', 'ARBUSDT', 'INJUSDT', 'SUIUSDT',
];

// ─── VOLUME & LIQUIDITY (ketat) ──────────────────────────────────────────
const MIN_VOL_USD        = 50_000_000;   // $50M minimum (dari $10M) — lebih likuid
const MIN_VOL_SPIKE_MULT = 0.8;          // Volume candle terkini minimal 80% dari rata-rata
const MAX_VOL_SPIKE_MULT = 4.0;          // Batas atas: spike ekstrem = manipulasi

// ─── VOLATILITY 24H (tidak terlalu flat, tidak liar) ────────────────────
const MIN_VOLAT_24H  = 1.5;   // minimal ada gerak
const MAX_VOLAT_24H  = 10.0;  // max 10% range 24h (dari 15% — lebih ketat)
const MAX_CHANGE_24H = 8.0;   // max 8% change (dari 20% — filter momentum ekstrem)

// ─── ATR SWEET SPOT (smooth scalping) ───────────────────────────────────
// Lebih sempit dari sebelumnya → hanya ambil yang paling "terkontrol"
const ATR_1M_MIN  = 0.04;   // % dari harga
const ATR_1M_MAX  = 0.18;   // dipersempit dari 0.30 → lebih smooth
const ATR_5M_MIN  = 0.08;
const ATR_5M_MAX  = 0.40;   // dipersempit dari 0.60
const ATR_15M_MIN = 0.12;
const ATR_15M_MAX = 0.70;

// ─── RSI FILTER (hindari zona ekstrem) ──────────────────────────────────
// RSI 1m: 35–65   → zone netral, tidak OB/OS
// RSI 5m: 40–60   → konfirmasi lebih ketat
// RSI 15m: 30–70  → trend check, beri ruang lebih
const RSI_1M_MIN  = 35;  const RSI_1M_MAX  = 65;
const RSI_5M_MIN  = 40;  const RSI_5M_MAX  = 60;
const RSI_15M_MIN = 30;  const RSI_15M_MAX = 70;

// ════════════════════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

function parseCandles(raw) {
  return raw.map(c => ({
    time : parseInt(c[0]),
    open : parseFloat(c[1]),
    high : parseFloat(c[2]),
    low  : parseFloat(c[3]),
    close: parseFloat(c[4]),
    vol  : parseFloat(c[5]),
  }));
}

// ATR — Average True Range
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h  = candles[i].high;
    const l  = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// RSI — Relative Strength Index (Wilder smoothing)
function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50; // default netral jika data kurang
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }
  let avgGain = gains  / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Volume Spike — bandingkan candle terbaru vs rata-rata N candle
function calcVolSpike(candles, lookback = 10) {
  if (candles.length < lookback + 1) return 1;
  const recent = candles[candles.length - 1].vol;
  const avg    = candles.slice(-lookback - 1, -1)
                        .reduce((s, c) => s + c.vol, 0) / lookback;
  return avg > 0 ? recent / avg : 1;
}

// Trend direction dari 15m / 30m (EMA20 slope)
function calcEMASlope(candles, period = 20) {
  if (candles.length < period + 5) return 0;
  const ema = (arr, p) => {
    const k = 2 / (p + 1);
    let e = arr.slice(0, p).reduce((s, c) => s + c.close, 0) / p;
    for (let i = p; i < arr.length; i++) e = arr[i].close * k + e * (1 - k);
    return e;
  };
  const emaFull  = ema(candles, period);
  const emaPrev  = ema(candles.slice(0, -3), period);
  return ((emaFull - emaPrev) / emaPrev) * 100; // % slope
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════════════════════
//  SCORING SYSTEM  (total 100 poin)
// ════════════════════════════════════════════════════════════════════════════
//
//  [30] Volume & Liquidity
//      • Volume 24h (log scale, cap $500M)
//      • Volume spike dalam zona ideal (0.8x–2x avg)
//
//  [30] ATR Quality
//      • 1m ATR: makin dekat ke midpoint sweet spot makin tinggi
//      • 5m ATR: konfirmasi konsistensi volatility
//
//  [20] RSI Neutrality
//      • 1m RSI: bonus maksimal jika 45–55 (paling netral)
//      • 5m RSI: konfirmasi
//      • 15m RSI: trend health
//
//  [20] Stability
//      • Change 24h rendah = lebih bisa diprediksi
//      • ATR 15m terkontrol = trend tidak panik

function calcScore(t) {
  // ── Volume score (30) ──────────────────────────────────────────────────
  const volLogScore  = Math.min(Math.log10(t.vol24h / 1_000_000) / Math.log10(500), 1) * 20;
  // Volume spike ideal: 0.8–2.0x = scalping dengan konfirmasi momentum
  const spikeScore   = (t.volSpike >= 0.8 && t.volSpike <= 2.0)
                       ? 10
                       : (t.volSpike > 2.0 && t.volSpike <= 3.0) ? 5 : 0;
  const volScore     = volLogScore + spikeScore;

  // ── ATR score (30) ────────────────────────────────────────────────────
  const atr1mMid     = (ATR_1M_MIN + ATR_1M_MAX) / 2;
  const atr1mDist    = Math.abs(t.atr1mPct - atr1mMid) / atr1mMid;
  const atr5mMid     = (ATR_5M_MIN + ATR_5M_MAX) / 2;
  const atr5mDist    = Math.abs(t.atr5mPct - atr5mMid) / atr5mMid;
  const atrScore     = ((1 - Math.min(atr1mDist, 1)) * 18) +
                       ((1 - Math.min(atr5mDist, 1)) * 12);

  // ── RSI score (20) ────────────────────────────────────────────────────
  // 1m RSI: 45–55 dapat full 10 poin, makin jauh makin turun
  const rsi1mCenter  = 50;
  const rsi1mDist    = Math.abs(t.rsi1m - rsi1mCenter) / 15; // normalize ke 15 unit
  const rsi1mScore   = (1 - Math.min(rsi1mDist, 1)) * 10;

  const rsi5mCenter  = 50;
  const rsi5mDist    = Math.abs(t.rsi5m - rsi5mCenter) / 10;
  const rsi5mScore   = (1 - Math.min(rsi5mDist, 1)) * 6;

  const rsi15mScore  = (t.rsi15m >= 40 && t.rsi15m <= 60) ? 4 : 2;
  const rsiScore     = rsi1mScore + rsi5mScore + rsi15mScore;

  // ── Stability score (20) ──────────────────────────────────────────────
  const changeScore  = t.change24h <= 3  ? 12 :
                       t.change24h <= 5  ? 10 :
                       t.change24h <= 8  ? 7  : 4;
  const atr15mMid    = (ATR_15M_MIN + ATR_15M_MAX) / 2;
  const atr15mDist   = Math.abs(t.atr15mPct - atr15mMid) / atr15mMid;
  const stabAtrScore = (1 - Math.min(atr15mDist, 1)) * 8;
  const stabScore    = changeScore + stabAtrScore;

  return parseFloat((volScore + atrScore + rsiScore + stabScore).toFixed(1));
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN SCAN
// ════════════════════════════════════════════════════════════════════════════
async function scan() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   BITGET FUTURES SCANNER — Bluechip Scalping 1m/5m/15m      ║');
  console.log('║   Filter: Liquidity • ATR Sweet Spot • RSI Neutral • Smooth  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const tickers = await c._request('GET', '/api/v2/mix/market/tickers', {
    productType: 'USDT-FUTURES',
  });

  // ── Step 1: Filter kasar — bluechip + volume + volatility ───────────────
  const candidates = tickers.filter(t => {
    if (!BLUECHIP.includes(t.symbol)) return false; // BLUECHIP ONLY

    const vol      = parseFloat(t.usdtVolume) || 0;
    const price    = parseFloat(t.lastPr) || 0;
    const change   = Math.abs(parseFloat(t.change24h) || 0) * 100;
    const high24h  = parseFloat(t.high24h) || price;
    const low24h   = parseFloat(t.low24h) || price;
    const volat    = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 0;

    return (
      vol   >= MIN_VOL_USD &&
      price  > 0 &&
      volat >= MIN_VOLAT_24H &&
      volat <= MAX_VOLAT_24H &&
      change <= MAX_CHANGE_24H
    );
  });

  console.log(`  ✔ Step 1 — Bluechip filter  : ${candidates.length} / ${BLUECHIP.length} lolos`);
  console.log(`  ✔ Step 2 — Fetch candle 1m, 5m, 15m + hitung ATR / RSI / VolSpike...\n`);

  const results = [];

  for (let i = 0; i < candidates.length; i++) {
    const t     = candidates[i];
    const sym   = t.symbol;
    const price = parseFloat(t.lastPr) || 1;

    try {
      // Fetch 3 timeframe sekaligus
      const [raw1m, raw5m, raw15m] = await Promise.all([
        c._request('GET', '/api/v2/mix/market/candles', {
          symbol: sym, productType: 'USDT-FUTURES', granularity: '1m', limit: '50',
        }),
        c._request('GET', '/api/v2/mix/market/candles', {
          symbol: sym, productType: 'USDT-FUTURES', granularity: '5m', limit: '30',
        }),
        c._request('GET', '/api/v2/mix/market/candles', {
          symbol: sym, productType: 'USDT-FUTURES', granularity: '15m', limit: '30',
        }),
      ]);

      const c1m  = parseCandles(raw1m);
      const c5m  = parseCandles(raw5m);
      const c15m = parseCandles(raw15m);

      // ── ATR ─────────────────────────────────────────────────────────────
      const atr1m    = calcATR(c1m,  14);
      const atr5m    = calcATR(c5m,  14);
      const atr15m   = calcATR(c15m, 14);
      const atr1mPct = (atr1m  / price) * 100;
      const atr5mPct = (atr5m  / price) * 100;
      const atr15mPct= (atr15m / price) * 100;

      // ── ATR Gate ─────────────────────────────────────────────────────────
      if (!(atr1mPct >= ATR_1M_MIN  && atr1mPct  <= ATR_1M_MAX))  continue;
      if (!(atr5mPct >= ATR_5M_MIN  && atr5mPct  <= ATR_5M_MAX))  continue;
      if (!(atr15mPct>= ATR_15M_MIN && atr15mPct <= ATR_15M_MAX)) continue;

      // ── RSI ──────────────────────────────────────────────────────────────
      const rsi1m  = calcRSI(c1m,  14);
      const rsi5m  = calcRSI(c5m,  14);
      const rsi15m = calcRSI(c15m, 14);

      // ── RSI Gate ──────────────────────────────────────────────────────────
      if (!(rsi1m  >= RSI_1M_MIN  && rsi1m  <= RSI_1M_MAX))  continue;
      if (!(rsi5m  >= RSI_5M_MIN  && rsi5m  <= RSI_5M_MAX))  continue;
      if (!(rsi15m >= RSI_15M_MIN && rsi15m <= RSI_15M_MAX)) continue;

      // ── Volume Spike ───────────────────────────────────────────────────
      const volSpike = calcVolSpike(c1m, 10);
      if (volSpike < MIN_VOL_SPIKE_MULT || volSpike > MAX_VOL_SPIKE_MULT) continue;

      // ── Trend (EMA slope 15m) ───────────────────────────────────────────
      const trendSlope = calcEMASlope(c15m, 20);
      const trendLabel = trendSlope >  0.05 ? '↑ UP'   :
                         trendSlope < -0.05 ? '↓ DOWN' : '→ FLAT';

      // ── Collect data ───────────────────────────────────────────────────
      const vol24h    = parseFloat(t.usdtVolume) || 0;
      const change24h = Math.abs(parseFloat(t.change24h) || 0) * 100;
      const high24h   = parseFloat(t.high24h) || price;
      const low24h    = parseFloat(t.low24h)  || price;
      const volat24h  = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 0;

      const entry = {
        symbol    : sym,
        price,
        vol24h,
        change24h : +change24h.toFixed(2),
        volat24h  : +volat24h.toFixed(2),
        atr1mPct  : +atr1mPct.toFixed(4),
        atr5mPct  : +atr5mPct.toFixed(4),
        atr15mPct : +atr15mPct.toFixed(4),
        rsi1m     : +rsi1m.toFixed(1),
        rsi5m     : +rsi5m.toFixed(1),
        rsi15m    : +rsi15m.toFixed(1),
        volSpike  : +volSpike.toFixed(2),
        trendSlope: +trendSlope.toFixed(4),
        trendLabel,
      };

      entry.score = calcScore(entry);
      results.push(entry);

    } catch (e) {
      // skip — bisa karena symbol tidak tersedia di futures
    }

    // Rate limit protection (3 request per token)
    await sleep(200);
  }

  // ── Step 3: Sort & Display ─────────────────────────────────────────────
  results.sort((a, b) => b.score - a.score);

  console.log(`  ✔ Step 3 — ${results.length} token lolos semua filter\n`);

  if (results.length === 0) {
    console.log('  ⚠️  Tidak ada token yang lolos semua filter saat ini.');
    console.log('     Coba longgarkan RSI_5M atau MAX_CHANGE_24H di config.\n');
    return;
  }

  // ── Print Full Table ───────────────────────────────────────────────────
  console.log('═'.repeat(95));
  console.log('  HASIL SCAN — Diurutkan dari score tertinggi');
  console.log('  ★ = ATR 1m di zona emas (0.07–0.14%) | ▲ = Trend UP | ▼ = Trend DOWN');
  console.log('═'.repeat(95));
  console.log(
    'Symbol'.padEnd(13) +
    'Price'.padEnd(12) +
    'Vol($M)'.padEnd(9) +
    'ATR1m%'.padEnd(9) +
    'ATR5m%'.padEnd(9) +
    'RSI1m'.padEnd(8) +
    'RSI5m'.padEnd(8) +
    'RSI15m'.padEnd(8) +
    'Spike'.padEnd(8) +
    'Trend'.padEnd(8) +
    'Score'
  );
  console.log('-'.repeat(95));

  results.forEach(t => {
    const star  = (t.atr1mPct >= 0.07 && t.atr1mPct <= 0.14) ? ' ★' : '  ';
    const trend = t.trendLabel;
    console.log(
      (t.symbol + star).padEnd(13) +
      t.price.toPrecision(4).padEnd(12) +
      ((t.vol24h / 1e6).toFixed(0) + 'M').padEnd(9) +
      (t.atr1mPct + '%').padEnd(9) +
      (t.atr5mPct + '%').padEnd(9) +
      t.rsi1m.toString().padEnd(8) +
      t.rsi5m.toString().padEnd(8) +
      t.rsi15m.toString().padEnd(8) +
      (t.volSpike + 'x').padEnd(8) +
      trend.padEnd(8) +
      t.score
    );
  });

  // ── Rekomendasi Final ──────────────────────────────────────────────────
  const top = results.slice(0, 6);
  const rec = top.map(t => t.symbol);

  console.log('\n' + '═'.repeat(95));
  console.log('  ✅  REKOMENDASI UNTUK SCALPING SEKARANG');
  console.log('      Kriteria: Score tertinggi + RSI netral + ATR smooth + Trend jelas');
  console.log('═'.repeat(95));
  console.log('');
  console.log(`  SYMBOLS=${rec.join(',')}`);
  console.log('');

  top.forEach((t, idx) => {
    const reasons = [];
    if (t.atr1mPct >= 0.07 && t.atr1mPct <= 0.14)  reasons.push('ATR zona emas');
    if (t.rsi1m   >= 45    && t.rsi1m   <= 55)      reasons.push('RSI 1m sangat netral');
    if (t.volSpike >= 0.9  && t.volSpike <= 1.5)    reasons.push('volume stabil');
    if (t.trendLabel.includes('UP'))                 reasons.push('trend 15m naik');
    if (t.trendLabel.includes('FLAT'))               reasons.push('sideways bersih');
    if (t.vol24h >= 200_000_000)                     reasons.push('super liquid');

    console.log(
      `  ${idx + 1}. ${t.symbol.padEnd(12)} Score: ${t.score.toString().padEnd(7)}` +
      `ATR1m: ${t.atr1mPct}%  RSI: ${t.rsi1m}/${t.rsi5m}/${t.rsi15m}  ` +
      (reasons.length ? `[${reasons.join(' · ')}]` : '')
    );
  });

  console.log('');
  console.log('  ⚡ Tips:');
  console.log('     • Entry saat RSI 1m baru keluar dari 40–45 (long) atau 55–60 (short)');
  console.log('     • Konfirmasi 5m harus searah trend 15m');
  console.log('     • Skip jika volume spike > 3x (kemungkinan news/manipulasi)');
  console.log('     • ATR zona emas ★ = target TP bisa 2–3x ATR dengan risiko terkontrol');
  console.log('');
  console.log('═'.repeat(95));
}

scan().catch(console.error);