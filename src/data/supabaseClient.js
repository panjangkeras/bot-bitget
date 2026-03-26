/**
 * supabaseClient.js — Supabase integration untuk Bitget Scalping Santai
 *
 * Tidak pakai SDK berat — pure HTTPS request ke Supabase REST API.
 * Zero dependency tambahan, langsung jalan di Railway.
 *
 * Fungsi utama:
 * 1. saveTrade()      — simpan trade ke tabel `trades`
 * 2. getTradeHistory() — ambil N trade terakhir per symbol (untuk AI context)
 * 3. getWinStats()    — statistik win-rate per symbol, per side, per session
 * 4. saveSignal()     — log sinyal AI (untuk audit)
 * 5. ping()           — cek koneksi saat startup
 */

const https = require("https");

class SupabaseClient {
  constructor({ url, anonKey }) {
    if (!url || !anonKey) {
      throw new Error("SUPABASE_URL dan SUPABASE_ANON_KEY wajib diisi!");
    }
    // Hapus trailing slash kalau ada
    this.url     = url.replace(/\/$/, "");
    this.anonKey = anonKey;
    this.enabled = true;
  }

  // ─────────────────────────────────────────────────────────
  // PUBLIC METHODS
  // ─────────────────────────────────────────────────────────

  /**
   * Simpan trade ke Supabase.
   * Dipanggil dari pnlTracker.record()
   */
  async saveTrade(trade) {
    return this._post("/rest/v1/trades", {
      external_id  : trade.id.toString(),
      ts           : trade.ts,
      symbol       : trade.symbol,
      side         : trade.side,
      entry_price  : trade.entryPrice,
      exit_price   : trade.exitPrice,
      size         : trade.size,
      leverage     : trade.leverage,
      pnl          : trade.pnl,
      pnl_pct      : trade.pnlPct,
      close_reason : trade.closeReason,
      strategy     : trade.strategy || "TF",
      win          : trade.win,
      price_source : trade.priceSource || "estimated",
    });
  }

  /**
   * Ambil histori trade untuk satu symbol (dipakai AI context).
   * @param {string} symbol  - e.g. "SOLUSDT"
   * @param {number} limit   - berapa trade terakhir (default 20)
   * @returns {Array}        - array trade objects
   */
  async getTradeHistory(symbol, limit = 20) {
    const params = new URLSearchParams({
      symbol : `eq.${symbol}`,
      order  : "ts.desc",
      limit  : limit.toString(),
      select : "side,entry_price,exit_price,pnl,pnl_pct,close_reason,win,leverage,ts",
    });
    return this._get(`/rest/v1/trades?${params}`);
  }

  /**
   * Statistik win rate per symbol (aggregate).
   * Dipakai groqAnalyzer untuk kasih AI context "seberapa bagus kita di token ini"
   */
  async getWinStats(symbol) {
    // Ambil semua trade symbol ini, max 200 (cukup untuk stat yang meaningful)
    const params = new URLSearchParams({
      symbol : `eq.${symbol}`,
      order  : "ts.desc",
      limit  : "200",
      select : "side,win,pnl,close_reason,leverage",
    });
    const trades = await this._get(`/rest/v1/trades?${params}`);
    if (!trades || trades.length === 0) return null;

    const total  = trades.length;
    const wins   = trades.filter(t => t.win).length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);

    const longTrades  = trades.filter(t => t.side === "long");
    const shortTrades = trades.filter(t => t.side === "short");

    const longWR  = longTrades.length  > 0 ? (longTrades.filter(t => t.win).length  / longTrades.length  * 100).toFixed(0) : null;
    const shortWR = shortTrades.length > 0 ? (shortTrades.filter(t => t.win).length / shortTrades.length * 100).toFixed(0) : null;

    // Close reason breakdown
    const reasons = {};
    for (const t of trades) {
      const r = t.close_reason || "UNKNOWN";
      reasons[r] = (reasons[r] || 0) + 1;
    }
    const topReason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || "N/A";

