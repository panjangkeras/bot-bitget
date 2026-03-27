/**
 * ══════════════════════════════════════════════════════════
 *  BITGET SCALPING SANTAI — index.js  v2.4
 *
 *  Fixes v2.1:
 *  - Session logic diperbaiki: entry HANYA 23.00–19.00 WIB
 *  - PnL tracking pakai actual fill price dari exchange
 *  - Candle 1m naik ke 200 (warmup StochRSI cukup)
 *  - SL/TP berbasis ATR (tidak lagi flat %)
 *  - Partial close & managePosition pakai size aktual dari exchange
 *
 *  Fixes v2.3:
 *  - Bug fix: closeReason undefined di handlePositionClosed()
 *  - Aktifkan getSlTpAtr() untuk SL/TP yang lebih adaptif
 *  - Fix estPnl di handlePositionClosed pakai size aktual (bukan usdtPerTrade)
 *  - Fix indentasi dailyStats/dailyLoss update (konsisten)
 *  - managePosition re-init juga pakai getSlTpAtr()
 *
 *  Fixes v2.4:
 *  - BUG 1 FIX: closeReason pakai lastEvalResult[] bukan posMgr.get()
 *    yang sudah di-remove → TIME LIMIT/TRAILING SL kini terbaca benar
 *  - BUG 2 FIX: Exit price ambil dari /history filled orders dulu,
 *    baru fallback ke plan order triggerPrice, terakhir current price
 *    → PnL estimation jauh lebih akurat
 *  - ISSUE 3 FIX: Hapus XAGUSDT dari default SYMBOLS (silver beda karakteristik)
 *  - ISSUE 4 FIX: preferLong/preferShort di sessionBias kini jadi filter
 *    nyata — SHORT diblokir saat Asia Night/Morning (23–09 WIB)
 *  - Interval default naik 45s → 60s untuk kurangi over-trading
 *  - lastEvalResult dibersihkan di semua path close (CLOSE_ALL, RSI, handled)
 * ══════════════════════════════════════════════════════════
 */

require("dotenv").config();
const { BitgetClient }      = require("./src/core/bitgetClient");
const { TechnicalAnalysis } = require("./src/analysis/technicalAnalysis");
const { GroqAnalyzer }      = require("./src/analysis/groqAnalyzer");
const { NewsFetcher }       = require("./src/analysis/newsFetcher");
const { PositionManager }   = require("./src/core/positionManager");
const { Notifier }          = require("./src/utils/notifier");
const { FundingRateFilter } = require("./src/core/fundingRate");
const { PnlTracker }        = require("./src/core/pnlTracker");
const logger                = require("./src/utils/logger");
const { getSlTp, getSlTpAtr } = require("./src/core/slTpTable");
const { calcDynamicSize, updateStreak } = require("./src/core/dynamicSizing");
// ─── SYMBOL INFO ─────────────────────────────────────────
const SYMBOL_INFO = {};

async function loadSymbolInfo(client) {
  try {
    const data = await client._request("GET", "/api/v2/mix/market/contracts", {
      productType: process.env.PRODUCT_TYPE || "USDT-FUTURES",
    });
    for (const sym of CONFIG.symbols) {
      const contract = data.find(d => d.symbol === sym);
      if (contract) {
        SYMBOL_INFO[sym] = {
          decimals    : parseInt(contract.pricePlace)    || 2,
          minSize     : parseFloat(contract.minTradeNum) || 0.001,
          sizeDecimals: parseInt(contract.volumePlace)   || 2,
        };
      } else {
        SYMBOL_INFO[sym] = { decimals: 4, minSize: 0.01, sizeDecimals: 2 };
        logger.warn(`⚠️  ${sym}: tidak ditemukan di contracts — pakai default`);
      }
    }
    logger.success(`Symbol info loaded: ${CONFIG.symbols.join(", ")}`);
  } catch(e) {
    logger.warn(`loadSymbolInfo gagal: ${e.message} — pakai fallback`);
    const fallback = {
      BTCUSDT  : { decimals: 1, minSize: 0.001, sizeDecimals: 4 },
      ETHUSDT  : { decimals: 2, minSize: 0.01,  sizeDecimals: 2 },
      SOLUSDT  : { decimals: 3, minSize: 0.1,   sizeDecimals: 1 },
      BNBUSDT  : { decimals: 3, minSize: 0.01,  sizeDecimals: 2 },
      XRPUSDT  : { decimals: 4, minSize: 1,     sizeDecimals: 0 },
      ADAUSDT  : { decimals: 4, minSize: 1,     sizeDecimals: 0 },
      DOGEUSDT : { decimals: 5, minSize: 1,     sizeDecimals: 0 },
      AVAXUSDT : { decimals: 3, minSize: 0.1,   sizeDecimals: 1 },
      PEPEUSDT : { decimals:10, minSize: 1000,  sizeDecimals: 0 },
      SUIUSDT  : { decimals: 4, minSize: 1,     sizeDecimals: 0 },
      LINKUSDT : { decimals: 3, minSize: 0.1,   sizeDecimals: 1 },
      DOTUSDT  : { decimals: 3, minSize: 0.1,   sizeDecimals: 1 },
      LTCUSDT  : { decimals: 2, minSize: 0.01,  sizeDecimals: 2 },
    };
    for (const sym of CONFIG.symbols) {
      SYMBOL_INFO[sym] = fallback[sym] || { decimals: 4, minSize: 0.01, sizeDecimals: 2 };
    }
  }
}

// ─── CORRELATION FILTER ──────────────────────────────────
const CORRELATED_GROUPS = [
  ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
  ["SOLUSDT", "AVAXUSDT", "DOTUSDT"],
  ["DOGEUSDT", "PEPEUSDT"],
];

function checkCorrelation(symbol, direction, openPositions) {
  const group = CORRELATED_GROUPS.find(g => g.includes(symbol));
  if (!group) return { allowed: true };
  for (const [sym, pos] of Object.entries(openPositions)) {
    if (sym === symbol) continue;
    if (!group.includes(sym)) continue;
    const posDir = pos.holdSide === "long" ? "LONG" : "SHORT";
    if (posDir !== direction) {
      return { allowed: false, reason: `Korelasi conflict: ${sym} ${posDir} vs ${symbol} ${direction}` };
    }
  }
  return { allowed: true };
}

// ─── CONFIG ──────────────────────────────────────────────
const CONFIG = {
  symbols     : (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map(s => s.trim()),

  leverage    : Math.max(10, Math.min(30, parseInt(process.env.LEVERAGE) || 15)),
  usdtPerTrade: Math.max(5, parseFloat(process.env.USDT_PER_TRADE) || 10),

  maxOpenPos  : Math.max(1, parseInt(process.env.MAX_OPEN_POS) || 2),
  maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS) || 30,

  minConfidence: parseFloat(process.env.MIN_CONFIDENCE) || 0.67, // was 0.65

  intervalMs  : 60_000,  // 60s — lebih aman untuk 1 symbol, kurangi over-trading

  // ── FIX: 200 candle untuk 1m supaya StochRSI punya cukup warmup ──
  candleLimit : 200,
};

