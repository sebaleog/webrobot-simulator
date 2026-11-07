"use strict";

/* =====================================================================
 * indicators.js — VWAP, EMA 9/20, ATR, pivots
 * Toutes les formules calculées localement, aucune dépendance externe.
 * Sources des formules (standard technique, cf. README.md) :
 *  - EMA : moyenne mobile exponentielle, période P, coefficient 2/(P+1)
 *  - VWAP session : somme(prix_typique * volume) / somme(volume),
 *    remise à zéro à chaque session UTC (journée UTC)
 *  - ATR(14) : moyenne sur 14 du True Range
 *  - Pivots (floor trader) : PP = (H+L+C)/3, R1 = 2PP-L, S1 = 2PP-H,
 *    R2 = PP + (H-L), S2 = PP - (H-L)
 * ===================================================================== */

class EMA {
  constructor(period) {
    this.period = period;
    this.k = 2 / (period + 1);
    this.value = null;
    this.n = 0; // nombre de valeurs vues (pour savoir si la chaîne est amorcée)
  }

  update(close) {
    if (this.value === null) this.value = close;
    else this.value = close * this.k + this.value * (1 - this.k);
    this.n += 1;
    return this.value;
  }

  ready() {
    return this.n >= this.period;
  }
}

class ATR {
  constructor(period = 14) {
    this.period = period;
    this.trs = [];
    this.value = null;
  }

  update(candle, prev) {
    if (!prev) return this.value;
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prev.close),
      Math.abs(candle.low - prev.close)
    );
    this.trs.push(tr);
    if (this.trs.length > this.period) this.trs.shift();
    this.value = this.trs.reduce((a, b) => a + b, 0) / this.trs.length;
    return this.value;
  }

  ready() {
    return this.trs.length >= this.period;
  }
}

function sessionKey(timeMs) {
  // Session = journée UTC (AAAA-MM-JJ)
  return new Date(timeMs).toISOString().slice(0, 10);
}

function typicalPrice(c) {
  return (c.high + c.low + c.close) / 3;
}

// Pivots calculés à partir d'une bougie clôturée
function pivotsFrom(c) {
  const pp = (c.high + c.low + c.close) / 3;
  const range = c.high - c.low;
  return {
    pp,
    r1: 2 * pp - c.low,
    s1: 2 * pp - c.high,
    r2: pp + range,
    s2: pp - range,
  };
}

/* Agrégat d'indicateurs pour une session de simulation. */
class IndicatorSet {
  constructor() {
    this.ema9 = new EMA(9);
    this.ema20 = new EMA(20);
    this.atr = new ATR(14);
    this.last = null; // dernière bougie mise à jour
  }

  // Passe sur une série de bougies SANS générer de signaux (amorçage).
  // Si `snapshots` est fourni, enregistre l'état des indicateurs à chaque
  // bougie (aligné index par index sur `candles`) — utilisé pour le warm
  // start de la stratégie et pour le graphe de l'historique.
  warmup(candles, snapshots) {
    let key = null;
    let sumPV = 0;
    let sumV = 0;
    for (const c of candles) {
      this.update(c);
      if (!snapshots) continue;
      // VWAP de session calculé au fil de l'eau (aucun avenir consulté)
      const k = sessionKey(c.time);
      if (k !== key) { key = k; sumPV = 0; sumV = 0; }
      const v = c.volume || 0;
      sumPV += typicalPrice(c) * v;
      sumV += v;
      snapshots.push({
        ema9: this.ema9.value,
        ema20: this.ema20.value,
        atr: this.atr.value,
        vwap: sumV > 0 ? sumPV / sumV : c.close,
        pivots: pivotsFrom(c),
        ready: this.ema9.ready() && this.ema20.ready() && this.atr.ready(),
      });
    }
  }

  // Met à jour l'état à chaque nouvelle bougie (clôturée ou en cours de remplacement)
  update(candle) {
    this.ema9.update(candle.close);
    this.ema20.update(candle.close);
    this.atr.update(candle, this.last);
    this.last = candle;
  }

  // VWAP de session : recalcul complet (série courte, coût négligeable)
  vwap(candles, timeMs) {
    const key = sessionKey(timeMs);
    let sumPV = 0;
    let sumV = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i];
      if (sessionKey(c.time) !== key) break; // arrêt à la session précédente
      const v = c.volume || 0;
      sumPV += typicalPrice(c) * v;
      sumV += v;
    }
    if (sumV > 0) return sumPV / sumV;
    // Repli : dernier prix connu si la série ne contient pas la session
    return this.last ? this.last.close : null;
  }

  // Instantané complet utilisé par la stratégie et le broker
  snapshot(candles, timeMs) {
    const pivots = this.last ? pivotsFrom(this.last) : null;
    const atr = this.atr.value !== null ? this.atr.value : 0;
    return {
      ema9: this.ema9.value,
      ema20: this.ema20.value,
      atr,
      vwap: this.vwap(candles, timeMs),
      pivots,
      ready: this.ema9.ready() && this.ema20.ready() && this.atr.ready(),
    };
  }
}
