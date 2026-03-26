/**
 * bitgetClient.js — Bitget Futures REST API v2
 */
const crypto = require("crypto");
const https  = require("https");
const logger = require("../utils/logger"); // ← tambah ini di atas
const BASE_URL = "https://api.bitget.com";

class BitgetClient {
  constructor({ apiKey, secretKey, passphrase }) {
    if (!apiKey || !secretKey || !passphrase)
      throw new Error("API Key, Secret Key, dan Passphrase wajib diisi!");
    this.apiKey = apiKey; this.secretKey = secretKey; this.passphrase = passphrase;
  }

  _sign(ts, method, path, body = "") {
    return crypto.createHmac("sha256", this.secretKey)
      .update(ts + method.toUpperCase() + path + body).digest("base64");
  }

  async _request(method, path, params = {}, body = null) {
    const ts = Date.now().toString();
    let fullPath = path;
    if (method === "GET" && Object.keys(params).length > 0)
      fullPath = `${path}?${new URLSearchParams(params).toString()}`;
    const bodyStr = body ? JSON.stringify(body) : "";
    const headers = {
      "ACCESS-KEY": this.apiKey, "ACCESS-SIGN": this._sign(ts, method, fullPath, bodyStr),
      "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": this.passphrase,
      "Content-Type": "application/json", locale: "en-US",
    };
    return new Promise((resolve, reject) => {
      const url = new URL(BASE_URL + fullPath);
      const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method, headers }, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try {
            const p = JSON.parse(data);
            if (p.code !== "00000") reject(new Error(`Bitget API error: ${p.msg} (${p.code})`));
            else resolve(p.data);
          } catch { reject(new Error("Parse error: " + data.slice(0,200))); }
        });
      });
      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  _pt() { return process.env.PRODUCT_TYPE || "USDT-FUTURES"; }

  _fmtPrice(value, decimals) {
    return parseFloat(value).toFixed(decimals);
  }

  async setLeverage(symbol, leverage) {
    for (const holdSide of ["long", "short"]) {
      try {
        await this._request("POST", "/api/v2/mix/account/set-leverage", {}, {
          symbol, productType: this._pt(), marginCoin: "USDT",
          leverage: leverage.toString(), holdSide,
        });
      } catch (err) {
        if (!err.message.includes("40019")) throw err;
      }
    }
  }

  async getCandles(symbol, granularity = "1m", limit = 60) {
    const map = { "1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","1d":"1D" };
    const data = await this._request("GET", "/api/v2/mix/market/candles", {
      symbol, productType: this._pt(), granularity: map[granularity] || "1m", limit: limit.toString(),
    });
    return data.map(c => ({ time: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]) }));
  }

  async getPosition(symbol) {
    const data = await this._request("GET", "/api/v2/mix/position/single-position", {
      symbol, productType: this._pt(), marginCoin: "USDT",
    });
    if (!data || data.length === 0) return null;
    return data.find(p => parseFloat(p.total) > 0) || null;
  }

  async placeMarketOrder({ symbol, side, size, sl, tp, decimals = 3, holdSide }) {
    const order = await this._request("POST", "/api/v2/mix/order/place-order", {}, {
      symbol, productType: this._pt(), marginMode: "crossed", marginCoin: "USDT",
      size: size.toString(), side, tradeSide: "open", orderType: "market",
    });

    const hs = holdSide || (side === "buy" ? "long" : "short");

    // Retry sampai 5x dengan interval 800ms supaya order pasti sudah terisi
    let actualSize = size.toString();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await new Promise(r => setTimeout(r, 800));
      try {
        const pos = await this.getPosition(symbol);
        if (pos && parseFloat(pos.total) > 0) {
          actualSize = pos.total;
          break; // posisi sudah ada, lanjut set SL/TP
        }
      } catch(e) {}
      // Kalau attempt 5 masih belum ada posisi, pakai size order asli
      if (attempt === 5) {
        logger.warn(`[${symbol}] Posisi belum muncul setelah 5 attempt, pakai size asli`);
      }
    }

    await this._setTpSl(symbol, hs, sl, tp, actualSize, decimals);
    return order;
  }

  async _setTpSl(symbol, holdSide, sl, tp, size, decimals = 3) {
    const slStr = this._fmtPrice(sl, decimals);
    const tpStr = this._fmtPrice(tp, decimals);

    let hasLoss = false, hasProfit = false;
    try {
      const existing = await this._request("GET", "/api/v2/mix/order/orders-plan-pending", {
        symbol, productType: this._pt(), planType: "profit_loss"
      });
      const orders = existing?.entrustedList || [];
      for (const o of orders) {
        if (o.posSide !== holdSide) continue;
        if (o.planType === "loss_plan")   hasLoss   = true;
        if (o.planType === "profit_plan") hasProfit = true;
      }
    } catch(e) {}

    if (!hasLoss) {
      try {
        await this._request("POST", "/api/v2/mix/order/place-tpsl-order", {}, {
          symbol, productType: this._pt(), marginCoin: "USDT",
          holdSide, planType: "loss_plan",
          triggerPrice: slStr, triggerType: "fill_price",
          executePrice: "0", size: size.toString(),
        });
      } catch(e) {
        if (!e.message.includes("already")) throw e;
      }
    }

    if (!hasProfit) {
      try {
        await this._request("POST", "/api/v2/mix/order/place-tpsl-order", {}, {
          symbol, productType: this._pt(), marginCoin: "USDT",
          holdSide, planType: "profit_plan",
          triggerPrice: tpStr, triggerType: "fill_price",
          executePrice: "0", size: size.toString(),
        });
      } catch(e) {
        if (!e.message.includes("already")) throw e;
      }
    }

    if (hasLoss && hasProfit) return "already_set";
    return "set_ok";
  }

  async setTpSlForPosition(symbol, holdSide, sl, tp, size, decimals = 3) {
    return this._setTpSl(symbol, holdSide, sl, tp, size, decimals);
  }

  // ─── Update SL — cancel lama lalu set baru ───────────────
  // Dipanggil saat TP1 hit untuk geser SL ke break even
  async updateSl(symbol, holdSide, newSl, tp2, size, decimals = 3) {
    const slStr = this._fmtPrice(newSl, decimals);

    // 1. Cari orderId SL yang sedang aktif
    let orderId = null;
    try {
      const existing = await this._request("GET", "/api/v2/mix/order/orders-plan-pending", {
        symbol, productType: this._pt(), planType: "profit_loss"
      });
      const orders = existing?.entrustedList || [];
      for (const o of orders) {
        if (o.posSide !== holdSide) continue;
        if (o.planType === "loss_plan") {
          orderId = o.orderId;
          break;
        }
      }
    } catch(e) {
      logger.warn(`[${symbol}] Gagal fetch plan orders: ${e.message}`);
    }

    // 2. Cancel SL lama
    if (orderId) {
      try {
        await this._request("POST", "/api/v2/mix/order/cancel-plan-order", {}, {
          symbol,
          productType: this._pt(),
          orderId,
          marginCoin: "USDT",
        });
      } catch(e) {
        logger.warn(`[${symbol}] Cancel SL lama gagal: ${e.message}`);
      }
    }

    // 3. Set SL baru — retry 3x dengan delay 800ms
    const maxRetry = 3;
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      try {
        await this._request("POST", "/api/v2/mix/order/place-tpsl-order", {}, {
          symbol,
          productType : this._pt(),
          marginCoin  : "USDT",
          holdSide,
          planType    : "loss_plan",
          triggerPrice: slStr,
          triggerType : "fill_price",
          executePrice: "0",
          size        : size.toString(),
        });
        return "sl_updated"; // sukses, keluar
      } catch(e) {
        if (attempt < maxRetry) {
          logger.warn(`[${symbol}] Set SL baru gagal (attempt ${attempt}/${maxRetry}): ${e.message} — retry...`);
          await new Promise(r => setTimeout(r, 800));
        } else {
          throw new Error(`Set SL baru gagal setelah ${maxRetry}x: ${e.message}`);
        }
      }
    }
  }

  async placeOrder({ symbol, side, size, price, sl, tp, decimals = 3 }) {
    const order = await this._request("POST", "/api/v2/mix/order/place-order", {}, {
      symbol, productType: this._pt(), marginMode: "crossed", marginCoin: "USDT",
      size: size.toString(), price: this._fmtPrice(price, decimals),
      side, tradeSide: "open", orderType: "limit",
    });
    const hs = side === "buy" ? "long" : "short";
    await this._setTpSl(symbol, hs, sl, tp, size, decimals);
    return order;
  }

  async partialClose({ symbol, holdSide, size }) {
    const side = holdSide === "long" ? "sell" : "buy";
    return this._request("POST", "/api/v2/mix/order/place-order", {}, {
      symbol, productType: this._pt(), marginMode: "crossed", marginCoin: "USDT",
      size: size.toString(), side, tradeSide: "close", orderType: "market",
    });
  }

  async closePosition(symbol, holdSide) {
    return this._request("POST", "/api/v2/mix/order/close-positions", {}, {
      symbol, productType: this._pt(), holdSide,
    });
  }
}

module.exports = { BitgetClient };