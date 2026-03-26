/**
 * groqAnalyzer.js — AI Analyzer untuk Scalping Santai
 * 
 * Upgrade dari versi lama:
 * - Leverage dikunci 10x–30x (tidak ada 40x/50x)
 * - Prompt lebih pintar: MTF 1m/5m/15m/30m aware
 * - Threshold confidence lebih tinggi → entry lebih selektif
 * - Fallback rule-based lebih robust
 * - Prompt bahasa lebih jelas untuk llama
 */

const https   = require("https");
const { getSlTp } = require("../core/slTpTable");

// Trade memory — inject histori ke prompt AI (opsional, graceful fallback)
let tradeMemory = null;
try {
  ({ tradeMemory } = require("../data/tradeMemory"));
} catch(e) {
  // tradeMemory.js belum ada atau Supabase tidak dikonfigurasi — skip
}

const VALID_LEVERAGES = [10, 15, 20, 25, 30];


// ─── TAMBAHKAN helper ini di atas class GroqAnalyzer ─────────────────────────

/**
 * Hitung confluence score sebelum kirim ke AI.
 * Return: { score: 0-10, bullPoints, bearPoints, neutral, summary }
 * 
 * Ini yang paling penting — AI dikasih tahu "seberapa banyak indikator setuju"
 * sehingga dia tidak perlu menebak dari data mentah.
 */
function calcConfluence({ rsi, histogram, bb, volume, stochRSI, sr, momentum,
  bullPct, bearPct, price, atr }) {

  const bull = [];
  const bear = [];
  const warn = [];

  // ── RSI ──────────────────────────────────────────────────
  if (rsi >= 52 && rsi <= 68)      bull.push("RSI bullish zone");
  else if (rsi >= 32 && rsi <= 48) bear.push("RSI bearish zone");
  else if (rsi > 70)               warn.push("RSI overbought — avoid LONG");
  else if (rsi < 30)               warn.push("RSI oversold — avoid SHORT");

  // ── MACD Histogram ───────────────────────────────────────
  if (histogram > 0)               bull.push("MACD hist positive");
  else                             bear.push("MACD hist negative");

  // ── Bollinger Bands ──────────────────────────────────────
  if (bb) {
    const bbW = bb.width * 100;
    if (bbW < 0.4)                 warn.push("BB squeeze — wait breakout");
    else if (price < bb.lower)     bull.push("Price below BB lower — reversal zone");
    else if (price > bb.upper)     bear.push("Price above BB upper — reversal zone");
    else if (price > bb.middle)    bull.push("Price above BB mid");
    else                           bear.push("Price below BB mid");
  }

  // ── Volume ───────────────────────────────────────────────
  if (volume) {
    if (volume.surge >= 1.5)       bull.push(`Volume surge ${volume.surge.toFixed(1)}x — strong move`);
    else if (volume.surge >= 1.0)  bull.push(`Volume ok ${volume.surge.toFixed(1)}x`);
    else if (volume.surge < 0.6)   warn.push(`Volume weak ${volume.surge.toFixed(1)}x`);
  }

  // ── StochRSI ─────────────────────────────────────────────
  if (stochRSI) {
    if (stochRSI.k < 25 && stochRSI.d < 25)      bull.push("StochRSI oversold — bounce likely");
    else if (stochRSI.k > 75 && stochRSI.d > 75) bear.push("StochRSI overbought");
    else if (stochRSI.k > stochRSI.d)             bull.push("StochRSI K>D bullish cross");
    else                                           bear.push("StochRSI K<D bearish");
  }

  // ── S/R ──────────────────────────────────────────────────
  if (sr) {
    if (sr.atSupport)    bull.push("Price at support level");
    if (sr.atResistance) bear.push("Price at resistance — LONG risky");
  }

  // ── Momentum ─────────────────────────────────────────────
  if (momentum > 0.3)  bull.push("Momentum positive");
  else if (momentum < -0.3) bear.push("Momentum negative");

  // ── Multi-TF alignment ───────────────────────────────────
  if (bullPct >= 75)   bull.push(`MTF ${bullPct}% bullish aligned`);
  else if (bullPct >= 60) bull.push(`MTF ${bullPct}% slight bull`);
  if (bearPct >= 75)   bear.push(`MTF ${bearPct}% bearish aligned`);
  else if (bearPct >= 60) bear.push(`MTF ${bearPct}% slight bear`);

  // ── ATR / volatility ─────────────────────────────────────
  if (atr && price) {
    const atrPct = (atr / price) * 100;
    if (atrPct > 0.8) warn.push(`High volatility ATR=${atrPct.toFixed(2)}% — widen SL`);
  }

  // Score: bull poin +1, bear poin +1 (tapi ke bear), warn tidak masuk score
  const score    = bull.length - bear.length; // range bisa -8 sampai +8
  const bullScore = bull.length;
  const bearScore = bear.length;

  const direction = score >= 2 ? "BULL" : score <= -2 ? "BEAR" : "MIXED";

  return {
    score,
    bullScore,
    bearScore,
    direction,
    bullPoints: bull,
    bearPoints: bear,
    warnings  : warn,
    summary   : `${direction} ${bullScore}↑/${bearScore}↓ | warnings: ${warn.length > 0 ? warn.join("; ") : "none"}`,
  };
}

