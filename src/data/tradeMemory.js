/**
 * tradeMemory.js — AI Learning Context dari Supabase
 *
 * Module ini TIDAK mengubah logika trading sama sekali.
 * Tugasnya: ambil data histori dari Supabase, lalu format
 * jadi string context yang diinjeksi ke prompt AI.
 *
 * Hasilnya: AI "ingat" performa bot di tiap token dan
 * bisa adjust confidence / risk warning berdasarkan data nyata.
 *
 * Cache 5 menit per symbol — tidak spam Supabase setiap tick.
 */

const { getSupabase } = require("./supabaseClient");
const logger          = require("../utils/logger");

const CACHE_TTL = 5 * 60 * 1000; // 5 menit

class TradeMemory {
  constructor() {
    this._cache = {}; // { symbol: { ts, context, stats } }
  }

  /**
   * Ambil konteks memori untuk satu symbol.
   * Return string yang siap diinjeksi ke prompt AI.
   * Return "" kalau Supabase tidak tersedia atau tidak ada data.
   */
  async getContext(symbol) {
    const now    = Date.now();
    const cached = this._cache[symbol];
    if (cached && now - cached.ts < CACHE_TTL) {
      return cached.context;
    }

    const sb = getSupabase();
    if (!sb) return ""; // Supabase tidak dikonfigurasi — skip

    try {
      // Fetch paralel: histori 15 trade terakhir + win stats
      const [history, stats] = await Promise.all([
        sb.getTradeHistory(symbol, 15),
        sb.getWinStats(symbol),
      ]);

      const context = this._buildContext(symbol, history, stats);
      this._cache[symbol] = { ts: now, context, stats };
      return context;

    } catch(e) {
      logger.warn(`[TradeMemory] ${symbol}: gagal fetch — ${e.message}`);
      return "";
    }
  }

  /**
   * Ambil stats saja (tanpa format string).
   * Dipakai di pnlTracker untuk enrich log.
   */
  async getStats(symbol) {
    const cached = this._cache[symbol];
    if (cached?.stats) return cached.stats;

    const sb = getSupabase();
    if (!sb) return null;
    try {
      return await sb.getWinStats(symbol);
    } catch {
      return null;
    }
  }

  /**
   * Invalidate cache satu symbol (panggil setelah trade close).
   */
  invalidate(symbol) {
    delete this._cache[symbol];
  }

  // ─── PRIVATE ──────────────────────────────────────────────

  _buildContext(symbol, history, stats) {
    const lines = [];
    const coin  = symbol.replace("USDT", "");

    // ── BAGIAN 1: Statistik keseluruhan ──────────────────────
    if (stats && stats.total > 0) {
      lines.push(`=== BOT MEMORY: ${coin} (${stats.total} trades) ===`);
      lines.push(`WinRate: ${stats.winRate}% | Total PnL: $${stats.totalPnl} | Avg PnL/trade: $${stats.avgPnl}`);

      if (stats.longWR !== null && stats.shortWR !== null) {
        lines.push(`LONG WR: ${stats.longWR}% | SHORT WR: ${stats.shortWR}%`);
        // Kasih peringatan kalau salah satu side konsisten buruk
        if (stats.longWR < 35)  lines.push(`⚠️ LONG di ${coin} win-rate buruk (${stats.longWR}%) — pertimbangkan turunkan confidence LONG`);
        if (stats.shortWR < 35) lines.push(`⚠️ SHORT di ${coin} win-rate buruk (${stats.shortWR}%) — pertimbangkan turunkan confidence SHORT`);
        if (stats.longWR > 65)  lines.push(`✅ LONG di ${coin} historically strong (${stats.longWR}%)`);
        if (stats.shortWR > 65) lines.push(`✅ SHORT di ${coin} historically strong (${stats.shortWR}%)`);
      }

      lines.push(`Most common exit: ${stats.topReason} | Avg leverage used: ${stats.avgLeverage}x`);
    } else {
      lines.push(`=== BOT MEMORY: ${coin} — no history yet ===`);
    }

    // ── BAGIAN 2: 15 trade terakhir (ringkas) ────────────────
    if (history && history.length > 0) {
      lines.push(`\nLast ${history.length} trades:`);

      // Grouping: berapa streak loss/win terakhir
      let streak = 0;
      let streakType = history[0]?.win ? "W" : "L";
      for (const t of history) {
        const cur = t.win ? "W" : "L";
        if (cur === streakType) streak++;
        else break;
      }
      if (streak >= 3) {
        lines.push(`⚠️ Current ${streakType} streak: ${streak} — adjust risk accordingly`);
      }

      // Summary 15 trade terakhir (format ringkas supaya tidak membengkak prompt)
      const recent = history.slice(0, 10).map(t => {
        const sign   = t.win ? "+" : "-";
        const pnlAbs = Math.abs(t.pnl || 0).toFixed(2);
        return `${t.side.toUpperCase()[0]}${sign}$${pnlAbs}(${t.close_reason?.slice(0,6)})`;
      });
      lines.push(`Recent: ${recent.join(" | ")}`);

      // Hitung rata-rata PnL dari recent yang masuk
      const recentPnl = history.slice(0, 10).reduce((s, t) => s + (t.pnl || 0), 0);
      const recentWins = history.slice(0, 10).filter(t => t.win).length;
      lines.push(`Recent 10: ${recentWins}W/${10 - recentWins}L | PnL: $${recentPnl.toFixed(2)}`);

      // Deteksi pola berulang yang buruk
      const slHits   = history.filter(t => (t.close_reason || "").includes("SL")).length;
      const slHitPct = history.length > 0 ? (slHits / history.length * 100).toFixed(0) : 0;
      if (parseInt(slHitPct) > 50) {
        lines.push(`⚠️ SL hit rate tinggi (${slHitPct}%) — pertimbangkan widen SL atau skip entry kalau signal lemah`);
      }
    }

    lines.push(`=== END MEMORY ===`);
    return lines.join("\n");
  }
}

// Singleton
const _memory = new TradeMemory();
module.exports = { tradeMemory: _memory, TradeMemory };