// ─── STATE ───────────────────────────────────────────────
let dailyLoss    = 0;
let lastResetDay = new Date().toDateString();
let tickCount    = 0;
let botRunning   = true;
let dailyStats = {
  wins: 0, losses: 0, trades: 0, totalPnl: 0,
  recentLossStreak: 0,   // ← TAMBAH
  recentWinStreak : 0,   // ← TAMBAH
};
const sentimentCache  = {};
const lastNewsTimeMap = {};
const posMgr          = new PositionManager();
const pnlTracker      = new PnlTracker();
const orderingSymbols = new Set();
let   frFilter        = null;
const activePositions = {};
let   _notifier       = null;
// FIX BUG 1: Simpan hasil evaluate() terakhir tiap symbol
// supaya handlePositionClosed() tahu alasan posisi ditutup
const lastEvalResult  = {};

// ─── MAIN ────────────────────────────────────────────────
async function main() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE", "GROQ_API_KEY"];
  for (const k of required) {
    if (!process.env[k] || process.env[k].startsWith("isi_") || process.env[k].includes("your_")) {
      logger.error(`❌ ${k} belum diisi di .env!`);
      process.exit(1);
    }
  }

  if (CONFIG.leverage < 10 || CONFIG.leverage > 30) {
    logger.error("❌ LEVERAGE harus antara 10–30!");
    process.exit(1);
  }
  if (CONFIG.usdtPerTrade < 5) {
    logger.error("❌ USDT_PER_TRADE minimal $5!");
    process.exit(1);
  }

  const client   = new BitgetClient({
    apiKey    : process.env.BITGET_API_KEY,
    secretKey : process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
  });
  const ta       = new TechnicalAnalysis();
  const groq     = new GroqAnalyzer(process.env.GROQ_API_KEY);
  const news     = new NewsFetcher(process.env.NEWS_API_KEY || "");
  const notifier = new Notifier(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
  _notifier      = notifier;

  await loadSymbolInfo(client);
  frFilter = new FundingRateFilter(client);

  logger.success(`🤖 Bitget Scalping Santai v2.4`);
  logger.success(`📊 Pairs : ${CONFIG.symbols.join(", ")}`);
  logger.success(`⚡ Max Lev: ${CONFIG.leverage}x (AI pilih 10–${CONFIG.leverage}x)`);
  logger.success(`💵 Entry : $${CONFIG.usdtPerTrade}/trade | Max Loss: $${CONFIG.maxDailyLoss}/hari`);
  logger.success(`📈 MTF   : 1m entry | 5m konfirmasi | 15m+30m trend`);
  logger.success(`🧠 AI    : Cerebras llama3.1-8b | MinConf: ${CONFIG.minConfidence}`);
  logger.success(`⏰ Sesi  : Entry 23.00–19.00 WIB | Skip 19.01–22.59 WIB | SHORT skip 23–09 WIB`);

  for (const symbol of CONFIG.symbols) {
    for (const side of ["long", "short"]) {
      try {
        await client._request("POST", "/api/v2/mix/account/set-leverage", {}, {
          symbol, productType: process.env.PRODUCT_TYPE || "USDT-FUTURES",
          marginCoin: "USDT", leverage: CONFIG.leverage.toString(), holdSide: side,
        });
      } catch {}
    }
    await sleep(300);
  }
  logger.success(`✅ Leverage max ${CONFIG.leverage}x di-set ke semua pair`);

  const allTime = pnlTracker.allTimeStats();
  await notifier.send(
    `🤖 *Scalping Santai v2.4 — Started*\n` +
    `📊 Pairs: ${CONFIG.symbols.map(s => s.replace("USDT","")).join(" | ")}\n` +
    `⚡ Max Lev: ${CONFIG.leverage}x | Entry: $${CONFIG.usdtPerTrade}\n` +
    `🛡 Max Loss/hari: $${CONFIG.maxDailyLoss} | MaxPos: ${CONFIG.maxOpenPos}\n` +
    `⏰ Session: Entry 23.00–19.00 WIB | SHORT skip 23–09 WIB | SL ATR-based\n` +
    (allTime.total > 0
      ? `📊 All-time: ${allTime.total} trades | WR:${allTime.winRate}% | PnL:$${allTime.pnl}`
      : `🆕 Fresh start — belum ada riwayat trade`)
  );

  // ── Loop utama ────────────────────────────────────────
  while (botRunning) {
    const start = Date.now();
    tickCount++;

    const today = new Date().toDateString();
    if (today !== lastResetDay) {
      logger.info(`🌅 Hari baru — reset daily loss & stats`);
      try { await notifier.send(pnlTracker.summaryMessage()); } catch {}
      dailyLoss    = 0;
      dailyStats = {
  wins: 0, losses: 0, trades: 0, totalPnl: 0,
  recentLossStreak: 0,   // ← TAMBAH
  recentWinStreak : 0,   // ← TAMBAH
};
      lastResetDay = today;
    }

    logger.tick(`⏱  Tick #${tickCount} ${new Date().toLocaleTimeString("id-ID")} | W:${dailyStats.wins} L:${dailyStats.losses} PnL:$${dailyStats.totalPnl.toFixed(2)} | Loss:$${dailyLoss.toFixed(2)}/$${CONFIG.maxDailyLoss}`);

    if (dailyLoss >= CONFIG.maxDailyLoss) {
      logger.warn(`🚫 Max daily loss $${CONFIG.maxDailyLoss} tercapai — istirahat 1 jam`);
      await sleep(60_000 * 60);
      continue;
    }

    const sessionBias = getSessionBias();
    if (sessionBias.avoidEntry) {
      logger.info(`⏸️  Jam skip entry (${sessionBias.session} WIB) — tetap pantau posisi aktif`);
    }

    const openCount = await countOpenPositions(client);
    logger.info(`📊 Posisi terbuka: ${openCount}/${CONFIG.maxOpenPos}`);

    for (const sym of CONFIG.symbols) {
      try {
        await processSymbol(sym, client, ta, groq, news, notifier, openCount, sessionBias);
        await sleep(100); // ⬅️ delay biar gak kena 429
      } catch (e) {
        logger.error(`[${sym}] Error: ${e.message}`);
      }
    }

    const elapsed = Date.now() - start;
    const nextTick = Math.max(0, CONFIG.intervalMs - elapsed);
    logger.info(`✅ Tick selesai ${(elapsed/1000).toFixed(1)}s | Next tick ${(nextTick/1000).toFixed(0)}s`);
    await sleep(nextTick);
  }
}