    // Rata-rata leverage yang dipakai
    const avgLev = trades.length > 0
      ? (trades.reduce((s, t) => s + (t.leverage || 10), 0) / trades.length).toFixed(0)
      : 10;

    return {
      symbol,
      total,
      winRate    : parseFloat((wins / total * 100).toFixed(1)),
      totalPnl   : parseFloat(totalPnl.toFixed(2)),
      avgPnl     : parseFloat((totalPnl / total).toFixed(2)),
      longWR     : longWR  ? parseInt(longWR)  : null,
      shortWR    : shortWR ? parseInt(shortWR) : null,
      topReason,
      avgLeverage: parseInt(avgLev),
    };
  }

  /**
   * Simpan log sinyal AI (untuk analisis/audit — tidak blocking trade).
   */
  async saveSignal(signal) {
    return this._post("/rest/v1/signals", {
      ts           : new Date().toISOString(),
      symbol       : signal.symbol,
      action       : signal.action,
      position     : signal.position,
      confidence   : signal.confidence,
      reason       : signal.reason,
      grade        : signal.grade,
      leverage_used: signal.leverageUsed,
      sl_pct       : signal.slPct,
      tp1_pct      : signal.tp1Pct,
      tp2_pct      : signal.tp2Pct,
      rsi          : signal.rsi,
      trend        : signal.trend,
      atr_pct      : signal.atrPct,
    });
  }

  /**
   * Cek koneksi saat startup.
   * Return true jika OK, false jika gagal (bot tetap jalan tanpa Supabase).
   */
  async ping() {
    try {
      await this._get("/rest/v1/trades?limit=1");
      return true;
    } catch(e) {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────
  // PRIVATE HTTP HELPERS
  // ─────────────────────────────────────────────────────────

  _headers() {
    return {
      "apikey"       : this.anonKey,
      "Authorization": `Bearer ${this.anonKey}`,
      "Content-Type" : "application/json",
      "Prefer"       : "return=minimal",
    };
  }

  _get(path) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.url + path);
      const req = https.request({
        hostname: url.hostname,
        path    : url.pathname + url.search,
        method  : "GET",
        headers : this._headers(),
      }, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(`Supabase GET error ${res.statusCode}: ${parsed.message || data.slice(0, 100)}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Supabase parse error: ${data.slice(0, 100)}`));
          }
        });
      });
      req.setTimeout(8000, () => {
        req.destroy();
        reject(new Error("Supabase GET timeout"));
      });
      req.on("error", reject);
      req.end();
    });
  }

  _post(path, body) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const url     = new URL(this.url + path);
      const req     = https.request({
        hostname: url.hostname,
        path    : url.pathname + url.search,
        method  : "POST",
        headers : {
          ...this._headers(),
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      }, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          // 201 Created atau 200 OK = sukses
          if (res.statusCode === 201 || res.statusCode === 200) {
            resolve({ ok: true });
          } else {
            // Jangan reject — log saja, biar bot tidak crash kalau Supabase down
            console.warn(`[Supabase] POST ${path} → ${res.statusCode}: ${data.slice(0, 100)}`);
            resolve({ ok: false, status: res.statusCode });
          }
        });
      });
      req.setTimeout(8000, () => {
        req.destroy();
        // Juga jangan reject — Supabase timeout tidak boleh crash bot
        console.warn(`[Supabase] POST timeout untuk ${path}`);
        resolve({ ok: false, error: "timeout" });
      });
      req.on("error", err => {
        console.warn(`[Supabase] POST error: ${err.message}`);
        resolve({ ok: false, error: err.message });
      });
      req.write(bodyStr);
      req.end();
    });
  }
}

// ─── Singleton — satu instance untuk seluruh bot ─────────
let _instance = null;

function getSupabase() {
  if (!_instance) {
    const url     = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!url || !anonKey) return null; // Supabase opsional
    try {
      _instance = new SupabaseClient({ url, anonKey });
    } catch(e) {
      console.warn(`[Supabase] Init gagal: ${e.message} — fitur DB dinonaktifkan`);
      return null;
    }
  }
  return _instance;
}

module.exports = { SupabaseClient, getSupabase };
