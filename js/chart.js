"use strict";

/* =====================================================================
 * chart.js — graphe « vue du robot » : les données que le moteur a
 * réellement utilisées (historique 1 min chargé + bougie en cours),
 * avec EMA 9/20, VWAP, marqueurs de trades et niveaux de position.
 *
 * Rendu canvas pur : aucune dépendance, aucun réseau.
 * ===================================================================== */

class RobotChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.visible = 90;          // bougies affichées
    this.last = null;           // dernier jeu de données (pour le redimensionnement)
    this.colors = {
      bg: "#161b26",
      grid: "#232b3d",
      axis: "#8b94a7",
      up: "#22c55e",
      down: "#ef4444",
      ema9: "#3b82f6",
      ema20: "#f59e0b",
      vwap: "#a78bfa",
      price: "#dbe2ef",
      entry: "#38bdf8",
      sl: "#ef4444",
      tp: "#22c55e",
    };
    window.addEventListener("resize", () => {
      if (this.last) this.render(this.last);
    });
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  /**
   * @param {object} d
   *   d.candles   toutes les bougies clôturées (Session.candles)
   *   d.snapshots indicateurs alignés (index identique, sauf bougie en cours)
   *   d.pending   bougie en cours (optionnelle)
   *   d.position  position ouverte ou null
   *   d.trades    trades clôturés
   *   d.livePrice dernier prix
   */
  render(d) {
    this.last = d;
    const { w, h } = this._resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);

    const candles = d.candles || [];
    if (candles.length < 2) return;

    const start = Math.max(0, candles.length - this.visible);
    const slice = [];
    for (let i = start; i < candles.length; i++) {
      slice.push({ c: candles[i], s: (d.snapshots && i < d.snapshots.length) ? d.snapshots[i] : null, i });
    }
    const pending = d.pending
      ? { c: d.pending, s: null, i: candles.length }
      : null;
    const items = pending ? slice.concat([pending]) : slice;
    if (items.length < 2) return;

    // --- échelle verticale -------------------------------------------
    let min = Infinity, max = -Infinity;
    const consider = (v) => {
      if (typeof v === "number" && isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); }
    };
    for (const it of items) {
      consider(it.c.high); consider(it.c.low);
      if (it.s && it.s.ready) { consider(it.s.ema9); consider(it.s.ema20); consider(it.s.vwap); }
    }
    if (d.position) {
      consider(d.position.entry); consider(d.position.sl); consider(d.position.tp);
    }
    if (typeof d.livePrice === "number") consider(d.livePrice);
    if (!isFinite(min) || !isFinite(max)) return;
    const pad = (max - min) * 0.06 || max * 0.001 || 1;
    min -= pad; max += pad;

    const padL = 8, padT = 8, padR = 74, padB = 22;
    const plotW = Math.max(10, w - padL - padR);
    const plotH = Math.max(10, h - padT - padB);
    const n = items.length;
    const step = plotW / n;
    const cw = Math.max(1, Math.min(9, step * 0.66));

    const xAt = (idx) => padL + (idx + 0.5) * step;
    const yAt = (v) => padT + (max - v) / (max - min) * plotH;

    // --- grille + axe des prix ----------------------------------------
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const lines = 5;
    for (let g = 0; g < lines; g++) {
      const v = min + (max - min) * (g / (lines - 1));
      const y = yAt(v);
      ctx.strokeStyle = this.colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = this.colors.axis;
      ctx.textAlign = "left";
      ctx.fillText(this._fmtPrice(v), padL + plotW + 6, y);
    }

    // --- axe du temps --------------------------------------------------
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelEvery = Math.ceil(n / 8);
    for (let i = 0; i < n; i += labelEvery) {
      const t = new Date(items[i].c.time);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      ctx.fillStyle = this.colors.axis;
      ctx.fillText(`${hh}:${mm}`, xAt(i), h - padB + 6);
    }

    // --- chandeliers ----------------------------------------------------
    for (let i = 0; i < n; i++) {
      const c = items[i].c;
      const x = xAt(i);
      const up = c.close >= c.open;
      const col = up ? this.colors.up : this.colors.down;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      // mèche
      ctx.beginPath();
      ctx.moveTo(x, yAt(c.high));
      ctx.lineTo(x, yAt(c.low));
      ctx.stroke();
      // corps
      const yTop = yAt(Math.max(c.open, c.close));
      const yBot = yAt(Math.min(c.open, c.close));
      ctx.fillStyle = col;
      ctx.fillRect(x - cw / 2, yTop, cw, Math.max(1, yBot - yTop));
    }

    // --- courbes d'indicateurs ------------------------------------------
    const drawSeries = (pick, color, dashed, width) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width || 1.4;
      if (dashed) ctx.setLineDash(dashed);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const s = items[i].s;
        if (!s || !s.ready) { started = false; continue; }
        const v = pick(s);
        if (typeof v !== "number" || !isFinite(v)) { started = false; continue; }
        const x = xAt(i), y = yAt(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };
    drawSeries((s) => s.ema9, this.colors.ema9, null, 1.4);
    drawSeries((s) => s.ema20, this.colors.ema20, null, 1.4);
    drawSeries((s) => s.vwap, this.colors.vwap, [5, 4], 1.2);

    // --- marqueurs de trades ---------------------------------------------
    const timeIndex = new Map(items.map((it, idx) => [it.c.time, idx]));
    for (const t of d.trades || []) {
      const xi = timeIndex.get(t.entryTime);
      if (xi !== undefined) {
        this._marker(xAt(xi), yAt(t.entry), t.side === "LONG" ? "up" : "down", t.side);
      }
      const xo = timeIndex.get(t.exitTime);
      if (xo !== undefined) {
        this._exitMarker(xAt(xo), yAt(t.exit), t.pnl >= 0);
      }
    }

    // --- niveaux de position ----------------------------------------------
    if (d.position) {
      const p = d.position;
      const level = (v, color, label) => {
        const y = yAt(v);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.font = "10px system-ui, sans-serif";
        ctx.fillText(label, padL + 4, y - 2);
        ctx.restore();
      };
      level(p.entry, this.colors.entry, `entrée ${this._fmtPrice(p.entry)}`);
      level(p.sl, this.colors.sl, `SL ${this._fmtPrice(p.sl)}`);
      level(p.tp, this.colors.tp, `TP ${this._fmtPrice(p.tp)}`);
    }

    // --- prix en direct ----------------------------------------------------
    if (typeof d.livePrice === "number" && isFinite(d.livePrice)) {
      const y = yAt(d.livePrice);
      ctx.save();
      ctx.strokeStyle = this.colors.price;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      const label = this._fmtPrice(d.livePrice);
      ctx.font = "10px system-ui, sans-serif";
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = this.colors.price;
      ctx.fillRect(padL + plotW + 2, y - 8, tw, 16);
      ctx.fillStyle = "#0e1117";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, padL + plotW + 6, y);
      ctx.restore();
    }
  }

  _marker(x, y, dir, side) {
    const ctx = this.ctx;
    const size = 5;
    ctx.save();
    ctx.fillStyle = dir === "up" ? this.colors.up : this.colors.down;
    ctx.beginPath();
    if (dir === "up") { // entrée longue : triangle vers le haut sous la bougie
      ctx.moveTo(x, y + size + 3);
      ctx.lineTo(x - size, y + size + 3 + size * 1.4);
      ctx.lineTo(x + size, y + size + 3 + size * 1.4);
    } else {            // entrée courte : triangle vers le haut au-dessus
      ctx.moveTo(x, y - size - 3);
      ctx.lineTo(x - size, y - size - 3 - size * 1.4);
      ctx.lineTo(x + size, y - size - 3 - size * 1.4);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = this.colors.price;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = dir === "up" ? "top" : "bottom";
    ctx.fillText(side, x, dir === "up" ? y + size + 3 + size * 1.4 + 1 : y - size - 3 - size * 1.4 - 1);
    ctx.restore();
  }

  _exitMarker(x, y, win) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = win ? this.colors.up : this.colors.down;
    ctx.fillStyle = win ? this.colors.up : this.colors.down;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _fmtPrice(v) {
    const digits = v >= 1000 ? 0 : v >= 1 ? 2 : 5;
    return new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v);
  }
}