// ═══════════════════════════════════════════════════════════
// ─── SESSION LOGIC — DIPERBAIKI ───────────────────────────
// Entry HANYA di jam 23.00–19.00 WIB
// Artinya: skip entry jam 19.01–22.59 WIB
//
// WIB = UTC+7
// Jam 23.00 WIB = 16.00 UTC  → h_utc = 16
// Jam 19.00 WIB = 12.00 UTC  → h_utc = 12
//
// Entry allowed: h_wib >= 23 ATAU h_wib <= 19
// Skip entry   : h_wib > 19 DAN h_wib < 23   → yaitu 20, 21, 22 WIB
// ═══════════════════════════════════════════════════════════

function getHourWIB() {
  // WIB = UTC + 7
  return (new Date().getUTCHours() + 7) % 24;
}

function getSessionBias() {
  const h = getHourWIB();

  // Jam sepi — SKIP ENTRY (19:01 – 22:59 WIB)
  if (h >= 20 && h <= 22) {
    return {
      session    : `${h}:xx WIB (jam skip)`,
      avoidEntry : true,
      preferLong : false,
      preferShort: false,
    };
  }

  // Jam aktif (23.00 – 19.00 WIB)
  let session, preferLong, preferShort;

  if (h >= 23 || h <= 3) {
    session     = `${h}:xx WIB (Asia Night)`;
    preferLong  = true;
    preferShort = false;
  } else if (h >= 4 && h <= 9) {
    session     = `${h}:xx WIB (Asia Morning)`;
    preferLong  = true;
    preferShort = false;
  } else if (h >= 10 && h <= 14) {
    session     = `${h}:xx WIB (London/EU)`;
    preferLong  = true;
    preferShort = true;
  } else {
    // 15 – 19 WIB = NY session
    session     = `${h}:xx WIB (New York)`;
    preferLong  = true;
    preferShort = true;
  }

  return {
    session,
    avoidEntry : false,
    preferLong,
    preferShort,
  };
}

// ─── POSITION SIZING ──────────────────────────────────────
function calcSize(usdt, price, lev, minSize, sizeDecimals) {
  let s = (usdt * lev) / price;
  s = parseFloat(s.toFixed(sizeDecimals));
  s = Math.max(s, minSize);

  const MIN_NOTIONAL = 5;
  if (s * price < MIN_NOTIONAL) {
    s = parseFloat((MIN_NOTIONAL / price).toFixed(sizeDecimals));
    s = Math.max(s, minSize);
  }
  return s;
}

function calcCloseSize(totalSize, minSize, sizeDecimals) {
  const half = parseFloat((totalSize * 0.5).toFixed(sizeDecimals));
  if (half < minSize) return totalSize;
  return Math.floor(half / minSize) * minSize;
}

async function setLeverage(client, symbol, lev) {
  const safeLev = Math.max(10, Math.min(30, lev));
  try {
    for (const hs of ["long", "short"]) {
      await client._request("POST", "/api/v2/mix/account/set-leverage", {}, {
        symbol, productType: process.env.PRODUCT_TYPE || "USDT-FUTURES",
        marginCoin: "USDT", leverage: safeLev.toString(), holdSide: hs,
      });
    }
  } catch {}
}

