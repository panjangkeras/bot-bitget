/**
 * dynamicSizing.js — Dynamic Position Sizing
 *
 * Menggantikan flat USDT_PER_TRADE dengan sizing yang adaptif
 * berdasarkan kondisi bot saat ini.
 *
 * LOGIKA:
 * 1. Base modal dari USDT_PER_TRADE di .env (default $20)
 * 2. Dikalikan multiplier berdasarkan:
 *    - Streak: loss streak → kurangi size, win streak → bisa tambah sedikit
 *    - Daily drawdown: makin dalam drawdown → makin kecil size
 *    - Confidence AI: confidence rendah → size lebih kecil
 *    - Volatilitas (ATR): ATR tinggi → size lebih kecil (risk tetap terjaga)
 *
 * BATAS KEAMANAN:
 * - Minimum: 50% dari base (tidak pernah < setengah modal awal)
 * - Maksimum: 150% dari base (tidak pernah > 1.5x modal awal)
 * - Selalu di atas $5 (minimum Bitget)
 *
 * CARA PAKAI di index.js:
 *   const { calcDynamicSize } = require("./src/core/dynamicSizing");
 *   const usdt = calcDynamicSize({
 *     base       : CONFIG.usdtPerTrade,
 *     dailyStats,
 *     dailyLoss,
 *     maxDailyLoss: CONFIG.maxDailyLoss,
 *     confidence  : decision.confidence,
 *     atrPct,     // ATR dalam % dari harga (opsional)
 *   });
 */

const logger = require("../utils/logger");

// ─── MULTIPLIER TABLE ─────────────────────────────────────
// Loss streak multiplier (makin banyak loss → makin kecil)
const STREAK_MULT = {
  0: 1.00,   // normal
  1: 1.00,   // 1 loss  → tetap
  2: 0.85,   // 2 loss  → -15%
  3: 0.70,   // 3 loss  → -30%
  4: 0.55,   // 4 loss  → -45%
  5: 0.50,   // 5+ loss → -50% (floor)
};

// Win streak bonus (hati-hati, tidak terlalu agresif)
const WIN_STREAK_MULT = {
  0: 1.00,
  1: 1.00,
  2: 1.05,   // 2 win berturut → +5%
  3: 1.10,   // 3 win berturut → +10%
  4: 1.15,   // 4+ win → +15% (cap)
};

/**
 * Hitung streak loss/win dari dailyStats
 * Return: { lossStreak, winStreak }
 */
function calcStreak(dailyStats) {
  // dailyStats tidak simpan urutan trade, jadi kita pakai proxy:
  // kalau wins >> losses → likely win streak
  // kalau losses >> wins  → likely loss streak
  // Ini approx — untuk akurasi lebih, perlu store trade history urutan
  const total = dailyStats.wins + dailyStats.losses;
  if (total === 0) return { lossStreak: 0, winStreak: 0 };

  // Pakai recentStreak jika tersedia (akan kita set di index.js)
  const ls = dailyStats.recentLossStreak || 0;
  const ws = dailyStats.recentWinStreak  || 0;
  return { lossStreak: ls, winStreak: ws };
}

/**
 * Hitung multiplier berdasarkan daily drawdown
 * Makin dekat ke max daily loss → makin kecil size
 */
function calcDrawdownMult(dailyLoss, maxDailyLoss) {
  if (!maxDailyLoss || maxDailyLoss <= 0) return 1.0;
  const ratio = dailyLoss / maxDailyLoss; // 0.0 = fresh, 1.0 = sudah kena limit

  if (ratio < 0.30) return 1.00;  // Drawdown < 30% → normal
  if (ratio < 0.50) return 0.90;  // Drawdown 30-50% → -10%
  if (ratio < 0.70) return 0.75;  // Drawdown 50-70% → -25%
  if (ratio < 0.90) return 0.60;  // Drawdown 70-90% → -40%
  return 0.50;                    // Drawdown > 90% → -50% (hampir limit)
}

/**
 * Hitung multiplier berdasarkan confidence AI
 */
function calcConfidenceMult(confidence) {
  if (!confidence) return 1.0;
  if (confidence >= 0.85) return 1.10;  // Confidence sangat tinggi → +10%
  if (confidence >= 0.75) return 1.00;  // Normal
  if (confidence >= 0.67) return 0.90;  // Confidence pas-pasan → -10%
  return 0.80;                          // Confidence rendah → -20%
}

