/**
 * slTpTable.js  v2.1 — SL/TP untuk Scalping Santai
 * Leverage range: 10x – 30x
 *
 * Fix v2.1:
 * - Tambah getSlTpAtr() yang scale SL/TP berdasarkan ATR aktual
 * - getSlTp() tetap ada sebagai base / fallback
 * - ATR floor: SL tidak boleh lebih kecil dari 1.2x ATR%
 * - ATR ceiling: SL tidak lebih dari 3x ATR% (cegah SL terlalu lebar)
 *
 * Filosofi:
 * - SL berbasis ATR = mengikuti volatilitas token saat itu
 * - Token yang sedang volatile → SL otomatis lebih lebar
 * - Token yang sedang tenang  → SL lebih tight
 * - Risk/Reward min 1:1.5 di semua kondisi
 */

// ─── BASE TABLE (dipakai jika ATR tidak tersedia) ─────────
const SL_TP_TABLE = {
  //         strong signal         normal signal         weak signal
  10: { strong:{sl:1.2,tp1:1.8,tp2:3.0}, normal:{sl:1.5,tp1:2.0,tp2:3.5}, weak:{sl:1.8,tp1:2.5,tp2:4.0} },
  15: { strong:{sl:1.0,tp1:1.5,tp2:2.8}, normal:{sl:1.2,tp1:1.8,tp2:3.0}, weak:{sl:1.5,tp1:2.0,tp2:3.5} },
  20: { strong:{sl:0.8,tp1:1.2,tp2:2.2}, normal:{sl:1.0,tp1:1.5,tp2:2.8}, weak:{sl:1.2,tp1:1.8,tp2:3.0} },
  25: { strong:{sl:0.7,tp1:1.0,tp2:2.0}, normal:{sl:0.8,tp1:1.2,tp2:2.2}, weak:{sl:1.0,tp1:1.5,tp2:2.5} },
  30: { strong:{sl:0.6,tp1:0.9,tp2:1.8}, normal:{sl:0.7,tp1:1.0,tp2:2.0}, weak:{sl:0.8,tp1:1.2,tp2:2.2} },
};

/**
 * getSlTp — Ambil SL/TP dari table (base, tanpa ATR)
 * @param {number} leverage       - leverage yang dipakai (10–30)
 * @param {string} signalStrength - "strong" | "normal" | "weak"
 */
function getSlTp(leverage, signalStrength) {
  const validLevs = [10, 15, 20, 25, 30];
  const nearest   = validLevs.reduce((a, b) =>
    Math.abs(b - leverage) < Math.abs(a - leverage) ? b : a
  );
  const row = SL_TP_TABLE[nearest] || SL_TP_TABLE[15];
  return row[signalStrength] || row.normal;
}

/**
 * getSlTpAtr — SL/TP yang di-scale berdasarkan ATR aktual
 *
 * @param {number} leverage       - leverage (10–30)
 * @param {string} signalStrength - "strong" | "normal" | "weak"
 * @param {number} atr            - ATR value (sama unit dengan price)
 * @param {number} price          - harga saat ini
 * @returns {{ sl, tp1, tp2 }}   - SL/TP dalam persen dari harga
 *
 * Logic:
 * 1. Ambil base dari table
 * 2. Hitung ATR%
 * 3. SL = max(base.sl, 1.2x ATR%)  — tidak boleh lebih kecil dari 1.2x ATR
 *         min(SL, 3.0x ATR%)        — tidak boleh lebih dari 3x ATR (terlalu lebar)
 * 4. TP1 = max(base.tp1, SL * 1.5)  — minimal R:R 1:1.5
 * 5. TP2 = max(base.tp2, SL * 2.5)  — minimal R:R 1:2.5
 */
function getSlTpAtr(leverage, signalStrength, atr, price) {
  const base = getSlTp(leverage, signalStrength);

  // Jika ATR tidak tersedia, kembalikan base saja
  if (!atr || !price || atr <= 0 || price <= 0) return base;

  const atrPct = (atr / price) * 100;

  // ATR floor & ceiling untuk SL
  const slFloor   = atrPct * 1.2;
  const slCeiling = atrPct * 3.0;
  const sl        = parseFloat(Math.min(Math.max(base.sl, slFloor), slCeiling).toFixed(3));

  // TP berdasarkan SL final (bukan base)
  const tp1 = parseFloat(Math.max(base.tp1, sl * 1.5).toFixed(3));
  const tp2 = parseFloat(Math.max(base.tp2, sl * 2.5).toFixed(3));

  return { sl, tp1, tp2 };
}

module.exports = { SL_TP_TABLE, getSlTp, getSlTpAtr };