// ─── PROSES SYMBOL ────────────────────────────────────────
async function processSymbol(symbol, client, ta, groq, news, notifier, openCount, sessionBias) {
  const info = SYMBOL_INFO[symbol];
  const coin = symbol.replace("USDT", "");
  if (!info) return;

  // Ambil candle semua TF — 1m sekarang 200 candle
  const candles1m = await client.getCandles(symbol, "1m", CONFIG.candleLimit);
  if (!candles1m || candles1m.length < 80) {
    logger.warn(`[${coin}] Candle 1m tidak cukup (${candles1m?.length || 0})`);
    return;
  }

  const [candles5m, candles15m, candles30m] = await Promise.all([
    client.getCandles(symbol, "5m",  80).catch(() => null),
    client.getCandles(symbol, "15m", 60).catch(() => null),
    client.getCandles(symbol, "30m", 50).catch(() => null),
  ]);

  const price        = candles1m[candles1m.length - 1].close;
  const recentPrices = candles1m.slice(-12).map(c => c.close); // was -6, now -12 (10 menit)

  const { rsi, macd, signal, histogram } = ta.calculate(candles1m);
  const trend      = ta.getTrend(candles1m, 20);
  const bb         = ta.calcBollingerBands(candles1m.map(c => c.close), 20, 2);
  const atr        = ta.calcATR(candles1m, 14);
  const stochRSI   = ta.calcStochRSI(candles1m.map(c => c.close));
  const sr         = ta.calcSupportResistance(candles1m, 30);
  const volume     = ta.calcVolumeAnalysis(candles1m, 10);
  const pattern    = ta.detectPattern(candles1m);
  const momentum   = ta.calcMomentum(candles1m, 5);
  const marketCond = ta.getMarketCondition(candles1m, 14);
  const mrSignal   = ta.calcMeanReversionSignal(candles1m, bb, rsi, stochRSI, volume, atr);
  const sweepSignal = ta.detectLiquiditySweep(candles1m, 20);

  if (sweepSignal.isSweep) {
    logger.info(`[${coin}] 🌊 SWEEP: ${sweepSignal.type} | wick:${sweepSignal.wickPct}% vol:${sweepSignal.volSurge}x conf:${sweepSignal.confidence}`);
  }

  // ── Pantau posisi aktif ───────────────────────────────
  const activePos = await client.getPosition(symbol);
  if (activePos) {
    activePositions[symbol] = activePos;
    await managePosition(activePos, symbol, price, rsi, trend, histogram, atr, info, groq, client, notifier);
    return;
  } else {
    if (posMgr.isTracking(symbol)) {
      await handlePositionClosed(symbol, price, info, client, notifier);
    } else {
      delete activePositions[symbol];
    }
  }

  // Jangan entry baru kalau max posisi, jam skip, atau sedang order
  if (openCount >= CONFIG.maxOpenPos) return;
  if (orderingSymbols.has(symbol)) return;

  // ── SWEEP GUARD ──────────────────────────────────────
  const sweepBlockDir = sweepSignal.isSweep && sweepSignal.confidence >= 0.65
    ? (sweepSignal.type === "BULL_SWEEP" ? "LONG" : "SHORT")
    : null;

  // ════════════════════════════════════════════════════════
  // STRATEGY 2: MEAN REVERSION (market sideways)
  // FIX: Hanya boleh entry MR kalau market benar-benar RANGING
  // ════════════════════════════════════════════════════════
  const mrAllowed = mrSignal.signal !== "NONE"
    && mrSignal.confidence >= CONFIG.minConfidence
    && (marketCond === "RANGING" || marketCond === "WEAK_TREND"); // GUARD BARU

  if (!mrAllowed && mrSignal.signal !== "NONE") {
    logger.info(`[${coin}] ❌ MR skip — market ${marketCond}, bukan RANGING/WEAK_TREND`);
  }

  if (mrAllowed) {
    const isLong = mrSignal.direction === "LONG";

    const tf15m = candles15m ? ta.getTrend(candles15m, 20) : "UNKNOWN";
    const tf30m = candles30m ? ta.getTrend(candles30m, 20) : "UNKNOWN";

    const higherTFConflict =
      (isLong  && (tf15m.includes("STRONG_DOWNTREND") || tf30m.includes("STRONG_DOWNTREND"))) ||
      (!isLong && (tf15m.includes("STRONG_UPTREND")   || tf30m.includes("STRONG_UPTREND")));

    if (higherTFConflict) {
      logger.info(`[${coin}] ❌ MR skip — strong trend berlawanan di TF tinggi`);
    } else if (volume.surge < 0.5) {
      logger.info(`[${coin}] ❌ MR skip — volume terlalu rendah (${volume.surge}x)`);
    } else if (sessionBias.avoidEntry) {
      logger.info(`[${coin}] ❌ MR skip — jam skip entry (${sessionBias.session})`);
    } else {
      const corrCheck = checkCorrelation(symbol, mrSignal.direction, activePositions);
      if (!corrCheck.allowed) {
        logger.info(`[${coin}] ❌ MR skip — ${corrCheck.reason}`);
        return;
      }

      const frCheck = await frFilter.checkEntry(symbol, mrSignal.direction);
      if (!frCheck.allowed) {
        logger.info(`[${coin}] ❌ MR skip — ${frCheck.reason}`);
        return;
      }

      if (sweepBlockDir && mrSignal.direction === sweepBlockDir) {
        logger.info(`[${coin}] ❌ MR skip — arah ${mrSignal.direction} diblokir sweep`);
        return;
      }

      const useLev = Math.min(mrSignal.suggestedLev || 15, 20, CONFIG.leverage);
      const d      = info.decimals;
      const side   = isLong ? "buy" : "sell";

      // ── SL/TP via getSlTpAtr — adaptif terhadap volatilitas aktual ──
      const atrPct  = atr ? (atr / price) * 100 : 0.5;
      const sltMR   = getSlTpAtr(useLev, "normal", atr, price);
      const slPct   = Math.max(mrSignal.slPct  || 0, sltMR.sl);
      const tp1Pct  = Math.max(mrSignal.tp1Pct || 0, sltMR.tp1);
      const tp2Pct  = Math.max(mrSignal.tp2Pct || 0, sltMR.tp2);

      const sl  = isLong
        ? parseFloat((price * (1 - slPct  / 100)).toFixed(d))
        : parseFloat((price * (1 + slPct  / 100)).toFixed(d));
      const tp2 = isLong
        ? parseFloat((price * (1 + tp2Pct / 100)).toFixed(d))
        : parseFloat((price * (1 - tp2Pct / 100)).toFixed(d));

      const usdtMR = calcDynamicSize({
  base        : CONFIG.usdtPerTrade,
  dailyStats,
  dailyLoss,
  maxDailyLoss: CONFIG.maxDailyLoss,
  confidence  : mrSignal.confidence,
  atrPct,
  verbose     : true,
});
const size = calcSize(usdtMR, price, useLev, info.minSize, info.sizeDecimals);
logger.info(`[${coin}] 🔄 MR ${mrSignal.direction} ${useLev}x | $${usdtMR} (dyn) | ATR:${atrPct.toFixed(3)}% SL:${slPct.toFixed(2)}% TP:${tp2Pct.toFixed(2)}%`);
      orderingSymbols.add(symbol);
      await setLeverage(client, symbol, useLev);

      try {
        const order = await withRetry(
          () => client.placeMarketOrder({ symbol, side, size, sl, tp: tp2, decimals: d }),
          2, 1000, `[${coin}] MR order`
        );
        dailyStats.trades++;

        // Ambil actual fill price dari posisi yang baru dibuka
        const actualEntry = await getActualEntryPrice(client, symbol, price);

        posMgr.init({
          symbol, side: isLong ? "long" : "short",
          entryPrice: actualEntry, slPct, tp1Pct, tp2Pct,
          size, leverage: useLev, atr,
        });

        await notifier.send(
          `🔄 *MR ${mrSignal.direction} — ${coin}* ⚡${useLev}x\n` +
          `Entry \`$${actualEntry.toFixed(d)}\` | ATR:${atrPct.toFixed(3)}%\n` +
          `SL:\`${slPct.toFixed(2)}%\` TP1:\`${tp1Pct.toFixed(2)}%\` TP2:\`${tp2Pct.toFixed(2)}%\`\n` +
          `BB:${mrSignal.bbPosition?.toFixed(0)}% | RSI:${rsi.toFixed(1)} | Conf:${(mrSignal.confidence*100).toFixed(0)}%\n` +
          `💰 Funding:${frCheck.fundingRate} | ${sessionBias.session}`
        );
      } catch(err) {
        logger.error(`[${coin}] MR order gagal: ${err.message}`);
      } finally {
        orderingSymbols.delete(symbol);
      }
      return;
    }
  } // end mrAllowed

  // ─── PRE-FILTER sebelum panggil AI ─────────────────────
  const bbW_precheck = bb ? bb.width * 100 : 1;
  const isBBSqueeze  = bbW_precheck < 0.4;
  const isRsiExtreme = rsi > 73 || rsi < 27;
  const isLowVolume  = volume.surge < 0.5;

  if (isBBSqueeze) {
    logger.info(`[${coin}] ❌ TF skip — BB squeeze (width=${bbW_precheck.toFixed(3)}%) tunggu breakout`);
    return;
  }
  if (isRsiExtreme) {
    logger.info(`[${coin}] ❌ TF skip — RSI extreme (${rsi.toFixed(1)})`);
    return;
  }
  if (isLowVolume) {
    logger.info(`[${coin}] ❌ TF skip — volume rendah (${volume.surge.toFixed(2)}x)`);
    return;
  }

  const tf15m_pre = candles15m ? ta.getTrend(candles15m, 20) : "UNKNOWN";
  const tf30m_pre = candles30m ? ta.getTrend(candles30m, 20) : "UNKNOWN";
  if (tf15m_pre === "UNKNOWN" && tf30m_pre === "UNKNOWN") {
    logger.info(`[${coin}] ❌ TF skip — tidak ada data 15m/30m`);
    return;
  }

  const tf15mBull = tf15m_pre.includes("UPTREND");
  const tf30mBull = tf30m_pre.includes("UPTREND");
  const tf15mBear = tf15m_pre.includes("DOWNTREND");
  const tf30mBear = tf30m_pre.includes("DOWNTREND");
  const tfConflict = (tf15mBull && tf30mBear) || (tf15mBear && tf30mBull);
  if (tfConflict && tf15m_pre !== "UNKNOWN" && tf30m_pre !== "UNKNOWN") {
    logger.info(`[${coin}] ❌ TF skip — 15m vs 30m conflicting (${tf15m_pre} vs ${tf30m_pre})`);
    return;
  }

  // ─── Blokir entry baru di jam skip (cek SEBELUM panggil AI) ──
  if (sessionBias.avoidEntry) {
    logger.info(`[${coin}] ❌ TF skip — jam skip entry (${sessionBias.session})`);
    return;
  }

  // ════════════════════════════════════════════════════════
  // STRATEGY 1: TREND FOLLOWING (AI-driven)
  // ════════════════════════════════════════════════════════
  const techAnalysis = await groq.analyzeTechnical({
    rsi, macd, signal, histogram, price, trend, bb,
    volume, atr, stochRSI, sr, pattern, momentum,
    candles1m, candles5m, candles15m, candles30m,
  });

  const now = Date.now();
  if (!sentimentCache[coin] || now - (lastNewsTimeMap[coin] || 0) > 15 * 60 * 1000) {
    const hl = await news.getHeadlines(coin);
    sentimentCache[coin]  = await groq.analyzeSentiment(coin, hl);
    lastNewsTimeMap[coin] = now;
  }
  const sentiment = sentimentCache[coin];

  const decision = await groq.makeDecision({
    technicalAnalysis: techAnalysis, sentiment, price, symbol,
    recentPrices, sessionInfo: getSessionBias().session,
  });

  if (decision.riskWarning) logger.warn(`[${coin}] ⚠️ ${decision.riskWarning}`);

  if (decision.action === "HOLD" || decision.urgency === "SKIP") return;
  if (decision.confidence < CONFIG.minConfidence) {
    logger.info(`[${coin}] ❌ TF skip — confidence terlalu rendah (${(decision.confidence*100).toFixed(0)}%)`);
    return;
  }
  if (decision.grade === "D" || decision.grade === "C") {
    logger.info(`[${coin}] ❌ TF skip — grade ${decision.grade} (hanya A/B yang masuk)`);
    return;
  }
  if (volume.surge < 0.5) {
    logger.info(`[${coin}] ❌ TF skip — volume rendah (${volume.surge}x)`);
    return;
  }
  if (!techAnalysis.recommendedLev) return;

  if (decision.action === "BUY"  && rsi > 72) {
    logger.info(`[${coin}] ❌ TF skip — RSI overbought (${rsi.toFixed(0)})`);
    return;
  }
  if (decision.action === "SELL" && rsi < 28) {
    logger.info(`[${coin}] ❌ TF skip — RSI oversold (${rsi.toFixed(0)})`);
    return;
  }

  // ── FIX ISSUE 4: Terapkan session bias sebagai filter nyata ──
  // Asia Night / Asia Morning (23-09 WIB): preferShort = false → skip SHORT
  if (decision.action === "SELL" && !sessionBias.preferShort) {
    logger.info(`[${coin}] ❌ TF skip — jam ${sessionBias.session} tidak prefer SHORT`);
    return;
  }

  if (orderingSymbols.has(symbol)) return;

  const tfDir = decision.action === "BUY" ? "LONG" : "SHORT";

  const corrCheckTF = checkCorrelation(symbol, tfDir, activePositions);
  if (!corrCheckTF.allowed) {
    logger.info(`[${coin}] ❌ TF skip — ${corrCheckTF.reason}`);
    return;
  }

  const frCheckTF = await frFilter.checkEntry(symbol, tfDir);
  if (!frCheckTF.allowed) {
    logger.info(`[${coin}] ❌ TF skip — ${frCheckTF.reason}`);
    return;
  }

  if (sweepBlockDir && tfDir === sweepBlockDir) {
    logger.info(`[${coin}] ❌ TF skip — arah ${tfDir} diblokir sweep`);
    return;
  }

  const useLev = Math.max(10, Math.min(
    decision.leverageUsed || techAnalysis.recommendedLev || 15,
    CONFIG.leverage, 30
  ));

  const d = info.decimals;

  // ── SL/TP via getSlTpAtr — adaptif terhadap volatilitas aktual ──
  const atrPct = atr ? (atr / price) * 100 : 0.5;
  const sigStr = (techAnalysis.signal === "STRONG_BUY" || techAnalysis.signal === "STRONG_SELL") ? "strong"
               : (decision.grade === "A" || decision.grade === "B") ? "normal" : "weak";
  const slt    = getSlTpAtr(useLev, sigStr, atr, price);

  // AI suggestion override jika ada dan lebih konservatif dari ATR-based
  const slPct  = Math.max(decision.slPct  || 0, slt.sl);
  const tp1Pct = Math.max(decision.tp1Pct || 0, slt.tp1);
  const tp2Pct = Math.max(decision.tp2Pct || 0, slt.tp2);

  const sl  = decision.action === "BUY"
    ? parseFloat((price * (1 - slPct  / 100)).toFixed(d))
    : parseFloat((price * (1 + slPct  / 100)).toFixed(d));
  const tp2 = decision.action === "BUY"
    ? parseFloat((price * (1 + tp2Pct / 100)).toFixed(d))
    : parseFloat((price * (1 - tp2Pct / 100)).toFixed(d));

  const usdtTF = calcDynamicSize({
  base        : CONFIG.usdtPerTrade,
  dailyStats,
  dailyLoss,
  maxDailyLoss: CONFIG.maxDailyLoss,
  confidence  : decision.confidence,
  atrPct,
  verbose     : true,
});
const size = calcSize(usdtTF, price, useLev, info.minSize, info.sizeDecimals);
const side = decision.action === "BUY" ? "buy" : "sell";

  logger.info(`[${coin}] ✅ TF ${decision.action} [${decision.grade}] ${useLev}x | $${usdtTF} (dyn) | ATR:${atrPct.toFixed(3)}% SL:${slPct.toFixed(2)}% TP1:${tp1Pct.toFixed(2)}% TP2:${tp2Pct.toFixed(2)}%`);

  orderingSymbols.add(symbol);
  await setLeverage(client, symbol, useLev);

  try {
    await withRetry(
      () => client.placeMarketOrder({ symbol, side, size, sl, tp: tp2, decimals: d }),
      2, 1000, `[${coin}] TF order`
    );
    dailyStats.trades++;

    // FIX: ambil actual fill price dari exchange
    const actualEntry = await getActualEntryPrice(client, symbol, price);

    posMgr.init({
      symbol, side: decision.action === "BUY" ? "long" : "short",
      entryPrice: actualEntry, slPct, tp1Pct, tp2Pct,
      size, leverage: useLev, atr,
    });

    await notifier.send(
      `🚀 *TF ${decision.action} — ${coin}* [${decision.grade}] ⚡${useLev}x\n` +
      `Entry \`$${actualEntry.toFixed(d)}\` | ATR:${atrPct.toFixed(3)}%\n` +
      `SL:\`${slPct.toFixed(2)}%\` TP1:\`${tp1Pct.toFixed(2)}%\` TP2:\`${tp2Pct.toFixed(2)}%\`\n` +
      `🧠 Conf:${(decision.confidence*100).toFixed(0)}% | TF:${techAnalysis.tfAlignment}\n` +
      `📈 RSI:${rsi.toFixed(1)} | Vol:${volume.surge}x | ${marketCond}\n` +
      `💰 Funding:${frCheckTF.fundingRate} | ${sessionBias.session}\n` +
      (sweepSignal.isSweep ? `🌊 Sweep: ${sweepSignal.type} (searah ✅)\n` : ``) +
      `💬 ${decision.reason}`
    );
  } catch(err) {
    logger.error(`[${coin}] TF order gagal setelah retry: ${err.message}`);
  } finally {
    orderingSymbols.delete(symbol);
  }
}