/**
 * Hitung multiplier berdasarkan ATR (volatilitas)
 * ATR tinggi → pasar volatile → kurangi size untuk jaga risk $
 */
function calcAtrMult(atrPct) {
  if (!atrPct || atrPct <= 0) return 1.0;
  if (atrPct < 0.3)  return 1.10;   // Volatilitas rendah → boleh sedikit lebih besar
  if (atrPct < 0.6)  return 1.00;   // Normal
  if (atrPct < 1.0)  return 0.90;   // Volatilitas tinggi → -10%
  if (atrPct < 1.5)  return 0.80;   // Sangat volatile → -20%
  return 0.70;                       // Ekstrem volatile → -30%
}

/**
 * MAIN FUNCTION — Hitung dynamic position size
 *
 * @param {Object} params
 * @param {number} params.base          - Base USDT per trade (dari .env)
 * @param {Object} params.dailyStats    - { wins, losses, recentLossStreak, recentWinStreak }
 * @param {number} params.dailyLoss     - Total rugi hari ini dalam USDT
 * @param {number} params.maxDailyLoss  - Batas rugi per hari
 * @param {number} params.confidence    - AI confidence (0.0–1.0)
 * @param {number} [params.atrPct]      - ATR sebagai % dari harga (opsional)
 * @param {boolean} [params.verbose]    - Log detail breakdown (opsional)
 *
 * @returns {number} Final USDT amount untuk trade ini
 */
function calcDynamicSize({
  base,
  dailyStats = {},
  dailyLoss  = 0,
  maxDailyLoss = 30,
  confidence = 0.75,
  atrPct     = null,
  verbose    = false,
}) {
  const safeBase = Math.max(5, base || 20);

  const { lossStreak, winStreak } = calcStreak(dailyStats);

  // Hitung tiap multiplier
  const mStreak   = STREAK_MULT[Math.min(lossStreak, 5)] || 0.50;
  const mWin      = WIN_STREAK_MULT[Math.min(winStreak, 4)] || 1.15;
  const mDrawdown = calcDrawdownMult(dailyLoss, maxDailyLoss);
  const mConf     = calcConfidenceMult(confidence);
  const mAtr      = calcAtrMult(atrPct);

  // Kombinasikan — loss streak override win streak (safety first)
  const streakMult = lossStreak > 0 ? mStreak : mWin;

  // Final multiplier: perkalian semua faktor
  const rawMult = streakMult * mDrawdown * mConf * mAtr;

  // Clamp: min 50%, max 150% dari base
  const clampedMult = Math.min(1.50, Math.max(0.50, rawMult));

  // Final size, dibulatkan ke $0.5 terdekat (lebih rapi)
  const rawSize   = safeBase * clampedMult;
  const finalSize = Math.max(5, Math.round(rawSize * 2) / 2); // round ke 0.5

  if (verbose) {
    logger.info(
      `[DynSize] Base:$${safeBase} | ` +
      `Streak:×${streakMult.toFixed(2)}(L${lossStreak}W${winStreak}) ` +
      `DD:×${mDrawdown.toFixed(2)} ` +
      `Conf:×${mConf.toFixed(2)} ` +
      `ATR:×${mAtr.toFixed(2)} ` +
      `→ ×${clampedMult.toFixed(2)} = $${finalSize}`
    );
  }

  return finalSize;
}

/**
 * Update streak tracker di dailyStats setelah tiap trade close.
 * Panggil ini di index.js setiap kali trade selesai.
 *
 * @param {Object} dailyStats  - Object dailyStats yang di-mutate langsung
 * @param {boolean} isWin      - Apakah trade ini menang
 */
function updateStreak(dailyStats, isWin) {
  if (!dailyStats.recentLossStreak) dailyStats.recentLossStreak = 0;
  if (!dailyStats.recentWinStreak)  dailyStats.recentWinStreak  = 0;

  if (isWin) {
    dailyStats.recentWinStreak++;
    dailyStats.recentLossStreak = 0;
  } else {
    dailyStats.recentLossStreak++;
    dailyStats.recentWinStreak  = 0;
  }
}

module.exports = { calcDynamicSize, updateStreak };
