/**
 * technicalAnalysis.js — Advanced Technical Analysis
 * RSI, MACD, BB, EMA, Support/Resistance, Volume, ATR, Stochastic
 * + Mean Reversion untuk market sideways
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
  calcEMAArray(data, period) {
    if (data.length < period) return [];
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
    const fastEMA = this.calcEMAArray(closes, fast);
    const slowEMA = this.calcEMAArray(closes, slow);
    const offset  = fastEMA.length - slowEMA.length;
    const macdLine = slowEMA.map((v,i) => fastEMA[i+offset] - v);
    const signalLine = this.calcEMAArray(macdLine, signalPeriod);
    const sigOffset  = macdLine.length - signalLine.length;
    const lastMACD   = macdLine[macdLine.length-1];
    const lastSignal = signalLine[signalLine.length-1];
    return { macd: lastMACD, signal: lastSignal, histogram: lastMACD-lastSignal, macdLine, signalLine };
  }

  // ─── BOLLINGER BANDS ──────────────────────────────────────
  calcBollingerBands(closes, period=20, mult=2) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const sma   = slice.reduce((a,b)=>a+b,0)/period;
    const std   = Math.sqrt(slice.reduce((a,b)=>a+Math.pow(b-sma,2),0)/period);
    return { upper: sma+mult*std, middle: sma, lower: sma-mult*std, width: (mult*2*std)/sma };
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

  // ─── STOCHASTIC RSI ───────────────────────────────────────
  calcStochRSI(closes, period=14, smoothK=3, smoothD=3) {
    if (closes.length < period * 2 + smoothK + smoothD) return { k: 50, d: 50 };

    // 1. Hitung semua nilai RSI
    const rsiValues = [];
    for (let i = period; i <= closes.length; i++) {
      rsiValues.push(this.calcRSI(closes.slice(0, i), period));
    }

    // 2. Hitung raw StochRSI per bar
    const rawK = [];
    for (let i = period - 1; i < rsiValues.length; i++) {
      const window = rsiValues.slice(i - period + 1, i + 1);
      const minRSI = Math.min(...window);
      const maxRSI = Math.max(...window);
      rawK.push(maxRSI === minRSI ? 50 : ((rsiValues[i] - minRSI) / (maxRSI - minRSI)) * 100);
    }

    // 3. Smooth K dengan SMA(smoothK)
    const smoothedK = [];
    for (let i = smoothK - 1; i < rawK.length; i++) {
      const slice = rawK.slice(i - smoothK + 1, i + 1);
      smoothedK.push(slice.reduce((a, b) => a + b, 0) / smoothK);
    }

    // 4. Smooth D dengan SMA(smoothD) dari K yang sudah di-smooth
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
  calcSupportResistance(candles, lookback=20) {
    const recent = candles.slice(-lookback);
    const highs  = recent.map(c => c.high);
    const lows   = recent.map(c => c.low);
    const price  = candles[candles.length-1].close;

    const pivotHigh = Math.max(...highs);
    const pivotLow  = Math.min(...lows);
    const pivot     = (pivotHigh + pivotLow + candles[candles.length-1].close) / 3;

    const r1 = 2*pivot - pivotLow;
    const s1 = 2*pivot - pivotHigh;
    const r2 = pivot + (pivotHigh - pivotLow);
    const s2 = pivot - (pivotHigh - pivotLow);

    const levels    = [s2, s1, pivot, r1, r2];
    const distances = levels.map(l => Math.abs(price-l)/price*100);
    const nearest   = Math.min(...distances);

    return {
      pivot, r1, r2, s1, s2,
      nearestLevelPct: nearest.toFixed(3),
      atResistance: price >= r1*0.998 && price <= r1*1.002,
      atSupport    : price >= s1*0.998 && price <= s1*1.002,
      zone         : price > r1 ? "ABOVE_R1" : price > pivot ? "ABOVE_PIVOT" :
                     price > s1 ? "BELOW_PIVOT" : "BELOW_S1",
    };
  }

  // ─── VOLUME ANALYSIS ──────────────────────────────────────
  calcVolumeAnalysis(candles, period=10) {
    if (candles.length < period+1) return { surge: 1, trend: "NORMAL" };
    const recent  = candles.slice(-period);
    const avgVol  = recent.reduce((a,c)=>a+c.volume,0)/period;
    const lastVol = candles[candles.length-2]?.volume || candles[candles.length-1].volume;
    const surge   = lastVol/avgVol;
    return {
      surge    : parseFloat(surge.toFixed(2)),
      avgVol,
      lastVol,
      trend    : surge > 2 ? "VERY_HIGH" : surge > 1.5 ? "HIGH" : surge > 0.8 ? "NORMAL" : "LOW",
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
  calcMomentum(candles, period=5) {
    if (candles.length < period+1) return 0;
    const recent = candles.slice(-period);
    const gains  = recent.filter(c => c.close >= c.open).length;
    const score  = (gains/period)*100 - 50;
    return parseFloat(score.toFixed(1));
  }

  // ═══════════════════════════════════════════════════════════
  // ─── MEAN REVERSION — Strategi untuk market sideways ──────
  // ═══════════════════════════════════════════════════════════

  /**
   * Deteksi apakah market sedang sideways/ranging
   * Return: { isSideways, rangeHigh, rangeLow, rangePct, confidence }
   */
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

    // Hitung standard deviation harga relatif terhadap rata-rata
    const stdDev = Math.sqrt(
      closes.reduce((a,b) => a + Math.pow((b - avgClose)/avgClose*100, 2), 0) / closes.length
    );

    // Sideways jika range < 3% dan std dev rendah
    const isSideways = rangePct < 3.0 && stdDev < 0.8;

    // Hitung posisi harga relatif dalam range (0 = bawah, 100 = atas)
    const lastPrice  = closes[closes.length - 1];
    const rangePos   = ((lastPrice - rangeLow) / (rangeHigh - rangeLow)) * 100;

    return {
      isSideways,
      rangeHigh,
      rangeLow,
      rangePct        : parseFloat(rangePct.toFixed(3)),
      stdDev          : parseFloat(stdDev.toFixed(3)),
      rangePosition   : parseFloat(rangePos.toFixed(1)), // 0-100, 0=bawah 100=atas
      confidence      : isSideways ? Math.min(100, (3.0 - rangePct) * 50 + (0.8 - stdDev) * 50) : 0,
    };
  }

  /**
   * Mean Reversion Signal — entry saat harga menyentuh ujung range
   * Strategy: Beli di lower BB + RSI oversold, Jual di upper BB + RSI overbought
   *
   * Return: { signal, direction, confidence, reason, entryPrice, slPct, tp1Pct, tp2Pct }
   */
  calcMeanReversionSignal(candles, bb, rsi, stochRSI, volume, atr) {
    if (!bb || candles.length < 20) return { signal: "NONE" };

    const price    = candles[candles.length - 1].close;
    const sideways = this.detectSidewaysMarket(candles, 20);

    // BB position dalam persentase (0 = lower, 100 = upper)
    const bbRange  = bb.upper - bb.lower;
    const bbPos    = bbRange > 0 ? ((price - bb.lower) / bbRange) * 100 : 50;
    const bbWidth  = bb.width * 100; // dalam %

    // Hitung ATR sebagai % dari harga untuk dynamic SL
    const atrPct   = atr ? (atr / price) * 100 : 0.5;

    // ── LONG SIGNAL (Mean Reversion BUY) ──────────────────
    // Kondisi: harga di lower BB + RSI oversold + volume tidak terlalu rendah
    const longConditions = {
      atLowerBB    : bbPos < 18,                    // was 20 — lebih ketat
      rsiOversold  : rsi < 35,                      // was 40 — 40 bukan oversold!
      stochOversold: stochRSI ? stochRSI.k < 22 : false,
      volumeOK     : volume ? volume.surge > 0.7 : true,
      notDowntrend : !candles.slice(-5).every(c => c.close < c.open),
    };

    const longScore = Object.values(longConditions).filter(Boolean).length;

    // FIX: Require score >= 4 (was 3) — lebih selektif
    // FIX: Harus sideways atau ranging — tidak boleh entry MR saat trending kuat
    const isTrending = ['STRONG_UPTREND','STRONG_DOWNTREND'].includes(
      candles.length >= 20 ? (() => {
        const cls = candles.map(c => c.close);
        const k = 2/21; let ema = cls.slice(0,20).reduce((a,b)=>a+b,0)/20;
        for (let i=20;i<cls.length;i++) ema=cls[i]*k+ema*(1-k);
        const last=cls[cls.length-1];
        if(last>ema*1.003)return 'STRONG_UPTREND';
        if(last<ema*0.997)return 'STRONG_DOWNTREND';
        return 'OTHER';
      })() : 'OTHER'
    );

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
        suggestedLev: sideways.isSideways ? 30 : 20, // lebih agresif kalau confirmed sideways
      };
    }

    // ── SHORT SIGNAL (Mean Reversion SELL) ────────────────
    const shortConditions = {
      atUpperBB     : bbPos > 82,              // was 80 — lebih ketat
      rsiOverbought : rsi > 68,                // was 60 — 60 bukan overbought!
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
        suggestedLev: sideways.isSideways ? 30 : 20,
      };
    }

    return { signal: "NONE", bbPosition: bbPos, sideways: sideways.isSideways };
  }

  /**
   * Deteksi kondisi pasar: TRENDING atau RANGING
   * Pakai ADX-like calculation sederhana
   */
  // ─── LIQUIDITY SWEEP DETECTOR ─────────────────────────────
  // Deteksi candle "fake break" yang menembus level lalu close kembali ke range
  // Ini tanda classic stop hunt / liquidity grab sebelum reversal
  //
  // BEAR_SWEEP : spike tajam ke bawah low range → close kembali → potensi LONG
  // BULL_SWEEP : spike tajam ke atas high range → close kembali → potensi SHORT
  //
  // Return: { isSweep, type, confidence, wickPct, volSurge, sweptLevel, reason }
  detectLiquiditySweep(candles, lookback = 20) {
    if (candles.length < lookback + 2) return { isSweep: false };

    const recent  = candles.slice(-(lookback + 1));
    const current = candles[candles.length - 1];

    // Range dari N candle sebelum candle terakhir
    const rangeCandles = recent.slice(0, -1);
    const rangeHigh    = Math.max(...rangeCandles.map(c => c.high));
    const rangeLow     = Math.min(...rangeCandles.map(c => c.low));
    const rangeSize    = rangeHigh - rangeLow;
    if (rangeSize === 0) return { isSweep: false };

    const avgVol   = rangeCandles.reduce((s, c) => s + c.volume, 0) / lookback;
    const volSurge = current.volume / (avgVol || 1);

    // ── BEAR SWEEP: spike ke bawah rangeLow tapi close kembali di atas ──
    const brokeBelow  = current.low  < rangeLow;
    const closedBack  = current.close > rangeLow * 0.999;
    const wickDown    = brokeBelow ? ((rangeLow - current.low) / rangeSize) * 100 : 0;

    if (brokeBelow && closedBack && wickDown > 0.5 && volSurge > 1.3) {
      const conf = Math.min(0.90,
        0.50 +
        (wickDown > 2.0 ? 0.15 : 0.05) +
        (volSurge > 2.0 ? 0.15 : volSurge > 1.5 ? 0.08 : 0) +
        (current.close > current.open ? 0.10 : 0)   // candle bullish setelah sweep
      );
      return {
        isSweep    : true,
        type       : 'BEAR_SWEEP',
        confidence : parseFloat(conf.toFixed(2)),
        wickPct    : parseFloat(wickDown.toFixed(2)),
        volSurge   : parseFloat(volSurge.toFixed(2)),
        sweptLevel : parseFloat(rangeLow.toFixed(6)),
        reason     : `Bear sweep: wick ${wickDown.toFixed(1)}% bawah low, vol ${volSurge.toFixed(1)}x, close kembali → potensi LONG`,
      };
    }

    // ── BULL SWEEP: spike ke atas rangeHigh tapi close kembali di bawah ──
    const brokeAbove    = current.high  > rangeHigh;
    const closedBackTop = current.close < rangeHigh * 1.001;
    const wickUp        = brokeAbove ? ((current.high - rangeHigh) / rangeSize) * 100 : 0;

    if (brokeAbove && closedBackTop && wickUp > 0.5 && volSurge > 1.3) {
      const conf = Math.min(0.90,
        0.50 +
        (wickUp > 2.0 ? 0.15 : 0.05) +
        (volSurge > 2.0 ? 0.15 : volSurge > 1.5 ? 0.08 : 0) +
        (current.close < current.open ? 0.10 : 0)   // candle bearish setelah sweep
      );
      return {
        isSweep    : true,
        type       : 'BULL_SWEEP',
        confidence : parseFloat(conf.toFixed(2)),
        wickPct    : parseFloat(wickUp.toFixed(2)),
        volSurge   : parseFloat(volSurge.toFixed(2)),
        sweptLevel : parseFloat(rangeHigh.toFixed(6)),
        reason     : `Bull sweep: wick ${wickUp.toFixed(1)}% atas high, vol ${volSurge.toFixed(1)}x, close kembali → potensi SHORT`,
      };
    }

    return { isSweep: false };
  }

  getMarketCondition(candles, period=14) {
    if (candles.length < period + 1) return "UNKNOWN";

    // Hitung directional movement
    let dmPlus = 0, dmMinus = 0, atr = 0;
    for (let i = 1; i < Math.min(candles.length, period + 1); i++) {
      const curr = candles[candles.length - i];
      const prev = candles[candles.length - i - 1];

      const upMove   = curr.high - prev.high;
      const downMove = prev.low  - curr.low;
      const tr       = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));

      if (upMove > downMove && upMove > 0)   dmPlus  += upMove;
      if (downMove > upMove && downMove > 0) dmMinus += downMove;
      atr += tr;
    }

    if (atr === 0) return "RANGING";
    const diPlus  = (dmPlus  / atr) * 100;
    const diMinus = (dmMinus / atr) * 100;
    const adx     = Math.abs(diPlus - diMinus) / (diPlus + diMinus + 0.001) * 100;

    // ADX > 25 = trending, < 20 = ranging
    if (adx > 25) return diPlus > diMinus ? "TRENDING_UP" : "TRENDING_DOWN";
    if (adx < 20) return "RANGING";
    return "WEAK_TREND";
  }
}

module.exports = { TechnicalAnalysis };