// ─── AMBIL ACTUAL ENTRY PRICE ─────────────────────────────
// Retry sampai posisi muncul di exchange, ambil openPriceAvg
// Fallback ke estimated price jika tidak berhasil
async function getActualEntryPrice(client, symbol, estimatedPrice) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(600);
    try {
      const pos = await client.getPosition(symbol);
      if (pos && parseFloat(pos.openPriceAvg) > 0) {
        const actual = parseFloat(pos.openPriceAvg);
        logger.info(`[${symbol.replace("USDT","")}] ✅ Actual fill price: $${actual}`);
        return actual;
      }
    } catch(e) {}
  }
  logger.warn(`[${symbol.replace("USDT","")}] ⚠️ Tidak bisa ambil fill price, pakai estimated $${estimatedPrice}`);
  return estimatedPrice;
}

// ─── HANDLE POSISI YANG SUDAH CLOSED DI EXCHANGE ─────────
// FIX BUG 1 + BUG 2: closeReason pakai lastEvalResult, PnL pakai actual fill dari history
async function handlePositionClosed(symbol, price, info, client, notifier) {
  const closedPos = posMgr.get(symbol);
  if (!closedPos) { delete activePositions[symbol]; return; }

  const coin    = symbol.replace("USDT", "");
  const wasLong = closedPos.side === "long";
  const entry   = closedPos.entryPrice || price;
  const usedLev = closedPos.leverage || CONFIG.leverage;

  // ── FIX BUG 2: Ambil actual fill price dari history filled orders ──
  // Pakai /history (filled orders), bukan /history-plan-order (plan orders)
  // startTime = waktu posisi dibuka supaya tidak ambil trade lain
  let actualExitPrice = null;
  let closeSource     = "estimated";

  try {
    const openedAt = posMgr.getOpenedAt(symbol) || closedPos.openedAt || (Date.now() - 5 * 60 * 1000);
    const history  = await client._request("GET", "/api/v2/mix/order/history", {
      symbol,
      productType: process.env.PRODUCT_TYPE || "USDT-FUTURES",
      startTime  : openedAt.toString(),
      endTime    : Date.now().toString(),
      pageSize   : "10",
    });
    const orders = history?.orderList || history?.entrustedList || [];
    // Cari close order (tradeSide = close) yang sudah filled, paling baru
    const fillOrder = orders
      .filter(o => o.tradeSide === "close" && o.state === "filled" && parseFloat(o.priceAvg || o.price) > 0)
      .sort((a, b) => parseInt(b.cTime || b.uTime || 0) - parseInt(a.cTime || a.uTime || 0))[0];

    if (fillOrder) {
      actualExitPrice = parseFloat(fillOrder.priceAvg || fillOrder.price);
      closeSource     = "exchange";
    }
  } catch(e) {
    logger.warn(`[${coin}] Fetch fill history gagal: ${e.message.slice(0, 80)}`);
  }

  // Fallback 1: coba triggerPrice dari plan order
  if (!actualExitPrice) {
    try {
      const planHist = await client._request("GET", "/api/v2/mix/order/history-plan-order", {
        symbol,
        productType: process.env.PRODUCT_TYPE || "USDT-FUTURES",
        pageSize   : "5",
      });
      const orders     = planHist?.entrustedList || [];
      const lastClosed = orders.find(o =>
        (o.planType === "loss_plan" || o.planType === "profit_plan") &&
        o.state === "triggered" && parseFloat(o.triggerPrice) > 0
      );
      if (lastClosed) {
        actualExitPrice = parseFloat(lastClosed.triggerPrice);
        closeSource     = "exchange (plan)";
      }
    } catch(e) {}
  }

  // Fallback 2: current market price (least accurate)
  if (!actualExitPrice) {
    actualExitPrice = price;
    closeSource     = "estimated";
    logger.warn(`[${coin}] ⚠️ Exit price fallback ke current price $${price} — PnL mungkin tidak akurat`);
  }

  // Hitung PnL dari actual exit price — pakai size aktual bukan CONFIG.usdtPerTrade
  const actualSize = closedPos.size || 0;
  const diffPct    = ((actualExitPrice - entry) / entry * 100 * (wasLong ? 1 : -1));
  const notional   = actualSize * entry;
  const estPnl     = (diffPct / 100) * notional;
  const hitTP      = diffPct > 0;
  const emoji      = hitTP ? "✅" : "❌";

  // ── FIX BUG 1: closeType dari lastEvalResult[symbol], bukan posMgr.get() ──
  // lastEvalResult menyimpan hasil evaluate() terakhir sebelum posisi hilang
  const lastEval  = lastEvalResult[symbol];
  const closeType = hitTP                    ? "TP HIT"
    : lastEval?.timeForced                   ? "TIME LIMIT"
    : lastEval?.reason?.includes("Trailing") ? "TRAILING SL"
    : "SL HIT";

  logger.trade(`[${coin}] 🔔 ${closeType} (${closeSource}) @ $${actualExitPrice.toFixed(info.decimals)} | PnL: $${estPnl.toFixed(2)}`);

  pnlTracker.record({
    symbol, side: closedPos.side || "unknown",
    entryPrice: entry, exitPrice: actualExitPrice,
    size: closedPos.size || 0, leverage: usedLev,
    pnl: estPnl, pnlPct: parseFloat(diffPct.toFixed(3)),
    closeReason: `${closeType} (${closeSource})`, strategy: "AUTO",
  });

  if (estPnl < 0) {
    dailyLoss += Math.abs(estPnl);
    dailyStats.losses++;
  } else {
    dailyStats.wins++;
  }
  updateStreak(dailyStats, estPnl >= 0);
  dailyStats.totalPnl += estPnl;
  dailyStats.trades++;

  const wr = dailyStats.trades > 0 ? ((dailyStats.wins / dailyStats.trades) * 100).toFixed(0) : 0;
  try {
    await notifier.send(
      `${emoji} *${closeType} — ${coin}*\n` +
      `${(closedPos.side || "").toUpperCase()} | Entry:\`$${entry.toFixed(info.decimals)}\` → \`$${actualExitPrice.toFixed(info.decimals)}\`\n` +
      `💵 PnL: \`${estPnl >= 0 ? "+" : ""}$${estPnl.toFixed(2)}\` (${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(3)}%)\n` +
      `📊 W:${dailyStats.wins} L:${dailyStats.losses} WR:${wr}% | Total:$${dailyStats.totalPnl.toFixed(2)}`
    );
  } catch(e) { logger.warn(`[${coin}] Notif close gagal`); }

  posMgr.remove(symbol);
  delete activePositions[symbol];
  delete lastEvalResult[symbol]; // cleanup
}

