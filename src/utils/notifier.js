/**
 * notifier.js
 * Kirim notifikasi ke Telegram dengan queue anti-flood
 * Telegram limit: max 30 msg/detik, 1 msg/detik per chat
 */

const https = require("https");

class Notifier {
  constructor(botToken, chatId) {
    this.botToken  = botToken;
    this.chatId    = chatId;
    this.enabled   = !!(botToken && chatId);
    this._queue    = [];          // antrian pesan
    this._sending  = false;       // flag sedang kirim
    this._minDelay = 1100;        // 1.1 detik antar pesan (aman dari limit)
  }

  // ─── Tambah ke queue ──────────────────────────────────────
  async send(message) {
    if (!this.enabled) {
      console.log("[Notifier disabled]", message);
      return;
    }

    return new Promise((resolve, reject) => {
      this._queue.push({ message, resolve, reject });
      if (!this._sending) this._processQueue();
    });
  }

  // ─── Proses queue satu per satu ───────────────────────────
  async _processQueue() {
    if (this._sending || this._queue.length === 0) return;
    this._sending = true;

    while (this._queue.length > 0) {
      const { message, resolve, reject } = this._queue.shift();
      try {
        const result = await this._sendNow(message);
        resolve(result);
      } catch(e) {
        console.warn("Telegram notify error:", e.message);
        resolve(null); // resolve bukan reject supaya bot tidak crash
      }
      // Delay antar pesan supaya tidak flood
      if (this._queue.length > 0) {
        await new Promise(r => setTimeout(r, this._minDelay));
      }
    }

    this._sending = false;
  }

  // ─── Kirim langsung ke Telegram API ──────────────────────
  async _sendNow(message) {
    const url  = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id   : this.chatId,
      text      : `🤖 *Bitget Bot*\n\n${message}`,
      parse_mode: "Markdown",
    });

    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method : "POST",
        headers: {
          "Content-Type"  : "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
      });

      // Timeout 5 detik
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("Telegram timeout"));
      });

      req.on("error", err => {
        console.warn("Telegram notify error:", err.message);
        resolve(null);
      });

      req.write(body);
      req.end();
    });
  }
}

module.exports = { Notifier };