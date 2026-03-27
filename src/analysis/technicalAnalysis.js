/**
 * technicalAnalysis.js — Advanced Technical Analysis  v2.1
 * RSI, MACD, BB, EMA, Support/Resistance, Volume, ATR, Stochastic
 * + Mean Reversion untuk market sideways
 *
 * Fixes v2.1:
 * - calcMomentum: magnitude-weighted (ATR-normalized) bukan sekedar candle count
 * - calcVolumeAnalysis: fix bug volume -2 → pakai candle terbaru, avg exclude candle terakhir
 * - detectSidewaysMarket: threshold 4.5%/1.2 stdDev (was 3.0/0.8) — realistis untuk SOL 1m
 * - calcSupportResistance: tambah touched-level clustering (2+ touch = valid S/R)
 * - getMarketCondition: proper Wilder-smoothed ADX, bukan raw DM sum yang noisy
 * - calcEMAArray: guard jika data kurang dari period
 * - calcBollingerBands: tambah %B indicator
 * - getATRArray: Wilder-smoothed ATR array untuk trailing SL dinamis
 * - MR suggestedLev diturunkan 30/20 → 20/15 (lebih konservatif)
 */

class TechnicalAnalysis {
  calculate(candles, rsiPeriod=14, fast=12, slow=26, signalPeriod=9) {
    const closes = candles.map(c => c.close);
    const rsi    = this.calcRSI(closes, rsiPeriod);
    const { macd, signal, histogram } = this.calcMACD(closes, fast, slow, signalPeriod);
    return { rsi, macd, signal, histogram };
  }