// ─── MANAGE POSISI TERBUKA ────────────────────────────────
async function managePosition(pos, symbol, currentPrice, rsi, trend, histogram, atr, info, groq, client, notifier) {
  const coin       = symbol.replace("USDT", "");
  const side       = pos.holdSide;
  const entryPrice = parseFloat(pos.openPriceAvg || currentPrice);
  const d          = info.decimals;
  const size       = parseFloat(pos.total || 0);

  // FIX: Gunakan unrealized PnL dari exchange langsung (lebih akurat)
  const pnlFromExchange = parseFloat(pos.unrealizedPL || 0);
  const pnlPct = ((currentPrice - entryPrice) / entryPrice * 100 * (side === "long" ? 1 : -1)).toFixed(3);

  if (!posMgr.isTracking(symbol)) {
    const atrPct = atr ? (atr / entryPrice) * 100 : 0.5;
    const slt    = getSlTpAtr(CONFIG.leverage, "normal", atr, entryPrice);
    // ATR-based SL/TP untuk posisi yang diinisialisasi ulang
    const slPct  = slt.sl;
    const tp1Pct = slt.tp1;
    const tp2Pct = slt.tp2;

    posMgr.init({ symbol, side, entryPrice, slPct, tp1Pct, tp2Pct, size, leverage: CONFIG.leverage, atr });
    try {
      const sl = side === "long"
        ? parseFloat((entryPrice * (1 - slPct  / 100)).toFixed(d))
        : parseFloat((entryPrice * (1 + slPct  / 100)).toFixed(d));
      const tp = side === "long"
        ? parseFloat((entryPrice * (1 + tp2Pct / 100)).toFixed(d))
        : parseFloat((entryPrice * (1 - tp2Pct / 100)).toFixed(d));
      const r = await client.setTpSlForPosition(symbol, side, sl, tp, size, d);
      if (r !== "already_set") logger.info(`[${coin}] SL/TP auto-set (ATR-based): SL=${sl} TP=${tp}`);
    } catch(e) {
      logger.warn(`[${coin}] Set SL/TP gagal: ${e.message.split("\n")[0]}`);
    }
  }

  const eval_ = posMgr.evaluate(symbol, currentPrice);
  // FIX BUG 1: Simpan hasil evaluate terbaru supaya handlePositionClosed bisa baca alasannya
  lastEvalResult[symbol] = eval_;
  const pnlSign = parseFloat(pnlPct) >= 0 ? "+" : "";
  logger.tick(`[${coin}] [${side.toUpperCase()}] $${currentPrice.toFixed(d)} | PnL:$${pnlFromExchange.toFixed(2)}(${pnlSign}${pnlPct}%) | SL:$${eval_.currentSL?.toFixed(d) || "?"} | ${eval_.tp1Hit ? "TP1✅" : "TP1⏳"} | ${eval_.tp2Hit ? "TP2✅" : "TP2⏳"}`);

  // ── TP1 HIT ──────────────────────────────────────────
  if (eval_.action === "TP1_HIT") {
    const closeSize  = calcCloseSize(size, info.minSize, info.sizeDecimals);
    const remainSize = parseFloat((size - closeSize).toFixed(info.sizeDecimals));

    try {
      if (closeSize > 0) {
        await client.partialClose({ symbol, holdSide: side, size: closeSize });
        logger.success(`[${coin}] ✅ TP1 — partial close ${closeSize} unit`);
      }
    } catch(err) {
      logger.warn(`[${coin}] Partial close gagal: ${err.message}`);
    }

    if (eval_.newSL && eval_.tp2 && remainSize >= info.minSize) {
      try {
        await sleep(800);
        await client.updateSl(symbol, side, eval_.newSL, eval_.tp2, remainSize, d);
        logger.success(`[${coin}] 🔒 SL geser ke break even $${eval_.newSL.toFixed(d)}`);
      } catch(err) {
        logger.warn(`[${coin}] Update SL ke break even gagal: ${err.message}`);
      }
    }

    try {
      await notifier.send(
        `🎯 *TP1 HIT — ${coin}*\n` +
        `Close 50% @ \`$${currentPrice.toFixed(d)}\` | PnL: \`$${pnlFromExchange.toFixed(2)}\`\n` +
        `🔒 SL → Break Even \`$${eval_.newSL?.toFixed(d) || "N/A"}\` ✅\n` +
        `🎯 Target TP2: \`$${eval_.tp2?.toFixed(d) || "N/A"}\``
      );
    } catch(e) { logger.warn(`[${coin}] Notif TP1 gagal`); }
    return;
  }

  // ── TRAILING STOP ─────────────────────────────────────
  if (eval_.action === "UPDATE_SL") {
    if (eval_.newSL && eval_.tp2) {
      try {
        await client.updateSl(symbol, side, eval_.newSL, eval_.tp2, size, d);
        logger.info(`[${coin}] 🔒 Trail SL → $${eval_.newSL.toFixed(d)}`);
      } catch(err) {
        logger.warn(`[${coin}] Trail SL update gagal: ${err.message}`);
      }
    }
    return;
  }

  // ── CLOSE ALL (SL hit / TP2 hit) ──────────────────────
  if (eval_.action === "CLOSE_ALL") {
    try {
      await client.closePosition(symbol, side);
    } catch(e) {
      logger.error(`[${coin}] Close gagal: ${e.message}`);
      return;
    }

    // FIX: Ambil actual fill price setelah close
    let actualExitPrice = currentPrice;
    await sleep(800);
    try {
      // Posisi sudah tidak ada, gunakan current price sebagai exit
      // (close market order biasanya filled sangat dekat current price)
      actualExitPrice = currentPrice;
    } catch {}

    const closedMeta  = posMgr.get(symbol);
    const usedLev     = closedMeta?.leverage || CONFIG.leverage;
    const actualEntry = closedMeta?.entryPrice || parseFloat(pos.openPriceAvg || 0);
    const actualDiffPct = ((actualExitPrice - actualEntry) / actualEntry * 100 * (side === "long" ? 1 : -1));
    const actualPnl   = pnlFromExchange; // unrealized PnL dari exchange = realized saat close

    posMgr.remove(symbol);
    delete activePositions[symbol];
    delete lastEvalResult[symbol]; // cleanup

    pnlTracker.record({
      symbol, side,
      entryPrice: actualEntry,
      exitPrice : actualExitPrice,
      size,
      leverage  : usedLev,
      pnl       : actualPnl,
      pnlPct    : parseFloat(actualDiffPct.toFixed(3)),
      closeReason: eval_.tp2Hit ? "TP2" : eval_.tp1Hit ? "SL_AFTER_TP1" : "SL",
      strategy  : "TF",
    });

    if (actualPnl < 0) {
      dailyLoss += Math.abs(actualPnl);
      dailyStats.losses++;
    } else {
      dailyStats.wins++;
    }
    updateStreak(dailyStats, actualPnl >= 0);

    dailyStats.totalPnl += actualPnl;
    dailyStats.trades++;

    const wr    = dailyStats.trades > 0 ? ((dailyStats.wins / dailyStats.trades) * 100).toFixed(0) : 0;
    const emoji = eval_.tp2Hit ? "🏆" : actualPnl >= 0 ? "✅" : "❌";
    try {
      await notifier.send(
        `${emoji} *CLOSE — ${coin}*\n` +
        `${side.toUpperCase()} | PnL: \`$${actualPnl.toFixed(2)}\` (${actualDiffPct >= 0 ? "+" : ""}${actualDiffPct.toFixed(3)}%)\n` +
        `💬 ${eval_.reason}\n` +
        `📊 W:${dailyStats.wins} L:${dailyStats.losses} WR:${wr}% | Total:$${dailyStats.totalPnl.toFixed(2)}`
      );
    } catch(e) { logger.warn(`[${coin}] Notif CLOSE gagal`); }
    return;
  }

  // ── RSI EXTREME EXIT ──────────────────────────────────
  if (rsi > 73 || rsi < 27) {
    const dec = await groq.analyzeOpenPosition({
      side, entryPrice, currentPrice,
      pnl: pnlFromExchange, pnlPct,
      rsi, trend, histogram, atr,
      tp1Hit: eval_.tp1Hit, trailSL: eval_.currentSL,
    });
    if (dec.action === "CLOSE") {
      try { await client.closePosition(symbol, side); } catch {}

      const closedMeta  = posMgr.get(symbol);
      const usedLev     = closedMeta?.leverage || CONFIG.leverage;

      posMgr.remove(symbol);
      delete activePositions[symbol];
      delete lastEvalResult[symbol]; // cleanup

      pnlTracker.record({
        symbol, side,
        entryPrice: parseFloat(pos.openPriceAvg || 0),
        exitPrice : currentPrice,
        size,
        leverage  : usedLev,
        pnl       : pnlFromExchange,
        pnlPct    : parseFloat(pnlPct),
        closeReason: "RSI_EXTREME",
        strategy  : "TF",
      });

      if (pnlFromExchange < 0) {
        dailyLoss += Math.abs(pnlFromExchange);
        dailyStats.losses++;
      } else {
        dailyStats.wins++;
      }
      updateStreak(dailyStats, pnlFromExchange >= 0);
      dailyStats.totalPnl += pnlFromExchange;
      dailyStats.trades++;

      try {
        await notifier.send(
          `⚡ *CLOSE RSI Extreme — ${coin}*\n` +
          `RSI:${rsi.toFixed(1)} | PnL: \`$${pnlFromExchange.toFixed(2)}\`\n` +
          `💬 ${dec.reason}`
        );
      } catch(e) { logger.warn(`[${coin}] Notif RSI close gagal`); }
    }
  }
}

