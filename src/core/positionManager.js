/**
 * positionManager.js  v2.1
 * TP1 + TP2 + Geser SL ke Break Even+ + Auto Trailing
 *
 * Fix v2.1:
 * - Terima parameter `atr` saat init untuk ATR-aware trailing
 * - Trailing distance = max(60% dari SL awal, 1.0x ATR%)
 * - Interval update SL minimal 30 detik (hindari spam update ke exchange)
 */

const logger = require("../utils/logger");

class PositionManager {
  constructor() {
    this._positions = {};
  }

  // ─── INIT POSISI BARU ─────────────────────────────────────
  init({ symbol, side, entryPrice, slPct, tp1Pct, tp2Pct, size, leverage, atr }) {
    const isLong = side === "long";

    const sl  = isLong
      ? entryPrice * (1 - slPct  / 100)
      : entryPrice * (1 + slPct  / 100);
    const tp1 = isLong
      ? entryPrice * (1 + tp1Pct / 100)
      : entryPrice * (1 - tp1Pct / 100);
    const tp2 = isLong
      ? entryPrice * (1 + tp2Pct / 100)
      : entryPrice * (1 - tp2Pct / 100);

    // Trailing = max(60% dari SL, 1.0x ATR%) — lebih tight dan ATR-aware
    const atrPct   = atr ? (atr / entryPrice) * 100 : slPct * 0.5;
    const trailPct = Math.max(slPct * 0.6, atrPct * 1.0);

    this._positions[symbol] = {
      side, entryPrice, size, leverage: leverage || 15,
      initialSL   : sl,
      currentSL   : sl,
      tp1, tp2,
      tp1Hit      : false,
      tp2Hit      : false,
      highestPrice: entryPrice,
      lowestPrice : entryPrice,
      trailPct,
      lastSLUpdate: 0,
      trailActive : false,
      atr         : atr || null,
      // Simpan untuk referensi PnL tracking
      slPct, tp1Pct, tp2Pct,
    };

    logger.info(
      `[${symbol}] 📍 Init | Entry:$${entryPrice} ` +
      `SL:$${sl.toFixed(4)} (${slPct.toFixed(2)}%) ` +
      `TP1:$${tp1.toFixed(4)} (${tp1Pct.toFixed(2)}%) ` +
      `TP2:$${tp2.toFixed(4)} (${tp2Pct.toFixed(2)}%) ` +
      `Trail:${trailPct.toFixed(2)}%`
    );
    return this._positions[symbol];
  }

  // ─── EVALUASI TIAP TICK ───────────────────────────────────
  evaluate(symbol, currentPrice) {
    const pos = this._positions[symbol];
    if (!pos) return { action: "HOLD", reason: "Not tracked" };

    const { side, entryPrice, trailPct } = pos;
    const isLong = side === "long";

    // Update high/low
    if (isLong) pos.highestPrice = Math.max(pos.highestPrice, currentPrice);
    else        pos.lowestPrice  = Math.min(pos.lowestPrice,  currentPrice);

    // ── CEK SL HIT ─────────────────────────────────────────
    const slHit = isLong
      ? currentPrice <= pos.currentSL
      : currentPrice >= pos.currentSL;

    if (slHit) {
      const label = pos.tp1Hit ? "Trailing SL" : "Initial SL";
      return {
        action: "CLOSE_ALL",
        reason: `${label} hit @ $${pos.currentSL.toFixed(4)}`,
        tp1Hit: pos.tp1Hit,
      };
    }

    // ── CEK TP1 ─────────────────────────────────────────────
    if (!pos.tp1Hit) {
      const tp1Hit = isLong
        ? currentPrice >= pos.tp1
        : currentPrice <= pos.tp1;

      if (tp1Hit) {
        pos.tp1Hit      = true;
        pos.trailActive = true;

        // Break Even+ (entry + 0.05%)
        const newSL = isLong
          ? entryPrice * 1.0005
          : entryPrice * 0.9995;
        pos.currentSL    = newSL;
        pos.lastSLUpdate = Date.now();

        logger.info(`[${symbol}] 🎯 TP1 HIT! SL → breakeven $${newSL.toFixed(4)} | Trailing aktif`);

        return {
          action   : "TP1_HIT",
          reason   : `TP1 hit @ $${currentPrice.toFixed(4)} | SL → $${newSL.toFixed(4)}`,
          newSL,
          tp2      : pos.tp2,
          closeSize: Math.floor(pos.size * 0.5),
          tp1Hit   : true,
          slMoved  : true,
        };
      }
    }

    // ── CEK TP2 + TRAILING ─────────────────────────────────
    if (pos.tp1Hit && !pos.tp2Hit) {
      // Hitung trailing SL baru
      const newTrail = isLong
        ? pos.highestPrice * (1 - trailPct / 100)
        : pos.lowestPrice  * (1 + trailPct / 100);

      // Trailing hanya naik (tidak boleh turun)
      const trailMoved = isLong
        ? newTrail > pos.currentSL
        : newTrail < pos.currentSL;

      // Rate-limit update SL: minimal 30 detik antar update
      const canUpdate = (Date.now() - pos.lastSLUpdate) > 30_000;

      if (trailMoved && canUpdate) {
        const oldSL      = pos.currentSL;
        pos.currentSL    = newTrail;
        pos.lastSLUpdate = Date.now();

        logger.info(`[${symbol}] 🔒 Trail SL: $${oldSL.toFixed(4)} → $${newTrail.toFixed(4)} (high: $${pos.highestPrice.toFixed(4)})`);

        return {
          action    : "UPDATE_SL",
          reason    : `Trail SL geser ke $${newTrail.toFixed(4)}`,
          newSL     : newTrail,
          tp2       : pos.tp2,
          currentSL : pos.currentSL,
          tp1Hit    : true,
          tp2Hit    : false,
          highestPrice: pos.highestPrice,
          lowestPrice : pos.lowestPrice,
        };
      }

      // Cek TP2
      const tp2Hit = isLong
        ? currentPrice >= pos.tp2
        : currentPrice <= pos.tp2;

      if (tp2Hit) {
        pos.tp2Hit = true;
        logger.info(`[${symbol}] 🎯🎯 TP2 HIT! Close semua sisa posisi`);
        return {
          action: "CLOSE_ALL",
          reason: `TP2 hit @ $${currentPrice.toFixed(4)} — FULL PROFIT!`,
          tp1Hit: true,
          tp2Hit: true,
        };
      }
    }

    return {
      action      : "HOLD",
      reason      : `SL:$${pos.currentSL.toFixed(4)} | TP1:${pos.tp1Hit ? "✅" : "$"+pos.tp1.toFixed(4)} | TP2:$${pos.tp2.toFixed(4)}`,
      currentSL   : pos.currentSL,
      tp1Hit      : pos.tp1Hit,
      tp2Hit      : pos.tp2Hit,
      highestPrice: pos.highestPrice,
      lowestPrice : pos.lowestPrice,
    };
  }

  remove(symbol)     { delete this._positions[symbol]; }
  isTracking(symbol) { return !!this._positions[symbol]; }
  get(symbol)        { return this._positions[symbol] || null; }
}

module.exports = { PositionManager };
