"use strict";

/* =====================================================================
 * strategy.js — règles LONG / SHORT
 *
 * Rappel des règles (documentées dans README.md) :
 *  Filtre de tendance  : EMA 9 > EMA 20 (LONG) / EMA 9 < EMA 20 (SHORT)
 *  Filtre de prix      : prix > VWAP (LONG) / prix < VWAP (SHORT)
 *  Repli              : le prix vient toucher le « nuage » EMA 9/20,
 *                        ce qui arme la possibilité d'entrée.
 *  Déclencheur (CBC)   : Candle By Candle —
 *                        LONG  si clôture > plus haut de la bougie précédente
 *                        SHORT si clôture < plus bas de la bougie précédente
 *  Attention : n'agit QUE sur des bougies clôturées (règle CBC).
 *
 * Une entrée a lieu uniquement si aucun trade n'est ouvert — c'est le
 * broker qui décide, la stratégie se contente d'émettre un signal.
 * ===================================================================== */

class Strategy {
  constructor({ armTTL = 6 } = {}) {
    this.armTTL = armTTL; // durée de validité d'un repli, en bougies
    this.armedLong = false;
    this.armedShort = false;
    this.armAge = 0;
  }

  reset() {
    this.armedLong = false;
    this.armedShort = false;
    this.armAge = 0;
  }

  /**
   * @param {object} candle   bougie vient de clôturer
   * @param {object} prev     bougie précédente
   * @param {object} ind      instantané d'indicateurs (IndicatorSet.snapshot)
   * @returns {'LONG'|'SHORT'|null}
   */
  onCandle(candle, prev, ind) {
    if (!prev || !ind || !ind.ready) return null;

    const { ema9, ema20, vwap } = ind;
    const cloudHi = Math.max(ema9, ema20);
    const cloudLo = Math.min(ema9, ema20);

    const trendUp = ema9 > ema20;
    const trendDn = ema9 < ema20;
    const aboveVwap = candle.close > vwap;
    const belowVwap = candle.close < vwap;

    // Âge du repli : au-delà de armTTL bougies, l'opportunité est expirée
    if (this.armedLong || this.armedShort) {
      this.armAge += 1;
      if (this.armAge > this.armTTL) this.reset();
    }

    // ---- Arming : le prix vient de rentrer dans le nuage ------------------
    if (trendUp && aboveVwap && candle.low <= cloudHi && candle.low >= cloudLo) {
      if (!this.armedLong) {
        this.armedLong = true;
        this.armedShort = false;
        this.armAge = 0;
      }
    }
    if (trendDn && belowVwap && candle.high >= cloudLo && candle.high <= cloudHi) {
      if (!this.armedShort) {
        this.armedShort = true;
        this.armedLong = false;
        this.armAge = 0;
      }
    }

    // ---- Déclenchement CBC sur bougie clôturée ---------------------------
    const cbcLong = candle.close > prev.high;
    const cbcShort = candle.close < prev.low;

    if (this.armedLong && cbcLong && trendUp && aboveVwap) {
      this.reset();
      return "LONG";
    }
    if (this.armedShort && cbcShort && trendDn && belowVwap) {
      this.reset();
      return "SHORT";
    }

    return null;
  }

  // Journal lisible des étapes de décision (affiché dans l'UI)
  describe(candle, prev, ind) {
    if (!prev || !ind || !ind.ready) return "amorçage des indicateurs…";
    const trendUp = ind.ema9 > ind.ema20;
    const trend = trendUp ? "tendance ↑" : "tendance ↓";
    const prix = candle.close > ind.vwap ? "prix > VWAP" : "prix < VWAP";
    const repli = this.armedLong || this.armedShort ? "repli armé" : "pas de repli";
    return `${trend} · ${prix} · ${repli}`;
  }
}
