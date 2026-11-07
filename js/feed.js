"use strict";

/* =====================================================================
 * feed.js — connexion temps réel aux prix (WebSocket Binance)
 *
 * Sources (gratuites, sans clé API, sans compte) — cf. README.md :
 *  - Flux WebSocket : wss://data-stream.binance.vision (données publiques)
 *    repli sur wss://stream.binance.com:9443
 *  - Historique REST : https://data-api.binance.vision/api/v3/klines
 *    repli sur https://api.binance.com/api/v3/klines
 *
 * Souscription à deux flux combinés :
 *  - <sym>@kline_1m   : bougies d'1 minute (la décision se fait à la clôture)
 *  - <sym>@aggTrade   : transactions agrégées (ticks, suivi du prix en direct)
 * ===================================================================== */

const FEED = {
  WS_HOSTS: [
    "wss://data-stream.binance.vision",
    "wss://stream.binance.com:9443",
  ],
  REST_HOSTS: [
    "https://data-api.binance.vision",
    "https://api.binance.com",
  ],
  HISTORY_LIMIT: 200, // bougies 1m chargées à l'ouverture (amorçage des EMA)
};

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Vérifie que le symbole existe bien sur le marché Binance.
 * @returns {'ok'|'invalid'|'network'}
 */
async function validateSymbol(symbol) {
  let networkFailed = false;
  for (const host of FEED.REST_HOSTS) {
    try {
      await fetchJson(`${host}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`);
      return "ok";
    } catch (e) {
      if (e.status === 400 || e.status === 404) return "invalid"; // symbole inconnu
      networkFailed = true; // erreur réseau, on tente l'hôte suivant
    }
  }
  return networkFailed ? "network" : "invalid";
}

/** Charge l'historique des bougies 1m pour amorcer les indicateurs. */
async function loadHistory(symbol) {
  let lastErr = null;
  for (const host of FEED.REST_HOSTS) {
    try {
      const rows = await fetchJson(
        `${host}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=${FEED.HISTORY_LIMIT}`
      );
      return rows.map((r) => ({
        time: r[0],
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5]),
        closed: true,
      }));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("historique indisponible");
}

/**
 * Flux WebSocket temps réel pour un symbole.
 * Reconnexion automatique avec backoff tant que la session est active.
 */
class BinanceFeed {
  constructor(symbol, { onTick, onKline, onStatus }) {
    this.symbol = symbol.toLowerCase();
    this.onTick = onTick;
    this.onKline = onKline;
    this.onStatus = onStatus; // ('connecting' | 'live' | 'down' | 'closed')
    this.ws = null;
    this.hostIndex = 0;
    this.running = false;
    this.retry = 0;
    this.retryTimer = null;
  }

  start() {
    this.running = true;
    this._connect();
  }

  stop() {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.onStatus("closed");
  }

  _connect() {
    if (!this.running) return;
    const host = FEED.WS_HOSTS[this.hostIndex];
    const streams = `${this.symbol}@kline_1m/${this.symbol}@aggTrade`;
    this.onStatus("connecting");

    let ws;
    try {
      ws = new WebSocket(`${host}/stream?streams=${streams}`);
    } catch (e) {
      this._scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onStatus("live");
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (e) {
        return;
      }
      const data = msg && msg.data ? msg.data : msg;
      if (!data || !data.e) return;

      if (data.e === "aggTrade") {
        const price = parseFloat(data.p);
        if (isFinite(price)) this.onTick(price, data.T || data.E);
      } else if (data.e === "kline" && data.k) {
        const k = data.k;
        this.onKline({
          time: k.t,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v),
          closed: !!k.x,
        });
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.running) {
        this.onStatus("down");
        this._scheduleRetry();
      }
    };

    ws.onerror = () => {
      // onclose sera appelé juste après : la reprise s'y gère
    };
  }

  _scheduleRetry() {
    if (!this.running || this.retryTimer) return;
    this.retry += 1;
    // Bascule d'hôte puis backoff progressif (1s, 2s, 4s … max 15s)
    if (this.retry % 3 === 0) this.hostIndex = (this.hostIndex + 1) % FEED.WS_HOSTS.length;
    const delay = Math.min(15000, 1000 * Math.pow(2, Math.min(this.retry - 1, 4)));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._connect();
    }, delay);
  }
}
