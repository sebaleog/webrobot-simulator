"use strict";

/* =====================================================================
 * broker.js — portefeuille virtuel
 *
 * Hypothèses de simulation (cf. README.md, valeurs par défaut modifiables) :
 *  - Capital initial      : 10 000 € (fixé, fictif)
 *  - Risque par trade     : 0.5 % du capital courant
 *  - Coûts par trade      : 0.08 R (démontage : commission + slippage réels,
 *                            non mesurés ici — c'est une hypothèse)
 *  - Slippage d'exécution : 0.05 % du prix (hypothèse)
 *  - Pas de levier        : la taille de position est plafonnée à 100 % du capital
 *
 * Le broker ne simule AUCUN carnet d'ordres réel : les ordres sont
 * supposés exécutés instantanément au prix indiqué.
 * ===================================================================== */

class Broker {
  constructor({
    initialCapital = 10000,
    riskPct = 0.005,
    costR = 0.08,
    slippagePct = 0.0005,
  } = {}) {
    this.initialCapital = initialCapital;
    this.riskPct = riskPct;
    this.costR = costR;
    this.slippagePct = slippagePct;
    this.reset();
  }

  reset() {
    this.capital = this.initialCapital;
    this.position = null;
    this.trades = []; // trades clôturés
    this.equityPeak = this.initialCapital;
    this.maxDrawdown = 0;
  }

  /* ---------------------------------------------------------------
   * Ouverture d'une position à partir d'un signal de stratégie.
   * @param {'LONG'|'SHORT'} side
   * @param {object} candle  bougie de confirmation (on entre à sa clôture)
   * @param {object} ind     instantané d'indicateurs
   * @param {Array}  candles série complète (pour le creux/creta local)
   * @returns position ou null
   * --------------------------------------------------------------- */
  open(side, candle, ind, candles) {
    if (this.position) return null;
    if (!ind || !ind.ready || !(ind.atr > 0)) return null;

    const long = side === "LONG";
    const slip = this.slippagePct;
    const entry = long ? candle.close * (1 + slip) : candle.close * (1 - slip);

    // Stop-loss sous le creux local (5 bougies) avec marge ATR
    const window = candles.slice(-5);
    const localLow = Math.min(...window.map((c) => c.low));
    const localHigh = Math.max(...window.map((c) => c.high));
    const margin = 0.5 * ind.atr;
    const sl = long ? localLow - margin : localHigh + margin;

    const riskPerUnit = Math.abs(entry - sl);
    if (!(riskPerUnit > 0)) return null;

    const riskAmount = this.capital * this.riskPct;
    let qty = riskAmount / riskPerUnit;
    if (qty * entry > this.capital) qty = this.capital / entry; // pas de levier

    // Take-profit : prochain pivot significatif ; sinon 2R par défaut
    let tp;
    if (long) {
      tp = ind.pivots ? ind.pivots.r1 : NaN;
      if (!(tp > entry + riskPerUnit)) tp = entry + 2 * riskPerUnit;
    } else {
      tp = ind.pivots ? ind.pivots.s1 : NaN;
      if (!(tp < entry - riskPerUnit)) tp = entry - 2 * riskPerUnit;
    }

    this.position = {
      side,
      entryTime: candle.time,
      entry,
      sl,
      tp,
      qty,
      riskAmount,
      stopLossUnit: riskPerUnit,
    };
    return this.position;
  }

  /* Sortie si la bougie clôturée a touché le stop ou le target.
   * Si les deux sont touchés dans la même bougie, le stop est retenu
   * (hypothèse prudente). */
  checkCandle(candle) {
    const p = this.position;
    if (!p) return null;
    if (p.side === "LONG") {
      if (candle.low <= p.sl) return this.close(p.sl, "stop-loss");
      if (candle.high >= p.tp) return this.close(p.tp, "take-profit");
    } else {
      if (candle.high >= p.sl) return this.close(p.sl, "stop-loss");
      if (candle.low <= p.tp) return this.close(p.tp, "take-profit");
    }
    return null;
  }

  /* Sortie sur tick temps réel (le stop peut se déclencher entre deux bougies). */
  checkTick(price) {
    const p = this.position;
    if (!p || typeof price !== "number" || !isFinite(price)) return null;
    if (p.side === "LONG") {
      if (price <= p.sl) return this.close(p.sl, "stop-loss (tick)");
      if (price >= p.tp) return this.close(p.tp, "take-profit (tick)");
    } else {
      if (price >= p.sl) return this.close(p.sl, "stop-loss (tick)");
      if (price <= p.tp) return this.close(p.tp, "take-profit (tick)");
    }
    return null;
  }

  /* Sortie manuelle : invalidation de tendance ou fin de session. */
  closeAt(price, reason) {
    if (!this.position) return null;
    return this.close(price, reason);
  }

  close(price, reason) {
    const p = this.position;
    if (!p) return null;

    const long = p.side === "LONG";
    const exit = long ? price * (1 - this.slippagePct) : price * (1 + this.slippagePct);
    const gross = (exit - p.entry) * p.qty * (long ? 1 : -1);
    const cost = this.costR * p.riskAmount;
    const pnl = gross - cost;
    const r = p.riskAmount > 0 ? pnl / p.riskAmount : 0;

    this.capital += pnl;
    this.equityPeak = Math.max(this.equityPeak, this.capital);
    const dd = this.equityPeak - this.capital;
    if (dd > this.maxDrawdown) this.maxDrawdown = dd;

    const trade = {
      side: p.side,
      entryTime: p.entryTime,
      entry: p.entry,
      exitTime: Date.now(),
      exit,
      reason,
      qty: p.qty,
      pnl,
      r,
      cost,
      capitalAfter: this.capital,
    };
    this.trades.push(trade);
    this.position = null;
    return trade;
  }

  /* P&L flottant de la position ouverte (hors coûts, valeur indicative). */
  floatingPnl(price) {
    const p = this.position;
    if (!p || typeof price !== "number" || !isFinite(price)) return 0;
    const long = p.side === "LONG";
    return (price - p.entry) * p.qty * (long ? 1 : -1);
  }

  stats() {
    const n = this.trades.length;
    const wins = this.trades.filter((t) => t.pnl > 0).length;
    const totalR = this.trades.reduce((a, t) => a + t.r, 0);
    const totalPnl = this.trades.reduce((a, t) => a + t.pnl, 0);
    const grossWins = this.trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const grossLosses = this.trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
    return {
      tradeCount: n,
      wins,
      losses: n - wins,
      winRate: n > 0 ? (wins / n) * 100 : 0,
      totalR,
      totalPnl,
      avgR: n > 0 ? totalR / n : 0,
      profitFactor: grossLosses !== 0 ? grossWins / Math.abs(grossLosses) : null,
      maxDrawdown: this.maxDrawdown,
      capital: this.capital,
      initialCapital: this.initialCapital,
    };
  }
}
