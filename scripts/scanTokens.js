require('dotenv').config();
const { BitgetClient } = require('../src/core/bitgetClient');
const c = new BitgetClient({
  apiKey    : process.env.BITGET_API_KEY,
  secretKey : process.env.BITGET_SECRET_KEY,
  passphrase: process.env.BITGET_PASSPHRASE,
});

// ─── ATR SWEET SPOT untuk 1m/5m scalping ─────────────────────
// ATR 1m: 0.05% - 0.25% per candle (tidak terlalu flat/liar)
// ATR 5m: 0.10% - 0.50% per candle
// Volatilitas 24h: 2% - 15% (filter kasar dulu sebelum fetch candle)

const MIN_VOL_USD    = 10_000_000;  // $10M minimum
const MAX_VOLAT_24H  = 15;          // filter kasar
const MIN_VOLAT_24H  = 2;
const MAX_CHANGE_24H = 20;

// ATR % dari harga (sweet spot untuk scalping 1m)
const ATR_1M_MIN = 0.04;   // min 0.04% per candle 1m
const ATR_1M_MAX = 0.30;   // max 0.30% per candle 1m
const ATR_5M_MIN = 0.08;   // min 0.08% per candle 5m
const ATR_5M_MAX = 0.60;   // max 0.60% per candle 5m

const BLUECHIP = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
                  'ADAUSDT','DOTUSDT','AVAXUSDT','LINKUSDT','LTCUSDT'];

