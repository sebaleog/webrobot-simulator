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
  snapshots: [],   // état des indicateurs à chaque bougie clôturée (aligné sur candles)
  indicators: null,
  strategy: null,
  broker: null,
  feed: null,
  chart: null,
  paused: false,
  warmedUntil: 0, // timestamp de la dernière bougie CLÔTURÉE au démarrage
  lastPrice: null,
  pendingLive: null, // bougie 1m reçue en direct, mise à jour à chaque tick kline
  lastChartRender: 0,
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
  UI.resetErrorStyle();
  const symbol = normalizeSymbol(UI.els["symbol-input"].value);
  if (!symbol) {
    UI.startError("Entrez un symbole, par exemple BTCUSDT.");
    return;
  }
  UI.busy();

  const check = await validateSymbol(symbol);
  if (check !== "ok") {
    // Marché introuvable ou vérification impossible : on n'ouvre rien.
    UI.resetErrorStyle();
    UI.startError(check === "invalid" ? "non disponible" : "non disponible (vérification impossible)");
    return;
  }

  UI.loading("Symbole disponible. Chargement de l'historique…");
  const history = await loadHistory(symbol).catch(() => null);
  if (!history || history.length < 40) {
    UI.resetErrorStyle();
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
  Session.snapshots = [];
  Session.lastChartRender = 0;

  // La dernière ligne REST est la bougie de la minute en cours si elle
  // a moins de ~55 s : elle n'est pas clôturée, elle ne décide de rien.
  const n = Session.candles.length;
  const lastC = Session.candles[n - 1];
  const inProgress = (Date.now() - lastC.time) < 55000;
  Session.pendingLive = inProgress ? { ...Session.candles.pop(), closed: false } : null;

  const closed = Session.candles; // uniquement des bougies clôturées désormais
  Session.indicators = new IndicatorSet();
  Session.indicators.warmup(closed, Session.snapshots);
  Session.strategy = new Strategy();
  Session.broker = new Broker();
  Session.paused = false;
  Session.warmedUntil = closed.length ? closed[closed.length - 1].time : 0;
  Session.lastPrice = Session.pendingLive ? Session.pendingLive.close : lastC.close;

  UI.showGame(symbol);
  UI.mountChart(symbol);
  UI.setPaused(false);
  window.scrollTo(0, 0);
  UI.checkChartLoaded();

  Session.feed = new BinanceFeed(symbol, {
    onTick: handleTick,
    onKline: handleKline,
    onStatus: (s) => UI.feedStatus(s),
  });
  Session.feed.start();

  // --- A+B : warm start + décision immédiate au lancement ---------------
  immediateDecision(closed);

  refreshPanel();
  renderChart(true);
}

/* Reconstruit l'état de la stratégie sur l'historique, puis décide
 * immédiatement à partir de la dernière bougie clôturée. */
function immediateDecision(closed) {
  const { strategy, broker, snapshots } = Session;
  if (closed.length < 40 || snapshots.length < 40) {
    UI.strategyLine("Amorçage des indicateurs…");
    return;
  }

  const evalIdx = closed.length - 1;
  const candle = closed[evalIdx];
  const prev = evalIdx > 0 ? closed[evalIdx - 1] : null;
  const snap = snapshots[evalIdx];

  // 1. Rejeu des règles sur l'historique : reconstruction de l'état seul
  //    (signaux ignorés : on ne fabrique aucun trade sur le passé).
  strategy.warmStart(closed.slice(0, evalIdx), snapshots);

  if (!snap || !snap.ready || !prev) {
    UI.strategyLine("Amorçage des indicateurs…");
    return;
  }

  // 2. Évaluation réelle sur la dernière bougie clôturée.
  const signal = strategy.onCandle(candle, prev, snap);
  if (signal) {
    const pos = broker.open(signal, candle, snap, closed, Session.lastPrice);
    if (pos) {
      UI.strategyLine(
        `Signal ${signal} au démarrage — entrée ${UI.fmtPrice(pos.entry)} · ` +
        `SL ${UI.fmtPrice(pos.sl)} · TP ${UI.fmtPrice(pos.tp)}`
      );
      return;
    }
  }
  // 3. Décision « ne rien faire » : c'est aussi une décision, affichée.
  UI.strategyLine(strategy.describe(candle, prev, snap) + " · décision immédiate");
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
  renderChart(); // rendu throttlé (~5 fps) : les ticks sont nombreux
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
    // Rattrapage : la bougie finale remplace la version partielle chargée
    // en REST. Si elle vient de clôturer, elle doit être évaluée.
    candles[candles.length - 1] = k;
    if (k.time > Session.warmedUntil) {
      processClosedCandle(k);
    } else {
      // Bougie d'amorçage déjà prise en compte : on met juste l'état à jour.
      Session.indicators.update(k);
      Session.snapshots[Session.snapshots.length - 1] =
        Session.indicators.snapshot(candles, k.time);
      renderChart(true);
    }
    return;
  }
  candles.push(k);
  if (candles.length > 1500) {
    const drop = candles.length - 1500;
    candles.splice(0, drop);
    Session.snapshots.splice(0, drop);
  }

  processClosedCandle(k);
}

/* Décision : uniquement sur bougie CLÔTURÉE. */
function processClosedCandle(candle) {
  const { indicators, strategy, broker, candles } = Session;
  indicators.update(candle);
  // Enregistrement aligné pour le graphe et le rejeu de stratégie
  Session.snapshots.push(indicators.snapshot(candles, candle.time));

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
  renderChart(true);
}

/* Rendu du graphe « vue du robot » (throttlé sur les ticks). */
function renderChart(force) {
  if (!Session.chart || !Session.broker) return;
  const now = Date.now();
  if (!force && now - Session.lastChartRender < 200) return;
  Session.lastChartRender = now;
  Session.chart.render({
    candles: Session.candles,
    snapshots: Session.snapshots,
    pending: Session.pendingLive,
    position: Session.broker.position,
    trades: Session.broker.trades,
    livePrice: Session.lastPrice,
  });
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
  Session.chart = new RobotChart(document.getElementById("robot-chart"));
  UI.els["symbol-form"].addEventListener("submit", onStart);
  UI.els["btn-pause"].addEventListener("click", onPause);
  UI.els["btn-reset"].addEventListener("click", onReset);

  // On oublie tout si l'onglet disparaît (aucun stockage persistant ailleurs)
  window.addEventListener("pagehide", stopSession);
});