// ─── UTILS ───────────────────────────────────────────────
async function countOpenPositions(client) {
  let count = 0;
  for (const sym of CONFIG.symbols) {
    try {
      const pos = await client.getPosition(sym);
      if (pos && parseFloat(pos.total) > 0) count++;
    } catch(e) {}
  }
  return count;
}

async function withRetry(fn, retries = 2, delayMs = 1000, label = "") {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch(e) {
      if (i === retries) throw e;
      logger.warn(`${label} gagal (attempt ${i+1}/${retries+1}): ${e.message} — retry...`);
      await sleep(delayMs);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────
async function shutdown(signal) {
  botRunning = false;
  const openSymbols = Object.keys(activePositions);
  const wr = dailyStats.trades > 0 ? ((dailyStats.wins / dailyStats.trades) * 100).toFixed(0) : 0;
  logger.info(`\n🛑 Bot stop (${signal}). W:${dailyStats.wins} L:${dailyStats.losses} WR:${wr}% PnL:$${dailyStats.totalPnl.toFixed(2)}`);
  if (openSymbols.length > 0) {
    logger.warn(`⚠️  Posisi masih terbuka: ${openSymbols.join(", ")} — pantau manual!`);
  }
  if (_notifier) {
    try {
      await _notifier.send(
        `🛑 *Bot STOP (${signal})*\n` +
        `📊 W:${dailyStats.wins} L:${dailyStats.losses} WR:${wr}% | PnL:$${dailyStats.totalPnl.toFixed(2)}\n` +
        pnlTracker.summaryMessage() + "\n" +
        (openSymbols.length > 0
          ? `⚠️ *Posisi terbuka: ${openSymbols.map(s => s.replace("USDT","")).join(", ")}*\nClose manual jika perlu!`
          : `✅ Tidak ada posisi terbuka.`)
      );
    } catch(e) { logger.warn(`Notif shutdown gagal: ${e.message}`); }
  }
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", async (err) => {
  logger.error(`💥 Uncaught Exception: ${err.message}`);
  logger.error(err.stack);
  if (_notifier) {
    try {
      await _notifier.send(
        `💥 *Bot CRASH*\n\`${err.message.slice(0, 200)}\`\nBot restart otomatis jika pakai PM2.`
      );
    } catch {}
  }
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error(`💥 Unhandled Rejection: ${msg}`);
  if (_notifier) {
    try { await _notifier.send(`⚠️ *Unhandled Rejection*\n\`${msg.slice(0, 200)}\``); } catch {}
  }
});

main().catch(err => {
  logger.error("Fatal:", err.message);
  process.exit(1);
});