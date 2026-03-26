/**
 * fundingRate.js — Funding Rate Filter
 * 
 * Funding rate = biaya yang dibayar antara long dan short setiap 8 jam
 * Positif  → long bayar ke short (market overbought, banyak yang long)
 * Negatif  → short bayar ke long (market oversold, banyak yang short)
 * 
 * Cara pakai untuk filter entry:
 * - Funding rate sangat positif (+0.05%+) → hindari LONG (sudah crowded)
 * - Funding rate sangat negatif (-0.05%+) → hindari SHORT (sudah crowded)
 * - Funding rate netral (-0.01% ~ +0.01%) → aman entry kedua arah
 */

class FundingRateFilter {
  constructor(client) {
    this.client = client;
    this._cache = {};
    this._cacheTTL = 5 * 60 * 1000;
  }

  async getFundingRate(symbol) {
    const now = Date.now();
    if (this._cache[symbol] && now - this._cache[symbol].ts < this._cacheTTL) {
      return this._cache[symbol].data;
    }

    try {
      const data = await this.client._request(
        'GET',
        '/api/v2/mix/market/current-fund-rate',
        { symbol, productType: process.env.PRODUCT_TYPE || 'USDT-FUTURES' }
      );

      if (!data) return null;

      // Fix NaN: coba ambil dari berbagai kemungkinan struktur response
      const raw    = data?.fundingRate ?? data?.data?.fundingRate;
      const latest = parseFloat(raw);

      if (isNaN(latest)) {
        console.warn(`[FundingRate] ${symbol}: invalid value "${raw}"`);
        return null;
      }

      const result = {
        symbol,
        latest   : latest,
        avg3     : latest,
        latestPct: (latest * 100).toFixed(5),
        avg3Pct  : (latest * 100).toFixed(5),
        trend    : 'STABLE',
        signal   : this._interpretSignal(latest, latest),
      };

      this._cache[symbol] = { ts: now, data: result };
      return result;

    } catch(e) {
      console.warn(`[FundingRate] ${symbol}: fetch error — ${e.message}`);
      return null;
    }
  }

  _interpretSignal(latest, avg3) {
    const r = latest * 100;

    if (r > 0.05)  return { bias: 'LONG_CROWDED',  safe_long: false, safe_short: true,  level: 'EXTREME_POSITIVE' };
    if (r > 0.02)  return { bias: 'LONG_HEAVY',    safe_long: false, safe_short: true,  level: 'HIGH_POSITIVE' };
    if (r > 0.005) return { bias: 'SLIGHT_LONG',   safe_long: true,  safe_short: true,  level: 'MILD_POSITIVE' };
    if (r > -0.005)return { bias: 'NEUTRAL',        safe_long: true,  safe_short: true,  level: 'NEUTRAL' };
    if (r > -0.02) return { bias: 'SLIGHT_SHORT',  safe_long: true,  safe_short: true,  level: 'MILD_NEGATIVE' };
    if (r > -0.05) return { bias: 'SHORT_HEAVY',   safe_long: true,  safe_short: false, level: 'HIGH_NEGATIVE' };
    return           { bias: 'SHORT_CROWDED', safe_long: true,  safe_short: false, level: 'EXTREME_NEGATIVE' };
  }

  async checkEntry(symbol, direction) {
    const fr = await this.getFundingRate(symbol);

    // Fix undefined: kalau gagal fetch, izinkan entry tapi tandai N/A
    if (!fr) return {
      allowed     : true,
      fundingRate : 'N/A',
      level       : 'UNKNOWN',
      bias        : 'UNKNOWN',
      trend       : 'STABLE',
      reason      : 'funding rate tidak tersedia',
    };

    const isLong  = direction === 'LONG';
    const allowed = isLong ? fr.signal.safe_long : fr.signal.safe_short;

    return {
      allowed,
      fundingRate : fr.latestPct + '%',
      level       : fr.signal.level,
      bias        : fr.signal.bias,
      trend       : fr.trend,
      reason      : allowed
        ? `Funding ${fr.latestPct}% (${fr.signal.level}) — aman untuk ${direction}`
        : `Funding ${fr.latestPct}% (${fr.signal.level}) — ${direction} terlalu crowded, skip`,
    };
  }

  async checkAll(symbols) {
    const results = {};
    for (const sym of symbols) {
      results[sym] = await this.getFundingRate(sym);
      await new Promise(r => setTimeout(r, 100));
    }
    return results;
  }
}

module.exports = { FundingRateFilter };