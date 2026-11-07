"use strict";

/* =====================================================================
 * ui.js — rendu de la page (affichage uniquement, aucun état métier)
 * ===================================================================== */

const UI = {
  els: {},

  init() {
    const ids = [
      "start-screen", "game-screen", "symbol-form", "symbol-input",
      "symbol-error", "live-symbol", "live-price", "feed-status",
      "chart", "stat-capital", "stat-equity", "stat-pnl",
      "stat-trades", "stat-winrate", "stat-totalr", "stat-drawdown",
      "position-box", "position-empty", "position-detail",
      "strategy-line", "trades-body", "trades-empty",
      "btn-pause", "btn-reset",
    ];
    for (const id of ids) this.els[id] = document.getElementById(id);
  },

  showStart() {
    this.els["start-screen"].hidden = false;
    this.els["game-screen"].hidden = true;
    this.resetForm();
  },

  resetForm() {
    this.els["symbol-error"].hidden = true;
    this.resetErrorStyle();
    this.els["symbol-input"].disabled = false;
    const btn = this.els["symbol-form"].querySelector("button");
    btn.disabled = false;
    btn.textContent = "Lancer";
  },

  showGame(symbol) {
    this.els["start-screen"].hidden = true;
    this.els["game-screen"].hidden = false;
    this.resetForm();
    this.els["live-symbol"].textContent = symbol;
    this.els["live-price"].textContent = "—";
  },

  startError(message) {
    const el = this.els["symbol-error"];
    el.textContent = message;
    el.hidden = false;
    this.els["symbol-input"].disabled = false;
    this.els["symbol-form"].querySelector("button").disabled = false;
    this.els["symbol-form"].querySelector("button").textContent = "Lancer";
  },

  busy() {
    this.els["symbol-error"].hidden = true;
    this.els["symbol-input"].disabled = true;
    const btn = this.els["symbol-form"].querySelector("button");
    btn.disabled = true;
    btn.textContent = "Vérification…";
  },

  // Retour visuel pendant le chargement de l'historique
  loading(message) {
    const el = this.els["symbol-error"];
    el.textContent = message;
    el.hidden = false;
    el.className = "info";
    const btn = this.els["symbol-form"].querySelector("button");
    btn.textContent = "Chargement…";
  },

  resetErrorStyle() {
    const el = this.els["symbol-error"];
    el.className = "error";
  },

  price(price) {
    this.els["live-price"].textContent = UI.fmtPrice(price);
  },

  feedStatus(state) {
    const el = this.els["feed-status"];
    const map = {
      connecting: ["flux : connexion…", "status-wait"],
      live: ["flux : en direct", "status-live"],
      down: ["flux : reconnexion…", "status-wait"],
      closed: ["flux : hors ligne", "status-off"],
    };
    const [text, cls] = map[state] || map.closed;
    el.textContent = text;
    el.className = "status " + cls;
  },

  stats(stats, floating) {
    const equity = stats.capital + (floating || 0);
    this.els["stat-capital"].textContent = UI.fmtEur(stats.initialCapital);
    this.els["stat-equity"].textContent = UI.fmtEur(equity);
    const pnl = stats.capital - stats.initialCapital;
    const pnlEl = this.els["stat-pnl"];
    pnlEl.textContent = (pnl >= 0 ? "+" : "") + UI.fmtEur(pnl);
    pnlEl.className = "value " + (pnl >= 0 ? "pos" : "neg");
    this.els["stat-trades"].textContent = String(stats.tradeCount);
    this.els["stat-winrate"].textContent = stats.tradeCount
      ? stats.winRate.toFixed(0) + " %"
      : "—";
    const rEl = this.els["stat-totalr"];
    rEl.textContent = (stats.totalR >= 0 ? "+" : "") + stats.totalR.toFixed(2) + " R";
    rEl.className = "value " + (stats.totalR >= 0 ? "pos" : "neg");
    this.els["stat-drawdown"].textContent = "-" + UI.fmtEur(stats.maxDrawdown);
  },

  position(pos, floating) {
    const box = this.els["position-box"];
    if (!pos) {
      this.els["position-empty"].hidden = false;
      this.els["position-detail"].hidden = true;
      return;
    }
    this.els["position-empty"].hidden = true;
    this.els["position-detail"].hidden = false;
    const long = pos.side === "LONG";
    box.querySelector(".pos-side").textContent = long ? "LONG ▲" : "SHORT ▼";
    box.querySelector(".pos-side").className = "pos-side " + (long ? "pos" : "neg");
    box.querySelector(".pos-entry").textContent = UI.fmtPrice(pos.entry);
    box.querySelector(".pos-sl").textContent = UI.fmtPrice(pos.sl);
    box.querySelector(".pos-tp").textContent = UI.fmtPrice(pos.tp);
    const fEl = box.querySelector(".pos-floating");
    fEl.textContent = (floating >= 0 ? "+" : "") + UI.fmtEur(floating);
    fEl.className = "pos-floating " + (floating >= 0 ? "pos" : "neg");
  },

  strategyLine(text) {
    this.els["strategy-line"].textContent = text;
  },

  trades(trades) {
    const body = this.els["trades-body"];
    const empty = this.els["trades-empty"];
    body.innerHTML = "";
    if (!trades.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    for (const t of trades.slice(-40).reverse()) {
      const tr = document.createElement("tr");
      const long = t.side === "LONG";
      tr.innerHTML =
        `<td>${new Date(t.entryTime).toLocaleTimeString("fr-FR")}</td>` +
        `<td class="${long ? "pos" : "neg"}">${t.side}</td>` +
        `<td>${UI.fmtPrice(t.entry)}</td>` +
        `<td>${UI.fmtPrice(t.exit)}</td>` +
        `<td>${t.reason}</td>` +
        `<td class="${t.pnl >= 0 ? "pos" : "neg"}">${(t.pnl >= 0 ? "+" : "") + UI.fmtEur(t.pnl)}</td>` +
        `<td class="${t.r >= 0 ? "pos" : "neg"}">${(t.r >= 0 ? "+" : "") + t.r.toFixed(2)} R</td>`;
      body.appendChild(tr);
    }
  },

  setPaused(paused) {
    this.els["btn-pause"].textContent = paused ? "Reprendre" : "Pause";
  },

  /* ---------- TradingView : widget officiel gratuit ---------- */
  mountChart(symbol) {
    const container = this.els["chart"];
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "tradingview-widget-container";
    wrap.style.height = "100%";
    const inner = document.createElement("div");
    inner.id = "tv-chart";
    inner.style.height = "100%";
    wrap.appendChild(inner);
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: "BINANCE:" + symbol.toUpperCase(),
      interval: "1",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "fr",
      hide_side_toolbar: false,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      withdateranges: false,
      support_host: "https://www.tradingview.com",
    });
    wrap.appendChild(script);
    container.appendChild(wrap);
  },

  /* Si le widget TradingView ne se charge pas (réseau, blocage),
     on l'affiche au lieu d'un cadre vide. */
  checkChartLoaded() {
    if (this._chartTimer) clearTimeout(this._chartTimer);
    this._chartTimer = setTimeout(() => {
      const container = this.els["chart"];
      if (!container || container.hidden) return;
      if (container.querySelector("iframe")) return;
      const msg = document.createElement("div");
      msg.className = "chart-fallback";
      msg.innerHTML =
        "Graphique TradingView indisponible (chargement bloqué ou réseau).<br>" +
        "Le simulateur, lui, reste opérationnel avec les prix en direct.";
      container.innerHTML = "";
      container.appendChild(msg);
    }, 8000);
  },

  /* ---------- Formats ---------- */
  fmtEur(v) {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 2,
    }).format(v || 0);
  },

  fmtPrice(v) {
    if (typeof v !== "number" || !isFinite(v)) return "—";
    const digits = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
    return new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v) + " $";
  },
};