class GroqAnalyzer {
  constructor(apiKey) {
    if (!apiKey) throw new Error("GROQ_API_KEY / Cerebras API key wajib diisi!");
    this.apiKey     = apiKey;
    this.model      = "llama3.1-8b";
    this.baseUrl    = "https://api.cerebras.ai/v1/chat/completions";
    this._newsCache = {};
    this._cacheTTL  = 15 * 60 * 1000;
  }

  // ─── 1. ANALISA TEKNIKAL MULTI-TF ────────────────────────
  async analyzeTechnical({ rsi, macd, signal, histogram, price, trend,
  bb, volume, atr, stochRSI, sr, pattern, momentum,
  candles1m, candles5m, candles15m, candles30m }) {

  const tf1m  = trend || "UNKNOWN";
  const tf5m  = candles5m  ? this._quickTrend(candles5m)  : "UNKNOWN";
  const tf15m = candles15m ? this._quickTrend(candles15m) : "UNKNOWN";
  const tf30m = candles30m ? this._quickTrend(candles30m) : "UNKNOWN";

  const tfsWeighted = [
    { tf: tf1m,  weight: 1, label: "1m"  },
    { tf: tf5m,  weight: 2, label: "5m"  },
    { tf: tf15m, weight: 3, label: "15m" },
    { tf: tf30m, weight: 2, label: "30m" },
  ].filter(t => t.tf !== "UNKNOWN");

  const totalWeight = tfsWeighted.reduce((s, t) => s + t.weight, 0);
  const bullWeight  = tfsWeighted.filter(t => t.tf.includes("UPTREND")).reduce((s, t) => s + t.weight, 0);
  const bearWeight  = tfsWeighted.filter(t => t.tf.includes("DOWNTREND")).reduce((s, t) => s + t.weight, 0);
  const bullPct     = totalWeight > 0 ? (bullWeight / totalWeight * 100).toFixed(0) : 0;
  const bearPct     = totalWeight > 0 ? (bearWeight / totalWeight * 100).toFixed(0) : 0;
  const tfSummary   = tfsWeighted.map(t => `${t.label}:${t.tf}`).join(" | ");

  const bbPos = bb
    ? price > bb.upper  ? "ABOVE_UPPER"
    : price < bb.lower  ? "BELOW_LOWER"
    : price > bb.middle ? "ABOVE_MID"
    :                     "BELOW_MID"
    : "N/A";
  const bbW     = bb ? (bb.width * 100).toFixed(3) : "0";
  const squeeze = bb && parseFloat(bbW) < 0.5 ? "BB_SQUEEZE_WAIT" : "";

  // ── Hitung confluence dulu SEBELUM kirim ke AI ───────────
  const conf = calcConfluence({
    rsi, histogram, bb, volume, stochRSI, sr, momentum,
    bullPct: parseInt(bullPct), bearPct: parseInt(bearPct),
    price, atr,
  });

  // Hard block: kalau confluence terlalu mixed atau ada warning kritis
  // Ini menghemat API call dan cegah entry jelek
  const hasCriticalWarning = conf.warnings.some(w =>
    w.includes("BB squeeze") || w.includes("overbought") || w.includes("oversold")
  );
  if (Math.abs(conf.score) < 2 && hasCriticalWarning) {
    // Langsung return HOLD tanpa panggil AI — setup terlalu jelek
    return this._technicalFallback(rsi, histogram, parseInt(bullPct), parseInt(bearPct));
  }

  const prompt = `You are a strict crypto scalping analyst. Your job is to PROTECT CAPITAL first, profit second.

=== CONFLUENCE ANALYSIS (pre-calculated) ===
Direction : ${conf.direction} | Score: ${conf.score > 0 ? "+" : ""}${conf.score}/10
BULL signals (${conf.bullScore}): ${conf.bullPoints.join(", ") || "none"}
BEAR signals (${conf.bearScore}): ${conf.bearPoints.join(", ") || "none"}
WARNINGS   : ${conf.warnings.join(", ") || "none"}

=== MARKET CONTEXT ===
Price   : $${price}
ATR(14) : ${atr ? atr.toFixed(5) : "N/A"} = ${atr ? ((atr/price)*100).toFixed(3)+"%" : "N/A"} of price
Pattern : ${pattern || "NONE"}

=== MULTI-TIMEFRAME ===
${tfSummary}
BULL weight: ${bullPct}% | BEAR weight: ${bearPct}%
Rule: 15m/30m must NOT conflict with entry direction.

=== RAW INDICATORS ===
RSI: ${rsi.toFixed(2)} | StochRSI K=${stochRSI?.k.toFixed(1) || "N/A"} D=${stochRSI?.d.toFixed(1) || "N/A"}
MACD Hist: ${histogram.toFixed(6)} | BB: ${bbPos} width=${bbW}% ${squeeze}
Volume: ${volume ? volume.surge.toFixed(2)+"x ("+volume.trend+")" : "N/A"}
${sr ? `S/R: R1=$${sr.r1?.toFixed(4)} Pivot=$${sr.pivot?.toFixed(4)} S1=$${sr.s1?.toFixed(4)}` : ""}

=== STRICT ENTRY RULES ===
Only recommend LONG/SHORT if:
- Confluence score >= +2 for LONG, <= -2 for SHORT
- At least 3 bull/bear signals confirmed
- NO BB squeeze warning
- 15m AND 30m trend must NOT be strongly opposite
- RSI not extreme (< 70 for LONG, > 30 for SHORT)

Leverage guide (conservative — protect capital):
30x: score >= +5/-5 AND 15m+30m both aligned AND RSI 44-60
25x: score >= +4/-4 AND 15m aligned AND RSI 42-62
20x: score >= +3/-3 AND 5m+15m aligned
15x: score >= +2/-2 AND 5m aligned
10x: only if mixed but slight lean — enter very cautiously
HOLD: score between -1 and +1 OR any critical warning

Respond ONLY with exact JSON (no markdown):
{"signal":"STRONG_BUY|BUY|HOLD|SELL|STRONG_SELL","direction":"LONG|SHORT|NONE","confidence":0.65,"reason":"max 80 chars","risk":"LOW|MEDIUM|HIGH","entry_quality":"EXCELLENT|GOOD|FAIR|POOR","tf_alignment":"${bullPct}%bull/${bearPct}%bear","recommended_lev":15}`;

  try {
    const r   = await this._chat(prompt, 280);
    const p   = this._parseJSON(r);
    const rawLev  = parseInt(p.recommended_lev) || 15;
    const recLev  = this._snapLeverage(rawLev);

    return {
      signal        : this._validateEnum(p.signal, ["STRONG_BUY","BUY","HOLD","SELL","STRONG_SELL"], "HOLD"),
      direction     : this._validateEnum(p.direction, ["LONG","SHORT","NONE"], "NONE"),
      confidence    : Math.max(0.50, Math.min(1, parseFloat(p.confidence) || 0.50)),
      reason        : (typeof p.reason === "string" ? p.reason : "-").slice(0, 100),
      risk          : this._validateEnum(p.risk, ["LOW","MEDIUM","HIGH"], "HIGH"),
      entryQuality  : this._validateEnum(p.entry_quality, ["EXCELLENT","GOOD","FAIR","POOR"], "POOR"),
      tfAlignment   : typeof p.tf_alignment === "string" ? p.tf_alignment : `${bullPct}%bull`,
      recommendedLev: recLev,
      lev30xSafe    : recLev >= 25,
      bullPct       : parseInt(bullPct),
      bearPct       : parseInt(bearPct),
      // Bonus: sertakan confluence buat logging di index.js
      confluence    : conf,
    };
  } catch(e) {
    console.warn(`[GroqAnalyzer] analyzeTechnical fallback: ${e.message}`);
    return this._technicalFallback(rsi, histogram, parseInt(bullPct), parseInt(bearPct));
  }
}

