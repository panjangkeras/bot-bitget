/**
 * pnlTracker.js  v2.2 — PnL & Trade History Tracker + Supabase Sync
 *
 * Perubahan v2.2:
 * - Sync trade ke Supabase setelah setiap record() (non-blocking)
 * - Kalau Supabase down/tidak dikonfigurasi, fallback ke local JSON seperti biasa
 * - tradeMemory.invalidate() dipanggil setelah record supaya AI context fresh
 */

const fs     = require("fs");
const path   = require("path");
const logger = require("../utils/logger");

// Import Supabase (opsional — kalau tidak ada env, getSupabase() return null)
let getSupabase, tradeMemory;
try {
  ({ getSupabase }  = require("../data/supabaseClient"));
  ({ tradeMemory }  = require("../data/tradeMemory"));
} catch(e) {
  // File belum ada atau error — fallback graceful
  getSupabase  = () => null;
  tradeMemory  = { invalidate: () => {} };
}

const TRADES_FILE = path.join(__dirname, '../../data/trades.json');

class PnlTracker {
  constructor() {
    this._trades = this._load();
  }

  // ─── Simpan trade baru ────────────────────────────────────
  record({
    symbol, side, entryPrice, exitPrice, size,
    leverage, pnl, pnlPct, closeReason, strategy,
    isActualPrice = false,
  }) {
    const safePnl    = isFinite(parseFloat(pnl))    ? parseFloat(pnl)    : 0;
    const safePnlPct = isFinite(parseFloat(pnlPct)) ? parseFloat(pnlPct) : 0;

    const trade = {
      id          : Date.now(),
      ts          : new Date().toISOString(),
      symbol,
      side,
      entryPrice  : parseFloat(entryPrice)  || 0,
      exitPrice   : parseFloat(exitPrice)   || 0,
      size        : parseFloat(size)        || 0,
      leverage    : parseInt(leverage)      || 1,
      pnl         : parseFloat(safePnl.toFixed(4)),
      pnlPct      : parseFloat(safePnlPct.toFixed(4)),
      closeReason : closeReason || "UNKNOWN",
      strategy    : strategy   || "TF",
      win         : safePnl > 0,
      priceSource : isActualPrice ? "exchange" : "estimated",
    };

    this._trades.push(trade);
    this._save();

    // ── Sync ke Supabase (fire-and-forget, tidak blocking) ──
    this._syncToSupabase(trade);

    // ── Invalidate trade memory cache supaya AI dapat data fresh ──
    if (tradeMemory) tradeMemory.invalidate(symbol);

    const sign = trade.win ? "+" : "";
    logger.trade(
      `[PnL] ${trade.symbol} ${side.toUpperCase()} ` +
      `${sign}$${trade.pnl} (${sign}${trade.pnlPct}%) — ` +
      `${closeReason} [${trade.priceSource}]`
    );

    return trade;
  }

  // ─── Sync ke Supabase (internal, non-blocking) ───────────
  async _syncToSupabase(trade) {
    try {
      const sb = getSupabase ? getSupabase() : null;
      if (!sb) return;
      await sb.saveTrade(trade);
    } catch(e) {
      // Jangan crash bot hanya karena Supabase gagal
      logger.warn(`[PnlTracker] Supabase sync gagal: ${e.message}`);
    }
  }

  // ─── Statistik hari ini ───────────────────────────────────
  todayStats() {
    const today  = new Date().toDateString();
    const todays = this._trades.filter(t => new Date(t.ts).toDateString() === today);

    const wins   = todays.filter(t => t.win).length;
    const losses = todays.filter(t => !t.win).length;
    const total  = todays.length;
    const pnl    = todays.reduce((s, t) => s + (isFinite(t.pnl) ? t.pnl : 0), 0);
    const wr     = total > 0 ? ((wins / total) * 100).toFixed(1) : "0";
    const avgPnl = total > 0 ? (pnl / total).toFixed(2) : "0";

    const tfTrades = todays.filter(t => t.strategy === "TF");
    const mrTrades = todays.filter(t => t.strategy === "MR");

    return {
      wins, losses, total,
      pnl    : parseFloat(pnl.toFixed(2)),
      winRate: parseFloat(wr),
      avgPnl : parseFloat(avgPnl),
      byStrategy: {
        TF: {
          total: tfTrades.length,
          wins : tfTrades.filter(t => t.win).length,
          pnl  : parseFloat(tfTrades.reduce((s,t) => s + (t.pnl||0), 0).toFixed(2)),
        },
        MR: {
          total: mrTrades.length,
          wins : mrTrades.filter(t => t.win).length,
          pnl  : parseFloat(mrTrades.reduce((s,t) => s + (t.pnl||0), 0).toFixed(2)),
        },
      },
    };
  }

