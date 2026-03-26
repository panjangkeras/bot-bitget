/**
 * ecosystem.config.js — PM2 config
 *
 * Install PM2  : npm install -g pm2
 * Start bot    : pm2 start ecosystem.config.js
 * Monitor      : pm2 monit
 * View logs    : pm2 logs bitget-bot
 * Stop         : pm2 stop bitget-bot
 * Auto-start   : pm2 startup  (jalankan command yang muncul)
 *                pm2 save
 */

module.exports = {
  apps: [
    {
      name        : "bitget-bot",
      script      : "index.js",
      interpreter : "node",
      args        : "--no-deprecation",

      // ── Restart policy ──────────────────────────────────
      // Restart otomatis jika bot crash (exit code != 0)
      autorestart : true,
      max_restarts: 10,        // max 10x restart berturut-turut
      min_uptime  : "30s",     // harus hidup min 30s, kalau tidak dihitung crash
      restart_delay: 5000,     // tunggu 5 detik sebelum restart

      // ── Logging ─────────────────────────────────────────
      output      : "./logs/out.log",
      error       : "./logs/err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs  : true,

      // ── Watch (disabled — pakai restart manual saja) ───
      watch       : false,

      // ── Memory limit: restart jika leak ────────────────
      max_memory_restart: "512M",

      // ── Environment ─────────────────────────────────────
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};