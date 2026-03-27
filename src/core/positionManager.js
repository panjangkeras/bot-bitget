/**
 * positionManager.js  v2.2
 * TP1 + TP2 + Geser SL ke Break Even+ + Auto Trailing + Time-Based Exit
 *
 * NEW v2.2:
 * - Time-based exit: posisi yang stuck terlalu lama ditutup di breakeven/kecil loss
 * - 3 fase waktu:
 *   FASE 1 (0–20 menit)  : Normal, tunggu TP/SL
 *   FASE 2 (20–45 menit) : Warning zone, SL digeser ke breakeven jika profit
 *   FASE 3 (>45 menit)   : Force close jika masih belum TP1 — buang opportunity cost
 * - Setelah TP1 hit, timer di-reset (posisi sudah aman, biarkan trailing kerja)
 */

const logger = require("../utils/logger");

// Batas waktu — bisa override via env
const TIME_WARN_MS  = parseInt(process.env.TIME_WARN_MINUTES  || 20) * 60 * 1000;  // default 20 menit
const TIME_CLOSE_MS = parseInt(process.env.TIME_CLOSE_MINUTES || 45) * 60 * 1000;  // default 45 menit

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
      slPct, tp1Pct, tp2Pct,
      // ── NEW: Time tracking ──────────────────────────────
      openedAt    : Date.now(),
      timeWarnSent: false,   // sudah kirim warning belum
      tp1HitAt    : null,    // reset timer setelah TP1
    };

    logger.info(
      `[${symbol}] 📍 Init | Entry:$${entryPrice} ` +
      `SL:$${sl.toFixed(4)} (${slPct.toFixed(2)}%) ` +
      `TP1:$${tp1.toFixed(4)} (${tp1Pct.toFixed(2)}%) ` +
      `TP2:$${tp2.toFixed(4)} (${tp2Pct.toFixed(2)}%) ` +
      `Trail:${trailPct.toFixed(2)}% | TimeLimit:${TIME_CLOSE_MS/60000}m`
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
        pos.tp1HitAt    = Date.now();  // reset timer
        pos.trailActive = true;

        const newSL = isLong
          ? entryPrice * 1.0005
          : entryPrice * 0.9995;
        pos.currentSL    = newSL;
        pos.lastSLUpdate = Date.now();

        logger.info(`[${symbol}] 🎯 TP1 HIT! SL → breakeven $${newSL.toFixed(4)} | Trailing aktif | Timer reset`);

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

      // ── TIME-BASED EXIT (hanya berlaku sebelum TP1) ──────
      const timeResult = this._checkTimeExit(pos, symbol, currentPrice, isLong);
      if (timeResult) return timeResult;
    }

    // ── CEK TP2 + TRAILING ─────────────────────────────────
    if (pos.tp1Hit && !pos.tp2Hit) {
      const newTrail = isLong
        ? pos.highestPrice * (1 - trailPct / 100)
        : pos.lowestPrice  * (1 + trailPct / 100);

      const trailMoved = isLong
        ? newTrail > pos.currentSL
        : newTrail < pos.currentSL;

      const canUpdate = (Date.now() - pos.lastSLUpdate) > 30_000;

      if (trailMoved && canUpdate) {
        const oldSL      = pos.currentSL;
        pos.currentSL    = newTrail;
        pos.lastSLUpdate = Date.now();

        logger.info(`[${symbol}] 🔒 Trail SL: $${oldSL.toFixed(4)} → $${newTrail.toFixed(4)}`);

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

    // ── HOLD: Sertakan info waktu di response ───────────────
    const ageMs  = Date.now() - pos.openedAt;
    const ageMin = (ageMs / 60000).toFixed(0);
    const timeTag = ageMs > TIME_WARN_MS ? ` | ⏰ ${ageMin}m` : "";

    return {
      action      : "HOLD",
      reason      : `SL:$${pos.currentSL.toFixed(4)} | TP1:${pos.tp1Hit ? "✅" : "$"+pos.tp1.toFixed(4)} | TP2:$${pos.tp2.toFixed(4)}${timeTag}`,
      currentSL   : pos.currentSL,
      tp1Hit      : pos.tp1Hit,
      tp2Hit      : pos.tp2Hit,
      highestPrice: pos.highestPrice,
      lowestPrice : pos.lowestPrice,
      ageMinutes  : parseFloat(ageMin),
    };
  }

  // ─── TIME-BASED EXIT LOGIC ────────────────────────────────
  _checkTimeExit(pos, symbol, currentPrice, isLong) {
    const now    = Date.now();
    const ageMs  = now - pos.openedAt;
    const ageMin = (ageMs / 60000).toFixed(1);

    // FASE 1: Masih dalam batas normal
    if (ageMs < TIME_WARN_MS) return null;

    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100 * (isLong ? 1 : -1));

    // FASE 2: Warning zone (20–45 menit) — geser SL ke breakeven jika sedang profit
    if (ageMs >= TIME_WARN_MS && ageMs < TIME_CLOSE_MS) {
      if (!pos.timeWarnSent) {
        pos.timeWarnSent = true;
        logger.warn(`[${symbol}] ⏰ Warning zone ${ageMin}m | PnL:${pnlPct.toFixed(3)}%`);

        // Kalau sedang profit walau kecil → geser SL ke breakeven sekarang
        if (pnlPct > 0.05) {
          const newSL = isLong
            ? pos.entryPrice * 1.0002  // breakeven + sedikit buffer
            : pos.entryPrice * 0.9998;

          // Hanya geser kalau SL baru lebih baik dari SL saat ini
          const slImproved = isLong
            ? newSL > pos.currentSL
            : newSL < pos.currentSL;

          if (slImproved) {
            pos.currentSL    = newSL;
            pos.lastSLUpdate = now;

            logger.info(`[${symbol}] ⏰ Time warning: SL geser ke breakeven $${newSL.toFixed(4)} (${ageMin}m)`);

            return {
              action : "UPDATE_SL",
              reason : `Time warning ${ageMin}m — SL → breakeven $${newSL.toFixed(4)}`,
              newSL,
              tp2    : pos.tp2,
              currentSL: pos.currentSL,
              tp1Hit : false,
              tp2Hit : false,
              timeWarning: true,
            };
          }
        }
      }
      return null;
    }

    // FASE 3: Force close (>45 menit, belum TP1)
    if (ageMs >= TIME_CLOSE_MS) {
      logger.warn(`[${symbol}] ⏰ TIME LIMIT ${ageMin}m — force close | PnL:${pnlPct.toFixed(3)}%`);
      return {
        action    : "CLOSE_ALL",
        reason    : `Time limit ${ageMin}m — posisi stuck, close untuk bebaskan modal`,
        tp1Hit    : false,
        tp2Hit    : false,
        timeForced: true,
        ageMinutes: parseFloat(ageMin),
        pnlPct    : parseFloat(pnlPct.toFixed(3)),
      };
    }

    return null;
  }

  // ─── GETTER WAKTU POSISI (untuk notifikasi di index.js) ──
  getAgeMinutes(symbol) {
    const pos = this._positions[symbol];
    if (!pos) return 0;
    return ((Date.now() - pos.openedAt) / 60000);
  }

  remove(symbol)     { delete this._positions[symbol]; }
  isTracking(symbol) { return !!this._positions[symbol]; }
  get(symbol)        { return this._positions[symbol] || null; }
  getOpenedAt(symbol){ return this._positions[symbol]?.openedAt || null; }
}

module.exports = { PositionManager };