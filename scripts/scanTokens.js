require('dotenv').config();
const { BitgetClient } = require('../src/core/bitgetClient');
const c = new BitgetClient({
  apiKey    : process.env.BITGET_API_KEY,
  secretKey : process.env.BITGET_SECRET_KEY,
  passphrase: process.env.BITGET_PASSPHRASE,
});

// ═══════════════════════════════════════════════════════════════════════════
//  SCANNER CONFIG — 1m entry | 5m konfirmasi | 15m trend
// ═══════════════════════════════════════════════════════════════════════════

const BLUECHIP = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOTUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT',
  'MATICUSDT', 'UNIUSDT', 'ATOMUSDT', 'NEARUSDT', 'FILUSDT',
  'APTUSDT', 'OPUSDT', 'ARBUSDT', 'INJUSDT', 'SUIUSDT',
];

// ── VOLUME 24H (hard gate) ────────────────────────────────────────────────
const MIN_VOL_USD    = 20_000_000;   // $20M minimum

// ── VOLATILITY 24H (hard gate) ───────────────────────────────────────────
const MIN_VOLAT_24H  = 1.0;
const MAX_VOLAT_24H  = 15.0;
const MAX_CHANGE_24H = 15.0;

// ── ATR (hard gate) ───────────────────────────────────────────────────────
const ATR_1M_MIN  = 0.03;
const ATR_1M_MAX  = 0.25;
const ATR_5M_MIN  = 0.06;
const ATR_5M_MAX  = 0.55;
const ATR_15M_MIN = 0.10;
const ATR_15M_MAX = 1.00;

// ── RSI (hard gate) ───────────────────────────────────────────────────────
// Hanya RSI 15m yang jadi gate (trend health)
// RSI 1m & 5m dijadikan INFO + komponen scoring saja
// Karena RSI 1m/5m berubah sangat cepat dan sering false reject
const RSI_15M_MIN = 25;
const RSI_15M_MAX = 75;

// ── VOL SPIKE — INFO ONLY, bukan gate ────────────────────────────────────
// Spike rendah (< 0.5x) = market sepi/consolidation = justru bagus untuk scalping smooth
// Spike tinggi (> 4x)   = waspada news/manipulasi, tapi masih boleh masuk dengan catatan
// Nilai ini hanya dipakai untuk label & scoring, tidak memblokir token

// ════════════════════════════════════════════════════════════════════════════
//  UTILITY
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

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i-1].close;
    if (d >= 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i-1].close;
    ag = (ag * (period - 1) + Math.max(d, 0))  / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

function calcVolSpike(candles, lookback = 10) {
  if (candles.length < lookback + 1) return 1;
  const recent = candles[candles.length - 1].vol;
  const avg    = candles.slice(-lookback - 1, -1).reduce((s, c) => s + c.vol, 0) / lookback;
  return avg > 0 ? recent / avg : 1;
}

// Volume rata-rata 10 candle terakhir (bukan hanya candle terkini)
function calcVolAvgRatio(candles, lookback = 10) {
  if (candles.length < lookback + 1) return 1;
  const recent = candles.slice(-lookback).reduce((s, c) => s + c.vol, 0) / lookback;
  const base   = candles.slice(-lookback * 2, -lookback).reduce((s, c) => s + c.vol, 0) / lookback;
  return base > 0 ? recent / base : 1;
}