  // ─── 2. SENTIMEN BERITA ───────────────────────────────────
  async analyzeSentiment(coin, headlines) {
    const key = coin.toLowerCase();
    const now = Date.now();
    if (this._newsCache[key] && now - this._newsCache[key].ts < this._cacheTTL)
      return this._newsCache[key].data;

    const hl = headlines.length > 0
      ? headlines.slice(0, 8).map((h, i) => `${i + 1}. ${h}`).join("\n")
      : "No recent news available.";

    const prompt = `Analyze crypto news sentiment for short-term trading impact (next 1-4 hours).

Coin: ${coin}
Headlines:
${hl}

Rules:
- BULLISH: clearly positive for price (adoption, partnership, ETF approval, whale buying)  
- BEARISH: clearly negative (hack, ban, dump, SEC action, major selloff)
- NEUTRAL: mixed, unclear, or not directly price-relevant

Respond ONLY with this JSON (no markdown):
{"label":"BULLISH|BEARISH|NEUTRAL","score":0.0,"impact":"HIGH|MEDIUM|LOW","reason":"one sentence max 80 chars","warning":""}

score: float -1.0 to 1.0 (negative=bearish, positive=bullish)`;

    try {
      const r = await this._chat(prompt, 150);
      const p = this._parseJSON(r);
      const s = {
        label    : this._validateEnum(p.label, ["BULLISH","BEARISH","NEUTRAL"], "NEUTRAL"),
        score    : Math.max(-1, Math.min(1, parseFloat(p.score) || 0)),
        impact   : this._validateEnum(p.impact, ["HIGH","MEDIUM","LOW"], "LOW"),
        reason   : (typeof p.reason === "string" ? p.reason : "-").slice(0, 120),
        warning  : (typeof p.warning === "string" ? p.warning : "").slice(0, 120),
      };
      this._newsCache[key] = { ts: now, data: s };
      return s;
    } catch(e) {
      console.warn(`[GroqAnalyzer] analyzeSentiment fallback: ${e.message}`);
      const neutral = { label: "NEUTRAL", score: 0, impact: "LOW", reason: "AI unavailable", warning: "" };
      this._newsCache[key] = { ts: now, data: neutral };
      return neutral;
    }
  }