  // ─── RSI ──────────────────────────────────────────────────
  calcRSI(closes, period=14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i-1];
      if (d >= 0) gains += d; else losses += Math.abs(d);
    }
    let ag = gains / period, al = losses / period;
    for (let i = period+1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      ag = (ag*(period-1) + Math.max(d,0)) / period;
      al = (al*(period-1) + Math.max(-d,0)) / period;
    }
    if (al === 0) return 100;
    return 100 - 100/(1 + ag/al);
  }

  // ─── EMA ──────────────────────────────────────────────────
  // FIX v2.1: guard jika data kurang dari period
  calcEMAArray(data, period) {
    if (!data || data.length < period) return data?.length ? [data[data.length-1]] : [0];
    const k = 2/(period+1);
    let ema = data.slice(0,period).reduce((a,b)=>a+b,0)/period;
    const result = [ema];
    for (let i = period; i < data.length; i++) {
      ema = data[i]*k + ema*(1-k);
      result.push(ema);
    }
    return result;
  }

  calcEMA(data, period) {
    const arr = this.calcEMAArray(data, period);
    return arr[arr.length-1] || data[data.length-1];
  }

  // ─── MACD ─────────────────────────────────────────────────
  calcMACD(closes, fast=12, slow=26, signalPeriod=9) {
    const fastEMA  = this.calcEMAArray(closes, fast);
    const slowEMA  = this.calcEMAArray(closes, slow);
    const offset   = fastEMA.length - slowEMA.length;
    const macdLine = slowEMA.map((v,i) => fastEMA[i+offset] - v);
    const signalLine = this.calcEMAArray(macdLine, signalPeriod);
    const lastMACD   = macdLine[macdLine.length-1];
    const lastSignal = signalLine[signalLine.length-1];
    return { macd: lastMACD, signal: lastSignal, histogram: lastMACD-lastSignal, macdLine, signalLine };
  }

  // ─── BOLLINGER BANDS ──────────────────────────────────────
  // FIX v2.1: tambah %B indicator (posisi harga dalam band 0-1)
  calcBollingerBands(closes, period=20, mult=2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const sma   = slice.reduce((a,b)=>a+b,0)/period;
    const std   = Math.sqrt(slice.reduce((a,b)=>a+Math.pow(b-sma,2),0)/period);
    const upper = sma + mult*std;
    const lower = sma - mult*std;
    const last  = closes[closes.length-1];
    // %B: 0 = di lower band, 1 = di upper band; bisa <0 atau >1 jika keluar band
    const pctB  = std > 0 ? (last - lower) / (upper - lower) : 0.5;
    return {
      upper,
      middle: sma,
      lower,
      width : (mult*2*std)/sma,
      pctB  : parseFloat(pctB.toFixed(3)),
    };
  }

  // ─── ATR ──────────────────────────────────────────────────
  calcATR(candles, period=14) {
    if (candles.length < period+1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
      trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    }
    return trs.slice(-period).reduce((a,b)=>a+b,0)/period;
  }

  // NEW v2.1: Wilder-smoothed ATR array untuk trailing SL dinamis
  getATRArray(candles, period=14) {
    if (candles.length < period+1) return [];
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
      trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    }
    let atr = trs.slice(0,period).reduce((a,b)=>a+b,0)/period;
    const atrs = [atr];
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period-1) + trs[i]) / period;
      atrs.push(atr);
    }
    return atrs;
  }

  // ─── STOCHASTIC RSI ───────────────────────────────────────
  calcStochRSI(closes, period=14, smoothK=3, smoothD=3) {
    if (closes.length < period * 2 + smoothK + smoothD) return { k: 50, d: 50 };

    const rsiValues = [];
    for (let i = period; i <= closes.length; i++) {
      rsiValues.push(this.calcRSI(closes.slice(0, i), period));
    }

    const rawK = [];
    for (let i = period - 1; i < rsiValues.length; i++) {
      const window = rsiValues.slice(i - period + 1, i + 1);
      const minRSI = Math.min(...window);
      const maxRSI = Math.max(...window);
      rawK.push(maxRSI === minRSI ? 50 : ((rsiValues[i] - minRSI) / (maxRSI - minRSI)) * 100);
    }

    const smoothedK = [];
    for (let i = smoothK - 1; i < rawK.length; i++) {
      const slice = rawK.slice(i - smoothK + 1, i + 1);
      smoothedK.push(slice.reduce((a, b) => a + b, 0) / smoothK);
    }

    const smoothedD = [];
    for (let i = smoothD - 1; i < smoothedK.length; i++) {
      const slice = smoothedK.slice(i - smoothD + 1, i + 1);
      smoothedD.push(slice.reduce((a, b) => a + b, 0) / smoothD);
    }

    const k = smoothedK[smoothedK.length - 1] ?? 50;
    const d = smoothedD[smoothedD.length - 1] ?? 50;
    return {
      k: parseFloat(k.toFixed(2)),
      d: parseFloat(d.toFixed(2)),
    };
  }

  // ─── SUPPORT & RESISTANCE ─────────────────────────────────
  // FIX v2.1: tambah touched-level clustering — level 2+ kali di-hit lebih kuat
  calcSupportResistance(candles, lookback=20) {
    const recent = candles.slice(-lookback);
    const highs  = recent.map(c => c.high);
    const lows   = recent.map(c => c.low);
    const price  = candles[candles.length-1].close;

    const pivotHigh = Math.max(...highs);
    const pivotLow  = Math.min(...lows);
    const pivot     = (pivotHigh + pivotLow + price) / 3;

    const r1 = 2*pivot - pivotLow;
    const s1 = 2*pivot - pivotHigh;
    const r2 = pivot + (pivotHigh - pivotLow);
    const s2 = pivot - (pivotHigh - pivotLow);

    // Cluster highs/lows untuk temukan level yang benar-benar di-touch
    const touchThreshold  = price * 0.0015; // 0.15% tolerance
    const highClusters    = this._findClusters(highs, touchThreshold);
    const lowClusters     = this._findClusters(lows,  touchThreshold);
    const strongResistance = highClusters.sort((a,b) => b.count - a.count)[0]?.level || r1;
    const strongSupport    = lowClusters.sort((a,b)  => b.count - a.count)[0]?.level || s1;

    const levels    = [s2, s1, pivot, r1, r2];
    const distances = levels.map(l => Math.abs(price-l)/price*100);

    return {
      pivot, r1, r2, s1, s2,
      strongResistance: parseFloat(strongResistance.toFixed(6)),
      strongSupport   : parseFloat(strongSupport.toFixed(6)),
      nearestLevelPct : Math.min(...distances).toFixed(3),
      atResistance    : Math.abs(price - strongResistance) / price < 0.002,
      atSupport       : Math.abs(price - strongSupport)    / price < 0.002,
      zone            : price > r1 ? "ABOVE_R1" : price > pivot ? "ABOVE_PIVOT" :
                        price > s1 ? "BELOW_PIVOT" : "BELOW_S1",
    };
  }

  // Helper: cluster harga yang sering di-touch (2+ touch = valid level)
  _findClusters(levels, threshold) {
    const clusters = [];
    for (const level of levels) {
      const existing = clusters.find(c => Math.abs(c.level - level) < threshold);
      if (existing) {
        existing.count++;
        existing.level = (existing.level + level) / 2;
      } else {
        clusters.push({ level, count: 1 });
      }
    }
    return clusters.filter(c => c.count >= 2);
  }

  // ─── VOLUME ANALYSIS ──────────────────────────────────────
  // FIX v2.1: bug lama pakai candle[-2] → sekarang pakai candle terbaru
  // avg dihitung dari N candle sebelum candle terakhir (exclude last)
  calcVolumeAnalysis(candles, period=10) {
    if (candles.length < period+1) return { surge: 1, trend: "NORMAL", avgVol: 0, lastVol: 0, volTrend: "FLAT" };
    const histCandles = candles.slice(-(period+1), -1);
    const avgVol  = histCandles.reduce((a,c) => a + c.volume, 0) / period;
    const lastVol = candles[candles.length-1].volume;
    const surge   = avgVol > 0 ? lastVol / avgVol : 1;

    // Arah volume: apakah naik atau turun dalam 5 candle terakhir
    const recentVols = candles.slice(-5).map(c => c.volume);
    const volTrend   = recentVols[recentVols.length-1] > recentVols[0] ? "INCREASING" : "DECREASING";

    return {
      surge   : parseFloat(surge.toFixed(2)),
      avgVol,
      lastVol,
      trend   : surge > 2 ? "VERY_HIGH" : surge > 1.5 ? "HIGH" : surge > 0.8 ? "NORMAL" : "LOW",
      volTrend,
    };
  }

  // ─── MULTI-TIMEFRAME TREND ────────────────────────────────
  getTrend(candles, emaPeriod=20) {
    const closes    = candles.map(c => c.close);
    const ema       = this.calcEMA(closes, emaPeriod);
    const ema50     = this.calcEMA(closes, Math.min(50, closes.length-1));
    const lastClose = closes[closes.length-1];

    if (lastClose > ema*1.002 && ema > ema50*1.001) return "STRONG_UPTREND";
    if (lastClose > ema*1.001) return "UPTREND";
    if (lastClose < ema*0.998 && ema < ema50*0.999) return "STRONG_DOWNTREND";
    if (lastClose < ema*0.999) return "DOWNTREND";
    return "SIDEWAYS";
  }

  // ─── CANDLESTICK PATTERNS ─────────────────────────────────
  detectPattern(candles) {
    const len = candles.length;
    if (len < 3) return "NONE";
    const c  = candles[len-1];
    const p  = candles[len-2];
    const pp = candles[len-3];

    const body    = Math.abs(c.close - c.open);
    const range   = c.high - c.low;
    const isGreen = c.close > c.open;
    const isRed   = c.close < c.open;

    if (range === 0) return "NONE";
    if (body/range < 0.1) return "DOJI";
    if (isGreen && (c.low - Math.min(c.open,c.close)) > body*2) return "HAMMER";
    if (isRed && (Math.max(c.open,c.close) - c.high) < -body*2) return "SHOOTING_STAR";
    if (isGreen && p.close < p.open && c.close > p.open && c.open < p.close) return "BULLISH_ENGULFING";
    if (isRed && p.close > p.open && c.close < p.open && c.open > p.close) return "BEARISH_ENGULFING";
    if (isGreen && p.close > p.open && pp.close > pp.open) return "THREE_GREEN";
    if (isRed && p.close < p.open && pp.close < pp.open) return "THREE_RED";
    return "NONE";
  }

  // ─── MOMENTUM SCORE ───────────────────────────────────────
  // FIX v2.1: magnitude-weighted, ATR-normalized
  // Sebelumnya: hitung candle hijau (misleading saat banyak doji kecil)
  // Sekarang: net price movement / ATR → angka bermakna secara volatilitas
  calcMomentum(candles, period=5) {
    if (candles.length < period+1) return 0;
    const recent  = candles.slice(-period);
    const atr     = this.calcATR(candles, Math.min(14, candles.length-1));
    const norm    = atr > 0 ? atr : 1;
    const netMove = recent.reduce((sum, c) => sum + (c.close - c.open), 0);
    const score   = (netMove / norm) * 10;
    return parseFloat(Math.max(-50, Math.min(50, score)).toFixed(1));
  }

  // ═══════════════════════════════════════════════════════════
  // ─── MEAN REVERSION ───────────────────────────────────────
  // ═══════════════════════════════════════════════════════════

  detectSidewaysMarket(candles, period=20) {
    if (candles.length < period) return { isSideways: false };

    const recent = candles.slice(-period);
    const highs  = recent.map(c => c.high);
    const lows   = recent.map(c => c.low);
    const closes = recent.map(c => c.close);

    const rangeHigh = Math.max(...highs);
    const rangeLow  = Math.min(...lows);
    const rangePct  = ((rangeHigh - rangeLow) / rangeLow) * 100;
    const avgClose  = closes.reduce((a,b)=>a+b,0) / closes.length;

    const stdDev = Math.sqrt(
      closes.reduce((a,b) => a + Math.pow((b - avgClose)/avgClose*100, 2), 0) / closes.length
    );

    // FIX v2.1: threshold disesuaikan untuk SOLUSDT 1m yang volatile
    // was: rangePct < 3.0 && stdDev < 0.8  (terlalu jarang trigger)
    // now: rangePct < 4.5 && stdDev < 1.2  (lebih realistis)
    const isSideways = rangePct < 4.5 && stdDev < 1.2;

    const lastPrice = closes[closes.length - 1];
    const rangePos  = rangeHigh > rangeLow
      ? ((lastPrice - rangeLow) / (rangeHigh - rangeLow)) * 100
      : 50;

    return {
      isSideways,
      rangeHigh,
      rangeLow,
      rangePct      : parseFloat(rangePct.toFixed(3)),
      stdDev        : parseFloat(stdDev.toFixed(3)),
      rangePosition : parseFloat(rangePos.toFixed(1)),
      confidence    : isSideways
        ? Math.min(100, (4.5 - rangePct) * 40 + (1.2 - stdDev) * 40)
        : 0,
    };
  }

  calcMeanReversionSignal(candles, bb, rsi, stochRSI, volume, atr) {
    if (!bb || candles.length < 20) return { signal: "NONE" };

    const price    = candles[candles.length - 1].close;
    const sideways = this.detectSidewaysMarket(candles, 20);

    const bbRange  = bb.upper - bb.lower;
    const bbPos    = bbRange > 0 ? ((price - bb.lower) / bbRange) * 100 : 50;
    const bbWidth  = bb.width * 100;
    const atrPct   = atr ? (atr / price) * 100 : 0.5;

    const _quickTrend = () => {
      const cls = candles.map(c => c.close);
      if (cls.length < 21) return 'OTHER';
      const k = 2/21; let ema = cls.slice(0,20).reduce((a,b)=>a+b,0)/20;
      for (let i=20;i<cls.length;i++) ema=cls[i]*k+ema*(1-k);
      const last = cls[cls.length-1];
      if (last > ema*1.003) return 'STRONG_UPTREND';
      if (last < ema*0.997) return 'STRONG_DOWNTREND';
      return 'OTHER';
    };
    const isTrending = ['STRONG_UPTREND','STRONG_DOWNTREND'].includes(_quickTrend());

    // ── LONG SIGNAL ─────────────────────────────────────────
    const longConditions = {
      atLowerBB    : bbPos < 18,
      rsiOversold  : rsi < 35,
      stochOversold: stochRSI ? stochRSI.k < 22 : false,
      volumeOK     : volume ? volume.surge > 0.7 : true,
      notDowntrend : !candles.slice(-5).every(c => c.close < c.open),
    };
    const longScore = Object.values(longConditions).filter(Boolean).length;

    if (longScore >= 4 && longConditions.atLowerBB && longConditions.rsiOversold && !isTrending) {
      const confidence = 0.57 + (longScore - 4) * 0.08 + (sideways.isSideways ? 0.08 : 0);
      const slPct  = Math.max(atrPct * 1.5, 0.6);
      const tp1Pct = Math.max(Math.min(bbWidth * 0.4, 1.5), slPct * 1.5);
      const tp2Pct = Math.max(Math.min(bbWidth * 0.8, 2.5), slPct * 2.5);
      return {
        signal     : "MEAN_REV_BUY",
        direction  : "LONG",
        confidence : Math.min(0.82, confidence),
        reason     : `MR: BB ${bbPos.toFixed(0)}% RSI:${rsi.toFixed(0)} Cond:${longScore}/5`,
        bbPosition : bbPos,
        sideways   : sideways.isSideways,
        slPct      : parseFloat(slPct.toFixed(2)),
        tp1Pct     : parseFloat(tp1Pct.toFixed(2)),
        tp2Pct     : parseFloat(tp2Pct.toFixed(2)),
        // FIX v2.1: turunkan dari 30/20 → 20/15 (lebih konservatif untuk MR)
        suggestedLev: sideways.isSideways ? 20 : 15,
      };
    }

    // ── SHORT SIGNAL ────────────────────────────────────────
    const shortConditions = {
      atUpperBB     : bbPos > 82,
      rsiOverbought : rsi > 68,
      stochOverbot  : stochRSI ? stochRSI.k > 78 : false,
      volumeOK      : volume ? volume.surge > 0.7 : true,
      notUptrend    : !candles.slice(-5).every(c => c.close > c.open),
    };
    const shortScore = Object.values(shortConditions).filter(Boolean).length;

    if (shortScore >= 4 && shortConditions.atUpperBB && shortConditions.rsiOverbought && !isTrending) {
      const confidence = 0.57 + (shortScore - 4) * 0.08 + (sideways.isSideways ? 0.08 : 0);
      const slPct  = Math.max(atrPct * 1.5, 0.6);
      const tp1Pct = Math.max(Math.min(bbWidth * 0.4, 1.5), slPct * 1.5);
      const tp2Pct = Math.max(Math.min(bbWidth * 0.8, 2.5), slPct * 2.5);
      return {
        signal     : "MEAN_REV_SELL",
        direction  : "SHORT",
        confidence : Math.min(0.82, confidence),
        reason     : `MR: BB ${bbPos.toFixed(0)}% RSI:${rsi.toFixed(0)} Cond:${shortScore}/5`,
        bbPosition : bbPos,
        sideways   : sideways.isSideways,
        slPct      : parseFloat(slPct.toFixed(2)),
        tp1Pct     : parseFloat(tp1Pct.toFixed(2)),
        tp2Pct     : parseFloat(tp2Pct.toFixed(2)),
        suggestedLev: sideways.isSideways ? 20 : 15,
      };
    }

    return { signal: "NONE", bbPosition: bbPos, sideways: sideways.isSideways };
  }

  // ─── MARKET CONDITION — proper Wilder-smoothed ADX ────────
  // FIX v2.1: raw DM sum tanpa smoothing → noisy dan tidak akurat
  // Sekarang: Wilder smoothing pada TR, +DM, -DM sebelum hitung DI dan DX
  getMarketCondition(candles, period=14) {
    if (candles.length < period * 2) return "UNKNOWN";

    const trArr = [], dmPlusArr = [], dmMinusArr = [];

    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i], prev = candles[i-1];
      const upMove   = curr.high - prev.high;
      const downMove = prev.low  - curr.low;
      trArr.push(Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low  - prev.close)
      ));
      dmPlusArr.push(upMove   > downMove && upMove   > 0 ? upMove   : 0);
      dmMinusArr.push(downMove > upMove  && downMove > 0 ? downMove : 0);
    }

    // Wilder smoothing: sum(1..period), lalu rolling
    const _wilderSmooth = (arr, p) => {
      if (arr.length < p) return 0;
      let sum = arr.slice(0, p).reduce((a,b) => a+b, 0);
      for (let i = p; i < arr.length; i++) sum = sum - sum/p + arr[i];
      return sum;
    };

    const atrS  = _wilderSmooth(trArr,      period);
    const dmPlusS  = _wilderSmooth(dmPlusArr,  period);
    const dmMinusS = _wilderSmooth(dmMinusArr, period);

    if (atrS === 0) return "RANGING";

    const diPlus  = (dmPlusS  / atrS) * 100;
    const diMinus = (dmMinusS / atrS) * 100;
    const dx      = Math.abs(diPlus - diMinus) / (diPlus + diMinus + 0.001) * 100;

    // dx sebagai proxy ADX (simplified — full ADX perlu smoothing DX juga)
    if (dx > 25) return diPlus > diMinus ? "TRENDING_UP" : "TRENDING_DOWN";
    if (dx < 20) return "RANGING";
    return "WEAK_TREND";
  }

  // ─── LIQUIDITY SWEEP DETECTOR ─────────────────────────────
  detectLiquiditySweep(candles, lookback=20) {
    if (candles.length < lookback + 2) return { isSweep: false };

    const recent       = candles.slice(-(lookback + 1));
    const current      = candles[candles.length - 1];
    const rangeCandles = recent.slice(0, -1);
    const rangeHigh    = Math.max(...rangeCandles.map(c => c.high));
    const rangeLow     = Math.min(...rangeCandles.map(c => c.low));
    const rangeSize    = rangeHigh - rangeLow;
    if (rangeSize === 0) return { isSweep: false };

    const avgVol   = rangeCandles.reduce((s, c) => s + c.volume, 0) / lookback;
    const volSurge = current.volume / (avgVol || 1);

    // ── BEAR SWEEP ──────────────────────────────────────────
    const brokeBelow = current.low  < rangeLow;
    const closedBack = current.close > rangeLow * 0.999;
    const wickDown   = brokeBelow ? ((rangeLow - current.low) / rangeSize) * 100 : 0;

    if (brokeBelow && closedBack && wickDown > 0.5 && volSurge > 1.3) {
      const conf = Math.min(0.90,
        0.50 +
        (wickDown  > 2.0 ? 0.15 : 0.05) +
        (volSurge  > 2.0 ? 0.15 : volSurge > 1.5 ? 0.08 : 0) +
        (current.close > current.open ? 0.10 : 0)
      );
      return {
        isSweep    : true,
        type       : 'BEAR_SWEEP',
        confidence : parseFloat(conf.toFixed(2)),
        wickPct    : parseFloat(wickDown.toFixed(2)),
        volSurge   : parseFloat(volSurge.toFixed(2)),
        sweptLevel : parseFloat(rangeLow.toFixed(6)),
        reason     : `Bear sweep: wick ${wickDown.toFixed(1)}% bawah low, vol ${volSurge.toFixed(1)}x → potensi LONG`,
      };
    }

    // ── BULL SWEEP ──────────────────────────────────────────
    const brokeAbove    = current.high  > rangeHigh;
    const closedBackTop = current.close < rangeHigh * 1.001;
    const wickUp        = brokeAbove ? ((current.high - rangeHigh) / rangeSize) * 100 : 0;

    if (brokeAbove && closedBackTop && wickUp > 0.5 && volSurge > 1.3) {
      const conf = Math.min(0.90,
        0.50 +
        (wickUp   > 2.0 ? 0.15 : 0.05) +
        (volSurge > 2.0 ? 0.15 : volSurge > 1.5 ? 0.08 : 0) +
        (current.close < current.open ? 0.10 : 0)
      );
      return {
        isSweep    : true,
        type       : 'BULL_SWEEP',
        confidence : parseFloat(conf.toFixed(2)),
        wickPct    : parseFloat(wickUp.toFixed(2)),
        volSurge   : parseFloat(volSurge.toFixed(2)),
        sweptLevel : parseFloat(rangeHigh.toFixed(6)),
        reason     : `Bull sweep: wick ${wickUp.toFixed(1)}% atas high, vol ${volSurge.toFixed(1)}x → potensi SHORT`,
      };
    }

    return { isSweep: false };
  }
}

module.exports = { TechnicalAnalysis };