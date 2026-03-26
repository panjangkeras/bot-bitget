/**
 * importTrades.js — Import trades.json lama ke Supabase
 *
 * Jalankan SEKALI saja setelah Supabase dikonfigurasi:
 *   node importTrades.js
 *
 * Script ini baca trades.json lokal, lalu upload ke Supabase.
 * Kalau trade sudah ada (external_id sama), Supabase akan skip (upsert).
 */

require("dotenv").config();
const fs  = require("fs");
const path = require("path");

// Validasi env
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error("❌ SUPABASE_URL dan SUPABASE_ANON_KEY wajib di .env!");
  process.exit(1);
}

const { SupabaseClient } = require("./supabaseClient");
const sb = new SupabaseClient({
  url    : process.env.SUPABASE_URL,
  anonKey: process.env.SUPABASE_ANON_KEY,
});

const TRADES_FILE = path.join(__dirname, '../../data/trades.json');

async function main() {
  if (!fs.existsSync(TRADES_FILE)) {
    console.log("⚠️  trades.json tidak ditemukan — tidak ada yang diimport.");
    return;
  }

  let trades;
  try {
    trades = JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  } catch(e) {
    console.error(`❌ Gagal baca trades.json: ${e.message}`);
    process.exit(1);
  }

  console.log(`📦 Ditemukan ${trades.length} trade di trades.json`);

  // Cek koneksi Supabase
  const ok = await sb.ping();
  if (!ok) {
    console.error("❌ Tidak bisa connect ke Supabase — cek SUPABASE_URL dan SUPABASE_ANON_KEY");
    process.exit(1);
  }
  console.log("✅ Supabase terhubung!\n");

  let success = 0, failed = 0, skipped = 0;

  for (const trade of trades) {
    try {
      const result = await sb.saveTrade(trade);
      if (result.ok === false && result.status === 409) {
        // Conflict = sudah ada, skip
        skipped++;
      } else if (result.ok) {
        success++;
      } else {
        failed++;
      }
      // Rate limit protection — jangan spam Supabase
      await new Promise(r => setTimeout(r, 100));
    } catch(e) {
      console.warn(`  ⚠️  Trade ${trade.id} (${trade.symbol}): ${e.message}`);
      failed++;
    }

    // Progress
    const done = success + failed + skipped;
    if (done % 10 === 0 || done === trades.length) {
      process.stdout.write(`  Progress: ${done}/${trades.length} | ✅ ${success} ⚠️ ${skipped} ❌ ${failed}\r`);
    }
  }

  console.log(`\n\n═══════════════════════════════`);
  console.log(`✅ Import selesai!`);
  console.log(`   Berhasil : ${success}`);
  console.log(`   Sudah ada: ${skipped}`);
  console.log(`   Gagal    : ${failed}`);
  console.log(`═══════════════════════════════`);
  console.log(`\nCek di Supabase → Table Editor → trades`);
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