  // ─── 3. KEPUTUSAN FINAL ───────────────────────────────────
  async makeDecision({ technicalAnalysis: ta, sentiment, price, symbol, recentPrices, sessionInfo }) {
    // ── Inject trade memory dari Supabase ke prompt ──────────
    let memoryContext = "";
    if (tradeMemory) {
      try {
        memoryContext = await tradeMemory.getContext(symbol);
      } catch(e) { /* non-blocking */ }
    }
    const coin = symbol.replace("USDT", "");
    const chg  = recentPrices && recentPrices.length >= 2
      ? (((recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0]) * 100).toFixed(3)
      : "0";
    const mom = parseFloat(chg) > 0.05 ? "BULLISH" : parseFloat(chg) < -0.05 ? "BEARISH" : "FLAT";

    const sentimentConflict =
      (ta.direction === "LONG"  && sentiment.label === "BEARISH" && sentiment.impact === "HIGH") ||
      (ta.direction === "SHORT" && sentiment.label === "BULLISH" && sentiment.impact === "HIGH");

    const lev    = ta.recommendedLev || 15;
    const sigTier = (ta.signal === "STRONG_BUY" || ta.signal === "STRONG_SELL") ? "strong"
                  : (ta.entryQuality === "EXCELLENT" || ta.entryQuality === "GOOD") ? "normal"
                  : "weak";
    const defSlt  = getSlTp(lev, sigTier);

    // Threshold naik seiring leverage (scalping santai = lebih pilih2 di leverage tinggi)
    const confThr = lev >= 30 ? "0.72" : lev >= 25 ? "0.68" : lev >= 20 ? "0.65" : lev >= 15 ? "0.62" : "0.60";

    const confSummary = ta.confluence
  ? `Confluence: ${ta.confluence.direction} score=${ta.confluence.score > 0 ? "+" : ""}${ta.confluence.score} | ${ta.confluence.bullScore}↑ bull / ${ta.confluence.bearScore}↓ bear\nWarnings: ${ta.confluence.warnings.length > 0 ? ta.confluence.warnings.join("; ") : "none"}`
  : "Confluence: N/A";

const prompt = `Make the FINAL entry decision for ${coin} at $${price}. CAPITAL PROTECTION IS PRIORITY #1.
${memoryContext ? "\n" + memoryContext + "\nUse this memory to adjust confidence: lower it if this symbol/side has poor history, raise slightly if strong.\n" : ""}
=== SIGNAL SUMMARY ===
Technical : ${ta.signal} | Direction: ${ta.direction}
Confidence: ${(ta.confidence * 100).toFixed(0)}% | Quality: ${ta.entryQuality}
TF Align  : ${ta.tfAlignment}
${confSummary}
Momentum  : ${chg}% (${mom}) | Session: ${sessionInfo}

Sentiment : ${sentiment.label} (impact: ${sentiment.impact}) — ${sentiment.reason}
Conflict  : ${sentimentConflict ? "YES — news contradicts technicals → HOLD unless score >= +4" : "NO"}
${sentiment.warning ? "NEWS WARNING: " + sentiment.warning : ""}

=== STRICT ENTRY CRITERIA (ALL must be true) ===
1. Confidence >= ${confThr}
2. Quality = EXCELLENT or GOOD (FAIR/POOR = HOLD)
3. No HIGH sentiment conflict UNLESS confluence score >= +4/-4
4. Momentum not strongly opposing (opposing > 0.3% = red flag)
5. Risk = LOW or MEDIUM
6. Session is active (not QUIET/DINI_HARI)

=== LOSS PREVENTION RULES (check before BUY/SELL) ===
- If confluence score between -1 and +1: ALWAYS HOLD — setup terlalu mixed
- If any warning contains "BB squeeze": HOLD — tunggu breakout
- If sentiment HIGH conflict AND score < 4: HOLD — news terlalu kuat
- If momentum opposing direction by > 0.5%: HOLD atau tunggu reversal
- If quality POOR: HOLD tidak peduli signal apapun

=== SL/TP GUIDANCE ===
Default for ${lev}x ${sigTier}: SL=${defSlt.sl}% | TP1=${defSlt.tp1}% | TP2=${defSlt.tp2}%
Adjust based on:
- High ATR/volatility → widen SL by +0.2-0.3%, widen TP proportionally
- Low volatility (squeeze) → do NOT enter, output HOLD
- Near S/R: tighten SL if at support (LONG) or resistance (SHORT)
Never: SL < 0.5% or TP2 < 1.5%

Respond ONLY with this JSON (no markdown):
{"action":"BUY|SELL|HOLD","position":"LONG|SHORT|NONE","confidence":0.65,"reason":"max 80 chars","sl_pct":${defSlt.sl},"tp1_pct":${defSlt.tp1},"tp2_pct":${defSlt.tp2},"urgency":"NOW|WAIT|SKIP","grade":"A|B|C|D","risk_warning":"","leverage_used":${lev}}`;
    try {
      const r = await this._chat(prompt, 280);
      const p = this._parseJSON(r);

      const rawSl  = parseFloat(p.sl_pct);
      const rawTp1 = parseFloat(p.tp1_pct);
      const rawTp2 = parseFloat(p.tp2_pct);

      // Validasi SL/TP dalam range masuk akal
      const finalSl  = (rawSl  > 0.3 && rawSl  < 8)  ? rawSl  : defSlt.sl;
      const finalTp1 = (rawTp1 > 0.5 && rawTp1 < 15) ? rawTp1 : defSlt.tp1;
      const finalTp2 = (rawTp2 > 1.0 && rawTp2 < 15) ? rawTp2 : defSlt.tp2;

      const usedLev = this._snapLeverage(parseInt(p.leverage_used) || lev);

      return {
        action      : this._validateEnum(p.action, ["BUY","SELL","HOLD"], "HOLD"),
        position    : this._validateEnum(p.position, ["LONG","SHORT","NONE"], "NONE"),
        confidence  : Math.min(1, Math.max(0.50, parseFloat(p.confidence) || 0.50)),
        reason      : (typeof p.reason === "string" ? p.reason : "-").slice(0, 100),
        slPct       : finalSl,
        tp1Pct      : finalTp1,
        tp2Pct      : finalTp2,
        urgency     : this._validateEnum(p.urgency, ["NOW","WAIT","SKIP"], "WAIT"),
        grade       : this._validateEnum(p.grade, ["A","B","C","D"], "D"),
        riskWarning : (typeof p.risk_warning === "string" ? p.risk_warning : "").slice(0, 120),
        leverageUsed: usedLev,
      };
    } catch(e) {
      console.warn(`[GroqAnalyzer] makeDecision fallback: ${e.message}`);
      return {
        action: "HOLD", position: "NONE", confidence: 0.50,
        reason: `AI unavailable: ${e.message}`.slice(0, 100),
        slPct: defSlt.sl, tp1Pct: defSlt.tp1, tp2Pct: defSlt.tp2,
        urgency: "SKIP", grade: "D", riskWarning: "AI timeout — skip entry",
        leverageUsed: lev,
      };
    }
  }