function calcEMASlope(candles, period = 20) {
  if (candles.length < period + 5) return 0;
  const ema = (arr, p) => {
    const k = 2 / (p + 1);
    let e = arr.slice(0, p).reduce((s, x) => s + x.close, 0) / p;
    for (let i = p; i < arr.length; i++) e = arr[i].close * k + e * (1 - k);
    return e;
  };
  const prev = ema(candles.slice(0, -3), period);
  return prev > 0 ? ((ema(candles, period) - prev) / prev) * 100 : 0;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════════════════════
//  LABEL HELPERS
// ════════════════════════════════════════════════════════════════════════════

function spikeLabel(spike) {
  if (spike < 0.3)  return '😴 sepi';
  if (spike < 0.8)  return '🔵 tenang';
  if (spike <= 2.0) return '✅ normal';
  if (spike <= 4.0) return '🟡 aktif';
  return '🔴 spike!';
}

function rsiLabel(rsi) {
  if (rsi < 30)  return '🔴 OS';
  if (rsi < 40)  return '🟡 lemah';
  if (rsi <= 60) return '✅ netral';
  if (rsi <= 70) return '🟡 kuat';
  return '🔴 OB';
}

// ════════════════════════════════════════════════════════════════════════════
//  SCORING (100 poin)
// ════════════════════════════════════════════════════════════════════════════
function calcScore(t) {
  // Volume 24h (20 poin)
  const volScore = Math.min(Math.log10(t.vol24h / 1_000_000) / Math.log10(500), 1) * 20;

  // ATR quality (30 poin) — makin dekat midpoint sweet spot = makin tinggi
  const atr1mMid  = (ATR_1M_MIN + ATR_1M_MAX) / 2;
  const atr5mMid  = (ATR_5M_MIN + ATR_5M_MAX) / 2;
  const atrScore  = ((1 - Math.min(Math.abs(t.atr1mPct  - atr1mMid) / atr1mMid,  1)) * 18) +
                    ((1 - Math.min(Math.abs(t.atr5mPct  - atr5mMid) / atr5mMid,  1)) * 12);

  // RSI neutrality (25 poin) — semua TF dijadikan scoring
  const rsi1mScore  = (1 - Math.min(Math.abs(t.rsi1m  - 50) / 20, 1)) * 10;
  const rsi5mScore  = (1 - Math.min(Math.abs(t.rsi5m  - 50) / 20, 1)) * 10;
  const rsi15mScore = (1 - Math.min(Math.abs(t.rsi15m - 50) / 25, 1)) * 5;

  // Stability (15 poin)
  const changeScore = t.change24h <= 3 ? 10 : t.change24h <= 6 ? 8 :
                      t.change24h <= 10 ? 5 : 2;
  const atr15mMid   = (ATR_15M_MIN + ATR_15M_MAX) / 2;
  const stabScore   = changeScore +
                      (1 - Math.min(Math.abs(t.atr15mPct - atr15mMid) / atr15mMid, 1)) * 5;

  // Vol activity bonus (10 poin) — sepi masih dapat poin, normal dapat full
  const volActivityScore = t.volAvgRatio >= 0.8 && t.volAvgRatio <= 2.5 ? 10 :
                           t.volAvgRatio >= 0.4 ? 7 : 4;

  return +((volScore + atrScore + rsi1mScore + rsi5mScore + rsi15mScore +
            stabScore + volActivityScore)).toFixed(1);
}

function diagFail(sym, reasons) {
  console.log(`   ✗ ${sym.padEnd(13)} → ${reasons.join(' | ')}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  MAIN SCAN
// ════════════════════════════════════════════════════════════════════════════
async function scan() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   BITGET FUTURES SCANNER — Bluechip Scalping 1m/5m/15m      ║');
  console.log('║   Gate: Vol24h · ATR · RSI-15m   |   Info: RSI1m/5m · Spike ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const tickers = await c._request('GET', '/api/v2/mix/market/tickers', {
    productType: 'USDT-FUTURES',
  });

  // ── Step 1: filter kasar ─────────────────────────────────────────────────
  const inFutures  = tickers.filter(t => BLUECHIP.includes(t.symbol));
  const candidates = inFutures.filter(t => {
    const vol   = parseFloat(t.usdtVolume) || 0;
    const price = parseFloat(t.lastPr) || 0;
    const chg   = Math.abs(parseFloat(t.change24h) || 0) * 100;
    const h24   = parseFloat(t.high24h) || price;
    const l24   = parseFloat(t.low24h)  || price;
    const volat = l24 > 0 ? ((h24 - l24) / l24) * 100 : 0;
    return vol >= MIN_VOL_USD && price > 0 &&
           volat >= MIN_VOLAT_24H && volat <= MAX_VOLAT_24H &&
           chg <= MAX_CHANGE_24H;
  });

  // Tampilkan rejects Step 1
  const failStep1 = inFutures.filter(t => !candidates.find(x => x.symbol === t.symbol));
  if (failStep1.length) {
    console.log('  ── Step 1 rejects:');
    failStep1.forEach(t => {
      const vol   = parseFloat(t.usdtVolume) || 0;
      const price = parseFloat(t.lastPr) || 0;
      const chg   = Math.abs(parseFloat(t.change24h) || 0) * 100;
      const h24   = parseFloat(t.high24h) || price;
      const l24   = parseFloat(t.low24h)  || price;
      const volat = l24 > 0 ? ((h24 - l24) / l24) * 100 : 0;
      const why   = [];
      if (vol   <  MIN_VOL_USD)    why.push(`vol $${(vol/1e6).toFixed(0)}M`);
      if (volat <  MIN_VOLAT_24H)  why.push(`volat ${volat.toFixed(1)}% flat`);
      if (volat >  MAX_VOLAT_24H)  why.push(`volat ${volat.toFixed(1)}% liar`);
      if (chg   >  MAX_CHANGE_24H) why.push(`change ${chg.toFixed(1)}%`);
      diagFail(t.symbol, why.length ? why : ['tidak aktif']);
    });
    console.log('');
  }

  const notFound = BLUECHIP.filter(s => !inFutures.find(t => t.symbol === s));
  if (notFound.length) {
    console.log('  ── Tidak ada di Bitget Futures: ' + notFound.join(', '));
    console.log('');
  }

  console.log(`  ✔ Step 1 — ${candidates.length} / ${BLUECHIP.length} lolos filter 24h`);
  console.log(`  ✔ Step 2 — Fetch candle 1m/5m/15m...\n`);
  console.log('  ── Step 2 detail:');

  const results = [];

  for (let i = 0; i < candidates.length; i++) {
    const t     = candidates[i];
    const sym   = t.symbol;
    const price = parseFloat(t.lastPr) || 1;

    try {
      const [raw1m, raw5m, raw15m] = await Promise.all([
        c._request('GET', '/api/v2/mix/market/candles', {
          symbol: sym, productType: 'USDT-FUTURES', granularity: '1m', limit: '50',
        }),
        c._request('GET', '/api/v2/mix/market/candles', {
          symbol: sym, productType: 'USDT-FUTURES', granularity: '5m', limit: '30',
        }),
        c._request('GET', '/api/v2/mix/market/candles', {
          symbol: sym, productType: 'USDT-FUTURES', granularity: '15m', limit: '40',
        }),
      ]);

      const c1m  = parseCandles(raw1m);
      const c5m  = parseCandles(raw5m);
      const c15m = parseCandles(raw15m);

      const atr1mPct  = (calcATR(c1m,  14) / price) * 100;
      const atr5mPct  = (calcATR(c5m,  14) / price) * 100;
      const atr15mPct = (calcATR(c15m, 14) / price) * 100;
      const rsi1m     = calcRSI(c1m,  14);
      const rsi5m     = calcRSI(c5m,  14);
      const rsi15m    = calcRSI(c15m, 14);
      const volSpike  = calcVolSpike(c1m, 10);
      const volAvgRatio = calcVolAvgRatio(c1m, 10);
      const slope     = calcEMASlope(c15m, 20);
      const trendLabel = slope > 0.05 ? '↑ UP' : slope < -0.05 ? '↓ DN' : '→ FL';

      // ── HARD GATES (hanya 3) ────────────────────────────────────────────
      const why = [];
      if (!(atr1mPct  >= ATR_1M_MIN  && atr1mPct  <= ATR_1M_MAX))
        why.push(`ATR1m ${atr1mPct.toFixed(3)}% [${ATR_1M_MIN}–${ATR_1M_MAX}]`);
      if (!(atr5mPct  >= ATR_5M_MIN  && atr5mPct  <= ATR_5M_MAX))
        why.push(`ATR5m ${atr5mPct.toFixed(3)}% [${ATR_5M_MIN}–${ATR_5M_MAX}]`);
      if (!(atr15mPct >= ATR_15M_MIN && atr15mPct <= ATR_15M_MAX))
        why.push(`ATR15m ${atr15mPct.toFixed(3)}% [${ATR_15M_MIN}–${ATR_15M_MAX}]`);
      if (!(rsi15m >= RSI_15M_MIN && rsi15m <= RSI_15M_MAX))
        why.push(`RSI15m ${rsi15m.toFixed(0)} [${RSI_15M_MIN}–${RSI_15M_MAX}]`);

      if (why.length) {
        // Tetap tampilkan info RSI 1m/5m sebagai konteks
        const info = `RSI ${rsi1m.toFixed(0)}/${rsi5m.toFixed(0)}/${rsi15m.toFixed(0)} | spike ${volSpike.toFixed(2)}x`;
        diagFail(sym, [...why, info]);
        continue;
      }

      const vol24h    = parseFloat(t.usdtVolume) || 0;
      const change24h = Math.abs(parseFloat(t.change24h) || 0) * 100;
      const h24       = parseFloat(t.high24h) || price;
      const l24       = parseFloat(t.low24h)  || price;
      const volat24h  = l24 > 0 ? ((h24 - l24) / l24) * 100 : 0;

      const entry = {
        symbol: sym, price, vol24h,
        change24h : +change24h.toFixed(2),
        volat24h  : +volat24h.toFixed(2),
        atr1mPct  : +atr1mPct.toFixed(4),
        atr5mPct  : +atr5mPct.toFixed(4),
        atr15mPct : +atr15mPct.toFixed(4),
        rsi1m     : +rsi1m.toFixed(1),
        rsi5m     : +rsi5m.toFixed(1),
        rsi15m    : +rsi15m.toFixed(1),
        volSpike  : +volSpike.toFixed(2),
        volAvgRatio: +volAvgRatio.toFixed(2),
        trendLabel,
      };
      entry.score = calcScore(entry);
      results.push(entry);

      console.log(
        `   ✓ ${sym.padEnd(13)} → LOLOS  ` +
        `RSI:${rsi1m.toFixed(0)}/${rsi5m.toFixed(0)}/${rsi15m.toFixed(0)}  ` +
        `ATR1m:${atr1mPct.toFixed(3)}%  ` +
        `spike:${volSpike.toFixed(2)}x ${spikeLabel(volSpike)}  ` +
        `score:${entry.score}`
      );

    } catch(e) {
      diagFail(sym, [`error: ${e.message}`]);
    }

    await sleep(200);
  }

  // ── Output ───────────────────────────────────────────────────────────────
  results.sort((a, b) => b.score - a.score);
  console.log('');
  console.log(`  ✔ Step 3 — ${results.length} token lolos semua filter\n`);

  if (!results.length) {
    console.log('  ⚠️  Nol token lolos. Kemungkinan ATR terlalu tinggi (market sedang volatile)');
    console.log('     atau RSI 15m di zona ekstrem (trend kuat). Tunggu 15–30 menit.\n');
    return;
  }

  // ── Tabel lengkap ────────────────────────────────────────────────────────
  const W = 110;
  console.log('═'.repeat(W));
  console.log(
    'Symbol'.padEnd(14) + 'Price'.padEnd(12) + 'Vol($M)'.padEnd(9) +
    'ATR1m%'.padEnd(9)  + 'ATR5m%'.padEnd(9) + 'ATR15m%'.padEnd(10)+
    'RSI1m'.padEnd(14)  + 'RSI5m'.padEnd(14) + 'RSI15m'.padEnd(10)+
    'Spike'.padEnd(12)  + 'Trend'.padEnd(6)  + 'Score'
  );
  console.log('-'.repeat(W));
  results.forEach(t => {
    const star = (t.atr1mPct >= 0.06 && t.atr1mPct <= 0.16) ? '★' : ' ';
    const warnSpike = t.volSpike > 4 ? ' ⚠️' : '';
    console.log(
      (star + t.symbol).padEnd(14) +
      t.price.toPrecision(4).padEnd(12) +
      ((t.vol24h/1e6).toFixed(0)+'M').padEnd(9) +
      (t.atr1mPct+'%').padEnd(9)   +
      (t.atr5mPct+'%').padEnd(9)   +
      (t.atr15mPct+'%').padEnd(10) +
      (t.rsi1m+' '+rsiLabel(t.rsi1m)).padEnd(14) +
      (t.rsi5m+' '+rsiLabel(t.rsi5m)).padEnd(14) +
      (t.rsi15m+'').padEnd(10) +
      (t.volSpike+'x '+spikeLabel(t.volSpike)+warnSpike).padEnd(12) +
      t.trendLabel.padEnd(6) +
      t.score
    );
  });

  // ── Rekomendasi ───────────────────────────────────────────────────────────
  const top = results.slice(0, 6);
  console.log('\n' + '═'.repeat(W));
  console.log('  ✅  REKOMENDASI SCALPING SEKARANG');
  console.log('═'.repeat(W));
  console.log(`\n  SYMBOLS=${top.map(t => t.symbol).join(',')}\n`);

  top.forEach((t, i) => {
    const tags = [];
    if (t.atr1mPct >= 0.06 && t.atr1mPct <= 0.16)  tags.push('★ ATR zona emas');
    if (t.rsi1m   >= 43    && t.rsi1m   <= 57)      tags.push('RSI 1m netral');
    if (t.rsi5m   >= 43    && t.rsi5m   <= 57)      tags.push('RSI 5m netral');
    if (t.volSpike < 0.5)                            tags.push('😴 market sepi → scalp tenang');
    if (t.volSpike >= 0.8  && t.volSpike <= 2.0)    tags.push('volume normal');
    if (t.trendLabel.includes('UP'))                 tags.push('trend naik');
    if (t.trendLabel.includes('FL'))                 tags.push('sideways');
    if (t.vol24h  >= 100_000_000)                    tags.push('super liquid');

    // Saran entry berdasarkan kondisi RSI saat ini
    let entrySaran = '';
    if      (t.rsi1m < 40 && t.rsi5m < 50) entrySaran = '→ Setup LONG menarik';
    else if (t.rsi1m > 60 && t.rsi5m > 50) entrySaran = '→ Setup SHORT menarik';
    else                                     entrySaran = '→ Tunggu RSI 1m sentuh 40 atau 60';

    console.log(
      `  ${i+1}. ${t.symbol.padEnd(12)} Score:${String(t.score).padEnd(7)}` +
      `ATR1m:${t.atr1mPct}%  RSI:${t.rsi1m}/${t.rsi5m}/${t.rsi15m}  ${entrySaran}`
    );
    if (tags.length) console.log(`     └─ ${tags.join(' · ')}`);
  });

  console.log('\n  ⚡ Panduan Entry:');
  console.log('     LONG  → RSI 1m naik dari bawah 38–42, RSI 5m > 45, trend 15m UP atau FLAT');
  console.log('     SHORT → RSI 1m turun dari atas 58–62, RSI 5m < 55, trend 15m DN atau FLAT');
  console.log('     SKIP  → VolSpike > 4x (⚠️  news/manipulasi), atau RSI 15m > 70 / < 30');
  console.log('     TP    → 1.5–2x ATR 1m  |  SL → 1x ATR 1m');
  console.log('     😴 Market sepi (spike < 0.3x) = range kecil, gunakan TP lebih ketat (1x ATR)');
  console.log('');
  console.log('═'.repeat(W));
}

scan().catch(console.error);