// ─── Hitung ATR ───────────────────────────────────────────────
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h  = candles[i].high;
    const l  = candles[i].low;
    const pc = candles[i-1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── MAIN SCAN ────────────────────────────────────────────────
async function scan() {
  console.log('🔍 Scanning Bitget Futures — ATR filter untuk scalping 1m/5m\n');

  const tickers = await c._request('GET', '/api/v2/mix/market/tickers', {
    productType: 'USDT-FUTURES',
  });

  // Step 1: Filter kasar dari ticker 24h
  const candidates = tickers.filter(t => {
    const vol        = parseFloat(t.usdtVolume) || 0;
    const price      = parseFloat(t.lastPr) || 0;
    const change     = Math.abs(parseFloat(t.change24h) || 0) * 100;
    const high24h    = parseFloat(t.high24h) || price;
    const low24h     = parseFloat(t.low24h) || price;
    const volatility = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 0;
    return (
      t.symbol.endsWith('USDT') &&
      vol >= MIN_VOL_USD &&
      price > 0.0000001 &&
      volatility >= MIN_VOLAT_24H &&
      volatility <= MAX_VOLAT_24H &&
      change <= MAX_CHANGE_24H
    );
  });

  console.log(`Step 1: ${candidates.length} kandidat lolos filter 24h`);
  console.log(`Step 2: Fetch candle 1m & 5m untuk ATR check...\n`);

  // Step 2: Fetch candle dan hitung ATR (batched supaya tidak rate limit)
  const results = [];
  const granMap  = { '1m': '1m', '5m': '5m' };

  for (let i = 0; i < candidates.length; i++) {
    const t    = candidates[i];
    const sym  = t.symbol;
    const price = parseFloat(t.lastPr) || 1;

    try {
      // Fetch 1m dan 5m candles
      const [raw1m, raw5m] = await Promise.all([
        c._request('GET', '/api/v2/mix/market/candles', {
          symbol: sym, productType: 'USDT-FUTURES', granularity: '1m', limit: '30',
        }),
        c._request('GET', '/api/v2/mix/market/candles', {
          symbol: sym, productType: 'USDT-FUTURES', granularity: '5m', limit: '20',
        }),
      ]);

      const candles1m = parseCandles(raw1m);
      const candles5m = parseCandles(raw5m);

      const atr1m    = calcATR(candles1m, 14);
      const atr5m    = calcATR(candles5m, 14);
      const atr1mPct = price > 0 ? (atr1m / price) * 100 : 0;
      const atr5mPct = price > 0 ? (atr5m / price) * 100 : 0;

      // Cek apakah masuk sweet spot
      const atr1mOK = atr1mPct >= ATR_1M_MIN && atr1mPct <= ATR_1M_MAX;
      const atr5mOK = atr5mPct >= ATR_5M_MIN && atr5mPct <= ATR_5M_MAX;

      if (atr1mOK && atr5mOK) {
        const vol24h     = parseFloat(t.usdtVolume) || 0;
        const change24h  = Math.abs(parseFloat(t.change24h) || 0) * 100;
        const high24h    = parseFloat(t.high24h) || price;
        const low24h     = parseFloat(t.low24h) || price;
        const volat24h   = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 0;

        // Score: volume (40) + ATR sweet spot (40) + consistency (20)
        const volScore  = Math.min(Math.log10(vol24h / 1_000_000) / Math.log10(500), 1) * 40;

        // ATR score: makin dekat ke tengah sweet spot makin tinggi
        const atr1mMid  = (ATR_1M_MIN + ATR_1M_MAX) / 2; // 0.175%
        const atr1mDist = Math.abs(atr1mPct - atr1mMid) / atr1mMid;
        const atrScore  = (1 - Math.min(atr1mDist, 1)) * 40;

        // Consistency: tidak terlalu banyak berubah
        const consScore = change24h <= 5 ? 20 : change24h <= 10 ? 15 : 10;

        const score = volScore + atrScore + consScore;

        results.push({
          symbol    : sym,
          price,
          vol24h,
          change24h : parseFloat(change24h.toFixed(2)),
          volat24h  : parseFloat(volat24h.toFixed(2)),
          atr1mPct  : parseFloat(atr1mPct.toFixed(4)),
          atr5mPct  : parseFloat(atr5mPct.toFixed(4)),
          score     : parseFloat(score.toFixed(1)),
          isBluechip: BLUECHIP.includes(sym),
        });
      }

      // Progress log setiap 10 token
      if ((i + 1) % 10 === 0) {
        process.stdout.write(`   Progress: ${i+1}/${candidates.length} | Found: ${results.length}\r`);
      }

      // Rate limit protection
      await sleep(120);

    } catch(e) {
      // Skip token yang error
    }
  }

  console.log(`\n\nStep 3: ${results.length} token lolos ATR filter\n`);
  results.sort((a, b) => b.score - a.score);

  const bluechip = results.filter(t => t.isBluechip);
  const altcoin  = results.filter(t => !t.isBluechip && t.vol24h > 20_000_000);
  const gem      = results.filter(t => !t.isBluechip && t.vol24h <= 20_000_000);

  console.log('═'.repeat(80));
  console.log('📊 TIER 1 — BLUE CHIP (Paling aman untuk scalping 1m/5m)');
  console.log(`   ATR sweet spot: 1m ${ATR_1M_MIN}-${ATR_1M_MAX}% | 5m ${ATR_5M_MIN}-${ATR_5M_MAX}%`);
  console.log('═'.repeat(80));
  printTable(bluechip.slice(0, 6));

  console.log('\n' + '═'.repeat(80));
  console.log('🚀 TIER 2 — ALTCOIN AKTIF (Volume tinggi, ATR terkontrol)');
  console.log('═'.repeat(80));
  printTable(altcoin.slice(0, 10));

  if (gem.length > 0) {
    console.log('\n' + '═'.repeat(80));
    console.log('💎 TIER 3 — GEM (Volume medium, ATR bagus)');
    console.log('═'.repeat(80));
    printTable(gem.slice(0, 6));
  }

  // Rekomendasi final
  const recBlue = bluechip.slice(0, 3).map(t => t.symbol);
  const recAlt  = altcoin.slice(0, 3).map(t => t.symbol);
  const rec     = [...recBlue, ...recAlt].slice(0, 6);

  console.log('\n' + '═'.repeat(80));
  console.log('✅ REKOMENDASI SYMBOLS untuk scalping 1m/5m:');
  console.log(`SYMBOLS=${rec.join(',')}`);
  console.log('');
  console.log('Symbol'.padEnd(15) + 'ATR 1m%'.padEnd(12) + 'ATR 5m%'.padEnd(12) + 'Vol($M)'.padEnd(12) + 'Score');
  console.log('-'.repeat(60));
  results.filter(t => rec.includes(t.symbol)).forEach(t => {
    console.log(
      t.symbol.padEnd(15) +
      (t.atr1mPct + '%').padEnd(12) +
      (t.atr5mPct + '%').padEnd(12) +
      ((t.vol24h/1e6).toFixed(0) + 'M').padEnd(12) +
      t.score
    );
  });
  console.log('═'.repeat(80));
}

function printTable(tokens) {
  if (!tokens.length) { console.log('   (tidak ada)'); return; }
  console.log(
    'Symbol'.padEnd(15) + 'Price'.padEnd(12) + 'Vol($M)'.padEnd(10) +
    'ATR1m%'.padEnd(9) + 'ATR5m%'.padEnd(9) + 'Volat24h'.padEnd(11) + 'Score'
  );
  console.log('-'.repeat(80));
  tokens.forEach(t => {
    const atrTag = t.atr1mPct >= 0.08 && t.atr1mPct <= 0.20 ? ' ⭐' : '';
    console.log(
      t.symbol.padEnd(15) +
      t.price.toPrecision(4).padEnd(12) +
      ((t.vol24h/1e6).toFixed(1)+'M').padEnd(10) +
      (t.atr1mPct+'%').padEnd(9) +
      (t.atr5mPct+'%').padEnd(9) +
      (t.volat24h+'%').padEnd(11) +
      t.score + atrTag
    );
  });
}

scan().catch(console.error);