  // ─── 4. MONITOR POSISI TERBUKA ────────────────────────────
  async analyzeOpenPosition({ side, entryPrice, currentPrice, pnl, pnlPct, rsi, trend, histogram, atr, tp1Hit, trailSL }) {
    const prompt = `Evaluate this open ${side.toUpperCase()} scalping position.

Entry: $${entryPrice} | Now: $${currentPrice} | PnL: $${typeof pnl === "number" ? pnl.toFixed(2) : pnl} (${pnlPct}%)
TP1: ${tp1Hit ? "HIT ✅" : "not yet"} | Trail SL: $${trailSL || "N/A"}
RSI: ${rsi.toFixed(2)} | Trend: ${trend} | MACD Histogram: ${histogram ? histogram.toFixed(6) : "N/A"}

CLOSE conditions:
LONG  → RSI > 73 AND (trend DOWNTREND OR negative histogram) OR PnL > +3%
SHORT → RSI < 27 AND (trend UPTREND OR positive histogram) OR PnL > +3%
Any direction → trend strongly reversed for 2+ candles

Respond ONLY with this JSON:
{"action":"HOLD|CLOSE","reason":"brief reason max 60 chars","urgency":"HIGH|NORMAL"}`;

    try {
      const r = await this._chat(prompt, 100);
      const p = this._parseJSON(r);
      return {
        action : this._validateEnum(p.action, ["HOLD","CLOSE"], "HOLD"),
        reason : (typeof p.reason === "string" ? p.reason : "-").slice(0, 100),
        urgency: this._validateEnum(p.urgency, ["HIGH","NORMAL"], "NORMAL"),
      };
    } catch(e) {
      return { action: "HOLD", reason: "AI unavailable", urgency: "NORMAL" };
    }
  }

