"use strict";

/* =====================================================================
 * main.js — orchestration de la session
 *
 * Cycle de vie :
 *  1. l'utilisateur soumet UN symbole ;
 *  2. le symbole est vérifié sur l'API Binance
 *     (inconnu → « non disponible », rien ne démarre) ;
 *  3. l'historique 1m est chargé pour amorcer les indicateurs
 *     (aucun trade n'est généré sur ces bougies passées) ;
 *  4. le flux temps réel démarre : chaque tick suit le prix et le
 *     stop/target, chaque bougie 1m clôturée fait prendre une décision ;
 *  5. fermeture de la page = destruction totale de l'état.
 *     Aucun storage (localStorage, cookie, indexDB) n'est utilisé.
 * ===================================================================== */

const Session = {
  symbol: null,
  candles: [],
  indicators: null,
  strategy: null,
  broker: null,
  feed: null,
  paused: false,
  warmedUntil: 0, // timestamp de la dernière bougie d'amorçage
  lastPrice: null,
  pendingLive: null, // bougie 1m reçue en direct, mise à jour à chaque tick kline
};

/* ------------------------------------------------------ formulaire ---- */

function normalizeSymbol(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

async function onStart(event) {
  event.preventDefault();
  const symbol = normalizeSymbol(UI.els["symbol-input"].value);
  if (!symbol) {
    UI.startError("Entrez un symbole, par exemple BTCUSDT.");
    return;
  }
  UI.busy();

  const check = await validateSymbol(symbol);
  if (check !== "ok") {
    // Marché introuvable ou vérification impossible : on n'ouvre rien.
    UI.startError(check === "invalid" ? "non disponible" : "non disponible (vérification impossible)");
    return;
  }

  const history = await loadHistory(symbol).catch(() => null);
  if (!history || history.length < 40) {
    UI.startError("non disponible (historique indisponible)");
    return;
  }

  startSession(symbol, history);
}

/* ------------------------------------------------------ session ------ */

function startSession(symbol, history) {
  stopSession();

  Session.symbol = symbol;
  Session.candles = history.slice();
  Session.indicators = new IndicatorSet();
  Session.indicators.warmup(Session.candles);
  Session.strategy = new Strategy();
  Session.broker = new Broker();
  Session.paused = false;
  Session.warmedUntil = Session.candles[Session.candles.length - 1].time;
  Session.lastPrice = Session.candles[Session.candles.length - 1].close;
  Session.pendingLive = null;

  UI.showGame(symbol);
  UI.mountChart(symbol);
  UI.setPaused(false);

  Session.feed = new BinanceFeed(symbol, {
    onTick: handleTick,
    onKline: handleKline,
    onStatus: (s) => UI.feedStatus(s),
  });
  Session.feed.start();

  refreshPanel();
}

function stopSession() {
  if (Session.feed) Session.feed.stop();
  Session.feed = null;
}

function handleTick(price, timeMs) {
  if (Session.paused) return;
  Session.lastPrice = price;
  UI.price(price);

  // Sortie stop/target entre deux bougies
  const closed = Session.broker.checkTick(price);
  if (closed) {
    UI.strategyLine(`Sortie ${closed.reason} — trade ${closed.pnl >= 0 ? "gagnant" : "perdant"} (${closed.r >= 0 ? "+" : ""}${closed.r.toFixed(2)} R)`);
  }

  // Pendant la formation de la bougie courante, on suit les extrêmes
  // pour que le checkCandle couvre la bougie entière à sa clôture.
  if (Session.pendingLive) {
    const p = Session.pendingLive;
    p.high = Math.max(p.high, price);
    p.low = Math.min(p.low, price);
    p.close = price;
    if (timeMs) p.time = Math.min(p.time, timeMs);
  }

  refreshPanel();
}

function handleKline(k) {
  if (Session.paused) return;
  const candles = Session.candles;

  if (!k.closed) {
    // Bougie en formation : suivi local (l'indicateur ne la voit qu'à la clôture)
    Session.pendingLive = { ...k, closed: false };
    return;
  }

  Session.pendingLive = null;
  const last = candles[candles.length - 1];

  if (k.time <= last.time) {
    // Cas de rattrapage (même bougie que la dernière chargée)
    candles[candles.length - 1] = k;
    return;
  }
  candles.push(k);
  if (candles.length > 1500) candles.splice(0, candles.length - 1500);

  processClosedCandle(k);
}

/* Décision : uniquement sur bougie CLÔTURÉE. */
function processClosedCandle(candle) {
  const { indicators, strategy, broker, candles } = Session;
  indicators.update(candle);

  // 1. Vérifier les sorties du trade ouvert (bougie complète)
  const exited = broker.checkCandle(candle);
  const ind = indicators.snapshot(candles, candle.time);

  // 2. Invalidation de tendance : EMA 9/20 croisée à l'envers
  if (!exited && broker.position && ind.ready) {
    const p = broker.position;
    const crossedLong = p.side === "LONG" && ind.ema9 < ind.ema20;
    const crossedShort = p.side === "SHORT" && ind.ema9 > ind.ema20;
    if (crossedLong || crossedShort) {
      const t = broker.closeAt(candle.close, "invalidation EMA");
      if (t) UI.strategyLine(`Invalidation de tendance — clôture à ${UI.fmtPrice(t.exit)}`);
    }
  }

  // 3. Nouveau signal si aucune position ouverte
  const isLive = candle.time > Session.warmedUntil;
  if (isLive && !broker.position) {
    const idx = candles.indexOf(candle);
    const prev = idx > 0 ? candles[idx - 1] : null;
    const signal = strategy.onCandle(candle, prev, ind);
    if (signal) {
      const pos = broker.open(signal, candle, ind, candles);
      if (pos) {
        UI.strategyLine(`Signal ${signal} — entrée ${UI.fmtPrice(pos.entry)} · SL ${UI.fmtPrice(pos.sl)} · TP ${UI.fmtPrice(pos.tp)}`);
      }
    } else {
      UI.strategyLine(strategy.describe(candle, prev, ind));
    }
  }

  refreshPanel();
}

/* ------------------------------------------------------ panneau ------ */

let lastPriceRefresh = 0;

function refreshPanel() {
  const broker = Session.broker;
  if (!broker) return;
  const floating = broker.floatingPnl(Session.lastPrice);
  UI.stats(broker.stats(), floating);
  UI.position(broker.position, floating);
  UI.trades(broker.trades);
}

function onPause() {
  Session.paused = !Session.paused;
  UI.setPaused(Session.paused);
  UI.strategyLine(Session.paused
    ? "Session en pause — décisions suspendues."
    : "Session relancée — décisions réactivées.");
}

function onReset() {
  if (!Session.symbol) return;
  stopSession();
  const history = Session.candles.filter((c) => c.time <= Session.warmedUntil);
  loadHistory(Session.symbol)
    .then((fresh) => startSession(Session.symbol, fresh.length >= 40 ? fresh : history))
    .catch(() => startSession(Session.symbol, history));
}

/* ------------------------------------------------------ départ ------- */

window.addEventListener("DOMContentLoaded", () => {
  UI.init();
  UI.showStart();
  UI.els["symbol-form"].addEventListener("submit", onStart);
  UI.els["btn-pause"].addEventListener("click", onPause);
  UI.els["btn-reset"].addEventListener("click", onReset);

  // On oublie tout si l'onglet disparaît (aucun stockage persistant ailleurs)
  window.addEventListener("pagehide", stopSession);
});