  // ─── Statistik total all-time ─────────────────────────────
  allTimeStats() {
    const trades = this._trades;
    const wins   = trades.filter(t => t.win).length;
    const losses = trades.filter(t => !t.win).length;
    const total  = trades.length;
    const pnl    = trades.reduce((s, t) => s + (isFinite(t.pnl) ? t.pnl : 0), 0);
    const wr     = total > 0 ? ((wins / total) * 100).toFixed(1) : "0";

    let peak   = 0, cum = 0, maxDD = 0;
    for (const t of trades) {
      cum += isFinite(t.pnl) ? t.pnl : 0;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }

    let maxStreak = 0, curStreak = 0;
    for (const t of trades) {
      if (!t.win) { curStreak++; maxStreak = Math.max(maxStreak, curStreak); }
      else curStreak = 0;
    }

    const bySymbol = {};
    for (const t of trades) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { total: 0, wins: 0, pnl: 0 };
      bySymbol[t.symbol].total++;
      if (t.win) bySymbol[t.symbol].wins++;
      bySymbol[t.symbol].pnl += isFinite(t.pnl) ? t.pnl : 0;
    }

    const actualCount    = trades.filter(t => t.priceSource === "exchange").length;
    const estimatedCount = trades.filter(t => t.priceSource !== "exchange").length;

    return {
      wins, losses, total,
      pnl         : parseFloat(pnl.toFixed(2)),
      winRate     : parseFloat(wr),
      maxDrawdown : parseFloat(maxDD.toFixed(2)),
      maxLossStreak: maxStreak,
      bySymbol,
      priceAccuracy: total > 0
        ? `${((actualCount/total)*100).toFixed(0)}% actual, ${((estimatedCount/total)*100).toFixed(0)}% estimated`
        : "no trades",
    };
  }

  // ─── Summary string untuk Telegram ───────────────────────
  summaryMessage() {
    const d = this.todayStats();
    const a = this.allTimeStats();

    const tfLine = d.byStrategy.TF.total > 0
      ? `TF: ${d.byStrategy.TF.wins}W/${d.byStrategy.TF.total - d.byStrategy.TF.wins}L PnL:$${d.byStrategy.TF.pnl >= 0 ? "+" : ""}${d.byStrategy.TF.pnl}`
      : "";
    const mrLine = d.byStrategy.MR.total > 0
      ? `MR: ${d.byStrategy.MR.wins}W/${d.byStrategy.MR.total - d.byStrategy.MR.wins}L PnL:$${d.byStrategy.MR.pnl >= 0 ? "+" : ""}${d.byStrategy.MR.pnl}`
      : "";

    return (
      `📊 *PnL Summary*\n` +
      `Today: W:${d.wins} L:${d.losses} WR:${d.winRate}% PnL:\`$${d.pnl >= 0 ? "+" : ""}${d.pnl}\`\n` +
      (tfLine ? `  ${tfLine}\n` : ``) +
      (mrLine ? `  ${mrLine}\n` : ``) +
      `All-time: ${a.total} trades | WR:${a.winRate}% | Total:\`$${a.pnl >= 0 ? "+" : ""}${a.pnl}\`\n` +
      `Max DD: \`$${a.maxDrawdown}\` | Max streak loss: ${a.maxLossStreak}`
    );
  }

  // ─── Ambil N trade terakhir (untuk debugging) ─────────────
  recent(n = 10) {
    return this._trades.slice(-n);
  }

  // ─── I/O ─────────────────────────────────────────────────
  _load() {
    try {
      if (fs.existsSync(TRADES_FILE)) {
        const raw    = fs.readFileSync(TRADES_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return parsed.map(t => ({
          ...t,
          priceSource: t.priceSource || "estimated",
        }));
      }
    } catch(e) {
      logger.warn(`[PnlTracker] Load gagal: ${e.message} — mulai fresh`);
    }
    return [];
  }

  _save() {
    try {
      fs.writeFileSync(TRADES_FILE, JSON.stringify(this._trades, null, 2));
    } catch(e) {
      logger.warn(`[PnlTracker] Save gagal: ${e.message}`);
    }
  }
}

module.exports = { PnlTracker };