  // ─── HELPERS ─────────────────────────────────────────────

  // Snap leverage ke nilai valid terdekat dalam 10–30
  _snapLeverage(raw) {
    const capped = Math.max(10, Math.min(30, raw));
    return VALID_LEVERAGES.reduce((a, b) =>
      Math.abs(b - capped) < Math.abs(a - capped) ? b : a
    );
  }

  // Fallback rule-based kalau AI gagal
  _technicalFallback(rsi, histogram, bullPct, bearPct) {
    let signal = "HOLD", direction = "NONE", confidence = 0.50, recLev = 15;

    if (bullPct >= 75 && rsi > 45 && rsi < 62 && histogram > 0) {
      signal = "BUY"; direction = "LONG"; confidence = 0.62; recLev = 20;
    } else if (bullPct >= 60 && rsi > 42 && rsi < 65 && histogram > 0) {
      signal = "BUY"; direction = "LONG"; confidence = 0.60; recLev = 15;
    } else if (bearPct >= 75 && rsi > 38 && rsi < 55 && histogram < 0) {
      signal = "SELL"; direction = "SHORT"; confidence = 0.62; recLev = 20;
    } else if (bearPct >= 60 && rsi > 35 && rsi < 58 && histogram < 0) {
      signal = "SELL"; direction = "SHORT"; confidence = 0.60; recLev = 15;
    }

    return {
      signal,
      direction,
      confidence,
      reason        : "AI unavailable — rule-based fallback",
      risk          : "MEDIUM",
      entryQuality  : signal === "HOLD" ? "POOR" : "FAIR",
      tfAlignment   : `${bullPct}%bull/${bearPct}%bear`,
      recommendedLev: recLev,
      lev30xSafe    : false,
      bullPct,
      bearPct,
    };
  }

