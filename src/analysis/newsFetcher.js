const https = require("https");

class NewsFetcher {
  constructor(newsApiKey) {
    this.newsApiKey = newsApiKey;
    this._cache     = {};
    this._cacheTTL  = 15 * 60 * 1000;
  }

  async getHeadlines(coin) {
    const key = coin.toLowerCase();
    const now = Date.now();
    if (this._cache[key] && now - this._cache[key].ts < this._cacheTTL)
      return this._cache[key].data;

    let headlines  = [];
    let anySuccess = false;

    // Sumber 1: NewsAPI
    if (this.newsApiKey && this.newsApiKey !== "your_newsapi_key_here") {
      try {
        const data = await this._fetchNewsAPI(coin);
        headlines  = [...headlines, ...data];
        anySuccess = true;
      } catch(e) {
        console.warn(`[NewsFetcher] NewsAPI gagal untuk ${coin}: ${e.message}`);
      }
    }

    // Sumber 2: CryptoCompare
    try {
      const data = await this._fetchCryptoCompare(coin);
      headlines  = [...headlines, ...data];
      anySuccess = true;
    } catch(e) {
      console.warn(`[NewsFetcher] CryptoCompare gagal untuk ${coin}: ${e.message}`);
    }

    // Kalau semua source gagal, return array kosong + warning
    if (!anySuccess) {
      console.warn(`[NewsFetcher] ⚠️ Semua source berita gagal untuk ${coin} — sentiment akan NEUTRAL`);
      return [];
    }

    headlines = [...new Set(headlines)].slice(0, 12);
    this._cache[key] = { ts: now, data: headlines };
    return headlines;
  }

  async _fetchNewsAPI(coin) {
    const coinNames = {
      BTC:"bitcoin", ETH:"ethereum", SOL:"solana",
      XRP:"ripple XRP", DOGE:"dogecoin", BNB:"binance BNB",
      ADA:"cardano", AVAX:"avalanche crypto",
    };
    const q   = encodeURIComponent(coinNames[coin.toUpperCase()] || coin);
    const url = `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=8&apiKey=${this.newsApiKey}`;
    const data = await this._get(url);
    if (!data.articles) return [];
    return data.articles.map(a => a.title).filter(Boolean).slice(0, 8);
  }

  async _fetchCryptoCompare(coin) {
    const url  = `https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=${coin.toUpperCase()}&excludeCategories=Sponsored`;
    const data = await this._get(url);
    if (!data || !Array.isArray(data.Data)) return [];
    return data.Data.map(item => item.title).filter(Boolean).slice(0, 6);
  }

  _get(url) {
    return new Promise((resolve, reject) => {
      // Timeout 5 detik supaya tidak blocking terlalu lama
      const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error("Parse error")); }
        });
      });
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
      req.on("error", reject);
    });
  }
}

module.exports = { NewsFetcher };