  // Hitung trend cepat dari candle array
  _quickTrend(candles) {
    if (!candles || candles.length < 21) return "UNKNOWN";
    const cls = candles.map(c => c.close);
    const k   = 2 / 21;
    let ema   = cls.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
    for (let i = 20; i < cls.length; i++) ema = cls[i] * k + ema * (1 - k);
    const last = cls[cls.length - 1];
    if (last > ema * 1.003)  return "STRONG_UPTREND";
    if (last > ema * 1.001)  return "UPTREND";
    if (last < ema * 0.997)  return "STRONG_DOWNTREND";
    if (last < ema * 0.999)  return "DOWNTREND";
    return "SIDEWAYS";
  }

  _validateEnum(value, allowed, fallback) {
    return (typeof value === "string" && allowed.includes(value.trim())) ? value.trim() : fallback;
  }

  // ─── CEREBRAS API CALL ───────────────────────────────────
  async _chat(msg, maxTokens = 300) {
    const body = JSON.stringify({
      model      : this.model,
      messages   : [{ role: "user", content: msg }],
      max_tokens : maxTokens,
      temperature: 0.1, // rendah = konsisten
    });

    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl);
      const req = https.request({
        hostname: url.hostname,
        path    : url.pathname,
        method  : "POST",
        headers : {
          Authorization   : `Bearer ${this.apiKey}`,
          "Content-Type"  : "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      }, res => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => {
          try {
            const p = JSON.parse(data);
            if (p.error) { reject(new Error(`Cerebras: ${p.error.message}`)); return; }
            resolve(p.choices?.[0]?.message?.content?.trim() || "{}");
          } catch { reject(new Error("Cerebras parse error")); }
        });
      });

      req.setTimeout(12000, () => {
        req.destroy();
        reject(new Error("Cerebras timeout"));
      });

      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  _parseJSON(text) {
    const stripped = text.replace(/```(?:json)?[\s\S]*?```/gi, t =>
      t.replace(/```(?:json)?/gi, "")).replace(/```/g, "").trim();
    try { return JSON.parse(stripped); } catch {
      const m = stripped.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      return {};
    }
  }
}

module.exports = { GroqAnalyzer };
